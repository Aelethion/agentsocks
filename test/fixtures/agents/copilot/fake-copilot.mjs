import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const home = process.env.COPILOT_HOME || join(process.env.HOME, ".copilot");
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
const servers = () => readJson(join(home, "mcp-config.json")).mcpServers ?? {};
const option = (name) => argv[argv.indexOf(name) + 1];

function hookFiles() {
  const dir = join(home, "hooks");
  if (process.env.FAKE_COPILOT_NO_HOOKS || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => readJson(join(dir, f)));
}

function shell(command, env, stdin) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { env, cwd: process.cwd() });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

async function runHooks(event, input) {
  const outputs = [];
  for (const file of hookFiles()) {
    for (const hook of file.hooks?.[event] ?? []) {
      if (hook.matcher && input.toolName !== undefined && !new RegExp(`^(?:${hook.matcher})$`).test(input.toolName)) continue;
      const r = await shell(hook.bash, { ...process.env, ...hook.env }, JSON.stringify(input));
      if (r.code !== 0) {
        if (event === "preToolUse") outputs.push({ permissionDecision: "deny" });
        continue;
      }
      try {
        if (r.stdout.trim()) outputs.push(JSON.parse(r.stdout.trim()));
      } catch {}
    }
  }
  return outputs;
}

async function connect(name) {
  const cfg = servers()[name];
  const client = new Client({ name: "fake-copilot", version: "0" });
  await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { PATH: process.env.PATH, ...cfg.env }, cwd: process.cwd() }));
  return client;
}

async function mcpCommand() {
  const [sub, name] = [argv[1], argv[2]];
  if (sub === "list") {
    console.log(JSON.stringify({ servers: Object.entries(servers()).map(([n, c]) => ({ name: n, type: c.type })) }));
  } else if (sub === "get") {
    const client = await connect(name);
    console.log(JSON.stringify({ name, tools: (await client.listTools()).tools.map((t) => `${name}-${t.name}`) }));
    await client.close();
  }
}

async function session(prompt, id) {
  const base = (extra = {}) => ({ sessionId: id, timestamp: Date.now(), cwd: process.cwd(), ...extra });
  await runHooks("sessionStart", base({ source: "new" }));
  let answer = "";
  const seen = [];
  let client;
  const useTool = async (toolName, toolArgs, run) => {
    let args = toolArgs;
    for (const out of await runHooks("preToolUse", base({ toolName, toolArgs: args }))) {
      if (out.permissionDecision === "deny") return "";
      if (out.modifiedArgs && !process.env.FAKE_COPILOT_DROP_MODIFIED_ARGS) args = out.modifiedArgs;
    }
    const { text, failed } = await run(args);
    const extra = [];
    const after = base({ toolName, toolArgs: args, ...(failed ? { error: text } : { toolResult: { resultType: "success", textResultForLlm: text } }) });
    for (const out of await runHooks(failed ? "postToolUseFailure" : "postToolUse", after)) if (out.additionalContext) extra.push(out.additionalContext);
    const seenByModel = [text, ...extra].join("\n");
    seen.push(seenByModel);
    return seenByModel;
  };
  const mcp = (tool) => useTool(`agentsocks-${tool}`, {}, async (args) => {
    client ??= await connect("agentsocks");
    const res = await client.callTool({ name: tool, arguments: args });
    return { text: res.content.map((c) => c.text).join("\n"), failed: res.isError === true };
  });
  const wait = (command, ms) => useTool("bash", { command }, async () => (await new Promise((r) => setTimeout(r, ms)), { text: "" }));

  if (/PONG/.test(prompt)) {
    answer = "PONG";
  } else if (/automated test of the agentsocks integration/.test(prompt)) {
    await mcp("list_peers");
    await wait("sleep 25", Number(process.env.FAKE_COPILOT_SLEEP_MS ?? 6000));
    await wait("echo step-three-done", 0);
    await mcp("read_inbox");
  } else {
    await mcp("list_peers");
    answer = "DONE";
  }
  if (!answer) {
    const marker = /kestrel-[0-9a-f]+/.exec(seen.join("\n"))?.[0] ?? "no-marker";
    const notices = seen.flatMap((t) => t.split("\n").filter((l) => l.includes("agentsocks:")));
    answer = `marker ${marker}. ${notices.length ? notices.join(" / ") : "NO-NOTICE"}`;
  }
  for (let blocks = 0; blocks < 8; blocks++) {
    const stops = await runHooks("agentStop", base({ transcriptPath: "/dev/null", stopReason: "end_turn", stop_hook_active: blocks > 0 }));
    if (!stops.some((o) => o.decision === "block" && o.reason)) break;
    answer += ` ${await mcp("read_inbox")}`;
  }
  await runHooks("sessionEnd", base({ reason: "complete" }));
  await client?.close();
  process.stdout.write(`${answer}\n`);
}

if (argv.includes("--version")) console.log("GitHub Copilot CLI 9.9.9 (fake)");
else if (argv[0] === "mcp") await mcpCommand();
else if (argv.includes("-p")) await session(option("-p"), option("--session-id"));
