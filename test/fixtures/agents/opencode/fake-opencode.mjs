import http from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [command, ...args] = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const data = join(process.env.XDG_DATA_HOME, "opencode-fake");
const store = join(data, "sessions.json");
mkdirSync(data, { recursive: true });
const sessions = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {};
const save = () => writeFileSync(store, JSON.stringify(sessions));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = () => `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;

if (command === "session" && args[0] === "list") {
  console.log(JSON.stringify(Object.values(sessions).map((s) => ({ id: s.id, directory: s.directory, title: "fake" }))));
} else if (command === "export") {
  console.log(JSON.stringify(sessions[args[0]] ?? {}));
} else if (command === "run") {
  const url = flag("--attach");
  const prompt = args[args.length - 1];
  const res = await fetch(`${url}/fake/prompt`, { method: "POST", headers: { authorization: auth(), "content-type": "application/json" }, body: JSON.stringify({ dir: flag("--dir"), text: prompt }) });
  process.stdout.write(await res.text());
} else if (command === "serve") {
  await serve(Number(flag("--port")), flag("--hostname"));
} else {
  console.error(`fake opencode: unsupported command ${command}`);
  process.exit(2);
}

async function serve(port, hostname) {
  const config = join(process.env.XDG_CONFIG_HOME, "opencode");
  const shim = join(config, "node_modules", "@opencode-ai", "plugin");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "package.json"), '{"name":"@opencode-ai/plugin","type":"module","main":"index.js"}\n');
  writeFileSync(join(shim, "index.js"), `import { z } from ${JSON.stringify(pathToFileURL(process.env.FAKE_OPENCODE_ZOD).href)};\nexport function tool(d) { return d; }\ntool.schema = z;\n`);

  const prompts = [];
  const client = {
    session: {
      get: async ({ path }) => (sessions[path.id] ? { data: sessions[path.id] } : { error: { name: "NotFoundError" } }),
      promptAsync: async ({ path, body }) => {
        prompts.push(body);
        void turn(path.id, body.parts[0].text, []);
        return undefined;
      },
    },
  };
  let hooks;
  let directory = "";
  const plugin = async (dir) => {
    if (hooks) return hooks;
    directory = dir;
    const mod = await import(pathToFileURL(join(config, "plugins", "agentsocks.js")).href);
    hooks = await mod.AgentsocksPlugin({ client, directory: dir, worktree: dir, project: {}, serverUrl: new URL(`http://${hostname}:${port}`), $: undefined });
    return hooks;
  };
  const call = (id, name, toolArgs = {}) => hooks.tool[`agentsocks_${name}`].execute(toolArgs, { sessionID: id, directory, abort: new AbortController().signal });
  const event = (type, properties) => hooks.event({ event: { type, properties } });

  async function afterShell(id, command, out) {
    const output = { title: command, output: `${command}\n`, metadata: {} };
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: id, callID: `call_${out.length}`, args: { command } }, output);
    out.push({ type: "tool_use", sessionID: id, part: { tool: "bash", state: { status: "completed", output: output.output } } });
    return output.output;
  }

  async function turn(id, text, out) {
    const session = sessions[id];
    await hooks["chat.message"]({ sessionID: id, agent: "build", model: { providerID: "fake", modelID: "model" } }, { parts: [{ type: "text", text }] });
    await event("session.status", { sessionID: id, status: { type: "busy" } });
    session.transcript.push({ role: "user", text });
    let answer;
    if (text.includes("Step 1")) {
      await call(id, "list_peers");
      let seen = "";
      await sleep(8000);
      seen += await afterShell(id, "sleep 8", out);
      seen += await afterShell(id, "echo step-three-done", out);
      const inbox = await call(id, "read_inbox");
      session.transcript.push({ role: "tool", text: inbox });
      out.push({ type: "tool_use", sessionID: id, part: { tool: "agentsocks_read_inbox", state: { status: "completed", output: inbox } } });
      const marker = /kumquat\d+/.exec(inbox)?.[0] ?? "NO-MARKER";
      const notice = seen.split("\n").find((l) => l.startsWith("📨 agentsocks:")) ?? "NO-NOTICE";
      answer = `marker ${marker}. notice: ${notice}`;
    } else {
      const inbox = await call(id, "read_inbox");
      session.transcript.push({ role: "tool", text: inbox });
      answer = "read it";
    }
    session.transcript.push({ role: "assistant", text: answer });
    out.push({ type: "text", sessionID: id, part: { text: answer, time: { end: Date.now() } } });
    save();
    await event("session.status", { sessionID: id, status: { type: "idle" } });
    await event("session.idle", { sessionID: id });
  }

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== auth()) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === "/global/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"healthy":true,"version":"fake"}');
      return;
    }
    if (req.url === "/fake/prompt" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { dir, text } = JSON.parse(raw);
      await plugin(dir);
      let id = Object.keys(sessions)[0];
      if (!id) {
        id = "ses_fake0001";
        sessions[id] = { id, directory: dir, transcript: [] };
        await event("session.created", { info: { id, directory: dir, projectID: "p", title: "t", version: "fake", time: { created: 1, updated: 1 } } });
      }
      const out = [];
      await turn(id, text, out);
      res.writeHead(200).end(out.map((e) => JSON.stringify(e)).join("\n") + "\n");
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, hostname);
  process.on("SIGTERM", () => process.exit(0));
  appendFileSync(join(data, "started"), "up\n");
  await new Promise(() => {});
}
