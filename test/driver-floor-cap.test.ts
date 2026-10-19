import "./support.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { fakeClaude, livePid } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import type { Decision } from "../src/router.ts";
import type { Party, Target } from "../src/routing.ts";

const broker = new Broker({ classifier: () => undefined, wakeEnabled: false });
const ccdir = process.env.AGENTSOCKS_CCSOCKS_DIR!;
const addrOf = (id: string): string => encodeAddress(threadSocketPath(id));
const party = (id: string): Party => ({ kind: "codex", name: id, addr: addrOf(id), session: id, mode: null });
const target = (id: string): Target => ({ kind: "codex", addr: addrOf(id), name: id, threadId: id });
const op = async <T>(name: string, req: Record<string, unknown> = {}): Promise<T> => ((await broker.dispatch({ op: name, ...req })) as { result: T }).result;
const send = async (from: Party, to: Target, body: string, urgency: "normal" | "fyi" | "urgent" = "normal") => {
  const r = await broker.routeSend({ msgId: randomUUID(), from, to, body, urgency });
  assert.ok(r, "routeSend returned nothing");
  return r;
};
const ruleOf = (r: { decision: { route: string; rule?: string; by: string } }): string => `${r.decision.route}/${r.decision.rule ?? r.decision.by}`;
const isFloored = (r: { decision: Decision }): boolean => "floored" in r.decision && r.decision.floored === true;
const stamp = (id: string): number | null => broker.store.getThread(id)?.driver_instructed_at ?? null;
const MIN = 60_000;
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

test("set_driver to a different driver clears the instruction stamp", async () => {
  for (const id of ["k1w", "k1d1", "k1rv"]) await op("register", { threadId: id, agent: id === "k1w" ? "omp" : "codex", cwd: `/w/${id}`, state: "busy" });
  await op("set_driver", { threadId: "k1w", addr: addrOf("k1d1"), name: "k1d1" });
  await send(party("k1d1"), target("k1w"), "first driver instructs");
  assert.notEqual(stamp("k1w"), null, "driver instruction did not stamp");
  ageAll(40 * MIN);
  await op("set_driver", { threadId: "k1w", addr: addrOf("k1rv"), name: "k1rv" });
  assert.equal(stamp("k1w"), null, "set_driver to a different identity kept the old driver stamp");
  for (let i = 0; i < 5; i++) {
    const r = await send(party("k1w"), target("k1rv"), `unsolicited report to new driver ${i}`, "fyi");
    assert.ok(!ruleOf(r).includes("report-to-driver"), `report ${i} used the stale floor: ${ruleOf(r)}`);
    assert.equal(r.decision.route, "digest", `report ${i} did not route normally: ${ruleOf(r)}`);
  }
});

test("re-binding the same driver keeps the stamp; clearing drops it", async () => {
  await send(party("k1rv"), target("k1w"), "orders from the current driver");
  assert.notEqual(stamp("k1w"), null, "instruction from the current driver did not stamp");
  await op("set_driver", { threadId: "k1w", addr: addrOf("k1rv"), name: "k1rv" });
  assert.notEqual(stamp("k1w"), null, "same-driver re-bind cleared the stamp");
  const r = await send(party("k1w"), target("k1rv"), "report after same-driver re-bind", "fyi");
  assert.equal(ruleOf(r), "now/awaited-reply", `re-bound driver lost the floor: ${ruleOf(r)}`);
  assert.ok(isFloored(r), "re-bound driver report misses the marker");
  await op("set_driver", { threadId: "k1w" });
  assert.equal(stamp("k1w"), null, "clearing the driver kept the stamp");
});

test("an idle driven victim floors at most 12 an hour, marker counted", async () => {
  for (const id of ["k2v", "k2s", "k2o", "k2p"]) await op("register", { threadId: id, agent: id === "k2v" ? "omp" : "codex", cwd: `/w/${id}`, state: "busy" });
  await op("set_driver", { threadId: "k2v", addr: addrOf("k2p"), name: "k2p" });
  await op("set_driver", { threadId: "k2s", addr: addrOf("k2v"), name: "k2v" });
  await send(party("k2s"), target("k2v"), "stranger asks");
  await send(party("k2v"), target("k2s"), "one reply");
  ageAll(35 * MIN);
  await op("register", { threadId: "k2v", agent: "omp", cwd: "/w/k2v", state: "idle" });
  await broker.hook({ threadId: "k2v", event: "Stop" }).catch(() => undefined);
  const rs = [];
  for (let i = 0; i < 16; i++) rs.push(await send(party("k2s"), target("k2v"), `stranger idle ${i}`));
  const floored = rs.filter(isFloored);
  assert.equal(floored.length, 12, `expected 12 floored rows, got ${floored.length}: ${rs.map(ruleOf).join(" ")}`);
  for (const [i, r] of rs.entries()) {
    if (i < 12) assert.equal(ruleOf(r), "now/receiver-idle", `floored idle ${i} misrouted: ${ruleOf(r)}`);
    else {
      assert.equal(ruleOf(r), "digest/not-from-driver", `over-cap idle ${i} kept the floor: ${ruleOf(r)}`);
      assert.ok(!isFloored(r), `over-cap idle ${i} carries the marker`);
    }
  }
});

