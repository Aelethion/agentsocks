import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { root, sleep, until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer, postLines } from "../src/ccsocks.ts";
import { brokerCall } from "../src/client.ts";
import { buildEnvelope, encodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { changeTask, createTask } from "../src/ops.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { redactSecrets } from "../src/redact.ts";
import { sendMessage } from "../src/send.ts";
import { brokerSocketPath, canonicalPath, codexHexName, threadSocketPath } from "../src/paths.ts";
import type { Classifier } from "../src/classifier.ts";
import type { OutboxRow } from "../src/store.ts";
import { tempDir } from "./tmp.ts";

let classifierImpl: Classifier | undefined;
const broker = new Broker({ classifier: () => classifierImpl, wakeEnabled: false });
const outbox = (msgId: string): OutboxRow => broker.store.getOutbox(msgId)!;
const party = (name: string) => ({ kind: "claude", name, addr: encodeAddress(join(root, "cc-socks", `${name}.sock`)), session: null, mode: null });
const partyOf = (c: FakeClaude) => ({ kind: "claude", name: c.name, addr: encodeAddress(c.socketPath), session: c.sessionId, mode: null });
const claudeTarget = (c: FakeClaude) => ({ kind: "claude", addr: encodeAddress(c.socketPath), name: c.name, sessionId: c.sessionId });
const route = (raw: Record<string, unknown>) => broker.routeSend(raw);
const fixedClassifier = (answer: "pause" | "now"): Classifier => ({ name: "fixed", remote: false, threshold: 0.6, timeoutMs: 500, async classify() { return { route: answer, confidence: 0.9 }; } });

before(async () => {
  await broker.start();
});

after(async () => {
  classifierImpl = undefined;
  await broker.stop();
});

test("promoting a paused Claude message that was already posted does not rewrite history: the old row stays sent", async () => {
  const alpha = await fakeClaude("promoalpha", livePid(), "busy");
  try {
    const to = claudeTarget(alpha);
    classifierImpl = fixedClassifier("pause");
    const first = await route({ from: party("ann"), to, body: "please double check the migration", urgency: "normal" });
    classifierImpl = undefined;
    assert.equal(first.decision.route, "pause");
    const second = await route({ from: party("ann"), to, body: "please double check the migration", urgency: "urgent" });
    assert.deepEqual([second.decision.route, second.decision.escalates], ["now", true]);
    assert.equal(outbox(first.msgId).status, "sent", "it really was delivered, at priority later");
    assert.equal(outbox(first.msgId).error, null);
    await until(() => alpha.frames.length === 2);
    assert.deepEqual(alpha.frames.map((f) => f.priority), ["later", "next"]);
  } finally {
    await closeServer(alpha.server);
  }
});

test("if the promoting post fails, the held digest it was meant to replace is still there", async () => {
  const path = join(tempDir("as-stale-claude-"), "stale.sock");
  const owner = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path)}, () => console.log("ready"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => owner.stdout!.once("data", resolve));
  owner.kill("SIGKILL");
  await sleep(150);
  const pid = livePid();
  mkdirSync(join(root, "claude-sessions"), { recursive: true });
  writeFileSync(join(root, "claude-sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: "stale-session", cwd: "/w/s", name: "stalerecv", messagingSocketPath: path, kind: "interactive", status: "busy" }));
  const to = { kind: "claude", addr: encodeAddress(path), name: "stalerecv" };
  const held = await route({ from: party("ann"), to, body: "deploy 41 is failing", urgency: "fyi" });
  assert.equal(outbox(held.msgId).status, "held");
  const promoted = await route({ from: party("ann"), to, body: "deploy 41 is failing", urgency: "urgent" });
  assert.equal(promoted.status, "failed");
  assert.equal(outbox(held.msgId).status, "held", "the digest was not given up for a send that never happened");
  assert.equal(outbox(held.msgId).body, "deploy 41 is failing");
});

test("senders with no inbox address are told apart by name for duplicates and budgets", async () => {
  const alpha = await fakeClaude("anonalpha", livePid(), "idle");
  try {
    const to = claudeTarget(alpha);
    const shell = (name: string) => ({ kind: "cli", name, addr: null, session: null, mode: null });
    const a = await route({ from: shell("cli-projA"), to, body: "the build is green", urgency: "normal" });
    const b = await route({ from: shell("cli-projB"), to, body: "the build is green", urgency: "normal" });
    assert.deepEqual([a.decision.route, b.decision.route], ["now", "now"], "two shells that say the same thing are two senders");
    const again = await route({ from: shell("cli-projA"), to, body: "the build is green", urgency: "normal" });
    assert.equal(again.decision.route, "merge");
    const routes: string[] = [];
    for (let i = 0; i < 12; i++) routes.push((await route({ from: shell(`cli-many-${i}`), to, body: `hello from ${i}`, urgency: "normal" })).decision.route);
    assert.deepEqual(new Set(routes), new Set(["now"]), "twelve strangers do not pool into one sender budget");
    const one: string[] = [];
    for (let i = 0; i < 11; i++) one.push((await route({ from: shell("cli-chatty"), to, body: `chatter ${i}`, urgency: "normal" })).decision.route);
    assert.equal(one[10], "digest", "one chatty shell still hits its own budget");
  } finally {
    await closeServer(alpha.server);
  }
});

test("a task update whose answer the client cannot wait for says the update may already be applied", async () => {
  const dir = tempDir("quiet-task-");
  const quiet = createServer((s) => s.on("data", () => s.destroy()));
  await new Promise<void>((r) => quiet.listen(join(dir, "broker.sock"), () => r()));
  const saved = process.env.AGENTSOCKS_RUNTIME_DIR;
  process.env.AGENTSOCKS_RUNTIME_DIR = dir;
  try {
    const me: Me = { kind: "claude", name: "w", socketPath: join(root, "cc-socks", "w.sock"), session: "w-session" };
    await assert.rejects(changeTask(me, "T-abcdef", "done"), /did not answer in time\. The update to T-abcdef may already be applied; read the task with list_tasks before trying again\./);
  } finally {
    process.env.AGENTSOCKS_RUNTIME_DIR = saved;
    quiet.close();
  }
});

test("redaction runs in linear time on hostile input", () => {
  for (const shape of ["a-".repeat(100_000), "key".repeat(60_000), `${"x ".repeat(30_000)}token=`, "-".repeat(200_000)]) {
    const t0 = performance.now();
    redactSecrets(shape);
    const took = performance.now() - t0;
    assert.ok(took < 250, `${shape.slice(0, 10)}... took ${Math.round(took)} ms`);
  }
});

test("a refused task update does not move the task to the caller's address", async () => {
  const worker = await codexIdentity("rebind-worker", "/work/rebind");
  const lead = await fakeClaude("rebindlead", livePid(), "idle");
  try {
    const { task } = await createTask({ kind: "claude", name: "rebindlead", socketPath: lead.socketPath, session: lead.sessionId }, { to: "codex-rebind", title: "Rebind check", details: "d" });
    const intruder = { kind: "codex", name: "intruder", addr: encodeAddress(join(root, "cc-socks", "intruder.sock")), session: "rebind-worker", mode: null };
    await assert.rejects(brokerCall("task_update", { taskId: task.id, status: "open", actor: intruder }), /cannot be reopened/);
    assert.equal(broker.store.getTask(task.id)!.to_addr, encodeAddress(threadSocketPath("rebind-worker")), "the assignee's address is unchanged");
    const moved = await brokerCall<{ task: { status: string } }>("task_update", { taskId: task.id, status: "accepted", actor: { ...intruder, name: worker.name } });
    assert.equal(moved.task.status, "accepted");
    assert.equal(broker.store.getTask(task.id)!.to_addr, encodeAddress(canonicalPath(join(root, "cc-socks", "intruder.sock"))), "a real move by the same session does follow it");
  } finally {
    await closeServer(lead.server);
  }
});

test("a live thread whose namespaced socket cannot be bound is advertised at its v0.1 path", async () => {
  const alpha = await fakeClaude("advalpha", livePid(), "idle");
  try {
    const me = await codexIdentity("thread-adv");
    const hex = join(process.env.AGENTSOCKS_CCSOCKS_DIR!, codexHexName("thread-adv"));
    assert.equal(me.socketPath, hex);
    await sendMessage(me, "advalpha", "from while the namespaced socket is bound");
    await broker.hook({ threadId: "thread-adv", event: "SessionEnd" });
    alpha.setStatus("busy");

    await broker.register("thread-adv2", { cwd: "/w/adv2" });
    const blocked = join(process.env.AGENTSOCKS_CCSOCKS_DIR!, codexHexName("thread-adv2"));
    const { unlinkSync } = await import("node:fs");
    await broker.hook({ threadId: "thread-adv2", event: "SessionEnd" });
    writeFileSync(blocked, "a regular file in the way");
    await broker.register("thread-adv2", { cwd: "/w/adv2", state: "idle" });
    const live = await codexIdentity("thread-adv2");
    assert.equal(live.socketPath, threadSocketPath("thread-adv2"), "list_peers advertises the path the broker really holds");
    await sendMessage(live, "advalpha", "from a thread whose hex path is taken");
    const frame = await until(() => alpha.frames.find((f) => parseEnvelope(messageContent(f))?.body === "from a thread whose hex path is taken"));
    assert.equal(parseEnvelope(messageContent(frame))!.from, encodeAddress(threadSocketPath("thread-adv2")), "and so does the frame Claude gets");
    unlinkSync(blocked);
  } finally {
    await closeServer(alpha.server);
  }
});

test("a Claude sender's address reaches the receiver in the sender's own spelling", async () => {
  const alpha = await fakeClaude("spellalpha", livePid(), "idle");
  try {
    const spelled = `${root}/cc-socks/./spelled.sock`;
    await sendMessage({ kind: "claude", name: "spelled", socketPath: spelled, session: "spelled-session" }, "spellalpha", "hi");
    await until(() => alpha.frames.length === 1);
    assert.equal(parseEnvelope(messageContent(alpha.frames[0]!))!.from, encodeAddress(spelled));
  } finally {
    await closeServer(alpha.server);
  }
});

test("spellings of one sender address share one inbound limiter bucket", async () => {
  await broker.hook({ threadId: "thread-spell", event: "SessionStart", cwd: "/work/spell" });
  await broker.hook({ threadId: "thread-spell", event: "UserPromptSubmit", prompt: "busy" });
  const sock = threadSocketPath("thread-spell");
  for (let i = 0; i < 45; i++) {
    const spelling = `${root}/cc-socks/${"./".repeat(i + 1)}flooder.sock`;
    await postLines(sock, [JSON.stringify({ type: "user", message: { role: "user", content: buildEnvelope({ from: encodeAddress(spelling), fromName: "flooder", body: `flood ${i}` }) }, msg_id: `spell-${i}` })]);
  }
  await sleep(500);
  const stored = Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_thread = 'thread-spell' AND kind = 'message'").get() as { n: number }).n);
  assert.ok(stored <= 31, `a sender gets a burst of 30, saw ${stored}`);
});

test("a caller cannot claim a Claude kind for a Codex socket", async () => {
  await broker.hook({ threadId: "thread-kind", event: "SessionStart", cwd: "/work/kind" });
  const result = await route({ from: party("ann"), to: { kind: "claude", addr: encodeAddress(threadSocketPath("thread-kind")), name: "whatever" }, body: "which kind am I", urgency: "normal" });
  assert.equal(result.to.kind, "codex");
  assert.equal(outbox(result.msgId).to_kind, "codex");
  assert.equal(Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE msg_id = ?").get(result.msgId) as { n: number }).n), 1, "it landed in the thread's inbox");
});

test("the recent window keeps the newest rows when there are more than 500", () => {
  const now = Date.now();
  for (let i = 0; i < 520; i++) {
    broker.store.insertOutbox({
      id: `r${i}`, msg_id: `m${i}`, from_addr: "uds:/a", from_name: "a", from_kind: "claude", from_session: null, from_mode: null, to_addr: "uds:/recent-dest", to_name: "d", to_kind: "claude", to_thread: null, to_session: null,
      body: "", body_hash: `h${i}`, urgency: "normal", route: "now", decision: "{}", status: "sent", task_id: null, created_at: now - 600_000 + i * 1000, sent_at: now,
    });
  }
  const rows = broker.store.recentOutboxTo("uds:/recent-dest", now - 700_000);
  assert.equal(rows.length, 500);
  assert.ok(rows.some((r) => r.msg_id === "m519"), "the newest message is in the window");
  assert.ok(!rows.some((r) => r.msg_id === "m0"), "the oldest ones fall out instead");
});

test("a sent row carries no stale retry note, and a superseded row drops its text", () => {
  broker.store.insertOutbox({
    id: "s1", msg_id: "s1", from_addr: "uds:/a", from_name: "a", from_kind: "claude", from_session: null, from_mode: null, to_addr: "uds:/b-store", to_name: "b", to_kind: "claude", to_thread: null, to_session: null,
    body: "held text", urgency: "fyi", route: "digest", decision: "{}", status: "held", task_id: null, created_at: Date.now(),
  });
  broker.store.noteRowError(["s1"], "will retry: no inbox socket");
  broker.store.markFlushed(["s1"], "carrier", Date.now());
  const row = broker.store.getOutboxByMsgId("s1")!;
  assert.deepEqual([row.status, row.error, row.body], ["sent", null, ""]);
  broker.store.insertOutbox({
    id: "s2", msg_id: "s2", from_addr: "uds:/a", from_name: "a", from_kind: "claude", from_session: null, from_mode: null, to_addr: "uds:/b-store", to_name: "b", to_kind: "claude", to_thread: null, to_session: null,
    body: "will be superseded", urgency: "fyi", route: "digest", decision: "{}", status: "held", task_id: null, created_at: Date.now(),
  });
  broker.store.supersede(["s2"], "uds:/b-store", "newer", ["held"]);
  const gone = broker.store.getOutboxByMsgId("s2")!;
  assert.deepEqual([gone.status, gone.body], ["merged", ""]);
});

test("a control line that is not a JSON object is ignored, and the connection still serves the next request", async () => {
  const lines = await new Promise<string[]>((resolve, reject) => {
    const sock = createConnection({ path: brokerSocketPath() });
    let out = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => (out += chunk));
    sock.on("error", reject);
    sock.on("close", () => resolve(out.split("\n").filter(Boolean)));
    sock.on("connect", () => sock.write(`null\n5\n[]\n"text"\ntrue\n${JSON.stringify({ id: 7, op: "ping" })}\n`));
  });
  assert.equal(lines.length, 1, "the junk lines got no reply");
  assert.deepEqual([JSON.parse(lines[0]!).ok, JSON.parse(lines[0]!).id], [true, 7]);
});
