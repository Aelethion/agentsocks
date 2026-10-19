import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./tmp.ts";
import { agentSpec } from "../src/agents/index.ts";
import { geminiAgent } from "../src/agents/gemini.ts";
import { isOurCommand } from "../src/agents/files.ts";
import type { InstallContext } from "../src/agents/types.ts";

delete process.env.GEMINI_CLI_HOME;

const NODE = "/opt/node/bin/node";
const CLI = "/opt/agentsocks/dist/cli.js";
const installer = geminiAgent.installer;

interface Harness {
  ctx: InstallContext;
  home: string;
  log: string[];
  backups: { path: string; text: string }[];
  settings: string;
}

function harness(over: Partial<InstallContext> & { cli?: string } = {}): Harness {
  const home = over.home ?? tempDir("agentsocks-gemini-");
  const log: string[] = [];
  const backups: Harness["backups"] = [];
  const { cli = CLI, ...rest } = over;
  const ctx: InstallContext = {
    dryRun: false,
    home,
    log,
    hasBinary: () => false,
    command: (...args) => [NODE, cli, ...args],
    backup: (path) => {
      if (existsSync(path)) backups.push({ path, text: readFileSync(path, "utf8") });
    },
    ...rest,
  };
  return { ctx, home, log, backups, settings: join(home, ".gemini", "settings.json") };
}

const canonical = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;
const write = (h: Harness, doc: unknown | string): void => {
  mkdirSync(join(h.home, ".gemini"), { recursive: true });
  writeFileSync(h.settings, typeof doc === "string" ? doc : canonical(doc));
};
const read = (h: Harness): Record<string, any> => JSON.parse(readFileSync(h.settings, "utf8"));
const hookCommand = (event: string, cli = CLI): string => `AGENTSOCKS_HOOK=1 '${NODE}' '${cli}' 'hook' 'gemini' '${event}'`;
const ours = (event: string, name: string, matcher: string, timeout = 10_000, cli = CLI) => ({ matcher, hooks: [{ name, type: "command", command: hookCommand(event, cli), timeout }] });

const WIRED = (cli = CLI) => ({
  mcpServers: { agentsocks: { command: NODE, args: [cli, "mcp", "--agent", "gemini"], env: { NODE_NO_WARNINGS: "1" } } },
  hooks: {
    SessionStart: [ours("SessionStart", "agentsocks-session-start", "*", 10_000, cli)],
    BeforeTool: [ours("BeforeTool", "agentsocks-stamp", "^mcp_agentsocks_", 10_000, cli)],
    AfterTool: [ours("AfterTool", "agentsocks-notice", "*", 10_000, cli)],
    AfterAgent: [ours("AfterAgent", "agentsocks-finish", "*", 10_000, cli)],
    SessionEnd: [ours("SessionEnd", "agentsocks-session-end", "*", 3_000, cli)],
  },
});

const DOCUMENTED_SERVER_KEYS = ["command", "args", "env", "cwd", "url", "httpUrl", "headers", "timeout", "trust", "description", "includeTools", "excludeTools"];
const DOCUMENTED_HOOK_KEYS = ["type", "command", "name", "timeout", "description"];

function assertDocumentedShape(doc: Record<string, any>): void {
  const server = doc.mcpServers.agentsocks;
  for (const k of Object.keys(server)) assert.ok(DOCUMENTED_SERVER_KEYS.includes(k), `mcpServers.agentsocks.${k} is a documented key`);
  assert.equal(server.trust, undefined, "agentsocks never asks Gemini CLI to skip tool confirmations");
  for (const [event, defs] of Object.entries<any[]>(doc.hooks)) {
    for (const def of defs) {
      assert.ok(Object.keys(def).every((k) => ["matcher", "sequential", "hooks"].includes(k)), `${event} definition keys`);
      for (const h of def.hooks) {
        assert.ok(Object.keys(h).every((k) => DOCUMENTED_HOOK_KEYS.includes(k)), `${event} hook keys ${Object.keys(h)}`);
        assert.equal(h.type, "command");
        if (h.timeout !== undefined) assert.equal(typeof h.timeout, "number");
      }
    }
  }
}

const USER = () => ({
  ui: { theme: "GitHub" },
  mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], trust: false } },
  hooks: {
    SessionStart: [{ matcher: "startup", hooks: [{ name: "mine", type: "command", command: "./mine.sh", timeout: 5000 }] }],
    BeforeTool: [{ matcher: "write_file", hooks: [{ type: "command", command: "./guard.sh" }] }],
    BeforeModel: [{ matcher: "*", hooks: [{ type: "command", command: "./log.sh" }] }],
  },
  hooksConfig: { notifications: false },
  tools: { exclude: ["run_shell_command"] },
});

