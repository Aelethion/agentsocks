import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import { isDriverSender } from "../src/router.ts";
import type { Party, Target } from "../src/routing.ts";
import { fakeClaude, livePid, root, type FakeClaude } from "./support.ts";

const broker = new Broker({ classifier: () => undefined, wakeEnabled: false });
const ccdir = process.env.AGENTSOCKS_CCSOCKS_DIR!;

const codexAddr = (id: string): string => encodeAddress(threadSocketPath(id));
const codexParty = (id: string, name: string, addr?: string): Party =>
  ({ kind: "codex", name, addr: addr ?? codexAddr(id), session: id, mode: null });
const codexTarget = (id: string, name: string): Target =>
  ({ kind: "codex", addr: codexAddr(id), name, threadId: id });
const claudeParty = (sock: string, session: string, name: string): Party =>
  ({ kind: "claude", name, addr: encodeAddress(sock), session, mode: null });
const bindDriver = async (worker: string, addr: string, name: string): Promise<void> => {
  await broker.dispatch({ op: "set_driver", threadId: worker, addr, name });
};
const send = (from: Party, to: Target, body: string, urgency: "normal" | "fyi" = "normal") =>
  broker.routeSend({ msgId: randomUUID(), from, to, body, urgency });
before(async () => {
  mkdirSync(ccdir, { recursive: true });
  chmodSync(ccdir, 0o700);
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("isDriverSender matches by thread, session and canon address", () => {
  assert.ok(isDriverSender({ threadId: "t1" }, { threadId: "t1" }));
  assert.ok(isDriverSender({ threadId: "t1", addr: "uds:/old" }, { threadId: "t1", addr: "uds:/new" }));
  assert.ok(isDriverSender({ threadId: "t1" }, { session: "t1" }));
  assert.ok(isDriverSender({ session: "s1" }, { session: "s1", addr: "uds:/changed" }));
  assert.ok(isDriverSender({ addr: "uds:/same" }, { addr: "uds:/same" }));
  assert.ok(!isDriverSender({ threadId: "t1" }, { threadId: "t2" }));
  assert.ok(!isDriverSender({ session: "s1" }, { session: "s2" }));
  assert.ok(!isDriverSender({ threadId: "t1" }, { addr: "uds:/other" }));
  assert.ok(!isDriverSender({}, { threadId: "t1" }));
});

test("a live driver's namespaced instructions read under From your driver", async () => {
  await broker.register("w4bworker", { cwd: "/w/w4b", state: "busy" });
  await broker.register("w4bdriver", { cwd: "/w/w4bdriver", state: "busy" });
  await broker.register("w4bstranger", { cwd: "/w/w4b", state: "busy" });
  const driverName = broker.store.getThread("w4bdriver")!.name;
  const ns = broker.describe(broker.store.getThread("w4bdriver")!).socketPath;
  assert.notEqual(ns, threadSocketPath("w4bdriver"));
  await bindDriver("w4bworker", encodeAddress(ns), driverName);
  const r = await send(codexParty("w4bdriver", driverName, encodeAddress(ns)), codexTarget("w4bworker", "worker"), "rebuild the index");
  assert.notEqual(r.decision.rule, "not-from-driver");
  await send(codexParty("w4bstranger", "stranger"), codexTarget("w4bworker", "worker"), "unrelated chatter");
  const text = broker.take("w4bworker").text;
  assert.match(text, new RegExp(`\\[agentsocks\\] From your driver \\(${driverName}\\):`), "grouped under the driver's live name (Y10)");
  assert.match(text, /rebuild the index/);
  assert.match(text, new RegExp(`\\[agentsocks\\] From other sessions \\(information only; your driver is ${driverName}\\):`));
  assert.match(text, /unrelated chatter/);
});

test("a stranger's declaration buys no floor, the sender budget applies", async () => {
  await broker.register("w4bplain", { cwd: "/w/w4b", state: "busy" });
  await broker.register("w4bfaker", { cwd: "/w/w4b", state: "busy" });
  await bindDriver("w4bfaker", codexAddr("w4bplain"), "plain");
  const to = codexTarget("w4bplain", "plain");
  const results = [];
  for (let i = 0; i < 14; i++) {
    results.push(await send(codexParty("w4bfaker", "faker"), to, `faker note ${i}`));
  }
  assert.ok(results.every((x) => x.decision.rule !== "report-to-driver"));
  for (const x of results.slice(10)) assert.equal(x.decision.rule, "sender-budget");
});

test("a real worker reporting to its instructing driver keeps the floor", async () => {
  await broker.register("w4bboss", { cwd: "/w/w4b", state: "busy" });
  await broker.register("w4brep", { cwd: "/w/w4b", state: "busy" });
  await bindDriver("w4brep", codexAddr("w4bboss"), "boss");
  await send(codexParty("w4bboss", "boss"), codexTarget("w4brep", "rep"), "ship the fix today");
  const to = codexTarget("w4bboss", "boss");
  for (let i = 0; i < 11; i++) {
    const r = await send(codexParty("w4brep", "rep"), to, `status update ${i}`);
    assert.ok(r.decision.route === "pause" || r.decision.route === "now", `report ${i} routes ${r.decision.route}`);
    assert.ok(r.decision.rule === "report-to-driver" || r.decision.rule === "awaited-reply", `report ${i} rule ${r.decision.rule}`);
  }
  const fyi = await send(codexParty("w4brep", "rep"), to, "fyi only", "fyi");
  assert.ok(fyi.decision.route === "pause" || fyi.decision.route === "now");
  assert.notEqual(fyi.decision.rule, "sender-budget");
});

test("a Claude driver resuming on a new socket keeps the binding", async () => {
  await broker.register("w4bclaudeworker", { cwd: "/w/w4b", state: "busy" });
  const pidA = livePid();
  const a: FakeClaude = await fakeClaude("w4bresumer", pidA, "idle");
  try {
    await bindDriver("w4bclaudeworker", encodeAddress(a.socketPath), "resumer");
    const first = await send(claudeParty(a.socketPath, a.sessionId, "resumer"), codexTarget("w4bclaudeworker", "worker"), "do the first thing");
    assert.equal(first.decision.route, "now");
    assert.match(broker.take("w4bclaudeworker").text, /From your driver/);
    await closeServer(a.server);
    unlinkSync(join(root, "claude-sessions", `${pidA}.json`));
    const pidB = livePid();
    const b: FakeClaude = await fakeClaude("w4bresumer", pidB, "idle", `${pidB}.sock`);
    try {
      assert.equal(b.sessionId, a.sessionId);
      const second = await send(claudeParty(b.socketPath, b.sessionId, "resumer"), codexTarget("w4bclaudeworker", "worker"), "do the next thing");
      assert.equal(second.decision.route, "now");
      assert.notEqual(second.decision.rule, "not-from-driver");
      assert.equal(broker.store.getThread("w4bclaudeworker")!.driver_addr, broker.canon(encodeAddress(b.socketPath)));
      const text = broker.take("w4bclaudeworker").text;
      assert.match(text, /\[agentsocks\] From your driver \(w4bresumer\):/, "Z5 renders the live Claude name");
      assert.match(text, /do the next thing/);
    } finally {
      await closeServer(b.server);
    }
  } finally {
    await closeServer(a.server).catch(() => {});
  }
});

test("decision half: a non-driver send to a driven worker names the driver", async () => {
  const driverName = broker.store.getThread("w4bdriver")!.name;
  await bindDriver("w4bworker", codexAddr("w4bdriver"), driverName);
  const r = await send(codexParty("w4bstranger", "stranger"), codexTarget("w4bworker", "worker"), "one more request");
  assert.equal(r.decision.rule, "not-from-driver");
  assert.equal(r.decision.driverName, driverName);
});
