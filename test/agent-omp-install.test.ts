import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ompInstaller } from "../src/agents/omp/installer.ts";
import { EXTENSION_MARKER, extensionSource } from "../src/agents/omp/extension.ts";
import { ompAgent } from "../src/agents/omp.ts";
import type { InstallContext } from "../src/agents/types.ts";
import { agentReports, installAgents, uninstallAgents } from "../src/install.ts";
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
  const home = opts.home ?? tempDir("agentsocks-omp-home-");
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

const root = (home: string) => join(home, ".omp");
const agentDir = (home: string) => join(root(home), "agent");
const extensionFile = (home: string) => join(agentDir(home), "extensions", "agentsocks.ts");

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

const USERS_CONFIG = "# my settings\ntools:\n  approvalMode: write\nenabledProviders: []\n";

function userConfig(home: string): void {
  mkdirSync(join(agentDir(home), "extensions"), { recursive: true });
  writeFileSync(join(agentDir(home), "config.yml"), USERS_CONFIG);
  writeFileSync(join(agentDir(home), "agent.db"), "not a real database");
  writeFileSync(join(agentDir(home), "extensions", "mine.ts"), "export default function mine() {}\n");
  chmodSync(join(agentDir(home), "config.yml"), 0o640);
}

const VERSION_TESTED = "omp/18.10.3";
const installerWith = (env: NodeJS.ProcessEnv = {}, version: string | null = VERSION_TESTED) => ompInstaller(() => env, () => version ?? undefined);
const installer = installerWith();

test("install writes one generated extension file whose first line marks it as ours, and nothing else in the user's OMP folder changes", () => {
  const h = harness();
  userConfig(h.home);
  const before = snapshot(root(h.home));
  installer.install(h.ctx);
  const after = snapshot(root(h.home));
  const added = Object.keys(after).filter((k) => !(k in before));
  assert.deepEqual(added, ["agent/extensions/agentsocks.ts"]);
  for (const [path, content] of Object.entries(before)) assert.equal(after[path], content, `${path} is byte-identical`);
  const text = readFileSync(extensionFile(h.home), "utf8");
  assert.ok(text.startsWith(EXTENSION_MARKER), "marker on the first line");
  assert.ok(text.includes(JSON.stringify(CLI_A)), "the cli path is baked in");
  assert.ok(text.includes(JSON.stringify("/usr/bin/node")), "the node path is baked in");
  assert.equal(text, extensionSource({ node: "/usr/bin/node", cli: CLI_A }));
  assert.equal(statSync(extensionFile(h.home)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(agentDir(h.home), "extensions")).sort(), ["agentsocks.ts", "mine.ts"], "no temp file is left behind");
  assert.deepEqual(h.backups, [], "nothing existed to back up");
  assert.match(h.log.join("\n"), /omp: wrote extension .*agentsocks\.ts/);
});

test("install twice changes nothing the second time and says so", () => {
  const h = harness();
  userConfig(h.home);
  installer.install(h.ctx);
  const once = snapshot(root(h.home));
  const second = harness({ home: h.home });
  installer.install(second.ctx);
  assert.deepEqual(snapshot(root(h.home)), once);
  assert.match(second.log.join("\n"), /already installed, unchanged/);
  assert.deepEqual(second.backups, []);
});

test("a dry run writes nothing, not even the folder, and says what it would do", () => {
  const h = harness({ dryRun: true });
  installer.install(h.ctx);
  assert.equal(existsSync(root(h.home)), false);
  assert.match(h.log.join("\n"), /omp \(dry run\): would write .*agentsocks\.ts/);

  const real = harness({ home: h.home });
  installer.install(real.ctx);
  const dry = harness({ home: h.home, dryRun: true, cli: CLI_B });
  const before = snapshot(root(h.home));
  installer.install(dry.ctx);
  assert.deepEqual(snapshot(root(h.home)), before);
  assert.match(dry.log.join("\n"), /would update/);
  const gone = harness({ home: h.home, dryRun: true });
  installer.uninstall(gone.ctx);
  assert.deepEqual(snapshot(root(h.home)), before);
  assert.match(gone.log.join("\n"), /would remove/);
});

test("an extension of ours with an older cli path is updated in place, after a backup, and is never duplicated", () => {
  const h = harness();
  installer.install(h.ctx);
  const moved = harness({ home: h.home, cli: CLI_B });
  assert.equal(installer.status(moved.ctx).state, "partly wired");
  assert.match(installer.status(moved.ctx).detail.join(" "), /out of date or points at another agentsocks install/);
  installer.install(moved.ctx);
  assert.deepEqual(moved.backups, [extensionFile(h.home)]);
  assert.deepEqual(readdirSync(join(agentDir(h.home), "extensions")), ["agentsocks.ts"]);
  const text = readFileSync(extensionFile(h.home), "utf8");
  assert.ok(text.includes(JSON.stringify(CLI_B)) && !text.includes(CLI_A));
  assert.match(moved.log.join("\n"), /updated extension/);
  assert.equal(installer.status(moved.ctx).state, "wired");
});

