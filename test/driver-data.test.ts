import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import "./support.ts";
import { fakeClaude, livePid } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress } from "../src/envelope.ts";
import { Store } from "../src/store.ts";
import { agentHookRequest } from "../src/agents/request.ts";
import { gatewayState } from "../src/gateway/state.ts";
import { resolvePeer, type Peer } from "../src/peers.ts";
import { buildDatabase } from "./schemadump.ts";
import { tempDir } from "./tmp.ts";

const broker = new Broker();
before(async () => {
  await broker.start();
});
after(async () => {
  await broker.stop();
});

const WORKER = "omp_drvworker01";
const DRIVER = "omp_drvboss01";
const OTHER = "omp_drvother01";

async function register(threadId: string, info: Record<string, string>): Promise<void> {
  await broker.dispatch({ op: "register", threadId, ...info });
}

test("set_driver stores the canon driver address and the name snapshot on the caller's own thread", async () => {
  await register(WORKER, { cwd: "/work/w9" });
  await register(DRIVER, { cwd: "/work/boss" });
  const dbo = broker.store.getThread(DRIVER)!;
  const addr = encodeAddress(broker.describe(dbo).socketPath);
  await broker.dispatch({ op: "set_driver", threadId: WORKER, addr, name: dbo.name });
  const row = broker.store.getThread(WORKER)!;
  assert.equal(row.driver_addr, broker.canon(addr));
  assert.equal(row.driver_name, dbo.name);
});

test("set_driver without an address clears the binding", async () => {
  await broker.dispatch({ op: "set_driver", threadId: WORKER });
  const row = broker.store.getThread(WORKER)!;
  assert.equal(row.driver_addr, null);
  assert.equal(row.driver_name, null);
});

test("only the session itself is written: no argument names another thread, and a bad identity is refused", async () => {
  await register(OTHER, { cwd: "/work/other" });
  const dbo = broker.store.getThread(DRIVER)!;
  const addr = encodeAddress(broker.describe(dbo).socketPath);
  await broker.dispatch({ op: "set_driver", threadId: WORKER, addr, name: dbo.name });
  assert.equal(broker.store.getThread(OTHER)!.driver_addr, null);
  await broker.dispatch({ op: "set_driver", threadId: OTHER });
  assert.equal(broker.store.getThread(WORKER)!.driver_addr, broker.canon(addr));
  for (const threadId of [undefined, "", "has space", 7]) {
    await assert.rejects(broker.dispatch({ op: "set_driver", threadId }), { message: "threadId required" });
  }
});

test("driver targets resolve by peer name or ref like send targets, never to self", () => {
  const me = { kind: "codex" as const, name: "worker", socketPath: "/run/w.sock", session: WORKER };
  const peers: Peer[] = [
    { kind: "codex", name: "boss", ref: "aa11bb", socketPath: "/run/b.sock", session: DRIVER },
    { kind: "codex", name: "worker", ref: "cc22dd", socketPath: "/run/w.sock", session: WORKER },
  ];
  assert.equal(resolvePeer(peers, "boss", me).session, DRIVER);
  assert.equal(resolvePeer(peers, "aa11bb", me).session, DRIVER);
  assert.throws(() => resolvePeer(peers, "worker", me), /yourself|no running session/);
});

test("a generated default that a live thread already uses gets -2, then -3", async () => {
  await register("omp_w9a1", { cwd: "/work/same" });
  await register("omp_w9b2", { cwd: "/work/same" });
  await register("omp_w9c3", { cwd: "/work/same" });
  assert.equal(broker.store.getThread("omp_w9a1")!.name, "omp-same");
  assert.equal(broker.store.getThread("omp_w9b2")!.name, "omp-same-2");
  assert.equal(broker.store.getThread("omp_w9c3")!.name, "omp-same-3");
  await register("omp_w9c3", { cwd: "/work/later" });
  assert.equal(broker.store.getThread("omp_w9c3")!.name, "omp-later");
});

test("a name set through set_name is explicit and survives a cwd change", async () => {
  await broker.dispatch({ op: "set_name", threadId: "omp_w9b2", name: "Mine" });
  const named = broker.store.getThread("omp_w9b2")!;
  assert.equal(named.name_explicit, 1);
  await register("omp_w9b2", { cwd: "/work/moved" });
  assert.equal(broker.store.getThread("omp_w9b2")!.name, "Mine");
});

test("an OMP-provided name registers as a uniquified default, and an explicit set_name survives a later hook name", async () => {
  await register("omp_w9omp", { cwd: "/work/pi", name: "Pi Session" });
  const row = broker.store.getThread("omp_w9omp")!;
  assert.deepEqual([row.name, row.name_explicit], ["Pi Session", null]);
  await register("omp_w9ompb", { cwd: "/work/pi-b", name: "Pi Session" });
  assert.equal(broker.store.getThread("omp_w9ompb")!.name, "Pi Session-2");
  await broker.dispatch({ op: "set_name", threadId: "omp_w9omp", name: "Mine" });
  await register("omp_w9omp", { cwd: "/work/pi2", name: "Pi Session" });
  assert.equal(broker.store.getThread("omp_w9omp")!.name, "Mine");
});

test("a default colliding with a remote/API peer name is suffixed", async () => {
  gatewayState(broker.store).insertPeer({ id: "gw1", thread_id: "r-w9gw000000000000000001", name: "omp-remote", via: "token", machine: null, login: null, may_message: "[]", detail: "" });
  await register("omp_w9r1", { cwd: "/work/remote" });
  assert.equal(broker.store.getThread("omp_w9r1")!.name, "omp-remote-2");
});

test("a default colliding with a live Claude session name is suffixed", async () => {
  const cla = await fakeClaude("omp-clash", livePid(), "idle");
  try {
    await register("omp_w9cc", { cwd: "/work/clash" });
    assert.equal(broker.store.getThread("omp_w9cc")!.name, "omp-clash-2");
  } finally {
    await closeServer(cla.server);
  }
});

test("migration: a v0.3.0 database gains driver_addr, driver_name and name_explicit as null", () => {
  const fixtures = fileURLToPath(new URL("./fixtures/schema/", import.meta.url));
  const path = join(tempDir("agentsocks-driver-"), "agentsocks.db");
  buildDatabase(path, readFileSync(join(fixtures, "v0.3.0.sql"), "utf8"));
  const setup = new DatabaseSync(path);
  setup.prepare("INSERT INTO threads (thread_id, name, created_at, last_seen) VALUES ('019e2f00-0000-7000-8000-000000000009', 'old', 1, 1)").run();
  setup.close();
  const store = new Store(path);
  try {
    const columns = (store.db.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).map((c) => c.name);
    for (const column of ["driver_addr", "driver_name", "name_explicit"]) assert.ok(columns.includes(column), column);
    assert.deepEqual(
      [store.getThread("019e2f00-0000-7000-8000-000000000009")!.driver_addr, store.getThread("019e2f00-0000-7000-8000-000000000009")!.driver_name, store.getThread("019e2f00-0000-7000-8000-000000000009")!.name_explicit],
      [null, null, null],
    );
  } finally {
    store.close();
  }
});
