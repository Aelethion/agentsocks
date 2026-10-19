import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tempDir } from "./tmp.ts";
import { reapPidFile } from "./procs.ts";
import { differentBuildLine, stopOlderBroker } from "../src/install.ts";
import { buildHash } from "../src/procinfo.ts";
import { cliEntry } from "../src/client.ts";
import { dirname } from "node:path";
import { brokerCall } from "../src/client.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const exec = promisify(execFile);

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
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

const LINE = /running a different build than installed \(.*\); run install again/;

// A rebuilt checkout whose entry file is byte-identical but another source
// file changed: same version, different whole-dist build.
function rebuiltTree(marker: string): { parent: string; entry: string } {
  const parent = tempDir(`lb${marker}-`);
  const copySrc = join(parent, "src");
  cpSync(join(repoRoot, "src"), copySrc, { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(parent, "node_modules"));
  const probed = join(copySrc, "version.ts");
  writeFileSync(probed, `${readFileSync(probed, "utf8")}\n`);
  return { parent, entry: join(copySrc, "cli.ts") };
}

test("install replaces a same-version broker whose non-entry files differ", async () => {
  const saved = saveEnv(["AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_STATE_DIR"]);
  const children: ChildProcess[] = [];
  let runtime = "";
  try {
    const { entry } = rebuiltTree("r6x");
    runtime = tempDir("lbr6xa-");
    const state = tempDir("lbr6xas-");
    const child = spawn(process.execPath, [entry, "daemon"], {
      env: { ...process.env, AGENTSOCKS_RUNTIME_DIR: runtime, AGENTSOCKS_STATE_DIR: state },
      stdio: "ignore",
    });
    children.push(child);
    process.env.AGENTSOCKS_RUNTIME_DIR = runtime;
    process.env.AGENTSOCKS_STATE_DIR = state;
    const pong = await waitPing();
    assert.equal(pong.pid, child.pid, "talking to the rebuilt broker");
    const log: string[] = [];
    await stopOlderBroker(log, false);
    assert.match(log.join("\n"), /different build/, "the log says the same-version daemon was a different build");
    await assert.rejects(brokerCall("ping", {}, { autoStart: false, timeoutMs: 500 }), "the rebuilt broker is stopped");
  } finally {
    restoreEnv(saved);
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    if (runtime) await reapPidFile(runtime);
  }
});

test("doctor says the running broker is a different build than installed", async () => {
  const saved = saveEnv(["AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_STATE_DIR"]);
  const children: ChildProcess[] = [];
  let runtime = "";
  try {
    const { entry } = rebuiltTree("doc");
    runtime = tempDir("lbdoca-");
    const state = tempDir("lbdocas-");
    const child = spawn(process.execPath, [entry, "daemon"], {
      env: { ...process.env, AGENTSOCKS_RUNTIME_DIR: runtime, AGENTSOCKS_STATE_DIR: state },
      stdio: "ignore",
    });
    children.push(child);
    process.env.AGENTSOCKS_RUNTIME_DIR = runtime;
    process.env.AGENTSOCKS_STATE_DIR = state;
    const pong = await waitPing();
    assert.equal(pong.pid, child.pid, "talking to the rebuilt broker");
    const r = await runCli({ ...process.env }, "doctor");
    assert.match(r.out, LINE, "doctor names the different build and says to run install again");
  } finally {
    restoreEnv(saved);
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    if (runtime) await reapPidFile(runtime);
  }
});

test("plain status keeps its JSON health and warns on stderr about a different build", async () => {
  const saved = saveEnv(["AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_STATE_DIR"]);
  const children: ChildProcess[] = [];
  let runtime = "";
  try {
    const { entry } = rebuiltTree("sts");
    runtime = tempDir("lbstsa-");
    const state = tempDir("lbstsas-");
    const child = spawn(process.execPath, [entry, "daemon"], {
      env: { ...process.env, AGENTSOCKS_RUNTIME_DIR: runtime, AGENTSOCKS_STATE_DIR: state },
      stdio: "ignore",
    });
    children.push(child);
    process.env.AGENTSOCKS_RUNTIME_DIR = runtime;
    process.env.AGENTSOCKS_STATE_DIR = state;
    const pong = await waitPing();
    assert.equal(pong.pid, child.pid, "talking to the rebuilt broker");
    const r = await runCli({ ...process.env }, "status");
    assert.equal(typeof JSON.parse(r.out).pid, "number", "stdout is still the ping JSON");
    assert.match(r.err, LINE, "stderr names the different build and says to run install again");
  } finally {
    restoreEnv(saved);
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    if (runtime) await reapPidFile(runtime);
  }
});

test("doctor and status stay quiet when the running broker is this build", async () => {
  const saved = saveEnv(["AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_STATE_DIR"]);
  const children: ChildProcess[] = [];
  let runtime = "";
  try {
    runtime = tempDir("lbsamea-");
    const state = tempDir("lbsameas-");
    const child = spawn(process.execPath, [cli, "daemon"], {
      env: { ...process.env, AGENTSOCKS_RUNTIME_DIR: runtime, AGENTSOCKS_STATE_DIR: state },
      stdio: "ignore",
    });
    children.push(child);
    process.env.AGENTSOCKS_RUNTIME_DIR = runtime;
    process.env.AGENTSOCKS_STATE_DIR = state;
    const pong = await waitPing();
    assert.equal(pong.pid, child.pid, "talking to this build's broker");
    const doc = await runCli({ ...process.env }, "doctor");
    assert.doesNotMatch(doc.out, /different build/, "doctor reports no build mismatch for this build");
    const st = await runCli({ ...process.env }, "status");
    assert.equal(typeof JSON.parse(st.out).pid, "number", "stdout is still the ping JSON");
    assert.doesNotMatch(st.err, /different build/, "status warns about nothing for this build");
  } finally {
    restoreEnv(saved);
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    if (runtime) await reapPidFile(runtime);
  }
});

test("doctor keeps the version-mismatch line for an older-version broker", async () => {
  const dir = tempDir("lbold-");
  const script = join(dir, "cli.js");
  writeFileSync(
    script,
    `const net = require("net"), fs = require("fs"), path = require("path");
const run = process.env.AGENTSOCKS_RUNTIME_DIR;
fs.mkdirSync(path.join(run, "broker.lock"), { recursive: true });
fs.writeFileSync(path.join(run, "broker.lock", "pid"), String(process.pid));
const server = net.createServer((s) => s.on("data", (d) => {
  const req = JSON.parse(String(d).split("\\n")[0]);
  s.end(JSON.stringify(req.op === "ping" ? { id: 1, ok: true, result: { pid: process.pid, version: "0.1.0", threads: 0 } } : { id: 1, ok: false, error: "unknown op " + req.op }) + "\\n");
}));
server.listen(path.join(run, "broker.sock"), () => console.log("ready"));
process.on("SIGTERM", () => { try { fs.unlinkSync(path.join(run, "broker.lock", "pid")); } catch {} try { fs.rmdirSync(path.join(run, "broker.lock")); } catch {} server.close(() => process.exit(0)); });
`,
  );
  const run = join(dir, "run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const saved = saveEnv(["AGENTSOCKS_RUNTIME_DIR", "AGENTSOCKS_STATE_DIR"]);
  process.env.AGENTSOCKS_RUNTIME_DIR = run;
  const old = spawn(process.execPath, [script, "daemon"], { env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => old.on("exit", resolve));
  try {
    await new Promise((resolve) => old.stdout!.once("data", resolve));
    const r = await runCli({ ...process.env }, "doctor");
    assert.match(r.out, /this is v.*so run `agentsocks install`/, "the version-mismatch line still fires");
    assert.doesNotMatch(r.out, /different build/, "no build line next to the version line");
    assert.ok(existsSync(join(run, "broker.sock")), "the probe spoke to the old broker");
  } finally {
    old.kill("SIGKILL");
    await exited;
    restoreEnv(saved);
  }
});

test("a same-path rebuild is flagged by the reported build hash, not the path", async () => {
  const entry = cliEntry();
  const mineHash = buildHash(dirname(entry));
  assert.ok(mineHash !== undefined && mineHash.length === 64, "the installed tree hashes");
  assert.match(differentBuildLine(entry, "0".repeat(64)) ?? "", LINE, "a stale reported hash flags even at the same path");
  assert.equal(differentBuildLine(entry, mineHash), undefined, "the current hash at the same path is quiet");
  assert.equal(differentBuildLine(entry), undefined, "no report means the path rule still applies");
});
