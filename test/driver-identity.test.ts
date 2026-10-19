import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import { isDriver } from "../src/router.ts";
import type { Party, Target } from "../src/routing.ts";
import { fakeClaude, livePid, root, type FakeClaude } from "./support.ts";

const broker = new Broker({ classifier: () => undefined, wakeEnabled: false });
const ccdir = process.env.AGENTSOCKS_CCSOCKS_DIR!;

const codexAddr = (id: string): string => encodeAddress(threadSocketPath(id));
const codexParty = (id: string, name: string): Party => ({ kind: "codex", name, addr: codexAddr(id), session: id, mode: null });
const codexTarget = (id: string, name: string): Target => ({ kind: "codex", addr: codexAddr(id), name, threadId: id });
const claudeParty = (sock: string, session: string, name: string): Party => ({ kind: "claude", name, addr: encodeAddress(sock), session, mode: null });
const claudeTarget = (sock: string, session: string, name: string): Target => ({ kind: "claude", addr: encodeAddress(sock), name, sessionId: session });
const send = (from: Party, to: Target, body: string, urgency: "normal" | "fyi" | "urgent" = "normal") =>
  broker.routeSend({ msgId: randomUUID(), from, to, body, urgency });
const op = async <T>(name: string, req: Record<string, unknown> = {}): Promise<T> => {
  const reply: unknown = await broker.dispatch({ op: name, ...req });
  if (reply && typeof reply === "object" && "result" in reply) return reply.result as T;
  throw new Error(`op ${name} returned no result`);
};
before(async () => {
  mkdirSync(ccdir, { recursive: true });
  chmodSync(ccdir, 0o700);
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("isDriver matches stored thread and session identities without live lookups", () => {
  assert.equal(isDriver(undefined, { addr: "uds:old", sid: "session:abc" }, "uds:new", "abc"), true);
  assert.equal(isDriver(undefined, { addr: "uds:old", sid: "session:abc" }, "uds:new", "other"), false);
  assert.equal(isDriver(undefined, { addr: "uds:old", sid: "thread:w" }, "uds:other", "w"), true);
  assert.equal(isDriver(undefined, { addr: "uds:old", sid: null }, "uds:old", null), true);
  assert.equal(isDriver(undefined, { addr: "uds:old", sid: null }, "uds:new", null), false);
  assert.equal(isDriver(undefined, { addr: null, sid: null }, "uds:new", null), false);
});

test("set_driver stores the Claude session identity on the worker thread", async () => {
  await broker.register("w4cident", { cwd: "/w/w4c", state: "busy" });
  const pid = livePid();
  const d: FakeClaude = await fakeClaude("w4cstore", pid, "idle");
  try {
    await op("set_driver", { threadId: "w4cident", addr: encodeAddress(d.socketPath), name: "storedriver" });
    assert.equal(broker.store.getThread("w4cident")!.driver_sid, `session:${d.sessionId}`);
    await op("set_driver", { threadId: "w4cident" });
    assert.equal(broker.store.getThread("w4cident")!.driver_sid, null);
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

test("a Claude driver that never messaged resumes on a new socket and keeps every driver right", async () => {
  await broker.register("w4cresume", { cwd: "/w/w4c", state: "busy" });
  const pidA = livePid();
  const a: FakeClaude = await fakeClaude("w4cresumer", pidA, "idle");
  let b: FakeClaude | undefined;
  try {
    await op("set_driver", { threadId: "w4cresume", addr: encodeAddress(a.socketPath), name: "resumer" });
    await closeServer(a.server);
    unlinkSync(join(root, "claude-sessions", `${pidA}.json`));
    const pidB = livePid();
    b = await fakeClaude("w4cresumer", pidB, "busy", `${pidB}.sock`);
    assert.equal(b.sessionId, a.sessionId);
    const driver = claudeParty(b.socketPath, b.sessionId, "resumer");
    const worker = codexTarget("w4cresume", "worker");
    const created = await op<{ task: { id: string } }>("task_create", { from: driver, to: worker, title: "Do it", body: "details" });
    assert.match(created.task.id, /^T-/);
    const first = await send(driver, worker, "first instruction after resume");
    assert.notEqual(first.decision.rule, "not-from-driver");
    assert.equal(first.decision.route, "now");
    assert.match(broker.take("w4cresume").text, /From your driver/);
    const firstReport = await send(codexParty("w4cresume", "worker"), claudeTarget(b.socketPath, b.sessionId, "resumer"), "status update one");
    assert.ok(firstReport.decision.route === "pause" || firstReport.decision.route === "now", `first report routes ${firstReport.decision.route}`);
    const report = await send(codexParty("w4cresume", "worker"), claudeTarget(b.socketPath, b.sessionId, "resumer"), "status update two");
    assert.equal(report.decision.route, "pause");
    assert.equal(report.decision.rule, "report-to-driver");
    const urgent = await send(driver, worker, "drop everything", "urgent");
    assert.equal(urgent.decision.urgency, "urgent");
    assert.equal(urgent.decision.route, "now");
  } finally {
    if (b) await closeServer(b.server).catch(() => {});
    await closeServer(a.server).catch(() => {});
  }
});

test("a forged session claim cannot steal a binding whose driver is still live", async () => {
  await broker.register("w4cguard", { cwd: "/w/w4c", state: "busy" });
  const pidD = livePid();
  const d: FakeClaude = await fakeClaude("w4cguarddriver", pidD, "idle");
  const pidI = livePid();
  const imp: FakeClaude = await fakeClaude("w4cguardimp", pidI, "idle");
  try {
    await op("set_driver", { threadId: "w4cguard", addr: encodeAddress(d.socketPath), name: "guarddriver" });
    await send(claudeParty(d.socketPath, d.sessionId, "guarddriver"), codexTarget("w4cguard", "worker"), "real instruction");
    const bound = broker.store.getThread("w4cguard")!.driver_addr;
    assert.equal(bound, broker.canon(encodeAddress(d.socketPath)));
    const honest = await send(claudeParty(imp.socketPath, imp.sessionId, "imp"), codexTarget("w4cguard", "worker"), "honest stranger");
    assert.equal(honest.decision.rule, "not-from-driver");
    await send(claudeParty(imp.socketPath, d.sessionId, "imp"), codexTarget("w4cguard", "worker"), "forged session claim", "urgent");
    assert.equal(broker.store.getThread("w4cguard")!.driver_addr, bound);
    const back = await send(claudeParty(d.socketPath, d.sessionId, "guarddriver"), codexTarget("w4cguard", "worker"), "real driver again");
    assert.notEqual(back.decision.rule, "not-from-driver");
    assert.equal(broker.store.getThread("w4cguard")!.driver_addr, bound);
  } finally {
    await closeServer(d.server).catch(() => {});
    await closeServer(imp.server).catch(() => {});
  }
});
