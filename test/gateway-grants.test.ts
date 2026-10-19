import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { disableGatewayState } from "../src/gateway/state.ts";
import { OAuthStore } from "../src/gateway/oauth.ts";
import { gatewayOf, type Gateway } from "../src/gateway/runtime.ts";
import { sourceCheck } from "../src/gateway/source.ts";
import { fakeLocalApi, raw, type FakeLocalApi } from "./gatewaysupport.ts";
import { tempDir } from "./tmp.ts";

interface GatewayTestHooks {
  requestedConns: Map<string, number>;
  sourceConns: Map<string, Set<unknown>>;
  releaseExposure(surface: string): Promise<void>;
}
const hooks = (gw: Gateway): GatewayTestHooks => gw as unknown as GatewayTestHooks;

const broker = new Broker();
let api: FakeLocalApi;
let priv = "";
let pub = "";
const OWNER = "sam@example.com";
const JRPC = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
const MHD = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const close = { connection: "close" };

let xff = 100;
const fresh = () => ({ "x-forwarded-for": `192.0.2.${(xff++ % 150) + 1}` });
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const mcpStatus = async (access: string) => (await raw(pub, "/mcp", { method: "POST", headers: { ...MHD, authorization: `Bearer ${access}`, ...fresh() }, body: JRPC })).status;

async function fullGrant(redirect: string, mayMessage: string[] = ["alpha"], name = "w1dgrant") {
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
  return { client, tok, ...(t.json() as { access_token: string; refresh_token: string }) };
}

before(async () => {
  api = await fakeLocalApi();
  api.machines.set("100.64.0.10", { name: "phone", login: OWNER, ip: "100.64.0.10", os: "iOS" });
  process.env.TS_SOCKET = api.socketPath;
  await broker.start();
  const on = (await broker.dispatch({ op: "gateway_on", port: 0 })).result as { private: { port: number } };
  priv = `http://127.0.0.1:${on.private.port}`;
  const pubOn = (await broker.dispatch({ op: "gateway_public", via: "funnel", port: 0 })).result as { public: { port: number } };
  pub = `http://127.0.0.1:${pubOn.public.port}`;
});

after(async () => {
  delete process.env.AGENTSOCKS_TAILSCALE_BIN;
  await broker.stop();
  await api.close();
});

test("uninstall-style disable revokes every family; a re-pair never revives the old grant, and the fresh grant works", async () => {
  const gw = gatewayOf(broker);
  const first = await fullGrant("https://w1dold.example/cb", ["alpha"], "w1drevive");
  assert.equal(await mcpStatus(first.access_token), 200, "old grant works before disable");
  assert.equal(disableGatewayState(gw.state), 1, "disabling the one peer reports one");
  assert.equal(await mcpStatus(first.access_token), 401, "disabling revokes the old access token");
  const stale = await first.tok({ grant_type: "refresh_token", client_id: first.client, refresh_token: first.refresh_token });
  assert.equal(stale.status, 400, "disabling revokes the old refresh token");
  const second = await fullGrant("https://w1dnew.example/cb", ["alpha"], "w1drevive");
  assert.equal(await mcpStatus(second.access_token), 200, "a fresh pairing after disable yields a working grant");
  assert.equal(await mcpStatus(first.access_token), 401, "the re-pair does not revive the old access token");
});

test("refresh with a live token is refused while its peer is disabled", async () => {
  const gw = gatewayOf(broker);
  const grant = await fullGrant("https://w1dheld.example/cb", ["alpha"], "w1dheld");
  gw.state.updatePeer("oauth:w1dheld", { disabled: 1 });
  try {
    const ref = await grant.tok({ grant_type: "refresh_token", client_id: grant.client, refresh_token: grant.refresh_token });
    assert.equal(ref.status, 400, "a disabled peer cannot mint tokens even with a live refresh token");
    assert.equal(await mcpStatus(grant.access_token), 403, "the disabled peer stays switched off");
  } finally {
    gw.state.updatePeer("oauth:w1dheld", { disabled: 0 });
  }
  const store = new OAuthStore(broker.store.db);
  const family = store.families().find((f) => f.peer_id === "oauth:w1dheld")!.family;
  await broker.dispatch({ op: "gateway_token_revoke", id: family });
  assert.equal(await mcpStatus(grant.access_token), 401, "revoking the grant denies the next request");
  const third = await fullGrant("https://w1dheld2.example/cb", ["alpha"], "w1dheld");
  assert.equal(await mcpStatus(third.access_token), 200, "a fresh pairing after revoke yields a working grant");
});

test("a later pairing never rewrites a live grant's list", async () => {
  const gw = gatewayOf(broker);
  const narrow = await fullGrant("https://w1dnarrow.example/cb", ["alpha"], "w1dlist");
  assert.deepEqual(JSON.parse(gw.state.getPeer("oauth:w1dlist")!.may_message), ["alpha"]);
  const wide = await fullGrant("https://w1dwide.example/cb", ["*"], "w1dlist");
  assert.deepEqual(JSON.parse(gw.state.getPeer("oauth:w1dlist")!.may_message), ["alpha"], "the live narrow list survives a later wide pairing");
  assert.equal(await mcpStatus(narrow.access_token), 200, "the first grant still works");
  assert.equal(await mcpStatus(wide.access_token), 200, "the second grant works");
});

