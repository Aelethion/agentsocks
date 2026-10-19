import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./tmp.ts";
import { GITHUB_PAT } from "./fakes.ts";
import { cursorAgent } from "../src/agents/cursor.ts";
import { createCursorInstaller } from "../src/agents/cursor/install.ts";
import { CURSOR_HOOKS, TOOL_NAMES } from "../src/agents/cursor/hooks.ts";
import { agentReports, installAgents, uninstallAgents } from "../src/install.ts";
import { shellQuote } from "../src/agents/files.ts";
import type { InstallContext } from "../src/agents/types.ts";

const NODE = "/usr/bin/node";
const CLI = "/opt/agentsocks/dist/cli.js";
const MATCHER = `^MCP:(${TOOL_NAMES.join("|")})$`;

interface Rig {
  home: string;
  ctx: InstallContext;
  backups: string[];
}

function rig(options: { bins?: string[]; dryRun?: boolean; cli?: string; home?: string } = {}): Rig {
  const home = options.home ?? tempDir("cursor-home-");
  const bins = new Set(options.bins ?? []);
  const backups: string[] = [];
  const ctx: InstallContext = {
    dryRun: options.dryRun ?? false,
    home,
    log: [],
    hasBinary: (name) => bins.has(name),
    command: (...args) => [NODE, options.cli ?? CLI, ...args],
    backup: (path) => {
      if (existsSync(path)) backups.push(path);
    },
  };
  return { home, ctx, backups };
}

const files = (home: string) => ({ mcp: join(home, ".cursor", "mcp.json"), hooks: join(home, ".cursor", "hooks.json"), claude: join(home, ".claude", "settings.json") });
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const hookCommand = (event: string, cli = CLI, pins: string[] = []) =>
  ["AGENTSOCKS_HOOK=1", "NODE_NO_WARNINGS='1'", ...pins, shellQuote(NODE), shellQuote(cli), "'hook'", "'cursor'", shellQuote(event)].join(" ");
const ourHooks = (cli = CLI, pins: string[] = []) => ({
  sessionStart: [{ command: hookCommand("sessionStart", cli, pins), timeout: 10 }],
  preToolUse: [{ command: hookCommand("preToolUse", cli, pins), timeout: 10, matcher: MATCHER }],
  postToolUse: [{ command: hookCommand("postToolUse", cli, pins), timeout: 10 }],
  stop: [{ command: hookCommand("stop", cli, pins), timeout: 10, loop_limit: 5 }],
  sessionEnd: [{ command: hookCommand("sessionEnd", cli, pins), timeout: 5 }],
});
const ourServer = (cli = CLI, env: Record<string, string> = {}) => ({ type: "stdio", command: NODE, args: [cli, "mcp", "--agent", "cursor"], env: { NODE_NO_WARNINGS: "1", ...env } });
const installer = createCursorInstaller({});

test("cursor is found by its config folder or by the cursor-agent binary, and the generic name agent counts for nothing on its own", () => {
  assert.equal(installer.detect(rig().ctx), false);
  assert.equal(installer.detect(rig({ bins: ["agent"] }).ctx), false);
  assert.equal(installer.detect(rig({ bins: ["cursor-agent"] }).ctx), true);
  const withFolder = rig();
  mkdirSync(files(withFolder.home).mcp.replace("/mcp.json", ""), { recursive: true });
  assert.equal(installer.detect(withFolder.ctx), true);
  assert.equal(installer.detect(rig({ bins: ["agent"], home: withFolder.home }).ctx), true);
});

test("a fresh install writes the stdio server and the five hooks exactly as Cursor documents them, private to the user", () => {
  const { home, ctx } = rig({ bins: ["cursor-agent"] });
  installer.install(ctx);
  const f = files(home);
  assert.deepEqual(readJson(f.mcp), { mcpServers: { agentsocks: ourServer() } });
  assert.deepEqual(readJson(f.hooks), { version: 1, hooks: ourHooks() });
  assert.deepEqual(Object.keys(readJson(f.hooks).hooks), Object.keys(CURSOR_HOOKS));
  for (const path of [f.mcp, f.hooks]) assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(existsSync(join(home, ".claude")), false, "nothing is registered through Claude Code's folder");
  assert.deepEqual(installer.status(ctx), { state: "wired", detail: ["pull-only: an idle Cursor chat is told at its next tool call and at the end of its turn, and cannot be woken"] });
});

