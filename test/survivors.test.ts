import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wakeLog } from "./support.ts";
import { tempDir } from "./tmp.ts";
import { Broker } from "../src/broker.ts";
import { encodeAddress } from "../src/envelope.ts";
import { stampKeyPath, stampSession, verifyStamp } from "../src/stamp.ts";
import type { AgentSpec, InboxAgentId } from "../src/agents/index.ts";
import type { TtyActivity } from "../src/typing.ts";

const woken: { threadId: string; line: string }[] = [];
let ttys: TtyActivity[] = [];

const wakeable = (id: InboxAgentId): AgentSpec => ({
  id,
  live: "untested",
  hook: async () => undefined,
  wake: async ({ thread, line }) => {
    woken.push({ threadId: thread.thread_id, line });
    return { ok: true };
  },
  installer: { detect: () => false, install: () => {}, uninstall: () => {}, status: () => ({ state: "not installed", detail: [] }) },
});

const broker = new Broker({ ttyScan: () => ttys, agents: [wakeable("opencode"), wakeable("hermes")], wakeEnabled: false });
const typing = (): TtyActivity[] => [{ pid: 1, tty: "/dev/pts/1", inputAgeMs: 2_000 }];
const codexQueueLines = (): string[] => {
  if (!existsSync(wakeLog)) return [];
  const lines = readFileSync(wakeLog, "utf8").split("\n");
  return lines.flatMap((l, i) => (l === "--message" ? [lines[i + 1]!] : []));
};
const unread = (threadId: string, id: string) =>
  broker.store.enqueue({
    id,
    msg_id: id,
    to_thread: threadId,
    kind: "message",
    from_addr: encodeAddress("/tmp/cc-socks/ann.sock"),
    from_name: "ann",
    from_kind: "claude",
    from_session: null,
    from_mode: null,
    body: "survivor",
    received_at: Date.now(),
    route: "now",
    decision: null,
  });

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("typing guard: someone typing in a Codex terminal holds a wake to a Codex thread and does not hold a wake to a session of another agent, which has no Codex terminal to protect", async () => {
  ttys = typing();
  await broker.hook({ threadId: "surv-codex-typing", event: "SessionStart", cwd: "/work/survtype" });
  await broker.hook({ threadId: "surv-codex-typing", event: "Stop" });
  unread("surv-codex-typing", "t-codex");
  const queued = codexQueueLines().length;
  await broker.wake("surv-codex-typing", Date.now() + 5000);
  assert.equal(codexQueueLines().length, queued, "the Codex wake is held while someone types");
  assert.notEqual(broker.store.getThread("surv-codex-typing")!.wake_hold_since, null);

  for (const agent of ["opencode", "hermes"] as const) {
    const id = `${agent}_surv_typing`;
    await broker.hook({ threadId: id, agent, event: "SessionStart", cwd: "/work/survtype" });
    await broker.hook({ threadId: id, agent, event: "Stop" });
    unread(id, `t-${agent}`);
    woken.length = 0;
    await broker.wake(id, Date.now() + 5000);
    assert.equal(woken.length, 1, `${agent} is woken although a Codex terminal has recent input`);
    assert.equal(broker.store.getThread(id)!.wake_hold_since, null, `${agent} is never put on a typing hold`);
  }
  ttys = [];
});

test("wake line: a session of another agent is told to read with the tool even if no hook has run for it yet, and a Codex session is told to use the shell command until its hooks run", async () => {
  const id = "opencode_surv_toolonly";
  await broker.register(id, { cwd: "/work/survtool" });
  assert.equal(broker.store.getThread(id)!.hooks_active, 0);
  unread(id, "w-agent");
  woken.length = 0;
  await broker.wake(id, Date.now() + 5000);
  assert.equal(woken.length, 1);
  assert.match(woken[0]!.line, /Read it with read_inbox\.$/);
  assert.doesNotMatch(woken[0]!.line, /agentsocks inbox/);

  await broker.register("surv-codex-nohook", { cwd: "/work/survnohook" });
  assert.equal(broker.store.getThread("surv-codex-nohook")!.hooks_active, 0);
  unread("surv-codex-nohook", "w-codex-nohook");
  await broker.wake("surv-codex-nohook", Date.now() + 5000);
  assert.match(codexQueueLines().at(-1)!, /Read it by running: agentsocks inbox$/);

  await broker.hook({ threadId: "surv-codex-hooked", event: "SessionStart", cwd: "/work/survhooked" });
  await broker.hook({ threadId: "surv-codex-hooked", event: "Stop" });
  unread("surv-codex-hooked", "w-codex-hooked");
  await broker.wake("surv-codex-hooked", Date.now() + 5000);
  assert.match(codexQueueLines().at(-1)!, /Read it with read_inbox\.$/);
});

