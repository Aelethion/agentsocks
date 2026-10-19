import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { gatewayOf } from "../src/gateway/runtime.ts";
import { localTailnet, type Tailnet } from "../src/gateway/tailscale.ts";
import { sourceCheck } from "../src/gateway/source.ts";
import { fakeLocalApi, fakeServe, raw, type FakeLocalApi, type FakeServe } from "./gatewaysupport.ts";

const broker = new Broker();
let api: FakeLocalApi;
let port = 0;
const direct = () => `http://127.0.0.1:${port}`;

type StatusResult = { private: { listening: boolean; port: number | null; wanted: boolean; error?: string }; public: { listening: boolean }; killSwitch: boolean; peers: { name: string }[] };
const status = async (): Promise<StatusResult> => (await broker.dispatch({ op: "gateway_status" })).result as StatusResult;

before(async () => {
  api = await fakeLocalApi();
  process.env.TS_SOCKET = api.socketPath;
  await broker.start();
});

after(async () => {
  await broker.stop();
  await api.close();
});

test("nothing listens until the gateway is switched on, and a sweep does not switch it on", async () => {
  await broker.runSweep();
  const s = await status();
  assert.deepEqual([s.private.wanted, s.private.listening, s.private.port, s.public.listening], [false, false, null, false]);
});

test("gateway on listens on the loopback address only and reports the port", async () => {
  const result = (await broker.dispatch({ op: "gateway_on", port: 0 })).result as StatusResult;
  assert.equal(result.private.listening, true);
  port = result.private.port!;
  assert.ok(port > 0);
  assert.equal((await raw(direct(), "/nothing")).status, 404);
  const external = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv4");
  if (external) {
    const refused = await new Promise<string>((resolve) => {
      const sock = connect({ host: external.address, port });
      sock.once("connect", () => (sock.destroy(), resolve("connected")));
      sock.once("error", (err) => resolve((err as NodeJS.ErrnoException).code ?? "error"));
    });
    assert.equal(refused, "ECONNREFUSED", "the listener is not reachable on a non-loopback address");
  }
});

