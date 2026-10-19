import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import "./support.ts";
import { fakeClaude, livePid, until } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { buildEnvelope, encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import type { Classifier } from "../src/classifier.ts";
import type { Party, Target } from "../src/routing.ts";

let calls = 0;
let useClassifier = false;
const stub: Classifier = {
  name: "stub",
  remote: false,
  threshold: 0.5,
  timeoutMs: 2000,
  classify: async () => {
    calls++;
    return { route: "digest", confidence: 0.99 };
  },
};
const broker = new Broker({ classifier: () => (useClassifier ? stub : undefined), wakeEnabled: false });
const ccdir = process.env.AGENTSOCKS_CCSOCKS_DIR!;
const op = async <T>(name: string, req: Record<string, unknown> = {}): Promise<T> => {
  const reply: unknown = await broker.dispatch({ op: name, ...req });
  if (reply && typeof reply === "object" && "result" in reply) {
    const result = reply.result as T; // op table returns { result } for known ops
    return result;
  }
  throw new Error(`op ${name} returned no result`);
};
const countOf = (row: unknown): number => {
  if (row && typeof row === "object" && "n" in row && typeof row.n === "number") return row.n;
  throw new Error("count query returned no row");
};
const ruleOf = (decision: string): string => {
  const parsed: unknown = JSON.parse(decision);
  if (parsed && typeof parsed === "object" && "rule" in parsed && typeof parsed.rule === "string") return parsed.rule;
  return "-";
};
const frameCount = (id: string): number => countOf(broker.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_thread = ?").get(id));
const frameRows = (id: string): string[] => {
  const rows: unknown = broker.store.db.prepare("SELECT msg_id, route, decision FROM messages WHERE to_thread = ? ORDER BY received_at, rowid").all(id);
  if (!Array.isArray(rows)) throw new Error("message rows query returned no rows");
  return rows.map((row) => {
    if (!row || typeof row !== "object" || !("msg_id" in row) || !("route" in row) || !("decision" in row)) throw new Error("message row has no fields");
    if (typeof row.msg_id !== "string" || typeof row.route !== "string" || typeof row.decision !== "string") throw new Error("message row fields mistyped");
    return `${row.msg_id}:${row.route}/${ruleOf(row.decision)}`;
  });
};
const outboxFrom = (addr: string): number =>
  countOf(broker.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE from_addr = ? AND status NOT IN ('merged','refused','failed')").get(addr));

before(async () => {
  mkdirSync(ccdir, { recursive: true });
  chmodSync(ccdir, 0o700);
  await broker.start();
});
after(async () => {
  await broker.stop();
});

test("native SendMessage frames from a bound Claude driver route as driver, not not-from-driver", async () => {
  await op("register", { threadId: "w4dfw", cwd: "/w/f", state: "busy" });
  const d = await fakeClaude("w4dfdrv", livePid(), "idle");
  try {
    await op("set_driver", { threadId: "w4dfw", addr: encodeAddress(d.socketPath), name: "w4dfdrv" });
    assert.equal(broker.store.getThread("w4dfw")!.driver_sid, `session:${d.sessionId}`);
    broker.onFrame("w4dfw", { type: "user", message: { role: "user", content: "plain native text from the driver" }, priority: "next", from: encodeAddress(d.socketPath), msg_id: "w4d-plain" });
    broker.onFrame("w4dfw", { type: "user", message: { role: "user", content: buildEnvelope({ from: encodeAddress(d.socketPath), fromName: "w4dfdrv", fromSession: d.sessionId, body: "enveloped with session" }) }, priority: "next", msg_id: "w4d-env-sess" });
    broker.onFrame("w4dfw", { type: "user", message: { role: "user", content: buildEnvelope({ from: encodeAddress(d.socketPath), fromName: "w4dfdrv", body: "enveloped without session" }) }, priority: "next", msg_id: "w4d-env-nosess" });
    await until(() => (frameCount("w4dfw") >= 3 ? true : undefined));
    assert.deepEqual(
      frameRows("w4dfw").filter((r) => r.includes("not-from-driver")),
      [],
      `a bound Claude driver's native frames must not route not-from-driver: ${frameRows("w4dfw").join(" | ")}`,
    );
    const take = broker.take("w4dfw").text;
    assert.ok(/From your driver/.test(take), "driver frames group under the driver heading");
    assert.ok(!/From other sessions/.test(take), "no driver frame groups as a stranger");
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

test("the classifier is consulted for a bound Claude driver's messages, exactly as for an undriven worker", async () => {
  useClassifier = true;
  try {
    await op("register", { threadId: "w4dcw", cwd: "/w/c", state: "busy" });
    await op("register", { threadId: "w4dcu", cwd: "/w/cu", state: "busy" });
    const live = await fakeClaude("w4dcdrv", livePid(), "idle");
    try {
      await op("set_driver", { threadId: "w4dcw", addr: encodeAddress(live.socketPath), name: "w4dcdrv" });
      const from: Party = { kind: "claude", name: "w4dcdrv", addr: encodeAddress(live.socketPath), session: live.sessionId, mode: null };
      const driven: Target = { kind: "codex", addr: encodeAddress(threadSocketPath("w4dcw")), name: "w4dcw", threadId: "w4dcw" };
      const undriven: Target = { kind: "codex", addr: encodeAddress(threadSocketPath("w4dcu")), name: "w4dcu", threadId: "w4dcu" };
      calls = 0;
      await op("route_send", { msgId: randomUUID(), from, to: driven, body: "ok thanks", urgency: "normal" });
      assert.equal(calls, 1, "the classifier is consulted for a bound Claude driver exactly as for an undriven worker");
      calls = 0;
      await op("route_send", { msgId: randomUUID(), from, to: undriven, body: "ok thanks", urgency: "normal" });
      assert.equal(calls, 1, "control: the classifier is consulted for the same sender to an undriven worker");
    } finally {
      await closeServer(live.server).catch(() => {});
    }
  } finally {
    useClassifier = false;
  }
});

test("a worker report to a Claude driver instructed only by native frame routes pause/report-to-driver", async () => {
  await op("register", { threadId: "w4d2w", cwd: "/w/f2", state: "busy" });
  const d = await fakeClaude("w4d2drv", livePid(), "busy");
  try {
    await op("set_driver", { threadId: "w4d2w", addr: encodeAddress(d.socketPath), name: "w4d2drv" });
    broker.onFrame("w4d2w", { type: "user", message: { role: "user", content: buildEnvelope({ from: encodeAddress(d.socketPath), fromName: "w4d2drv", fromSession: d.sessionId, body: "do the build" }) }, priority: "next", msg_id: "w4d2-instr" });
    await until(() => (frameCount("w4d2w") >= 1 ? true : undefined));
    assert.equal(outboxFrom(encodeAddress(d.socketPath)), 0, "the instruction arrived only as a native frame: the test is not vacuous");
    broker.store.db.prepare("UPDATE messages SET received_at = received_at - ? WHERE to_thread = ?").run(40 * 60_000, "w4d2w");
    const w: Party = { kind: "codex", name: "w4d2w", addr: encodeAddress(threadSocketPath("w4d2w")), session: "w4d2w", mode: null };
    const to: Target = { kind: "claude", addr: encodeAddress(d.socketPath), name: "w4d2drv", sessionId: d.sessionId };
    const r = await op<{ decision: { route: string; rule?: string } }>("route_send", { msgId: randomUUID(), from: w, to, body: "just fyi, cleaned up the logs, all green", urgency: "fyi" });
    assert.equal(r.decision.route, "pause", `late chatter report to an instructing Claude driver pauses, got ${r.decision.route}/${r.decision.rule}`);
    assert.equal(r.decision.rule, "report-to-driver");
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});
