import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { z } from "zod";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./support.ts";
import { tempDir } from "./tmp.ts";
import { Broker } from "../src/broker.ts";
import { brokerCall } from "../src/client.ts";
import { encodeAddress } from "../src/envelope.ts";
import { threadSocketPath } from "../src/paths.ts";
import { codexIdentity, listPeers } from "../src/peers.ts";
import type { Me } from "../src/peers.ts";
import { renderForCodex, noticeLine, wakeLine } from "../src/codexframe.ts";
import { formatVisible } from "../src/gateway/gtools.ts";
import { formatPeers } from "../src/tools/messaging.ts";
import { peerStatus } from "../src/status.ts";
import { formatPeerStatus } from "../src/render.ts";
import { topSnapshot, renderTop } from "../src/top.ts";
import { extensionSource } from "../src/agents/omp/extension.ts";
import { FakeOmp } from "./omphost.ts";
import type { ThreadRow } from "../src/store.ts";

const broker = new Broker({ wakeEnabled: false });
let n = 0;

const addrOf = (threadId: string): string => encodeAddress(threadSocketPath(threadId));

const driverFields = (driverId: string): Partial<ThreadRow> => ({
  driver_addr: addrOf(driverId),
  driver_name: broker.store.getThread(driverId)?.name ?? driverId,
});

const bindDriver = (workerId: string, driverId: string): void => {
  broker.store.updateThread(workerId, driverFields(driverId));
};
const HookCall = z.object({ argv: z.array(z.string()), stdin: z.string() });
const HookPayload = z.object({}).passthrough();

const queue = (to: string, fromAddr: string | null, fromName: string, tag: string): void => {
  n++;
  broker.store.enqueue({
    id: `drv-${tag}-${n}`,
    msg_id: `drv-msg-${tag}-${n}`,
    to_thread: to,
    kind: "message",
    from_addr: fromAddr,
    from_name: fromName,
    from_kind: "codex",
    from_session: null,
    from_mode: null,
    body: `body ${tag} ${n}`,
    received_at: Date.now(),
    route: "now",
    decision: null,
  });
};

const freshThread = async (label: string): Promise<{ id: string; me: Me }> => {
  n++;
  const id = `thread-drv-${label}-${n}`;
  await broker.hook({ threadId: id, event: "SessionStart", cwd: `/work/${label}` });
  return { id, me: await codexIdentity(id) };
};

const noticeAfter = async (id: string, prompt = "keep going"): Promise<string> => {
  const out = await broker.hook({ threadId: id, event: "UserPromptSubmit", prompt });
  return typeof out.context === "string" ? out.context : "";
};

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("read groups messages under From-your-driver and From-other-sessions headings, each still in framed peer blocks", async () => {
  const driver = await freshThread("boss");
  const other = await freshThread("helper");
  const worker = await freshThread("worker");
  bindDriver(worker.id, driver.id);
  queue(worker.id, addrOf(driver.id), driver.me.name, "g1");
  queue(worker.id, addrOf(other.id), other.me.name, "g1");
  const text = broker.take(worker.id).text;
  const driverHead = `From your driver (${driver.me.name})`;
  const otherHead = `From other sessions (information only; your driver is ${driver.me.name})`;
  assert.ok(text.includes(driverHead), text);
  assert.ok(text.includes(otherHead), text);
  assert.ok(text.indexOf(driverHead) < text.indexOf(otherHead), "driver group first");
  assert.match(text, new RegExp(`<peer-message-[0-9a-f]+ id="[\\w-]+" from="@${driver.me.name}`), "driver message keeps its framed peer block");
  assert.match(text, new RegExp(`<peer-message-[0-9a-f]+ id="[\\w-]+" from="@${other.me.name}`), "other message keeps its framed peer block");
  assert.ok(text.indexOf(`from="@${driver.me.name}`) < text.indexOf(otherHead), "driver block sits under the driver heading");
});

test("read without a driver renders exactly as before, with no group headings", async () => {
  const a = await freshThread("plain-a");
  const b = await freshThread("plain-b");
  queue(a.id, addrOf(b.id), b.me.name, "g2");
  const text = broker.take(a.id).text;
  assert.ok(!text.includes("From your driver"), text);
  assert.ok(!text.includes("From other sessions"), text);
  assert.match(text, /Another agent session sent you a message\./);
});

test("read with only driver messages shows just the driver heading", async () => {
  const driver = await freshThread("solo-boss");
  const worker = await freshThread("solo-worker");
  bindDriver(worker.id, driver.id);
  queue(worker.id, addrOf(driver.id), driver.me.name, "g3");
  const text = broker.take(worker.id).text;
  assert.ok(text.includes(`From your driver (${driver.me.name})`), text);
  assert.ok(!text.includes("From other sessions"), text);
});

