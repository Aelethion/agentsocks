import "./support.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fakeClaude, livePid, root, until, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { buildEnvelope, encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import type { Party, Target } from "../src/routing.ts";

const broker = new Broker({ classifier: () => undefined, wakeEnabled: false });
const ccdir = process.env.AGENTSOCKS_CCSOCKS_DIR!;
const op = async <T>(name: string, req: Record<string, unknown> = {}): Promise<T> => {
  const out: unknown = (await broker.dispatch({ op: name, ...req })).result;
  return out as T;
};
const MIN = 60_000;
const addrOf = (id: string): string => encodeAddress(threadSocketPath(id));
const ompParty = (id: string): Party => ({ kind: "codex", name: id, addr: addrOf(id), session: id, mode: null });
const target = (id: string): Target => ({ kind: "codex", addr: addrOf(id), name: id, threadId: id });
const claudeParty = (d: FakeClaude): Party => ({ kind: "claude", name: d.name, addr: encodeAddress(d.socketPath), session: d.sessionId, mode: null });
const claudeTarget = (d: FakeClaude): Target => ({ kind: "claude", addr: encodeAddress(d.socketPath), name: d.name, sessionId: d.sessionId });
type Shape = "plain" | "envsess" | "envnosess";
const frame = (d: FakeClaude, shape: Shape, body: string, msgId: string) => {
  const from = encodeAddress(d.socketPath);
  const content = shape === "plain" ? body : buildEnvelope({ from, fromName: d.name, ...(shape === "envsess" && { fromSession: d.sessionId }), body });
  return { type: "user", message: { role: "user", content }, priority: "next", ...(shape === "plain" && { from }), msg_id: msgId };
};
const report = async (w: string, d: FakeClaude, body: string, urgency: "normal" | "fyi" | "urgent" = "fyi") => {
  const r = await broker.routeSend({ msgId: randomUUID(), from: ompParty(w), to: claudeTarget(d), body, urgency });
  return `${r.decision.route}/${r.decision.rule ?? r.decision.by}`;
};
type MsgRow = { route: string; decision: string };
const isMsgRow = (v: unknown): v is MsgRow => !!v && typeof v === "object" && "route" in v && "decision" in v && typeof v.route === "string" && typeof v.decision === "string";
const msgRule = (decision: string): string => {
  const parsed: unknown = JSON.parse(decision);
  if (!!parsed && typeof parsed === "object" && "rule" in parsed && typeof parsed.rule === "string") return parsed.rule;
  return "-";
};
const rows = (id: string): string[] => {
  const got: unknown = broker.store.db.prepare("SELECT route, decision FROM messages WHERE to_thread = ? ORDER BY received_at, rowid").all(id);
  assert.ok(Array.isArray(got) && got.every(isMsgRow), "unexpected message rows");
  return got.map((r) => `${r.route}/${msgRule(r.decision)}`);
};
const cellCount = (got: unknown): number => {
  assert.ok(!!got && typeof got === "object" && "n" in got && typeof got.n === "number", "unexpected count row");
  return got.n;
};
const storedSession = (id: string): string | null => {
  const got: unknown = broker.store.db.prepare("SELECT from_session AS s FROM messages WHERE to_thread = ? AND kind = 'message' ORDER BY received_at, rowid").get(id);
  if (!got || typeof got !== "object" || !("s" in got)) return null;
  const s: unknown = got.s;
  return typeof s === "string" ? s : null;
};
const resume = async (a: FakeClaude): Promise<FakeClaude> => {
  await closeServer(a.server);
  unlinkSync(join(root, "claude-sessions", `${a.pid}.json`));
  const pidB = livePid();
  const b = await fakeClaude(a.name, pidB, "busy", `${pidB}.sock`);
  assert.equal(b.sessionId, a.sessionId);
  return b;
};
before(async () => { mkdirSync(ccdir, { recursive: true }); chmodSync(ccdir, 0o700); await broker.start(); });
after(async () => { await broker.stop(); });

