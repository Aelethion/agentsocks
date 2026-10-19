import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { sendMessage } from "../src/send.ts";
import type { Me } from "../src/peers.ts";
import { raw } from "./gatewaysupport.ts";
import { formatReport, stoppedLines, type GatewayReport, type StoppedReport } from "../src/commands/gateway.ts";
import { gatewayOf, uninstallGateway } from "../src/gateway/runtime.ts";
import { gatewayState, randomLoopbackPort } from "../src/gateway/state.ts";
import { sourceCheck } from "../src/gateway/source.ts";
import { saveSubscription, subscriptionsOf } from "../src/gateway/push.ts";
import { OAuthStore, ensureOauthPeer } from "../src/gateway/oauth.ts";
import { fakeClaude, livePid, root, until, type FakeClaude } from "./support.ts";
import { tempDir } from "./tmp.ts";

const exec = promisify(execFile);
type Report = GatewayReport & { stopped?: StoppedReport };

const broker = new Broker();
let alpha: FakeClaude;
let provider: Server;
let providerBase = "";
let providerHits = 0;
let keyFile = "";

const alphaMe = (): Me => ({ kind: "claude", name: "w1ops-alpha", socketPath: alpha.socketPath, session: alpha.sessionId });
const call = async <T>(op: string, args: Record<string, unknown> = {}): Promise<T> => (await broker.dispatch({ op, ...args })).result as T;
const status = (): Promise<Report> => call<Report>("gateway_status");

before(async () => {
  keyFile = join(tempDir("w1ops-key-"), "xai.env");
  writeFileSync(keyFile, "XAI_API_KEY=fake-not-a-real-key-0000000000\n", { mode: 0o600 });
  provider = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      providerHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  providerBase = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  await broker.start();
  alpha = await fakeClaude("w1ops-alpha", livePid(), "idle");
  broker.store.upsertThread("w1ops-thread-1", { name: "w1ops-coder" }, "w1ops-coder");
});

after(async () => {
  delete process.env.AGENTSOCKS_OFF;
  await closeServer(alpha.server);
  await broker.stop();
  await new Promise<void>((resolve) => {
    provider.closeAllConnections();
    provider.close(() => resolve());
  });
});

test("a fresh install gets a random loopback port kept in gateway state, never the old fixed ports", () => {
  assert.ok(randomLoopbackPort() >= 20000 && randomLoopbackPort() < 60000);
  const gateway = gatewayOf(broker);
  const priv = gateway.privateSettings();
  const pub = gateway.publicSettings();
  for (const port of [priv.port, pub.port]) {
    assert.ok(Number.isInteger(port) && port >= 20000 && port < 60000, `default port ${port} is a per-install random loopback port`);
    assert.ok(port !== 8787 && port !== 8788);
  }
  assert.equal(gatewayOf(broker).privateSettings().port, priv.port, "the port is stored, not re-rolled");
  assert.equal(gatewayState(broker.store).setting("private") !== undefined, true);
});

