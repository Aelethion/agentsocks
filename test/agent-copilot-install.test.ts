import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { cat, GITHUB_PAT } from "./fakes.ts";
import { tempDir } from "./tmp.ts";
import { copilotAgent } from "../src/agents/copilot.ts";
import { copilotInstaller } from "../src/agents/copilot/install.ts";
import type { InstallContext } from "../src/agents/types.ts";
import { agentReports, installAgents, uninstallAgents } from "../src/install.ts";

delete process.env.COPILOT_HOME;

const NODE = "/opt/node/bin/node";
const CLI = "/opt/agentsocks/dist/cli.js";
const EVENTS = ["sessionStart", "preToolUse", "postToolUse", "agentStop", "sessionEnd"];

interface Ctx extends InstallContext {
  backups: { path: string; existed: boolean }[];
}

function context(home: string, over: Partial<InstallContext> & { cli?: string } = {}): Ctx {
  const backups: Ctx["backups"] = [];
  const { cli = CLI, ...rest } = over;
  return {
    dryRun: false,
    home,
    log: [],
    hasBinary: () => false,
    command: (...args) => [NODE, cli, ...args],
    backup: (path) => void backups.push({ path, existed: existsSync(path) }),
    backups,
    ...rest,
  };
}

const marked = (event: string, cli = CLI): string => `AGENTSOCKS_HOOK=1 '${NODE}' '${cli}' 'hook' 'copilot' '${event}'`;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const read = (path: string): string => readFileSync(path, "utf8");
const readJson = (path: string) => JSON.parse(read(path)) as Record<string, any>;
const write = (path: string, text: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const tree = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length)).sort()
    : [];

let home: string;
let copilot: string;
let mcpFile: string;
let hooksFile: string;

beforeEach(() => {
  home = tempDir("agentsocks-copilot-");
  copilot = join(home, ".copilot");
  mcpFile = join(copilot, "mcp-config.json");
  hooksFile = join(copilot, "hooks", "agentsocks.json");
});

const entry = (env: Record<string, string>, cli = CLI) => ({ type: "local", command: NODE, args: [cli, "mcp", "--agent", "copilot"], env, tools: ["*"] });
const hookEntry = (event: string, env: Record<string, string>, cli = CLI) => ({
  type: "command",
  ...(event === "preToolUse" && { matcher: "agentsocks[-/][a-z_]+" }),
  bash: marked(event, cli),
  env,
  timeoutSec: event === "sessionEnd" ? 3 : 10,
});

test("a fresh install writes the MCP server and the five hooks, private to the user, pointing at this install", () => {
  const ctx = context(home);
  copilotInstaller({}).install(ctx);
  const env = { NODE_NO_WARNINGS: "1", HOME: home };
  assert.deepEqual(readJson(mcpFile), { mcpServers: { agentsocks: entry(env) } });
  assert.deepEqual(readJson(hooksFile), { version: 1, hooks: Object.fromEntries(EVENTS.map((e) => [e, [hookEntry(e, env)]])) });
  assert.deepEqual(Object.keys(readJson(hooksFile).hooks), EVENTS);
  for (const file of [mcpFile, hooksFile]) assert.equal(statSync(file).mode & 0o777, 0o600, file);
  assert.ok(ctx.backups.every((b) => !b.existed), "nothing existed to back up");
  assert.ok(ctx.log.every((l) => l.startsWith("copilot:")), ctx.log.join("\n"));
  assert.match(ctx.log.at(-1)!, /pull-only.*--allow-tool=agentsocks.*Untested live/);
});

test("a second install changes nothing and says so", () => {
  const installer = copilotInstaller({});
  installer.install(context(home));
  const before = [read(mcpFile), read(hooksFile)];
  const again = context(home);
  installer.install(again);
  assert.deepEqual([read(mcpFile), read(hooksFile)], before);
  assert.equal(again.log.filter((l) => l.includes("unchanged")).length, 2, again.log.join("\n"));
  assert.ok(!again.log.some((l) => l.includes("pull-only")), "the advice is printed when something was written, not on every run");
  assert.deepEqual(again.backups, [], "an unchanged file is neither rewritten nor backed up");
});

