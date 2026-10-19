import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { root, sleep, until, fakeClaude, livePid } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { encodeAddress, userFrame } from "../src/envelope.ts";
import { listClaudeSessions } from "../src/claude.ts";

let scans = 0;
let broker: Broker | undefined;

const start = async (sessionCacheMs: number): Promise<Broker> => {
  scans = 0;
  broker = new Broker({
    wakeEnabled: false,
    sessionCacheMs,
    claudeSessions: () => {
      scans++;
      return listClaudeSessions();
    },
  });
  await broker.start();
  return broker;
};

afterEach(async () => {
  await sleep(100);
  await broker?.stop();
  broker = undefined;
});

const party = (name: string) => ({ kind: "claude", name, addr: encodeAddress(join(root, "cc-socks", `${name}.sock`)), session: null, mode: null });

test("a flood of inbound frames pays for the Claude registry only on the frames the limiter lets through", async () => {
  const b = await start(0);
  await b.register("thr-cost", { cwd: "/work/cost" });
  const frames = 2000;
  for (let i = 0; i < frames; i++) b.onFrame("thr-cost", userFrame({ from: encodeAddress(join(root, "cc-socks", `atk${i % 3}.sock`)), fromName: "atk", body: `flood ${i}` }, `m${i}`));
  assert.ok(scans <= 100, `${scans} registry scans for ${frames} frames`);
});

test("sends the limiter refuses cost no registry scan", async () => {
  const b = await start(0);
  const target = await fakeClaude("costtarget", livePid(), "busy");
  try {
    const to = { kind: "claude", addr: encodeAddress(target.socketPath), name: target.name, sessionId: target.sessionId };
    let refused = 0;
    while (refused === 0) {
      await b.routeSend({ from: party("burst"), to, body: `message ${scans}`, urgency: "fyi" }).catch((err: Error) => {
        if (/too many messages/.test(err.message)) refused++;
        else throw err;
      });
    }
    const settled = scans;
    for (let i = 0; i < 100; i++) await assert.rejects(b.routeSend({ from: party("burst"), to, body: `refused ${i}`, urgency: "fyi" }), /too many messages/);
    assert.equal(scans, settled, "a refused send never reads the registry");
  } finally {
    await closeServer(target.server);
  }
});

test("the Claude registry is read once a second at most, however many messages are routed", async () => {
  const b = await start(1000);
  const target = await fakeClaude("cachetarget", livePid(), "busy");
  try {
    const to = { kind: "claude", addr: encodeAddress(target.socketPath), name: target.name, sessionId: target.sessionId };
    const began = Date.now();
    for (let i = 0; i < 40; i++) await b.routeSend({ from: party(`sender${i}`), to, body: `note ${i}`, urgency: "fyi" });
    const seconds = Math.ceil((Date.now() - began) / 1000);
    assert.ok(scans <= 1 + seconds, `${scans} registry reads for 40 messages in ${seconds} s`);
  } finally {
    await closeServer(target.server);
  }
});

test("a socket name that looks like a Codex thread's but is unknown costs no scan of the thread table", async () => {
  const b = await start(0);
  await b.register("thr-hex", { cwd: "/work/hex" });
  const real = b.store.listThreads.bind(b.store);
  let listed = 0;
  b.store.listThreads = (...args) => {
    listed++;
    return real(...args);
  };
  for (let i = 0; i < 200; i++) {
    const name = `a${i.toString(16).padStart(15, "0")}.sock`;
    b.onFrame("thr-hex", userFrame({ from: encodeAddress(join(root, "cc-socks", name)), fromName: "ghost", body: `hello ${i}` }, `h${i}`));
  }
  assert.equal(listed, 0);
});

test("a sweep reads the registry fresh, so a digest goes out as soon as its session turns idle even inside the cache window", async () => {
  const b = await start(60_000);
  const target = await fakeClaude("sweeptarget", livePid(), "busy");
  try {
    const to = { kind: "claude", addr: encodeAddress(target.socketPath), name: target.name, sessionId: target.sessionId };
    const held = await b.routeSend({ from: party("notifier"), to, body: "FYI the build is green", urgency: "fyi" });
    assert.equal(held.status, "held");
    target.setStatus("idle");
    await b.runSweep();
    await until(() => target.frames.length === 1);
    assert.equal(b.store.getOutbox(held.msgId)!.status, "sent");
  } finally {
    await closeServer(target.server);
  }
});
