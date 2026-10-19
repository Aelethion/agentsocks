import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { ensurePeer } from "../src/gateway/remote.ts";
import { createOmpExtension } from "../src/agents/omp/runtime.ts";

const broker = new Broker();

before(async () => {
  await broker.start();
  await ensurePeer(broker, { id: "tailnet:w1fn-a:agent", name: "hetzner-lab", via: "tailnet", machine: "hetzner-lab", login: "sam@example.com", mayMessage: ["*"] });
  await ensurePeer(broker, { id: "tailnet:w1fn-b:app", name: "sam (devbox)", via: "tailnet", machine: "devbox", login: "sam@example.com", mayMessage: ["*"] });
  await ensurePeer(broker, { id: "oauth:w1fn-c", name: "chatgpt", via: "oauth", mayMessage: [] });
  await ensurePeer(broker, { id: "api:w1fn-d", name: "grok (api)", via: "api", mayMessage: [] });
});

after(async () => {
  await broker.stop();
});

const HOSTILE = ["chatgpt (remote)", "x(remote)", "x(phone)", "sam (phone)", "Grok (API)", "grok(api)", "x(guest)", "hetzner-lab", "sam (devbox)", "chatgpt", "CHATGPT", "grok (api)", "bob@hetzner-lab"];
const OMP_LOCAL = ["chatgpt (remote)", "x(remote)", "x(phone)", "sam (phone)", "Grok (API)", "grok(api)", "x(guest)", "bob@hetzner-lab"];

test("set_name refuses gateway markers with or without the space, @, and names equal to a live peer", async () => {
  await broker.dispatch({ op: "register", threadId: "w1fn-set", cwd: "/work/w1fn" });
  for (const name of HOSTILE) {
    await assert.rejects(broker.dispatch({ op: "set_name", threadId: "w1fn-set", name }), /marker|already|linked session|peer/i, `${name} must be refused`);
  }
});

test("set_name still allows ordinary names and explicit duplicates across local sessions", async () => {
  await broker.dispatch({ op: "register", threadId: "w1fn-ok-a", cwd: "/work/w1fn" });
  await broker.dispatch({ op: "register", threadId: "w1fn-ok-b", cwd: "/work/w1fn" });
  await broker.dispatch({ op: "set_name", threadId: "w1fn-ok-a", name: "ok name" });
  assert.equal(broker.store.getThread("w1fn-ok-a")!.name, "ok name");
  await broker.dispatch({ op: "set_name", threadId: "w1fn-ok-a", name: "shared-local" });
  await broker.dispatch({ op: "set_name", threadId: "w1fn-ok-b", name: "shared-local" });
  assert.equal(broker.store.getThread("w1fn-ok-b")!.name, "shared-local");
});

test("register with a hostile name refuses instead of uniquifying it", async () => {
  for (const name of HOSTILE) {
    await assert.rejects(broker.dispatch({ op: "register", threadId: `w1fn-reg-${name.length}-${HOSTILE.indexOf(name)}`, cwd: "/work/w1fn", name }), /marker|already|linked session|peer/i, `register ${name} must be refused`);
  }
  await broker.dispatch({ op: "register", threadId: "w1fn-reg-ok", cwd: "/work/w1fn", name: "plain session" });
  assert.equal(broker.store.getThread("w1fn-reg-ok")!.name, "plain session");
});

test("hook session names go through the same validator", async () => {
  for (const [id, name] of [["w1fn-hook", "chatgpt"], ["w1fn-hook2", "x(remote)"], ["w1fn-hook-peer", "hetzner-lab"], ["w1fn-hook-omp", "sam (devbox)"]] as const) {
    await broker.hook({ threadId: id, event: "SessionStart", cwd: "/work/w1fn", name });
    const got = broker.store.getThread(id)!.name!;
    assert.ok(!/chatgpt|x\(remote\)|hetzner-lab|sam \(devbox\)/.test(got), `${name} falls back to the folder default, got ${got}`);
  }
  const t = await broker.hook({ threadId: "w1fn-hook3", event: "SessionStart", cwd: "/work/w1fn", name: "fine name" });
  assert.equal(t.context === undefined || typeof t.context === "string", true);
  assert.equal(broker.store.getThread("w1fn-hook3")!.name, "fine name");
});

const hookPayloads: Record<string, unknown>[] = [];
const fakeSpawn = () => {
  const handlers = new Map<string, ((arg?: unknown) => void)[]>();
  const child = {
    stdin: { end: (stdin: string) => void hookPayloads.push(JSON.parse(stdin as string)), on: () => {} },
    stdout: { setEncoding: () => {}, on: (event: string, handler: (arg?: unknown) => void) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    on: (event: string, handler: () => void) => {
      if (event === "close") queueMicrotask(() => handler());
    },
    kill: () => false,
  };
  return child;
};

const driveOmpName = async (sessionName: string): Promise<Record<string, unknown>[]> => {
  hookPayloads.length = 0;
  const seen: Record<string, { handler: (event: Record<string, unknown>, ctx: never) => Promise<unknown> }[]> = {};
  const pi = {
    zod: { object: (shape: Record<string, unknown>) => shape },
    getSessionName: () => sessionName,
    on: (event: string, handler: (event: Record<string, unknown>, ctx: never) => Promise<unknown>) => void (seen[event] ??= []).push({ handler }),
    registerTool: () => {},
    sendMessage: () => {},
  };
  createOmpExtension({ spawn: fakeSpawn as never, randomBytes: () => ({ toString: () => "ab".repeat(12) }), node: "node", cli: "cli", tools: [] }, pi as never);
  const ctx = { agent: { kind: "main" }, sessionManager: { getSessionId: () => "sess-1" }, cwd: "/work/w1fn" };
  for (const { handler } of seen.session_start ?? []) await handler({}, ctx as never);
  return hookPayloads.filter((p) => typeof p.session === "string");
};

test("the OMP extension never sends a hostile session name to the hook", async () => {
  for (const name of OMP_LOCAL) {
    const payloads = await driveOmpName(name);
    assert.ok(payloads.length > 0, `a hook ran for ${name}`);
    assert.equal(payloads[0]!.name, undefined, `${name} must not reach the hook`);
  }
  const peerEqual = await driveOmpName("hetzner-lab");
  assert.equal(peerEqual[0]!.name, "hetzner-lab", "a peer-equal name still reaches the hook, where register refuses it");
  await broker.hook({ threadId: "w1fn-omp-peer", event: "SessionStart", cwd: "/work/w1fn", name: String(peerEqual[0]!.name) });
  assert.notEqual(broker.store.getThread("w1fn-omp-peer")!.name, "hetzner-lab");
  const clean = await driveOmpName("my omp session");
  assert.equal(clean[0]!.name, "my omp session");
});