test("the private source check runs before admission, so rejected sockets never enter the budget", async () => {
  const gw = gatewayOf(broker);
  const uid = process.getuid!();
  const original = gw.source;
  Object.defineProperty(gw, "source", { value: sourceCheck({ platform: "linux", ownUid: uid, expectedUid: () => uid + 1 }), configurable: true });
  try {
    const held: Socket[] = [];
    const port = Number(new URL(priv).port);
    for (let i = 0; i < 10; i++) {
      const status: number = await new Promise((resolve, reject) => {
        const s = createConnection({ host: "127.0.0.1", port });
        s.on("error", reject);
        let text = "";
        s.on("data", (d: Buffer) => {
          text += d.toString();
          if (text.includes("\r\n\r\n")) {
            held.push(s);
            resolve(Number(/HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0));
          }
        });
        s.on("connect", () => s.write(`GET /app/ HTTP/1.1\r\nHost: x\r\nTailscale-User-Login: ${OWNER}\r\nX-Forwarded-For: 100.64.9.${i + 1}\r\nConnection: keep-alive\r\n\r\n`));
      });
      assert.equal(status, 403, "a connection tailscaled did not open is refused");
    }
    const inner = hooks(gw);
    assert.equal(inner.requestedConns.get("private") ?? 0, 0, "rejected sockets never enter the connection budget");
    assert.ok([...inner.sourceConns.keys()].every((k) => !k.startsWith("private:")), "rejected sockets are not tracked per source");
    for (const s of held) s.destroy();
  } finally {
    Object.defineProperty(gw, "source", { value: original, configurable: true });
  }
});

test("a full budget sheds the oldest idle keep-alive instead of locking a new source out", async () => {
  const port = Number(new URL(pub).port);
  const hold = (xffAddr: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const s = createConnection({ host: "127.0.0.1", port });
      s.on("error", reject);
      let text = "";
      s.on("data", (d: Buffer) => {
        text += d.toString();
        const head = text.indexOf("\r\n\r\n");
        if (head !== -1) {
          const length = Number(/content-length:\s*(\d+)/i.exec(text)?.[1] ?? 0);
          if (text.length >= head + 4 + length) {
            s.removeAllListeners("data");
            s.on("data", () => {});
            resolve(s);
          }
        }
      });
      s.on("connect", () => s.write(`GET /.well-known/oauth-authorization-server HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: ${xffAddr}\r\nConnection: keep-alive\r\n\r\n`));
    });
  const held: Socket[] = [];
  const probeFresh = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const s = createConnection({ host: "127.0.0.1", port });
      s.on("error", reject);
      let text = "";
      s.on("data", (d: Buffer) => {
        text += d.toString();
        const head = text.indexOf("\r\n\r\n");
        if (head !== -1) {
          const length = Number(/content-length:\s*(\d+)/i.exec(text)?.[1] ?? 0);
          if (text.length >= head + 4 + length) {
            s.destroy();
            resolve(Number(/HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0));
          }
        }
      });
      s.on("connect", () => s.write("GET /.well-known/oauth-authorization-server HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 203.0.113.50\r\nConnection: close\r\n\r\n"));
    });
  try {
    for (const a of [1, 2, 3, 4]) for (let i = 0; i < 32; i++) held.push(await hold(`198.51.100.${a}`));
    assert.equal(await probeFresh(), 200, "a new source sheds an idle keep-alive instead of taking a 503");
  } finally {
    for (const s of held) s.destroy();
  }
});

test("gateway off keeps served/exposed when the off command fails, and reports it", async () => {
  const gw = gatewayOf(broker);
  const dir = tempDir("w1d-r8-");
  const shim = join(dir, "tailscale");
  writeFileSync(shim, "#!/bin/sh\nexit 1\n");
  chmodSync(shim, 0o755);
  process.env.AGENTSOCKS_TAILSCALE_BIN = shim;
  try {
    gw.savePrivate({ ...gw.privateSettings(), served: true });
    gw.savePublic({ ...gw.publicSettings(), exposed: true });
    const res = (await broker.dispatch({ op: "gateway_off" })) as { result: { stopped: { serveUndone: boolean; funnelUndone: boolean } } };
    assert.equal(res.result.stopped.serveUndone, false, "the failed serve-off is reported");
    assert.equal(res.result.stopped.funnelUndone, false, "the failed funnel-off is reported");
    assert.equal(gw.privateSettings().served, true, "served survives a failed off command");
    assert.equal(gw.publicSettings().exposed, true, "exposed survives a failed off command");
  } finally {
    delete process.env.AGENTSOCKS_TAILSCALE_BIN;
  }
});

test("releaseExposure keeps the flag when the off command fails", async () => {
  const gw = gatewayOf(broker);
  const inner = hooks(gw);
  const dir = tempDir("w1d-r8b-");
  const shim = join(dir, "tailscale");
  writeFileSync(shim, "#!/bin/sh\nexit 1\n");
  chmodSync(shim, 0o755);
  process.env.AGENTSOCKS_TAILSCALE_BIN = shim;
  try {
    gw.savePrivate({ ...gw.privateSettings(), served: true });
    await inner.releaseExposure("private");
    assert.equal(gw.privateSettings().served, true, "served survives a failed serve-off");
    gw.savePublic({ ...gw.publicSettings(), exposed: true });
    await inner.releaseExposure("public");
    assert.equal(gw.publicSettings().exposed, true, "exposed survives a failed funnel-off");
  } finally {
    delete process.env.AGENTSOCKS_TAILSCALE_BIN;
  }
});

test("the sync trust path is gone; checkSource is the one path", () => {
  assert.equal("trust" in sourceCheck(), false, "no sync trust remains");
  assert.equal(typeof sourceCheck().checkSource, "function", "the async source check remains");
});
