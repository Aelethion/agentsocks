import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { livePid, shimmedEnv } from "./support.ts";
import { reapPidFile } from "./procs.ts";
import { install, uninstall } from "../src/install.ts";
import { ENTRYPOINT, listAgentsEnabled } from "../src/claudelist.ts";
import { listClaudeSessions } from "../src/claude.ts";
import { configPath } from "../src/paths.ts";
import { SWEEP_STAGES } from "../src/sweep/index.ts";
import { fakeClaude } from "./support.ts";
import { closeServer } from "../src/ccsocks.ts";
import { tempDir } from "./tmp.ts";

const options = { claude: false, codexMcp: false, codexHooks: false, trustHooks: false, dryRun: false };

test("a plain install leaves Claude ListAgents off, and --claude-listagents turns it on and says what it does and that it is untested", async () => {
  const plain = await install({ ...options });
  assert.equal(listAgentsEnabled({}), false);
  assert.ok(!plain.some((l) => /listagents/.test(l)));
  const log = await install({ ...options, claudeListAgents: true });
  assert.equal(listAgentsEnabled({}), true);
  assert.equal(JSON.parse(readFileSync(configPath(), "utf8")).claudeListAgents, true);
  assert.match(log.join("\n"), /claude listagents: set claudeListAgents/);
  assert.match(log.join("\n"), /experimental and untested live/);
  assert.match((await install({ ...options, claudeListAgents: true })).join("\n"), /already on, unchanged/);
});

test("uninstall turns it off and keeps the other config keys; a dry run changes nothing", async () => {
  writeFileSync(configPath(), `${JSON.stringify({ classifier: { backend: "none" }, claudeListAgents: true })}\n`);
  assert.ok(uninstall(true).some((l) => /would turn it off/.test(l)));
  assert.equal(listAgentsEnabled({}), true);
  const log = uninstall(false);
  assert.match(log.join("\n"), /removed claudeListAgents/);
  assert.deepEqual(JSON.parse(readFileSync(configPath(), "utf8")), { classifier: { backend: "none" } });
});

test("a dry run of install --claude-listagents writes nothing", async () => {
  rmSync(configPath(), { force: true });
  const log = await install({ ...options, claudeListAgents: true, dryRun: true });
  assert.match(log.join("\n"), /claude listagents \(dry run\)/);
  assert.equal(existsSync(configPath()), false);
});

test("a registry record agentsocks wrote is not a Claude session, so a Codex thread is listed once, as a Codex thread", async () => {
  const real = await fakeClaude("real-claude", livePid(), "idle");
  try {
    const dir = dirname(join(process.env.AGENTSOCKS_CLAUDE_SESSIONS_DIR!, "x"));
    const holder = livePid();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${holder}.json`), JSON.stringify({ pid: holder, sessionId: "019e2f00-0000-7000-8000-000000000009", cwd: "/work/web", name: "codex-web-0009", kind: "interactive", entrypoint: ENTRYPOINT, messagingSocketPath: real.socketPath }));
    const names = listClaudeSessions().map((s) => s.name);
    assert.deepEqual(names, ["real-claude"]);
  } finally {
    await closeServer(real.server);
  }
});

test("the sweep runs the ListAgents stage, which does nothing while the switch is off", () => {
  assert.ok(SWEEP_STAGES.some((s) => s.name === "claude listagents"));
});

function stopBrokersOf(runtime: string): void {
  reapPidFile(runtime);
}

test("the command line: install --claude-listagents --dry-run, and doctor says whether it is on", () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
  const runtime = tempDir("asr-");
  const env = { ...process.env, ...shimmedEnv(), NODE_NO_WARNINGS: "1", AGENTSOCKS_RUNTIME_DIR: runtime, AGENTSOCKS_STATE_DIR: tempDir("ass-") };
  try {
    const dry = spawnSync(process.execPath, [cli, "install", "--claude-listagents", "--dry-run"], { env, encoding: "utf8" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /claude listagents \(dry run\)/);
    const doctor = spawnSync(process.execPath, [cli, "doctor"], { env, encoding: "utf8" });
    assert.match(doctor.stdout, process.platform === "linux" ? /Claude ListAgents \(experimental, untested live\): off/ : /Claude ListAgents \(experimental, untested live\): not available on darwin in this release/);
  } finally {
    stopBrokersOf(runtime);
  }
});