test("installing again changes nothing, writes nothing and says unchanged", () => {
  const { home, ctx, backups } = rig();
  installer.install(ctx);
  const f = files(home);
  const before = [readFileSync(f.mcp, "utf8"), readFileSync(f.hooks, "utf8")];
  const mtimes = [statSync(f.mcp).mtimeMs, statSync(f.hooks).mtimeMs];
  ctx.log.length = 0;
  installer.install(ctx);
  assert.deepEqual([readFileSync(f.mcp, "utf8"), readFileSync(f.hooks, "utf8")], before);
  assert.deepEqual([statSync(f.mcp).mtimeMs, statSync(f.hooks).mtimeMs], mtimes);
  assert.deepEqual(backups, []);
  assert.deepEqual(ctx.log, [`cursor: ${f.mcp} unchanged`, `cursor: ${f.hooks} unchanged`]);
});

test("the user's own servers, hooks, ordering and other keys survive an install and are restored byte for byte by an uninstall", () => {
  const { home, ctx, backups } = rig();
  const f = files(home);
  const mine = { command: "./my-stop.sh", timeout: 30, loop_limit: null };
  const codexs = { command: "AGENTSOCKS_HOOK=1 '/usr/bin/node' '/x/cli.js' 'hook' 'codex'" };
  writeJson(f.mcp, { mcpServers: { linear: { url: "https://mcp.linear.app/mcp" }, local: { command: "npx", args: ["-y", "thing"] } }, note: "keep" });
  writeJson(f.hooks, { version: 1, hooks: { stop: [mine, codexs], afterFileEdit: [{ command: "./fmt.sh" }], sessionStart: [{ command: "./a.sh" }, { command: "./b.sh" }] }, extra: { a: 1 } });
  const seed = [readFileSync(f.mcp, "utf8"), readFileSync(f.hooks, "utf8")];

  installer.install(ctx);
  const mcp = readJson(f.mcp);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["linear", "local", "agentsocks"]);
  assert.equal(mcp.note, "keep");
  const hooks = readJson(f.hooks);
  assert.deepEqual(Object.keys(hooks.hooks), ["stop", "afterFileEdit", "sessionStart", "preToolUse", "postToolUse", "sessionEnd"]);
  assert.deepEqual(hooks.hooks.stop, [mine, codexs, ourHooks().stop[0]]);
  assert.deepEqual(hooks.hooks.sessionStart, [{ command: "./a.sh" }, { command: "./b.sh" }, ourHooks().sessionStart[0]]);
  assert.deepEqual(hooks.hooks.afterFileEdit, [{ command: "./fmt.sh" }]);
  assert.deepEqual(hooks.extra, { a: 1 });
  assert.deepEqual(backups, [f.mcp, f.hooks], "each existing file is backed up before it is rewritten");

  installer.uninstall(ctx);
  assert.deepEqual([readFileSync(f.mcp, "utf8"), readFileSync(f.hooks, "utf8")], seed);
});

test("a stale entry of ours, however many copies, is rewritten in its place and never duplicated", () => {
  const { home, ctx } = rig();
  const f = files(home);
  const old = ourHooks("/old/agentsocks/cli.js");
  writeJson(f.mcp, { mcpServers: { agentsocks: ourServer("/old/agentsocks/cli.js"), other: { command: "x" } } });
  writeJson(f.hooks, { version: 1, hooks: { stop: [{ command: "./first.sh" }, old.stop[0], { command: "./last.sh" }, old.stop[0]], sessionStart: [old.sessionStart[0]] } });
  installer.install(ctx);
  assert.deepEqual(readJson(f.mcp), { mcpServers: { agentsocks: ourServer(), other: { command: "x" } } });
  const hooks = readJson(f.hooks).hooks;
  assert.deepEqual(hooks.stop, [{ command: "./first.sh" }, ourHooks().stop[0], { command: "./last.sh" }]);
  assert.deepEqual(hooks.sessionStart, ourHooks().sessionStart);
});

