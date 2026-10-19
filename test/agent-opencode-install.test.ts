import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { opencodeInstaller } from "../src/agents/opencode.ts";
import { PLUGIN_MARKER } from "../src/agents/opencode/plugin.ts";
import type { InstallContext } from "../src/agents/types.ts";
import { agentReports, installAgents, uninstallAgents } from "../src/install.ts";
import { opencodeAgent } from "../src/agents/opencode.ts";
import { tempDir } from "./tmp.ts";

const CLI_A = "/opt/agentsocks-a/dist/cli.js";
const CLI_B = "/opt/agentsocks-b/dist/cli.js";

interface Harness {
  home: string;
  ctx: InstallContext;
  backups: string[];
  log: string[];
}

function harness(opts: { cli?: string; dryRun?: boolean; home?: string; binary?: boolean } = {}): Harness {
  const home = opts.home ?? tempDir("agentsocks-oc-home-");
  const backups: string[] = [];
  const log: string[] = [];
  const cli = opts.cli ?? CLI_A;
  return {
    home,
    backups,
    log,
    ctx: { dryRun: opts.dryRun ?? false, home, log, hasBinary: () => opts.binary ?? false, command: (...args) => ["/usr/bin/node", cli, ...args], backup: (path) => void backups.push(path) },
  };
}

const configDir = (home: string) => join(home, ".config", "opencode");
const pluginFile = (home: string) => join(configDir(home), "plugins", "agentsocks.js");

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) {
        out[`${relative(dir, full)}/`] = "dir";
        walk(full);
      } else out[relative(dir, full)] = `${(statSync(full).mode & 0o777).toString(8)}:${readFileSync(full, "utf8")}`;
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const USERS_CONFIG = '{\n  // my settings, with a comment jsonc allows\n  "$schema": "https://opencode.ai/config.json",\n  "model": "anthropic/claude-sonnet-4-5",\n  "plugin": ["opencode-wakatime"],\n}\n';

