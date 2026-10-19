import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fakeClaude, livePid, until, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { brokerCall } from "../src/client.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { postLines } from "../src/ccsocks.ts";
import { encodeAddress, userFrame } from "../src/envelope.ts";
import { brokerSocketPath, threadSocketPath } from "../src/paths.ts";
import { renderTop, startOfDay, type TopSnapshot } from "../src/top.ts";
import type { NewOutbox } from "../src/store.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker({ wakeEnabled: false });
let ops: FakeClaude;
let worker: Me;
let helper: Me;
let seeded = 0;

const snapshot = (): Promise<TopSnapshot> => brokerCall("top", {}, { autoStart: false });
const MINUTE = 60_000;

function seed({ shown_at, ...over }: Partial<NewOutbox> & { created_at: number; shown_at?: number }): void {
  seeded++;
  const id = `seed-${seeded}`;
  broker.store.insertOutbox({
    id,
    msg_id: `seed-msg-${seeded}`,
    from_addr: null,
    from_name: "seeder",
    from_kind: "cli",
    from_session: null,
    from_mode: null,
    to_addr: "uds:/nowhere/seed.sock",
    to_name: "ghost",
    to_kind: "claude",
    to_thread: null,
    to_session: null,
    body: "",
    urgency: "normal",
    route: "now",
    decision: "{}",
    status: shown_at === undefined ? "sent" : "shown",
    task_id: null,
    ...over,
  });
  if (shown_at !== undefined) broker.store.updateOutbox(id, { shown_at });
}

before(async () => {
  await broker.start();
  ops = await fakeClaude("ops", livePid(), "busy");
  await broker.hook({ threadId: "thread-top-worker", event: "SessionStart", cwd: "/work/worker" });
  await broker.hook({ threadId: "thread-top-helper", event: "SessionStart", cwd: "/work/helper" });
  worker = await codexIdentity("thread-top-worker");
  helper = await codexIdentity("thread-top-helper");
});

after(async () => {
  await closeServer(ops.server);
  await broker.stop();
});

test("the snapshot lists every live session with its state, task, unread, held and active tasks, and when it last had a message and from whom", async () => {
  await broker.hook({ threadId: "thread-top-worker", event: "UserPromptSubmit", prompt: "migrate the billing tables" });
  await sendMessage(helper, "codex-worker", "need the schema by noon");
  await sendMessage(helper, "codex-worker", "FYI the dump is in /tmp", undefined, { urgency: "fyi" });
  const sentToOps = await sendMessage(worker, "ops", "ops, can you look at CI");
  await brokerCall("task_create", {
    from: { kind: "codex", name: helper.name, addr: `uds:${helper.socketPath}`, session: helper.session, mode: null },
    to: { kind: "codex", addr: `uds:${worker.socketPath}`, name: worker.name, threadId: worker.session },
    title: "Add the tenant column",
    body: "see migrations/",
  });
  const snap = await snapshot();
  const byName = Object.fromEntries(snap.peers.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(byName).sort(), ["codex-helper", "codex-worker", "ops"]);
  const w = byName["codex-worker"]!;
  assert.deepEqual([w.kind, w.state, w.task, w.held, w.tasks], ["codex", "busy", "migrate the billing tables", 1, 1]);
  assert.ok(w.unread >= 1);
  assert.equal(w.lastMessage?.from, helper.name);
  assert.ok(Date.now() - w.lastMessage!.at < 60_000);
  const o = byName.ops!;
  assert.deepEqual([o.kind, o.state, o.task, o.lastMessage?.from], ["claude", "busy", null, worker.name]);
  assert.equal(sentToOps.route, "now");
  assert.equal(o.unread, 1, "a Claude session's unread is what was sent and not yet seen in its transcript");
  assert.equal(byName["codex-helper"]!.lastMessage, null);
});

