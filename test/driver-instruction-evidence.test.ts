import "./support.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeClaude, livePid, root, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import { driverOfThread } from "../src/status.ts";
import type { Party, Target } from "../src/routing.ts";

const broker = new Broker({ classifier: () => undefined, wakeEnabled: false });
const ccdir = process.env.AGENTSOCKS_CCSOCKS_DIR!;
const addrOf = (id: string): string => encodeAddress(threadSocketPath(id));
const party = (id: string): Party => ({ kind: "codex", name: id, addr: addrOf(id), session: id, mode: null });
const target = (id: string): Target => ({ kind: "codex", addr: addrOf(id), name: id, threadId: id });
const op = async <T>(name: string, req: Record<string, unknown> = {}): Promise<T> => ((await broker.dispatch({ op: name, ...req })) as { result: T }).result;
const route = (from: Party, to: Target, body: string, urgency: "normal" | "fyi" | "urgent" = "normal") => broker.routeSend({ msgId: randomUUID(), from, to, body, urgency });
const MIN = 60_000;
const age = (ids: string[], ms: number): void => {
  for (const id of ids) {
    broker.store.db.prepare("UPDATE outbox SET created_at = created_at - ? WHERE from_name = ?").run(ms, id);
    broker.store.db.prepare("UPDATE tasks SET created_at = created_at - ? WHERE from_name = ?").run(ms, id);
  }
};
const noticeFor = async (id: string): Promise<string> => (await broker.hook({ threadId: id, event: "UserPromptSubmit" })).context ?? "";
async function setup(label: string): Promise<{ w: string; s: string; real: string }> {
  const w = `w4d${label}w`;
  const s = `w4d${label}s`;
  const real = `w4d${label}d`;
  await op("register", { threadId: w, cwd: "/w/w4d", state: "busy" });
  await op("register", { threadId: s, cwd: "/w/w4d" });
  await op("register", { threadId: real, cwd: "/w/w4d" });
  await op("set_driver", { threadId: w, addr: addrOf(real), name: "real" });
  await op("set_driver", { threadId: s, addr: addrOf(w), name: w });
  return { w, s, real };
}
async function followupRules(s: string, w: string, n = 12): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await route(party(s), target(w), `follow ${s} ${i}`);
    out.push(`${r.decision.route}/${r.decision.rule ?? r.decision.by}`);
  }
  return out;
}

before(async () => {
  mkdirSync(ccdir, { recursive: true });
  chmodSync(ccdir, 0o700);
  await broker.start();
});
after(async () => {
  await broker.stop();
});

test("a driver reply after a stranger message instructs, capped at 12 floors an hour", async () => {
  const { w, s } = await setup("b");
  await route(party(s), target(w), "question from stranger");
  age([s], 100 * MIN);
  await route(party(w), target(s), "answer after a long turn");
  age([w], 55 * MIN);
  const res = await followupRules(s, w);
  assert.ok(res.every((r) => r === "pause/report-to-driver"), `driver reply lost the floor: ${res.join(" ")}`);
  const over = await route(party(s), target(w), "one more followup");
  assert.equal(`${over.decision.route}/${over.decision.rule ?? over.decision.by}`, "digest/not-from-driver", `13th followup kept the floor: ${over.decision.route}/${over.decision.rule ?? over.decision.by}`);
});

test("a stranger-task done-notice is not instruction evidence", async () => {
  const w = "w4dcw";
  const s = "w4dcs";
  const real = "w4dcd";
  await op("register", { threadId: w, cwd: "/w/w4d", state: "busy" });
  await op("register", { threadId: s, cwd: "/w/w4d" });
  await op("register", { threadId: real, cwd: "/w/w4d" });
  const created = await op<{ task: { id: string } }>("task_create", { from: party(s), to: target(w), title: "stranger task", body: "details" });
  age([s], 3 * 3_600_000);
  await op("set_driver", { threadId: w, addr: addrOf(real), name: "real" });
  await op("task_update", { actor: party(w), taskId: created.task.id, status: "accepted" });
  await op("task_update", { actor: party(w), taskId: created.task.id, status: "done", result: "ok" });
  age([w], 40 * MIN);
  await op("set_driver", { threadId: s, addr: addrOf(w), name: w });
  const res = await followupRules(s, w);
  assert.ok(!res.some((r) => r.includes("report-to-driver")), `done-notice manufactured the floor: ${res.join(" ")}`);
});

test("a receiver-created task keeps the floor", async () => {
  const { w, s } = await setup("d");
  await op("task_create", { from: party(w), to: target(s), title: "w asks s", body: "details" });
  age([w], 40 * MIN);
  const res = await followupRules(s, w);
  assert.ok(res.some((r) => r.includes("report-to-driver")), `receiver-created task lost the floor: ${res.join(" ")}`);
});

test("an unprompted direct message keeps the floor", async () => {
  const { w, s } = await setup("n");
  await route(party(w), target(s), "unprompted note from the worker");
  age([w], 40 * MIN);
  const res = await followupRules(s, w);
  assert.ok(res.some((r) => r.includes("report-to-driver")), `unprompted message lost the floor: ${res.join(" ")}`);
});

