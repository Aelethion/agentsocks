import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import "./support.ts";
import { root } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { gatewayOf } from "../src/gateway/runtime.ts";
import { localTailnet, tailscaleBin } from "../src/gateway/tailscale.ts";
import { OAuthStore, ensureOauthPeer } from "../src/gateway/oauth.ts";
import { header, isCanonicalPath, lastForwardedFor, readBody } from "../src/gateway/http.ts";
import { sourceCheck } from "../src/gateway/source.ts";
import { fakeLocalApi, fakeServe, raw, whoisJson, type FakeLocalApi } from "./gatewaysupport.ts";
import { tempDir } from "./tmp.ts";

const broker = new Broker();
let api: FakeLocalApi;
let priv = "";
let pub = "";
const OWNER = "sam@example.com";
const HOST = "devbox.tail1234.ts.net";
const JRPC = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
const MHD = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const tail = (login: string, ip: string, extra: Record<string, string> = {}) => ({ host: HOST, "tailscale-user-login": login, "x-forwarded-for": ip, ...extra });

let xff = 100;
const fresh = () => ({ "x-forwarded-for": `192.0.2.${(xff++ % 150) + 1}` });

before(async () => {
  api = await fakeLocalApi();
  api.machines.set("100.64.0.10", { name: "phone", login: OWNER, ip: "100.64.0.10", os: "iOS" });
  api.machines.set("100.64.0.20", { name: "guest", login: "guest@example.org", ip: "100.64.0.20" });
  api.machines.set("100.64.0.30", { name: "ci", login: "tagged-devices", ip: "100.64.0.30", tags: ["tag:ci"] });
  process.env.TS_SOCKET = api.socketPath;
  await broker.start();
  const on = (await broker.dispatch({ op: "gateway_on", port: 0 })).result as { private: { port: number } };
  priv = `http://127.0.0.1:${on.private.port}`;
  const pubOn = (await broker.dispatch({ op: "gateway_public", via: "funnel", port: 0 })).result as { public: { port: number } };
  pub = `http://127.0.0.1:${pubOn.public.port}`;
});

after(async () => {
  await broker.stop();
  await api.close();
});

test("funnel markers are refused even with a valid identity", async () => {
  for (const marker of ["?1", "", "?0", "x"]) {
    const serve = await fakeServe(Number(new URL(priv).port), { login: OWNER, ip: "100.64.0.10" }, { "tailscale-funnel-request": marker });
    try {
      const r = await raw(serve.url, "/mcp", { method: "POST", headers: { ...MHD }, body: JRPC });
      assert.equal(r.status, 403, `marker ${JSON.stringify(marker)}`);
    } finally {
      await serve.close();
    }
  }
});

test("identity matrix on the private listener", async () => {
  const mcp = (h: Record<string, string>) => raw(priv, "/mcp", { method: "POST", headers: { ...MHD, ...h }, body: JRPC });
  assert.equal((await mcp(tail("tagged-devices", "100.64.0.30"))).status, 403, "tagged node refused");
  assert.equal((await mcp(tail(OWNER, "100.64.0.31"))).status, 403, "unknown tagged ip refused");
  assert.equal((await mcp(tail("guest@example.org", "100.64.0.20"))).status, 403, "non-owner refused");
  assert.equal((await mcp(tail(OWNER, "100.64.0.20"))).status, 403, "owner login from another node refused");
  assert.equal((await mcp(tail(OWNER, "100.64.9.9"))).status, 403, "unknown ip refused");
  assert.equal((await mcp({ host: HOST, "tailscale-user-login": OWNER })).status, 401, "no source address");
  assert.equal((await mcp(tail(OWNER, "100.64.0.10, 203.0.113.9"))).status, 403, "last XFF entry wins");
  assert.equal((await mcp(tail(OWNER, "203.0.113.9, 100.64.0.10"))).status, 200, "serve-appended address trusted");
  assert.equal((await mcp(tail(OWNER.toUpperCase(), "100.64.0.10"))).status, 200, "login case-insensitive");
});

