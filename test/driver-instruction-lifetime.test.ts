import "./support.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeClaude, livePid, root } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import type { Party, Target } from "../src/routing.ts";

const broker = new Broker({ classifier: () => undefined, wakeEnabled: false });
const ccdir = process.env.AGENTSOCKS_CCSOCKS_DIR!;
const addrOf = (id: string): string => encodeAddress(threadSocketPath(id));
const party = (id: string): Party => ({ kind: "codex", name: id, addr: addrOf(id), session: id, mode: null });
const target = (id: string): Target => ({ kind: "codex", addr: addrOf(id), name: id, threadId: id });
const op = async <T>(name: string, req: Record<string, unknown> = {}): Promise<T> => ((await broker.dispatch({ op: name, ...req })) as { result: T }).result;
const send = (from: Party, to: Target, body: string, urgency: "normal" | "fyi" | "urgent" = "normal") => broker.routeSend({ msgId: randomUUID(), from, to, body, urgency });
const ruleOf = (r: { decision: { route: string; rule?: string; by: string } }): string => `${r.decision.route}/${r.decision.rule ?? r.decision.by}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const ageAll = (ms: number): void => {
  broker.store.db.prepare("UPDATE outbox SET created_at = created_at - ?").run(ms);
  broker.store.db.prepare("UPDATE messages SET received_at = received_at - ?").run(ms);
  broker.store.db.prepare("UPDATE tasks SET created_at = created_at - ?").run(ms);
  broker.store.db.prepare("UPDATE threads SET driver_instructed_at = CASE WHEN driver_instructed_at IS NULL THEN NULL ELSE driver_instructed_at - ? END").run(ms);
};

before(async () => {
  mkdirSync(ccdir, { recursive: true });
  chmodSync(ccdir, 0o700);
  await broker.start();
});
after(async () => {
  await broker.stop();
});

test("second instruction 40 min before the next report keeps the floor", async () => {
  await op("register", { threadId: "w4el4w", agent: "omp", cwd: "/w/e4", state: "busy" });
  await op("register", { threadId: "w4el4d", agent: "codex", cwd: "/w/e4d", state: "busy" });
  await op("set_driver", { threadId: "w4el4w", addr: addrOf("w4el4d"), name: "w4el4d" });
  await send(party("w4el4d"), target("w4el4w"), "first job");
  await send(party("w4el4w"), target("w4el4d"), "first job done", "fyi");
  ageAll(26 * HOUR);
  await send(party("w4el4d"), target("w4el4w"), "second job");
  ageAll(40 * MIN);
  const r2 = await send(party("w4el4w"), target("w4el4d"), "ok thanks, second job done");
  const r3 = await send(party("w4el4w"), target("w4el4d"), "all green", "fyi");
  assert.equal(ruleOf(r2), "pause/report-to-driver", `second report lost the floor: ${ruleOf(r2)}`);
  assert.equal(ruleOf(r3), "pause/report-to-driver", `chatter after the report lost the floor: ${ruleOf(r3)}`);
});

test("second instruction 2 h after the first report keeps the floor", async () => {
  await op("register", { threadId: "w4el5w", agent: "omp", cwd: "/w/e5", state: "busy" });
  await op("register", { threadId: "w4el5d", agent: "codex", cwd: "/w/e5d", state: "busy" });
  await op("set_driver", { threadId: "w4el5w", addr: addrOf("w4el5d"), name: "w4el5d" });
  await send(party("w4el5d"), target("w4el5w"), "first job");
  await send(party("w4el5w"), target("w4el5d"), "first job done", "fyi");
  ageAll(30 * HOUR);
  await send(party("w4el5d"), target("w4el5w"), "second job");
  ageAll(40 * MIN);
  const r2 = await send(party("w4el5w"), target("w4el5d"), "ok thanks, second job done");
  assert.equal(ruleOf(r2), "pause/report-to-driver", `report inside the window lost the floor: ${ruleOf(r2)}`);
});

test("a day-old instruction lapses", async () => {
  await op("register", { threadId: "w4eexw", agent: "omp", cwd: "/w/ex", state: "busy" });
  await op("register", { threadId: "w4eexd", agent: "codex", cwd: "/w/exd", state: "busy" });
  await op("set_driver", { threadId: "w4eexw", addr: addrOf("w4eexd"), name: "w4eexd" });
  await send(party("w4eexd"), target("w4eexw"), "do it");
  ageAll(25 * HOUR);
  const r = await send(party("w4eexw"), target("w4eexd"), "done a day later", "fyi");
  assert.ok(!ruleOf(r).includes("report-to-driver"), `stale instruction kept the floor: ${ruleOf(r)}`);
  assert.equal(r.decision.route, "digest");
});

test("channel posts and broadcasts never count as instruction", async () => {
  await op("register", { threadId: "w4echw", cwd: "/w/ech", state: "busy" });
  await op("register", { threadId: "w4echs", cwd: "/w/ech", state: "busy" });
  await op("register", { threadId: "w4echr", cwd: "/w/ech", state: "busy" });
  await op("set_driver", { threadId: "w4echw", addr: addrOf("w4echr"), name: "real" });
  await op("set_driver", { threadId: "w4echs", addr: addrOf("w4echw"), name: "w4echw" });
  await op("channel_subscribe", { party: party("w4echs"), channel: "w4eroom" });
  await op("channel_subscribe", { party: party("w4echw"), channel: "w4eroom" });
  await op("channel_send", { from: party("w4echw"), channel: "#w4eroom", body: "room post", urgency: "normal" });
  await op("channel_send", { from: party("w4echw"), channel: "#all", body: "broadcast", urgency: "normal" });
  for (let i = 0; i < 3; i++) {
    const r = await send(party("w4echs"), target("w4echw"), `follow ${i}`);
    assert.equal(ruleOf(r), "pause/not-from-driver", `channel traffic manufactured the floor: ${ruleOf(r)}`);
  }
});

test("the floor caps at 12 reports per rolling hour", async () => {
  await op("register", { threadId: "w4ecapw", agent: "omp", cwd: "/w/cap", state: "busy" });
  await op("register", { threadId: "w4ecapd", agent: "codex", cwd: "/w/capd", state: "busy" });
  await op("set_driver", { threadId: "w4ecapw", addr: addrOf("w4ecapd"), name: "w4ecapd" });
  await send(party("w4ecapd"), target("w4ecapw"), "build it");
  ageAll(40 * MIN);
  for (let i = 0; i < 12; i++) {
    const r = await send(party("w4ecapw"), target("w4ecapd"), `progress ${i}`, "fyi");
    assert.equal(ruleOf(r), "pause/report-to-driver", `report ${i} lost the floor: ${ruleOf(r)}`);
  }
  const over = await send(party("w4ecapw"), target("w4ecapd"), "progress 12", "fyi");
  assert.equal(over.decision.route, "digest", `13th report kept the floor: ${ruleOf(over)}`);
  assert.ok(!ruleOf(over).includes("report-to-driver"));
});

test("a stranger with one reply gains at most 12 floors an hour", async () => {
  await op("register", { threadId: "w4estrw", cwd: "/w/estr", state: "busy" });
  await op("register", { threadId: "w4estrs", cwd: "/w/estr", state: "busy" });
  await op("set_driver", { threadId: "w4estrs", addr: addrOf("w4estrw"), name: "w4estrw" });
  await send(party("w4estrs"), target("w4estrw"), "question from a stranger");
  await send(party("w4estrw"), target("w4estrs"), "one direct reply");
  ageAll(40 * MIN);
  for (let i = 0; i < 12; i++) {
    const r = await send(party("w4estrs"), target("w4estrw"), `stranger follow ${i}`);
    assert.equal(ruleOf(r), "pause/report-to-driver", `stranger follow ${i} lost the floor: ${ruleOf(r)}`);
  }
  const over = await send(party("w4estrs"), target("w4estrw"), "stranger follow 12");
  assert.equal(over.decision.route, "digest", `13th stranger message kept the floor: ${ruleOf(over)}`);
  assert.ok(!ruleOf(over).includes("report-to-driver"));
});

test("same-socket new driver session re-binds", async () => {
  await op("register", { threadId: "w4erbw", agent: "omp", cwd: "/w/erb", state: "busy" });
  const pid = livePid();
  const d = await fakeClaude("w4erbd", pid, "busy");
  try {
    await op("set_driver", { threadId: "w4erbw", addr: encodeAddress(d.socketPath), name: d.name });
    const oldSid = broker.store.getThread("w4erbw")!.driver_sid;
    assert.equal(oldSid, `session:${d.sessionId}`);
    const newSid = "w4erbd-session-after-clear";
    writeFileSync(join(root, "claude-sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: newSid, cwd: "/work/w4erbd", name: d.name, messagingSocketPath: d.socketPath, kind: "interactive", status: "busy" }));
    const from = encodeAddress(d.socketPath);
    const first = await send({ kind: "claude", name: d.name, addr: from, session: newSid, mode: null }, target("w4erbw"), "instruction after clear");
    assert.notEqual(ruleOf(first), "digest/not-from-driver", `K3 re-binds before views: first message routes as driver, got ${ruleOf(first)}`);
    assert.equal(broker.store.getThread("w4erbw")!.driver_sid, `session:${newSid}`);
    const second = await send({ kind: "claude", name: d.name, addr: from, session: newSid, mode: null }, target("w4erbw"), "second instruction");
    assert.equal(ruleOf(second), "now/default", `re-bound driver still routed as stranger: ${ruleOf(second)}`);
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

test("a binding live elsewhere never moves", async () => {
  await op("register", { threadId: "w4ez8w", agent: "omp", cwd: "/w/ez8", state: "busy" });
  const pidA = livePid();
  const a = await fakeClaude("w4ez8d", pidA, "busy");
  const pidB = livePid();
  const b = await fakeClaude("w4ez8e", pidB, "busy");
  try {
    await op("set_driver", { threadId: "w4ez8w", addr: encodeAddress(a.socketPath), name: a.name });
    const newSid = "w4ez8d-session-elsewhere-test";
    writeFileSync(join(root, "claude-sessions", `${pidA}.json`), JSON.stringify({ pid: pidA, sessionId: newSid, cwd: "/work/w4ez8d", name: a.name, messagingSocketPath: a.socketPath, kind: "interactive", status: "busy" }));
    writeFileSync(join(root, "claude-sessions", `${pidB}.json`), JSON.stringify({ pid: pidB, sessionId: a.sessionId, cwd: "/work/w4ez8e", name: "w4ez8e", messagingSocketPath: b.socketPath, kind: "interactive", status: "busy" }));
    const r = await send({ kind: "claude", name: a.name, addr: encodeAddress(a.socketPath), session: newSid, mode: null }, target("w4ez8w"), "spoofed instruction");
    assert.equal(broker.store.getThread("w4ez8w")!.driver_sid, `session:${a.sessionId}`);
    assert.equal(ruleOf(r), "digest/not-from-driver", `moved binding routed as driver: ${ruleOf(r)}`);
  } finally {
    await closeServer(b.server).catch(() => {});
    await closeServer(a.server).catch(() => {});
  }
});

test("a session-less task from the bound driver socket is the driver", async () => {
  await op("register", { threadId: "w4escw", agent: "omp", cwd: "/w/esc", state: "busy" });
  const pid = livePid();
  const d = await fakeClaude("w4escd", pid, "busy");
  try {
    await op("set_driver", { threadId: "w4escw", addr: encodeAddress(d.socketPath), name: d.name });
    const created = await op<{ task: { id: string } }>("task_create", {
      from: { kind: "claude", name: d.name, addr: encodeAddress(d.socketPath), session: null, mode: null },
      to: target("w4escw"),
      title: "session-less instruction",
      body: "details",
    });
    assert.match(created.task.id, /^T-[0-9a-f]{6}$/);
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

test("the information note to a sender names the live driver", async () => {
  await op("register", { threadId: "w4elnw", agent: "omp", cwd: "/w/eln", state: "busy" });
  await op("register", { threadId: "w4elns", agent: "codex", cwd: "/w/eln", state: "busy" });
  const pid = livePid();
  const d = await fakeClaude("w4elnd", pid, "busy");
  try {
    await op("set_driver", { threadId: "w4elnw", addr: encodeAddress(d.socketPath), name: "w4ebind" });
    writeFileSync(join(root, "claude-sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: d.sessionId, cwd: "/work/w4elnd", name: "w4elive", messagingSocketPath: d.socketPath, kind: "interactive", status: "busy" }));
    const r = await send(party("w4elns"), target("w4elnw"), "stranger note");
    assert.equal(ruleOf(r), "digest/not-from-driver", `unexpected route: ${ruleOf(r)}`);
    assert.equal(r.decision.driverName, "w4elive");
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

test("the task refusal names the live driver", async () => {
  await op("register", { threadId: "w4elrw", agent: "omp", cwd: "/w/elr", state: "busy" });
  await op("register", { threadId: "w4elrs", agent: "codex", cwd: "/w/elr", state: "busy" });
  const pid = livePid();
  const d = await fakeClaude("w4elrd", pid, "busy");
  try {
    await op("set_driver", { threadId: "w4elrw", addr: encodeAddress(d.socketPath), name: "w4ebind" });
    writeFileSync(join(root, "claude-sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: d.sessionId, cwd: "/work/w4elrd", name: "w4elive", messagingSocketPath: d.socketPath, kind: "interactive", status: "busy" }));
    await assert.rejects(op("task_create", { from: party("w4elrs"), to: target("w4elrw"), title: "stranger task", body: "details" }), /w4elive/);
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});
