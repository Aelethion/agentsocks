import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { root, until, fakeClaude, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { brokerCall } from "../src/client.ts";
import { checkMove, MOVES, type TaskStatus } from "../src/tasks.ts";
import type { OutboxRow, TaskRow } from "../src/store.ts";

const broker = new Broker();
let lead: FakeClaude;
let worker: Me;
let helper: Me;
const HOUR = 3_600_000;

const partyOf = (me: Me) => ({ kind: me.kind, name: me.name, addr: encodeAddress(me.socketPath!), session: me.session ?? null, mode: me.mode ?? null });
const leadMe = (): Me => ({ kind: "claude", name: "lead", socketPath: lead.socketPath, session: lead.sessionId });
const codexTarget = (me: Me) => ({ kind: "codex", addr: encodeAddress(me.socketPath!), name: me.name, threadId: me.session });
const rpc = async <T>(op: string, args: Record<string, unknown>): Promise<T> => brokerCall<T>(op, args, { autoStart: false });

async function create(over: Record<string, unknown> = {}) {
  return rpc<{ task: TaskRow; delivery: { msgId: string; decision: { route: string } } }>("task_create", {
    from: partyOf(leadMe()),
    to: codexTarget(worker),
    title: "Add the tenant_id migration",
    body: "Add migrations/0042_tenant.sql and update the users model.",
    acceptance: "npm test passes and the migration is reversible",
    onBehalfOf: "Jane Doe",
    externalRef: "LIN-123",
    ...over,
  });
}

const update = (taskId: string, status: string, me: Me, extra: Record<string, unknown> = {}) => rpc<{ task: TaskRow; notified: boolean }>("task_update", { taskId, status, actor: partyOf(me), ...extra });
const noticesFor = (taskId: string): OutboxRow[] => broker.store.db.prepare("SELECT * FROM outbox WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as unknown as OutboxRow[];

before(async () => {
  await broker.start();
  lead = await fakeClaude("lead", process.pid, "busy");
  await broker.hook({ threadId: "thread-worker", event: "SessionStart", cwd: "/work/worker" });
  await broker.hook({ threadId: "thread-helper", event: "SessionStart", cwd: "/work/helper" });
  worker = await codexIdentity("thread-worker");
  helper = await codexIdentity("thread-helper");
});

after(async () => {
  await closeServer(lead.server);
  await broker.stop();
});

test("the transition table is the only authority: who may move a task where", () => {
  const cases: [TaskStatus, TaskStatus, "assignee" | "creator" | "system", boolean][] = [
    ["open", "accepted", "assignee", true],
    ["open", "in_progress", "assignee", true],
    ["accepted", "in_progress", "assignee", true],
    ["in_progress", "in_progress", "assignee", true],
    ["in_progress", "done", "assignee", true],
    ["open", "failed", "assignee", true],
    ["in_progress", "cancelled", "creator", true],
    ["open", "expired", "system", true],
    ["accepted", "accepted", "assignee", false],
    ["done", "failed", "assignee", false],
    ["cancelled", "in_progress", "assignee", false],
    ["expired", "done", "assignee", true],
    ["expired", "failed", "assignee", true],
    ["expired", "cancelled", "creator", false],
    ["expired", "accepted", "assignee", false],
    ["failed", "cancelled", "creator", false],
    ["in_progress", "done", "creator", false],
    ["in_progress", "cancelled", "assignee", false],
    ["open", "expired", "assignee", false],
    ["done", "open", "system", false],
  ];
  for (const [from, to, role, ok] of cases) assert.equal(checkMove(from, to, role) === undefined, ok, `${from} -> ${to} by ${role}`);
  assert.deepEqual(Object.keys(MOVES).sort(), ["accepted", "cancelled", "done", "expired", "failed", "in_progress"]);
  assert.equal(checkMove("open", "done", undefined) !== undefined, true, "a stranger can do nothing");
});

test("creating a task stores it and sends the assignee one routed message that carries the details and how to update it", async () => {
  await broker.hook({ threadId: "thread-worker", event: "UserPromptSubmit", prompt: "something else" });
  const { task, delivery } = await create();
  assert.match(task.id, /^T-[0-9a-f]{6}$/);
  assert.equal(task.status, "open");
  assert.equal(task.risk, "low");
  assert.equal(task.expires_at - task.created_at, 24 * HOUR, "default expiry is 24 hours");
  assert.equal(delivery.decision.route, "now", "a normal task reaches a busy worker at its next tool call");
  const text = broker.take("thread-worker").text;
  assert.ok(text.includes(`[agentsocks task ${task.id}] Add the tenant_id migration`));
  assert.ok(text.includes("migrations/0042_tenant.sql"));
  assert.ok(text.includes("Acceptance criteria: npm test passes"));
  assert.ok(text.includes("On behalf of (as stated by the sender): Jane Doe"));
  assert.ok(text.includes("Reference: LIN-123"));
  assert.ok(text.includes(`update_task tool with task_id "${task.id}"`));
  const rows = noticesFor(task.id);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.urgency, rows[0]!.task_id], ["normal", task.id]);

  const high = await create({ title: "Rotate the staging credentials", risk: "high" });
  assert.equal(high.delivery.decision.route, "now", "risk high is sent as urgent");
  assert.equal(noticesFor(high.task.id)[0]!.urgency, "urgent");
  broker.take("thread-worker");
});

