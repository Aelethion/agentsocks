import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import "./support.ts";
import { tempDir } from "./tmp.ts";
import { Broker } from "../src/broker.ts";
import { encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import type { Party, RouteSendResult, Target } from "../src/routing.ts";
import { extensionSource } from "../src/agents/omp/extension.ts";
import { FakeOmp } from "./omphost.ts";

const broker = new Broker({ classifier: () => undefined, wakeEnabled: false });
const addrOf = (id: string): string => encodeAddress(threadSocketPath(id));
const party = (id: string, name: string): Party => ({ kind: "codex", name, addr: addrOf(id), session: id, mode: null });
const target = (id: string, name: string): Target => ({ kind: "codex", addr: addrOf(id), name, threadId: id });
const op = async <T>(name: string, req: Record<string, unknown> = {}): Promise<T> => {
  const reply = await broker.dispatch({ op: name, ...req });
  if (reply && typeof reply === "object" && "result" in reply) return reply.result as T;
  throw new Error(`op ${name} returned no result`);
};
const send = (from: Party, to: Target, body: string, urgency: "normal" | "fyi" | "urgent" = "normal"): Promise<RouteSendResult> =>
  op<RouteSendResult>("route_send", { msgId: randomUUID(), from, to, body, urgency });
const threadName = (id: string): string => broker.store.getThread(id)!.name;
const evidenceFrom = (fromId: string, toId: string): number => {
  const row: unknown = broker.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE from_addr = ? AND to_addr = ? AND status NOT IN ('merged','refused','failed')").get(addrOf(fromId), addrOf(toId));
  if (row && typeof row === "object" && "n" in row && typeof row.n === "number") return row.n;
  throw new Error("count query returned no row");
};

before(async () => {
  await broker.start();
});
after(async () => {
  await broker.stop();
});

async function manufactureSetup(tag: string): Promise<{ w: string; s: string }> {
  const w = `w4cg${tag}w`;
  const s = `w4cg${tag}s`;
  const real = `w4cg${tag}d`;
  for (const id of [w, s, real]) await op("register", { threadId: id, cwd: "/w/w4cg" });
  await op("set_driver", { threadId: w, addr: addrOf(real), name: threadName(real) });
  await op("set_driver", { threadId: s, addr: addrOf(w), name: threadName(w) });
  const pre = await send(party(s, "s"), target(w, "w"), `pre ${tag}`);
  assert.equal(pre.decision.rule, "not-from-driver");
  return { w, s };
}

async function followups(s: string, w: string, tag: string): Promise<(string | undefined)[]> {
  const out: (string | undefined)[] = [];
  for (let i = 0; i < 12; i++) out.push((await send(party(s, "s"), target(w, "w"), `post ${tag} ${i}`)).decision.rule);
  return out;
}

test("a worker reply to the stranger buys a floor capped at 12 an hour", async () => {
  const { w, s } = await manufactureSetup("reply");
  await send(party(w, "w"), target(s, "s"), "ok, here is the answer you asked for");
  assert.ok(evidenceFrom(w, s) > 0, "the reply row exists: the test is not vacuous");
  broker.store.db.prepare("UPDATE outbox SET created_at = created_at - ? WHERE from_addr = ?").run(40 * 60_000, addrOf(w));
  assert.ok((await followups(s, w, "reply")).every((x) => x === "report-to-driver"));
  const over = await send(party(s, "s"), target(w, "w"), "post reply 12");
  assert.equal(over.decision.route, "digest");
  assert.ok(over.decision.rule !== "report-to-driver");
});

test("a worker channel post buys no floor", async () => {
  const { w, s } = await manufactureSetup("chan");
  await op("channel_subscribe", { party: party(s, "s"), channel: "w4croom" });
  await op("channel_subscribe", { party: party(w, "w"), channel: "w4croom" });
  await op("channel_send", { from: party(w, "w"), channel: "w4croom", body: "status for the room", urgency: "normal" });
  assert.ok(evidenceFrom(w, s) > 0, "the channel row exists: the test is not vacuous");
  assert.ok((await followups(s, w, "chan")).every((x) => x === "not-from-driver"));
});

test("a worker broadcast buys no floor", async () => {
  const { w, s } = await manufactureSetup("bcast");
  await op("channel_send", { from: party(w, "w"), channel: "all", body: "worker status broadcast", urgency: "normal" });
  assert.ok(evidenceFrom(w, s) > 0, "the broadcast row exists: the test is not vacuous");
  assert.ok((await followups(s, w, "bcast")).every((x) => x === "not-from-driver"));
});

test("a real direct instruction keeps the floor", async () => {
  await op("register", { threadId: "w4cgboss", cwd: "/w/w4cg", state: "busy" });
  await op("register", { threadId: "w4cgrep", cwd: "/w/w4cg", state: "busy" });
  await op("set_driver", { threadId: "w4cgrep", addr: addrOf("w4cgboss"), name: threadName("w4cgboss") });
  await send(party("w4cgboss", "boss"), target("w4cgrep", "rep"), "do the build");
  const rs = [];
  for (let i = 0; i < 12; i++) rs.push(await send(party("w4cgrep", "rep"), target("w4cgboss", "boss"), `ok ${i}`, "fyi"));
  assert.ok(rs.every((r) => r.decision.route === "pause" || r.decision.route === "now"), rs.map((r) => `${r.decision.route}/${r.decision.rule}`).join(" "));
  assert.ok(rs.every((r) => r.decision.rule !== "not-from-driver"), rs.map((r) => `${r.decision.route}/${r.decision.rule}`).join(" "));
});

test("a task the receiver created for the sender keeps the floor", async () => {
  await op("register", { threadId: "w4cgtboss", cwd: "/w/w4cg", state: "busy" });
  await op("register", { threadId: "w4cgtrep", cwd: "/w/w4cg", state: "busy" });
  await op("set_driver", { threadId: "w4cgtrep", addr: addrOf("w4cgtboss"), name: threadName("w4cgtboss") });
  await op("task_create", { from: party("w4cgtboss", "boss"), to: target("w4cgtrep", "rep"), title: "build it", body: "build the thing" });
  const rs = [];
  for (let i = 0; i < 4; i++) rs.push(await send(party("w4cgtrep", "rep"), target("w4cgtboss", "boss"), `status ${i}`, "fyi"));
  assert.ok(rs.every((r) => r.decision.rule !== "not-from-driver"), rs.map((r) => `${r.decision.route}/${r.decision.rule}`).join(" "));
});

test("a ref-like OMP session name falls back to the folder default", async () => {
  await op("hook", { threadId: "omp_w4cg6a", agent: "omp", event: "SessionStart", cwd: "/work/w4cgreet", name: "deadbeef12" });
  assert.equal(threadName("omp_w4cg6a"), "omp-w4cgreet");
  await op("hook", { threadId: "omp_w4cg6b", agent: "omp", event: "SessionStart", cwd: "/work/w4cgreet", name: "DEADBEEF12" });
  assert.equal(threadName("omp_w4cg6b"), "omp-w4cgreet-2");
});

test("a ref-like name on a later SessionStart keeps the existing name", async () => {
  await op("hook", { threadId: "omp_w4cg6c", agent: "omp", event: "SessionStart", cwd: "/work/w4cg6c", name: "steady" });
  assert.equal(threadName("omp_w4cg6c"), "steady");
  await op("hook", { threadId: "omp_w4cg6c", agent: "omp", event: "SessionStart", cwd: "/work/w4cg6c", name: "deadbeef12" });
  assert.equal(threadName("omp_w4cg6c"), "steady");
});

test("a later SessionStart keeps the derived name once A renames away", async () => {
  await op("hook", { threadId: "omp_w4cg7a", agent: "omp", event: "SessionStart", cwd: "/work/w4cg7a", name: "w4cgwork" });
  await op("hook", { threadId: "omp_w4cg7b", agent: "omp", event: "SessionStart", cwd: "/work/w4cg7b", name: "w4cgwork" });
  assert.equal(threadName("omp_w4cg7a"), "w4cgwork");
  assert.equal(threadName("omp_w4cg7b"), "w4cgwork-2");
  await op("set_name", { threadId: "omp_w4cg7a", name: "w4cgalpha" });
  await op("hook", { threadId: "omp_w4cg7b", agent: "omp", event: "SessionStart", cwd: "/work/w4cg7b", name: "w4cgwork" });
  assert.equal(threadName("omp_w4cg7b"), "w4cgwork-2");
});

test("a direct register with a name uniquifies on first register", async () => {
  const a = await op<{ name: string }>("register", { threadId: "w4cg10a", cwd: "/work/w4cg10a", name: "Pi Session" });
  const b = await op<{ name: string }>("register", { threadId: "w4cg10b", cwd: "/work/w4cg10b", name: "Pi Session" });
  assert.equal(a.name, "Pi Session");
  assert.equal(b.name, "Pi Session-2");
});

const recordCli = (tag: string): { cli: string; calls: string } => {
  const dir = tempDir(`agentsocks-w4cg-${tag}-`);
  const calls = join(dir, "calls.jsonl");
  const cli = join(dir, "cli.mjs");
  writeFileSync(cli, `for await (const c of process.stdin) (await import("node:fs")).appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), stdin: Buffer.concat([c]).toString() }) + "\\n");\n`);
  return { cli, calls };
};
const HookCall = z.object({ argv: z.array(z.string()), stdin: z.string() });
const HookPayload = z.object({}).passthrough();
const startPayload = (calls: string): z.infer<typeof HookPayload> => {
  for (const line of readFileSync(calls, "utf8").trim().split("\n")) {
    const call = HookCall.parse(JSON.parse(line));
    if (call.argv[2] !== "SessionStart") continue;
    return HookPayload.parse(JSON.parse(call.stdin));
  }
  throw new Error(`no SessionStart call in ${calls}`);
};

test("the OMP extension never forwards a ref-like session name", async () => {
  const { cli, calls } = recordCli("refname");
  const dir = tempDir("agentsocks-w4cg-ext-");
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  const file = join(dir, "agentsocks.ts");
  writeFileSync(file, extensionSource({ node: process.execPath, cli }));
  const host = await FakeOmp.load({ file, sessionId: "w4cg-ref-1", sessionName: "deadbeef12" });
  try {
    await host.emit("session_start");
    assert.ok(!("name" in startPayload(calls)), "no name key for a ref-like session name");
  } finally {
    await host.shutdown();
  }
});
