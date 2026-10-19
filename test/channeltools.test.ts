import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { root, until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { brokerCall } from "../src/client.ts";
import { encodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker({ wakeEnabled: false });
let lead: FakeClaude;
let observer: FakeClaude;
let claudeClient: Client;
let codexClient: Client;

async function connect(host: "claude" | "codex"): Promise<Client> {
  const client = new Client({ name: `channels-${host}`, version: "0" });
  const cwd = join(root, "work", "channels");
  mkdirSync(cwd, { recursive: true });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--host", host], cwd, env: { ...process.env } as Record<string, string> }));
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}, threadId?: string) => {
  const res = (await client.callTool({ name, arguments: args, ...(threadId && { _meta: { threadId } }) })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
};

async function shell(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const r = await exec(process.execPath, [cli, ...args], { env: process.env, timeout: 30_000 });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

const bodies = (c: FakeClaude): string[] => c.frames.map((f) => parseEnvelope(messageContent(f))!.body);
const partyOf = (c: FakeClaude) => ({ kind: "claude", name: c.name, addr: encodeAddress(c.socketPath), session: c.sessionId, mode: null });

before(async () => {
  await broker.start();
  lead = await fakeClaude("lead", process.pid, "busy");
  observer = await fakeClaude("observer", livePid(), "idle");
  await broker.hook({ threadId: "thread-chan", event: "SessionStart", cwd: "/work/chan" });
  claudeClient = await connect("claude");
  codexClient = await connect("codex");
});

after(async () => {
  await claudeClient.close();
  await codexClient.close();
  await closeServer(lead.server);
  await closeServer(observer.server);
  await broker.stop();
});

test("both hosts offer subscribe, unsubscribe, list_channels and broadcast, every parameter is described, and only list_channels is read-only", async () => {
  for (const client of [claudeClient, codexClient]) {
    const tools = (await client.listTools()).tools;
    for (const name of ["subscribe", "unsubscribe", "list_channels", "broadcast"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, name);
      assert.ok(tool.description!.length < 800, name);
      for (const [param, schema] of Object.entries((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>)) assert.ok(schema.description, `${name}.${param}`);
      assert.equal(tool.annotations?.readOnlyHint === true, name === "list_channels", name);
    }
    const urgency = (tools.find((t) => t.name === "broadcast")!.inputSchema.properties as Record<string, { enum?: string[] }>).urgency!;
    assert.deepEqual(urgency.enum, ["normal", "fyi"], "an urgent broadcast cannot even be asked for");
  }
});

test("a Claude session subscribes, a Codex session posts with send_message to the channel, and the Claude session gets it natively with the channel in front", async () => {
  const joined = await call(claudeClient, "subscribe", { channel: "#qa" });
  assert.equal(joined.isError, false, joined.text);
  assert.match(joined.text, /Subscribed to #qa\. Now 1 subscriber: @lead \(you\)\./);
  const sent = await call(codexClient, "send_message", { to: "#qa", message: "tests are green" }, "thread-chan");
  assert.equal(sent.isError, false, sent.text);
  assert.match(sent.text, /Posted to #qa: 1 session\. Each delivery was routed on its own\.\n- @lead \(claude\): routed now, message id [0-9a-f-]{36}/);
  const frame = await until(() => lead.frames.find((f) => parseEnvelope(messageContent(f))?.body === "[#qa] tests are green"));
  assert.equal(parseEnvelope(messageContent(frame))!.fromName, "codex-channels (codex)");
  const listed = await call(codexClient, "list_channels", {}, "thread-chan");
  assert.match(listed.text, /#qa: @lead$/m, "to a Codex session the Claude subscriber is not you");
  assert.match((await call(claudeClient, "list_channels")).text, /#qa: @lead \(you\)$/m);
  const left = await call(claudeClient, "unsubscribe", { channel: "#qa" });
  assert.match(left.text, /Unsubscribed from #qa\. Now no subscribers left\./);
});

test("a Claude session posting to a channel reaches the Codex subscribers and is told to use SendMessage for the Claude ones", async () => {
  await call(codexClient, "subscribe", { channel: "#handoff" }, "thread-chan");
  await brokerCall("channel_subscribe", { party: partyOf(observer), channel: "handoff" });
  const before = observer.frames.length;
  const sent = await call(claudeClient, "send_message", { to: "#handoff", message: "claude to channel" });
  assert.equal(sent.isError, false, sent.text);
  assert.match(sent.text, /- @codex-channels \(codex\): routed now/);
  assert.match(sent.text, /Not posted to @observer: you are a Claude session, so message Claude sessions with your built-in SendMessage\./);
  assert.equal(observer.frames.length, before, "nothing reached the Claude subscriber from a Claude sender");
  const read = await call(codexClient, "read_inbox", {}, "thread-chan");
  assert.match(read.text, /\[#handoff\] claude to channel/);
  await call(codexClient, "unsubscribe", { channel: "#handoff" }, "thread-chan");
  await brokerCall("channel_unsubscribe", { party: partyOf(observer), channel: "handoff" });
});

test("broadcast from Codex reaches the Claude sessions and is batched as fyi by default", async () => {
  observer.setStatus("busy");
  const before = observer.frames.length;
  const sent = await call(codexClient, "broadcast", { message: "maintenance at 18:00" }, "thread-chan");
  assert.equal(sent.isError, false, sent.text);
  assert.match(sent.text, /Posted to #all: 2 sessions/);
  assert.match(sent.text, /@observer \(claude\): batched/);
  assert.equal(observer.frames.length, before, "an fyi broadcast to a busy session is held, not posted");
  const normal = await call(codexClient, "broadcast", { message: "build is green", urgency: "normal" }, "thread-chan");
  assert.match(normal.text, /@observer \(claude\): routed now/);
  await until(() => bodies(observer).includes("[#all] build is green"));
});

test("the command line posts to a channel with send and lists channels with channels", async () => {
  await call(codexClient, "subscribe", { channel: "#cli-room" }, "thread-chan");
  const sent = await shell("send", "#cli-room", "hello from a shell");
  assert.equal(sent.code, 0, sent.err);
  assert.match(sent.out, /Posted to #cli-room: 1 session\. Each delivery was routed on its own\.\n- @codex-channels \(codex\): routed now/);
  assert.match((await call(codexClient, "read_inbox", {}, "thread-chan")).text, /\[#cli-room\] hello from a shell/);
  const listed = JSON.parse((await shell("channels", "--json")).out) as { channels: { channel: string; members: { name: string; ref: string; kind: string; you: boolean; live: boolean }[] }[] };
  const members = listed.channels.find((c) => c.channel === "cli-room")!.members;
  assert.deepEqual(members.map(({ ref, ...rest }) => rest), [{ name: "codex-channels", kind: "codex", you: false, live: true }]);
  assert.match(members[0]!.ref, /^[0-9a-f]{6}$/);
  assert.match((await shell("channels")).out, /#cli-room: @codex-channels \(codex\)/);
  const empty = await shell("send", "#nobody-here", "anyone?");
  assert.equal(empty.code, 0, empty.err);
  assert.match(empty.out, /No one but you is subscribed to #nobody-here, so nothing was sent\./);
  await call(codexClient, "unsubscribe", { channel: "#cli-room" }, "thread-chan");
});

test("a bad channel name is an error the model reads framed, and nothing is subscribed", async () => {
  const bad = await call(codexClient, "subscribe", { channel: "#no good" }, "thread-chan");
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Not subscribed: "#no good" is not a channel name/);
  assert.match(bad.text, /<peer-text-[0-9a-f]{6}>/);
  const reserved = await call(codexClient, "subscribe", { channel: "all" }, "thread-chan");
  assert.match(reserved.text, /#all is every live session/);
});