const PIN_NAMES = ["AGENTSOCKS_STATE_DIR", "AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_CONFIG", "AGENTSOCKS_CCSOCKS_DIR", "AGENTSOCKS_CLAUDE_SESSIONS_DIR", "AGENTSOCKS_CLAUDE_PROJECTS_DIR", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"];

test("the variables that decide where the broker lives are pinned in the server and in every hook, and nothing else from the environment is, secrets least of all", () => {
  const paths = Object.fromEntries(PIN_NAMES.map((name, i) => [name, i === 0 ? "/srv/as state" : `/pins/${i}`]));
  const env = { ...paths, AGENTSOCKS_OFF: "1", AGENTSOCKS_WAKE: "0", AGENTSOCKS_CLASSIFIER_KEY: GITHUB_PAT, TYPESAFE_API_KEY: GITHUB_PAT, PATH: "/usr/bin", HOME: "/h", TMPDIR: "/tmp/x" };
  const { home, ctx } = rig();
  createCursorInstaller(env).install(ctx);
  const f = files(home);
  assert.deepEqual(readJson(f.mcp).mcpServers.agentsocks.env, { NODE_NO_WARNINGS: "1", ...paths });
  assert.deepEqual(readJson(f.hooks).hooks, ourHooks(CLI, PIN_NAMES.map((name) => `${name}=${shellQuote(paths[name]!)}`)));
  for (const path of [f.mcp, f.hooks]) assert.doesNotMatch(readFileSync(path, "utf8"), /AGENTSOCKS_OFF|AGENTSOCKS_WAKE|CLASSIFIER_KEY|TYPESAFE|ghp_|TMPDIR|"HOME"/);
});

test("a hook command with a space or a quote in a pinned path is one shell word", () => {
  const { home, ctx } = rig();
  createCursorInstaller({ AGENTSOCKS_STATE_DIR: "/it's here/state" }).install(ctx);
  assert.match(readJson(files(home).hooks).hooks.stop[0].command, /^AGENTSOCKS_HOOK=1 NODE_NO_WARNINGS='1' AGENTSOCKS_STATE_DIR='\/it'\\''s here\/state' '\/usr\/bin\/node'/);
});

test("a config file that is not valid JSON is left byte for byte as it was, the other file is still wired, and the log says which and why", () => {
  const { home, ctx, backups } = rig();
  const f = files(home);
  mkdirSync(join(home, ".cursor"));
  writeFileSync(f.hooks, "{ \"version\": 1, // hand edited\n hooks: {} }");
  installer.install(ctx);
  assert.equal(readFileSync(f.hooks, "utf8"), "{ \"version\": 1, // hand edited\n hooks: {} }");
  assert.deepEqual(readJson(f.mcp), { mcpServers: { agentsocks: ourServer() } });
  assert.equal(ctx.log.filter((l) => l.includes("not valid JSON") && l.includes(f.hooks) && l.includes("left untouched")).length, 1, ctx.log.join("\n"));
  assert.deepEqual(backups, []);
  const status = installer.status(ctx);
  assert.equal(status.state, "partly wired");
  assert.match(status.detail.join(" "), /hooks\.json is not valid JSON/);
  installer.uninstall(ctx);
  assert.equal(readFileSync(f.hooks, "utf8"), "{ \"version\": 1, // hand edited\n hooks: {} }");
  assert.equal(existsSync(f.mcp), false);
});

test("a file whose shape is not what Cursor documents (hooks as a list, an event that is not a list, servers as a string, a top level list) is refused untouched while a sound sibling is still wired", () => {
  const shapes: [string, "mcp" | "hooks" | "both", unknown, unknown][] = [
    ["hooks as a list", "hooks", { mcpServers: {} }, { version: 1, hooks: [] }],
    ["an event that is not a list", "hooks", { mcpServers: {} }, { version: 1, hooks: { stop: { command: "x" } } }],
    ["servers as a string", "mcp", { mcpServers: "none" }, { version: 1, hooks: {} }],
    ["a top level list", "both", [], []],
  ];
  for (const [what, bad, mcp, hooks] of shapes) {
    const { home, ctx } = rig();
    const f = files(home);
    writeJson(f.mcp, mcp);
    writeJson(f.hooks, hooks);
    const seed = { mcp: readFileSync(f.mcp, "utf8"), hooks: readFileSync(f.hooks, "utf8") };
    installer.install(ctx);
    for (const key of bad === "both" ? (["mcp", "hooks"] as const) : [bad]) assert.equal(readFileSync(f[key], "utf8"), seed[key], `${what}: ${key} untouched`);
    if (bad !== "both") assert.match(readFileSync(f[bad === "mcp" ? "hooks" : "mcp"], "utf8"), /agentsocks/, `${what}: the sound file is wired`);
    assert.ok(ctx.log.some((l) => l.includes("left untouched")), `${what}: ${ctx.log.join(" | ")}`);
  }
});

test("a dry run writes nothing, backs nothing up and says what it would write", () => {
  const { home, ctx, backups } = rig({ dryRun: true });
  installer.install(ctx);
  assert.equal(existsSync(join(home, ".cursor")), false);
  assert.deepEqual(backups, []);
  assert.deepEqual(ctx.log, [`cursor (dry run): would write ${files(home).mcp}`, `cursor (dry run): would write ${files(home).hooks}`]);
  const wired = rig();
  installer.install(wired.ctx);
  const seed = [readFileSync(files(wired.home).mcp, "utf8"), readFileSync(files(wired.home).hooks, "utf8")];
  installer.uninstall({ ...wired.ctx, dryRun: true });
  assert.deepEqual([readFileSync(files(wired.home).mcp, "utf8"), readFileSync(files(wired.home).hooks, "utf8")], seed);
  assert.ok(wired.ctx.log.some((l) => /dry run/.test(l)));
});

test("an uninstall on a machine that has nothing of ours changes nothing and logs nothing", () => {
  const { home, ctx } = rig();
  installer.uninstall(ctx);
  assert.equal(existsSync(join(home, ".cursor")), false);
  const f = files(home);
  writeJson(f.mcp, { mcpServers: { linear: { url: "u" } } });
  writeJson(f.hooks, { version: 1, hooks: { stop: [{ command: "./mine.sh" }] } });
  const seed = [readFileSync(f.mcp, "utf8"), readFileSync(f.hooks, "utf8")];
  installer.uninstall(ctx);
  assert.deepEqual([readFileSync(f.mcp, "utf8"), readFileSync(f.hooks, "utf8")], seed);
  assert.deepEqual(ctx.log, []);
});

test("an uninstall after a fresh install leaves no file of ours behind, and not even an empty folder it created", () => {
  const { home, ctx, backups } = rig();
  installer.install(ctx);
  backups.length = 0;
  installer.uninstall(ctx);
  assert.equal(existsSync(join(home, ".cursor")), false);
  assert.deepEqual(backups.sort(), [files(home).hooks, files(home).mcp].sort(), "what it removes it backs up first");
  assert.equal(installer.status(ctx).state, "not installed");
});

test("an uninstall keeps a folder that holds anything else", () => {
  const { home, ctx } = rig();
  installer.install(ctx);
  writeFileSync(join(home, ".cursor", "cli-config.json"), "{}\n");
  installer.uninstall(ctx);
  assert.equal(existsSync(files(home).mcp), false);
  assert.equal(readFileSync(join(home, ".cursor", "cli-config.json"), "utf8"), "{}\n");
});

test("status tells wired from not wired, from a missing or stale piece, and names the piece", () => {
  const { home, ctx } = rig({ bins: ["cursor-agent"] });
  assert.deepEqual(installer.status(ctx), { state: "not wired", detail: [] });
  installer.install(ctx);
  const f = files(home);
  assert.equal(installer.status(ctx).state, "wired");

  const hooks = readJson(f.hooks);
  delete hooks.hooks.stop;
  writeJson(f.hooks, hooks);
  let status = installer.status(ctx);
  assert.equal(status.state, "partly wired");
  assert.match(status.detail.join(" "), /hooks\.json has no stop hook/);

  installer.install(ctx);
  assert.equal(installer.status(ctx).state, "wired");
  const moved = { ...ctx, command: (...args: string[]) => [NODE, "/new/place/cli.js", ...args] };
  status = installer.status(moved);
  assert.equal(status.state, "partly wired");
  assert.match(status.detail.join(" "), /mcp\.json starts \/opt\/agentsocks\/dist\/cli\.js, not \/new\/place\/cli\.js/);
  assert.match(status.detail.join(" "), /hooks\.json is out of date for sessionStart, preToolUse, postToolUse, stop, sessionEnd/);

  const otherNode = installer.status({ ...ctx, command: (...args: string[]) => ["/other/node", CLI, ...args] });
  assert.equal(otherNode.state, "partly wired");
  assert.match(otherNode.detail.join(" "), /mcp\.json has an agentsocks server that is not the one this install runs/);

  const mcpGone = readJson(f.mcp);
  delete mcpGone.mcpServers.agentsocks;
  writeJson(f.mcp, mcpGone);
  assert.match(installer.status(ctx).detail.join(" "), /mcp\.json has no agentsocks server/);
  installer.install(ctx);
  const stale = readJson(f.hooks);
  stale.hooks.preToolUse[0].matcher = "^MCP:(send_message)$";
  writeJson(f.hooks, stale);
  assert.match(installer.status(ctx).detail.join(" "), /out of date for preToolUse/, "an old tool list is stale, because its calls would reach the server unstamped");
});

test("a Cursor that is not here is reported as not installed", () => {
  assert.deepEqual(installer.status(rig().ctx), { state: "not installed", detail: [] });
});

test("an agentsocks hook in ~/.claude/settings.json, which Cursor also loads, is reported as double registration and the file is never touched", () => {
  const { home, ctx } = rig();
  installer.install(ctx);
  const f = files(home);
  const claudeHooks = { hooks: { Stop: [{ hooks: [{ type: "command", command: hookCommand("stop").replace("'cursor'", "'codex'") }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./mine.sh" }] }] } };
  writeJson(f.claude, claudeHooks);
  const seed = readFileSync(f.claude, "utf8");
  const status = installer.status(ctx);
  assert.equal(status.state, "partly wired");
  assert.match(status.detail.join(" "), /~\/\.claude\/settings\.json also holds an agentsocks hook, and Cursor loads that file too, so the hook would run twice/);
  assert.match(status.detail.join(" "), /agentsocks never edits ~\/\.claude/);
  installer.install(ctx);
  installer.uninstall(ctx);
  assert.equal(readFileSync(f.claude, "utf8"), seed);

  writeJson(f.claude, { hooks: { Stop: [{ hooks: [{ type: "command", command: "./mine.sh" }] }] } });
  installer.install(ctx);
  assert.equal(installer.status(ctx).state, "wired", "a Claude hook that is not ours is none of our business");
  writeFileSync(f.claude, "{ not json");
  assert.equal(installer.status(ctx).state, "wired", "an unreadable Claude file is not an error of ours");
});

test("a CURSOR_CONFIG_DIR in the environment is mentioned, because Cursor documents it for cli-config.json only and the files still go under ~/.cursor", () => {
  const { home, ctx } = rig();
  createCursorInstaller({ CURSOR_CONFIG_DIR: "/alt/cursor" }).install(ctx);
  assert.ok(ctx.log.some((l) => l.includes("CURSOR_CONFIG_DIR") && l.includes("cli-config.json") && l.includes(join(home, ".cursor"))), ctx.log.join("\n"));
  assert.ok(existsSync(files(home).hooks));
  const quiet = rig();
  installer.install(quiet.ctx);
  assert.ok(!quiet.ctx.log.some((l) => l.includes("CURSOR_CONFIG_DIR")));
});

test("a symlinked config file is written through on uninstall and never unlinked, so a dotfiles checkout keeps its link and loses our entries", () => {
  const { home, ctx } = rig();
  const f = files(home);
  const dotfiles = tempDir("cursor-dotfiles-");
  const target = join(dotfiles, "hooks.json");
  writeJson(target, { version: 1 });
  mkdirSync(join(home, ".cursor"));
  symlinkSync(target, f.hooks);
  installer.install(ctx);
  assert.equal(lstatSync(f.hooks).isSymbolicLink(), true);
  assert.match(readFileSync(target, "utf8"), /agentsocks/);
  installer.uninstall(ctx);
  assert.equal(lstatSync(f.hooks).isSymbolicLink(), true, "the link survives");
  assert.deepEqual(readJson(target), { version: 1 }, "and the file it points at no longer has our entries");
});

test("a server named agentsocks that is not a local agentsocks command (a remote url, say) is never overwritten, never removed, and is reported", () => {
  const { home, ctx } = rig();
  const f = files(home);
  writeJson(f.mcp, { mcpServers: { agentsocks: { url: "https://gateway.example/mcp", headers: { Authorization: "Bearer x" } } } });
  const seed = readFileSync(f.mcp, "utf8");
  installer.install(ctx);
  assert.equal(readFileSync(f.mcp, "utf8"), seed);
  assert.ok(ctx.log.some((l) => l.includes(f.mcp) && l.includes("does not run a local agentsocks command") && l.includes("left untouched")), ctx.log.join(" | "));
  assert.ok(existsSync(f.hooks), "the hooks are still wired");
  const status = installer.status(ctx);
  assert.equal(status.state, "partly wired");
  assert.match(status.detail.join(" "), /a server named agentsocks that does not run a local agentsocks command/);
  installer.uninstall(ctx);
  assert.equal(readFileSync(f.mcp, "utf8"), seed);
});

test("status notices a second agentsocks hook in one event, and an install removes the extra", () => {
  const { home, ctx } = rig();
  installer.install(ctx);
  const f = files(home);
  const hooks = readJson(f.hooks);
  hooks.hooks.stop.push({ ...hooks.hooks.stop[0], timeout: 99 });
  writeJson(f.hooks, hooks);
  const status = installer.status(ctx);
  assert.equal(status.state, "partly wired");
  assert.match(status.detail.join(" "), /more than one agentsocks hook for stop/);
  assert.match(status.detail.join(" "), /out of date for stop/, "the copy with another timeout is stale too");
  installer.install(ctx);
  assert.equal(installer.status(ctx).state, "wired");
  assert.equal(readJson(f.hooks).hooks.stop.length, 1);
});

test("status notices a pinned variable that now has another value in the shell, and says nothing about one that is not set", () => {
  const { ctx } = rig();
  createCursorInstaller({ AGENTSOCKS_STATE_DIR: "/old/state" }).install(ctx);
  assert.equal(createCursorInstaller({ AGENTSOCKS_STATE_DIR: "/old/state" }).status(ctx).state, "wired");
  assert.equal(createCursorInstaller({}).status(ctx).state, "wired", "a shell without the variable proves nothing");
  const moved = createCursorInstaller({ AGENTSOCKS_STATE_DIR: "/new/state" }).status(ctx);
  assert.equal(moved.state, "partly wired");
  assert.match(moved.detail.join(" "), /pins AGENTSOCKS_STATE_DIR to other values than this shell has/);
});

test("the registered agent is Cursor, untested live, and runs through the same install, report and uninstall calls agentsocks install, doctor and uninstall use", () => {
  assert.equal(cursorAgent.id, "cursor");
  assert.equal(cursorAgent.live, "untested");
  assert.equal(cursorAgent.wake, undefined, "an idle Cursor chat cannot be woken");
  const log: string[] = [];
  installAgents(["cursor"], false, log, [cursorAgent]);
  assert.ok(log.some((l) => l.includes(".cursor/mcp.json")), log.join("\n"));
  assert.equal(agentReports([cursorAgent])[0]!.status.state, "wired");
  uninstallAgents(false, log, [cursorAgent]);
  assert.notEqual(agentReports([cursorAgent])[0]!.status.state, "wired");
  assert.equal(existsSync(join(process.env.HOME!, ".cursor", "mcp.json")), false);
});