test("uninstall deletes only a file that carries our marker and leaves everything else byte-identical", () => {
  const h = harness();
  userConfig(h.home);
  const before = snapshot(root(h.home));
  installer.install(h.ctx);
  const un = harness({ home: h.home });
  installer.uninstall(un.ctx);
  assert.deepEqual(snapshot(root(h.home)), before);
  assert.deepEqual(un.backups, [extensionFile(h.home)]);
  assert.match(un.log.join("\n"), /omp: removed .*agentsocks\.ts/);

  const foreign = harness();
  mkdirSync(join(agentDir(foreign.home), "extensions"), { recursive: true });
  writeFileSync(extensionFile(foreign.home), "export default function notOurs() {}\n");
  const kept = snapshot(root(foreign.home));
  installer.uninstall(foreign.ctx);
  assert.deepEqual(snapshot(root(foreign.home)), kept);
  assert.deepEqual(foreign.log, []);
});

test("uninstall on a machine where nothing of ours is present changes nothing and logs nothing; on a fresh install it removes the extensions folder it made and nothing above it", () => {
  const empty = harness();
  installer.uninstall(empty.ctx);
  assert.equal(existsSync(root(empty.home)), false);
  assert.deepEqual(empty.log, []);

  const bare = harness();
  mkdirSync(root(bare.home), { recursive: true });
  installer.install(bare.ctx);
  assert.equal(existsSync(join(agentDir(bare.home), "extensions")), true);
  installer.uninstall(harness({ home: bare.home }).ctx);
  assert.equal(existsSync(join(agentDir(bare.home), "extensions")), false, "the extensions folder install made is gone again");
  assert.equal(existsSync(root(bare.home)), true, "and no folder above it is touched");

  const used = harness();
  userConfig(used.home);
  installer.install(used.ctx);
  installer.uninstall(harness({ home: used.home }).ctx);
  assert.equal(existsSync(join(agentDir(used.home), "config.yml")), true, "the user's files keep their folders");
});

test("install refuses to overwrite a file of that name that is not ours, and leaves it untouched", () => {
  const h = harness();
  mkdirSync(join(agentDir(h.home), "extensions"), { recursive: true });
  writeFileSync(extensionFile(h.home), "export default function mine() {}\n");
  const before = snapshot(root(h.home));
  assert.throws(() => installer.install(h.ctx), /exists and is not an agentsocks extension; left untouched/);
  assert.deepEqual(snapshot(root(h.home)), before);
  assert.equal(installer.status(h.ctx).state, "not wired");
  assert.match(installer.status(h.ctx).detail.join(" "), /is not an agentsocks extension/);
});

test("status tells not installed, not wired, wired and partly wired apart", () => {
  const none = harness();
  assert.deepEqual(installer.status(none.ctx), { state: "not installed", detail: [] });
  assert.equal(installer.detect(none.ctx), false);

  const withBinary = harness({ binary: true });
  assert.equal(installer.detect(withBinary.ctx), true);
  assert.equal(installer.status(withBinary.ctx).state, "not wired");

  const folder = harness();
  mkdirSync(root(folder.home), { recursive: true });
  assert.equal(installer.detect(folder.ctx), true);
  assert.equal(installer.status(folder.ctx).state, "not wired");

  installer.install(folder.ctx);
  const wired = installer.status(folder.ctx);
  assert.equal(wired.state, "wired");
  assert.equal(wired.detail[0], extensionFile(folder.home));

  writeFileSync(extensionFile(folder.home), `${readFileSync(extensionFile(folder.home), "utf8")}// edited\n`);
  assert.equal(installer.status(folder.ctx).state, "partly wired", "a changed file is not the one we wrote");
});

test("status names the OMP version it found and what it was tested on, and calls a version outside the tested major partly wired", () => {
  const h = harness();
  installer.install(h.ctx);
  assert.match(installer.status(h.ctx).detail.join("; "), /OMP 18\.10\.3 \(the version this extension was written against\)/);

  const minor = installerWith({}, "omp/18.14.0").status(h.ctx);
  assert.equal(minor.state, "wired");
  assert.match(minor.detail.join("; "), /OMP 18\.14\.0 \(tested on 18\.10\.3; extension APIs can change between minors, so check the OMP release notes for breaking extension changes if it does not load\)/);

  const major = installerWith({}, "omp/19.0.1").status(h.ctx);
  assert.equal(major.state, "partly wired");
  assert.match(major.detail.join("; "), /OMP 19\.0\.1 is outside the 18\.x range this was tested on; the extension may not load/);

  const unknown = installerWith({}, null).status(h.ctx);
  assert.equal(unknown.state, "wired");
  assert.match(unknown.detail.join("; "), /omp is not on PATH or did not print a version, so the version was not checked/);

  const odd = installerWith({}, "something else entirely").status(h.ctx);
  assert.equal(odd.state, "wired");
  assert.match(odd.detail.join("; "), /did not print a version/);
});

