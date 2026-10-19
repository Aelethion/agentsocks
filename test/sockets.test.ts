import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { sleep } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer, listenUnix, probe, refusalProvesStale, type ListenOptions } from "../src/ccsocks.ts";
import { brokerSocketPath, ensurePrivateDir, runtimeDir, threadSocketPath } from "../src/paths.ts";
import { tempDir } from "./tmp.ts";

const dirOf = (): string => tempDir("as-sock-");

function child(code: string): Promise<{ pid: number; kill(signal: NodeJS.Signals): void }> {
  const proc = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    proc.stdout!.once("data", () => resolve({ pid: proc.pid!, kill: (signal) => proc.kill(signal) }));
    proc.once("error", reject);
    proc.once("exit", () => reject(new Error("child exited early")));
  });
}

async function bindOrWhy(path: string, opts?: ListenOptions): Promise<string> {
  return listenUnix(path, () => {}, opts).then(
    async (server) => {
      await closeServer(server);
      return "bound";
    },
    (err: Error) => err.message,
  );
}

test("a refusal proves a name stale everywhere except macOS, where a listener with a full backlog is refused too and only a name this broker owns counts", () => {
  assert.equal(refusalProvesStale("linux", false), true);
  assert.equal(refusalProvesStale("linux", true), true);
  assert.equal(refusalProvesStale("android", false), true);
  assert.equal(refusalProvesStale("darwin", false), false);
  assert.equal(refusalProvesStale("darwin", true), true);
});

test("only a refused connection proves a socket is stale; a listener that cannot answer right now is left alone", async () => {
  const path = join(dirOf(), "busy.sock");
  const owner = await child(`require("net").createServer().listen({ path: ${JSON.stringify(path)}, backlog: 1 }, () => console.log("ready"))`);
  const fillers: ReturnType<typeof createConnection>[] = [];
  try {
    assert.equal(await probe(path, true), "alive");
    owner.kill("SIGSTOP");
    for (let i = 0; i < 8; i++) fillers.push(createConnection({ path }).on("error", () => {}));
    await sleep(150);
    assert.equal(await probe(path, true, 300), process.platform === "darwin" ? "stale" : "unknown", "macOS refuses a full backlog, the others leave the caller waiting");
    assert.equal(await probe(path, refusalProvesStale(process.platform, false), 300), "unknown");
    assert.match(await bindOrWhy(path), /cannot tell whether a server still listens/);
    assert.ok(existsSync(path), "the busy owner keeps its socket");
  } finally {
    owner.kill("SIGCONT");
    owner.kill("SIGKILL");
    for (const f of fillers) f.destroy();
  }
});

async function deadSocket(path = join(dirOf(), "stale.sock")): Promise<string> {
  const owner = await child(`require("net").createServer().listen(${JSON.stringify(path)}, () => console.log("ready"))`);
  owner.kill("SIGKILL");
  await sleep(150);
  assert.ok(existsSync(path), "the file outlives the process");
  return path;
}

test("a socket left behind by a dead server is replaced", async () => {
  const path = await deadSocket();
  assert.equal(await probe(path, true), "stale");
  const server = await listenUnix(path, () => {}, { platform: "linux" });
  assert.equal(await probe(path, true), "alive");
  await closeServer(server);
});

test("on macOS a refusal is not enough for a name that is not this broker's, and enough for one that is", async () => {
  const path = await deadSocket();
  assert.match(await bindOrWhy(path, { platform: "darwin" }), /cannot tell whether a server still listens/);
  assert.ok(existsSync(path), "the socket that might belong to a live server stays");
  const server = await listenUnix(path, () => {}, { platform: "darwin", ownsName: true });
  assert.equal(await probe(path, true), "alive");
  await closeServer(server);
});

test("closing a server whose path now belongs to someone else leaves that socket in place", async () => {
  const dir = dirOf();
  const path = join(dir, "contested.sock");
  const ours = await listenUnix(path, () => {});
  const { unlinkSync } = await import("node:fs");
  unlinkSync(path);
  const theirs = createServer((s) => s.on("error", () => {}).end("theirs"));
  await new Promise<void>((resolve) => theirs.listen(path, () => resolve()));
  try {
    await closeServer(ours);
    assert.ok(existsSync(path), "libuv would have unlinked it");
    assert.equal(await probe(path, true), "alive");
    assert.deepEqual(readdirSync(dir), ["contested.sock"], "nothing is left parked beside it");
  } finally {
    theirs.close();
  }
});

test("a broker on macOS replaces the dead sockets in its own runtime directory, because it holds the lock", async () => {
  ensurePrivateDir(runtimeDir());
  await deadSocket(brokerSocketPath());
  const broker = new Broker({ platform: "darwin", ttyScan: () => [] });
  await broker.start();
  try {
    assert.equal(await probe(brokerSocketPath(), true), "alive", "it bound its control socket over the dead one");
    const threadId = "thread-x12-restart";
    ensurePrivateDir(dirname(threadSocketPath(threadId)));
    await deadSocket(threadSocketPath(threadId));
    await broker.hook({ threadId, event: "SessionStart", cwd: "/work/x12" });
    assert.equal(await probe(threadSocketPath(threadId), true), "alive", "it bound the thread's inbox over the dead one");
  } finally {
    await broker.stop();
  }
});