test("notices say from your driver for the driver and name other sessions as not your driver", async () => {
  const driver = await freshThread("notice-boss");
  const other = await freshThread("notice-helper");
  const w1 = await freshThread("notice-w1");
  bindDriver(w1.id, driver.id);
  queue(w1.id, addrOf(driver.id), driver.me.name, "n1");
  assert.match(await noticeAfter(w1.id), /from your driver/, "driver notice");
  const w2 = await freshThread("notice-w2");
  bindDriver(w2.id, driver.id);
  queue(w2.id, addrOf(other.id), other.me.name, "n2");
  const line = await noticeAfter(w2.id);
  assert.ok(line.includes("not your driver"), line);
  assert.ok(!line.includes("from your driver ("), line);
});

test("wake and notice lines keep the agentsocks prefix and stay content-free", () => {
  const from = "your driver";
  assert.ok(noticeLine({ messages: 1, receipts: 0 }, "working", from).startsWith("📨 agentsocks:"), "notice prefix");
  assert.ok(wakeLine(1, true, from).startsWith("📨 agentsocks:"), "wake prefix");
  assert.ok(noticeLine({ messages: 1, receipts: 0 }, "working", from).includes("from your driver"), "notice wording");
  assert.ok(wakeLine(2, true, "another session (not your driver)").includes("not your driver"), "wake wording");
  assert.ok(!wakeLine(1, true, from).includes("secret-body"), "content-free");
});

test("renderForCodex groups by driver address without a broker", () => {
  const now = Date.now();
  const row = (msg: string, from: string | null, name: string) => ({
    id: msg, msg_id: msg, to_thread: "t", kind: "message" as const, from_addr: from, from_name: name,
    from_kind: "codex", from_session: null, from_mode: null, body: "hi", received_at: now,
    state: "queued" as const, surfaced_at: null, stop_blocked: 0, wakes: 0, route: "now" as const,
    decision: null, body_hash: null, released_at: null,
  });
  const text = renderForCodex([row("m1", "uds:/drv.sock", "boss"), row("m2", "uds:/other.sock", "helper")], 0, "tool", { addr: "uds:/drv.sock", name: "boss" }, (m) => m.from_addr === "uds:/drv.sock");
  assert.ok(text.includes("From your driver (boss)"), text);
  assert.ok(text.includes("From other sessions (information only; your driver is boss)"), text);
});

test("describe and list_threads show driver only when set", async () => {
  const driver = await freshThread("listed-boss");
  const worker = await freshThread("listed-worker");
  const plain = await freshThread("listed-plain");
  assert.ok(!("driver" in broker.describe(broker.store.getThread(plain.id)!)), "no driver key without a binding");
  bindDriver(worker.id, driver.id);
  assert.equal(broker.describe(broker.store.getThread(worker.id)!).driver, driver.me.name);
  const listed = await brokerCall<{ threadId: string; driver?: string }[]>("list_threads");
  assert.equal(listed.find((t) => t.threadId === worker.id)?.driver, driver.me.name);
  assert.ok(!("driver" in listed.find((t) => t.threadId === plain.id)!), "list_threads omits driver when unset");
});

test("listPeers carries the driver name through to list --json", async () => {
  const driver = await freshThread("json-boss");
  const worker = await freshThread("json-worker");
  bindDriver(worker.id, driver.id);
  const peers = await listPeers({});
  assert.equal(peers.find((p) => p.session === worker.id)?.driver, driver.me.name);
  const coded = JSON.stringify(peers.find((p) => p.session === worker.id));
  assert.ok(coded.includes(`"driver":"${driver.me.name}"`), coded);
});

test("peer_status and its text form name the driver", async () => {
  const driver = await freshThread("status-boss");
  const worker = await freshThread("status-worker");
  bindDriver(worker.id, driver.id);
  const ref = { kind: "codex" as const, addr: addrOf(worker.id), name: worker.me.name, thread: broker.store.getThread(worker.id) };
  const s = peerStatus(broker.store, ref, Date.now());
  assert.equal(s.peer.driver, driver.me.name);
  assert.ok(formatPeerStatus(s).includes(driver.me.name), "text names the driver");
  const plain = await freshThread("status-plain");
  const p = peerStatus(broker.store, { kind: "codex", addr: addrOf(plain.id), name: plain.me.name, thread: broker.store.getThread(plain.id) }, Date.now());
  assert.ok(!("driver" in p.peer), "no driver key without a binding");
});

test("top snapshot and frame show the driver", async () => {
  const driver = await freshThread("top-boss");
  const worker = await freshThread("top-worker");
  bindDriver(worker.id, driver.id);
  const snap = topSnapshot(broker, Date.now());
  assert.equal(snap.peers.find((p) => p.name === worker.me.name)?.driver, driver.me.name);
  const frame = renderTop(snap, { width: 120, color: false, now: Date.now() });
  assert.ok(frame.includes(driver.me.name), frame);
});

