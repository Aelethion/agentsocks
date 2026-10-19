import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { install, type RunLog } from "../src/install.ts";
import { cliEntry } from "../src/client.ts";
import { tempDir } from "./tmp.ts";

const options = { claude: false, codexMcp: true, codexHooks: true, trustHooks: false, dryRun: false, codexOptional: true } as const;

async function withEnv(env: Record<string, string | undefined>, body: () => Promise<RunLog>): Promise<RunLog> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function oldCheckout(dir: string, name: string): string {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "cli.js"), "old build");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.3.1" }));
  return join(dir, "dist", "cli.js");
}

function staleConfig(cli: string): string {
  return `[mcp_servers.agentsocks]\ncommand = "/usr/bin/node"\nargs = [${JSON.stringify(cli)}, "mcp", "--host", "codex"]\n`;
}

function runInstall(home: string, codexHome: string | undefined, emptyBin: string): Promise<RunLog> {
  return withEnv({ HOME: home, PATH: emptyBin, CODEX_HOME: codexHome }, () => install({ ...options }));
}

test("a stale codex entry pointing at an agentsocks build outside a folder named agentsocks is replaced", async () => {
  const oldCli = oldCheckout(tempDir("oldbuild-"), "agentsocks");
  assert.ok(!oldCli.includes("agentsocks"), `fixture path must avoid the old literal match: ${oldCli}`);
  const codexHome = tempDir("codexhome-");
  writeFileSync(join(codexHome, "config.toml"), staleConfig(oldCli));
  const log = await runInstall(tempDir("home-"), codexHome, tempDir("emptybin-"));
  const current = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.ok(current.includes(cliEntry()), `config still points at the old build:\n${current}`);
  assert.ok(log.some((l) => l.includes("updated [mcp_servers.agentsocks]") && l.includes("to this install")), log.join("\n"));
});

test("a codex entry pointing at another tool's cli.js is left alone", async () => {
  const otherCli = oldCheckout(tempDir("otherbuild-"), "something-else");
  const codexHome = tempDir("codexhome-");
  writeFileSync(join(codexHome, "config.toml"), staleConfig(otherCli));
  const log = await runInstall(tempDir("home-"), codexHome, tempDir("emptybin-"));
  const current = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.ok(current.includes(otherCli), `foreign entry was touched:\n${current}`);
  assert.ok(log.some((l) => l.includes("already present") && l.includes("left as is")), log.join("\n"));
});

test("a bin symlink into another agentsocks checkout is re-pointed at this install", async () => {
  const home = tempDir("home-");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const otherCli = oldCheckout(tempDir("othercopy-"), "agentsocks");
  const link = join(home, ".local", "bin", "agentsocks");
  symlinkSync(otherCli, link);
  const log = await runInstall(home, undefined, tempDir("emptybin-"));
  assert.equal(readlinkSync(link), cliEntry());
  assert.ok(log.some((l) => l.includes("re-pointed") || l.includes("re-point")), log.join("\n"));
});

test("a bin symlink into another tool is left alone", async () => {
  const home = tempDir("home-");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const otherCli = oldCheckout(tempDir("foreigncopy-"), "something-else");
  const link = join(home, ".local", "bin", "agentsocks");
  symlinkSync(otherCli, link);
  const log = await runInstall(home, undefined, tempDir("emptybin-"));
  assert.equal(readlinkSync(link), otherCli);
  assert.ok(log.some((l) => l.includes("not ours, left alone")), log.join("\n"));
});

test("a codex folder with no codex or claude binary counts as an agent present", async () => {
  const codexHome = tempDir("codexhome-");
  const log = await runInstall(tempDir("home-"), codexHome, tempDir("emptybin-"));
  assert.equal(log.failed, undefined, log.join("\n"));
  assert.ok(existsSync(join(codexHome, "config.toml")), log.join("\n"));
  assert.ok(existsSync(join(codexHome, "hooks.json")), log.join("\n"));
});

test("a machine with nothing found and nothing wired still fails naming what to install first", async () => {
  const missing = join(tempDir("codexgone-"), ".codex");
  const log = await runInstall(tempDir("home-"), missing, tempDir("emptybin-"));
  assert.equal(log.failed, true, log.join("\n"));
  assert.ok(log.some((l) => l.includes("install the Claude Code CLI") && l.includes("Codex CLI")), log.join("\n"));
});
