import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { root } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { hermesAgent } from "../src/agents/hermes.ts";
import { encodeAddress } from "../src/envelope.ts";
import type { InstallContext } from "../src/agents/types.ts";

const hasPyYaml = spawnSync("python3", ["-I", "-c", "import yaml"], { stdio: "ignore" }).status === 0;
const stripsWithoutFlags = spawnSync(process.execPath, ["-e", "process.exit(process.features.typescript ? 0 : 1)"], { env: { PATH: process.env.PATH ?? "" } }).status === 0;
const cli = fileURLToPath(new URL(stripsWithoutFlags ? "../src/cli.ts" : "../dist/cli.js", import.meta.url));
const fixture = (name: string): Record<string, any> => ({ ...JSON.parse(readFileSync(new URL(`./fixtures/agents/hermes/${name}.json`, import.meta.url), "utf8")), cwd: join(root, "work", "api-worker") });

interface HookEntry {
  matcher?: string;
  command: string;
  argv: string[];
  timeout?: number;
}

interface Loaded {
  mcp: { command: string; args: string[]; env: Record<string, string> };
  hooks: Record<string, HookEntry[]>;
}

const LOAD = `
import sys, json, shlex, yaml
doc = yaml.safe_load(open(sys.argv[1]).read())
hooks = {}
for event, entries in (doc.get("hooks") or {}).items():
    hooks[event] = [dict(e, argv=shlex.split(e["command"])) for e in entries]
print(json.dumps({"mcp": doc["mcp_servers"]["agentsocks"], "hooks": hooks}))
`;

const broker = new Broker({ ttyScan: () => [], agents: [hermesAgent], wakeEnabled: false });
let home = "";
let loaded: Loaded;
let client: Client | undefined;
const SESSION = "20261013_101500_ab12cd";
const THREAD = `hermes_${SESSION}`;

function execute(argv: string[], input: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, cwd, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function hookRun(event: string, payload: Record<string, any>, env: NodeJS.ProcessEnv = process.env): Promise<unknown[]> {
  const toolName = payload.tool_name as string | null;
  const out: unknown[] = [];
  for (const entry of loaded.hooks[event] ?? []) {
    if (entry.matcher && !(toolName && new RegExp(entry.matcher).test(toolName))) continue;
    const r = await execute(entry.argv, JSON.stringify(payload), env, payload.cwd, (entry.timeout ?? 60) * 1000);
    assert.equal(r.status, 0, `${entry.command}: ${r.stderr}`);
    if (r.stdout.trim()) out.push(JSON.parse(r.stdout));
  }
  return out;
}

async function afterPreToolCall(payload: Record<string, any>, env?: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  let args: Record<string, unknown> = { ...payload.tool_input };
  for (const result of await hookRun("pre_tool_call", payload, env)) {
    const r = result as { action?: string; args?: Record<string, unknown> };
    if (r.action === "modify" && r.args) args = { ...args, ...r.args };
  }
  return args;
}

async function toolCall(name: string, args: Record<string, unknown>) {
  const res = (await client!.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
}

before(async () => {
  if (!hasPyYaml) return;
  await broker.start();
  home = process.env.HOME!;
  const ctx: InstallContext = { dryRun: false, home, log: [], hasBinary: () => false, command: (...a) => [process.execPath, cli, ...a], backup: () => {} };
  hermesAgent.installer.install(ctx);
  const r = spawnSync("python3", ["-I", "-c", LOAD, join(home, ".hermes", "config.yaml")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  loaded = JSON.parse(r.stdout);
  const baseline = { PATH: process.env.PATH ?? "", HOME: home };
  mkdirSync(join(root, "work", "api-worker"), { recursive: true });
  client = new Client({ name: "hermes-emulation", version: "0" });
  await client.connect(new StdioClientTransport({ command: loaded.mcp.command, args: loaded.mcp.args, env: { ...baseline, ...loaded.mcp.env }, cwd: join(root, "work", "api-worker") }));
});

after(async () => {
  await client?.close();
  if (hasPyYaml) await broker.stop();
});

test("config.yaml as a real YAML reader and shlex see it: the hooks are runnable commands (shell=False) and the MCP server entry carries the state locations", { skip: !hasPyYaml }, () => {
  assert.deepEqual(Object.keys(loaded.hooks).sort(), ["on_session_end", "on_session_finalize", "pre_llm_call", "pre_tool_call", "pre_verify"]);
  for (const entries of Object.values(loaded.hooks)) for (const e of entries) assert.equal(e.argv[0], "env", e.command);
  assert.equal(loaded.mcp.command, process.execPath);
  assert.deepEqual(loaded.mcp.args, [cli, "mcp", "--agent", "hermes"]);
  assert.equal(loaded.mcp.env.AGENTSOCKS_STATE_DIR, process.env.AGENTSOCKS_STATE_DIR);
  assert.equal(loaded.mcp.env.AGENTSOCKS_RUNTIME_DIR, process.env.AGENTSOCKS_RUNTIME_DIR);
  assert.equal(loaded.mcp.env.NODE_NO_WARNINGS, "1");
});

test("the pre_tool_call matcher selects agentsocks tools under both documented naming forms and no others", { skip: !hasPyYaml }, () => {
  const matcher = new RegExp(loaded.hooks.pre_tool_call![0]!.matcher!);
  for (const name of ["mcp_agentsocks_read_inbox", "mcp__agentsocks__read_inbox", "mcp_agentsocks_wait_for_message"]) assert.ok(matcher.test(name), name);
  for (const name of ["mcp_github_create_issue", "terminal", "read_file", "mcp_notagentsocks_read_inbox"]) assert.ok(!matcher.test(name), name);
});

test("a whole session as Hermes would drive it: first turn, stamped tool calls reach the broker as this session, a message is announced and read, and the kill switch leaves the tools refusing", { skip: !hasPyYaml }, async () => {
  const first = fixture("hook-pre-llm-call-first");
  const intro = await hookRun("pre_llm_call", first);
  assert.match((intro[0] as { context: string }).context, /^\[agentsocks\] Your user installed agentsocks/);

  const call = fixture("hook-pre-tool-call-read-inbox");
  const withStamp = await afterPreToolCall(call);
  assert.match(String(withStamp._session), /^20261013_101500_ab12cd\.[0-9a-f]{32}$/);
  const peers = await toolCall("list_peers", { ...withStamp });
  assert.equal(peers.isError, false, peers.text);
  assert.match(peers.text, /hermes-api-worker \[[0-9a-f]{6}\] hermes, .*\(you\)/);
  assert.equal(broker.store.getThread(THREAD)!.cwd, join(root, "work", "api-worker"));

  broker.store.enqueue({ id: "e2e-1", msg_id: "e2e-1", to_thread: THREAD, kind: "message", from_addr: encodeAddress(`${root}/cc-socks/ann.sock`), from_name: "ann", from_kind: "claude", from_session: null, from_mode: null, body: "run the migration dry run", received_at: Date.now(), route: "now", decision: null });
  const next = await hookRun("pre_llm_call", fixture("hook-pre-llm-call-next"));
  assert.equal((next[0] as { context: string }).context, "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox before your next step.");
  const read = await toolCall("read_inbox", { ...(await afterPreToolCall(call)) });
  assert.match(read.text, /run the migration dry run/);

  const off = { ...process.env, AGENTSOCKS_OFF: "1" };
  assert.deepEqual(await hookRun("pre_tool_call", call, off), []);
  const refused = await toolCall("read_inbox", { ...call.tool_input });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /could not tell which Hermes session is calling/);
});