function userConfig(home: string): void {
  const dir = configDir(home);
  mkdirSync(join(dir, "plugins"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "@opencode-ai", "plugin"), { recursive: true });
  writeFileSync(join(dir, "opencode.jsonc"), USERS_CONFIG);
  writeFileSync(join(dir, "package.json"), '{"dependencies":{"@opencode-ai/plugin":"1.18.31"}}\n');
  writeFileSync(join(dir, "plugins", "mine.js"), "export const Mine = async () => ({})\n");
  writeFileSync(join(dir, "node_modules", "@opencode-ai", "plugin", "index.js"), "export {}\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  chmodSync(join(dir, "opencode.jsonc"), 0o640);
}

const installer = opencodeInstaller(() => ({}));

test("install writes one generated plugin file whose first line marks it as ours, and nothing else in the user's OpenCode folder changes", () => {
  const h = harness();
  userConfig(h.home);
  const before = snapshot(configDir(h.home));
  installer.install(h.ctx);
  const after = snapshot(configDir(h.home));
  const added = Object.keys(after).filter((k) => !(k in before));
  assert.deepEqual(added, ["plugins/agentsocks.js"]);
  for (const [path, content] of Object.entries(before)) assert.equal(after[path], content, `${path} is byte-identical`);
  const text = readFileSync(pluginFile(h.home), "utf8");
  assert.ok(text.startsWith(PLUGIN_MARKER), "marker on the first line");
  assert.equal(text.split("\n")[0]!.startsWith("// "), true);
  assert.ok(text.includes(JSON.stringify(CLI_A)), "the cli path is baked in");
  assert.ok(text.includes(JSON.stringify("/usr/bin/node")), "the node path is baked in");
  assert.equal(statSync(pluginFile(h.home)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(configDir(h.home), "plugins")).sort(), ["agentsocks.js", "mine.js"], "no temp file is left behind");
  assert.deepEqual(h.backups, [], "nothing existed to back up");
  assert.match(h.log.join("\n"), /opencode: wrote plugin .*agentsocks\.js/);
});

test("install twice changes nothing the second time and says so", () => {
  const h = harness();
  userConfig(h.home);
  installer.install(h.ctx);
  const once = snapshot(configDir(h.home));
  const second = harness({ home: h.home });
  installer.install(second.ctx);
  assert.deepEqual(snapshot(configDir(h.home)), once);
  assert.match(second.log.join("\n"), /already installed, unchanged/);
  assert.deepEqual(second.backups, []);
});

test("a dry run writes nothing, not even the folder, and says what it would do", () => {
  const h = harness({ dryRun: true });
  installer.install(h.ctx);
  assert.equal(existsSync(configDir(h.home)), false);
  assert.match(h.log.join("\n"), /opencode \(dry run\): would write .*agentsocks\.js/);

  const real = harness({ home: h.home });
  installer.install(real.ctx);
  const dry = harness({ home: h.home, dryRun: true, cli: CLI_B });
  const before = snapshot(configDir(h.home));
  installer.install(dry.ctx);
  assert.deepEqual(snapshot(configDir(h.home)), before);
  assert.match(dry.log.join("\n"), /would update/);
  const gone = harness({ home: h.home, dryRun: true });
  installer.uninstall(gone.ctx);
  assert.deepEqual(snapshot(configDir(h.home)), before);
  assert.match(gone.log.join("\n"), /would remove/);
});

test("a plugin of ours with an older cli path is updated in place, after a backup, and is never duplicated", () => {
  const h = harness();
  installer.install(h.ctx);
  const moved = harness({ home: h.home, cli: CLI_B });
  assert.equal(installer.status(moved.ctx).state, "partly wired");
  assert.match(installer.status(moved.ctx).detail.join(" "), /out of date or points at another agentsocks install/);
  installer.install(moved.ctx);
  assert.deepEqual(moved.backups, [pluginFile(h.home)]);
  assert.deepEqual(readdirSync(join(configDir(h.home), "plugins")), ["agentsocks.js"]);
  const text = readFileSync(pluginFile(h.home), "utf8");
  assert.ok(text.includes(JSON.stringify(CLI_B)) && !text.includes(CLI_A));
  assert.match(moved.log.join("\n"), /updated plugin/);
  assert.equal(installer.status(moved.ctx).state, "wired");
});

test("uninstall deletes only a file that carries our marker and leaves everything else byte-identical", () => {
  const h = harness();
  userConfig(h.home);
  const before = snapshot(configDir(h.home));
  installer.install(h.ctx);
  const un = harness({ home: h.home });
  installer.uninstall(un.ctx);
  assert.deepEqual(snapshot(configDir(h.home)), before);
  assert.deepEqual(un.backups, [pluginFile(h.home)]);
  assert.match(un.log.join("\n"), /opencode: removed .*agentsocks\.js/);

  const foreign = harness();
  mkdirSync(join(configDir(foreign.home), "plugins"), { recursive: true });
  writeFileSync(pluginFile(foreign.home), "export const NotOurs = async () => ({})\n");
  const kept = snapshot(configDir(foreign.home));
  installer.uninstall(foreign.ctx);
  assert.deepEqual(snapshot(configDir(foreign.home)), kept);
  assert.deepEqual(foreign.log, []);
});

test("uninstall on a machine where nothing of ours is present changes nothing and logs nothing; on a fresh install it removes the folder it made", () => {
  const empty = harness();
  installer.uninstall(empty.ctx);
  assert.equal(existsSync(configDir(empty.home)), false);
  assert.deepEqual(empty.log, []);

  const bare = harness();
  mkdirSync(configDir(bare.home), { recursive: true });
  installer.install(bare.ctx);
  assert.equal(existsSync(join(configDir(bare.home), "plugins")), true);
  installer.uninstall(harness({ home: bare.home }).ctx);
  assert.equal(existsSync(join(configDir(bare.home), "plugins")), false, "the plugins folder install made is gone again");
  assert.equal(existsSync(configDir(bare.home)), false, "and so is the config folder, once nothing is left in it");
});

test("install refuses to overwrite a file of that name that is not ours, and leaves it untouched", () => {
  const h = harness();
  mkdirSync(join(configDir(h.home), "plugins"), { recursive: true });
  writeFileSync(pluginFile(h.home), "export const Mine = async () => ({})\n");
  const before = snapshot(configDir(h.home));
  assert.throws(() => installer.install(h.ctx), /exists and is not an agentsocks plugin; left untouched/);
  assert.deepEqual(snapshot(configDir(h.home)), before);
  assert.equal(installer.status(h.ctx).state, "not wired");
  assert.match(installer.status(h.ctx).detail.join(" "), /is not an agentsocks plugin/);
});

test("status tells not installed, not wired, wired and partly wired apart", () => {
  const none = harness();
  assert.deepEqual(installer.status(none.ctx), { state: "not installed", detail: [] });
  assert.equal(installer.detect(none.ctx), false);

  const withBinary = harness({ binary: true });
  assert.equal(installer.detect(withBinary.ctx), true);
  assert.equal(installer.status(withBinary.ctx).state, "not wired");

  const folder = harness();
  mkdirSync(configDir(folder.home), { recursive: true });
  assert.equal(installer.detect(folder.ctx), true);
  assert.equal(installer.status(folder.ctx).state, "not wired");

  installer.install(folder.ctx);
  assert.equal(installer.status(folder.ctx).state, "wired");
  assert.deepEqual(installer.status(folder.ctx).detail, [pluginFile(folder.home)]);

  writeFileSync(pluginFile(folder.home), `${readFileSync(pluginFile(folder.home), "utf8")}// edited\n`);
  assert.equal(installer.status(folder.ctx).state, "partly wired", "a changed file is not the one we wrote");
});

test("OPENCODE_CONFIG_DIR is where install writes when it is set; uninstall and status look in it and in the global folder; an older copy in the global folder is moved, so two never load", () => {
  const home = tempDir("agentsocks-oc-home-");
  const custom = tempDir("agentsocks-oc-custom-");
  const plain = opencodeInstaller(() => ({}));
  const withEnv = opencodeInstaller(() => ({ OPENCODE_CONFIG_DIR: custom }));
  plain.install(harness({ home }).ctx);
  assert.equal(existsSync(pluginFile(home)), true);

  const h = harness({ home });
  assert.equal(withEnv.status(h.ctx).state, "wired", "OpenCode loads the global folder too, so it is wired");
  withEnv.install(h.ctx);
  assert.equal(existsSync(join(custom, "plugins", "agentsocks.js")), true);
  assert.equal(existsSync(pluginFile(home)), false, "the global copy was moved, not duplicated");
  assert.match(h.log.join("\n"), /an older copy/);
  assert.equal(withEnv.status(h.ctx).state, "wired");

  plain.install(harness({ home }).ctx);
  assert.equal(withEnv.status(h.ctx).state, "partly wired");
  assert.match(withEnv.status(h.ctx).detail.join(" "), /two agentsocks plugins would load/);

  withEnv.uninstall(harness({ home }).ctx);
  assert.equal(existsSync(pluginFile(home)), false);
  assert.equal(existsSync(join(custom, "plugins", "agentsocks.js")), false);
});

test("XDG_CONFIG_HOME moves the global folder, and a relative value of either variable is ignored", () => {
  const home = tempDir("agentsocks-oc-home-");
  const xdg = tempDir("agentsocks-oc-xdg-");
  opencodeInstaller(() => ({ XDG_CONFIG_HOME: xdg })).install(harness({ home }).ctx);
  assert.equal(existsSync(join(xdg, "opencode", "plugins", "agentsocks.js")), true);
  assert.equal(existsSync(configDir(home)), false);

  const other = tempDir("agentsocks-oc-home-");
  opencodeInstaller(() => ({ XDG_CONFIG_HOME: "relative/dir", OPENCODE_CONFIG_DIR: "also/relative" })).install(harness({ home: other }).ctx);
  assert.equal(existsSync(pluginFile(other)), true);
});

test("a registry install and doctor report reach the OpenCode installer: the dry run names the file and the report carries the state and the untested label", () => {
  const log: string[] = [];
  installAgents(["opencode"], true, log, [opencodeAgent]);
  assert.match(log.join("\n"), /^opencode \(dry run\): would write .*agentsocks\.js$/);
  const [report] = agentReports([opencodeAgent]);
  assert.equal(report!.id, "opencode");
  assert.equal(report!.live, "untested");
  assert.ok(["not wired", "not installed"].includes(report!.status.state), "nothing was written, so it is not wired whether or not OpenCode is on this machine's PATH");
  const gone: string[] = [];
  uninstallAgents(true, gone, [opencodeAgent]);
  assert.ok(gone.every((l) => l.startsWith("opencode")));
});

test("the plugin generator throws for a tool it cannot describe, so an install fails loudly instead of writing a plugin without that tool", async () => {
  const { z } = await import("zod");
  const { pluginSource } = await import("../src/agents/opencode/plugin.ts");
  const bad = [{ name: "later_tool", title: "x", description: "from another stream", inputSchema: { items: z.record(z.string()) }, host: "both" as const, handler: async () => ({ content: [] }) }];
  assert.throws(() => pluginSource({ node: "/usr/bin/node", cli: CLI_A, tools: bad }), /cannot describe items to OpenCode: unsupported zod type ZodRecord/);
});
