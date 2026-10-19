import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { root, until, fakeClaude, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { messageContent, parseEnvelope } from "../src/envelope.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker({ wakeEnabled: false });
let lead: FakeClaude;
let claudeClient: Client;
let codexClient: Client;

async function connect(host: "claude" | "codex"): Promise<Client> {
  const client = new Client({ name: `asks-${host}`, version: "0" });
  const cwd = join(root, "work", "asks");
  mkdirSync(cwd, { recursive: true });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--host", host], cwd, env: { ...process.env } as Record<string, string> }));
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}, threadId?: string) => {
  const res = (await client.callTool({ name, arguments: args, ...(threadId && { _meta: { threadId } }) })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
};

const latestAsk = (): string | undefined => (broker.store.db.prepare("SELECT id FROM asks ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string } | undefined)?.id;
const nextAsk = async (previous: string | undefined): Promise<string> => until(() => (latestAsk() !== previous ? latestAsk() : undefined));

before(async () => {
  await broker.start();
  lead = await fakeClaude("lead", process.pid, "idle");
  await broker.hook({ threadId: "thread-asks", event: "SessionStart", cwd: "/work/asks" });
  claudeClient = await connect("claude");
  codexClient = await connect("codex");
});

after(async () => {
  await claudeClient.close();
  await codexClient.close();
  await closeServer(lead.server);
  await broker.stop();
});

test("both hosts offer ask and answer with every parameter described, and ask never offers a way to name a model or a classifier", async () => {
  for (const client of [claudeClient, codexClient]) {
    const tools = (await client.listTools()).tools;
    for (const name of ["ask", "answer"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, name);
      assert.ok(tool.description!.length < 800, name);
      for (const [param, schema] of Object.entries((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>)) assert.ok(schema.description, `${name}.${param}`);
    }
    const ask = tools.find((t) => t.name === "ask")!.inputSchema.properties as Record<string, { enum?: string[]; maxItems?: number }>;
    assert.deepEqual(Object.keys(ask).sort(), ["pick", "question", "timeout_seconds", "to"]);
    assert.deepEqual(ask.pick!.enum, ["best"]);
    assert.equal(ask.to!.maxItems, 16);
  }
});

test("a Claude session asks a Codex session, which answers with the answer tool, and the answer comes back inside the peer-text frame", async () => {
  const before = latestAsk();
  const pending = call(claudeClient, "ask", { to: ["codex-asks"], question: "which port does the gateway use?", timeout_seconds: 20 });
  const id = await nextAsk(before);
  const question = await call(codexClient, "read_inbox", {}, "thread-asks");
  assert.match(question.text, new RegExp(`\\[agentsocks ask ${id}\\] @lead asks you`));
  assert.match(question.text, /which port does the gateway use\?/);
  const answered = await call(codexClient, "answer", { ask_id: id, answer: "8787, on 127.0.0.1" }, "thread-asks");
  assert.equal(answered.isError, false, answered.text);
  assert.match(answered.text, new RegExp(`Answer sent for ${id}\\. You were the last one the asker was waiting for\\.`));
  const result = await pending;
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /<peer-text-[0-9a-f]{6}>/);
  assert.match(result.text, new RegExp(`Ask ${id}: 1 session asked, 1 answered\\.`));
  assert.match(result.text, /@codex-asks \(codex\) answered after \d+ s:\n8787, on 127\.0\.0\.1/);
  assert.match(result.text, /not typed by your user/);
});

test("a Codex session asks a Claude session, which answers with the answer tool, and a second ask times out cleanly", async () => {
  const before = latestAsk();
  const pending = call(codexClient, "ask", { to: ["lead"], question: "is the release branch frozen?", timeout_seconds: 20 }, "thread-asks");
  const id = await nextAsk(before);
  const frame = await until(() => lead.frames.map((f) => parseEnvelope(messageContent(f))!.body).find((b) => b.includes(`[agentsocks ask ${id}]`)));
  assert.match(frame, /is the release branch frozen\?/);
  const answered = await call(claudeClient, "answer", { ask_id: id, answer: "yes until Monday" });
  assert.equal(answered.isError, false, answered.text);
  assert.match((await pending).text, /@lead \(claude\) answered after \d+ s:\nyes until Monday/);
  const quiet = await call(codexClient, "ask", { to: ["lead"], question: "anyone home?", timeout_seconds: 1 }, "thread-asks");
  assert.equal(quiet.isError, false, quiet.text);
  assert.match(quiet.text, /1 session asked, 0 answered\./);
  assert.match(quiet.text, /No answer from @lead \(claude\) within 1 s/);
});

test("errors reach the model framed: an unknown session, and an answer from a session that was not asked", async () => {
  const unknown = await call(codexClient, "ask", { to: ["nobody-home"], question: "hello?", timeout_seconds: 1 }, "thread-asks");
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Not asked: no running session named "nobody-home"/);
  assert.match(unknown.text, /<peer-text-[0-9a-f]{6}>/);
  const wrong = await call(codexClient, "answer", { ask_id: latestAsk()!, answer: "me?" }, "thread-asks");
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /Not answered: you were not asked in A-[0-9a-f]{6}, so you cannot answer it/);
});
