import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { root, fakeClaude, livePid, until, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress, messageContent, parseEnvelope } from "../src/envelope.ts";
import { stampSession } from "../src/stamp.ts";
import { toolsFor } from "../src/tools/index.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker({ wakeEnabled: false });
let lead: FakeClaude;
let hermes: Client;

async function connect(args: string[]): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "0" });
  const cwd = join(root, "work", "hermes-proj");
  mkdirSync(cwd, { recursive: true });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", ...args], cwd, env: { ...process.env } as Record<string, string> }));
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
};

before(async () => {
  await broker.start();
  lead = await fakeClaude("lead", livePid(), "idle");
  hermes = await connect(["--agent", "hermes"]);
});

after(async () => {
  await hermes.close();
  await closeServer(lead.server);
  await broker.stop();
});

test("an MCP server started for an agent offers the inbox tool set and says in each schema that the session stamp is the hook's to fill", async () => {
  const tools = (await hermes.listTools()).tools;
  const combined = ["list_peers", "list_tasks", "message_status", "peer_status", "read_inbox", "send_message", "send_task", "set_name", "set_driver", "update_task", "wait_for_message", "subscribe", "unsubscribe", "list_channels", "broadcast", "ask", "answer", "rate_message"];
  assert.deepEqual(tools.map((t) => t.name).sort(), [...combined].sort(), "the tools of 0.3.1 and the ones 0.4 added");
  assert.deepEqual(tools.map((t) => t.name).sort(), toolsFor("codex").map((t) => t.name).sort(), "and nothing the Codex route does not offer");
  for (const t of tools) {
    const session = (t.inputSchema.properties as Record<string, { description?: string }>)._session;
    assert.match(session?.description ?? "", /Reserved/, `${t.name} carries the reserved _session field`);
    assert.ok(!(t.inputSchema.required ?? []).includes("_session"), `${t.name} does not require it`);
  }
});

test("a call with the stamp the hook wrote is that session: it registers as a thread of the agent and its messages say so", async () => {
  const stamp = stampSession("hermes", "20261013_101500_ab12cd");
  await broker.hook({ threadId: "hermes_20261013_101500_ab12cd", agent: "hermes", event: "SessionStart", cwd: join(root, "work", "hermes-proj") });
  const peers = await call(hermes, "list_peers", { _session: stamp });
  assert.equal(peers.isError, false, peers.text);
  assert.match(peers.text, /lead \[[0-9a-f]{6}\] claude, idle/);
  const sent = await call(hermes, "send_message", { to: "lead", message: "the migration is done", _session: stamp });
  assert.equal(sent.isError, false, sent.text);
  const frame = await until(() => lead.frames.find((f) => parseEnvelope(messageContent(f))?.body === "the migration is done"));
  const env = parseEnvelope(messageContent(frame))!;
  assert.equal(env.fromName, "hermes-proj (hermes)");
  const t = broker.store.getThread("hermes_20261013_101500_ab12cd")!;
  assert.equal(t.agent, "hermes");
  assert.equal(t.cwd, join(root, "work", "hermes-proj"), "the cwd the hook reported stays, whatever folder the MCP server was started in");
  assert.equal(t.name, "hermes-proj");
  const seen = await call(hermes, "list_peers", { _session: stamp });
  assert.match(seen.text, /hermes-proj \[[0-9a-f]{6}\] hermes, .*\(you\)/);
});

test("the inbox of a stamped session is read by that session only, and the message carries the sender's agent", async () => {
  const stamp = stampSession("hermes", "20261013_101500_ab12cd");
  const other = stampSession("hermes", "20261013_999999_ffffff");
  await call(hermes, "list_peers", { _session: other });
  assert.equal(broker.store.getThread("hermes_20261013_999999_ffffff")!.name, "hermes-20261013", "a session no hook has met yet is named from its id");
  broker.store.enqueue({ id: "m1", msg_id: "m1", to_thread: "hermes_20261013_101500_ab12cd", kind: "message", from_addr: encodeAddress(lead.socketPath), from_name: "lead", from_kind: "claude", from_session: null, from_mode: null, body: "rebase onto main", received_at: Date.now(), route: "now", decision: null });
  const mine = await call(hermes, "read_inbox", { _session: stamp });
  assert.match(mine.text, /rebase onto main/);
  assert.match((await call(hermes, "read_inbox", { _session: other })).text, /No new messages\./, "another session of the same agent does not see it");
});

test("no stamp, a forged stamp, a stamp for another agent, and a stamp that names another session are all refused with a message that says what to check", async () => {
  const good = stampSession("hermes", "20261013_101500_ab12cd");
  const wrongAgent = stampSession("gemini", "20261013_101500_ab12cd");
  const attempts: [string, Record<string, unknown>][] = [
    ["no stamp", {}],
    ["a forged mac", { _session: `20261013_101500_ab12cd.${"0".repeat(32)}` }],
    ["a bare session id", { _session: "20261013_101500_ab12cd" }],
    ["another agent's stamp", { _session: wrongAgent }],
    ["a session swapped under a good mac", { _session: good.replace("20261013_101500_ab12cd", "20261013_000000_000000") }],
  ];
  for (const [what, args] of attempts) {
    const r = await call(hermes, "read_inbox", args);
    assert.equal(r.isError, true, what);
    assert.match(r.text, /could not tell which Hermes session is calling/, what);
    assert.match(r.text, /agentsocks doctor/, what);
  }
  assert.equal(broker.store.getThread("hermes_20261013_000000_000000"), undefined, "a refused stamp registers nothing");
});