test("resumed silent Claude driver shows online with the live name", async () => {
  await op("register", { threadId: "w4dw", cwd: "/w/w4d", state: "idle" });
  await op("register", { threadId: "w4ds", cwd: "/w/w4d", state: "busy" });
  const pidA = livePid();
  const a = await fakeClaude("w4ddrv", pidA, "idle");
  let b: FakeClaude | undefined;
  try {
    await op("set_driver", { threadId: "w4dw", addr: encodeAddress(a.socketPath), name: "w4ddrv" });
    await closeServer(a.server);
    unlinkSync(join(root, "claude-sessions", `${pidA}.json`));
    const pidB = livePid();
    b = await fakeClaude("w4ddrv", pidB, "idle", `${pidB}.sock`);
    assert.equal(b.sessionId, a.sessionId);
    writeFileSync(join(root, "claude-sessions", `${pidB}.json`), JSON.stringify({ pid: pidB, sessionId: a.sessionId, cwd: "/work/w4ddrv", name: "w4d-renamed", messagingSocketPath: b.socketPath, kind: "interactive", status: "idle" }));
    await route(party("w4ds"), target("w4dw"), "stranger note");
    const seen = driverOfThread(broker.store, broker.store.getThread("w4dw"));
    assert.equal(seen?.name, "w4d-renamed");
    assert.ok(!(await noticeFor("w4dw")).includes("offline"), await noticeFor("w4dw"));
  } finally {
    if (b) await closeServer(b.server).catch(() => {});
    await closeServer(a.server).catch(() => {});
  }
});

test("worker report before the driver speaks after resume", async () => {
  await op("register", { threadId: "w4dew", cwd: "/w/w4d", state: "busy" });
  const pidA = livePid();
  const a = await fakeClaude("w4dedrv", pidA, "idle");
  let b: FakeClaude | undefined;
  try {
    await op("set_driver", { threadId: "w4dew", addr: encodeAddress(a.socketPath), name: "w4dedrv" });
    await route({ kind: "claude", name: "w4dedrv", addr: encodeAddress(a.socketPath), session: a.sessionId, mode: null }, target("w4dew"), "do the build");
    await closeServer(a.server);
    unlinkSync(join(root, "claude-sessions", `${pidA}.json`));
    const pidB = livePid();
    b = await fakeClaude("w4dedrv", pidB, "busy", `${pidB}.sock`);
    const r = await broker.routeSend({
      msgId: randomUUID(),
      from: party("w4dew"),
      to: { kind: "claude", addr: encodeAddress(b.socketPath), name: "w4dedrv", sessionId: b.sessionId },
      body: "build done, first report after your resume",
      urgency: "normal",
    });
    assert.equal(`${r.decision.route}/${r.decision.rule ?? r.decision.by}`, "pause/report-to-driver");
  } finally {
    if (b) await closeServer(b.server).catch(() => {});
    await closeServer(a.server).catch(() => {});
  }
});

test("a channel post and a broadcast with no stranger message first are not instruction evidence", async () => {
  const { w, s } = await setup("f");
  await op("channel_subscribe", { party: party(s), channel: "w4droom" });
  await op("channel_subscribe", { party: party(w), channel: "w4droom" });
  await op("channel_send", { from: party(w), channel: "#w4droom", body: "room post", urgency: "normal" });
  await op("channel_send", { from: party(w), channel: "#all", body: "broadcast", urgency: "normal" });
  const res = await followupRules(s, w);
  assert.ok(res.length === 12 && res.every((r) => r === "pause/not-from-driver"), `channel traffic misrouted: ${res.join(" ")}`);
});

test("outbox evidence with no assignment row", async () => {
  const { w, s } = await setup("q");
  const pairTasks = (broker.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE (from_name = ? AND to_name = ?) OR (from_name = ? AND to_name = ?)").get(w, s, s, w) as { n: number }).n;
  assert.equal(pairTasks, 0);
  await route(party(w), target(s), "unprompted note, no tasks anywhere for this pair");
  age([w], 40 * MIN);
  const res = await followupRules(s, w);
  assert.ok(res.some((r) => r.includes("report-to-driver")), `outbox evidence lost the floor: ${res.join(" ")}`);
});

test("a stranger's urgent message to a worker whose driver has no session is downgraded to normal", async () => {
  await op("register", { threadId: "w4dzw", cwd: "/w/w4d", state: "busy" });
  await op("register", { threadId: "w4dzs", cwd: "/w/w4d", state: "busy" });
  await op("set_driver", { threadId: "w4dzw", addr: encodeAddress(join(root, "no-such.sock")), name: "ghost" });
  assert.equal(broker.store.getThread("w4dzw")!.driver_sid, null);
  const r = await route(party("w4dzs"), target("w4dzw"), "urgent from a stranger", "urgent");
  assert.equal(r.decision.urgency, "normal");
  assert.equal(r.decision.rule ?? r.decision.by, "not-from-driver");
});