test("a fresh install writes the MCP server and the five hooks in Gemini CLI's documented settings.json shape, privately, with no trust key", () => {
  const h = harness();
  installer.install(h.ctx);
  const doc = read(h);
  assert.deepEqual(doc, WIRED());
  assertDocumentedShape(doc);
  assert.equal(statSync(h.settings).mode & 0o777, 0o600);
  assert.deepEqual(h.backups, [], "nothing existed to back up");
  assert.ok((read(h).hooks.SessionStart[0].hooks as { command: string }[]).every((x) => isOurCommand(x.command)));
  assert.match(h.log.join("\n"), /untested live/i);
  assert.match(h.log.join("\n"), /pull-only|cannot be woken/);
});

test("install keeps every other key, every user hook and their order, and appends its own after them", () => {
  const h = harness();
  const original = canonical(USER());
  write(h, original);
  installer.install(h.ctx);
  const doc = read(h);
  assertDocumentedShape(doc);
  const user = USER();
  assert.deepEqual(doc.ui, user.ui);
  assert.deepEqual(doc.hooksConfig, user.hooksConfig);
  assert.deepEqual(doc.tools, user.tools);
  assert.deepEqual(doc.mcpServers.github, user.mcpServers.github);
  assert.deepEqual(doc.hooks.SessionStart[0], user.hooks.SessionStart[0]);
  assert.deepEqual(doc.hooks.BeforeTool[0], user.hooks.BeforeTool[0]);
  assert.deepEqual(doc.hooks.BeforeModel, user.hooks.BeforeModel);
  assert.equal(doc.hooks.SessionStart.length, 2);
  assert.equal(doc.hooks.BeforeTool.length, 2);
  assert.ok(isOurCommand(doc.hooks.SessionStart[1].hooks[0].command));
  assert.deepEqual(Object.keys(doc), ["ui", "mcpServers", "hooks", "hooksConfig", "tools"]);
  assert.deepEqual(Object.keys(doc.mcpServers), ["github", "agentsocks"]);
  assert.deepEqual(Object.keys(doc.hooks), ["SessionStart", "BeforeTool", "BeforeModel", "AfterTool", "AfterAgent", "SessionEnd"]);
  assert.deepEqual(h.backups, [{ path: h.settings, text: original }], "the original was backed up once, before the write");
});

test("uninstall removes exactly what install added and leaves the user's file as it was, byte for byte", () => {
  const h = harness();
  const original = canonical(USER());
  write(h, original);
  installer.install(h.ctx);
  installer.uninstall(h.ctx);
  assert.equal(readFileSync(h.settings, "utf8"), original);
  assert.match(h.log.join("\n"), /removed the MCP server/);
});

test("uninstall of a file agentsocks created removes the file, so nothing is left that makes Gemini CLI look installed", () => {
  const h = harness();
  installer.install(h.ctx);
  installer.uninstall(h.ctx);
  assert.equal(existsSync(h.settings), false);
});

test("running install twice changes nothing the second time and says so, with no second backup", () => {
  const h = harness();
  write(h, USER());
  installer.install(h.ctx);
  const first = readFileSync(h.settings, "utf8");
  h.log.length = 0;
  installer.install(h.ctx);
  assert.equal(readFileSync(h.settings, "utf8"), first);
  assert.equal(h.backups.length, 1);
  assert.match(h.log.join("\n"), /already wired .*unchanged/);
});

test("a stale entry from an older install path is updated in place: one entry per event, the user's extra keys on it survive", () => {
  const h = harness({ cli: "/old/agentsocks/dist/cli.js" });
  installer.install(h.ctx);
  const staleDoc = read(h);
  staleDoc.mcpServers.agentsocks.timeout = 5000;
  staleDoc.hooks.AfterTool[0].hooks[0].description = "my note";
  write(h, staleDoc);
  const fresh = harness({ home: h.home });
  installer.install(fresh.ctx);
  const doc = read(fresh);
  assert.deepEqual(doc.mcpServers.agentsocks, { command: NODE, args: [CLI, "mcp", "--agent", "gemini"], env: { NODE_NO_WARNINGS: "1" }, timeout: 5000 });
  assert.equal(doc.hooks.AfterTool[0].hooks[0].description, "my note");
  for (const [event, defs] of Object.entries<any[]>(doc.hooks)) {
    assert.equal(defs.length, 1, event);
    assert.equal(defs[0].hooks.length, 1, event);
    assert.equal(defs[0].hooks[0].command, hookCommand(event));
  }
  assert.match(fresh.log.join("\n"), /updated the MCP server/);
});

test("uninstall with nothing of ours present changes nothing: no write, no backup, no log, and no file is created", () => {
  const h = harness();
  installer.uninstall(h.ctx);
  assert.equal(existsSync(join(h.home, ".gemini")), false);
  const original = canonical(USER());
  write(h, original);
  installer.uninstall(h.ctx);
  assert.equal(readFileSync(h.settings, "utf8"), original);
  assert.deepEqual([h.backups, h.log], [[], []]);
});

