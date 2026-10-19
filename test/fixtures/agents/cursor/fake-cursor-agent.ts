import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const faults = new Set((process.env.FAKE_CURSOR ?? "").split(",").filter(Boolean));

const BOOLEAN_FLAGS = new Set(["-p", "--print", "--force", "-f", "--yolo", "--trust", "--approve-mcps", "--stream-partial-output"]);
const VALUE_FLAGS = new Set(["--output-format", "--workspace", "--model"]);

const argv = process.argv.slice(2);
if (argv[0] === "--help" || argv[0] === "-h") {
  console.log("Cursor Agent (fake, for agentsocks tests)");
  process.exit(0);
}
if (argv[0] === "--version") {
  console.log("0.0.0-fake");
  process.exit(0);
}
const flags = new Map<string, string>();
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (BOOLEAN_FLAGS.has(a)) flags.set(a, "");
  else if (VALUE_FLAGS.has(a)) flags.set(a, argv[++i] ?? "");
  else if (a.startsWith("-")) {
    console.error(`error: unknown option '${a}'`);
    process.exit(1);
  } else words.push(a);
}
if (!flags.has("-p") && !flags.has("--print")) {
  console.error("the fake only does print mode");
  process.exit(1);
}
if (flags.get("--output-format") !== "stream-json") {
  console.error("the fake only does --output-format stream-json");
  process.exit(1);
}
if (process.env.FAKE_CURSOR_AUTH === "0") {
  console.error("Not authenticated. Run `agent login` or set CURSOR_API_KEY.");
  process.exit(1);
}

const workspace = flags.get("--workspace") || process.cwd();
const prompt = words.join(" ");
const session = randomUUID();
const out = (event: Json): void => void process.stdout.write(`${JSON.stringify({ ...event, session_id: session })}\n`);

interface HookDef {
  command: string;
  matcher?: string;
  timeout?: number;
  loop_limit?: number;
  cwd: string;
}

function loadHooks(): Record<string, HookDef[]> {
  const found: Record<string, HookDef[]> = {};
  const sources: [string, string][] = [[join(homedir(), ".cursor", "hooks.json"), join(homedir(), ".cursor")]];
  if (flags.has("--trust")) sources.push([join(workspace, ".cursor", "hooks.json"), workspace]);
  for (const [file, cwd] of sources) {
    if (!existsSync(file)) continue;
    const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(doc) || doc.version !== 1 || !isRecord(doc.hooks)) throw new Error(`${file} is not a hooks.json Cursor accepts`);
    for (const [event, list] of Object.entries(doc.hooks)) {
      for (const h of Array.isArray(list) ? list : []) {
        if (isRecord(h) && typeof h.command === "string") (found[event] ??= []).push({ ...(h as Omit<HookDef, "cwd">), cwd });
      }
    }
  }
  return found;
}

const hooks = faults.has("no-hooks") ? {} : loadHooks();
const baseInput = (): Json => ({
  conversation_id: session,
  generation_id: randomUUID(),
  model: "fake",
  cursor_version: "0.0.0-fake",
  workspace_roots: [workspace],
  user_email: null,
  transcript_path: null,
});

interface Merged {
  contexts: string[];
  followup?: string;
  limit: number;
  denied: boolean;
  decided: boolean;
  updatedInput?: Json;
}

function runHooks(event: string, extra: Json, matchValue = ""): Merged {
  const merged: Merged = { contexts: [], limit: 5, denied: false, decided: false };
  for (const h of hooks[event] ?? []) {
    if (h.matcher && !new RegExp(h.matcher).test(matchValue)) continue;
    const env = faults.has("scrub-env") ? { PATH: process.env.PATH ?? "", HOME: homedir() } : process.env;
    const r = spawnSync("sh", ["-c", h.command], { input: JSON.stringify({ ...baseInput(), hook_event_name: event, ...extra }), cwd: h.cwd, env, encoding: "utf8", timeout: (h.timeout ?? 30) * 1000 });
    if (r.status === 2) merged.denied = true;
    if (event === "stop" && typeof h.loop_limit === "number") merged.limit = Math.min(merged.limit, h.loop_limit);
    let reply: unknown;
    try {
      reply = JSON.parse(r.stdout);
    } catch {
      continue;
    }
    if (!isRecord(reply)) continue;
    if (reply.permission === "deny") merged.denied = true;
    if (typeof reply.permission === "string") merged.decided = true;
    if (typeof reply.additional_context === "string" && !faults.has("no-context")) merged.contexts.push(reply.additional_context);
    if (typeof reply.followup_message === "string" && reply.followup_message && !faults.has("blind-stop")) merged.followup = reply.followup_message;
    if (isRecord(reply.updated_input) && !faults.has("ignore-updated-input")) merged.updatedInput = reply.updated_input;
  }
  return merged;
}

const spoken: string[] = [];
const say = (text: string): void => {
  spoken.push(text);
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
};

let mcp: Client | undefined;
async function mcpClient(): Promise<Client> {
  if (mcp) return mcp;
  if (!flags.has("--approve-mcps")) throw new Error("MCP server agentsocks is not approved");
  const file = join(homedir(), ".cursor", "mcp.json");
  const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
  const server = isRecord(doc) && isRecord(doc.mcpServers) ? doc.mcpServers.agentsocks : undefined;
  if (!isRecord(server) || server.type !== "stdio" || typeof server.command !== "string") throw new Error("no stdio server named agentsocks in mcp.json");
  const env = { ...(process.env as Record<string, string>), ...(isRecord(server.env) ? (server.env as Record<string, string>) : {}) };
  mcp = new Client({ name: "fake-cursor", version: "0" });
  await mcp.connect(new StdioClientTransport({ command: server.command, args: Array.isArray(server.args) ? (server.args as string[]) : [], env, cwd: workspace }));
  return mcp;
}