test("PI_CODING_AGENT_DIR is where install writes when it is set to an absolute path, PI_CONFIG_DIR renames the folder under home, and relative values are ignored", () => {
  const home = tempDir("agentsocks-omp-home-");
  const custom = tempDir("agentsocks-omp-agent-");
  const h = harness({ home });
  installerWith({ PI_CODING_AGENT_DIR: custom }).install(h.ctx);
  assert.equal(existsSync(join(custom, "extensions", "agentsocks.ts")), true);
  assert.equal(existsSync(root(home)), false, "the default folder is not touched");
  assert.equal(installerWith({ PI_CODING_AGENT_DIR: custom }).status(h.ctx).state, "wired");
  assert.equal(installerWith({}).status(h.ctx).state, "not installed", "without the variable OMP looks in the default folder, where nothing is");
  installerWith({ PI_CODING_AGENT_DIR: custom }).uninstall(harness({ home }).ctx);
  assert.equal(existsSync(join(custom, "extensions", "agentsocks.ts")), false);
  assert.equal(existsSync(custom), true, "a folder the user named is never removed, only the extensions folder install made");
  assert.equal(existsSync(join(custom, "extensions")), false);

  const renamed = tempDir("agentsocks-omp-home-");
  installerWith({ PI_CONFIG_DIR: ".omp-work" }).install(harness({ home: renamed }).ctx);
  assert.equal(existsSync(join(renamed, ".omp-work", "agent", "extensions", "agentsocks.ts")), true);
  assert.equal(existsSync(root(renamed)), false);

  const other = tempDir("agentsocks-omp-home-");
  installerWith({ PI_CODING_AGENT_DIR: "relative/agent" }).install(harness({ home: other }).ctx);
  assert.equal(existsSync(extensionFile(other)), true);
  assert.equal(existsSync(join(process.cwd(), "relative")), false);
});

test("a named profile (OMP_PROFILE, or PI_PROFILE when that is not set) has its own agent folder, which PI_CODING_AGENT_DIR does not move; uninstall finds every copy", () => {
  const home = tempDir("agentsocks-omp-home-");
  const custom = tempDir("agentsocks-omp-agent-");
  const profiled = installerWith({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: custom });
  profiled.install(harness({ home }).ctx);
  const workFile = join(root(home), "profiles", "work", "agent", "extensions", "agentsocks.ts");
  assert.equal(existsSync(workFile), true);
  assert.equal(existsSync(join(custom, "extensions")), false);
  assert.equal(profiled.status(harness({ home }).ctx).state, "wired");

  installerWith({ PI_PROFILE: "play" }).install(harness({ home }).ctx);
  assert.equal(existsSync(join(root(home), "profiles", "play", "agent", "extensions", "agentsocks.ts")), true);

  installerWith({ OMP_PROFILE: "", PI_PROFILE: "play" }).install(harness({ home }).ctx);
  assert.equal(existsSync(extensionFile(home)), true, "an empty OMP_PROFILE selects the default profile");

  installerWith({ OMP_PROFILE: "default" }).install(harness({ home }).ctx);
  installerWith({ OMP_PROFILE: "../escape" }).install(harness({ home }).ctx);
  assert.equal(existsSync(join(home, "escape")), false);

  const un = harness({ home });
  installer.uninstall(un.ctx);
  assert.equal(existsSync(workFile), false);
  assert.equal(existsSync(join(root(home), "profiles", "play", "agent", "extensions", "agentsocks.ts")), false);
  assert.equal(existsSync(extensionFile(home)), false);
  assert.equal(un.backups.length, 3);
});