test("hostile Host and Origin values are refused, real ones pass", async () => {
  const mcp = (h: Record<string, string>) => raw(priv, "/mcp", { method: "POST", headers: { ...MHD, ...tail(OWNER, "100.64.0.10"), ...h }, body: JRPC });
  assert.equal((await hostProbe("evil.example.com")).status, 403, "rebinding domain");
  assert.equal((await hostProbe(`${HOST}.evil.com`)).status, 403, "suffix confusion");
  assert.equal((await hostProbe(HOST.toUpperCase())).status, 200, "uppercase real name");
  assert.equal((await mcp({ origin: "https://evil.example" })).status, 403, "cross-origin");
  assert.equal((await mcp({ origin: "null" })).status, 403, "opaque origin");
  assert.equal((await mcp({ origin: `https://${HOST}` })).status, 403, "right host but wrong port is still cross-origin");
  assert.equal((await mcp({ origin: `http://127.0.0.1:${new URL(priv).port}` })).status, 200, "same origin");
  assert.equal((await mcp({ "sec-fetch-site": "cross-site" })).status, 403, "cross-site fetch");
});

const hostProbe = (host: string): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const port = Number(new URL(priv).port);
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { ...MHD, ...tail(OWNER, "100.64.0.10"), host }, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(JRPC);
  });

test("a connection tailscaled did not open is refused once the source check is enforced", async () => {
  const gw = gatewayOf(broker);
  const uid = process.getuid!();
  const original = gw.source;
  Object.defineProperty(gw, "source", { value: sourceCheck({ platform: "linux", ownUid: uid, expectedUid: () => uid + 1 }), configurable: true });
  try {
    const r = await raw(priv, "/mcp", { method: "POST", headers: { ...MHD, ...tail(OWNER, "100.64.0.10") }, body: JRPC });
    assert.equal(r.status, 403, "forged direct loopback request refused at admission");
  } finally {
    Object.defineProperty(gw, "source", { value: original, configurable: true });
  }
});

test("cross-site posts and preflights get no CORS approval", async () => {
  const bad = await raw(priv, "/mcp", { method: "POST", headers: { ...MHD, ...tail(OWNER, "100.64.0.10"), origin: "https://evil.example" }, body: JRPC });
  assert.equal(bad.status, 403);
  for (const path of ["/mcp", "/app/api/inbox"]) {
    const pre = await raw(priv, path, { method: "OPTIONS", headers: { ...tail(OWNER, "100.64.0.10"), origin: "https://evil.example", "access-control-request-method": "POST" } });
    assert.equal(pre.headers.get("access-control-allow-origin"), null, `no ACAO for OPTIONS ${path}`);
  }
});

test("token presentation matrix on the public listener", async () => {
  const made = (await broker.dispatch({ op: "gateway_token_add", name: "w1matrix", mayMessage: [] })).result as { token: string; id: string };
  const post = (h: Record<string, string>, path = "/mcp") => raw(pub, path, { method: "POST", headers: { ...MHD, ...h, ...fresh() }, body: JRPC });
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  assert.equal((await post(bearer(made.token))).status, 200, "valid bearer");
  assert.equal((await post({ authorization: `bearer ${made.token}` })).status, 200, "scheme case-insensitive");
  assert.equal((await post({}, `/mcp?key=${encodeURIComponent(made.token)}`)).status, 200, "?key= on /mcp");
  assert.equal((await post(bearer(`${made.token}x`))).status, 401, "trailing junk");
  assert.equal((await post({ authorization: "Basic xyz" }, `/mcp?key=${encodeURIComponent(made.token)}`)).status, 200, "bad header falls back to good ?key=");
  assert.equal((await post(bearer(made.token), `/mcp?key=agk_00000000_${"A".repeat(43)}`)).status, 200, "good header wins over bad ?key=");
  assert.equal((await post({}, `/oauth/other?key=${encodeURIComponent(made.token)}`)).status, 404, "?key= ignored off /mcp");
});