test("list_peers text carries a driver suffix only when set", async () => {
  const driver = await freshThread("text-boss");
  const worker = await freshThread("text-worker");
  const plain = await freshThread("text-plain");
  bindDriver(worker.id, driver.id);
  const peers = await listPeers({});
  const driven = formatPeers(peers, plain.me, "codex");
  assert.ok(driven.includes(`driver ${driver.me.name}`), driven);
  const undriven = peers.find((p) => p.session === plain.id)!;
  assert.ok(!new RegExp(`^- ${undriven.name} \\[[0-9a-f]+\\][^\\n]*driver `, "m").test(driven), "no suffix without a binding");
});

test("gateway visible text carries a driver suffix only when set", async () => {
  const driver = await freshThread("suffix-boss");
  const worker = await freshThread("suffix-worker");
  bindDriver(worker.id, driver.id);
  const peers = await listPeers({});
  const visible = formatVisible(peers, "private");
  assert.ok(visible.includes(`driver ${driver.me.name}`), visible);
});

test("notices add your-driver-is-offline when the driver thread ended", async () => {
  const driver = await freshThread("gone-boss");
  const worker = await freshThread("gone-worker");
  bindDriver(worker.id, driver.id);
  await broker.hook({ threadId: driver.id, event: "SessionEnd" });
  queue(worker.id, addrOf(driver.id), driver.me.name, "off1");
  const line = await noticeAfter(worker.id);
  assert.ok(line.includes("(your driver is offline)"), line);
});

test("notices add your-driver-is-offline when the driver row is gone", async () => {
  const worker = await freshThread("ghost-worker");
  broker.store.updateThread(worker.id, { driver_addr: addrOf("thread-drv-never-there"), driver_name: "ghost" });
  queue(worker.id, addrOf("thread-drv-never-there"), "ghost", "off2");
  const line = await noticeAfter(worker.id);
  assert.ok(line.includes("(your driver is offline)"), line);
});

test("a live driver is not labelled offline", async () => {
  const driver = await freshThread("live-boss");
  const worker = await freshThread("live-worker");
  bindDriver(worker.id, driver.id);
  queue(worker.id, addrOf(driver.id), driver.me.name, "off3");
  const line = await noticeAfter(worker.id);
  assert.ok(!line.includes("offline"), line);
});

const recordCli = (tag: string): { cli: string; calls: string } => {
  const dir = tempDir(`agentsocks-drv-${tag}-`);
  const calls = join(dir, "calls.jsonl");
  const cli = join(dir, "cli.mjs");
  writeFileSync(cli, `for await (const c of process.stdin) (await import("node:fs")).appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), stdin: Buffer.concat([c]).toString() }) + "\\n");\n`);
  return { cli, calls };
};

const startPayload = (calls: string): z.infer<typeof HookPayload> => {
  for (const line of readFileSync(calls, "utf8").trim().split("\n")) {
    const call = HookCall.parse(JSON.parse(line));
    if (call.argv[2] !== "SessionStart") continue;
    return HookPayload.parse(JSON.parse(call.stdin));
  }
  throw new Error(`no SessionStart call in ${calls}`);
}
const loadExtension = (cli: string, sessionId: string, sessionName?: string): Promise<FakeOmp> => {
  const extDir = tempDir("agentsocks-drv-ext-");
  writeFileSync(join(extDir, "package.json"), '{"type":"module"}\n');
  const file = join(extDir, "agentsocks.ts");
  writeFileSync(file, extensionSource({ node: process.execPath, cli }));
  return FakeOmp.load({ file, sessionId, ...(sessionName !== undefined && { sessionName }) });
};


test("the OMP extension passes OMP's own session name in the SessionStart hook", async () => {
  const { cli, calls } = recordCli("omp");
  const host = await loadExtension(cli, "drv-omp-1", "my-own-name");
  try {
    await host.emit("session_start");
    assert.equal(startPayload(calls).name, "my-own-name");
  } finally {
    await host.shutdown();
  }
});

test("without an OMP session name the SessionStart hook carries no name", async () => {
  const { cli, calls } = recordCli("omp2");
  const host = await loadExtension(cli, "drv-omp-2");
  try {
    await host.emit("session_start");
    assert.ok(!("name" in startPayload(calls)), "no name key");
  } finally {
    await host.shutdown();
  }
});

test("an OMP session takes OMP's own name as its broker name", async () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const sessionId = "drv-omp-named";
  const host = await loadExtension(cli, sessionId, "my-own-name");
  try {
    await host.emit("session_start");
    assert.equal(broker.store.getThread(`omp_${sessionId}`)?.name, "my-own-name");
  } finally {
    await host.shutdown();
  }
});
