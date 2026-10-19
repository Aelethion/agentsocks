import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tempDir } from "./tmp.ts";
import { reapPidFile } from "./procs.ts";
import { Store } from "../src/store.ts";
import { agentContext, install, stopOlderBroker } from "../src/install.ts";
import { brokerCall, cliEntry } from "../src/client.ts";
import { dbPath } from "../src/paths.ts";
import { COMMANDS } from "../src/commands/index.ts";
import { helpText } from "../src/commands/help.ts";
import { ompInstaller } from "../src/agents/omp/installer.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const policyPath = fileURLToPath(new URL("../src/gateway/policy.ts", import.meta.url));

const saveEnv = (keys: string[]): Record<string, string | undefined> => Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const restoreEnv = (saved: Record<string, string | undefined>): void => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

async function runCli(env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const r = await exec(process.execPath, [cli, ...args], { env, timeout: 30_000 });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

// Live daemons are separate processes, so deterministic timers cannot drive
// them: poll for the ping the way test/support.ts does for live sessions.
async function waitPing(timeoutMs = 15_000): Promise<{ pid: number; version: string }> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await brokerCall<{ pid: number; version: string }>("ping", {}, { autoStart: false, timeoutMs: 500 });
    } catch {
      if (Date.now() > end) throw new Error("the daemon did not answer ping");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

const NO_AGENT_PATH = "/usr/bin:/bin";

test("the database and its WAL sidecars are created 0600, and existing ones are fixed to 0600 on open", () => {
  const dir = tempDir("w6r4-");
  const db = join(dir, "agentsocks.db");
  const store = new Store(db);
  try {
    store.upsertThread("thread-r4", { name: "r4" }, "r4");
    assert.equal(statSync(db).mode & 0o777, 0o600, "a fresh database is created 0600");
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${db}${suffix}`;
      if (existsSync(sidecar)) assert.equal(statSync(sidecar).mode & 0o777, 0o600, `${suffix} is created 0600`);
    }
  } finally {
    store.close();
  }
  chmodSync(db, 0o644);
  new Store(db).close();
  assert.equal(statSync(db).mode & 0o777, 0o600, "opening the database fixes a lax mode to 0600");
});

test("install replaces a same-version broker whose build differs, and leaves an identical build alone", async () => {
  const saved = saveEnv(["AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_STATE_DIR"]);
  const children: ChildProcess[] = [];
  const runtimes: string[] = [];
  try {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const parent = tempDir("w6r6-");
    const copySrc = join(parent, "src");
    cpSync(srcDir, copySrc, { recursive: true });
    symlinkSync(join(repoRoot, "node_modules"), join(parent, "node_modules"));
    writeFileSync(join(copySrc, "cli.ts"), `${readFileSync(join(copySrc, "cli.ts"), "utf8")}\n`);

    const runtimeA = tempDir("w6r6a-");
    const stateA = tempDir("w6r6as-");
    runtimes.push(runtimeA);
    const childA = spawn(process.execPath, [join(copySrc, "cli.ts"), "daemon"], {
      env: { ...process.env, AGENTSOCKS_RUNTIME_DIR: runtimeA, AGENTSOCKS_STATE_DIR: stateA },
      stdio: "ignore",
    });
    children.push(childA);
    process.env.AGENTSOCKS_RUNTIME_DIR = runtimeA;
    process.env.AGENTSOCKS_STATE_DIR = stateA;
    const pong = await waitPing();
    assert.equal(pong.pid, childA.pid, "talking to the rebuilt broker");

    const log: string[] = [];
    await stopOlderBroker(log, false);
    assert.match(log.join("\n"), /different build/, "the log says the same-version daemon was a different build");
    await assert.rejects(brokerCall("ping", {}, { autoStart: false, timeoutMs: 500 }), "the rebuilt broker is stopped");

    const runtimeB = tempDir("w6r6b-");
    const stateB = tempDir("w6r6bs-");
    runtimes.push(runtimeB);
    const childB = spawn(process.execPath, [cli, "daemon"], {
      env: { ...process.env, AGENTSOCKS_RUNTIME_DIR: runtimeB, AGENTSOCKS_STATE_DIR: stateB },
      stdio: "ignore",
    });
    children.push(childB);
    process.env.AGENTSOCKS_RUNTIME_DIR = runtimeB;
    process.env.AGENTSOCKS_STATE_DIR = stateB;
    const pongB = await waitPing();
    assert.equal(pongB.pid, childB.pid, "talking to the identical-build broker");
    const same: string[] = [];
    await stopOlderBroker(same, false);
    assert.doesNotMatch(same.join("\n"), /stopped/, "an identical build is left alone");
    assert.ok((await brokerCall<{ pid: number }>("ping", {}, { autoStart: false, timeoutMs: 500 })).pid === childB.pid);
  } finally {
    restoreEnv(saved);
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    for (const runtime of runtimes) await reapPidFile(runtime);
  }
});

test("uninstall stops the broker, restores absent files to absent, skips an empty gateway archive, and keeps history", async () => {
  const saved = saveEnv(["AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_STATE_DIR", "CODEX_HOME", "PATH"]);
  let child: ChildProcess | undefined;
  try {
    const codexHome = tempDir("w6r7-codex-");
    const runtime = tempDir("w6r7-run-");
    const state = tempDir("w6r7-state-");
    process.env.CODEX_HOME = codexHome;
    process.env.AGENTSOCKS_RUNTIME_DIR = runtime;
    process.env.AGENTSOCKS_STATE_DIR = state;
    process.env.PATH = NO_AGENT_PATH;
    new Store(dbPath()).close();
    child = spawn(process.execPath, [cli, "daemon"], { env: process.env, stdio: "ignore" });
    const pong = await waitPing();
    assert.equal(pong.pid, child.pid);

    await install({ claude: false, codexMcp: true, codexHooks: true, trustHooks: false, dryRun: false });
    assert.ok(existsSync(join(codexHome, "config.toml")), "install writes config.toml on a fresh Codex home");
    assert.ok(existsSync(join(codexHome, "hooks.json")), "install writes hooks.json on a fresh Codex home");

    const r = await runCli({ ...process.env, CODEX_HOME: codexHome, AGENTSOCKS_RUNTIME_DIR: runtime, AGENTSOCKS_STATE_DIR: state, PATH: NO_AGENT_PATH }, "uninstall");
    assert.equal(r.code, 0, r.err);
    await assert.rejects(brokerCall("ping", {}, { autoStart: false, timeoutMs: 500 }), "uninstall stops the broker");
    assert.ok(!existsSync(join(codexHome, "config.toml")), "a config.toml nobody had is absent again");
    assert.ok(!existsSync(join(codexHome, "hooks.json")), "a hooks.json nobody had is absent again");
    const archives: string[] = [];
    const backups = join(state, "backups");
    if (existsSync(backups)) {
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, name.name);
          if (name.isDirectory()) walk(full);
          else if (/^gateway-state-.*\.json$/.test(name.name)) archives.push(full);
        }
      };
      walk(backups);
    }
    assert.deepEqual(archives, [], "no gateway-state archive is written when the gateway was never used");
    assert.ok(existsSync(dbPath()), "the database is kept by design");
    assert.match(r.out, /your message history \(database\), audit\.log and daemon\.log stay in/, "uninstall says the history and logs stay");
  } finally {
    restoreEnv(saved);
    try {
      child?.kill("SIGKILL");
    } catch {}
  }
});

test("upgrading rewrites a stale fallback MCP block that points at an old agentsocks cli", async () => {
  const saved = saveEnv(["CODEX_HOME", "PATH", "AGENTSOCKS_STATE_DIR"]);
  try {
    const codexHome = tempDir("w6r8-codex-");
    process.env.CODEX_HOME = codexHome;
    process.env.PATH = NO_AGENT_PATH;
    process.env.AGENTSOCKS_STATE_DIR = tempDir("w6r8-state-");
    writeFileSync(join(codexHome, "config.toml"), `[mcp_servers.agentsocks]\ncommand = "/old/agentsocks/dist/cli.js"\nargs = ["/old/agentsocks/dist/cli.js", "mcp", "--host", "codex"]\n`);
    await install({ claude: false, codexMcp: true, codexHooks: false, trustHooks: false, dryRun: false });
    const text = readFileSync(join(codexHome, "config.toml"), "utf8");
    assert.doesNotMatch(text, /\/old\/agentsocks/, "the stale block no longer points at the old cli");
    assert.ok(text.includes(cliEntry()), "the block points at this install's cli");
    assert.equal(text.match(/\[\s*mcp_servers\.agentsocks\s*\]/g)?.length ?? 0, 1, "exactly one agentsocks table remains");
    const second: string[] = [];
    await install({ claude: false, codexMcp: true, codexHooks: false, trustHooks: false, dryRun: false });
    void second;
    const again = readFileSync(join(codexHome, "config.toml"), "utf8");
    assert.equal(again, text, "a current block is left untouched");
  } finally {
    restoreEnv(saved);
  }
});

test("the OMP version warning for an untested minor names what to check, not the unshipped script", () => {
  const savedHome = process.env.HOME;
  process.env.HOME = tempDir("w6r9-home-");
  try {
    const log: string[] = [];
    const ctx = agentContext(false, log);
    mkdirSync(join(ctx.home, ".omp", "agent"), { recursive: true });
    const installer = ompInstaller(() => process.env, () => "18.9.0");
    installer.install(ctx);
    const report = installer.status(ctx);
    assert.equal(report.state, "wired");
    assert.doesNotMatch(report.detail.join("\n"), /scripts\/live\/omp\.sh/, "no pointer at a file outside the package");
    assert.match(report.detail.join("\n"), /release notes|docs/i, "it says what to check instead");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("the bypass check carries no dev-narrative comment", () => {
  const text = readFileSync(policyPath, "utf8");
  assert.doesNotMatch(text, /belongs next to this check/);
  assert.doesNotMatch(text, /Note: this tree has no separate hold/);
});

test("install with neither Claude Code nor Codex present exits 1 naming what to install first", async () => {
  const saved = saveEnv(["PATH", "CODEX_HOME", "AGENTSOCKS_STATE_DIR", "AGENTSOCKS_RUNTIME_DIR"]);
  try {
    process.env.PATH = NO_AGENT_PATH;
    process.env.CODEX_HOME = join(tempDir("w6r11-"), "codex-missing");
    process.env.AGENTSOCKS_STATE_DIR = tempDir("w6r11-state-");
    process.env.AGENTSOCKS_RUNTIME_DIR = tempDir("w6r11-run-");
    const log = await install({ claude: true, codexMcp: true, codexHooks: true, trustHooks: false, dryRun: false, agents: "detected", codexOptional: true });
    assert.equal(log.failed, true, "nothing to wire is a failure");
    assert.match(log.join("\n"), /Claude Code/, "it names Claude Code");
    assert.match(log.join("\n"), /Codex/, "it names Codex");
    assert.match(log.join("\n"), /install .* first/i, "it says to install one first");
    const dry = await install({ claude: true, codexMcp: true, codexHooks: true, trustHooks: false, dryRun: true, agents: "detected", codexOptional: true });
    assert.ok(!dry.failed, "a dry run still exits 0");
  } finally {
    restoreEnv(saved);
  }
});

test("every command answers --help with usage and does not run", async () => {
  for (const command of COMMANDS) {
    const runtime = tempDir("w6help-");
    const r = await runCli({ ...process.env, AGENTSOCKS_RUNTIME_DIR: runtime }, command.name, "--help");
    assert.equal(r.code, 0, `${command.name} --help exits 0`);
    assert.ok(r.out.includes(`agentsocks ${command.name}`) || r.out.includes("Usage:"), `${command.name} --help prints usage`);
    assert.ok(!existsSync(join(runtime, "broker.sock")), `${command.name} --help starts no broker`);
  }
});

test("top-line help names every supported agent", () => {
  const text = helpText();
  for (const name of ["Claude Code", "Codex", "OpenCode", "Hermes", "Cursor", "Copilot", "Gemini", "OMP"]) {
    assert.ok(text.includes(name), `help names ${name}`);
  }
  assert.ok(!text.includes("[--port 8787]"), "help no longer presents a fixed port as the gateway default");
});

test("gateway help shows this install's real default port, a random port per install", async () => {
  const saved = saveEnv(["AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_STATE_DIR"]);
  let child: ChildProcess | undefined;
  try {
    const runtime = tempDir("w6gw-run-");
    const state = tempDir("w6gw-state-");
    process.env.AGENTSOCKS_RUNTIME_DIR = runtime;
    process.env.AGENTSOCKS_STATE_DIR = state;
    child = spawn(process.execPath, [cli, "daemon"], { env: process.env, stdio: "ignore" });
    await waitPing();
    const status = await brokerCall<{ private: { configuredPort?: number; port?: number | null } }>("gateway_status", {}, { autoStart: false });
    const port = status.private.configuredPort ?? status.private.port;
    assert.ok(port, "the install has a configured gateway port");
    const r = await runCli(process.env, "gateway", "--help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes(String(port)), `gateway --help shows the configured port ${port}`);
    assert.match(r.out, /random/, "it says the default is picked per install");
    const idle = await runCli({ ...process.env, AGENTSOCKS_RUNTIME_DIR: tempDir("w6gw-idle-") }, "gateway", "--help");
    assert.equal(idle.code, 0);
    assert.match(idle.out, /random/, "without a broker it still describes the random default");
  } finally {
    restoreEnv(saved);
    try {
      child?.kill("SIGKILL");
    } catch {}
  }
});

test("a missing recipient says what to do", async () => {
  const r = await runCli(process.env, "send");
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: agentsocks send/);
});
