import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import "./support.ts";
import { runAgentTool } from "../src/agenttool.ts";
import { formatAsk } from "../src/asks.ts";
import { Broker } from "../src/broker.ts";
import { encodeAddress } from "../src/envelope.ts";
import { ensurePeer } from "../src/gateway/remote.ts";
import { threadSocketPath } from "../src/paths.ts";
import type { Party, Target } from "../src/routing.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker({ classifier: () => undefined, wakeEnabled: false });

const addrOf = (id: string): string => encodeAddress(threadSocketPath(id));
const partyOf = (id: string, name: string): Party => ({ kind: "codex", name, addr: addrOf(id), session: id, mode: null });
const bareTarget = (id: string, name: string): Target => ({ kind: "codex", addr: addrOf(id), name });

async function op<T>(opName: string, req: Record<string, unknown> = {}): Promise<T> {
  const reply: unknown = await broker.dispatch({ op: opName, ...req });
  if (reply && typeof reply === "object" && "result" in reply) return reply.result as T;
  throw new Error(`${opName} returned no result`);
}

const taskCount = (): number => Number((broker.store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n);

before(async () => {
  await broker.start();
  for (const id of ["w4bworker", "w4bboss", "w4bstranger", "w4bcli", "w4bbystander"]) {
    await op("register", { threadId: id, cwd: "/w/w4b" });
  }
  await op("set_name", { threadId: "w4bboss", name: "w4bboss" });
  await op("set_driver", { threadId: "w4bworker", addr: addrOf("w4bboss"), name: "w4bboss" });
});

after(async () => {
  await broker.stop();
});

test("task_create with no threadId on a driven worker is refused and stores nothing", async () => {
  const before = taskCount();
  await assert.rejects(
    op("task_create", { from: partyOf("w4bstranger", "stranger"), to: bareTarget("w4bworker", "worker"), title: "Do this", body: "details" }),
    /works for w4bboss and may not act on it/,
  );
  assert.equal(taskCount(), before);
});

test("the driver's own task_create with no threadId still lands", async () => {
  const before = taskCount();
  const out = await op<{ task: { id: string } }>("task_create", { from: partyOf("w4bboss", "w4bboss"), to: bareTarget("w4bworker", "worker"), title: "Do this", body: "details" });
  assert.match(out.task.id, /^T-[0-9a-f]{6}$/);
  assert.equal(taskCount(), before + 1);
});

test("an ask to a driven worker tells the asker the worker may not act", async () => {
  const snap = await op<{ id: string; targets: { name: string; driver?: string; route?: string }[] }>("ask_create", {
    from: partyOf("w4bstranger", "stranger"),
    targets: [bareTarget("w4bworker", "worker")],
    channels: [],
    question: "is the deploy green?",
    timeoutSeconds: 1,
  });
  assert.equal(snap.targets[0]!.driver, "w4bboss");
  assert.match(formatAsk({ ask: snap as never }), /Delivered as information: worker works for w4bboss and may not act on it\. Ask w4bboss if you need it to do something\./);
});

test("an ask from the driver carries no driven-worker note", async () => {
  const snap = await op<{ targets: { driver?: string }[] }>("ask_create", {
    from: partyOf("w4bboss", "w4bboss"),
    targets: [bareTarget("w4bworker", "worker")],
    channels: [],
    question: "is the deploy green?",
    timeoutSeconds: 1,
  });
  assert.equal(snap.targets[0]!.driver, undefined);
  assert.doesNotMatch(formatAsk({ ask: snap as never }), /may not act on it/);
});

test("the set_driver tool refuses token, OAuth, API and tailnet peers as drivers", async () => {
  const peers = [
    await ensurePeer(broker, { id: "token:w4by5", name: "w4b-tok", via: "token", mayMessage: ["*"] }),
    await ensurePeer(broker, { id: "oauth:w4by5", name: "w4b-oa", via: "oauth", mayMessage: [] }),
    await ensurePeer(broker, { id: "api:w4by5", name: "w4b-mdl (api)", via: "api", mayMessage: [] }),
    await ensurePeer(broker, { id: "tailnet:w4by5:app", name: "w4b-phone", via: "tailnet", machine: "iphone-14", login: "sam@example.com", mayMessage: [] }),
  ];
  for (const peer of peers) {
    const r = await runAgentTool("opencode", "set_driver", "ses_w4by5", "/w/w4b", { peer: peer.name });
    assert.equal(r.isError, true, `${peer.via} peer must not become a driver`);
    assert.match(r.text, /a driver must be a local session: token, OAuth, API and linked peers cannot drive/);
  }
  assert.equal(broker.store.getThread("opencode_ses_w4by5")?.driver_addr ?? null, null);
});

test("the set_driver tool sets, clears, and refuses an unknown name", async () => {
  const set = await runAgentTool("opencode", "set_driver", "ses_w4by12", "/w/w4b", { peer: "w4bboss" });
  assert.equal(set.isError, false);
  assert.match(set.text, /@w4bboss is now your driver/);
  assert.equal(broker.store.getThread("opencode_ses_w4by12")!.driver_addr, broker.canon(addrOf("w4bboss")));
  const clear = await runAgentTool("opencode", "set_driver", "ses_w4by12", "/w/w4b", { peer: "none" });
  assert.equal(clear.isError, false);
  assert.match(clear.text, /driver is cleared/);
  assert.equal(broker.store.getThread("opencode_ses_w4by12")!.driver_addr, null);
  const wrong = await runAgentTool("opencode", "set_driver", "ses_w4by12", "/w/w4b", { peer: "no-such-session-w4b" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /no running session|not connected|unknown/i);
});

test("one caller setting its driver never moves another session's driver", async () => {
  const set = await runAgentTool("opencode", "set_driver", "ses_w4bfirst", "/w/w4b", { peer: "w4bboss" });
  assert.equal(set.isError, false);
  assert.equal(broker.store.getThread("opencode_ses_w4bfirst")!.driver_addr, broker.canon(addrOf("w4bboss")));
  assert.equal(broker.store.getThread("w4bbystander")!.driver_addr, null);
  await op("set_driver", { threadId: "w4bbystander", addr: addrOf("w4bboss"), name: "w4bboss" });
  assert.equal(broker.store.getThread("w4bbystander")!.driver_addr, broker.canon(addrOf("w4bboss")));
  const move = await runAgentTool("opencode", "set_driver", "ses_w4bfirst", "/w/w4b", { peer: "none" });
  assert.equal(move.isError, false);
  assert.equal(broker.store.getThread("opencode_ses_w4bfirst")!.driver_addr, null);
  assert.equal(broker.store.getThread("w4bbystander")!.driver_addr, broker.canon(addrOf("w4bboss")));
});

test("the driver CLI sets and clears the caller's own driver", async () => {
  const env = { ...process.env, CODEX_THREAD_ID: "w4bcli" } as NodeJS.ProcessEnv;
  const set = await exec(process.execPath, [cli, "driver", "w4bboss"], { env, timeout: 30_000 }).catch((e) => {
    throw new Error(`cli driver set failed: ${e.stdout ?? ""} ${e.stderr ?? ""}`);
  });
  assert.match(set.stdout, /@w4bboss is now your driver/);
  assert.equal(broker.store.getThread("w4bcli")!.driver_addr, broker.canon(addrOf("w4bboss")));
  const none = await exec(process.execPath, [cli, "driver", "none"], { env, timeout: 30_000 }).catch((e) => {
    throw new Error(`cli driver none failed: ${e.stdout ?? ""} ${e.stderr ?? ""}`);
  });
  assert.match(none.stdout, /Driver cleared/);
  assert.equal(broker.store.getThread("w4bcli")!.driver_addr, null);
});
