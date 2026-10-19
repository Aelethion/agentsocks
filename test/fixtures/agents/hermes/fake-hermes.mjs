#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const home = process.env.HERMES_HOME;
const style = process.env.FAKE_HERMES_TOOL_STYLE === "double" ? (t) => `mcp__agentsocks__${t}` : (t) => `mcp_agentsocks_${t}`;

const take = (flag) => {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  return args.splice(at, 2)[1];
};

if (args[0] === "--version") {
  console.log("Hermes Agent v0.21.5 (fake)");
  process.exit(0);
}

const LOAD = `
import sys, json, shlex, yaml
doc = yaml.safe_load(open(sys.argv[1]).read()) or {}
hooks = {}
for event, entries in (doc.get("hooks") or {}).items():
    hooks[event] = [dict(e, argv=shlex.split(e["command"])) for e in entries]
print(json.dumps({"mcp": (doc.get("mcp_servers") or {}).get("agentsocks"), "hooks": hooks}))
`;

function config() {
  const r = spawnSync("python3", ["-I", "-c", LOAD, join(home, "config.yaml")], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`fake hermes: cannot read config.yaml: ${r.stderr}`);
    process.exit(2);
  }
  const cfg = JSON.parse(r.stdout);
  if (process.env.HERMES_ACCEPT_HOOKS !== "1") cfg.hooks = {};
  return cfg;
}

function execute(argv, input, cwd) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { env: process.env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", () => resolve(stdout));
    child.stdin.end(input);
  });
}

async function runHooks(cfg, event, payload) {
  const outputs = [];
  for (const entry of cfg.hooks[event] ?? []) {
    if (entry.matcher && !(payload.tool_name && new RegExp(entry.matcher).test(payload.tool_name))) continue;
    const out = (await execute(entry.argv, JSON.stringify(payload), payload.cwd)).trim();
    if (out) outputs.push(JSON.parse(out));
  }
  return outputs;
}

const cwd = process.cwd();
const payload = (event, session, extra = {}, tool = null, input = null) => ({ hook_event_name: event, tool_name: tool, tool_input: input, session_id: session, cwd, profile: "default", extra });

if (args[0] === "hooks" && args[1] === "list") {
  const cfg = config();
  console.log(`${Object.keys(cfg.hooks).length} events configured`);
  process.exit(0);
}

if (args[0] === "hooks" && args[1] === "test") {
  const tool = take("--for-tool");
  const file = take("--payload-file");
  const cfg = config();
  const body = file ? JSON.parse(readFileSync(file, "utf8")) : payload(args[2], "synthetic", {}, tool, {});
  for (const out of await runHooks(cfg, args[2], body)) console.log(`parsed: ${JSON.stringify(out)}`);
  process.exit(0);
}

const resume = take("--resume");
const usageFile = take("--usage-file");
const prompt = take("-z");
if (prompt === undefined) {
  console.error("fake hermes: only -z is supported");
  process.exit(2);
}
const session = resume ?? `fake_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
const cfg = config();
let client;
if (cfg.mcp) {
  client = new Client({ name: "fake-hermes", version: "0" });
  await client.connect(new StdioClientTransport({ command: cfg.mcp.command, args: cfg.mcp.args, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...cfg.mcp.env }, cwd }));
}

async function callTool(name, input) {
  let merged = { ...input };
  for (const result of await runHooks(cfg, "pre_tool_call", payload("pre_tool_call", session, {}, style(name), input))) if (result.action === "modify" && process.env.FAKE_HERMES_IGNORE_MODIFY !== "1") merged = { ...merged, ...result.args };
  const res = await client.callTool({ name, arguments: merged });
  return res.content.map((c) => c.text).join("\n");
}

const context = [];
for (const out of await runHooks(cfg, "pre_llm_call", payload("pre_llm_call", session, { user_message: prompt, is_first_turn: !resume }))) if (out.context) context.push(out.context);

let answer;
const marker = (text) => /LIVEMARK\w+/.exec(text)?.[0] ?? "NONE";
if (/wait_for_message/.test(prompt)) {
  await callTool("list_peers", {});
  answer = `GOT ${marker(await callTool("wait_for_message", { timeout_seconds: 150 }))}`;
} else if (/NOTICE-SEEN/.test(prompt)) {
  const seen = context.some((c) => c.includes("agentsocks:")) ? "NOTICE-SEEN" : "NO-NOTICE";
  answer = `${seen} ${marker(await callTool("read_inbox", {}))}`;
} else if (/list_peers tool once/.test(prompt)) {
  answer = await callTool("list_peers", {});
} else {
  answer = "READY";
}

await runHooks(cfg, "on_session_end", payload("on_session_end", session, { completed: true, interrupted: false }));
await runHooks(cfg, "on_session_finalize", payload("on_session_finalize", session, { platform: "cli" }));
await client?.close();
if (usageFile) writeFileSync(usageFile, JSON.stringify({ session_id: session, completed: true }));
console.log(answer);
