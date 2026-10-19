import "./support.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeClaude, livePid, root, until, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { buildEnvelope, encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import type { Party, Target } from "../src/routing.ts";

const hub = new Broker({ classifier: () => undefined, wakeEnabled: false });
const sockDir = process.env.AGENTSOCKS_CCSOCKS_DIR!;
const MIN = 60_000;
const FLOORED_COUNT = "SELECT COUNT(*) AS n FROM outbox WHERE json_extract(decision,'$.floored') = 1";

type Verdict = { decision: { route: string; rule?: string; by: string; floored?: boolean } };
type StoredRow = { route: string; decision: string };
type StoredOutbox = { msg_id: string; status: string; decision: string };

const call = async <T>(name: string, req: Record<string, unknown> = {}): Promise<T> => {
  const res = (await hub.dispatch({ op: name, ...req })) as unknown as { result: T };
  return res.result;
};
const wire = (id: string, agent: string, state = "busy"): Promise<unknown> =>
  call("register", { threadId: id, agent, cwd: `/w/${id}`, state });
const hire = (worker: string, addr: string, name: string): Promise<unknown> =>
  call("set_driver", { threadId: worker, addr, name });
const threadAddr = (id: string): string => encodeAddress(threadSocketPath(id));
const crew = (id: string): Party => ({ kind: "codex", name: id, addr: threadAddr(id), session: id, mode: null });
const leg = (id: string): Target => ({ kind: "codex", addr: threadAddr(id), name: id, threadId: id });
const drive = (d: FakeClaude, session = d.sessionId): Party =>
  ({ kind: "claude", name: d.name, addr: encodeAddress(d.socketPath), session, mode: null });
const passAs = async (id: string, from: Party, to: Target, body: string, urgency: "normal" | "fyi" | "urgent" = "normal") =>
  hub.routeSend({ msgId: id, from, to, body, urgency });
const pass = (from: Party, to: Target, body: string, urgency: "normal" | "fyi" | "urgent" = "normal") =>
  passAs(randomUUID(), from, to, body, urgency);
const sig = (r: Verdict): string => `${r.decision.route}/${r.decision.rule ?? r.decision.by}`;
const marked = (r: Verdict): boolean => r.decision.floored === true;
const posted = (id: string): string[] => {
  const found = hub.store.db.prepare("SELECT route, decision FROM messages WHERE to_thread = ? ORDER BY received_at, rowid").all(id) as StoredRow[];
  return found.map((r) => {
    const decision = JSON.parse(r.decision) as { rule?: string };
    return `${r.route}/${decision.rule ?? "-"}`;
  });
};
const frame = (from: string, body: string, id: string, name?: string, session?: string) => {
  const content = name === undefined ? body : buildEnvelope({ from, fromName: name, ...(session && { fromSession: session }), body });
  return { type: "user", message: { role: "user", content }, priority: "next", ...(name === undefined && { from }), msg_id: id };
};
const backdate = (ms: number): void => {
  hub.store.db.prepare("UPDATE outbox SET created_at = created_at - ?").run(ms);
  hub.store.db.prepare("UPDATE messages SET received_at = received_at - ?").run(ms);
  hub.store.db.prepare("UPDATE tasks SET created_at = created_at - ?").run(ms);
  hub.store.db.prepare("UPDATE threads SET driver_instructed_at = CASE WHEN driver_instructed_at IS NULL THEN NULL ELSE driver_instructed_at - ? END").run(ms);
};
const pair = async (tag: string): Promise<void> => {
  await wire(`${tag}w`, "omp");
  await wire(`${tag}d`, "codex");
  await hire(`${tag}w`, threadAddr(`${tag}d`), `${tag}d`);
  await pass(crew(`${tag}d`), leg(`${tag}w`), "do the job");
  backdate(40 * MIN);
};

before(async () => {
  mkdirSync(sockDir, { recursive: true });
  chmodSync(sockDir, 0o700);
  await hub.start();
});
after(async () => {
  await hub.stop();
});