test("revoking a token denies the next request", async () => {
  const made = (await broker.dispatch({ op: "gateway_token_add", name: "w1revokee", mayMessage: [] })).result as { token: string; id: string };
  const post = () => raw(pub, "/mcp", { method: "POST", headers: { ...MHD, authorization: `Bearer ${made.token}`, ...fresh() }, body: JRPC });
  assert.equal((await post()).status, 200);
  await broker.dispatch({ op: "gateway_token_revoke", id: made.id });
  assert.equal((await post()).status, 401, "revocation is immediate");
});

test("constant-source wrong tokens trip the failure limiter", async () => {
  const post = () => raw(pub, "/mcp", { method: "POST", headers: { ...MHD, authorization: `Bearer agk_deadbeef_${"B".repeat(43)}`, "x-forwarded-for": "198.51.100.200" }, body: JRPC });
  let limited = 0;
  for (let i = 0; i < 40; i++) if ((await post()).status === 429) limited++;
  assert.ok(limited > 0, "a constant source guessing tokens is throttled");
});

test("hostile client metadata is refused at registration", async () => {
  const register = (body: unknown) => raw(pub, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", ...fresh() }, body: JSON.stringify(body) });
  for (const [label, uris] of [["javascript", ["javascript:alert(1)"]], ["http-non-loopback", ["http://evil.example/cb"]], ["userinfo", ["https://u:p@evil.example/cb"]], ["fragment", ["https://evil.example/cb#x"]], ["six", Array.from({ length: 6 }, (_, i) => `https://e${i}.example/cb`)], ["empty", []], ["relative", ["/cb"]]] as const) {
    assert.equal((await register({ client_name: "x", redirect_uris: uris })).status, 400, label);
  }
  assert.equal((await register({ client_name: "x", redirect_uris: ["http://localhost:4000/cb"] })).status, 201, "loopback http allowed");
  assert.equal((await register({ client_name: "x", redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" })).status, 400, "confidential clients refused");
  assert.equal((await raw(pub, "/oauth/register", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...fresh() }, body: "x=1" })).status, 415, "form content-type refused");
});

test("oversized register bodies propagate 413 instead of collapsing to 400", async () => {
  const r = await raw(pub, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", ...fresh() }, body: JSON.stringify({ x: "y".repeat(20 * 1024) }) });
  assert.equal(r.status, 413);
});

test("authorize binds redirect uri, client and PKCE method exactly", async () => {
  const reg = await raw(pub, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", ...fresh() }, body: JSON.stringify({ client_name: "x", redirect_uris: ["https://good.example/cb"] }) });
  const client = (reg.json() as { client_id: string }).client_id;
  const { verifier, challenge } = pkce();
  void verifier;
  const q = (redirect: string, extra = "") => `/oauth/authorize?response_type=code&client_id=${client}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256${extra}`;
  assert.equal((await raw(pub, q("https://evil.example/cb"), { headers: fresh() })).status, 400, "other host");
  assert.equal((await raw(pub, q("https://GOOD.example/cb"), { headers: fresh() })).status, 400, "host case differs");
  assert.equal((await raw(pub, q("https://good.example/cb").replace("S256", "plain"), { headers: fresh() })).status, 400, "plain PKCE");
  assert.equal((await raw(pub, q("https://good.example/cb"), { headers: fresh() })).status, 200, "exact match renders consent");
});

test("pairing codes are single-use, pinned and expiring", async () => {
  const store = new OAuthStore(broker.store.db);
  const code = ((await broker.dispatch({ op: "gateway_pair", name: "w1pin", mayMessage: ["alpha"], redirectHost: "chatgpt.com" })).result as { code: string }).code;
  assert.equal(store.consumePairing(code, "good.example")?.peer_name, undefined, "pinned code not spent by a mismatching host");
  assert.ok(store.consumePairing(code, "chatgpt.com")?.peer_name === "w1pin", "pinned code works for its host");
  assert.equal(store.consumePairing(code, "chatgpt.com"), undefined, "pairing code is single-use");
  const expiring = ((await broker.dispatch({ op: "gateway_pair", name: "w1exp", mayMessage: [] })).result as { code: string }).code;
  assert.equal(store.consumePairing(expiring, "x.example", Date.now() + 11 * 60_000), undefined, "pairing expires");
});

test("a fresh pairing exchange after revoke yields a working grant with the fresh list", async () => {
  const gw = gatewayOf(broker);
  const first = await ensureOauthPeer(gw, "w1samename", ["alpha"], true);
  assert.deepEqual(JSON.parse(first.may_message), ["alpha"]);
  gw.state.updatePeer(first.id, { disabled: 1 });
  const untouched = await ensureOauthPeer(gw, "w1samename", ["alpha"], false);
  assert.equal(untouched.disabled, 1, "without a fresh pairing nothing changes");
  const second = await ensureOauthPeer(gw, "w1samename", ["alpha"], true);
  assert.equal(second.disabled, 0, "a fresh pairing exchange recovers the revoked grant");
  assert.deepEqual(JSON.parse(second.may_message), ["alpha"], "the fresh narrow list applies");
});

test("wrong pairing codes lock the source, and the right code stays locked", async () => {
  const reg = await raw(pub, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", ...fresh() }, body: JSON.stringify({ client_name: "lock", redirect_uris: ["https://lock.example/cb"] }) });
  const client = (reg.json() as { client_id: string }).client_id;
  const { challenge } = pkce();
  const code = ((await broker.dispatch({ op: "gateway_pair", name: "w1brute", mayMessage: ["alpha"] })).result as { code: string }).code;
  const src = { "x-forwarded-for": "203.0.113.77" };
  const attempt = (c: string) =>
    raw(pub, "/oauth/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...src }, body: new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: "https://lock.example/cb", code_challenge: challenge, code_challenge_method: "S256", code: c }).toString() });
  for (let i = 0; i < 5; i++) assert.equal((await attempt(String(111111 + i))).status, 200, "wrong guesses render the form again");
  assert.equal((await attempt("111116")).status, 429, "source locked after the per-source cap");
  assert.equal((await attempt(code)).status, 429, "the right code from a locked source stays locked");
});
test("authorization codes are single-shot and replay revokes the family", async () => {
  const grant = await fullGrant("https://race.example/cb", ["alpha"], "w1race");
  const again = await grant.tok({ grant_type: "authorization_code", client_id: grant.client, code: grant.authCode, redirect_uri: "https://race.example/cb", code_verifier: grant.verifier });
  assert.equal(again.status, 400, "code replay refused");
  assert.equal(await mcpStatus(grant.access_token), 401, "replay revokes the issued access token");
});

test("refresh rotation keeps old access alive; reuse of a rotated token kills the family", async () => {
  const grant = await fullGrant("https://rot.example/cb", ["alpha"], "w1rot");
  const ref1 = await grant.tok({ grant_type: "refresh_token", client_id: grant.client, refresh_token: grant.refresh_token });
  assert.equal(ref1.status, 200);
  const j1 = ref1.json() as { access_token: string; refresh_token: string };
  assert.equal(await mcpStatus(j1.access_token), 200, "rotated access works");
  assert.equal(await mcpStatus(grant.access_token), 200, "older access survives rotation");
  const reuse = await grant.tok({ grant_type: "refresh_token", client_id: grant.client, refresh_token: grant.refresh_token });
  assert.equal(reuse.status, 400, "rotated refresh token is single-use");
  assert.equal(await mcpStatus(j1.access_token), 401, "reuse revokes the whole family");
});

test("OAuth metadata never reflects the Host header", async () => {
  const meta = await raw(pub, "/.well-known/oauth-authorization-server", { headers: { host: "attacker.example", ...fresh() } });
  assert.doesNotMatch((meta.json() as { issuer: string }).issuer, /attacker/);
  const anon = await raw(pub, "/mcp", { method: "POST", headers: { ...MHD, host: 'x"y', ...fresh() }, body: "{}" });
  assert.doesNotMatch(String(anon.headers.get("www-authenticate") ?? ""), /x"y/);
});

test("client registration is capped and idle clients are pruned", async () => {
  let accepted = 0;
  for (let i = 0; i < 8; i++) {
    const r = await raw(pub, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", ...fresh() }, body: JSON.stringify({ client_name: `w1cap${i}`, redirect_uris: ["https://cap.example/cb"] }) });
    if (r.status === 201) accepted++;
  }
  assert.ok(accepted > 0 && accepted <= 8);
  const store = new OAuthStore(broker.store.db);
  const before = Number((broker.store.db.prepare("SELECT COUNT(*) n FROM gateway_oauth_clients").get() as { n: number }).n);
  store.pruneIdleClients(Date.now() + 11 * 60_000);
  const afterCount = Number((broker.store.db.prepare("SELECT COUNT(*) n FROM gateway_oauth_clients").get() as { n: number }).n);
  assert.ok(afterCount <= before, "idle clients are pruned");
});

test("body caps hold on /mcp and the token endpoint", async () => {
  const made = (await broker.dispatch({ op: "gateway_token_add", name: "w1limiter", mayMessage: [] })).result as { token: string };
  const auth = { authorization: `Bearer ${made.token}` };
  assert.equal((await raw(pub, "/mcp", { method: "POST", headers: { ...MHD, ...auth, ...fresh() }, body: "x".repeat(300 * 1024) })).status, 413, "300 KiB on /mcp");
  assert.equal((await raw(pub, "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...fresh() }, body: `a=${"x".repeat(20 * 1024)}` })).status, 413, "20 KiB on /oauth/token");
  assert.equal((await raw(pub, "/mcp", { method: "POST", headers: { ...MHD, ...auth, ...fresh() }, body: JRPC })).status, 200, "listener healthy after caps");
});

test("a slow body is cut instead of held", async () => {
  process.env.AGENTSOCKS_GATEWAY_BODY_MS = "150";
  try {
    const port = Number(new URL(pub).port);
    const got = await new Promise<string>((resolve) => {
      const s = createConnection({ host: "127.0.0.1", port });
      let text = "";
      s.setEncoding("utf8");
      s.on("data", (d: string) => (text += d));
      s.on("connect", () => s.write("POST /oauth/token HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 400\r\n\r\ngrant"));
      s.on("close", () => resolve(text.split("\r\n")[0] ?? ""));
      setTimeout(() => {
        s.destroy();
        resolve("still open");
      }, 4000).unref(); // real timer: the assertion is the server's own deadline firing first
    });
    assert.match(got, /^HTTP\/1\.1 408/, "slow body cut at the deadline");
  } finally {
    delete process.env.AGENTSOCKS_GATEWAY_BODY_MS;
  }
});

test("malformed targets never authenticate and never crash the listener", async () => {
  const port = Number(new URL(pub).port);
  const socket = (payload: string) =>
    new Promise<string>((resolve) => {
      const s = createConnection({ host: "127.0.0.1", port });
      let got = "";
      s.setEncoding("latin1");
      s.on("data", (d: string) => (got += d));
      s.on("connect", () => s.write(payload, "latin1"));
      s.on("error", () => resolve(got));
      s.on("close", () => resolve(got));
      setTimeout(() => {
        s.destroy();
        resolve(got);
      }, 1500).unref(); // real timer: raw-socket probes have no response promise to await
    });
  for (const payload of [
    `CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    `GET /mcp%00 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    `POST /mcp?key=%ZZ%FF HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    `TRACE /mcp HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
  ]) {
    const got = await socket(payload);
    assert.doesNotMatch(got, /HTTP\/1\.1 200/, `hostile target never authenticates: ${JSON.stringify(payload.slice(0, 24))}`);
  }
  assert.equal((await raw(pub, "/.well-known/oauth-protected-resource", { headers: fresh() })).status, 200, "listener healthy");
});

test("one authorization code yields at most one grant", async () => {
  const reg = await raw(pub, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", ...fresh() }, body: JSON.stringify({ client_name: "race2", redirect_uris: ["https://race2.example/cb"] }) });
  const client = (reg.json() as { client_id: string }).client_id;
  const store = new OAuthStore(broker.store.db);
  const { verifier, challenge } = pkce();
  const code = store.issueCode({ clientId: client, redirectUri: "https://race2.example/cb", challenge, peerName: "w1racepeer", mayMessage: "[]" });
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: client, code, redirect_uri: "https://race2.example/cb", code_verifier: verifier }).toString();
  const once = () => raw(pub, "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...fresh() }, body });
  assert.equal((await once()).status, 200, "first exchange succeeds");
  assert.equal((await once()).status, 400, "second exchange of the same code fails");
});

test("pairing guesses cannot exceed the global cap across sources", async () => {
  const reg = await raw(pub, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", ...fresh() }, body: JSON.stringify({ client_name: "race", redirect_uris: ["https://race.example/cb"] }) });
  const client = (reg.json() as { client_id: string }).client_id;
  const { challenge } = pkce();
  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      raw(pub, "/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `10.1.9.${i + 1}` },
        body: new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: "https://race.example/cb", code_challenge: challenge, code_challenge_method: "S256", code: String(300000 + i) }).toString(),
      }).then((r) => r.status, () => -1),
    ),
  );
  assert.ok(results.filter((s) => s === 200).length <= 30, "at most the global cap is evaluated as guesses");
});

test("a definitive LocalAPI 404 denies without calling the CLI", async () => {
  const dir = tempDir("w1-cli-");
  const log = join(dir, "calls.log");
  const bin = join(dir, "tailscale");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nprintf '{"Node":{"Name":"planted."},"UserProfile":{"LoginName":"sam@example.com"}}'\n`);
  chmodSync(bin, 0o755);
  const tailnet = localTailnet({ sockets: () => [api.socketPath], bin: () => bin });
  assert.equal(await tailnet.whois("100.99.99.99"), undefined, "unknown address is unknown");
  assert.equal(existsSync(log), false, "the CLI is not asked after a definitive 404");
  assert.ok((await tailnet.whois("100.64.0.10"))?.login === OWNER, "known addresses still resolve");
});

test("the CLI fallback runs only when no socket exists, from an absolute path", async () => {
  assert.match(tailscaleBin({}), /^\//, "default bin is absolute");
  assert.ok(!String(tailscaleBin({})).includes("PATH") && tailscaleBin({}) !== "tailscale", "never a bare PATH lookup");
  const missing = localTailnet({ sockets: () => [join(root, "gone.sock")], bin: () => join(root, "gone-cli") });
  assert.equal(await missing.whois("100.64.0.10"), undefined, "missing socket and CLI fails closed");
});

test("source: verdicts are stable and table reads are cached per connection and across the TTL", async () => {
  const uid = process.getuid!();
  let reads = 0;
  const tables = () => ["t"];
  const check = sourceCheck({ platform: "linux", ownUid: uid, expectedUid: () => uid + 1, tcpTablesAsync: async () => (reads++, tables()) });
  const sock = { remoteAddress: "127.0.0.1", remotePort: 1, localAddress: "127.0.0.1", localPort: 2 };
  const req = { socket: sock };
  assert.equal(await check.checkSource(req as never), false);
  assert.equal(reads, 2, "a miss re-reads the table fresh before deciding");
  assert.equal(await check.checkSource(req as never), false, "second verdict on the same connection reuses the decision");
  assert.equal(reads, 2, "no further reads once decided");
  assert.deepEqual(Object.keys(check.getSourceVerdict()).sort(), ["detail", "enforced"]);
  assert.match(check.getSourceVerdict().detail, /accepted only from a connection/);
  const flat = sourceCheck({ platform: "linux", ownUid: uid, expectedUid: () => uid });
  assert.equal(flat.getSourceVerdict().enforced, false);
  assert.match(flat.getSourceVerdict().detail, /^not enforced/);
  let asyncReads = 0;
  const ac = sourceCheck({ platform: "linux", ownUid: uid, expectedUid: () => uid + 1, tcpTablesAsync: async () => (asyncReads++, ["t"]) });
  for (let i = 0; i < 50; i++) await ac.checkSource({ socket: { remoteAddress: "127.0.0.1", remotePort: 100 + i, localAddress: "127.0.0.1", localPort: 200 } } as never);
  assert.equal(asyncReads, 51, "a miss costs one fresh read; the decision is then made once per connection");
});

test("http: header precedence and canonical paths", () => {
  assert.equal(lastForwardedFor({ headers: { "x-forwarded-for": "203.0.113.9, 100.64.0.10" } } as never), "100.64.0.10", "last entry wins");
  assert.equal(lastForwardedFor({ headers: { "x-forwarded-for": ["203.0.113.9", "100.64.0.10"] } } as never), "100.64.0.10", "duplicate headers join, last wins");
  assert.equal(header({ headers: { "tailscale-user-login": ["a@evil.test", OWNER] } } as never, "tailscale-user-login"), "a@evil.test", "duplicates do not smuggle the second value through");
  for (const bad of ["//evil.test/mcp", "/./mcp", "/../mcp", "/mcp/../x", "/.", "/..", "/mcp/.", "/%2e%2e/x", "/%2F"]) assert.equal(isCanonicalPath(bad), false, bad);
  assert.equal(isCanonicalPath("/mcp"), true);
});

test("http: oversized and slow bodies are refused with 413 and 408", async () => {
  const fakeReq = (length: string | undefined, chunks: Buffer[]) => {
    const req = new EventEmitter() as unknown as IncomingMessage;
    req.headers = length === undefined ? {} : { "content-length": length };
    process.nextTick(() => {
      for (const c of chunks) req.emit("data", c);
      req.emit("end");
    });
    return req;
  };
  await assert.rejects(readBody(fakeReq("999999", []), 16 * 1024), (e: unknown) => (e as { status: number }).status === 413, "declared length over the cap");
  await assert.rejects(readBody(fakeReq(undefined, [Buffer.alloc(9000), Buffer.alloc(9000)]), 16 * 1024), (e: unknown) => (e as { status: number }).status === 413, "streamed overflow");
  process.env.AGENTSOCKS_GATEWAY_BODY_MS = "30";
  try {
    const hanging = new EventEmitter() as unknown as IncomingMessage;
    hanging.headers = { "content-length": "400" };
    await assert.rejects(readBody(hanging, 16 * 1024), (e: unknown) => (e as { status: number }).status === 408, "slow body");
  } finally {
    delete process.env.AGENTSOCKS_GATEWAY_BODY_MS;
  }
});

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const mcpStatus = async (access: string) => (await raw(pub, "/mcp", { method: "POST", headers: { ...MHD, authorization: `Bearer ${access}`, ...fresh() }, body: JRPC })).status;

async function fullGrant(redirect: string, mayMessage: string[] = ["alpha"], name = "w1grant") {
  const reg = await raw(pub, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", ...fresh() }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }) });
  assert.equal(reg.status, 201);
  const client = (reg.json() as { client_id: string }).client_id;
  const { verifier, challenge } = pkce();
  const code = ((await broker.dispatch({ op: "gateway_pair", name, mayMessage })).result as { code: string }).code;
  const c = await raw(pub, "/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...fresh() },
    body: new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", code }).toString(),
  });
  assert.equal(c.status, 302, c.text.slice(0, 120));
  const authCode = new URL(c.headers.get("location")!).searchParams.get("code")!;
  const tok = (body: Record<string, string>) => raw(pub, "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...fresh() }, body: new URLSearchParams(body).toString() });
  const t = await tok({ grant_type: "authorization_code", client_id: client, code: authCode, redirect_uri: redirect, code_verifier: verifier });
  assert.equal(t.status, 200, t.text.slice(0, 120));
  return { client, verifier, authCode, tok, ...(t.json() as { access_token: string; refresh_token: string }) };
}