test("today's numbers are counts from the outbox since local midnight: routed, interrupts avoided as paused + batched + merged, digests flushed and the median time to shown", async () => {
  broker.store.db.exec("DELETE FROM outbox");
  broker.store.db.exec("DELETE FROM messages");
  const now = Date.now();
  const midnight = startOfDay(now);
  const today = Math.max(midnight + 1000, now - 30_000);
  const yesterday = midnight - 3_600_000;
  seed({ created_at: today, route: "now", shown_at: today + 10_000 });
  seed({ created_at: today, route: "now", shown_at: today + 30_000 });
  seed({ created_at: today, route: "now" });
  seed({ created_at: today, route: "pause", shown_at: today + 20_000 });
  seed({ created_at: today, route: "pause" });
  seed({ created_at: today, route: "digest", status: "sent", sent_at: today + 5000, carrier_id: "carrier-1" });
  seed({ created_at: today, route: "digest", status: "sent", sent_at: today + 5000, carrier_id: "carrier-1" });
  seed({ created_at: today, route: "digest", status: "sent", sent_at: today + 9000, carrier_id: "carrier-2" });
  seed({ created_at: today, route: "digest", status: "held" });
  seed({ created_at: today, route: "merge", status: "merged" });
  seed({ created_at: today, route: "now", status: "refused" });
  seed({ created_at: today, route: "pause", status: "failed" });
  seed({ created_at: yesterday, route: "pause", shown_at: yesterday + 1000 });
  seed({ created_at: yesterday, route: "digest", status: "sent", sent_at: yesterday, carrier_id: "carrier-old" });
  broker.store.db.prepare("INSERT INTO messages (id, msg_id, to_thread, kind, body, received_at, state, route, released_at) VALUES (?, ?, ?, 'message', 'x', ?, 'queued', 'digest', ?)").run("m1", "mm1", "thread-top-worker", today, today + 1);
  broker.store.db.prepare("INSERT INTO messages (id, msg_id, to_thread, kind, body, received_at, state, route, released_at) VALUES (?, ?, ?, 'message', 'x', ?, 'queued', 'digest', ?)").run("m2", "mm2", "thread-top-worker", today, today + 1);
  broker.store.db.prepare("INSERT INTO messages (id, msg_id, to_thread, kind, body, received_at, state, route, released_at) VALUES (?, ?, ?, 'message', 'x', ?, 'queued', 'digest', ?)").run("m3", "mm3", "thread-top-helper", today, today + 1);
  const t = (await snapshot()).today;
  assert.equal(t.since, midnight);
  assert.deepEqual([t.routed, t.paused, t.batched, t.merged, t.interruptsAvoided], [13, 2, 7, 1, 10], "refused and failed sends and yesterday's rows are not counted, and the three released Codex digests are routed batches");
  assert.equal(t.digestsFlushed, 4, "two Claude digests and two Codex releases (one release of two messages counts once)");
  assert.deepEqual([t.shown, t.medianMsToShown], [3, 20_000]);
});

test("with nothing routed today the numbers are zero and the median is absent, never a made-up figure", async () => {
  broker.store.db.exec("DELETE FROM outbox");
  broker.store.db.exec("DELETE FROM messages");
  const t = (await snapshot()).today;
  assert.deepEqual([t.routed, t.interruptsAvoided, t.digestsFlushed, t.shown, t.medianMsToShown], [0, 0, 0, 0, null]);
});

test("the frame is plain text: a header, a row per session and a footer with counts, and it holds no minutes-saved figure", async () => {
  const snap = await snapshot();
  const frame = renderTop(snap, { width: 130, color: false, now: snap.at });
  const lines = frame.split("\n");
  assert.match(lines[0]!, /^agentsocks \d+\.\d+\.\d+ {2}\d\d:\d\d:\d\d/);
  assert.match(frame, /^PEER +KIND +STATE +UNREAD +HELD +TASKS +LAST MESSAGE +CURRENT TASK$/m);
  assert.match(frame, /^codex-worker +codex +busy +\d+ +\d+ +\d+ +/m);
  assert.match(frame, /^Today: 0 messages routed, 0 interrupts avoided \(0 paused, 0 batched, 0 merged\), 0 digests flushed, median time to shown n\/a$/m);
  assert.doesNotMatch(frame, /saved|\x1b/);
  assert.ok(lines.every((l) => l.length <= 130), "no line is wider than the terminal");
  const narrow = renderTop(snap, { width: 80, color: false, now: snap.at });
  assert.ok(narrow.split("\n").every((l) => l.length <= 80), "the footer wraps instead of running off a narrow terminal");
  assert.match(narrow, /Today: 0 messages routed, 0 interrupts avoided \(0 paused, 0 batched, 0 merged\),\n {7}0 digests flushed, median time to shown n\/a/);
});