test("uninstall removes our hooks even from a definition the user shares with their own, and keeps that definition's matcher", () => {
  const h = harness();
  const doc = USER();
  (doc.hooks.BeforeTool[0] as any).hooks.push({ name: "x", type: "command", command: hookCommand("BeforeTool") });
  write(h, doc);
  installer.uninstall(h.ctx);
  assert.deepEqual(read(h).hooks.BeforeTool, USER().hooks.BeforeTool);
});

test("a dry run writes nothing and says what it would do, for install and for uninstall", () => {
  const dry = harness({ dryRun: true });
  installer.install(dry.ctx);
  assert.equal(existsSync(dry.settings), false);
  assert.match(dry.log.join("\n"), /dry run/);
  assert.match(dry.log.join("\n"), /would write/);
  const wired = harness();
  installer.install(wired.ctx);
  const before = readFileSync(wired.settings, "utf8");
  const dryUninstall = harness({ home: wired.home, dryRun: true });
  installer.uninstall(dryUninstall.ctx);
  assert.equal(readFileSync(wired.settings, "utf8"), before);
  assert.match(dryUninstall.log.join("\n"), /dry run/);
});

test("a settings.json that is not strict JSON (comments included), not an object, or shaped wrongly is refused and left byte-identical", () => {
  const unreadable: Record<string, string> = {
    "line comments": '{\n  // my notes\n  "ui": { "theme": "GitHub" }\n}\n',
    "block comments": '{ /* x */ "ui": {} }',
    "a truncated file": '{ "ui": ',
    "an array": "[]",
  };
  const misshapen: Record<string, string> = {
    "hooks as an array": '{ "hooks": [] }',
    "an event that is not an array": '{ "hooks": { "BeforeTool": {} } }',
    "mcpServers as a string": '{ "mcpServers": "x" }',
  };
  for (const [what, text] of Object.entries({ ...unreadable, ...misshapen })) {
    const h = harness();
    write(h, text);
    assert.throws(() => installer.install(h.ctx), /left untouched/, what);
    assert.equal(readFileSync(h.settings, "utf8"), text, `${what}: install left the file alone`);
    assert.deepEqual([h.backups, h.log], [[], []], what);
    if (what in unreadable) assert.throws(() => installer.uninstall(h.ctx), /left untouched/, `${what}: uninstall`);
    else {
      try {
        installer.uninstall(h.ctx);
      } catch {}
    }
    assert.equal(readFileSync(h.settings, "utf8"), text, `${what}: uninstall left the file alone`);
  }
});

test("a node or agentsocks path with a dollar sign is refused, because Gemini CLI expands $VARS in settings.json", () => {
  const h = harness({ cli: "/srv/$HOME/agentsocks/dist/cli.js" });
  assert.throws(() => installer.install(h.ctx), /contains a \$/);
  assert.equal(existsSync(h.settings), false);
});

test("an existing settings.json keeps its permission bits", () => {
  const h = harness();
  write(h, USER());
  chmodSync(h.settings, 0o640);
  installer.install(h.ctx);
  assert.equal(statSync(h.settings).mode & 0o777, 0o640);
});

test("GEMINI_CLI_HOME moves the config directory: that is where install writes and status looks", () => {
  const elsewhere = tempDir("gemini-cli-home-");
  const h = harness();
  process.env.GEMINI_CLI_HOME = elsewhere;
  try {
    installer.install(h.ctx);
    assert.equal(existsSync(h.settings), false);
    assert.equal(existsSync(join(h.home, ".gemini")), false);
    const doc = JSON.parse(readFileSync(join(elsewhere, ".gemini", "settings.json"), "utf8"));
    assert.deepEqual(doc, WIRED());
    assert.equal(installer.detect(h.ctx), true);
    assert.equal(installer.status(h.ctx).state, "wired");
    installer.uninstall(h.ctx);
    assert.equal(existsSync(join(elsewhere, ".gemini", "settings.json")), false);
  } finally {
    delete process.env.GEMINI_CLI_HOME;
  }
});

