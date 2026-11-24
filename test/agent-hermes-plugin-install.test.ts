import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./tmp.ts";
import { hermesAgent } from "../src/agents/hermes.ts";
import { PLUGIN_MARKER } from "../src/agents/hermes/plugin.ts";
import type { InstallContext } from "../src/agents/types.ts";

const hasPyYaml = spawnSync("python3", ["-I", "-c", "import yaml"], { stdio: "ignore" }).status === 0;
const installer = hermesAgent.installer;
const ALLOW = "config set plugins.entries.agentsocks.allow_gateway_injection true";
const ENABLE = "plugins enable agentsocks";
const DISABLE = "plugins disable agentsocks";
const DISALLOW = "config unset plugins.entries.agentsocks.allow_gateway_injection";

let home: string;
let bin: string;
let calls: string;
const saved = { PATH: process.env.PATH, HERMES_HOME: process.env.HERMES_HOME };

beforeEach(() => {
  home = tempDir("hermes-plugin-home-");
  bin = tempDir("hermes-fake-bin-");
  calls = join(bin, "calls.log");
  // A fake hermes that records its arguments and the HERMES_HOME it was given, and fails when told to.
  writeFileSync(join(bin, "hermes"), `#!/bin/sh\nprintf '%s|%s\\n' "$HERMES_HOME" "$*" >> '${calls}'\n[ -f '${join(bin, "fail")}' ] && exit 2\nexit 0\n`);
  chmodSync(join(bin, "hermes"), 0o755);
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  delete process.env.HERMES_HOME;
});

afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.HERMES_HOME === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = saved.HERMES_HOME;
});

function rig(opts: { dryRun?: boolean; binary?: boolean } = {}): { ctx: InstallContext; log: string[] } {
  const log: string[] = [];
  const ctx: InstallContext = {
    dryRun: opts.dryRun ?? false,
    home,
    log,
    hasBinary: (name) => name === "hermes" && (opts.binary ?? true),
    command: (...args) => ["/usr/bin/node", "/opt/agentsocks/src/cli.ts", ...args],
    backup: () => {},
  };
  return { ctx, log };
}

const hermes = (): string => join(home, ".hermes");
const plugin = (name = ""): string => join(hermes(), "plugins", "agentsocks", name);
const ran = (): string[] => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);
const seed = (text: string): void => {
  mkdirSync(hermes(), { recursive: true });
  writeFileSync(join(hermes(), "config.yaml"), text);
};
const ENABLED = "plugins:\n  enabled:\n  - agentsocks\n  entries:\n    agentsocks:\n      allow_gateway_injection: true\n";

test("a dry run writes nothing, runs nothing, and names the plugin folder and both Hermes commands", () => {
  mkdirSync(hermes());
  const r = rig({ dryRun: true });
  installer.install(r.ctx);
  assert.ok(!existsSync(plugin()));
  assert.ok(!existsSync(join(hermes(), "config.yaml")));
  assert.deepEqual(ran(), []);
  const log = r.log.join("\n");
  assert.match(log, new RegExp(`would write the agentsocks plugin to ${plugin().replace(/\/$/, "")}`));
  assert.match(log, new RegExp(`would run .hermes ${ALLOW}., then .hermes ${ENABLE}.`));
});

test("install writes the plugin, private and marked, then allows injection and enables it through Hermes's own CLI, in that Hermes home", () => {
  mkdirSync(hermes());
  const r = rig();
  installer.install(r.ctx);
  for (const name of ["plugin.yaml", "__init__.py"]) {
    const text = readFileSync(plugin(name), "utf8");
    assert.ok(text.startsWith(PLUGIN_MARKER), name);
    assert.equal(statSync(plugin(name)).mode & 0o777, 0o600, name);
  }
  assert.equal(statSync(plugin()).mode & 0o777, 0o700);
  const code = readFileSync(plugin("__init__.py"), "utf8");
  assert.match(code, /^NODE = "\/usr\/bin\/node"$/m);
  assert.match(code, /^CLI = "\/opt\/agentsocks\/src\/cli\.ts"$/m);
  assert.match(readFileSync(plugin("plugin.yaml"), "utf8"), /^name: agentsocks$/m);
  assert.deepEqual(ran(), [`${hermes()}|${ALLOW}`, `${hermes()}|${ENABLE}`]);
  assert.match(r.log.join("\n"), /ran .hermes plugins enable agentsocks./);
});

test("HERMES_HOME moves the plugin and is the home the Hermes commands are given", () => {
  const elsewhere = tempDir("hermes-elsewhere-");
  process.env.HERMES_HOME = elsewhere;
  installer.install(rig().ctx);
  assert.ok(existsSync(join(elsewhere, "plugins", "agentsocks", "__init__.py")));
  assert.deepEqual(ran(), [`${elsewhere}|${ALLOW}`, `${elsewhere}|${ENABLE}`]);
});