const contextsAfter: string[] = [];
const NAP = process.env.FAKE_CURSOR_SLEEP ?? "6";
const delay = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

function shell(command: string): void {
  const callId = randomUUID();
  out({ type: "tool_call", subtype: "started", call_id: callId, tool_call: { function: { name: "Shell", arguments: JSON.stringify({ command }) } } });
  runHooks("preToolUse", { tool_name: "Shell", tool_input: { command }, tool_use_id: callId, cwd: workspace }, "Shell");
  spawnSync("sh", ["-c", command], { cwd: workspace });
  const post = runHooks("postToolUse", { tool_name: "Shell", tool_input: { command }, tool_output: "{}", tool_use_id: callId, cwd: workspace, duration: 1 }, "Shell");
  contextsAfter.push(...post.contexts);
  out({ type: "tool_call", subtype: "completed", call_id: callId, tool_call: { function: { name: "Shell", arguments: JSON.stringify({ command }) } } });
}

function denyRules(): RegExp[] {
  const file = join(workspace, ".cursor", "cli.json");
  if (!existsSync(file)) return [];
  const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
  const deny = isRecord(doc) && isRecord(doc.permissions) && Array.isArray(doc.permissions.deny) ? doc.permissions.deny : [];
  return deny.flatMap((rule) => {
    const m = typeof rule === "string" ? /^Mcp\((.*):(.*)\)$/.exec(rule) : null;
    const glob = (g: string) => g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return m ? [new RegExp(`^${glob(m[1]!)}:${glob(m[2]!)}$`)] : [];
  });
}

interface Inbox {
  text: string;
  denied: boolean;
}

async function readInbox(): Promise<Inbox> {
  const callId = randomUUID();
  const asked: Json = {};
  out({ type: "tool_call", subtype: "started", call_id: callId, tool_call: { function: { name: "read_inbox", arguments: "{}" } } });
  const pre = runHooks("preToolUse", { tool_name: "MCP:read_inbox", tool_input: asked, tool_use_id: callId, cwd: workspace }, "MCP:read_inbox");
  const ruled = denyRules().some((rule) => rule.test("agentsocks:read_inbox")) && !(faults.has("hook-overrides-deny") && pre.decided);
  const denied = pre.denied || ruled;
  let text = "denied";
  if (denied) {
    runHooks("postToolUseFailure", { tool_name: "MCP:read_inbox", tool_input: asked, tool_use_id: callId, cwd: workspace, error_message: "denied", failure_type: "permission_denied", duration: 1, is_interrupt: false }, "MCP:read_inbox");
  } else {
    const input = pre.updatedInput ?? asked;
    const res = (await (await mcpClient()).callTool({ name: "read_inbox", arguments: input })) as { content: { text: string }[]; isError?: boolean };
    text = res.content.map((c) => c.text).join("\n");
    runHooks("afterMCPExecution", { tool_name: "read_inbox", tool_input: JSON.stringify(input), mcp_server_name: "agentsocks", result_json: JSON.stringify(res), duration: 1 });
    const post = runHooks("postToolUse", { tool_name: "MCP:read_inbox", tool_input: input, tool_output: JSON.stringify(res), tool_use_id: callId, cwd: workspace, duration: 1 }, "MCP:read_inbox");
    contextsAfter.push(...post.contexts);
  }
  out({ type: "tool_call", subtype: "completed", call_id: callId, tool_call: { function: { name: "read_inbox", arguments: "{}" } } });
  return { text, denied };
}

const markerIn = (text: string): string => /MARK[A-Za-z0-9]+/.exec(text)?.[0] ?? "none";

async function main(): Promise<void> {
  out({ type: "system", subtype: "init", apiKeySource: "env", cwd: workspace, model: "fake", permissionMode: "default" });
  out({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } });
  const start = runHooks("sessionStart", { session_id: session, is_background_agent: false, composer_mode: "agent" });
  contextsAfter.push(...start.contexts);

  if (prompt.includes("AGENTSOCKS-LIVE-NOTICE")) {
    contextsAfter.length = 0;
    shell(`sleep ${NAP}`);
    const notice = contextsAfter.find((c) => c.includes("agentsocks:"));
    say(`MARKER=${markerIn((await readInbox()).text)} NOTICE=${notice ?? "none"}`);
  } else if (prompt.includes("AGENTSOCKS-LIVE-NUDGE")) {
    shell("true");
    await delay(Number(NAP));
    say("READY");
  } else if (prompt.includes("AGENTSOCKS-LIVE-DENY")) {
    shell(`sleep ${NAP}`);
    const inbox = await readInbox();
    say(inbox.denied ? "DENIED" : `MARKER=${markerIn(inbox.text)}`);
  } else if (prompt.includes("AGENTSOCKS-LIVE-OFF")) {
    say((await readInbox()).text);
  } else say("I do not know this prompt");

  for (let loop = 0; ; loop++) {
    const stop = runHooks("stop", { status: "completed", loop_count: loop }, "Stop");
    if (!stop.followup || loop >= stop.limit) break;
    out({ type: "user", message: { role: "user", content: [{ type: "text", text: stop.followup }] } });
    say(`MARKER=${markerIn((await readInbox()).text)}`);
  }
  runHooks("sessionEnd", { session_id: session, reason: "completed", duration_ms: 1, is_background_agent: false, final_status: "completed" });
  out({ type: "result", subtype: "success", is_error: false, duration_ms: 1, duration_api_ms: 1, result: spoken.join("") });
  await mcp?.close();
}

main().then(
  () => process.exit(0),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