test("risk shapes the assignment only: a high-risk task's notices are fyi until it ends, then normal", async () => {
  const { task } = await create({ title: "High risk lifecycle", risk: "high" });
  broker.take("thread-worker");
  const before = noticesFor(task.id).length;
  await update(task.id, "accepted", worker);
  await update(task.id, "done", worker, { result: "ok" });
  assert.deepEqual(noticesFor(task.id).slice(before).map((n) => n.urgency), ["fyi", "normal"]);
});

test("only the assignee moves a task forward and only the creator cancels it; strangers and terminal tasks are refused", async () => {
  const { task } = await create({ title: "Permissions" });
  await assert.rejects(update(task.id, "done", leadMe()), /only the assignee can update a task/);
  await assert.rejects(update(task.id, "accepted", helper), /only the assignee or the creator/);
  await assert.rejects(update(task.id, "cancelled", worker), /only the creator can cancel/);
  await assert.rejects(update("T-ffffff", "accepted", worker), /no task T-ffffff/);
  await assert.rejects(update(task.id, "open", worker), /cannot be reopened/);
  await assert.rejects(update(task.id, "bogus", worker), /bogus is not a task status/);
  assert.equal(broker.store.getTask(task.id)!.status, "open", "nothing changed");

  await update(task.id, "accepted", worker);
  await assert.rejects(update(task.id, "accepted", worker), /accepted cannot become accepted/);
  await update(task.id, "cancelled", leadMe());
  await assert.rejects(update(task.id, "done", worker), /cancelled cannot become done/);
  assert.equal(broker.store.getTask(task.id)!.status, "cancelled");
});

test("every change tells the creator: done and failed as normal messages, the rest as fyi, with the result and evidence", async () => {
  const { task } = await create({ title: "Full lifecycle" });
  const before = noticesFor(task.id).length;
  const accepted = await update(task.id, "accepted", worker);
  assert.equal(accepted.notified, true);
  await update(task.id, "in_progress", worker, { result: "halfway: model done, migration next" });
  const done = await update(task.id, "done", worker, { result: "Migration added and reversible", evidence: "npm test: 212 passed; commit 4f2c1ab" });
  assert.equal(done.task.status, "done");
  assert.equal(done.task.evidence, "npm test: 212 passed; commit 4f2c1ab");
  const notices = noticesFor(task.id).slice(before);
  assert.deepEqual(
    notices.map((n) => [n.urgency, n.to_name]),
    [
      ["fyi", "lead"],
      ["fyi", "lead"],
      ["normal", "lead"],
    ],
  );
  assert.deepEqual(notices.map((n) => n.route), ["digest", "digest", "now"], "a busy creator is not interrupted by progress, and done reaches it at its next tool call");
  const last = await until(() => lead.frames.find((f) => parseEnvelope(messageContent(f))?.body.includes(`${task.id}] Full lifecycle: done`)));
  const body = parseEnvelope(messageContent(last))!.body;
  assert.ok(body.includes("(by @codex-worker)"));
  assert.ok(body.includes("Result: Migration added and reversible"));
  assert.ok(body.includes("Evidence: npm test: 212 passed; commit 4f2c1ab"));
  assert.equal(last.priority, "next");
  await assert.rejects(update(task.id, "failed", worker), /done cannot become failed/);
});

