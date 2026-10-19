import "./support.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeClaude, livePid, root, until, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { buildEnvelope, encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import { DRIVEN_FLOOR_WINDOW_MS } from "../src/router.ts";
import type { Party, Target } from "../src/routing.ts";

const broker = new Broker({ classifier: () => undefined, wakeEnabled: false });
const ccdir = process.env.AGENTSOCKS_CCSOCKS_DIR!;
const op = async <T>(name: string, req: Record<string, unknown> = {}): Promise<T> => ((await broker.dispatch({ op: name, ...req })) as { result: T }).result;
const MIN = 60_000;
const addrOf = (id: string): string => encodeAddress(threadSocketPath(id));
const party = (id: string): Party => ({ kind: "codex", name: id, addr: addrOf(id), session: id, mode: null });
const target = (id: string): Target => ({ kind: "codex", addr: addrOf(id), name: id, threadId: id });
const claudeParty = (d: FakeClaude, session = d.sessionId): Party => ({ kind: "claude", name: d.name, addr: encodeAddress(d.socketPath), session, mode: null });
const send = async (from: Party, to: Target, body: string, urgency: "normal" | "fyi" | "urgent" = "normal") => broker.routeSend({ msgId: randomUUID(), from, to, body, urgency });
const ruleOf = (r: { decision: { route: string; rule?: string; by: string } }): string => `${r.decision.route}/${r.decision.rule ?? r.decision.by}`;
const stamp = (id: string): number | null => broker.store.getThread(id)?.driver_instructed_at ?? null;
const sidOf = (id: string): string | null => broker.store.getThread(id)?.driver_sid ?? null;
const ageAll = (ms: number): void => {
  broker.store.db.prepare("UPDATE outbox SET created_at = created_at - ?").run(ms);
  broker.store.db.prepare("UPDATE messages SET received_at = received_at - ?").run(ms);
  broker.store.db.prepare("UPDATE tasks SET created_at = created_at - ?").run(ms);
  broker.store.db.prepare("UPDATE threads SET driver_instructed_at = CASE WHEN driver_instructed_at IS NULL THEN NULL ELSE driver_instructed_at - ? END").run(ms);
};
const plainFrame = (from: string, body: string, id: string) => ({ type: "user", message: { role: "user", content: body }, priority: "next", from, msg_id: id });
const envFrame = (from: string, name: string, session: string | undefined, body: string, id: string) => ({ type: "user", message: { role: "user", content: buildEnvelope({ from, fromName: name, ...(session && { fromSession: session }), body }) }, priority: "next", msg_id: id });
const rows = (id: string): string[] => (broker.store.db.prepare("SELECT route, decision FROM messages WHERE to_thread = ? ORDER BY received_at, rowid").all(id) as { route: string; decision: string }[]).map((r) => `${r.route}/${(JSON.parse(r.decision) as { rule?: string }).rule ?? "-"}`);
const clear = (pid: number, d: FakeClaude, session: string): void => {
  writeFileSync(join(root, "claude-sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: session, cwd: `/work/${d.name}`, name: d.name, messagingSocketPath: d.socketPath, kind: "interactive", status: "busy" }));
};

before(async () => { mkdirSync(ccdir, { recursive: true }); chmodSync(ccdir, 0o700); await broker.start(); });
after(async () => { await broker.stop(); });

test("tool send: first message after a driver /clear routes as driver, not digest", async () => {
  await op("register", { threadId: "w4fb-w", agent: "omp", cwd: "/w/w4fb", state: "busy" });
  const pid = livePid();
  const d = await fakeClaude("w4fb-d", pid, "busy");
  try {
    const from = encodeAddress(d.socketPath);
    await op("set_driver", { threadId: "w4fb-w", addr: from, name: d.name });
    await send(claudeParty(d), target("w4fb-w"), "build it");
    const after = "w4fb-d-after-clear";
    clear(pid, d, after);
    const first = await send(claudeParty(d, after), target("w4fb-w"), "first instruction after clear");
    assert.equal(first.decision.route, "now", `first tool send after /clear digested: ${ruleOf(first)}`);
    assert.equal(sidOf("w4fb-w"), `session:${after}`);
    const second = await send(claudeParty(d, after), target("w4fb-w"), "second instruction after clear");
    assert.equal(second.decision.route, "now");
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

test("native frame: frames-only after /clear re-bind the same-socket driver and stamp", async () => {
  await op("register", { threadId: "w4fc-w", agent: "omp", cwd: "/w/w4fc", state: "busy" });
  const pid = livePid();
  const d = await fakeClaude("w4fc-d", pid, "busy");
  try {
    const from = encodeAddress(d.socketPath);
    await op("set_driver", { threadId: "w4fc-w", addr: from, name: d.name });
    await send(claudeParty(d), target("w4fc-w"), "build it");
    const nBefore = rows("w4fc-w").length;
    const after = "w4fc-d-after-clear";
    clear(pid, d, after);
    broker.onFrame("w4fc-w", envFrame(from, d.name, after, "native instruction after clear", "w4fc-f1"));
    await until(() => (rows("w4fc-w").length > nBefore ? true : undefined));
    assert.equal(sidOf("w4fc-w"), `session:${after}`, "native frame did not re-bind the same-socket driver");
    assert.notEqual(stamp("w4fc-w"), null, "native frame from the rebound driver did not stamp");
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

test("forgers never move the binding, stamp, or route as driver", async () => {
  await op("register", { threadId: "w4ff-w", agent: "omp", cwd: "/w/w4ff", state: "busy" });
  const pid = livePid();
  const d = await fakeClaude("w4ff-d", pid, "busy");
  const x = await fakeClaude("w4ff-x", livePid(), "busy");
  try {
    const from = encodeAddress(d.socketPath);
    await op("set_driver", { threadId: "w4ff-w", addr: from, name: d.name });
    await send(claudeParty(d), target("w4ff-w"), "build it");
    const nBefore = rows("w4ff-w").length;
    const t1 = await send(claudeParty(x), target("w4ff-w"), "forger own socket");
    const t2 = await send({ kind: "claude", name: d.name, addr: from, session: x.sessionId, mode: null }, target("w4ff-w"), "forger claims driver addr with its own live session");
    assert.equal(sidOf("w4ff-w"), `session:${d.sessionId}`, "tool forger moved the binding");
    assert.ok(t1.decision.route === "digest" && t2.decision.route === "digest", `tool forgers routed as driver: ${ruleOf(t1)} ${ruleOf(t2)}`);
    broker.onFrame("w4ff-w", envFrame(from, d.name, "forger-session", "frame claims driver addr with a wrong session", "w4ff-f1"));
    await until(() => (rows("w4ff-w").length > nBefore ? true : undefined));
    const last = rows("w4ff-w").at(-1)!;
    assert.ok(!last.startsWith("now/"), `forger frame routed as driver: ${last}`);
    assert.equal(sidOf("w4ff-w"), `session:${d.sessionId}`, "frame forger moved the binding");
  } finally {
    await closeServer(d.server).catch(() => {});
    await closeServer(x.server).catch(() => {});
  }
});

test("driver frame without a claimed session routes and stamps by the resolved identity", async () => {
  await op("register", { threadId: "w4fg-w", agent: "omp", cwd: "/w/w4fg", state: "busy" });
  const pid = livePid();
  const d = await fakeClaude("w4fg-d", pid, "busy");
  try {
    const from = encodeAddress(d.socketPath);
    await op("set_driver", { threadId: "w4fg-w", addr: from, name: d.name });
    broker.store.db.prepare("UPDATE threads SET driver_instructed_at = NULL WHERE thread_id = ?").run("w4fg-w");
    const nBefore = rows("w4fg-w").length;
    broker.onFrame("w4fg-w", plainFrame(from, "plain driver instruction", "w4fg-f1"));
    await until(() => (rows("w4fg-w").length > nBefore ? true : undefined));
    assert.ok(rows("w4fg-w").at(-1)!.startsWith("now/"), `plain driver frame digested: ${rows("w4fg-w").at(-1)}`);
    await until(() => (stamp("w4fg-w") !== null ? true : undefined));
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

test("cap: 12 floors an hour per pair, then digest; the window rolls", async () => {
  assert.equal(DRIVEN_FLOOR_WINDOW_MS, 3_600_000);
  await op("register", { threadId: "w4fh-d", agent: "codex", cwd: "/w/w4fh-d", state: "busy" });
  for (const id of ["w4fh-w1", "w4fh-w2"]) {
    await op("register", { threadId: id, agent: "omp", cwd: `/w/${id}`, state: "busy" });
    await op("set_driver", { threadId: id, addr: addrOf("w4fh-d"), name: "w4fh-d" });
    await send(party("w4fh-d"), target(id), "build it");
  }
  ageAll(40 * MIN);
  const a: string[] = [];
  for (let i = 0; i < 14; i++) a.push(ruleOf(await send(party("w4fh-w1"), target("w4fh-d"), `w1 progress ${i}`, "fyi")));
  assert.deepEqual(a.slice(0, 12), Array(12).fill("pause/report-to-driver"), a.join(" "));
  assert.deepEqual(a.slice(12), ["digest/sender-budget", "digest/sender-budget"], a.join(" "));
  const b = ruleOf(await send(party("w4fh-w2"), target("w4fh-d"), "w2 first report", "fyi"));
  assert.equal(b, "pause/report-to-driver", `cap leaked across pairs: ${b}`);
  ageAll(61 * MIN);
  const c = ruleOf(await send(party("w4fh-w1"), target("w4fh-d"), "w1 after an hour", "fyi"));
  assert.equal(c, "pause/report-to-driver", `rolling window did not reset: ${c}`);
});

test("cap ignores merged, refused and failed rows", async () => {
  await op("register", { threadId: "w4fi-d", agent: "codex", cwd: "/w/w4fi-d", state: "busy" });
  await op("register", { threadId: "w4fi-w", agent: "omp", cwd: "/w/w4fi-w", state: "busy" });
  await op("set_driver", { threadId: "w4fi-w", addr: addrOf("w4fi-d"), name: "w4fi-d" });
  await send(party("w4fi-d"), target("w4fi-w"), "build it");
  ageAll(40 * MIN);
  for (let i = 0; i < 12; i++) await send(party("w4fi-w"), target("w4fi-d"), `progress ${i}`, "fyi");
  const exhausted = ruleOf(await send(party("w4fi-w"), target("w4fi-d"), "thirteenth", "fyi"));
  assert.equal(exhausted, "digest/sender-budget", `cap did not bite at 13: ${exhausted}`);
  broker.store.db.prepare("UPDATE outbox SET status = 'merged' WHERE from_addr = ? AND to_addr = ? AND status = 'sent'").run(addrOf("w4fi-w"), addrOf("w4fi-d"));
  const revived = ruleOf(await send(party("w4fi-w"), target("w4fi-d"), "after merge", "fyi"));
  assert.equal(revived, "pause/report-to-driver", `merged row still counted: ${revived}`);
  broker.store.db.prepare("UPDATE outbox SET status = 'refused' WHERE from_addr = ? AND to_addr = ? AND status IN ('sent','held')").run(addrOf("w4fi-w"), addrOf("w4fi-d"));
  const revived2 = ruleOf(await send(party("w4fi-w"), target("w4fi-d"), "after refuse", "fyi"));
  assert.equal(revived2, "pause/report-to-driver", `refused rows still counted: ${revived2}`);
});

test("strangers never stamp, even urgent; refused stranger tasks never stamp", async () => {
  for (const id of ["w4fj-w", "w4fj-d", "w4fj-s"]) await op("register", { threadId: id, agent: id === "w4fj-w" ? "omp" : "codex", cwd: `/w/${id}`, state: "busy" });
  await op("set_driver", { threadId: "w4fj-w", addr: addrOf("w4fj-d"), name: "w4fj-d" });
  await send(party("w4fj-s"), target("w4fj-w"), "stranger hello");
  await send(party("w4fj-s"), target("w4fj-w"), "stranger urgent", "urgent");
  assert.equal(stamp("w4fj-w"), null, "stranger stamped");
  await assert.rejects(op("task_create", { from: party("w4fj-s"), to: target("w4fj-w"), title: "t", body: "b" }));
  assert.equal(stamp("w4fj-w"), null, "refused stranger task stamped");
  await send(party("w4fj-d"), target("w4fj-w"), "direct instruction", "fyi");
  assert.notEqual(stamp("w4fj-w"), null, "tool send from the driver did not stamp");
});

test("urgent from a non-driver to a driven worker is not a driver report", async () => {
  for (const id of ["w4fk-w", "w4fk-d", "w4fk-s"]) await op("register", { threadId: id, agent: id === "w4fk-w" ? "omp" : "codex", cwd: `/w/${id}`, state: "busy" });
  await op("set_driver", { threadId: "w4fk-w", addr: addrOf("w4fk-d"), name: "w4fk-d" });
  const r = ruleOf(await send(party("w4fk-s"), target("w4fk-w"), "URGENT do this now", "urgent"));
  assert.ok(!r.includes("report-to-driver"), `non-driver urgent took the floor: ${r}`);
});
