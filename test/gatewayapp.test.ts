import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createVerify } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { buildEnvelope, messageContent, parseEnvelope } from "../src/envelope.ts";
import { codexIdentity } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { createTask } from "../src/ops.ts";
import { fakeLocalApi, fakeServe, raw, type FakeLocalApi, type FakeServe } from "./gatewaysupport.ts";

const broker = new Broker();
let api: FakeLocalApi;
let serve: FakeServe;
let alpha: FakeClaude;
let pushServer: Server;
let pushed: { path: string; authorization: string | undefined; length: number; status: number }[] = [];
let pushStatus = 201;
let pushUrl = "";
let publicKey = "";

const JSON_HEADERS = { "content-type": "application/json" };
const APP = { "x-agentsocks-app": "1" };
const get = (path: string, headers: Record<string, string> = {}) => raw(serve.url, path, { headers: path.startsWith("/app/api/") ? { ...APP, ...headers } : headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => raw(serve.url, path, { method: "POST", headers: { ...APP, ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });

before(async () => {
  process.env.AGENTSOCKS_PUSH_HOSTS = "127.0.0.1";
  api = await fakeLocalApi();
  process.env.TS_SOCKET = api.socketPath;
  api.machines.set("100.64.3.1", { name: "iphone-14", login: "sam@example.com", ip: "100.64.3.1", os: "iOS" });
  pushServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      pushed.push({ path: req.url ?? "", authorization: req.headers.authorization, length: Buffer.concat(chunks).length, status: pushStatus });
      res.writeHead(pushStatus);
      res.end();
    });
  });
  await new Promise<void>((resolve) => pushServer.listen(0, "127.0.0.1", resolve));
  pushUrl = `http://127.0.0.1:${(pushServer.address() as { port: number }).port}/send/abc123`;
  await broker.start();
  alpha = await fakeClaude("alpha", livePid(), "idle");
  const on = (await broker.dispatch({ op: "gateway_on", port: 0 })).result as { private: { port: number } };
  serve = await fakeServe(on.private.port, { login: "sam@example.com", ip: "100.64.3.1" }, {}, "devbox.tail1234.ts.net");
});

after(async () => {
  await serve.close();
  await closeServer(alpha.server);
  await broker.stop();
  await api.close();
  await new Promise<void>((resolve) => (pushServer.closeAllConnections(), pushServer.close(() => resolve())));
});