test("colours are only used when asked for, and a narrow terminal cuts the task, not the numbers", async () => {
  const snap = await snapshot();
  const coloured = renderTop(snap, { width: 70, color: true, now: snap.at });
  assert.match(coloured, /\x1b\[/);
  const plain = coloured.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(plain.split("\n").every((l) => l.length <= 70));
  assert.match(plain, /^codex-wor… +codex +busy +\d+ +\d+ +\d+ +/m);
  assert.deepEqual(renderTop({ ...snap, peers: [] }, { width: 80, color: false, now: snap.at }).split("\n").filter((l) => l.startsWith("No ")), ["No live sessions."]);
});

test("top --json is one plain JSON snapshot and top --once is one plain-text frame; neither needs a terminal or MCP", async () => {
  const json = await exec(process.execPath, [cli, "top", "--json"], { env: process.env, timeout: 30_000 });
  const snap = JSON.parse(json.stdout) as TopSnapshot;
  assert.deepEqual(Object.keys(snap).sort(), ["at", "peers", "today", "version"]);
  assert.deepEqual(snap.peers.map((p) => p.name).sort(), ["codex-helper", "codex-worker", "ops"]);
  assert.deepEqual(Object.keys(snap.today).sort(), ["batched", "digestsFlushed", "interruptsAvoided", "medianMsToShown", "merged", "paused", "routed", "shown", "since"]);
  assert.doesNotMatch(json.stdout, /peer-text/, "--json is plain data");
  const once = await exec(process.execPath, [cli, "top", "--once"], { env: process.env, timeout: 30_000 });
  assert.match(once.stdout, /<peer-text-[0-9a-f]{6}>/, "piped, the peer-written names are framed like every other command");
  assert.match(once.stdout, /PEER +KIND +STATE/);
  assert.doesNotMatch(once.stdout, /\x1b/);
  await assert.rejects(exec(process.execPath, [cli, "top", "--bogus"], { env: process.env }), (e: { stderr?: string }) => /usage: agentsocks top \[--once\] \[--json\]/.test(e.stderr ?? ""));
});

test("when the broker is not running, top says so and exits 1 instead of starting one", async () => {
  await broker.stop();
  try {
    const r = await exec(process.execPath, [cli, "top", "--once"], { env: process.env, timeout: 30_000 }).then(
      () => ({ code: 0, err: "" }),
      (e: { code?: number; stderr?: string }) => ({ code: e.code ?? 1, err: e.stderr ?? "" }),
    );
    assert.equal(r.code, 1);
    assert.match(r.err, /the agentsocks broker is not running/);
  } finally {
    await broker.start();
  }
});

const hasScript = process.platform === "linux" && spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

test("at a terminal top draws the screen again every second, hides the cursor, and q puts the terminal back and exits 0", { skip: !hasScript && "needs util-linux script to give the command a terminal" }, async () => {
  const command = [process.execPath, cli, "top"].map((a) => `'${a}'`).join(" ");
  const child = spawn("script", ["-qec", command, "/dev/null"], { env: { ...process.env, NO_COLOR: "" } as Record<string, string>, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  try {
    await until(() => out.includes("PEER") && out.includes("Today:"), 15_000);
    assert.ok(out.includes("\x1b[?1049h") && out.includes("\x1b[?25l"), "enters the alternate screen and hides the cursor");
    const first = out.split("Today:").length - 1;
    await until(() => out.split("Today:").length - 1 > first, 5000);
    child.stdin.write("q");
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("did not exit within 5 s"), 5000))]);
    assert.equal(code, 0);
    assert.ok(out.includes("\x1b[?25h") && out.includes("\x1b[?1049l"), "shows the cursor and leaves the alternate screen");
  } finally {
    child.stdin.write("\x03q");
    child.kill("SIGKILL");
  }
});