test("a request that did not come through tailscale serve is refused with no identity", async () => {
  const r = await raw(direct(), "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.match(String(r.json() && (r.json() as { error: string }).error), /Tailscale identity/);
});

test("a request that carries a Funnel marker is refused, even with a valid identity", async () => {
  api.machines.set("100.64.0.10", { name: "phone", login: "sam@example.com", ip: "100.64.0.10" });
  const serve = await fakeServe(port, { login: "sam@example.com", ip: "100.64.0.10" }, { "tailscale-funnel-request": "?1" });
  try {
    const r = await raw(serve.url, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 403);
    assert.match((r.json() as { error: string }).error, /funnel/);
  } finally {
    await serve.close();
  }
});

async function through(machine: { login: string; ip: string }, extra: Record<string, string> = {}, host?: string): Promise<{ status: number; error: string }> {
  const serve: FakeServe = await fakeServe(port, machine, extra, host);
  try {
    const r = await raw(serve.url, "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    return { status: r.status, error: (() => { try { return (r.json() as { error?: string }).error ?? ""; } catch { return ""; } })() };
  } finally {
    await serve.close();
  }
}

test("a forged identity header is refused: the login must match the node tailscale says connected", async () => {
  api.machines.set("100.64.0.11", { name: "laptop", login: "sam@example.com", ip: "100.64.0.11" });
  const forged = await through({ login: "someone-else@example.com", ip: "100.64.0.11" });
  assert.equal(forged.status, 403);
  assert.match(forged.error, /does not match/);
});

test("an address tailscale does not know, a missing source address and a tagged node are refused", async () => {
  const unknown = await through({ login: "sam@example.com", ip: "100.64.9.9" });
  assert.equal(unknown.status, 403);
  api.machines.set("100.64.0.12", { name: "build-box", login: "tagged-devices", ip: "100.64.0.12", tags: ["tag:ci"] });
  const tagged = await through({ login: "tagged-devices", ip: "100.64.0.12" });
  assert.equal(tagged.status, 403);
  assert.match(tagged.error, /tagged/);
  const direct401 = await raw(direct(), "/mcp", { method: "POST", headers: { "content-type": "application/json", "tailscale-user-login": "sam@example.com" }, body: "{}" });
  assert.equal(direct401.status, 401);
  assert.match((direct401.json() as { error: string }).error, /source address/);
});

test("another user's node is refused: only the user this node belongs to gets in", async () => {
  api.machines.set("100.64.0.13", { name: "guest", login: "guest@example.org", ip: "100.64.0.13" });
  const guest = await through({ login: "guest@example.org", ip: "100.64.0.13" });
  assert.equal(guest.status, 403);
  assert.match(guest.error, /only the user this node belongs to/);
});

test("a Host header that is not this node's name, or an Origin from another site, is refused", async () => {
  api.machines.set("100.64.0.14", { name: "laptop2", login: "sam@example.com", ip: "100.64.0.14" });
  const rebinding = await through({ login: "sam@example.com", ip: "100.64.0.14" }, {}, "evil.example.com");
  assert.equal(rebinding.status, 403);
  assert.match(rebinding.error, /Host/);
  const crossOrigin = await through({ login: "sam@example.com", ip: "100.64.0.14" }, { origin: "https://evil.example.com" });
  assert.equal(crossOrigin.status, 403);
  assert.match(crossOrigin.error, /cross-origin/);
  const crossSite = await through({ login: "sam@example.com", ip: "100.64.0.14" }, { "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.status, 403);
});

test("a page that rebinds its own name to this machine cannot vouch for itself with a header it writes", async () => {
  api.machines.set("100.64.0.19", { name: "laptop6", login: "sam@example.com", ip: "100.64.0.19" });
  const forwardedHost = await through({ login: "sam@example.com", ip: "100.64.0.19" }, { "x-forwarded-host": "localhost" }, "evil.example.com");
  assert.equal(forwardedHost.status, 403);
  assert.match(forwardedHost.error, /Host/);
  const matchingOrigin = await through({ login: "sam@example.com", ip: "100.64.0.19" }, { origin: "https://evil.example.com", "x-forwarded-host": "evil.example.com" }, "evil.example.com");
  assert.equal(matchingOrigin.status, 403, "an Origin that matches the attacker's own Host is still not one of this node's names");
  const ours = await through({ login: "sam@example.com", ip: "100.64.0.19" }, { origin: "https://devbox.tail1234.ts.net" });
  assert.notEqual(ours.status, 403, "the tailnet name as Origin is accepted");
});

test("the owner's node gets in and appears as a remote peer named after the node", async () => {
  api.machines.set("100.64.0.15", { name: "hetzner-lab", login: "sam@example.com", ip: "100.64.0.15" });
  const ok = await through({ login: "sam@example.com", ip: "100.64.0.15" });
  assert.notEqual(ok.status, 401);
  assert.notEqual(ok.status, 403);
  const peers = (await status()).peers.map((p) => p.name);
  assert.ok(peers.includes("hetzner-lab"));
});

test("LocalAPI is asked about the address the proxy saw, and its answers are cached for the next request", async () => {
  const before = api.asked.filter((a) => a.includes("whois")).length;
  await through({ login: "sam@example.com", ip: "100.64.0.15" });
  assert.equal(api.asked.filter((a) => a.includes("whois")).length, before, "a second request from the same address does not ask again");
  assert.ok(api.asked.some((a) => a.includes("addr=100.64.0.15%3A0")));
});

test("an unknown route is 404 and a wrong method is 405 with the methods that work", async () => {
  api.machines.set("100.64.0.16", { name: "laptop3", login: "sam@example.com", ip: "100.64.0.16" });
  const serve = await fakeServe(port, { login: "sam@example.com", ip: "100.64.0.16" });
  try {
    assert.equal((await raw(serve.url, "/nope")).status, 404);
    const get = await raw(serve.url, "/mcp");
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");
  } finally {
    await serve.close();
  }
});

test("a connection that did not come from tailscaled is refused, whatever headers it carries", { skip: process.platform !== "linux" }, async () => {
  api.machines.set("100.64.0.17", { name: "laptop4", login: "sam@example.com", ip: "100.64.0.17" });
  const gateway = gatewayOf(broker);
  const original = gateway.source;
  const uid = process.getuid!();
  Object.defineProperty(gateway, "source", { value: sourceCheck({ platform: "linux", ownUid: uid, expectedUid: () => uid + 1, tcpTablesAsync: async () => [] }), configurable: true });
  try {
    const refused = await through({ login: "sam@example.com", ip: "100.64.0.17" });
    assert.equal(refused.status, 403);
    assert.match(refused.error, /did not come through tailscale serve/);
  } finally {
    Object.defineProperty(gateway, "source", { value: original, configurable: true });
  }
  assert.notEqual((await through({ login: "sam@example.com", ip: "100.64.0.17" })).status, 403);
});

test("a node owned by tags has no user, so the people who may use the gateway are named explicitly", async () => {
  const gateway = gatewayOf(broker);
  const original = gateway.tailnet;
  (gateway as { tailnet: Tailnet }).tailnet = localTailnet({ cacheMs: 0, selfCacheMs: 0 });
  api.setOwner("tagged-devices", "devbox.tail1234.ts.net");
  api.machines.set("100.64.0.18", { name: "laptop5", login: "sam@example.com", ip: "100.64.0.18" });
  try {
    const refused = await through({ login: "sam@example.com", ip: "100.64.0.18" });
    assert.equal(refused.status, 403);
    assert.match(refused.error, /only the user this node belongs to/);
    await broker.dispatch({ op: "gateway_allow", user: "Sam@Example.com" });
    assert.notEqual((await through({ login: "sam@example.com", ip: "100.64.0.18" })).status, 403);
    assert.deepEqual(((await broker.dispatch({ op: "gateway_status" })).result as { users: string[] }).users, ["sam@example.com"]);
    await broker.dispatch({ op: "gateway_allow", user: "sam@example.com", allowed: false });
    assert.equal((await through({ login: "sam@example.com", ip: "100.64.0.18" })).status, 403);
    await assert.rejects(broker.dispatch({ op: "gateway_allow", user: "not a login" }), /give the tailnet login/);
  } finally {
    api.setOwner("sam@example.com", "devbox.tail1234.ts.net");
    (gateway as { tailnet: Tailnet }).tailnet = original;
  }
});

test("the kill switch answers 503 on the next request, and a sweep closes the listener", async () => {
  mkdirSync(join(root, "config", "agentsocks"), { recursive: true });
  const off = join(root, "config", "agentsocks", "off");
  writeFileSync(off, "");
  try {
    const r = await raw(direct(), "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 503);
    await broker.runSweep();
    assert.equal((await status()).private.listening, false);
    await assert.rejects(raw(direct(), "/mcp"), /fetch failed/);
  } finally {
    rmSync(off, { force: true });
  }
  await broker.runSweep();
  assert.equal((await status()).private.listening, true, "when the switch is lifted the sweep brings the listener back");
  port = (await status()).private.port!;
});

test("gateway off closes the listener and a restarted sweep does not bring it back", async () => {
  await broker.dispatch({ op: "gateway_off" });
  assert.equal((await status()).private.listening, false);
  await broker.runSweep();
  assert.equal((await status()).private.listening, false);
  await assert.rejects(raw(direct(), "/mcp"), /fetch failed/);
});