test("status warns when OMP is set to read Claude Code's or Codex's config, where agentsocks registered servers that cannot tell an OMP session from their own", () => {
  const h = harness();
  installer.install(h.ctx);
  const detail = () => installer.status(h.ctx).detail.join("; ");
  assert.doesNotMatch(detail(), /warning/);

  const config = join(agentDir(h.home), "config.yml");
  writeFileSync(config, "enabledProviders:\n  - claude\n  - gemini\n");
  assert.match(detail(), /warning: OMP also reads Claude Code's config .*list claude under disabledProviders/);
  assert.doesNotMatch(detail(), /Codex/);

  writeFileSync(config, "enabledProviders:\n- claude\n");
  assert.match(detail(), /warning: OMP also reads Claude Code's config/, "a sequence written at the key's own indent is still its list");

  writeFileSync(config, "enabledProviders: [codex, 'cursor']\n");
  assert.match(detail(), /warning: OMP also reads Codex's config/);

  writeFileSync(config, 'enabledProviders: ["*"]\n');
  assert.match(detail(), /Claude Code's config/);
  assert.match(detail(), /Codex's config/);

  writeFileSync(config, "enabledProviders:\n  - all\ndisabledProviders:\n  - claude\n  - codex\n");
  assert.doesNotMatch(detail(), /warning/, "disabledProviders wins");

  writeFileSync(config, "enabledProviders: []\n");
  assert.doesNotMatch(detail(), /warning/);
  assert.match(installerWith({ CLAUDE_CONFIG_DIR: "/somewhere" }).status(h.ctx).detail.join("; "), /Claude Code's config/);
  assert.doesNotMatch(installerWith({ CLAUDE_CONFIG_DIR: "  " }).status(h.ctx).detail.join("; "), /warning/);

  writeFileSync(config, "# enabledProviders:\n#  - claude\ntools:\n  enabledProviders:\n    - claude\n");
  assert.doesNotMatch(detail(), /warning/, "a comment or a nested key of that name is not the setting");
});

test("an install says in its log when OMP is set to read Claude Code's config, and a config.yml that cannot be read changes nothing about the install", () => {
  const h = harness();
  mkdirSync(agentDir(h.home), { recursive: true });
  writeFileSync(join(agentDir(h.home), "config.yml"), "enabledProviders:\n  - claude\n");
  installer.install(h.ctx);
  assert.match(h.log.join("\n"), /omp: warning: OMP also reads Claude Code's config/);

  const broken = harness();
  mkdirSync(join(agentDir(broken.home), "config.yml"), { recursive: true });
  installer.install(broken.ctx);
  assert.equal(existsSync(extensionFile(broken.home)), true);
  assert.equal(installer.status(broken.ctx).state, "wired");
});

test("a registry install and doctor report reach the OMP installer: the dry run names the file and the report carries the state and the untested label", () => {
  const log: string[] = [];
  installAgents(["omp"], true, log, [ompAgent]);
  assert.match(log.join("\n"), /^omp \(dry run\): would write .*agentsocks\.ts$/);
  const [report] = agentReports([ompAgent]);
  assert.equal(report!.id, "omp");
  assert.equal(report!.live, "untested");
  assert.ok(["not wired", "not installed"].includes(report!.status.state), "nothing was written, so it is not wired whether or not OMP is on this machine's PATH");
  const gone: string[] = [];
  uninstallAgents(true, gone, [ompAgent]);
  assert.ok(gone.every((l) => l.startsWith("omp")));
});

test("the generator throws for a tool it cannot describe, naming OMP, so an install fails loudly instead of writing an extension without that tool", async () => {
  const { z } = await import("zod");
  const bad = [{ name: "later_tool", title: "x", description: "from another stream", inputSchema: { items: z.record(z.string()) }, host: "both" as const, handler: async () => ({ content: [] }) }];
  assert.throws(() => extensionSource({ node: "/usr/bin/node", cli: CLI_A, tools: bad }), /cannot describe items to OMP: unsupported zod type ZodRecord/);
});

test("uninstall through a symlinked extensions folder or a symlinked file removes what is ours without throwing and leaves no generated copy behind", () => {
  const linked = harness();
  const elsewhere = tempDir("omp-elsewhere-");
  mkdirSync(agentDir(linked.home), { recursive: true });
  symlinkSync(elsewhere, join(agentDir(linked.home), "extensions"));
  installer.install(linked.ctx);
  assert.equal(existsSync(join(elsewhere, "agentsocks.ts")), true);
  const un = harness({ home: linked.home });
  installer.uninstall(un.ctx);
  assert.equal(existsSync(join(elsewhere, "agentsocks.ts")), false);
  assert.equal(lstatSync(join(agentDir(linked.home), "extensions")).isSymbolicLink(), true, "the user's link stays");
  assert.deepEqual(un.log.filter((l) => !l.startsWith("omp: removed")), []);

  const filed = harness();
  const target = join(tempDir("omp-dotfiles-"), "agentsocks.ts");
  mkdirSync(join(agentDir(filed.home), "extensions"), { recursive: true });
  symlinkSync(target, extensionFile(filed.home));
  installer.install(filed.ctx);
  assert.equal(readFileSync(target, "utf8").startsWith(EXTENSION_MARKER), true, "install wrote through the link");
  installer.uninstall(harness({ home: filed.home }).ctx);
  assert.equal(existsSync(target), false, "the generated file behind the link went with it");
  assert.equal(existsSync(extensionFile(filed.home)), false);
});
