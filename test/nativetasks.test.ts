import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { root, until, fakeClaude, livePid, sleep, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { brokerCall } from "../src/client.ts";
import { changeTask, createTask, listTasks, peerStatus } from "../src/ops.ts";
import type { TaskRow } from "../src/store.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker({ wakeEnabled: false });
let lead: FakeClaude;
let worker: FakeClaude;
let client: Client;
const claude = (c: FakeClaude): Me => ({ kind: "claude", name: c.name, socketPath: c.socketPath, session: c.sessionId });
const partyOf = (me: Me) => ({ kind: me.kind, name: me.name, addr: encodeAddress(me.socketPath!), session: me.session ?? null, mode: me.mode ?? null });
const claudeTarget = (c: FakeClaude) => ({ kind: "claude", addr: encodeAddress(c.socketPath), name: c.name, sessionId: c.sessionId });
const outboxFor = (taskId: string) => broker.store.db.prepare("SELECT * FROM outbox WHERE task_id = ?").all(taskId);
const tasksCount = () => Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n);

before(async () => {
  await broker.start();
  lead = await fakeClaude("lead", process.pid, "busy");
  worker = await fakeClaude("native-worker", livePid(), "idle");
  const cwd = join(root, "work", "native");
  mkdirSync(cwd, { recursive: true });
  client = new Client({ name: "test-claude", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--host", "claude"], cwd, env: { ...process.env } as Record<string, string> }));
});

after(async () => {
  await client.close();
  await closeServer(lead.server);
  await closeServer(worker.server);
  await broker.stop();
});

const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
};

test("a task from a Claude session to a Claude session is created and tracked but not posted", async () => {
  const made = await createTask(claude(lead), { to: "native-worker", title: "Review the parser", details: "Read src/parser.ts and list the bugs.", acceptance: "a list with line numbers", risk: "high" });
  assert.match(made.task.id, /^T-[0-9a-f]{6}$/);
  assert.equal(made.delivery, undefined);
  assert.equal(made.sendTo, "native-worker");
  assert.equal(outboxFor(made.task.id).length, 0, "no message was recorded");
  await sleep(150);
  assert.equal(worker.frames.length, 0, "nothing reached the assignee's inbox");
  assert.deepEqual((await listTasks(claude(worker), "assigned_to_me")).map((t) => t.id), [made.task.id]);
  assert.deepEqual((await listTasks(claude(lead), "created_by_me")).map((t) => t.id), [made.task.id]);
  const status = await peerStatus(claude(lead), "native-worker");
  assert.deepEqual(status.desired.openTasks.map((t) => t.id), [made.task.id]);
});

test("send_task on the Claude host says to send it with SendMessage and gives a ready block", async () => {
  const before = worker.frames.length;
  const r = await call("send_task", { to: "native-worker", title: "Check the lockfile", details: "Compare package-lock.json with package.json.", acceptance_criteria: "no drift", risk: "low" });
  assert.equal(r.isError, false, r.text);
  const id = r.text.match(/^Task (T-[0-9a-f]{6}) created\. Send it to native-worker with your built-in SendMessage \(it carries your permission mode\); paste this:\n\n/)?.[1];
  assert.ok(id, r.text);
  const block = r.text.slice(r.text.indexOf("\n\n") + 2);
  assert.ok(block.startsWith(`[agentsocks task ${id}] Check the lockfile\n\nCompare package-lock.json with package.json.`), block);
  assert.ok(block.includes("Acceptance criteria: no drift"));
  assert.ok(block.includes(`update_task tool with task_id "${id}"`));
  assert.ok(block.includes("accepted, in_progress, done or failed"));
  assert.equal(broker.store.getTask(id)!.status, "open");
  assert.equal(outboxFor(id).length, 0);
  await sleep(150);
  assert.equal(worker.frames.length, before, "not posted by agentsocks");
});

test("an update between two Claude sessions is applied but not posted, and says what to send", async () => {
  const { task } = await createTask(claude(lead), { to: "native-worker", title: "Fix the flake", details: "Find why checkout.test.ts flakes." });
  const frames = lead.frames.length;
  const accepted = await changeTask(claude(worker), task.id, "accepted");
  assert.equal(accepted.task.status, "accepted");
  assert.equal(accepted.notified, false);
  assert.deepEqual(accepted.notice.outcome, "native");
  const done = await changeTask(claude(worker), task.id, "done", "Fixed: a missing await.", "commit 4f2c1ab");
  assert.equal(done.task.status, "done");
  assert.equal(done.notice.outcome === "native" && done.notice.name, "lead");
  assert.equal(done.notice.outcome === "native" && done.notice.text, `[agentsocks task ${task.id}] Fix the flake: done (by @native-worker). Result: Fixed: a missing await. Evidence: commit 4f2c1ab`);
  assert.equal(outboxFor(task.id).length, 0, "no notice was recorded");
  await sleep(150);
  assert.equal(lead.frames.length, frames, "the creator's inbox got nothing from agentsocks");
});

test("update_task on the Claude host tells the creator-side caller the assignee was not notified, with one line to send", async () => {
  const made = await call("send_task", { to: "native-worker", title: "Call it off", details: "Will be cancelled." });
  const id = made.text.match(/Task (T-[0-9a-f]{6}) created/)![1]!;
  const r = await call("update_task", { task_id: id, status: "cancelled" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /cancelled/);
  assert.ok(r.text.includes(`The assignee (@native-worker) was not notified automatically, because you are both Claude sessions. If it matters, send this to them with your built-in SendMessage: [agentsocks task ${id}] Call it off: cancelled (by @lead).`), r.text);
});

test("a retry of the same request id returns the same Claude to Claude task", async () => {
  const body = { from: partyOf(claude(lead)), to: claudeTarget(worker), title: "Once only", body: "details", requestId: "native-retry-0001" };
  const first = await brokerCall<{ task: TaskRow; delivery?: unknown }>("task_create", body, { autoStart: false });
  const before = tasksCount();
  const second = await brokerCall<{ task: TaskRow; delivery?: unknown }>("task_create", body, { autoStart: false });
  assert.equal(second.task.id, first.task.id);
  assert.equal(tasksCount(), before);
  assert.equal(first.delivery, undefined);
});

test("a Claude to Claude task still needs a live assignee, and leaves nothing behind otherwise", async () => {
  const before = tasksCount();
  await assert.rejects(
    brokerCall("task_create", { from: partyOf(claude(lead)), to: { kind: "claude", addr: encodeAddress(`${root}/cc-socks/nobody.sock`), name: "nobody" }, title: "Ghost", body: "x" }, { autoStart: false }),
    /no inbox socket/,
  );
  assert.equal(tasksCount(), before);
});

test("tasks between Codex and Claude, and between Codex sessions, are still posted and notified", async () => {
  await broker.hook({ threadId: "thread-native-a", event: "SessionStart", cwd: "/work/a" });
  await broker.hook({ threadId: "thread-native-b", event: "SessionStart", cwd: "/work/b" });
  const a = await codexIdentity("thread-native-a");
  const b = await codexIdentity("thread-native-b");
  const toCodex = await createTask(claude(lead), { to: a.name, title: "Claude to Codex", details: "d" });
  assert.ok(toCodex.delivery && outboxFor(toCodex.task.id).length === 1);
  assert.ok(broker.take("thread-native-a").text.includes(`[agentsocks task ${toCodex.task.id}] Claude to Codex`));
  const accepted = await changeTask(a, toCodex.task.id, "done", "ok");
  assert.equal(accepted.notified, true);
  assert.equal(accepted.notice.outcome === "native", false);
  await until(() => lead.frames.find((f) => parseEnvelope(messageContent(f))?.body.includes(`${toCodex.task.id}] Claude to Codex: done`)));

  const fromCodex = await createTask(a, { to: "native-worker", title: "Codex to Claude", details: "d" });
  assert.ok(fromCodex.delivery);
  await until(() => worker.frames.find((f) => parseEnvelope(messageContent(f))?.body.includes(`[agentsocks task ${fromCodex.task.id}] Codex to Claude`)));
  const cancelled = await changeTask(claude(worker), fromCodex.task.id, "accepted");
  assert.equal(cancelled.notice.outcome === "native", false);

  const codexPair = await createTask(a, { to: b.name, title: "Codex to Codex", details: "d" });
  assert.ok(codexPair.delivery);
  assert.ok(broker.take("thread-native-b").text.includes(`[agentsocks task ${codexPair.task.id}] Codex to Codex`));
});

test("a Claude to Claude task the creator never forwarded shows up in the assignee's status after thirty minutes", async () => {
  const { task } = await createTask(claude(lead), { to: "native-worker", title: "Never forwarded", details: "d" });
  const drift = async () => (await peerStatus(claude(lead), "native-worker")).drift.filter((d) => d.detail.startsWith(task.id));
  assert.deepEqual(await drift(), []);
  broker.store.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(Date.now() - 31 * 60_000, task.id);
  const flagged = await drift();
  assert.deepEqual(flagged.map((d) => d.code), ["task-unaccepted"]);
  assert.match(flagged[0]!.detail, /still open 31 min after it was created, not accepted yet/);
  await changeTask(claude(worker), task.id, "accepted");
  assert.deepEqual(await drift(), []);
});

test("a Claude to Claude task that expires posts nothing to either side, however many sweeps follow", async () => {
  const { task } = await createTask(claude(lead), { to: "native-worker", title: "Lapses quietly", details: "d", expiresInMinutes: 60 });
  const frames = [lead.frames.length, worker.frames.length];
  await broker.runSweep(Date.now() + 2 * 3_600_000);
  assert.equal(broker.store.getTask(task.id)!.status, "expired");
  for (const hours of [3, 4, 5]) await broker.runSweep(Date.now() + hours * 3_600_000);
  await sleep(200);
  assert.equal(outboxFor(task.id).length, 0, "no notice was recorded, held or sent");
  assert.deepEqual([lead.frames.length, worker.frames.length], frames, "neither inbox got anything from agentsocks");
});

test("an expired task still tells its creator when one side is Codex", async () => {
  await broker.hook({ threadId: "thread-native-c", event: "SessionStart", cwd: "/work/c" });
  const c = await codexIdentity("thread-native-c");
  const toCodex = await createTask(claude(lead), { to: c.name, title: "Claude asks Codex, lapses", details: "d", expiresInMinutes: 60 });
  const fromCodex = await createTask(c, { to: "native-worker", title: "Codex asks Claude, lapses", details: "d", expiresInMinutes: 60 });
  broker.take("thread-native-c");
  await broker.runSweep(Date.now() + 2 * 3_600_000);
  assert.equal(broker.store.getTask(toCodex.task.id)!.status, "expired");
  assert.equal(broker.store.getTask(fromCodex.task.id)!.status, "expired");
  const told = (outboxFor(toCodex.task.id) as { to_name: string; body: string }[]).filter((r) => /: expired/.test(r.body));
  assert.deepEqual(told.map((r) => r.to_name), ["lead"], "the Claude creator is told, in a digest while it is busy");
  assert.ok(broker.take("thread-native-c").text.includes(`${fromCodex.task.id}] Codex asks Claude, lapses: expired`));
});