test("the paths and variables the broker needs are pinned at install time, for the server and the hooks alike, and nothing else leaks in", () => {
  const env = {
    XDG_RUNTIME_DIR: "/run/user/1000",
    TMPDIR: "/var/tmp",
    AGENTSOCKS_STATE_DIR: "/data/state",
    AGENTSOCKS_RUNTIME_DIR: "/data/run",
    AGENTSOCKS_OFF: "1",
    TYPESAFE_API_KEY: "typesafe-key-value",
    GITHUB_TOKEN: GITHUB_PAT,
    COPILOT_GITHUB_TOKEN: cat("github", "_pat_", "abcdef"),
  };
  copilotInstaller(env).install(context(home));
  const pinned = { NODE_NO_WARNINGS: "1", HOME: home, XDG_RUNTIME_DIR: "/run/user/1000", TMPDIR: "/var/tmp", AGENTSOCKS_RUNTIME_DIR: "/data/run", AGENTSOCKS_STATE_DIR: "/data/state" };
  assert.deepEqual(readJson(mcpFile).mcpServers.agentsocks.env, pinned);
  for (const e of EVENTS) assert.deepEqual(readJson(hooksFile).hooks[e][0].env, pinned, e);
  assert.doesNotMatch(read(mcpFile) + read(hooksFile), /typesafe-key-value|ghp_|github_pat_|AGENTSOCKS_OFF/);
});

test("an install whose paths or environment changed updates our entries where they stand instead of adding second ones", () => {
  mkdirSync(join(copilot, "hooks"), { recursive: true });
  const userHook = { type: "command", bash: "echo mine", timeoutSec: 5 };
  write(hooksFile, json({ version: 1, hooks: { preToolUse: [userHook] } }));
  write(mcpFile, json({ mcpServers: { agentsocks: { type: "local", command: "/old/node", args: ["/old/cli.js", "mcp", "--agent", "copilot"], tools: ["*"] }, playwright: { type: "local", command: "npx", args: ["@playwright/mcp@latest"], tools: ["*"] } } }));
  copilotInstaller({}).install(context(home));
  const hooks = readJson(hooksFile).hooks;
  assert.deepEqual(hooks.preToolUse, [userHook, hookEntry("preToolUse", { NODE_NO_WARNINGS: "1", HOME: home })]);
  assert.deepEqual(Object.keys(readJson(mcpFile).mcpServers), ["agentsocks", "playwright"], "our key keeps its place");

  const moved = context(home, { cli: "/new/dist/cli.js" });
  copilotInstaller({ XDG_RUNTIME_DIR: "/run/user/1000" }).install(moved);
  const env = { NODE_NO_WARNINGS: "1", HOME: home, XDG_RUNTIME_DIR: "/run/user/1000" };
  const after = readJson(hooksFile).hooks;
  assert.deepEqual(after.preToolUse, [userHook, hookEntry("preToolUse", env, "/new/dist/cli.js")]);
  for (const e of EVENTS) assert.equal(after[e].length, e === "preToolUse" ? 2 : 1, e);
  assert.deepEqual(readJson(mcpFile).mcpServers.agentsocks, entry(env, "/new/dist/cli.js"));
  assert.ok(moved.log.some((l) => l.includes("updated")), moved.log.join("\n"));
});

test("a second entry of ours left by an older run is folded into one", () => {
  mkdirSync(join(copilot, "hooks"), { recursive: true });
  const stale = { type: "command", bash: marked("agentStop", "/old/cli.js"), timeoutSec: 10 };
  write(hooksFile, json({ version: 1, hooks: { agentStop: [stale, { type: "command", bash: "echo mine" }, stale] } }));
  copilotInstaller({}).install(context(home));
  assert.deepEqual(readJson(hooksFile).hooks.agentStop, [hookEntry("agentStop", { NODE_NO_WARNINGS: "1", HOME: home }), { type: "command", bash: "echo mine" }]);
});

test("the user's own servers, hooks, keys and ordering survive install and uninstall, byte for byte", () => {
  const mcp = json({ mcpServers: { playwright: { type: "local", command: "npx", args: ["@playwright/mcp@latest"], env: {}, tools: ["*"] }, context7: { type: "http", url: "https://mcp.context7.com/mcp", tools: ["*"] } }, extra: { keep: [1, 2, 3] } });
  const hooks = json({ version: 1, disableAllHooks: false, hooks: { sessionStart: [{ type: "command", bash: "echo hello" }], agentStop: [{ type: "command", bash: "afplay done.aiff", timeoutSec: 5 }], errorOccurred: [{ type: "command", bash: "echo oops" }] } });
  write(mcpFile, mcp);
  write(hooksFile, hooks);
  const installer = copilotInstaller({});
  const ctx = context(home);
  installer.install(ctx);
  assert.deepEqual(ctx.backups.map((b) => b.path).sort(), [hooksFile, mcpFile].sort());
  assert.ok(ctx.backups.every((b) => b.existed), "backed up before the write, while the original was still there");
  const installed = readJson(hooksFile);
  assert.equal(installed.disableAllHooks, false);
  assert.deepEqual(installed.hooks.sessionStart[0], { type: "command", bash: "echo hello" });
  assert.deepEqual(installed.hooks.errorOccurred, [{ type: "command", bash: "echo oops" }]);
  assert.deepEqual(Object.keys(readJson(mcpFile).mcpServers), ["playwright", "context7", "agentsocks"]);

  const gone = context(home);
  installer.uninstall(gone);
  assert.equal(read(mcpFile), mcp);
  assert.equal(read(hooksFile), hooks);
  assert.equal(gone.backups.length, 2);
});

