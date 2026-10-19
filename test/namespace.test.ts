import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until, fakeClaude, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer, postLines } from "../src/ccsocks.ts";
import { buildEnvelope, encodeAddress } from "../src/envelope.ts";
import { codexHexName, inboxKind } from "../src/paths.ts";
import { codexIdentity, listPeers, resolvePeer, type Me } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { tempDir } from "./tmp.ts";

const ccdir = process.env.AGENTSOCKS_CCSOCKS_DIR!;
const runtime = process.env.AGENTSOCKS_RUNTIME_DIR!;
const broker = new Broker();
let claude: FakeClaude;
const aliasOf = (threadId: string) => join(runtime, "t", `${threadId}.sock`);
const hexOf = (threadId: string) => `a${createHash("sha256").update(`${runtime}\0${threadId}`).digest("hex").slice(0, 15)}`;
const isSocket = (p: string) => {
  try {
    return lstatSync(p).isSocket();
  } catch {
    return false;
  }
};
const frame = (from: string, body: string, id: string) => JSON.stringify({ type: "user", message: { role: "user", content: buildEnvelope({ from, fromName: "peer", body }) }, priority: "next", msg_id: id });

before(async () => {
  await broker.start();
  claude = await fakeClaude("alpha", process.pid, "idle");
  chmodSync(ccdir, 0o700);
  writeFileSync(join(ccdir, "keep.txt"), "not ours");
});

after(async () => {
  await closeServer(claude.server);
  await broker.stop();
});

test("a Codex inbox is advertised in Claude's cc-socks directory under a hex name, and the v0.1 path stays bound as an alias", async () => {
  await broker.hook({ threadId: "thread-n1", event: "SessionStart", cwd: "/work/n1" });
  const me = await codexIdentity("thread-n1");
  const ns = join(ccdir, `${hexOf("thread-n1")}.sock`);
  assert.equal(me.socketPath, ns, "the advertised address is the namespaced one");
  assert.equal(codexHexName("thread-n1"), `${hexOf("thread-n1")}.sock`);
  assert.match(hexOf("thread-n1"), /^a[0-9a-f]{15}$/);
  assert.equal(hexOf("thread-n1").length, 16);
  for (const p of [ns, aliasOf("thread-n1")]) {
    assert.ok(isSocket(p), `${p} is bound`);
    assert.equal(lstatSync(p).mode & 0o777, 0o600);
  }
  await postLines(ns, [frame(encodeAddress(claude.socketPath), "via the namespaced path", "ns-1")]);
  await postLines(aliasOf("thread-n1"), [frame(encodeAddress(claude.socketPath), "via the v0.1 alias", "ns-2")]);
  await until(() => broker.store.queuedCount("thread-n1") === 2);
  const text = broker.take("thread-n1").text;
  assert.ok(text.includes("via the namespaced path") && text.includes("via the v0.1 alias"));
});

test("a hex name is never all digits, and it depends on the broker's runtime directory so two brokers never share a name", () => {
  for (let i = 0; i < 200; i++) assert.ok(!/^\d+$/.test(hexOf(`thread-${i}`)));
  const here = codexHexName("thread-x");
  const saved = process.env.AGENTSOCKS_RUNTIME_DIR;
  process.env.AGENTSOCKS_RUNTIME_DIR = join(saved!, "other-broker");
  try {
    assert.notEqual(codexHexName("thread-x"), here);
  } finally {
    process.env.AGENTSOCKS_RUNTIME_DIR = saved;
  }
  assert.equal(codexHexName("thread-x"), here);
});

test("by path alone, anything in a cc-socks directory is Claude and a t/ path is ours; the broker knows the rest", () => {
  assert.equal(inboxKind(`${ccdir}/4242.sock`), "claude");
  assert.equal(inboxKind(`${ccdir}/abc.sock`), "claude");
  assert.equal(inboxKind(aliasOf("whatever")), "codex");
  assert.equal(inboxKind("/tmp/elsewhere/9.sock"), "agent");
  assert.equal(inboxKind("/run/user/4242/cc-socks/77.sock"), "claude");
  assert.equal(inboxKind("/tmp/cc-socks-4242/8777.sock"), "claude", "the fallback directory Claude uses when XDG_RUNTIME_DIR is unset");
  assert.equal(inboxKind("/tmp/cc-socks-501/8777-0a1b2c3d.sock"), "claude");
  assert.equal(inboxKind("/tmp/not-cc-socks/8777.sock"), "agent");
});

