import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tempDir } from "./tmp.ts";
import { hermesAgent } from "../src/agents/hermes.ts";
import { wiring } from "../src/agents/hermes/config.ts";
import { addManaged } from "../src/agents/hermes/yaml.ts";
import { agentReports } from "../src/install.ts";
import type { InstallContext } from "../src/agents/types.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/agents/hermes/${name}`, import.meta.url), "utf8");
const hasPyYaml = spawnSync("python3", ["-I", "-c", "import yaml"], { stdio: "ignore" }).status === 0;

const installer = hermesAgent.installer;

interface Rig {
  ctx: InstallContext;
  log: string[];
  backups: string[];
}

function rig(home: string, opts: { dryRun?: boolean; binary?: boolean; cli?: string } = {}): Rig {
  const log: string[] = [];
  const backups: string[] = [];
  const cli = opts.cli ?? "/opt/agentsocks/src/cli.ts";
  const ctx: InstallContext = {
    dryRun: opts.dryRun ?? false,
    home,
    log,
    hasBinary: (name) => name === "hermes" && (opts.binary ?? false),
    command: (...args) => ["/usr/bin/node", cli, ...args],
    backup: (path) => void backups.push(path),
  };
  return { ctx, log, backups };
}

let home: string;
let saved: string | undefined;

beforeEach(() => {
  home = tempDir("hermes-home-");
  saved = process.env.HERMES_HOME;
  delete process.env.HERMES_HOME;
});