test("uninstalling a fresh install removes the files and the directories it made", () => {
  const installer = copilotInstaller({});
  installer.install(context(home));
  const gone = context(home);
  installer.uninstall(gone);
  assert.deepEqual(tree(home), []);
  assert.equal(existsSync(copilot), false);
  assert.equal(existsSync(home), true, "only directories this install made are removed");
  assert.ok(gone.log.some((l) => l.startsWith("copilot:")), gone.log.join("\n"));
});

test("uninstall keeps the directory and the files a user has put beside ours", () => {
  const installer = copilotInstaller({});
  installer.install(context(home));
  write(join(copilot, "hooks", "mine.json"), json({ version: 1, hooks: {} }));
  write(join(copilot, "settings.json"), json({ model: "gpt-5.3-codex" }));
  installer.uninstall(context(home));
  assert.deepEqual(tree(copilot), ["/hooks/mine.json", "/settings.json"]);
});

test("uninstall with nothing of ours present changes nothing, makes no backup and logs nothing", () => {
  const installer = copilotInstaller({});
  const empty = context(home);
  installer.uninstall(empty);
  assert.deepEqual([empty.log, empty.backups, tree(home)], [[], [], []]);

  const mcp = json({ mcpServers: { playwright: { type: "local", command: "npx", args: [], tools: ["*"] } } });
  const hooks = `{"version":1,"hooks":{"agentStop":[{"type":"command","bash":"echo mine"}]}}`;
  write(mcpFile, mcp);
  write(hooksFile, hooks);
  const untouched = context(home);
  installer.uninstall(untouched);
  assert.deepEqual([read(mcpFile), read(hooksFile), untouched.log, untouched.backups], [mcp, hooks, [], []]);
});

test("a file that is not valid JSON, or not the shape Copilot documents, is left byte-identical and named, and the other file is still handled", () => {
  const installer = copilotInstaller({});
  for (const [bad, shapes] of [
    ["{ not json", /not valid JSON/],
    ["[]", /does not hold a JSON object/],
    [json({ mcpServers: [] }), /mcpServers/],
  ] as const) {
    write(mcpFile, bad);
    const ctx = context(home);
    installer.install(ctx);
    assert.equal(read(mcpFile), bad);
    assert.match(ctx.log.join("\n"), shapes);
    assert.ok(readJson(hooksFile).hooks.sessionStart, "the hooks file was still written");
    installer.uninstall(context(home));
    assert.equal(read(mcpFile), bad, "uninstall leaves it alone too");
    assert.equal(existsSync(hooksFile), false);
  }
  rmSync(mcpFile);
  for (const [bad, shapes] of [
    ["{ not json", /not valid JSON/],
    [json({ version: 2, hooks: {} }), /version 2/],
    [json({ version: 1, hooks: [] }), /hooks/],
    [json({ version: 1, hooks: { agentStop: {} } }), /agentStop/],
  ] as const) {
    write(hooksFile, bad);
    const ctx = context(home);
    installer.install(ctx);
    assert.equal(read(hooksFile), bad);
    assert.match(ctx.log.join("\n"), shapes);
    assert.ok(readJson(mcpFile).mcpServers.agentsocks, "the MCP file was still written");
    installer.uninstall(context(home));
    assert.equal(read(hooksFile), bad);
    rmSync(mcpFile, { force: true });
  }
});

test("a dry run writes nothing, makes no directories and no backups, and says what it would do", () => {
  const installer = copilotInstaller({});
  const fresh = context(home, { dryRun: true });
  installer.install(fresh);
  assert.equal(existsSync(copilot), false);
  assert.deepEqual(fresh.backups, []);
  assert.equal(fresh.log.filter((l) => l.includes("dry run")).length, 2, fresh.log.join("\n"));

  installer.install(context(home));
  const before = [read(mcpFile), read(hooksFile)];
  const dry = context(home, { dryRun: true, cli: "/new/dist/cli.js" });
  installer.install(dry);
  installer.uninstall(dry);
  assert.deepEqual([read(mcpFile), read(hooksFile)], before);
  assert.deepEqual(dry.backups, []);
  assert.ok(dry.log.some((l) => l.includes("dry run")));
});