test("the app and its assets are served over the tailnet only, with a CSP that carries a fresh nonce", async () => {
  assert.equal((await raw(`http://127.0.0.1:${await currentPort()}`, "/app")).status, 401);
  const page = await get("/app");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  const csp = page.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.ok(page.text.includes(`nonce="${nonce}"`));
  const again = await get("/app");
  assert.notEqual(/script-src 'nonce-([^']+)'/.exec(again.headers.get("content-security-policy") ?? "")![1], nonce);
  assert.doesNotMatch(page.text, /https?:\/\//);
  const manifest = await get("/app/manifest.webmanifest");
  assert.equal((manifest.json() as { start_url: string }).start_url, "/app/");
  assert.equal((await get("/app/")).status, 200, "the installed app opens the page at its scope");
  const worker = await get("/app/sw.js");
  assert.equal(worker.headers.get("service-worker-allowed"), "/app/");
  assert.match(worker.headers.get("content-type") ?? "", /javascript/);
  const icon = await fetch(`${serve.url}/app/icon.png`);
  assert.deepEqual([...new Uint8Array(await icon.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("the human appears as a peer named after their login and the kind of device, and sees the sessions they can message", async () => {
  const state = (await get("/app/api/state")).json() as { me: { name: string; login: string; node: string }; peers: { name: string; kind: string }[]; unread: number; tasks: number; push: { key: string; subscribed: boolean } };
  assert.deepEqual(state.me, { name: "sam (phone)", login: "sam@example.com", node: "iphone-14" });
  assert.ok(state.peers.some((p) => p.name === "alpha" && p.kind === "claude"));
  assert.ok(!state.peers.some((p) => p.name === "sam (phone)"));
  assert.equal(state.unread, 0);
  assert.match(state.push.key, /^[A-Za-z0-9_-]{87}$/);
  assert.equal(state.push.subscribed, false);
  publicKey = state.push.key;
});

test("a message to the human is read once in the app, then kept in the history", async () => {
  const codex = await codexIdentity("codex-app-1", "/work/appcheck");
  await sendMessage(codex, "sam", "deploy is waiting for your ok");
  assert.equal(((await get("/app/api/state")).json() as { unread: number }).unread, 1);
  const inbox = (await get("/app/api/inbox")).json() as { messages: { kind: string; from: string; body: string; at: number }[]; remaining: number };
  assert.equal(inbox.messages.length, 1);
  assert.deepEqual([inbox.messages[0]!.kind, inbox.messages[0]!.from, inbox.messages[0]!.body], ["message", "codex-appcheck (codex)", "deploy is waiting for your ok"]);
  assert.equal(((await get("/app/api/inbox")).json() as { messages: unknown[] }).messages.length, 0, "read once");
  const history = (await get("/app/api/history?limit=10")).json() as { messages: { body: string }[] };
  assert.deepEqual(history.messages.map((m) => m.body).slice(-1), ["deploy is waiting for your ok"]);
});

test("the inbox can be waited on: it returns as soon as something arrives", async () => {
  const codex = await codexIdentity("codex-app-2", "/work/appwait");
  const started = Date.now();
  const waiting = get("/app/api/inbox?wait=10");
  await new Promise((r) => setTimeout(r, 300));
  await sendMessage(codex, "sam", "arrived while you were waiting");
  const got = (await waiting).json() as { messages: { body: string }[] };
  assert.equal(got.messages[0]?.body, "arrived while you were waiting");
  assert.ok(Date.now() - started < 4000);
});

test("a message the human sends reaches the session with the urgency they chose and the human's name", async () => {
  const sent = await post("/app/api/send", { to: "alpha", message: "ship it", urgency: "urgent" });
  assert.equal(sent.status, 200);
  const body = sent.json() as { ok: boolean; to: { name: string; kind: string } };
  assert.deepEqual([body.ok, body.to.name, body.to.kind], [true, "alpha", "claude"]);
  const frame = await until(() => alpha.frames.find((f) => parseEnvelope(messageContent(f))?.body === "ship it"));
  assert.equal(parseEnvelope(messageContent(frame))!.fromName, "sam (phone)");
  assert.equal(parseEnvelope(messageContent(frame))!.fromMode, undefined);
  const row = broker.store.db.prepare("SELECT urgency FROM outbox WHERE body_chars = ? ORDER BY created_at DESC LIMIT 1").get("ship it".length) as { urgency: string };
  assert.equal(row.urgency, "urgent");
  assert.equal((await post("/app/api/send", { to: "nobody", message: "x" })).status, 400);
  assert.equal((await post("/app/api/send", { to: "uds:/tmp/x.sock", message: "x" })).status, 400);
  assert.equal((await post("/app/api/send", { to: "alpha", message: "" })).status, 400);
});

test("state-changing requests from another origin or site are refused, and so is a missing identity", async () => {
  assert.equal((await post("/app/api/send", { to: "alpha", message: "csrf" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/app/api/send", { to: "alpha", message: "csrf" }, { "sec-fetch-site": "cross-site" })).status, 403);
  const direct = await raw(`http://127.0.0.1:${await currentPort()}`, "/app/api/state");
  assert.equal(direct.status, 401);
  const wrongType = await raw(serve.url, "/app/api/send", { method: "POST", headers: { ...APP, "content-type": "text/plain" }, body: '{"to":"alpha","message":"x"}' });
  assert.equal(wrongType.status, 415);
  assert.ok(!alpha.frames.some((f) => parseEnvelope(messageContent(f))?.body === "csrf"));
});

test("the app's own routes answer only requests that carry its header, which another site cannot add", async () => {
  for (const path of ["/app/api/state", "/app/api/inbox", "/app/api/history", "/app/api/tasks"]) {
    const bare = await raw(serve.url, path);
    assert.equal(bare.status, 403, path);
  }
  const bareSend = await raw(serve.url, "/app/api/send", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ to: "alpha", message: "no header" }) });
  assert.equal(bareSend.status, 403);
  assert.ok(!alpha.frames.some((f) => parseEnvelope(messageContent(f))?.body === "no header"));
  assert.equal((await raw(serve.url, "/app")).status, 200, "the page itself needs no header");
});

async function currentPort(): Promise<number> {
  return ((await broker.dispatch({ op: "gateway_status" })).result as { private: { port: number } }).private.port;
}

test("tasks assigned to the human can be listed and moved from the app", async () => {
  const codex = await codexIdentity("codex-app-3", "/work/apptask");
  const made = await createTask(codex, { to: "sam", title: "approve the release", details: "the checklist is in RELEASE.md" });
  const listed = (await get("/app/api/tasks")).json() as { tasks: { id: string; mine: string; title: string; status: string }[] };
  const mine = listed.tasks.find((t) => t.id === made.task.id)!;
  assert.deepEqual([mine.mine, mine.title, mine.status], ["assignee", "approve the release", "open"]);
  const moved = await post("/app/api/tasks/update", { taskId: made.task.id, status: "done", result: "approved" });
  assert.equal(moved.status, 200);
  assert.equal(broker.store.getTask(made.task.id)!.status, "done");
  assert.equal((await post("/app/api/tasks/update", { taskId: made.task.id, status: "bogus" })).status, 400);
});

function verifyVapid(authorization: string, endpoint: string): void {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(authorization)!;
  assert.ok(m, "a vapid Authorization header");
  const claims = JSON.parse(Buffer.from(m[2]!, "base64url").toString()) as { aud: string; exp: number; sub: string };
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 13 * 3600);
  assert.match(claims.sub, /^https:\/\//);
  assert.equal(m[4], publicKey);
  const point = Buffer.from(m[4]!, "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
  const ok = createVerify("sha256").update(`${m[1]}.${m[2]}`).verify({ key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3]!, "base64url"));
  assert.ok(ok, "the JWT is signed by the VAPID key");
}

test("Web Push is content-free, signed with the VAPID key, rate-limited, and a gone subscription is dropped", async () => {
  const refused = await post("/app/api/push/subscribe", { endpoint: "https://evil.example/push/1", keys: { p256dh: "a", auth: "b" } });
  assert.equal(refused.status, 400, "only push services agentsocks knows are called");
  assert.equal((await post("/app/api/push/subscribe", { endpoint: pushUrl })).status, 400);
  assert.equal((await post("/app/api/push/subscribe", { endpoint: pushUrl, keys: { p256dh: "BPubKeyForTestsOnly", auth: "authsecret" } })).status, 200);
  assert.equal(((await get("/app/api/state")).json() as { push: { subscribed: boolean } }).push.subscribed, true);

  const codex = await codexIdentity("codex-app-4", "/work/apppush");
  pushed = [];
  await sendMessage(codex, "sam", "first push-worthy message");
  await broker.runSweep();
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]!.length, 0, "no payload, so no content");
  assert.equal(pushed[0]!.path, "/send/abc123");
  verifyVapid(pushed[0]!.authorization!, pushUrl);

  await sendMessage(codex, "sam", "a second one right after");
  await broker.runSweep();
  assert.equal(pushed.length, 1, "one push per burst");

  await get("/app/api/inbox");
  await broker.runSweep();
  process.env.AGENTSOCKS_PUSH_GAP_MS = "0";
  pushStatus = 410;
  await sendMessage(codex, "sam", "a third one, after reading");
  await broker.runSweep();
  assert.equal(pushed.length, 2, "after the app read everything the next message pushes again");
  assert.equal(((await get("/app/api/state")).json() as { push: { subscribed: boolean } }).push.subscribed, false, "a 410 from the push service drops the subscription");
  pushStatus = 201;
  await get("/app/api/inbox");
});

test("a subscription cannot be taken over by another device, and one device cannot hold an unbounded number", async () => {
  api.machines.set("100.64.3.2", { name: "ipad", login: "sam@example.com", ip: "100.64.3.2", os: "iOS" });
  const port = ((await broker.dispatch({ op: "gateway_status" })).result as { private: { port: number } }).private.port;
  const other = await fakeServe(port, { login: "sam@example.com", ip: "100.64.3.2" }, {}, "devbox.tail1234.ts.net");
  try {
    const mine = `${pushUrl}-mine`;
    const keys = { p256dh: "BPubKeyForTestsOnly", auth: "authsecret" };
    assert.equal((await post("/app/api/push/subscribe", { endpoint: mine, keys })).status, 200);
    const theirs = await raw(other.url, "/app/api/push/subscribe", { method: "POST", headers: { ...APP, ...JSON_HEADERS }, body: JSON.stringify({ endpoint: mine, keys }) });
    assert.equal(theirs.status, 409);
    for (let i = 0; i < 12; i++) await post("/app/api/push/subscribe", { endpoint: `${pushUrl}-n${i}`, keys });
    const count = (broker.store.db.prepare("SELECT COUNT(*) AS n FROM gateway_push WHERE peer_id LIKE 'tailnet:%:app' AND endpoint LIKE ?").get(`${pushUrl}-%`) as { n: number }).n;
    assert.ok(count <= 10, `${count} subscriptions for one device`);
    broker.store.db.prepare("DELETE FROM gateway_push WHERE endpoint LIKE ?").run(`${pushUrl}-%`);
  } finally {
    await other.close();
  }
});

test("a message to the human with no subscription pushes nothing", async () => {
  pushed = [];
  const codex = await codexIdentity("codex-app-5", "/work/appquiet");
  await sendMessage(codex, "sam", "nobody to push to");
  await broker.runSweep();
  assert.equal(pushed.length, 0);
  await get("/app/api/inbox");
});

test("the kill switch stops pushes too", async () => {
  assert.equal((await post("/app/api/push/subscribe", { endpoint: pushUrl, keys: { p256dh: "BPubKeyForTestsOnly", auth: "authsecret" } })).status, 200);
  await broker.runSweep();
  pushed = [];
  const thread = (broker.store.db.prepare("SELECT thread_id FROM gateway_peers WHERE id LIKE 'tailnet:%:app'").get() as { thread_id: string }).thread_id;
  const off = join(process.env.XDG_CONFIG_HOME!, "agentsocks");
  mkdirSync(off, { recursive: true });
  writeFileSync(join(off, "off"), "");
  try {
    broker.onFrame(thread, { type: "user", message: { role: "user", content: buildEnvelope({ fromName: "alpha", body: "while switched off" }) }, priority: "next", msg_id: "kill-push-1" });
    await new Promise((r) => setTimeout(r, 200));
    await broker.runSweep();
    assert.equal(pushed.length, 0);
  } finally {
    rmSync(join(off, "off"), { force: true });
  }
  await broker.runSweep();
  assert.equal(pushed.length, 1, "and when it is lifted the waiting message pushes");
});
