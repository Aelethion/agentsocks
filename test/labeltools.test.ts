import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { root, fakeClaude, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { codexIdentity, type Me } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker({ wakeEnabled: false });
let lead: FakeClaude;
let claudeClient: Client;
let codexClient: Client;
let pusher: Me;

async function connect(host: "claude" | "codex"): Promise<Client> {
  const client = new Client({ name: `labels-${host}`, version: "0" });
  const cwd = join(root, "work", "rater");
  mkdirSync(cwd, { recursive: true });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--host", host], cwd, env: { ...process.env } as Record<string, string> }));
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}, threadId?: string) => {
  const res = (await client.callTool({ name, arguments: args, ...(threadId && { _meta: { threadId } }) })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
};

before(async () => {
  await broker.start();
  lead = await fakeClaude("lead", process.pid, "busy");
  await broker.hook({ threadId: "thread-rater", event: "SessionStart", cwd: "/work/rater" });
  await broker.hook({ threadId: "thread-pusher", event: "SessionStart", cwd: "/work/pusher" });
  pusher = await codexIdentity("thread-pusher");
  claudeClient = await connect("claude");
  codexClient = await connect("codex");
});

after(async () => {
  await claudeClient.close();
  await codexClient.close();
  await closeServer(lead.server);
  await broker.stop();
});

test("both hosts offer rate_message with a three-value rating, and it is not read-only", async () => {
  for (const client of [claudeClient, codexClient]) {
    const tool = (await client.listTools()).tools.find((t) => t.name === "rate_message")!;
    assert.ok(tool && tool.description!.length < 800);
    const props = tool.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
    assert.deepEqual(props.rating!.enum, ["useful-now", "could-wait", "noise"]);
    for (const [name, schema] of Object.entries(props)) assert.ok(schema.description, name);
    assert.notEqual(tool.annotations?.readOnlyHint, true);
  }
});

test("a Codex session rates a message by the id read_inbox shows, and a Claude session rates the latest message from a sender", async () => {
  const toCodex = await sendMessage(pusher, "codex-rater", "build is green again");
  const inbox = await call(codexClient, "read_inbox", {}, "thread-rater");
  const id = inbox.text.match(/<peer-message-[0-9a-f]+ id="([^"]+)"/)![1]!;
  assert.equal(id, toCodex.msgId);
  const rated = await call(codexClient, "rate_message", { rating: "could-wait", message_id: id }, "thread-rater");
  assert.equal(rated.isError, false, rated.text);
  assert.match(rated.text, /Rated the message from @codex-pusher \(codex\) as could-wait\. It is stored on this machine, with its text,/);
  assert.match(rated.text, /<peer-text-[0-9a-f]{6}>/);

  await sendMessage(pusher, "lead", "the lint job finished");
  const claudeRated = await call(claudeClient, "rate_message", { rating: "noise", from: pusher.name });
  assert.equal(claudeRated.isError, false, claudeRated.text);
  assert.match(claudeRated.text, /as noise\./);
  const rows = broker.store.db.prepare("SELECT rating, source, body FROM labels ORDER BY id").all() as { rating: string; source: string; body: string }[];
  assert.deepEqual(rows.map((r) => [r.rating, r.source, r.body]), [["could-wait", "explicit", "build is green again"], ["noise", "explicit", "the lint job finished"]]);
});

test("errors reach the model framed: a message that was never delivered to it, and a rating that is not one of the three", async () => {
  const none = await call(codexClient, "rate_message", { rating: "noise", message_id: "never-sent" }, "thread-rater");
  assert.equal(none.isError, true);
  assert.match(none.text, /Not rated: no message never-sent was delivered to you through agentsocks/);
  assert.match(none.text, /<peer-text-[0-9a-f]{6}>/);
  const bad = await call(codexClient, "rate_message", { rating: "meh" }, "thread-rater");
  assert.equal(bad.isError, true);
});