test("COPILOT_HOME moves everything, and the default home is left alone", () => {
  const alt = join(home, "elsewhere", "copilot-config");
  const installer = copilotInstaller({ COPILOT_HOME: alt });
  installer.install(context(home));
  assert.deepEqual(tree(alt), ["/hooks/agentsocks.json", "/mcp-config.json"]);
  assert.equal(existsSync(copilot), false);
  assert.equal(installer.status(context(home)).state, "wired");
  installer.uninstall(context(home));
  assert.deepEqual(tree(alt), []);
});

test("Copilot CLI counts as installed when its config directory exists, and a program called copilot on the PATH is not enough, since the AWS CLI of that name exists", () => {
  const installer = copilotInstaller({});
  assert.equal(installer.detect(context(home)), false);
  assert.equal(installer.detect(context(home, { hasBinary: (name) => name === "copilot" })), false);
  mkdirSync(copilot);
  assert.equal(installer.detect(context(home)), true);
  assert.equal(copilotInstaller({ COPILOT_HOME: join(home, "alt") }).detect(context(home)), false, "the default directory does not count when COPILOT_HOME names another");
  mkdirSync(join(home, "alt"));
  assert.equal(copilotInstaller({ COPILOT_HOME: join(home, "alt") }).detect(context(home)), true);
});

test("status is wired only when every piece is present and points at this install, and otherwise says which piece is wrong", () => {
  const installer = copilotInstaller({});
  const here = () => context(home, { hasBinary: () => true });
  assert.deepEqual(installer.status(context(home)), { state: "not installed", detail: [] });
  mkdirSync(copilot);
  assert.equal(installer.status(here()).state, "not wired");

  installer.install(context(home));
  const wired = installer.status(here());
  assert.equal(wired.state, "wired");
  assert.match(wired.detail.join(" "), /pull-only/);

  const moved = installer.status(context(home, { hasBinary: () => true, cli: "/new/dist/cli.js" }));
  assert.equal(moved.state, "partly wired");
  assert.match(moved.detail.join("\n"), /MCP server.*another install/);
  assert.match(moved.detail.join("\n"), /preToolUse.*another install/);

  const doc = readJson(hooksFile);
  delete doc.hooks.preToolUse;
  doc.hooks.agentStop = [];
  write(hooksFile, json(doc));
  const missing = installer.status(here());
  assert.equal(missing.state, "partly wired");
  assert.match(missing.detail.join("\n"), /preToolUse hook is missing/);
  assert.match(missing.detail.join("\n"), /agentStop hook is missing/);

  installer.install(context(home));
  write(join(copilot, "settings.json"), json({ disableAllHooks: true }));
  const off = installer.status(here());
  assert.equal(off.state, "partly wired");
  assert.match(off.detail.join("\n"), /disableAllHooks/);

  write(join(copilot, "settings.json"), json({ disableAllHooks: false }));
  assert.equal(installer.status(here()).state, "wired");

  rmSync(hooksFile);
  assert.equal(installer.status(here()).state, "partly wired", "only the MCP entry is left");
  write(mcpFile, "{ broken");
  assert.match(installer.status(here()).detail.join("\n"), /mcp-config.json is not valid JSON/);
});

test("the stub's replacement is registered once and `agentsocks install --copilot` round-trips through the registry", () => {
  const log: string[] = [];
  installAgents(["copilot"], false, log, [copilotAgent]);
  assert.ok(existsSync(join(process.env.HOME!, ".copilot", "mcp-config.json")), log.join("\n"));
  assert.equal(agentReports([copilotAgent])[0]!.status.state, "wired");
  assert.equal(agentReports([copilotAgent])[0]!.live, "untested");
  const second: string[] = [];
  installAgents(["copilot"], false, second, [copilotAgent]);
  assert.equal(second.filter((l) => l.includes("unchanged")).length, 2, second.join("\n"));
  const gone: string[] = [];
  uninstallAgents(false, gone, [copilotAgent]);
  assert.notEqual(agentReports([copilotAgent])[0]!.status.state, "wired");
  assert.deepEqual(tree(join(process.env.HOME!, ".copilot")), []);
});