test("plain frame stores the resolved driver session", async () => {
  await op("register", { threadId: "w4esw", agent: "omp", cwd: "/w/es", state: "busy" });
  const d = await fakeClaude("w4esd", livePid(), "busy");
  try {
    await op("set_driver", { threadId: "w4esw", addr: encodeAddress(d.socketPath), name: d.name });
    broker.onFrame("w4esw", frame(d, "plain", "driver instruction please continue", "w4e-store-1"));
    await until(() => (rows("w4esw").length >= 1 ? true : undefined));
    assert.equal(storedSession("w4esw"), d.sessionId);
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

for (const shape of ["plain", "envsess", "envnosess"] as Shape[]) {
  test(`frame still reads From your driver after the driver resumes on a new socket`, async () => {
    const w = `w4eg${shape}w`;
    await op("register", { threadId: w, agent: "omp", cwd: `/w/${w}`, state: "busy" });
    const a = await fakeClaude(`w4eg${shape}d`, livePid(), "busy");
    let b: FakeClaude | undefined;
    try {
      await op("set_driver", { threadId: w, addr: encodeAddress(a.socketPath), name: a.name });
      broker.onFrame(w, frame(a, shape, "build the thing, first instruction", `w4eg-${shape}-1`));
      await until(() => (rows(w).length >= 1 ? true : undefined));
      b = await resume(a);
      const take = broker.take(w).text;
      assert.ok(/From your driver/.test(take) && !/other sessions/.test(take), take.slice(0, 300));
    } finally {
      if (b) await closeServer(b.server).catch(() => {});
      await closeServer(a.server).catch(() => {});
    }
  });
}

test("a Claude driver's native frames route as the driver and read under From your driver, and reports 40 minutes later pause", async () => {
  const w = "w4eppw";
  await op("register", { threadId: w, agent: "omp", cwd: "/w/pp", state: "busy" });
  const d = await fakeClaude("w4eppd", livePid(), "busy");
  try {
    await op("set_driver", { threadId: w, addr: encodeAddress(d.socketPath), name: d.name });
    assert.equal(broker.store.getThread(w)!.driver_sid, `session:${d.sessionId}`);
    broker.onFrame(w, frame(d, "plain", "driver instruction number 0 please continue", "w4ep-0"));
    await until(() => (rows(w).length >= 1 ? true : undefined));
    assert.ok(!rows(w).some((r) => r.includes("not-from-driver")), rows(w).join(" "));
    const take = broker.take(w).text;
    assert.ok(/From your driver/.test(take) && !/other sessions/.test(take), take.slice(0, 300));
    broker.store.db.prepare("UPDATE messages SET received_at = received_at - ? WHERE to_thread = ?").run(40 * MIN, w);
    const out = [await report(w, d, "ok thanks, tidied the logs", "fyi"), await report(w, d, "all green here", "normal"), await report(w, d, "just fyi done", "fyi")];
    assert.ok(out.every((r) => r === "pause/report-to-driver"), out.join(" "));
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

test("after the driver resumes, a report still pauses and later frames and urgent messages are still the driver's", async () => {
  const w = "w4eprw";
  await op("register", { threadId: w, agent: "omp", cwd: "/w/pr", state: "busy" });
  const a = await fakeClaude("w4eprd", livePid(), "busy");
  let b: FakeClaude | undefined;
  try {
    await op("set_driver", { threadId: w, addr: encodeAddress(a.socketPath), name: a.name });
    broker.onFrame(w, frame(a, "plain", "build the thing", "w4epr-1"));
    await until(() => (rows(w).length >= 1 ? true : undefined));
    broker.store.db.prepare("UPDATE messages SET received_at = received_at - ? WHERE to_thread = ?").run(40 * MIN, w);
    b = await resume(a);
    const r1 = await report(w, b, "ok thanks, first report after your resume", "fyi");
    const notice = ((await broker.hook({ threadId: w, event: "UserPromptSubmit" })).context ?? "");
    assert.equal(r1, "pause/report-to-driver");
    assert.ok(!/offline/.test(notice), notice);
    broker.onFrame(w, frame(b, "plain", "after resume instruction", "w4epr-2"));
    await until(() => (rows(w).length >= 2 ? true : undefined));
    assert.ok(!rows(w).some((r) => r.includes("not-from-driver")), rows(w).join(" "));
    const rt = await broker.routeSend({ msgId: randomUUID(), from: claudeParty(b), to: target(w), body: "URGENT please stop now", urgency: "urgent" });
    assert.notEqual(rt.decision.rule, "not-from-driver");
  } finally {
    if (b) await closeServer(b.server).catch(() => {});
    await closeServer(a.server).catch(() => {});
  }
});

test("receiver-created task alone keeps the floor when the assignment outbox aged out", async () => {
  const w = "w4etw", s = "w4ets", w2 = "w4etw2", s2 = "w4ets2";
  await op("register", { threadId: w, cwd: "/w/et", state: "busy" });
  await op("register", { threadId: s, cwd: "/w/et" });
  await op("register", { threadId: w2, cwd: "/w/et", state: "busy" });
  await op("register", { threadId: s2, cwd: "/w/et" });
  await op("set_driver", { threadId: s, addr: addrOf(w), name: w });
  await op("set_driver", { threadId: s2, addr: addrOf(w2), name: w2 });
  await op("task_create", { from: ompParty(w), to: target(s), title: "w asks s", body: "details" });
  broker.store.db.prepare("UPDATE outbox SET created_at = created_at - ? WHERE from_name = ?").run(25 * 60 * MIN, w);
  const freshOutbox = cellCount(broker.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE from_name = ? AND created_at >= ?").get(w, Date.now() - 24 * 60 * MIN));
  assert.equal(freshOutbox, 0);
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await broker.routeSend({ msgId: randomUUID(), from: ompParty(s), to: target(w), body: `followup ${i} unique`, urgency: "normal" });
    out.push(`${r.decision.route}/${r.decision.rule ?? r.decision.by}`);
  }
  assert.ok(out.some((r) => r.includes("report-to-driver")), out.join(" "));
  const ctrl: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await broker.routeSend({ msgId: randomUUID(), from: ompParty(s2), to: target(w2), body: `control ${i} unique`, urgency: "normal" });
    ctrl.push(`${r.decision.route}/${r.decision.rule ?? r.decision.by}`);
  }
  assert.ok(!ctrl.some((r) => r.includes("report-to-driver")), ctrl.join(" "));
});