const stampProc = fileURLToPath(new URL("./fixtures/stampproc.ts", import.meta.url));

function stampInChild(stateDir: string, startAt: number, agent: string, session: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [stampProc, agent, session, String(startAt)], { env: { ...process.env, AGENTSOCKS_STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`stamp child exited ${code}: ${err}`))));
  });
}

test("stamp key: processes that all need the key at once end up with one key, and every stamp any of them made verifies", async () => {
  for (let round = 0; round < 3; round++) {
    const state = tempDir("survivor-stamp-");
    const startAt = Date.now() + 700;
    const stamps = await Promise.all(Array.from({ length: 12 }, (_, i) => stampInChild(state, startAt, "cursor", `race-${round}-${i}`)));
    const saved = process.env.AGENTSOCKS_STATE_DIR;
    process.env.AGENTSOCKS_STATE_DIR = state;
    try {
      stamps.forEach((stamp, i) => assert.equal(verifyStamp("cursor", stamp), `race-${round}-${i}`, `round ${round}: stamp ${i} verifies against the key that is on disk`));
      assert.deepEqual(readdirSync(state).sort(), ["stamp.key"], "no temporary key file is left behind");
      assert.equal(statSync(stampKeyPath()).mode & 0o777, 0o600);
    } finally {
      process.env.AGENTSOCKS_STATE_DIR = saved;
    }
  }
});

test("stamp key: a key that is already there is used and never replaced, and one that is not a 32 byte key is replaced once, by a key every later stamp uses", () => {
  const state = tempDir("stamp-existing-");
  const saved = process.env.AGENTSOCKS_STATE_DIR;
  process.env.AGENTSOCKS_STATE_DIR = state;
  try {
    const first = stampSession("hermes", "keep-1");
    const before = readFileSync(stampKeyPath(), "utf8");
    assert.equal(stampSession("hermes", "keep-2").split(".")[1] === first.split(".")[1], false, "different sessions get different macs");
    assert.equal(readFileSync(stampKeyPath(), "utf8"), before, "a second stamp does not touch the key");
    assert.equal(verifyStamp("hermes", first), "keep-1");
    assert.equal(verifyStamp("cursor", first), undefined, "a stamp is for one agent");

    writeFileSync(stampKeyPath(), "not a key\n");
    const repaired = stampSession("hermes", "keep-3");
    const after = readFileSync(stampKeyPath(), "utf8");
    assert.match(after, /^[0-9a-f]{64}\n$/);
    assert.equal(stampSession("hermes", "keep-3"), repaired, "the replacement key is the one every later stamp uses");
    assert.equal(readFileSync(stampKeyPath(), "utf8"), after);
    assert.equal(verifyStamp("hermes", first), undefined, "a stamp made with the key that was thrown away no longer verifies");
    assert.deepEqual(readdirSync(state).sort(), ["stamp.key"]);
  } finally {
    process.env.AGENTSOCKS_STATE_DIR = saved;
  }
});

test("stamp key: when another process creates the key between our read and our link, our key is dropped, its key is the one kept and used, and no temporary file is left", () => {
  const state = tempDir("survivor-stamp-race-");
  const saved = process.env.AGENTSOCKS_STATE_DIR;
  process.env.AGENTSOCKS_STATE_DIR = state;
  const competitor = randomBytes(32).toString("hex");
  const realLink = fs.linkSync;
  fs.linkSync = ((existing: fs.PathLike, target: fs.PathLike) => {
    writeFileSync(target, `${competitor}\n`, { mode: 0o600 });
    return realLink(existing, target);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  try {
    const stamp = stampSession("cursor", "raced");
    assert.equal(readFileSync(stampKeyPath(), "utf8").trim(), competitor, "the key that won the race is the one on disk");
    assert.equal(verifyStamp("cursor", stamp), "raced", "and the stamp was made with it");
    assert.deepEqual(readdirSync(state).sort(), ["stamp.key"]);
  } finally {
    fs.linkSync = realLink;
    syncBuiltinESMExports();
    process.env.AGENTSOCKS_STATE_DIR = saved;
  }
});