test("urgent and awaited floors carry the marker and count toward the cap", async () => {
  for (const id of ["k2uw", "k2ud"]) await op("register", { threadId: id, agent: "codex", cwd: `/w/${id}`, state: "busy" });
  await op("set_driver", { threadId: "k2uw", addr: addrOf("k2ud"), name: "k2ud" });
  await send(party("k2ud"), target("k2uw"), "do this");
  ageAll(35 * MIN);
  const urgents = [];
  urgents.push(await send(party("k2uw"), target("k2ud"), "urgent progress alpha", "urgent"));
  urgents.push(await send(party("k2uw"), target("k2ud"), "urgent progress beta", "urgent"));
  for (const r of urgents) {
    assert.equal(ruleOf(r), "now/urgent", `urgent floor misrouted: ${ruleOf(r)}`);
    assert.ok(isFloored(r), "urgent floor misses the marker");
  }
  for (const id of ["k2av", "k2as"]) await op("register", { threadId: id, agent: "codex", cwd: `/w/${id}`, state: "busy" });
  await op("set_driver", { threadId: "k2as", addr: addrOf("k2av"), name: "k2av" });
  await send(party("k2av"), target("k2as"), "answer this");
  const follows = [];
  for (let i = 0; i < 13; i++) follows.push(await send(party("k2as"), target("k2av"), `awaited follow ${i}`));
  const marked = follows.filter(isFloored);
  assert.equal(marked.length, 12, `expected 12 floored awaited rows, got ${marked.length}: ${follows.map(ruleOf).join(" ")}`);
  for (const [i, r] of follows.entries()) {
    if (i < 12) assert.equal(ruleOf(r), "now/awaited-reply", `awaited floor ${i} misrouted: ${ruleOf(r)}`);
    else assert.ok(!isFloored(r), "13th awaited message kept the marker");
  }
});

test("a delivered duplicate merges even when the sender holds the floor", async () => {
  await op("register", { threadId: "k8w", agent: "omp", cwd: "/w/k8w", state: "busy" });
  await op("register", { threadId: "k8d", agent: "codex", cwd: "/w/k8d", state: "busy" });
  await op("set_driver", { threadId: "k8w", addr: addrOf("k8d"), name: "k8d" });
  await send(party("k8d"), target("k8w"), "do the job");
  ageAll(40 * MIN);
  const first = await send(party("k8w"), target("k8d"), "job is done", "fyi");
  assert.equal(ruleOf(first), "pause/report-to-driver", `first report lost the floor: ${ruleOf(first)}`);
  assert.ok(isFloored(first), "first report misses the marker");
  broker.take("k8d");
  const dup = await send(party("k8w"), target("k8d"), "job is done", "fyi");
  assert.equal(dup.decision.route, "merge", `delivered duplicate did not merge under the floor: ${ruleOf(dup)}`);
  assert.equal(dup.decision.rule, "duplicate", `duplicate merged under the wrong rule: ${ruleOf(dup)}`);
});

test("a task from the driver stamps through the delivery path", async () => {
  await op("register", { threadId: "k5w", agent: "codex", cwd: "/w/k5w", state: "busy" });
  await op("register", { threadId: "k5d", agent: "codex", cwd: "/w/k5d", state: "busy" });
  await op("set_driver", { threadId: "k5w", addr: addrOf("k5d"), name: "k5d" });
  await send(party("k5d"), target("k5w"), "do this");
  broker.store.db.prepare("UPDATE threads SET driver_instructed_at = NULL WHERE thread_id = 'k5w'").run();
  const created = await op<{ task: { id: string } }>("task_create", { from: party("k5d"), to: target("k5w"), title: "driver task", body: "details" });
  assert.match(created.task.id, /^T-[0-9a-f]{6}$/);
  assert.notEqual(stamp("k5w"), null, "task delivery from the driver did not stamp");
});

test("a Claude-to-Claude task performs no side-channel stamp", async () => {
  await op("register", { threadId: "k5c", agent: "codex", cwd: "/w/k5c", state: "busy" });
  const pidD = livePid();
  const d = await fakeClaude("k5dd", pidD, "busy");
  const pidW = livePid();
  const w = await fakeClaude("k5ww", pidW, "busy");
  try {
    await op("set_driver", { threadId: "k5c", addr: encodeAddress(d.socketPath), name: d.name });
    const from = { kind: "claude", name: d.name, addr: encodeAddress(d.socketPath), session: d.sessionId, mode: null };
    const to = { kind: "claude", addr: encodeAddress(w.socketPath), name: w.name, threadId: "k5c" };
    const created = await op<{ task: { id: string } }>("task_create", { from, to, title: "driver task", body: "details" });
    assert.match(created.task.id, /^T-[0-9a-f]{6}$/);
    assert.equal(stamp("k5c"), null, "Claude-to-Claude task stamped outside the delivery path");
  } finally {
    await closeServer(w.server).catch(() => {});
    await closeServer(d.server).catch(() => {});
  }
});