test("a session name from the Claude registry cannot carry terminal escapes into the frame", async () => {
  const sneaky = await fakeClaude("sneaky\x1b[2Jscreen", livePid(), "idle");
  try {
    const snap = await snapshot();
    const names = snap.peers.map((p) => p.name);
    assert.ok(names.some((n) => n.startsWith("sneaky") && n.endsWith("screen")));
    assert.ok(names.every((n) => !/[\x00-\x1f]/.test(n)));
    assert.doesNotMatch(renderTop(snap, { width: 100, color: false, now: snap.at }), /\x1b/);
  } finally {
    await closeServer(sneaky.server);
  }
});

test("at every width from 60 to 140 no line is wider than the terminal, with long names, long tasks and colour", () => {
  const now = Date.now();
  const snap: TopSnapshot = {
    at: now,
    version: "0.4.0",
    peers: [
      { name: "a-very-long-session-name-that-keeps-going-and-going", kind: "codex", state: "waiting", task: "refactor the auth middleware and add the retry policy to the client", unread: 12, held: 3, tasks: 4, lastMessage: { at: now - 7_200_000, from: "another-long-sender-name-here" } },
      { name: "ops", kind: "claude", state: "busy", task: null, unread: 0, held: 0, tasks: 0, lastMessage: null },
    ],
    today: { since: now, routed: 4200, paused: 900, batched: 600, merged: 200, interruptsAvoided: 1700, digestsFlushed: 44, shown: 3100, medianMsToShown: 12_000 },
  };
  for (let width = 60; width <= 140; width++) {
    for (const color of [false, true]) {
      const plain = renderTop(snap, { width, color, now, hint: true }).replace(/\x1b\[[0-9;]*m/g, "");
      for (const line of plain.split("\n")) assert.ok(line.length <= width, `width ${width}: "${line}" is ${line.length} wide`);
    }
  }
  const eighty = renderTop(snap, { width: 80, color: false, now });
  assert.match(eighty, /CURRENT TA/, "the task still fits next to the counts at 80 columns when the names are short enough");
});

test("a message a Claude session sends straight to a Codex session, which never touches the outbox, is counted as routed", async () => {
  const before = (await snapshot()).today;
  const frame = userFrame({ from: encodeAddress(ops.socketPath), fromName: "ops", body: "native hello to the worker" }, randomUUID(), "next");
  await postLines(threadSocketPath("thread-top-worker"), [JSON.stringify(frame)]);
  const counted = await new Promise<TopSnapshot["today"]>((resolve, reject) => {
    const started = Date.now();
    const poll = async () => {
      const t = (await snapshot()).today;
      if (t.routed === before.routed + 1) return resolve(t);
      if (Date.now() - started > 5000) return reject(new Error(`routed stayed ${t.routed}`));
      setTimeout(() => void poll(), 25);
    };
    void poll();
  });
  assert.equal(counted.routed, before.routed + 1);
});

test("against a broker that predates top, top says to run install, not that the broker is not running", async () => {
  await broker.stop();
  const fake = createServer((s) => s.on("data", (d) => {
    const req = JSON.parse(String(d).split("\n")[0]!) as { op: string };
    s.end(`${JSON.stringify(req.op === "ping" ? { id: 1, ok: true, result: { pid: 4242, version: "0.3.1", threads: 0 } } : { id: 1, ok: false, error: `unknown op ${req.op}` })}\n`);
  }));
  await new Promise<void>((resolve) => fake.listen(brokerSocketPath(), resolve));
  try {
    const r = await exec(process.execPath, [cli, "top", "--once"], { env: process.env, timeout: 30_000 }).then(
      () => "ran",
      (e: { stderr?: string }) => e.stderr ?? "",
    );
    assert.match(r, /The running agentsocks broker is an older version\. Run `agentsocks install` \(or stop pid 4242\) and retry\./);
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    await broker.start();
  }
});