test("when the creator cancels, the assignee hears about it", async () => {
  const { task } = await create({ title: "Cancel me" });
  broker.take("thread-worker");
  const out = await update(task.id, "cancelled", leadMe());
  assert.equal(out.task.status, "cancelled");
  const notice = noticesFor(task.id).at(-1)!;
  assert.deepEqual([notice.to_name, notice.urgency], [worker.name, "normal"]);
});

test("a cancellation reaches a busy Claude assignee now, not in a digest up to 15 minutes later", async () => {
  const { task } = await rpc<{ task: TaskRow }>("task_create", {
    from: partyOf(worker),
    to: { kind: "claude", addr: encodeAddress(lead.socketPath), name: lead.name, sessionId: lead.sessionId },
    title: "Stop me if plans change",
    body: "A long job that may be called off.",
  });
  await update(task.id, "cancelled", worker);
  const notice = noticesFor(task.id).at(-1)!;
  assert.deepEqual([notice.to_name, notice.urgency, notice.status], ["lead", "normal", "sent"]);
  assert.notEqual(notice.route, "digest");
  await until(() => lead.frames.find((f) => parseEnvelope(messageContent(f))?.body.includes("Stop me if plans change: cancelled")));
});

test("a task past its expiry becomes expired and the creator is told; finished tasks are left alone", async () => {
  const open = await create({ title: "Will lapse", expiresInMinutes: 60 });
  const finished = await create({ title: "Already done", expiresInMinutes: 60 });
  await update(finished.task.id, "done", worker, { result: "ok" });
  const count = noticesFor(open.task.id).length;
  await broker.runSweep(Date.now() + 30 * 60_000);
  assert.equal(broker.store.getTask(open.task.id)!.status, "open", "not yet");
  await broker.runSweep(Date.now() + 2 * HOUR);
  assert.equal(broker.store.getTask(open.task.id)!.status, "expired");
  assert.equal(broker.store.getTask(finished.task.id)!.status, "done");
  const notices = noticesFor(open.task.id);
  assert.equal(notices.length, count + 1);
  assert.equal(notices.at(-1)!.to_name, "lead");
  assert.equal(notices.at(-1)!.urgency, "fyi");
  assert.match(notices.at(-1)!.body, /Will lapse: expired/);
  await broker.runSweep(Date.now() + 3 * HOUR);
  assert.equal(noticesFor(open.task.id).length, count + 1, "expiry is told once");
  const late = await update(open.task.id, "done", worker, { result: "finished after the deadline", evidence: "commit 9d8c7b6" });
  assert.equal(late.task.status, "done", "the assignee may still report a late result on an expired task");
  assert.equal(late.task.result, "finished after the deadline");
  assert.equal(noticesFor(open.task.id).length, count + 2, "and the creator is told");
});

test("tasks can be listed by role and status, and read back by id", async () => {
  const { task } = await create({ title: "Listed" });
  const mine = await rpc<TaskRow[]>("task_list", { party: encodeAddress(worker.socketPath!), session: worker.session, role: "assignee" });
  assert.ok(mine.some((t) => t.id === task.id));
  assert.ok(mine.every((t) => ["open", "accepted", "in_progress"].includes(t.status)), "the default is active tasks");
  const created = await rpc<TaskRow[]>("task_list", { party: encodeAddress(leadMe().socketPath!), role: "creator", status: "all" });
  assert.ok(created.some((t) => t.id === task.id) && created.some((t) => t.status === "done"));
  const none = await rpc<TaskRow[]>("task_list", { party: encodeAddress(helper.socketPath!), role: "assignee" });
  assert.equal(none.length, 0);
  assert.equal((await rpc<TaskRow>("task_get", { taskId: task.id, party: partyOf(leadMe()) })).title, "Listed");
  await assert.rejects(rpc("task_get", { taskId: "T-000000", party: partyOf(leadMe()) }), /no task/);
});

test("a task that cannot be delivered is not left behind, and a caller with no inbox cannot create one", async () => {
  const before = Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n);
  await assert.rejects(create({ to: { kind: "claude", addr: encodeAddress(`${root}/cc-socks/ghost.sock`), name: "ghost" } }), /no inbox socket/);
  await assert.rejects(create({ from: { kind: "cli", name: "shell", addr: null } }), /no inbox address/);
  await assert.rejects(create({ title: "  ", body: "x" }), /needs a title/);
  await assert.rejects(create({ to: partyOf(leadMe()) , title: "self" }), /yourself|to\.kind/);
  assert.equal(Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n), before);
});