test("a config that already enables the plugin reloads it when install rewrites it, and runs no Hermes command when nothing changed", { skip: !hasPyYaml }, () => {
  seed(ENABLED);
  installer.install(rig().ctx);
  assert.deepEqual(ran(), [`${hermes()}|${DISABLE}`, `${hermes()}|${ENABLE}`], "a running Hermes loads the new plugin");
  installer.install(rig().ctx);
  assert.equal(ran().length, 2, "an unchanged plugin is not reloaded");
  const s = installer.status(rig().ctx);
  assert.match(s.detail.join("; "), /is enabled and may start turns/);
});

test("without the hermes command, or when it fails, the plugin is still written and the log names the commands to run", () => {
  mkdirSync(hermes());
  const none = rig({ binary: false });
  installer.install(none.ctx);
  assert.ok(existsSync(plugin("__init__.py")));
  assert.deepEqual(ran(), []);
  assert.match(none.log.join("\n"), new RegExp(`not on the PATH.*run .hermes ${ALLOW}., then .hermes ${ENABLE}.`));
  writeFileSync(join(bin, "fail"), "");
  const failing = rig();
  installer.install(failing.ctx);
  assert.equal(ran().length, 1, "the first failure stops the rest");
  assert.match(failing.log.join("\n"), new RegExp(`.hermes ${ALLOW}. exited with 2; .*run .hermes ${ALLOW}., then .hermes ${ENABLE}.`));
});

test("status says what is missing: no plugin, a plugin Hermes has not enabled, and one it may not let start turns", { skip: !hasPyYaml }, () => {
  mkdirSync(hermes());
  const r = rig({ binary: false });
  installer.install(r.ctx);
  const s = installer.status(r.ctx).detail.join("; ");
  assert.match(s, /not enabled.*hermes plugins enable agentsocks/);
  assert.match(s, /may not start turns.*allow_gateway_injection true/);
  writeFileSync(plugin("__init__.py"), "def register(ctx):\n    pass\n");
  assert.match(installer.status(r.ctx).detail.join("; "), /holds files agentsocks did not write/);
  rmSync(plugin(), { recursive: true });
  const gone = installer.status(r.ctx);
  assert.equal(gone.state, "partly wired");
  assert.match(gone.detail.join("; "), /plugin is not in .*plugins\/agentsocks.*agentsocks install --hermes/);
});

test("install refuses to overwrite a plugin of that name that agentsocks did not write, before it changes anything", () => {
  mkdirSync(plugin(), { recursive: true });
  writeFileSync(plugin("__init__.py"), "def register(ctx):\n    pass\n");
  assert.throws(() => installer.install(rig().ctx), /not part of the agentsocks plugin; left untouched/);
  assert.equal(readFileSync(plugin("__init__.py"), "utf8"), "def register(ctx):\n    pass\n");
  assert.ok(!existsSync(join(hermes(), "config.yaml")));
  assert.deepEqual(ran(), []);
});

test("uninstall disables the plugin and drops the injection grant through Hermes, then deletes only the files that carry the marker", () => {
  mkdirSync(hermes());
  installer.install(rig().ctx);
  seed(`${readFileSync(join(hermes(), "config.yaml"), "utf8")}${ENABLED}`);
  writeFileSync(plugin("plugin.yaml"), "name: agentsocks\n# edited by hand\n");
  writeFileSync(plugin("notes.txt"), "mine\n");
  mkdirSync(join(hermes(), "plugins", "other"));
  writeFileSync(join(hermes(), "plugins", "other", "__init__.py"), `${PLUGIN_MARKER}\n`);
  writeFileSync(calls, "");
  const dry = rig({ dryRun: true });
  installer.uninstall(dry.ctx);
  assert.ok(existsSync(plugin("__init__.py")));
  assert.deepEqual(ran(), []);
  assert.match(dry.log.join("\n"), new RegExp(`would run .hermes ${DISABLE}., then .hermes ${DISALLOW}.`));
  installer.uninstall(rig().ctx);
  assert.deepEqual(ran(), [`${hermes()}|${DISABLE}`, `${hermes()}|${DISALLOW}`]);
  assert.deepEqual(readdirSync(plugin()).sort(), ["notes.txt", "plugin.yaml"]);
  assert.equal(readFileSync(plugin("plugin.yaml"), "utf8"), "name: agentsocks\n# edited by hand\n");
  assert.ok(existsSync(join(hermes(), "plugins", "other", "__init__.py")), "another plugin's folder is never touched");
});

test("uninstall of a clean install removes the plugin folder it made", () => {
  mkdirSync(hermes());
  installer.install(rig().ctx);
  installer.uninstall(rig().ctx);
  assert.ok(!existsSync(plugin()));
  assert.ok(existsSync(join(hermes(), "plugins")));
});
