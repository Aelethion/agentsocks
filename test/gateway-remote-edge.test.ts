import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { encodeAddress } from "../src/envelope.ts";
import { canonicalPath } from "../src/paths.ts";
import { resolvePeer, type Peer } from "../src/peers.ts";
import { Gateway, tailnetPeer } from "../src/gateway/runtime.ts";
import { gatewayState, mayMessage } from "../src/gateway/state.ts";
import { ensurePeer } from "../src/gateway/remote.ts";
import { mayReach } from "../src/gateway/policy.ts";
import { fakeLocalApi, fakeServe, mcpClient, type FakeLocalApi, type FakeServe } from "./gatewaysupport.ts";

const broker = new Broker();
let api: FakeLocalApi | undefined;
let serve: FakeServe | undefined;
const priorTsSocket = process.env.TS_SOCKET;

async function op<T>(opName: string, req: Record<string, unknown> = {}): Promise<T> {
  const reply: unknown = await broker.dispatch({ op: opName, ...req });
  if (reply && typeof reply === "object" && "result" in reply) return reply.result as T;
  throw new Error(`${opName} returned no result`);
}

before(async () => {
  await broker.start();
});

after(async () => {
  if (serve) await serve.close();
  await broker.dispatch({ op: "gateway_off" }).catch(() => {});
  await broker.stop();
  await api?.close();
  if (priorTsSocket === undefined) delete process.env.TS_SOCKET;
  else process.env.TS_SOCKET = priorTsSocket;
});

test("set_driver refuses a token peer as the driver target", async () => {
  await broker.dispatch({ op: "register", threadId: "w1d_worker04", cwd: "/work/w" });
  const peer = await ensurePeer(broker, { id: "token:w1dx4", name: "w1d-stranger", via: "token", mayMessage: ["*"] });
  const addr = encodeAddress(broker.describe(broker.store.getThread(peer.thread_id)!).socketPath);
  await assert.rejects(broker.dispatch({ op: "set_driver", threadId: "w1d_worker04", addr, name: peer.name }), /local session/);
  assert.equal(broker.store.getThread("w1d_worker04")!.driver_addr, null);
});

test("set_driver still accepts a local session", async () => {
  await broker.dispatch({ op: "register", threadId: "w1d_boss04", cwd: "/work/boss" });
  const dbo = broker.store.getThread("w1d_boss04")!;
  const addr = encodeAddress(broker.describe(dbo).socketPath);
  await broker.dispatch({ op: "set_driver", threadId: "w1d_worker04", addr, name: dbo.name });
  assert.equal(broker.store.getThread("w1d_worker04")!.driver_addr, broker.canon(addr));
});

test("ambiguity text to a remote caller names no cwd", () => {
  const peers: Peer[] = [
    { kind: "codex", name: "alpha", ref: "aa11bb", socketPath: "/run/a.sock", session: "sess-a", cwd: "/clients/Smith & Sons/contract: 2026, final" },
    { kind: "codex", name: "alpha", ref: "cc22dd", socketPath: "/run/b.sock", session: "sess-b", cwd: "/other\tplace" },
  ];
  assert.throws(
    () => resolvePeer(peers, "alpha"),
    (err) => {
      const msg = (err as Error).message;
      assert.ok(!msg.includes("/clients/"), `no cwd leaks: ${msg}`);
      assert.ok(!msg.includes("/other"), `no cwd leaks: ${msg}`);
      assert.ok(msg.includes("aa11bb") && msg.includes("cc22dd"), `refs still disambiguate: ${msg}`);
      return true;
    },
  );
});

const stubPort = (server: Server): number => {
  const addr = server.address();
  if (addr && typeof addr === "object" && "port" in addr && typeof addr.port === "number") return addr.port;
  throw new Error("stub server has no port");
};

// The tsconfig lib predates Promise.withResolvers, so these use the executor form.
const stubPeers = (claimed: string): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/federation/peers") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ host: claimed, peers: [] }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${stubPort(server)}`, close: () => new Promise<void>((done) => server.close(() => done())) }));
  });
test("handshake fails closed when the own tailnet name is unknown", async () => {
  const gw = new Gateway(broker, { whois: async () => undefined, self: async () => undefined });
  try {
    await assert.rejects(gw.federation.handshake("https://evil.example.com:443"), /tailnet/, "refusal precedes any fetch");
    assert.equal(gatewayState(broker.store).host("evil"), undefined);
  } finally {
    await gw.federation.stop();
  }
});

test("a loopback link records the sane claim (local linker, inside the trust boundary)", async () => {
  const stub = await stubPeers("someone-else");
  const gw = new Gateway(broker, { whois: async () => undefined, self: async () => ({ login: "sam@example.com", dnsName: "mybox.tail99.ts.net" }) });
  try {
    const { host } = await gw.federation.handshake(stub.url);
    assert.equal(host, "someone-else");
  } finally {
    await gw.federation.stop();
    await stub.close();
  }
  const vague = await stubPeers("unknown");
  const gw2 = new Gateway(broker, { whois: async () => undefined, self: async () => ({ login: "sam@example.com", dnsName: "mybox.tail99.ts.net" }) });
  try {
    await assert.rejects(gw2.federation.handshake(vague.url), /did not say which machine/);
  } finally {
    await gw2.federation.stop();
    await vague.close();
  }
});