test("a loopback port another process holds is refused with a plain message, and serve is never left pointing at it", async () => {
  const blocker = createNetServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const taken = (blocker.address() as { port: number }).port;
  try {
    const report = await call<Report>("gateway_on", { port: taken });
    assert.equal(report.private.listening, false);
    assert.match(report.private.error ?? "", new RegExp(`port ${taken} on 127\\.0\\.0\\.1 is already in use by another process`));
    await assert.rejects(call("gateway_served", { served: true }), /no port for tailscale serve/);
    assert.equal(gatewayOf(broker).privateSettings().served, false);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
  await call("gateway_off");
});

test("gateway off stops the private and public listeners, API peers and in-flight polls, and says what it stopped", async () => {
  const on = await call<Report>("gateway_on", { port: 0 });
  assert.equal(on.private.listening, true);
  const pub = await call<Report>("gateway_public", { via: "funnel", port: 0 });
  assert.equal(pub.public.listening, true);
  const publicBase = `http://127.0.0.1:${pub.public.port}`;
  const tok = await call<{ token: string; id: string }>("gateway_token_add", { name: "w1ops-off", mayMessage: ["w1ops-alpha"] });
  await call("peer_api_add", { name: "w1ops-grok", provider: "xai", keyFile, baseUrl: providerBase, mayMessage: ["w1ops-alpha"] });

  let pollClosed = false;
  gatewayOf(broker).registerPoll({ peerId: `token:${tok.id}`, route: "test" }, () => {
    pollClosed = true;
  });

  const off = await call<Report>("gateway_off");
  assert.equal(off.private.listening, false, "the private listener stops");
  assert.equal(off.public.listening, false, "the public listener stops too, not only the private one");
  assert.equal(off.stopped?.privateStopped, true);
  assert.equal(off.stopped?.publicStopped, true);
  assert.equal(off.stopped?.polls, 1, "in-flight long polls end at once");
  assert.equal(off.stopped?.apiPeers, 1);
  assert.equal(pollClosed, true);
  const said = stoppedLines(off.stopped!, 1111, 2222).join("\n");
  assert.match(said, /Stopped: private listener \(127\.0\.0\.1:1111\), public listener \(127\.0\.0\.1:2222\), 1 API peer paused, 1 in-flight request ended\./);
  await assert.rejects(raw(publicBase, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), "nothing answers on the public port after off");

  const hitsBefore = providerHits;
  await sendMessage(alphaMe(), "w1ops-grok (api)", "are you paused after gateway off?");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(providerHits, hitsBefore, "the API peer makes no provider call while the gateway is off");

  await broker.runSweep();
  const again = await status();
  assert.equal(again.private.listening, false, "a sweep does not bring the private listener back");
  assert.equal(again.public.listening, false, "a sweep does not bring the public listener back");
});

test("the kill switch answers 503 on every route and ends in-flight polls at once", async () => {
  const on = await call<Report>("gateway_on", { port: 0 });
  const privateBase = `http://127.0.0.1:${on.private.port}`;
  const tok = await call<{ token: string; id: string }>("gateway_token_add", { name: "w1ops-kill", mayMessage: ["w1ops-alpha"] });
  let pollClosed = false;
  gatewayOf(broker).registerPoll({ peerId: `token:${tok.id}`, route: "test" }, () => {
    pollClosed = true;
  });
  process.env.AGENTSOCKS_OFF = "1";
  try {
    const r = await raw(privateBase, "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", Authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    assert.equal(r.status, 503);
    assert.equal(pollClosed, true, "the kill switch ends in-flight long polls");
  } finally {
    delete process.env.AGENTSOCKS_OFF;
  }
  await call("gateway_off");
});

test("a non-canonical path is refused with 404 before routing", async () => {
  const gateway = gatewayOf(broker);
  const original = gateway.source;
  Object.defineProperty(gateway, "source", { value: sourceCheck({ platform: "darwin", ownUid: 501, expectedUid: () => 0 }), configurable: true });
  const on = await call<Report>("gateway_on", { port: 0 });
  const verbatim = (path: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: on.private.port!, path, method: "GET" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
  try {
    for (const path of ["//mcp", "/app/../mcp", "/%2e%2e/mcp", "/./mcp"]) assert.equal(await verbatim(path), 404, path);
  } finally {
    Object.defineProperty(gateway, "source", { value: original, configurable: true });
    await call("gateway_off");
  }
});

test("a new peer name cannot carry @ or brackets, or collide with a live local session", async () => {
  await assert.rejects(call("gateway_token_add", { name: "bad@name" }), /peer name/);
  await assert.rejects(call("gateway_token_add", { name: "evil (remote)" }), /brackets/);
  await assert.rejects(call("gateway_token_add", { name: "w1ops-alpha" }), /already named "w1ops-alpha"/);
  await assert.rejects(call("gateway_token_add", { name: "W1OPS-CODER" }), /already named "w1ops-coder"/);
  await assert.rejects(call("gateway_pair", { name: "w1ops-coder" }), /already named "w1ops-coder"/);
  await assert.rejects(call("peer_api_add", { name: "w1ops-alpha", provider: "xai", keyFile, baseUrl: providerBase, mayMessage: ["w1ops-alpha"] }), /already named "w1ops-alpha"/);
});

test("gateway may stores any non-empty entry verbatim so refs survive renames", async () => {
  await call("gateway_token_add", { name: "w1ops-friend", mayMessage: ["*"] });
  const made = await call<{ peer: string; mayMessage: string[] }>("gateway_may", { peer: "w1ops-friend", mayMessage: ["thread:abc123", "*"] });
  assert.deepEqual(made.mayMessage, ["thread:abc123", "*"]);
  const report = await status();
  assert.deepEqual(report.peers.find((p) => p.name === "w1ops-friend")?.mayMessage, ["thread:abc123", "*"]);
});

test("the JSON report carries the source-check verdict and the human text prints it with may-message lists", async () => {
  const report = await status();
  assert.equal(typeof report.sourceCheck?.enforced, "boolean");
  assert.equal(typeof report.sourceCheck?.detail, "string");
  const text = formatReport(report);
  assert.match(text, /source check +(enforced|NOT enforced)/);
  assert.match(text, /may message thread:abc123, \*/);
});

test("revoking a token ends its long polls and drops its push subscriptions at once", async () => {
  const made = await call<{ id: string }>("gateway_token_add", { name: "w1ops-revokee", mayMessage: ["w1ops-alpha"] });
  const peerId = `token:${made.id}`;
  let pollClosed = false;
  gatewayOf(broker).registerPoll({ peerId, route: "test" }, () => {
    pollClosed = true;
  });
  const state = gatewayState(broker.store);
  assert.equal(saveSubscription(state, peerId, "https://fcm.googleapis.com/w1ops-a", "p256dh-a", "auth-a"), true);
  assert.equal(saveSubscription(state, "token:other", "https://fcm.googleapis.com/w1ops-b", "p256dh-b", "auth-b"), true);
  await call("gateway_token_revoke", { id: made.id });
  assert.equal(pollClosed, true, "revoking ends the peer's long polls at once");
  assert.deepEqual(subscriptionsOf(state, peerId), [], "the revoked peer loses push endpoints immediately");
  assert.equal(subscriptionsOf(state, "token:other").length, 1, "other peers keep theirs");
  assert.equal((await status()).peers.some((p) => p.name === "w1ops-revokee"), false);
  await assert.rejects(call("gateway_token_revoke", { id: made.id }), /already revoked/);
});

test("revoking an OAuth family ends its long polls and drops its push subscriptions", async () => {
  const store = new OAuthStore(broker.store.db);
  const client = store.registerClient("w1ops-client", ["https://app.example.com/cb"])!;
  const code = store.issueCode({ clientId: client.client_id, redirectUri: "https://app.example.com/cb", challenge: "w1ops-challenge", peerName: "w1ops-oauth", mayMessage: JSON.stringify(["w1ops-alpha"]) });
  const taken = store.takeCode(code);
  assert.ok(taken.row);
  const peer = await ensureOauthPeer(gatewayOf(broker), "w1ops-oauth", ["w1ops-alpha"]);
  store.issueTokens(peer.id, client.client_id, taken.row.family);
  let pollClosed = false;
  gatewayOf(broker).registerPoll({ peerId: peer.id, route: "test" }, () => {
    pollClosed = true;
  });
  const state = gatewayState(broker.store);
  assert.equal(saveSubscription(state, peer.id, "https://fcm.googleapis.com/w1ops-c", "p256dh-c", "auth-c"), true);
  await call("gateway_token_revoke", { id: taken.row.family });
  assert.equal(pollClosed, true);
  assert.deepEqual(subscriptionsOf(state, peer.id), []);
});

test("closePollsFor ends only the matching peers' polls and reports the count", () => {
  const gateway = gatewayOf(broker);
  let a = false;
  let b = false;
  gateway.registerPoll({ peerId: "peer-a", route: "test" }, () => {
    a = true;
  });
  gateway.registerPoll({ peerId: "peer-b", route: "test" }, () => {
    b = true;
  });
  assert.equal(gateway.closePollsFor((id) => id === "peer-a"), 1);
  assert.equal(a, true);
  assert.equal(b, false);
  assert.equal(gateway.closePollsFor(() => true), 1);
  assert.equal(b, true);
});

test("uninstall stops the gateway, disables every peer, and archives the state without deleting it", async () => {
  await call("gateway_on", { port: 0 });
  await until(() => gatewayOf(broker).port("private"));
  const done = await uninstallGateway(broker);
  assert.equal(done.stopped.privateStopped, true);
  assert.ok(done.disabled > 0, "tokens, grants and API peers are disabled");
  assert.ok(existsSync(done.archive), "the archive exists");
  assert.ok(done.archive.startsWith(join(process.env.AGENTSOCKS_STATE_DIR ?? join(root, "state"), "backups")));
  assert.ok(readdirSync(join(done.archive, "..")).length >= 1);
  const dump = JSON.parse(readFileSync(done.archive, "utf8")) as Record<string, unknown[]>;
  assert.ok(Array.isArray(dump.gateway_peers) && dump.gateway_peers.length > 0, "the peers are in the archive");
  const after = await status();
  assert.equal(after.private.listening, false);
  assert.equal(after.public.listening, false);
  assert.equal(after.peers.length, 0, "no peer stays enabled");
  assert.ok(gatewayState(broker.store).listPeers().length > 0, "rows are kept, only disabled");
});

test("a burst of requests from one source is limited before authentication", async () => {
  const gateway = gatewayOf(broker);
  const original = gateway.source;
  Object.defineProperty(gateway, "source", { value: sourceCheck({ platform: "darwin", ownUid: 501, expectedUid: () => 0 }), configurable: true });
  const on = await call<Report>("gateway_on", { port: 0 });
  const base = `http://127.0.0.1:${on.private.port}`;
  const statuses = new Set<number>();
  try {
    for (let i = 0; i < 160; i++) statuses.add((await raw(base, "/nothing-here", { headers: { "x-forwarded-for": "198.51.100.77" } })).status);
    assert.ok(statuses.has(404), "early requests are answered normally");
    assert.ok(statuses.has(429), "a burst past the limit is refused before any route or credential is looked at");
  } finally {
    Object.defineProperty(gateway, "source", { value: original, configurable: true });
    await call("gateway_off");
  }
});

test("gateway on refuses when the source check cannot be enforced, unless --allow-unverified-local-source says what that means", async () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = async (args: string[]): Promise<{ code: number; out: string; err: string }> => {
    try {
      const r = await exec(process.execPath, [cli, ...args], { env: process.env, timeout: 30_000 });
      return { code: 0, out: r.stdout, err: r.stderr };
    } catch (e) {
      const x = e as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof x.code === "number" ? x.code : 1, out: x.stdout ?? "", err: x.stderr ?? "" };
    }
  };
  const gateway = gatewayOf(broker);
  const original = gateway.source;
  Object.defineProperty(gateway, "source", { value: sourceCheck({ platform: "darwin", ownUid: 501, expectedUid: () => 0 }), configurable: true });
  try {
    const refused = await run(["gateway", "on", "--port", "0"]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /cannot check who opened a connection.*--allow-unverified-local-source/s);
    assert.equal((await status()).private.listening, false, "nothing was started");
    const allowed = await run(["gateway", "on", "--port", "0", "--allow-unverified-local-source"]);
    assert.equal(allowed.code, 0, allowed.err);
    assert.match(allowed.out, /Source check not enforced .*--allow-unverified-local-source means any program on this machine can present itself as a tailnet device/s);
  } finally {
    Object.defineProperty(gateway, "source", { value: original, configurable: true });
  }
  const off = await run(["gateway", "off"]);
  assert.equal(off.code, 0, off.err);
  assert.match(off.out, /stopped\. Nothing is listening\.\nStopped: private listener \(127\.0\.0\.1:\d+\)/);
});