afterEach(() => {
  if (saved === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = saved;
});

const config = (): string => join(home, ".hermes", "config.yaml");
const seed = (text: string): void => {
  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(config(), text);
};

function approveAll(r: Rig): void {
  const approvals = wiring(r.ctx).commands.map(({ event, command }) => ({ event, command }));
  writeFileSync(join(home, ".hermes", "shell-hooks-allowlist.json"), JSON.stringify({ approvals }));
}

test("Hermes is found by its config folder, and a program called hermes on the PATH is not enough, since the JavaScript engine of that name is common", () => {
  assert.equal(installer.detect(rig(home).ctx), false);
  assert.equal(installer.detect(rig(home, { binary: true }).ctx), false);
  mkdirSync(join(home, ".hermes"));
  assert.equal(installer.detect(rig(home).ctx), true);
});

test("HERMES_HOME moves everything: detection, the config that is edited, and the consent file that is read", () => {
  const elsewhere = tempDir("hermes-elsewhere-");
  process.env.HERMES_HOME = elsewhere;
  assert.equal(installer.detect(rig(home).ctx), true);
  const r = rig(home);
  installer.install(r.ctx);
  assert.ok(existsSync(join(elsewhere, "config.yaml")));
  assert.ok(!existsSync(join(home, ".hermes")));
  assert.equal(installer.status(r.ctx).state, "partly wired");
  writeFileSync(join(elsewhere, "shell-hooks-allowlist.json"), JSON.stringify({ approvals: wiring(r.ctx).commands }));
  assert.equal(installer.status(r.ctx).state, "wired");
});

test("a leading ~ or $VAR in HERMES_HOME is expanded the way Hermes expands it", () => {
  process.env.HERMES_HOME = "~/custom";
  const r = rig(home);
  installer.install(r.ctx);
  assert.ok(existsSync(join(home, "custom", "config.yaml")));
});

test("install adds the MCP server and the five shell hooks to an existing config, backs it up first, and tells the user what to approve", () => {
  seed(fixture("servers-existing.yaml"));
  const r = rig(home);
  installer.install(r.ctx);
  assert.deepEqual(r.backups, [config()]);
  const text = readFileSync(config(), "utf8");
  assert.match(text, /agentsocks:\n {4}command: "\/usr\/bin\/node"/);
  for (const event of ["pre_llm_call", "pre_tool_call", "pre_verify", "on_session_end", "on_session_finalize"]) assert.match(text, new RegExp(`hook hermes ${event}"`), event);
  assert.match(text, /matcher: "\^mcp_\{1,2\}agentsocks_\{1,2\}\.\*\$"/);
  assert.match(r.log.join("\n"), /hermes: wired .*config\.yaml/);
  assert.match(r.log.join("\n"), /approve the 5 agentsocks hooks.*hermes --accept-hooks chat/i);
  assert.match(r.log.join("\n"), /no API wake configured/);
});

test("the hook commands start with env and the marker, because Hermes runs a hook with shell=False and a bare VAR=1 would be taken for the program", () => {
  seed("");
  installer.install(rig(home).ctx);
  const commands = [...readFileSync(config(), "utf8").matchAll(/command: "(env AGENTSOCKS_HOOK=1 [^"]*hook hermes \w+)"/g)].map((m) => m[1]!);
  assert.equal(commands.length, 5);
  for (const c of commands) assert.match(c, /^env AGENTSOCKS_HOOK=1 .*'\/usr\/bin\/node' '\/opt\/agentsocks\/src\/cli\.ts' hook hermes \w+$/);
});

test("the state locations in this shell are written into the MCP server's env and the hook commands, so both resolve the same stamp key", () => {
  const was = process.env.AGENTSOCKS_STATE_DIR;
  process.env.AGENTSOCKS_STATE_DIR = "/srv/as state";
  try {
    seed("");
    installer.install(rig(home).ctx);
    const text = readFileSync(config(), "utf8");
    assert.match(text, /\n {6}AGENTSOCKS_STATE_DIR: "\/srv\/as state"/);
    assert.equal(text.match(/'AGENTSOCKS_STATE_DIR=\/srv\/as state'/g)?.length, 5);
  } finally {
    if (was === undefined) delete process.env.AGENTSOCKS_STATE_DIR;
    else process.env.AGENTSOCKS_STATE_DIR = was;
  }
});

test("installing a second time changes nothing, writes no backup and says unchanged", () => {
  seed(fixture("hooks-existing.yaml"));
  installer.install(rig(home).ctx);
  const once = readFileSync(config(), "utf8");
  const again = rig(home);
  installer.install(again.ctx);
  assert.equal(readFileSync(config(), "utf8"), once);
  assert.deepEqual(again.backups, []);
  assert.match(again.log.join("\n"), /already present .*unchanged/);
});

test("an install from a different place updates the entries where they are instead of adding a second set", () => {
  seed(fixture("servers-existing.yaml"));
  installer.install(rig(home).ctx);
  const moved = rig(home, { cli: "/srv/agentsocks/dist/cli.js" });
  installer.install(moved.ctx);
  const text = readFileSync(config(), "utf8");
  assert.ok(!text.includes("/opt/agentsocks"));
  assert.equal(text.match(/hook hermes pre_llm_call/g)?.length, 1);
  assert.equal(text.match(/^ {2}agentsocks:/gm)?.length, 1);
  assert.deepEqual(moved.backups, [config()]);
});

test("the config file is created private when there was none, and an existing file keeps its permissions and is not left beside a temp file", () => {
  installer.install(rig(home).ctx);
  assert.equal(statSync(config()).mode & 0o777, 0o600);
  seed(fixture("typical.yaml"));
  chmodSync(config(), 0o640);
  installer.install(rig(home).ctx);
  assert.equal(statSync(config()).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(join(home, ".hermes")), ["config.yaml"]);
});

test("a config.yaml that is a symlink (a dotfiles setup) stays a symlink and its target is the file that is edited and restored", () => {
  const dotfiles = tempDir("hermes-dotfiles-");
  writeFileSync(join(dotfiles, "hermes.yaml"), fixture("typical.yaml"));
  mkdirSync(join(home, ".hermes"));
  symlinkSync(join(dotfiles, "hermes.yaml"), config());
  installer.install(rig(home).ctx);
  assert.ok(lstatSync(config()).isSymbolicLink());
  assert.match(readFileSync(join(dotfiles, "hermes.yaml"), "utf8"), /agentsocks:/);
  installer.uninstall(rig(home).ctx);
  assert.ok(lstatSync(config()).isSymbolicLink());
  assert.equal(readFileSync(join(dotfiles, "hermes.yaml"), "utf8"), fixture("typical.yaml"));
  assert.deepEqual(readdirSync(dotfiles), ["hermes.yaml"]);
});

test("a config.yaml that is a dangling symlink stays a symlink and the file it points at is created", () => {
  const dotfiles = tempDir("hermes-dotfiles-");
  mkdirSync(join(home, ".hermes"));
  symlinkSync(join(dotfiles, "later.yaml"), config());
  installer.install(rig(home).ctx);
  assert.ok(lstatSync(config()).isSymbolicLink());
  assert.match(readFileSync(join(dotfiles, "later.yaml"), "utf8"), /mcp_servers:/);
});

test("a HERMES_HOME that is empty after expansion or relative is refused instead of editing a config.yaml in the current directory", () => {
  for (const value of ["$HERMES_TEST_NOT_SET", "relhome", "~x/y"]) {
    process.env.HERMES_HOME = value;
    const r = rig(home);
    assert.throws(() => installer.install(r.ctx), /HERMES_HOME .* not an absolute path/, value);
    assert.throws(() => installer.uninstall(r.ctx), /HERMES_HOME/, value);
    assert.equal(installer.status(r.ctx).state, "not wired", value);
    assert.equal(installer.detect(r.ctx), false, value);
  }
  assert.ok(!existsSync("relhome") && !existsSync("config.yaml"));
});

test("entries Hermes rewrote without markers are replaced by marked ones and the log says so", { skip: !hasPyYaml }, () => {
  seed(fixture("servers-existing.yaml"));
  installer.install(rig(home).ctx);
  const dumped = spawnSync("python3", ["-I", "-c", "import sys, yaml\nsys.stdout.write(yaml.safe_dump(yaml.safe_load(sys.stdin.read()), default_flow_style=False, sort_keys=False))"], { input: readFileSync(config(), "utf8"), encoding: "utf8" }).stdout;
  writeFileSync(config(), dumped);
  const again = rig(home);
  installer.install(again.ctx);
  assert.match(again.log.join("\n"), /6 agentsocks entries .* had lost their comment markers/);
});

test("a file the editor cannot be sure of is left byte for byte as it was, with the reason in the error and no backup", () => {
  for (const name of ["refuse-tabs.yaml", "refuse-flow-servers.yaml", "refuse-duplicate.yaml", "refuse-multidoc.yaml"]) {
    seed(fixture(name));
    const r = rig(home);
    assert.throws(() => installer.install(r.ctx), /config\.yaml: .*left untouched/, name);
    assert.equal(readFileSync(config(), "utf8"), fixture(name), name);
    assert.deepEqual(r.backups, [], name);
  }
});

test("a dry run reports what it would do and writes nothing", () => {
  seed(fixture("typical.yaml"));
  const r = rig(home, { dryRun: true });
  installer.install(r.ctx);
  assert.equal(readFileSync(config(), "utf8"), fixture("typical.yaml"));
  assert.deepEqual(r.backups, []);
  assert.match(r.log.join("\n"), /hermes \(dry run\): would write .*config\.yaml/);
  const none = rig(home, { dryRun: true });
  mkdirSync(join(home, "fresh"));
  process.env.HERMES_HOME = join(home, "fresh");
  installer.install(none.ctx);
  assert.ok(!existsSync(join(home, "fresh", "config.yaml")));
});

test("uninstall gives back the exact bytes the file had before, for every kind of file", () => {
  for (const name of ["empty.yaml", "comments-only.yaml", "typical.yaml", "servers-existing.yaml", "hooks-existing.yaml", "flow-empty.yaml", "crlf.yaml", "no-final-newline.yaml"]) {
    seed(fixture(name));
    installer.install(rig(home).ctx);
    assert.notEqual(readFileSync(config(), "utf8"), fixture(name), name);
    const r = rig(home);
    installer.uninstall(r.ctx);
    assert.equal(readFileSync(config(), "utf8"), fixture(name), name);
    assert.match(r.log.join("\n"), /hermes: removed agentsocks entries from .*config\.yaml/, name);
  }
});

test("uninstall changes nothing, backs nothing up and says nothing when none of the entries are there or there is no config at all", () => {
  const none = rig(home);
  installer.uninstall(none.ctx);
  assert.deepEqual([none.log, none.backups], [[], []]);
  seed(fixture("foreign-agentsocks.yaml"));
  const r = rig(home);
  installer.uninstall(r.ctx);
  assert.equal(readFileSync(config(), "utf8"), fixture("foreign-agentsocks.yaml"));
  assert.deepEqual([r.log, r.backups], [[], []]);
});

test("a dry run of uninstall removes nothing", () => {
  seed(fixture("typical.yaml"));
  installer.install(rig(home).ctx);
  const installed = readFileSync(config(), "utf8");
  const r = rig(home, { dryRun: true });
  installer.uninstall(r.ctx);
  assert.equal(readFileSync(config(), "utf8"), installed);
  assert.match(r.log.join("\n"), /dry run/);
});

test("status: not installed, then not wired, then partly wired until the hooks are approved, then wired", () => {
  const r = rig(home);
  assert.equal(installer.status(r.ctx).state, "not installed");
  mkdirSync(join(home, ".hermes"));
  assert.equal(installer.status(r.ctx).state, "not wired");
  seed(fixture("typical.yaml"));
  assert.equal(installer.status(r.ctx).state, "not wired");
  installer.install(r.ctx);
  const waiting = installer.status(r.ctx);
  assert.equal(waiting.state, "partly wired");
  assert.match(waiting.detail.join("; "), /approve the 5 agentsocks hooks/i);
  approveAll(r);
  const done = installer.status(r.ctx);
  assert.equal(done.state, "wired");
  assert.match(done.detail.join("; "), /no API wake configured/);
});

test("status counts hooks_auto_accept as consent, and one hook still unapproved keeps it at partly wired", () => {
  seed(`${fixture("typical.yaml")}hooks_auto_accept: true\n`);
  const r = rig(home);
  installer.install(r.ctx);
  assert.equal(installer.status(r.ctx).state, "wired");
  seed(fixture("typical.yaml"));
  installer.install(r.ctx);
  const commands = wiring(r.ctx).commands.slice(1);
  writeFileSync(join(home, ".hermes", "shell-hooks-allowlist.json"), JSON.stringify({ approvals: commands }));
  const partly = installer.status(r.ctx);
  assert.equal(partly.state, "partly wired");
  assert.match(partly.detail.join("; "), /approve the 1 agentsocks hook\b/i);
});

test("status notices entries that point at another agentsocks install, and entries that are missing", () => {
  seed(fixture("typical.yaml"));
  installer.install(rig(home, { cli: "/old/place/cli.js" }).ctx);
  const here = rig(home);
  approveAll(here);
  const stale = installer.status(here.ctx);
  assert.equal(stale.state, "partly wired");
  assert.match(stale.detail.join("; "), /another agentsocks install/);
  const w = wiring(here.ctx);
  const partial = addManaged(fixture("typical.yaml"), { ...w.plan, hooks: w.plan.hooks.filter((h) => h.event !== "pre_verify") });
  assert.ok(partial.ok);
  writeFileSync(config(), partial.ok ? partial.text : "");
  const missing = installer.status(here.ctx);
  assert.equal(missing.state, "partly wired");
  assert.match(missing.detail.join("; "), /pre_verify/);
});

test("status says so when an mcp_servers.agentsocks entry the user wrote is in the way", () => {
  seed(fixture("foreign-agentsocks.yaml"));
  const r = rig(home);
  installer.install(r.ctx);
  assert.match(r.log.join("\n"), /mcp_servers\.agentsocks .*not one agentsocks wrote/);
  approveAll(r);
  const s = installer.status(r.ctx);
  assert.equal(s.state, "partly wired");
  assert.match(s.detail.join("; "), /did not write/);
});

test("the entries are still found after Hermes rewrites its config.yaml without comments", { skip: !hasPyYaml }, () => {
  seed(fixture("servers-existing.yaml"));
  const r = rig(home);
  installer.install(r.ctx);
  const dumped = spawnSync("python3", ["-I", "-c", "import sys, yaml\nsys.stdout.write(yaml.safe_dump(yaml.safe_load(sys.stdin.read()), default_flow_style=False, sort_keys=False))"], { input: readFileSync(config(), "utf8"), encoding: "utf8" }).stdout;
  writeFileSync(config(), dumped);
  approveAll(r);
  assert.equal(installer.status(r.ctx).state, "wired");
  const again = rig(home);
  installer.install(again.ctx);
  assert.equal(readFileSync(config(), "utf8").match(/hook hermes pre_llm_call/g)?.length, 1);
  installer.uninstall(rig(home).ctx);
  assert.ok(!readFileSync(config(), "utf8").includes("agentsocks"));
});

test("the registry's Hermes entry is this module, with the API wake wired in and labelled untested live", async () => {
  const { AGENTS } = await import("../src/agents/index.ts");
  const spec = AGENTS.find((a) => a.id === "hermes");
  assert.equal(spec, hermesAgent);
  assert.equal(spec.live, "untested");
  assert.equal(typeof spec.wake, "function");
  assert.equal(spec.canWake?.(), false, "without a configured Hermes API there is nothing to wake through");
  assert.ok(agentReports().some((r) => r.id === "hermes"));
});
