import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { until } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { brokerCall } from "../src/client.ts";
import { AGENT_IDS, threadIdFor, type InboxAgentId } from "../src/agents/index.ts";
import { agentIdentity, codexIdentity } from "../src/peers.ts";
import { runtimeDirFor, threadSocketName, threadSocketPath, type SocketContext } from "../src/paths.ts";
import { sendMessage } from "../src/send.ts";
import { stampSession, verifyStamp } from "../src/stamp.ts";

const LINUX_LIMIT = 107;
const DARWIN_LIMIT = 103;
const INBOX_AGENTS = AGENT_IDS.filter((a): a is InboxAgentId => a !== "codex");
const LONGEST_RAW = `${"s".repeat(30)}-${"0123456789".repeat(4)}`.slice(0, 71);
const LONGEST_ID = threadIdFor("opencode", LONGEST_RAW)!;
const UUID = "019a5f2e-7c3b-7d11-9a42-0123456789ab";
const HERMES_LOCAL = `local-${"0123456789abcdef".repeat(4)}`;

const broker = new Broker({ wakeEnabled: false, ttyScan: () => [] });

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

function context(over: Partial<SocketContext>): SocketContext {
  return { platform: "linux", env: {}, uid: 1000, tmpdir: "/tmp", ...over };
}

test("a session id is accepted while the thread id built from it fits 80 characters, so Hermes' local- ids of 70 characters work", () => {
  assert.equal(HERMES_LOCAL.length, 70);
  assert.equal(threadIdFor("hermes", HERMES_LOCAL), `hermes_${HERMES_LOCAL}`);
  assert.equal(LONGEST_ID.length, 80);
  for (const agent of INBOX_AGENTS) {
    const room = 80 - agent.length - 1;
    assert.equal(threadIdFor(agent, "s".repeat(room))?.length, 80, agent);
    assert.equal(threadIdFor(agent, "s".repeat(room + 1)), undefined, agent);
  }
  assert.equal(threadIdFor("codex", "c".repeat(80)), "c".repeat(80));
  assert.equal(threadIdFor("codex", "c".repeat(81)), undefined);
});

test("a long Hermes session id is stamped and its stamp verifies, and an id too long for a thread id is never stamped", () => {
  assert.equal(verifyStamp("hermes", stampSession("hermes", HERMES_LOCAL)), HERMES_LOCAL);
  assert.equal(verifyStamp("cursor", stampSession("hermes", HERMES_LOCAL)), undefined);
  assert.doesNotThrow(() => stampSession("hermes", "s".repeat(73)));
  assert.throws(() => stampSession("hermes", "s".repeat(74)), /not a session id agentsocks can stamp/);
});

test("a thread id of 36 characters or fewer keeps the socket name it has always had, and a longer one is hashed into a name that is the same every time and differs between ids", () => {
  assert.equal(threadSocketName(UUID), `${UUID}.sock`);
  assert.equal(threadSocketName("x".repeat(36)), `${"x".repeat(36)}.sock`);
  const hashed = threadSocketName(LONGEST_ID);
  assert.match(hashed, /^h\.[0-9a-f]{32}\.sock$/);
  assert.equal(threadSocketName(LONGEST_ID), hashed);
  assert.notEqual(threadSocketName("a".repeat(64)), threadSocketName(`${"a".repeat(63)}b`), "ids that share their first 63 characters do not share a socket");
  assert.notEqual(threadSocketName("x".repeat(37)), threadSocketName("x".repeat(38)));
  assert.equal(threadSocketPath(UUID), join(process.env.AGENTSOCKS_RUNTIME_DIR!, "t", `${UUID}.sock`));
});

test("the socket of the longest thread id fits sun_path wherever a 36 character id does: Linux limit 107, macOS and BSD limit 103, in every runtime directory agentsocks can choose", () => {
  const fitsIn = (ctx: SocketContext, limit: number, label: string) => {
    for (const id of [LONGEST_ID, threadIdFor("copilot", LONGEST_RAW)!, "x".repeat(80)]) {
      const path = join(runtimeDirFor(ctx), "t", threadSocketName(id));
      assert.ok(Buffer.byteLength(path) <= limit, `${label}: ${path} is ${Buffer.byteLength(path)} bytes`);
    }
  };
  fitsIn(context({ env: { XDG_RUNTIME_DIR: "/run/user/1000" } }), LINUX_LIMIT, "linux, systemd runtime dir");
  fitsIn(context({ uid: 4294967294, env: { XDG_RUNTIME_DIR: "/run/user/4294967294" } }), LINUX_LIMIT, "linux, largest uid");
  fitsIn(context({}), LINUX_LIMIT, "linux, no runtime dir");
  fitsIn(context({ tmpdir: "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T" }), LINUX_LIMIT, "linux, long tmpdir");
  for (let len = 1; len <= 150; len++) {
    fitsIn(context({ platform: "darwin", uid: 501, tmpdir: `/${"d".repeat(len)}` }), DARWIN_LIMIT, `darwin, tmpdir of ${len + 1} characters`);
  }
  fitsIn(context({ platform: "darwin", uid: 501, tmpdir: "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T" }), DARWIN_LIMIT, "darwin, the real macOS tmpdir");
});

test("a session with the longest id its agent allows registers for every agent, binds its socket under the test runtime directory, and receives a message sent to it by name", async () => {
  const sender = await (async () => {
    await broker.hook({ threadId: "long-sender-1", event: "SessionStart", cwd: "/work/longsender" });
    return codexIdentity("long-sender-1");
  })();
  for (const agent of INBOX_AGENTS) {
    const raw = `${agent}-${"k".repeat(80)}`.slice(0, 80 - agent.length - 1);
    const me = await agentIdentity(agent, raw, `/work/long-${agent}`);
    const threadId = threadIdFor(agent, raw)!;
    assert.equal(me.session, threadId);
    const described = broker.describe(broker.store.getThread(threadId)!);
    assert.ok(Buffer.byteLength(described.socketPath) <= LINUX_LIMIT, `${agent}: ${described.socketPath}`);
    assert.equal(lstatSync(described.socketPath).isSocket(), true, `${agent} has a bound inbox`);
    assert.equal(described.socketPath, threadSocketPath(threadId));
    const sent = await sendMessage(sender, me.name, `hello long ${agent}`);
    assert.equal(sent.delivered, true, `${agent}: ${sent.note}`);
    const got = await until(() => {
      const text = broker.take(threadId).text;
      return text.includes(`hello long ${agent}`) ? text : undefined;
    });
    assert.match(got, new RegExp(`hello long ${agent}`));
  }
});

test("a long thread id is found again from its socket path after the broker restarts, so a message addressed to the hashed path still reaches it", async () => {
  const raw = "r".repeat(64);
  const me = await agentIdentity("gemini", raw, "/work/longrestart");
  const threadId = threadIdFor("gemini", raw)!;
  await broker.stop();
  await broker.start();
  await brokerCall("register", { threadId, agent: "gemini" });
  await broker.hook({ threadId: "long-sender-2", event: "SessionStart", cwd: "/work/longsender2" });
  const sender = await codexIdentity("long-sender-2");
  const sent = await sendMessage(sender, me.name, "after the restart");
  assert.equal(sent.delivered, true, sent.note);
  const got = await until(() => {
    const text = broker.take(threadId).text;
    return text.includes("after the restart") ? text : undefined;
  });
  assert.match(got, /after the restart/);
  assert.equal(lstatSync(threadSocketPath(threadId)).isSocket(), true);
});
