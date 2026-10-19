import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { fakeClaude, livePid, root, sleep, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { drained, settled } from "../src/exit.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const sources = fileURLToPath(new URL("../src/", import.meta.url));
const broker = new Broker({ ttyScan: () => [] });
let claude: FakeClaude;

const CROWD = 240;
const PIPE_HOLDS = 64 * 1024;
const READER_DELAY_MS = 2000;

before(async () => {
  await broker.start();
  claude = await fakeClaude("pipes-claude", livePid(), "idle");
  for (let i = 0; i < CROWD; i++) {
    const record = { pid: process.pid, sessionId: `crowd-${i}`, name: `crowd-${i}`, cwd: `/work/crowd-${i}/${"d".repeat(1200)}`, messagingSocketPath: claude.socketPath, kind: "interactive", status: "idle" };
    writeFileSync(join(root, "claude-sessions", `${2000 + i}.json`), JSON.stringify(record));
  }
});

after(async () => {
  await closeServer(claude.server);
  await broker.stop();
});

async function withSlowReader(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk)).pause();
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk)).pause();
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await Promise.race([exited, sleep(READER_DELAY_MS)]);
  child.stdout.resume();
  child.stderr.resume();
  const code = await closed;
  return { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

test("list --json prints every peer when the output is larger than a pipe holds and the reader is slow", async () => {
  const r = await withSlowReader(["list", "--json"]);
  assert.equal(r.code, 0);
  const peers = JSON.parse(r.stdout) as { name: string }[];
  assert.equal(peers.filter((p) => p.name.startsWith("crowd-")).length, CROWD);
  assert.ok(Buffer.byteLength(r.stdout) > 4 * PIPE_HOLDS, "the output was far larger than a pipe's buffer");
});

test("drained waits for what a stream has queued, and does not hang on one that failed", async () => {
  const taken: string[] = [];
  const slow = new Writable({
    write(chunk, _encoding, done) {
      setTimeout(() => {
        taken.push(String(chunk));
        done();
      }, 50);
    },
  });
  slow.write("first");
  slow.write("second");
  await drained(slow);
  assert.deepEqual(taken.slice(0, 2), ["first", "second"]);
  const broken = new Writable({ write: (_chunk, _encoding, done) => done(new Error("EPIPE")) });
  await drained(broken);
});

test("the wait before exiting is bounded: a reader that never reads cannot hold the process", async () => {
  const never = new Promise(() => {});
  const started = Date.now();
  await settled(never, 100);
  assert.ok(Date.now() - started < 1000, "settled gave up at its limit");
  let finishedAt = 0;
  await settled(new Promise((resolve) => setTimeout(() => resolve((finishedAt = Date.now())), 20)), 5000);
  assert.ok(finishedAt > 0 && Date.now() - finishedAt < 1000, "settled returned as soon as the work did");
});

test("only exit.ts calls process.exit, because it discards what a pipe has not taken yet", () => {
  const callers = readdirSync(sources).filter((file) => file.endsWith(".ts") && /\bprocess\.exit\(/.test(readFileSync(join(sources, file), "utf8")));
  assert.deepEqual(callers, ["exit.ts"]);
});