test("reseat: first native frame after /clear routes as the driver", async () => {
  await wire("g1w", "omp");
  const d = await fakeClaude("g1d", livePid(), "busy");
  try {
    const from = encodeAddress(d.socketPath);
    await hire("g1w", from, d.name);
    await pass(drive(d), leg("g1w"), "build it");
    const n = posted("g1w").length;
    writeFileSync(join(root, "claude-sessions", `${d.pid}.json`), JSON.stringify({ pid: d.pid, sessionId: "g1d-after-clear", cwd: `/work/${d.name}`, name: d.name, messagingSocketPath: d.socketPath, kind: "interactive", status: "busy" }));
    hub.onFrame("g1w", frame(from, "first native instruction after clear", "g1f1", d.name, "g1d-after-clear"));
    await until(() => (posted("g1w").length > n ? true : undefined));
    const last = posted("g1w").at(-1)!;
    assert.ok(last.startsWith("now/"), `first native frame after reseat missed the driver: ${last}`);
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

test("stranger native frame never stamps the worker", async () => {
  await wire("g2w", "omp");
  const d = await fakeClaude("g2d", livePid(), "busy");
  const x = await fakeClaude("g2x", livePid(), "busy");
  try {
    await hire("g2w", encodeAddress(d.socketPath), d.name);
    const n = posted("g2w").length;
    hub.onFrame("g2w", frame(encodeAddress(x.socketPath), "stranger native frame", "g2f1"));
    await until(() => (posted("g2w").length > n ? true : undefined));
    const stamp = hub.store.getThread("g2w")?.driver_instructed_at ?? null;
    assert.equal(stamp, null, "stranger frame left an instruction stamp");
    const last = posted("g2w").at(-1)!;
    assert.ok(!last.startsWith("now/"), `stranger frame routed as the driver: ${last}`);
  } finally {
    await closeServer(d.server).catch(() => {});
    await closeServer(x.server).catch(() => {});
  }
});

test("pending duplicates from a floored worker are counted, cap holds", async () => {
  await pair("g3");
  const beforeRow = hub.store.db.prepare(FLOORED_COUNT).get() as { n: number };
  const rs: string[] = [];
  for (let i = 0; i < 20; i++) rs.push(sig(await pass(crew("g3w"), leg("g3d"), "same progress text", "fyi")));
  const floored = rs.filter((s) => s === "pause/report-to-driver").length;
  assert.equal(floored, 12, `cap missed: ${floored} floored of 20 pending duplicates`);
  const afterRow = hub.store.db.prepare(FLOORED_COUNT).get() as { n: number };
  assert.equal(afterRow.n - beforeRow.n, 12, "pending duplicates skipped the floor marker");
});

test("delivered duplicate merges; edited re-sends still floor with the marker", async () => {
  await pair("g4");
  const first = await pass(crew("g4w"), leg("g4d"), "job is done", "fyi");
  hub.take("g4d");
  const dupFyi = await pass(crew("g4w"), leg("g4d"), "job is done", "fyi");
  const dupUrgent = await pass(crew("g4w"), leg("g4d"), "job is done", "urgent");
  const edited = await pass(crew("g4w"), leg("g4d"), "job is done!", "fyi");
  const editedUrgent = await pass(crew("g4w"), leg("g4d"), "job is done, tests green", "urgent");
  assert.equal(sig(first), "pause/report-to-driver");
  assert.equal(dupFyi.decision.route, "merge");
  assert.equal(dupUrgent.decision.route, "merge");
  assert.equal(sig(edited), "pause/report-to-driver");
  assert.ok(marked(edited), "edited re-send lost the floor marker");
  assert.equal(sig(editedUrgent), "now/urgent");
  assert.ok(marked(editedUrgent), "edited urgent re-send lost the floor marker");
});

test("floor cap spans report, idle, awaited and urgent legs in one pair", async () => {
  await pair("g5");
  const log: string[] = [];
  const batch = async (label: string, n: number, urg: "normal" | "fyi" | "urgent"): Promise<void> => {
    for (let i = 0; i < n; i++) log.push(`${label}:${sig(await pass(crew("g5w"), leg("g5d"), `${label} ${i} ${randomUUID()}`, urg))}`);
  };
  const beforeRow = hub.store.db.prepare(FLOORED_COUNT).get() as { n: number };
  await batch("report", 3, "fyi");
  backdate(11 * MIN);
  await wire("g5d", "codex", "idle");
  await batch("idle", 3, "normal");
  backdate(11 * MIN);
  await wire("g5d", "codex", "busy");
  for (let i = 0; i < 3; i++) {
    await pass(crew("g5d"), leg("g5w"), `driver asks ${i} ${randomUUID()}`);
    log.push(`awaited:${sig(await pass(crew("g5w"), leg("g5d"), `awaited reply ${i} ${randomUUID()}`, "normal"))}`);
  }
  backdate(11 * MIN);
  await batch("urgent", 3, "urgent");
  const afterRow = hub.store.db.prepare(FLOORED_COUNT).get() as { n: number };
  assert.equal(afterRow.n - beforeRow.n, 12, `expected 12 floored rows: ${log.join(" ")}`);
  const t1 = await pass(crew("g5w"), leg("g5d"), `thirteenth fyi ${randomUUID()}`, "fyi");
  const t2 = await pass(crew("g5w"), leg("g5d"), `thirteenth urgent ${randomUUID()}`, "urgent");
  const t3 = await pass(crew("g5w"), leg("g5d"), `thirteenth normal ${randomUUID()}`, "normal");
  for (const [i, r] of [t1, t2, t3].entries()) {
    assert.ok(!sig(r).includes("report-to-driver"), `13th message ${i} still floored: ${sig(r)}`);
    assert.ok(!marked(r), `13th message ${i} kept the floor marker`);
  }
});

test("forged-session frame from the driver address never routes as the driver", async () => {
  await wire("g6w", "omp");
  const d = await fakeClaude("g6d", livePid(), "busy");
  try {
    const from = encodeAddress(d.socketPath);
    await hire("g6w", from, d.name);
    await pass(drive(d), leg("g6w"), "build it");
    backdate(40 * MIN);
    const n = posted("g6w").length;
    hub.onFrame("g6w", frame(from, "frame claims driver addr, wrong session", "g6f1", d.name, "forger-session"));
    await until(() => (posted("g6w").length > n ? true : undefined));
    const last = posted("g6w").at(-1)!;
    assert.ok(!last.startsWith("now/"), `forged-session frame routed as the driver: ${last}`);
  } finally {
    await closeServer(d.server).catch(() => {});
  }
});

test("dead driver: another socket cannot steal the binding with the driver address", async () => {
  await wire("g7w", "omp");
  const pid = livePid();
  const d = await fakeClaude("g7d", pid, "busy");
  const x = await fakeClaude("g7x", livePid(), "busy");
  try {
    const from = encodeAddress(d.socketPath);
    await hire("g7w", from, d.name);
    await pass(drive(d), leg("g7w"), "build it");
    const sidBefore = hub.store.getThread("g7w")?.driver_sid ?? null;
    rmSync(join(root, "claude-sessions", `${pid}.json`));
    await pass({ kind: "claude", name: d.name, addr: from, session: x.sessionId, mode: null }, leg("g7w"), "attacker on another socket claims the driver address");
    assert.equal(hub.store.getThread("g7w")?.driver_sid ?? null, sidBefore, "binding moved to a session on another socket");
  } finally {
    await closeServer(d.server).catch(() => {});
    await closeServer(x.server).catch(() => {});
  }
});

test("refused duplicates never consume the floor cap", async () => {
  await pair("g8");
  const seeds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = randomUUID();
    seeds.push(id);
    const n = posted("g8d").length;
    hub.onFrame("g8d", frame(threadAddr("g8w"), `seed ${i}`, id));
    await until(() => (posted("g8d").length > n ? true : undefined));
    const retry = await passAs(id, crew("g8w"), leg("g8d"), `same id, fresh report ${i} ${randomUUID()}`, "fyi");
    assert.equal(sig(retry), "pause/report-to-driver", `refused seed ${i} misrouted: ${sig(retry)}`);
  }
  const found = hub.store.db.prepare(`SELECT msg_id, status, decision FROM outbox WHERE msg_id IN (${seeds.map(() => "?").join(",")})`).all(...seeds) as StoredOutbox[];
  const rows = found.filter((r) => seeds.includes(r.msg_id));
  assert.equal(rows.length, 12, `expected 12 refused rows, got ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.status, "refused", `seed ${r.msg_id} not refused: ${r.status}`);
    const decision = JSON.parse(r.decision) as { floored?: boolean };
    assert.ok(decision.floored === true, `seed ${r.msg_id} lost the floor marker`);
  }
  const extra = await pass(crew("g8w"), leg("g8d"), `after twelve refused ${randomUUID()}`, "fyi");
  assert.equal(sig(extra), "pause/report-to-driver", `cap consumed by refused rows: ${sig(extra)}`);
  assert.ok(marked(extra), "post-refusal report lost the floor marker");
});

test("failed deliveries never consume the floor cap", async () => {
  await wire("g9w", "omp");
  const d = await fakeClaude("g9d", livePid(), "busy");
  try {
  const from = encodeAddress(d.socketPath);
  const toDriver: Target = { kind: "claude", addr: from, name: d.name };
  await hire("g9w", from, d.name);
  await pass(drive(d), leg("g9w"), "build it");
  backdate(40 * MIN);
  chmodSync(d.socketPath, 0o000);
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = randomUUID();
    ids.push(id);
    const r = await passAs(id, crew("g9w"), toDriver, `doomed report ${i} ${randomUUID()}`, "fyi");
    assert.equal(sig(r), "pause/report-to-driver", `doomed report ${i} misrouted: ${sig(r)}`);
  }
  const placeholders = ids.map(() => "?").join(",");
  const found = hub.store.db.prepare(`SELECT msg_id, status, decision FROM outbox WHERE msg_id IN (${placeholders})`).all(...ids) as StoredOutbox[];
  const rows = found.filter((r) => ids.includes(r.msg_id));
  assert.equal(rows.length, 12, `expected 12 failed rows, got ${rows.length}`);
  for (const r of rows) assert.equal(r.status, "failed", `doomed ${r.msg_id} not failed: ${r.status}`);
  const extra = await pass(crew("g9w"), toDriver, `after twelve failed ${randomUUID()}`, "fyi");
  assert.equal(sig(extra), "pause/report-to-driver", `cap consumed by failed rows: ${sig(extra)}`);
  } finally {
    try {
      chmodSync(d.socketPath, 0o600);
    } catch {}
    await closeServer(d.server).catch(() => {});
  }
  });