test("a Claude session whose socket is named like a Codex hex name is still Claude, and an unknown hex name in a cc-socks directory is Claude too", async () => {
  const lookalike = await fakeClaude("hexy", 7, "idle", "a0123456789abcde.sock");
  try {
    const me = await codexIdentity("thread-n1");
    await postLines(aliasOf("thread-n1"), [frame(encodeAddress(lookalike.socketPath), "from a registered Claude with a hex-shaped socket", "hx-1"), frame(encodeAddress(`${ccdir}/a1111111111111111.sock`), "from an unknown hex-shaped socket", "hx-2")]);
    await until(() => broker.store.db.prepare("SELECT 1 FROM messages WHERE msg_id = 'hx-2'").get());
    const kinds = broker.store.db.prepare("SELECT msg_id, from_kind FROM messages WHERE msg_id IN ('hx-1', 'hx-2') ORDER BY msg_id").all() as { msg_id: string; from_kind: string }[];
    assert.deepEqual(kinds.map((k) => k.from_kind), ["claude", "claude"]);
    assert.ok(me.socketPath);
  } finally {
    await closeServer(lookalike.server);
  }
});

test("sender kind is recognised for both layouts, so labels and routing stay right", async () => {
  const me = await codexIdentity("thread-n1");
  const sock = aliasOf("thread-n1");
  await broker.hook({ threadId: "thread-n2", event: "SessionStart", cwd: "/work/n2" });
  const second = await codexIdentity("thread-n2");
  await postLines(aliasOf("thread-n2"), [frame(encodeAddress(me.socketPath!), "from a namespaced codex address", "k-1"), frame(encodeAddress(sock), "from an alias codex address", "k-2"), frame(encodeAddress(claude.socketPath), "from claude", "k-3")]);
  await until(() => broker.store.queuedCount("thread-n2") === 3);
  const kinds = broker.store.db.prepare("SELECT msg_id, from_kind FROM messages WHERE to_thread = 'thread-n2' ORDER BY msg_id").all() as { msg_id: string; from_kind: string }[];
  assert.deepEqual(kinds.map((k) => k.from_kind), ["codex", "codex", "claude"]);
  assert.equal(second.socketPath, join(ccdir, `${hexOf("thread-n2")}.sock`));
});

test("peers list and resolve by the advertised path, and a reply to it from Claude marks the question answered", async () => {
  const me = await codexIdentity("thread-n1");
  const peers = await listPeers();
  const self = peers.find((p) => p.session === "thread-n1")!;
  assert.equal(self.socketPath, me.socketPath);
  assert.equal(resolvePeer(peers, `uds:${me.socketPath}`).session, "thread-n1");
  const asked = await sendMessage(me, "alpha", "do you have the schema?");
  await until(() => claude.frames.length >= 1);
  const frameIn = claude.frames.at(-1)!;
  const content = (frameIn.message as { content: string }).content;
  assert.ok(content.includes(`from="${encodeAddress(me.socketPath!)}"`), "Claude is told to reply to the namespaced address");
  const projects = join(process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR!, "-work-alpha");
  mkdirSync(projects, { recursive: true });
  appendFileSync(join(projects, `${claude.sessionId}.jsonl`), `${JSON.stringify({ origin: { kind: "peer", msg_id: asked.msgId } })}\n`);
  await postLines(me.socketPath!, [frame(encodeAddress(claude.socketPath), "yes, attached", "reply-ns")]);
  await until(() => broker.store.getOutbox(asked.msgId)!.status === "replied");
  const row = broker.store.db.prepare("SELECT route, decision FROM messages WHERE msg_id = 'reply-ns'").get() as { route: string };
  assert.ok(row, "the reply arrived in the Codex inbox");
});

test("receipts sent to the namespaced address reach the sender's outbox", async () => {
  const me = await codexIdentity("thread-n1");
  const sent = await sendMessage(me, "alpha", "needs approval please");
  await postLines(me.socketPath!, [JSON.stringify({ type: "control", action: "peer_message_status", status: "held", orig_msg_id: sent.msgId, reason: "awaiting approval" })]);
  await until(() => broker.store.getOutbox(sent.msgId)!.status === "held");
  assert.match(broker.store.getOutbox(sent.msgId)!.error!, /awaiting approval/);
});