test("detect: the gemini binary, or Gemini CLI's own settings.json or session store; an empty ~/.gemini shared with Antigravity CLI does not count", () => {
  const empty = harness();
  assert.equal(installer.detect(empty.ctx), false);

  const antigravity = harness();
  mkdirSync(join(antigravity.home, ".gemini", "antigravity-cli", "skills"), { recursive: true });
  mkdirSync(join(antigravity.home, ".gemini", "config"), { recursive: true });
  writeFileSync(join(antigravity.home, ".gemini", "GEMINI.md"), "rules");
  writeFileSync(join(antigravity.home, ".gemini", "config", "mcp_config.json"), "{}");
  assert.equal(installer.detect(antigravity.ctx), false);

  const asked: string[] = [];
  const binary = harness({ hasBinary: (name) => (asked.push(name), name === "gemini") });
  assert.equal(installer.detect(binary.ctx), true);
  assert.deepEqual(asked, ["gemini"]);

  const withSettings = harness();
  write(withSettings, {});
  assert.equal(installer.detect(withSettings.ctx), true);

  const withSessions = harness();
  mkdirSync(join(withSessions.home, ".gemini", "tmp", "5d1c7a0e", "chats"), { recursive: true });
  assert.equal(installer.detect(withSessions.ctx), true);
});

test("status: not installed, not wired, wired, partly wired for a missing piece, a stale path, and each setting that stops Gemini CLI using them", () => {
  const none = harness();
  assert.deepEqual(installer.status(none.ctx), { state: "not installed", detail: [] });

  const h = harness();
  write(h, USER());
  assert.equal(installer.status(h.ctx).state, "not wired");

  installer.install(h.ctx);
  assert.deepEqual(installer.status(h.ctx), { state: "wired", detail: [] });

  const doc = read(h);
  delete doc.hooks.AfterTool;
  write(h, doc);
  const missing = installer.status(h.ctx);
  assert.equal(missing.state, "partly wired");
  assert.deepEqual(missing.detail, ["missing AfterTool hook"]);

  installer.install(h.ctx);
  const stale = installer.status(harness({ home: h.home, cli: "/new/agentsocks/dist/cli.js" }).ctx);
  assert.equal(stale.state, "partly wired");
  assert.equal(stale.detail.length, 6);
  assert.match(stale.detail[0]!, /stale MCP server/);

  const blocked: Record<string, [(d: Record<string, any>) => void, RegExp]> = {
    "hooks switched off": [(d) => (d.hooksConfig = { enabled: false }), /hooksConfig\.enabled is false/],
    "one hook disabled by name": [(d) => (d.hooksConfig = { disabled: ["agentsocks-stamp"] }), /switched off: agentsocks-stamp/],
    "the legacy hooks.disabled list": [(d) => (d.hooks.disabled = ["agentsocks-finish"]), /switched off: agentsocks-finish/],
    "the server excluded": [(d) => (d.mcp = { excluded: ["agentsocks"] }), /mcp\.excluded lists agentsocks/],
    "an allowlist without it": [(d) => (d.mcp = { allowed: ["github"] }), /mcp\.allowed does not list agentsocks/],
  };
  for (const [what, [change, pattern]] of Object.entries(blocked)) {
    const b = harness();
    installer.install(b.ctx);
    const d = read(b);
    change(d);
    write(b, d);
    const s = installer.status(b.ctx);
    assert.equal(s.state, "partly wired", what);
    assert.match(s.detail.join("; "), pattern, what);
    const again = harness({ home: b.home });
    installer.install(again.ctx);
    assert.match(again.log.join("\n"), pattern, `${what}: install warns about it`);
  }

  const broken = harness();
  write(broken, "{ // note\n}");
  const s = installer.status(broken.ctx);
  assert.equal(s.state, "not wired");
  assert.match(s.detail.join(), /not valid JSON/);

  installer.uninstall(h.ctx);
  assert.equal(installer.status(h.ctx).state, "not wired");
});

test("Gemini CLI is registered as a pull-only, untested-live agent, and the core's install, doctor and uninstall paths drive this installer", async () => {
  assert.equal(agentSpec("gemini"), geminiAgent);
  assert.equal(geminiAgent.live, "untested");
  assert.equal(geminiAgent.wake, undefined);
  assert.equal(geminiAgent.canWake, undefined);
  const { installAgents, uninstallAgents, agentReports } = await import("../src/install.ts");
  const home = process.env.HOME!;
  assert.ok(home.startsWith("/tmp/"), "the preload gave this process a temporary home");
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "settings.json"), "{}\n");
  const log: string[] = [];
  installAgents(["gemini"], false, log, [geminiAgent]);
  assert.match(log.join("\n"), /gemini: added the MCP server/);
  const doc = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(doc.hooks), ["SessionStart", "BeforeTool", "AfterTool", "AfterAgent", "SessionEnd"]);
  assert.match(doc.hooks.BeforeTool[0].hooks[0].command, /^AGENTSOCKS_HOOK=1 '[^']+' '[^']+cli\.[jt]s' 'hook' 'gemini' 'BeforeTool'$/);
  assert.deepEqual(agentReports([geminiAgent]).map((r) => [r.id, r.live, r.status.state]), [["gemini", "untested", "wired"]]);
  uninstallAgents(false, [], [geminiAgent]);
  assert.deepEqual(readdirSync(join(home, ".gemini")), []);
});