test("an allow entry shorter than 6 hex chars never matches by ref", async () => {
  const peer = await ensurePeer(broker, { id: "token:w1dx10", name: "w1d-hex", via: "token", mayMessage: [] });
  const path = "/w1d/nobody-there";
  const full = createHash("sha256").update(canonicalPath(path)).digest("hex");
  const short = full.slice(0, 2);
  const state = gatewayState(broker.store);
  state.updatePeer(peer.id, { may_message: JSON.stringify([short]) });
  const to = { name: "w1d-nobody", session: null as string | null, addr: encodeAddress(path) };
  assert.equal(mayReach(broker, { session: peer.thread_id }, to), false, `entry ${short} must not match by ref`);
  state.updatePeer(peer.id, { may_message: JSON.stringify([full.slice(0, 6)]) });
  assert.equal(mayReach(broker, { session: peer.thread_id }, to), true, "a 6-char ref prefix still matches");
});

test("a rename to another session's ref text is refused", async () => {
  assert.equal(mayMessage(["deadbeef"], { name: "deadbeef" }), true, "a ref-text name collides by name match, so it must be refused");
  await broker.dispatch({ op: "register", threadId: "w1d_ren10", cwd: "/work/r" });
  await assert.rejects(broker.dispatch({ op: "set_name", threadId: "w1d_ren10", name: "deadbeef" }), /ref/);
  await assert.rejects(broker.dispatch({ op: "set_name", threadId: "w1d_ren10", name: "DEADBEEF" }), /ref/);
  await broker.dispatch({ op: "set_name", threadId: "w1d_ren10", name: "boss-ten" });
  assert.equal(broker.store.getThread("w1d_ren10")!.name, "boss-ten");
});

test("a non-owner tailnet login is marked (remote); the owner's is not", () => {
  const owner = "sam@example.com";
  const me = { login: owner, node: "laptop", nodeId: "n-9", os: null, ip: "100.64.0.2" };
  assert.equal(tailnetPeer(me, "agent", owner).name, "laptop");
  assert.equal(tailnetPeer({ ...me, login: "friend@example.com", ip: "100.64.0.3" }, "agent", owner).name, "laptop (remote)");
  assert.equal(tailnetPeer({ ...me, login: "FRIEND@example.com", ip: "100.64.0.3" }, "agent", owner).name, "laptop (remote)");
  assert.equal(tailnetPeer({ ...me, login: "friend@example.com", node: "iphone", nodeId: "n-2", os: "iOS" }, "app", owner).name, "friend (phone) (remote)");
  assert.equal(tailnetPeer(me, "app", owner).name, "sam (laptop)");
  assert.equal(tailnetPeer({ ...me, login: "friend@example.com" }, "agent").name, "laptop");
});

test("an in-flight federation pull ends when the login allow is removed", async () => {
  api = await fakeLocalApi({ login: "sam@example.com", dnsName: "w1dbox.tail99.ts.net" });
  process.env.TS_SOCKET = api.socketPath;
  api.machines.set("100.64.9.11", { name: "w1d-fed11", login: "friend11@example.com", ip: "100.64.9.11" });
  await op("gateway_allow", { host: "w1d-fed11" });
  await op("gateway_allow", { user: "friend11@example.com" });
  const on = await op<{ private: { port: number } }>("gateway_on", { port: 0 });
  serve = await fakeServe(on.private.port, { login: "friend11@example.com", ip: "100.64.9.11" }, {}, "w1dbox.tail99.ts.net");
  try {
    const started = Date.now();
    const waited = fetch(`${serve.url}/federation/pull?wait=10`, { signal: AbortSignal.timeout(15000) }).then(async (r) => ({ status: r.status, body: await r.text() }));
    // Real delay: the point is a live long-poll hanging while the owner removes the login mid-poll; no event signals that.
    await new Promise((r) => setTimeout(r, 700));
    await op("gateway_allow", { user: "friend11@example.com", allowed: false });
    const got = await waited;
    const elapsed = Date.now() - started;
    assert.equal(got.status, 200, got.body.slice(0, 200));
    assert.deepEqual(JSON.parse(got.body), { items: [] });
    assert.ok(elapsed < 8000, `the poll ended on login disallow after ${elapsed}ms instead of running the full wait`);
  } finally {
    await serve.close();
    serve = undefined;
    await op("gateway_off");
  }
});

test("a tailnet session admitted by user-allow is stored marked (remote)", async () => {
  if (!api) {
    api = await fakeLocalApi({ login: "sam@example.com", dnsName: "w1dbox.tail99.ts.net" });
    process.env.TS_SOCKET = api.socketPath;
  }
  api.machines.set("100.64.9.13", { name: "w1d-node13", login: "friend13@example.com", ip: "100.64.9.13" });
  await op("gateway_allow", { user: "friend13@example.com" });
  const on = await op<{ private: { port: number } }>("gateway_on", { port: 0 });
  serve = await fakeServe(on.private.port, { login: "friend13@example.com", ip: "100.64.9.13" }, {}, "w1dbox.tail99.ts.net");
  try {
    const client = await mcpClient(serve.url);
    try {
      await client.callTool({ name: "list_peers", arguments: {} });
    } finally {
      await client.close();
    }
    const row = gatewayState(broker.store)
      .listPeers()
      .find((p) => p.login === "friend13@example.com" && p.id.endsWith(":agent"));
    assert.ok(row, "the tailnet login has a peer row");
    assert.equal(row!.name, "w1d-node13 (remote)");
    const ownerRow = gatewayState(broker.store)
      .listPeers()
      .find((p) => p.login === "sam@example.com" && p.id.endsWith(":agent"));
    if (ownerRow) assert.ok(!ownerRow.name.endsWith(" (remote)"), `owner node stays as-is: ${ownerRow.name}`);
  } finally {
    await serve.close();
    serve = undefined;
    await op("gateway_off");
  }
});