test("other files in the cc-socks directory are never touched, and our sockets are removed when the session ends", async () => {
  const before = readdirSync(ccdir).sort();
  await broker.hook({ threadId: "thread-n3", event: "SessionStart", cwd: "/work/n3" });
  const ns = join(ccdir, `${hexOf("thread-n3")}.sock`);
  assert.ok(isSocket(ns));
  await broker.hook({ threadId: "thread-n3", event: "SessionEnd" });
  assert.ok(!existsSync(ns) && !existsSync(aliasOf("thread-n3")), "both sockets are removed");
  assert.deepEqual(readdirSync(ccdir).sort(), before);
  assert.equal(readFileSync(join(ccdir, "keep.txt"), "utf8"), "not ours");
  assert.ok(isSocket(claude.socketPath), "Claude's own sockets are untouched");
});

test("a namespaced socket that disappears is not advertised while it is gone, and is bound again on the next sweep", async () => {
  await broker.hook({ threadId: "thread-n4", event: "SessionStart", cwd: "/work/n4" });
  const ns = join(ccdir, `${hexOf("thread-n4")}.sock`);
  const { unlinkSync } = await import("node:fs");
  unlinkSync(ns);
  const listed = () => listPeers().then((peers) => peers.find((p) => p.session === "thread-n4")!.socketPath);
  assert.equal(await listed(), aliasOf("thread-n4"), "a listing never advertises a socket that is not there");
  await broker.runSweep();
  assert.ok(isSocket(ns));
  assert.equal(await listed(), ns);
});

test("without a usable cc-socks directory the v0.1 path is advertised and nothing is created", async () => {
  const saved = process.env.AGENTSOCKS_CCSOCKS_DIR;
  const base = tempDir("agentsocks-ccdir-");
  try {
    const missing = join(base, "cc-socks");
    process.env.AGENTSOCKS_CCSOCKS_DIR = missing;
    await broker.hook({ threadId: "thread-m1", event: "SessionStart", cwd: "/work/m1" });
    assert.equal((await codexIdentity("thread-m1")).socketPath, aliasOf("thread-m1"));
    assert.ok(!existsSync(missing), "the directory is not created for us");

    const loose = join(base, "loose");
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    process.env.AGENTSOCKS_CCSOCKS_DIR = loose;
    await broker.hook({ threadId: "thread-m2", event: "SessionStart", cwd: "/work/m2" });
    assert.equal((await codexIdentity("thread-m2")).socketPath, aliasOf("thread-m2"), "a directory that is not 0700 is not used");
    assert.deepEqual(readdirSync(loose), []);

    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(base, "link"));
    process.env.AGENTSOCKS_CCSOCKS_DIR = join(base, "link");
    await broker.hook({ threadId: "thread-m3", event: "SessionStart", cwd: "/work/m3" });
    assert.equal((await codexIdentity("thread-m3")).socketPath, aliasOf("thread-m3"), "a symlinked directory is not used");
    assert.deepEqual(readdirSync(real), []);

    process.env.AGENTSOCKS_CCSOCKS_DIR = missing;
    mkdirSync(missing, { mode: 0o700 });
    chmodSync(missing, 0o700);
    assert.equal((await codexIdentity("thread-m1")).socketPath, join(missing, `${hexOf("thread-m1")}.sock`), "once the directory exists the next registration moves the advertised address");
  } finally {
    process.env.AGENTSOCKS_CCSOCKS_DIR = saved;
  }
});

test("a cc-socks directory whose socket names would not fit sun_path is left alone and the v0.1 path is advertised", async () => {
  const saved = process.env.AGENTSOCKS_CCSOCKS_DIR;
  const base = tempDir("agentsocks-ccdir-");
  const long = join(base, "x".repeat(40), "y".repeat(40), "cc-socks");
  mkdirSync(long, { recursive: true, mode: 0o700 });
  chmodSync(long, 0o700);
  try {
    process.env.AGENTSOCKS_CCSOCKS_DIR = long;
    await broker.hook({ threadId: "thread-long", event: "SessionStart", cwd: "/work/long" });
    assert.equal((await codexIdentity("thread-long")).socketPath, aliasOf("thread-long"));
    assert.deepEqual(readdirSync(long), []);
  } finally {
    process.env.AGENTSOCKS_CCSOCKS_DIR = saved;
  }
});

test("an isolated instance (runtime dir overridden, no cc-socks override) never reaches into the system directory", async () => {
  const saved = process.env.AGENTSOCKS_CCSOCKS_DIR;
  delete process.env.AGENTSOCKS_CCSOCKS_DIR;
  try {
    await broker.hook({ threadId: "thread-iso", event: "SessionStart", cwd: "/work/iso" });
    assert.equal((await codexIdentity("thread-iso")).socketPath, aliasOf("thread-iso"));
  } finally {
    process.env.AGENTSOCKS_CCSOCKS_DIR = saved;
  }
});
