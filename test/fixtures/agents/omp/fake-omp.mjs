import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("omp/18.10.3");
  process.exit(0);
}
if (args[args.indexOf("--mode") + 1] !== "rpc") {
  console.error("fake omp: only --mode rpc is supported");
  process.exit(2);
}

const { EXPLORE, FakeOmp } = await import(new URL("../../../omphost.ts", import.meta.url).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const copy = mkdtempSync(join(tmpdir(), "fake-omp-"));
const { rmSync } = await import("node:fs");
process.on("exit", () => rmSync(copy, { recursive: true, force: true }));
writeFileSync(join(copy, "package.json"), '{"type":"module"}\n');
copyFileSync(join(process.env.PI_CODING_AGENT_DIR, "extensions", "agentsocks.ts"), join(copy, "agentsocks.mjs"));
const file = join(copy, "agentsocks.mjs");
const sessionId = `0199c1a2-7b3c-7d4e-8f50-${String(process.pid).padStart(12, "0")}`;
const host = await FakeOmp.load({ file, sessionId, cwd: process.cwd() });

const WAKE_PREFIX = "📨 agentsocks:";
let reported = 0;
const flushErrors = () => {
  for (const error of host.errors.slice(reported)) frame({ type: "extension_error", extensionPath: file, event: "handler", error });
  reported = host.errors.length;
};
const emit = async (type, event) => {
  const results = await host.emit(type, event);
  flushErrors();
  return results;
};

const asides = [];
let turning = false;
host.onSend = (sent) => {
  frame({ type: "message_start", message: { role: "custom", customType: sent.message.customType, content: sent.message.content } });
  frame({ type: "message_end", message: { role: "custom", customType: sent.message.customType, content: sent.message.content } });
  if (turning || (sent.options.deliverAs === "aside" && !sent.idle)) asides.push(sent.message.content);
  else void turn(sent.message.content, { woke: true });
};

let tool = 0;
async function callTool(name, params = {}) {
  const text = await host.callTool(`agentsocks_${name}`, params).catch((err) => `error: ${err.message}`);
  frame({ type: "tool_execution_start", toolName: `agentsocks_${name}`, toolCallId: `call-${++tool}` });
  frame({ type: "tool_execution_end", toolName: `agentsocks_${name}`, result: { content: [{ type: "text", text }] }, isError: false });
  frame({ type: "message_end", message: { role: "toolResult", toolName: `agentsocks_${name}`, content: [{ type: "text", text }] } });
  return text;
}

async function shell(command, notes) {
  frame({ type: "tool_execution_start", toolName: "bash", toolCallId: `call-${++tool}` });
  const output = `${command}\n`;
  const results = await emit("tool_result", { toolName: "bash", content: [{ type: "text", text: output }], isError: false });
  for (const result of results) if (result?.additionalContext) notes.push(result.additionalContext);
  frame({ type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: output }] }, isError: false });
  frame({ type: "message_end", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: output }] } });
}

async function turn(text, { woke = false, id } = {}) {
  turning = true;
  host.idle = false;
  frame({ type: "agent_start" });
  const notes = [];
  if (!woke) {
    for (const result of await emit("before_agent_start", { prompt: text, systemPrompt: [] })) if (result?.message) notes.push(result.message.content);
  }
  let answer;
  if (text.includes("Step 1")) {
    await callTool("list_peers");
    await sleep(12000);
    await shell("sleep 20", notes);
    await shell("echo step-three-done", notes);
    const inbox = await callTool("read_inbox");
    const marker = /kumquat\d+/.exec(inbox)?.[0] ?? "NO-MARKER";
    const notice = notes.flatMap((n) => n.split("\n")).find((line) => line.startsWith(WAKE_PREFIX)) ?? "NO-NOTICE";
    answer = `marker ${marker}. notice: ${notice}`;
  } else if (text.includes("task tool")) {
    frame({ type: "tool_execution_start", toolName: "task", toolCallId: `call-${++tool}` });
    const sub = await FakeOmp.load({ file, sessionId: `${sessionId}-sub`, identity: EXPLORE });
    await sub.emit("session_start");
    await sub.emit("before_agent_start", { prompt: "echo from-the-subagent", systemPrompt: [] });
    await sub.emit("tool_result", { toolName: "bash", content: [], isError: false });
    await sub.settle();
    await sub.emit("session_shutdown");
    flushErrors();
    frame({ type: "tool_execution_end", toolName: "task", result: { content: [{ type: "text", text: "from-the-subagent" }] }, isError: false });
    answer = "the subagent printed from-the-subagent";
  } else {
    await callTool("read_inbox");
    answer = "read it";
  }
  frame({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
  await emit("agent_end", { messages: [] }).finally(() => (host.idle = true));
  frame({ type: "agent_end", messages: [], yielded: true, isTerminal: true });
  turning = false;
  if (id) frame({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
  if (asides.length > 0) return turn(asides.splice(0).join("\n"), { woke: true });
  frame({ type: "session_settled" });
}

frame({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
await emit("session_start");

process.on("SIGTERM", () => process.exit(0));
const lines = createInterface({ input: process.stdin });
const running = new Set();
for await (const line of lines) {
  if (!line.trim()) continue;
  const command = JSON.parse(line);
  if (command.type === "prompt") {
    frame({ id: command.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
    const work = turn(command.message, { id: command.id }).catch((err) => frame({ type: "extension_error", extensionPath: file, event: "turn", error: String(err) }));
    running.add(work);
    work.finally(() => running.delete(work));
  } else {
    frame({ id: command.id, type: "response", command: command.type, success: false, error: "fake omp does not implement this command" });
  }
}
await Promise.all(running);
await host.shutdown();
flushErrors();
process.exit(0);
