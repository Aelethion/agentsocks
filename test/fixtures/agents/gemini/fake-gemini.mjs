#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settingsFile = join(process.env.GEMINI_CLI_HOME || homedir(), ".gemini", "settings.json");
const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
const servers = settings.mcpServers ?? {};

if (argv[0] === "mcp" && argv[1] === "list") {
  const names = Object.keys(servers);
  console.log(names.length === 0 ? "No MCP servers configured." : names.map((n) => `✓ ${n}: ${servers[n].command} ${(servers[n].args ?? []).join(" ")} (stdio) - Connected`).join("\n"));
  process.exit(0);
}

const prompt = flagValue("-p");
if (prompt === undefined) {
  console.error("fake gemini only implements -p and mcp list");
  process.exit(42);
}

const sessionId = randomUUID();
const cwd = process.cwd();
const base = (event) => ({ session_id: sessionId, transcript_path: join(process.env.GEMINI_CLI_HOME || homedir(), ".gemini", "tmp", "fake", "chats", `session-${sessionId}.json`), cwd, hook_event_name: event, timestamp: new Date().toISOString() });

function runCommand(command, input) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env, GEMINI_PROJECT_DIR: cwd, GEMINI_CWD: cwd, GEMINI_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: cwd },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseOutput({ code, stdout, stderr }) {
  const text = stdout.trim() || stderr.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return code === 0 ? { decision: "allow", systemMessage: text } : code === 1 ? { decision: "allow", systemMessage: `Warning: ${text}` } : { decision: "deny", reason: text };
}

const matches = (matcher, subject, isTool) => {
  if (!matcher || matcher.trim() === "" || matcher.trim() === "*") return true;
  if (subject === undefined) return true;
  if (!isTool) return matcher === subject;
  try {
    return new RegExp(matcher).test(subject);
  } catch {
    return matcher === subject;
  }
};

async function fire(event, fields, { toolName, trigger } = {}) {
  const input = { ...base(event), ...fields };
  const outputs = [];
  for (const def of process.env.FAKE_GEMINI_NO_HOOKS ? [] : (settings.hooks?.[event] ?? [])) {
    if (!matches(def.matcher, toolName ?? trigger, toolName !== undefined)) continue;
    for (const hook of def.hooks ?? []) {
      if (hook.type !== "command" || !hook.command) continue;
      outputs.push(parseOutput(await runCommand(hook.command, input)));
    }
  }
  const merged = { deny: undefined, reason: undefined, contexts: [], toolInput: undefined };
  for (const o of outputs) {
    if (o.decision === "deny" || o.decision === "block") {
      merged.deny = true;
      merged.reason = [merged.reason, o.reason].filter(Boolean).join("\n");
    }
    const specific = o.hookSpecificOutput ?? {};
    if (typeof specific.additionalContext === "string") merged.contexts.push(specific.additionalContext.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    if (specific.tool_input && typeof specific.tool_input === "object") merged.toolInput = specific.tool_input;
  }
  return merged;
}

const server = servers.agentsocks;
let client;
async function connect() {
  if (client || !server) return;
  client = new Client({ name: "fake-gemini", version: "0" });
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args ?? [], env: { ...process.env, ...(server.env ?? {}) }, cwd }));
}

async function callTool(name, args) {
  await connect();
  const toolName = `mcp_agentsocks_${name}`;
  const mcpContext = { server_name: "agentsocks", tool_name: name, command: server.command, args: server.args };
  const before = await fire("BeforeTool", { tool_name: toolName, tool_input: args, mcp_context: mcpContext }, { toolName });
  if (before.deny) return `Tool execution blocked: ${before.reason}`;
  const finalArgs = before.toolInput ?? args;
  const res = await client.callTool({ name, arguments: finalArgs });
  let text = res.content.map((c) => c.text).join("\n");
  const after = await fire("AfterTool", { tool_name: toolName, tool_input: finalArgs, tool_response: { llmContent: text, returnDisplay: "" }, mcp_context: mcpContext }, { toolName });
  if (after.contexts.length > 0) text += `\n\n<hook_context>${after.contexts.join("\n")}</hook_context>`;
  return text;
}

const hookContext = (text) => (text.match(/<hook_context>([\s\S]*?)<\/hook_context>/g) ?? []).map((m) => m.replace(/<\/?hook_context>/g, ""));

async function model(request) {
  await sleep(Number(process.env.FAKE_GEMINI_LATENCY_MS ?? 2500));
  if (request.includes("PONG")) return "PONG";
  if (request.includes("wait_for_message")) {
    const text = await callTool("wait_for_message", { timeout_seconds: 100 });
    return /MARK-\d+/.exec(text)?.[0] ?? "NOMESSAGE";
  }
  if (request.includes("RESULT:")) return `RESULT: ${(await callTool("list_peers", {})).replace(/\s+/g, " ")}`;
  if (request.includes("list_peers")) {
    let notice = "none";
    let last = "";
    for (let i = 0; i < 3; i++) {
      last = await callTool("list_peers", {});
      const seen = hookContext(last).find((c) => c.includes("agentsocks"));
      if (seen && notice === "none") notice = seen;
      await sleep(Number(process.env.FAKE_GEMINI_LATENCY_MS ?? 2500) / 2.5);
    }
    const you = last.split("\n").find((l) => l.trimEnd().endsWith("(you)")) ?? "none";
    return `NOTICE: ${notice}\nYOU: ${you}\nDONE`;
  }
  if (request.includes("read_inbox")) {
    await callTool("read_inbox", {});
    return answer.replace(/DONE$/, "INBOX READ\nDONE");
  }
  return "I do not know what to do";
}

const start = await fire("SessionStart", { source: "startup" }, { trigger: "startup" });
let request = [...start.contexts, prompt].join("\n\n");
let answer = "";
let active = false;
for (let turn = 0; turn < 5; turn++) {
  answer = await model(request);
  const after = await fire("AfterAgent", { prompt: request, prompt_response: answer, stop_hook_active: active });
  if (!after.deny) break;
  request = after.reason ?? "";
  active = true;
}
await fire("SessionEnd", { reason: "exit" }, { trigger: "exit" });
await client?.close();
console.log(JSON.stringify({ response: answer, stats: {} }));
process.exit(0);
