import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { gateway as gatewayCommand } from "../src/commands/gateway.ts";
import { OAuthStore } from "../src/gateway/oauth.ts";
import { gatewayOf, tailnetPeer } from "../src/gateway/runtime.ts";
import { disableGatewayState } from "../src/gateway/state.ts";
import { fakeLocalApi, raw, type FakeLocalApi } from "./gatewaysupport.ts";
import { tempDir } from "./tmp.ts";

const broker = new Broker();
let api: FakeLocalApi;
let pub = "";
const MHD = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const JRPC = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });

let xff = 100;
const fresh = () => ({ "x-forwarded-for": `192.0.2.${(xff++ % 150) + 1}` });
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const mcpStatus = async (access: string) => (await raw(pub, "/mcp", { method: "POST", headers: { ...MHD, authorization: `Bearer ${access}`, ...fresh() }, body: JRPC })).status;
const call = async <T>(op: string, args: Record<string, unknown> = {}): Promise<T> => (await broker.dispatch({ op, ...args })).result as T;

function clientIdOf(body: unknown): string {
  if (!body || typeof body !== "object" || !("client_id" in body) || typeof body.client_id !== "string") throw new Error("register did not return a client_id");
  return body.client_id;
}

async function fullGrant(redirect: string, mayMessage: string[] = ["alpha"], name = "w1egrant") {
  const reg = await raw(pub, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", ...fresh() }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }) });
  assert.equal(reg.status, 201);
  const client = clientIdOf(reg.json());
  const { verifier, challenge } = pkce();
  const code = (await call<{ code: string }>("gateway_pair", { name, mayMessage })).code;
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
  const issued: unknown = t.json();
  if (!issued || typeof issued !== "object" || !("access_token" in issued) || typeof issued.access_token !== "string" || !("refresh_token" in issued) || typeof issued.refresh_token !== "string") {
    throw new Error("token endpoint did not return tokens");
  }
  return { client, tok, access_token: issued.access_token, refresh_token: issued.refresh_token };
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    return { value: await fn(), out: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

before(async () => {
  api = await fakeLocalApi();
  await broker.start();
  const on = (await call<{ private: { port: number } }>("gateway_on", { port: 0 })).private.port;
  const pubOn = (await call<{ public: { port: number } }>("gateway_public", { via: "funnel", port: 0 })).public.port;
  pub = `http://127.0.0.1:${pubOn}`;
  void on;
});

after(async () => {
  delete process.env.AGENTSOCKS_TAILSCALE_BIN;
  await broker.stop();
  await api.close();
});

test("set_name refuses local names carrying gateway markers", async () => {
  await broker.dispatch({ op: "register", threadId: "w1eimit", cwd: "/work/w1e" });
  for (const name of ["chatgpt (remote)", "ChatGPT (REMOTE)", "hetzner-lab (remote)", "bob@hetzner-lab", "sam (phone)", "Sam (Phone)", "grok (api) (remote)"]) {
    await assert.rejects(broker.dispatch({ op: "set_name", threadId: "w1eimit", name }), /marker|imitate|@/i, `${name} must be refused`);
  }
  await broker.dispatch({ op: "set_name", threadId: "w1eimit", name: "field notes" });
  assert.equal(broker.store.getThread("w1eimit")!.name, "field notes");
  await broker.dispatch({ op: "set_name", threadId: "w1eimit", name: "call mom (later)" });
  assert.equal(broker.store.getThread("w1eimit")!.name, "call mom (later)");
});

test("re-enabling a peer disabled by an older build revokes every family", async () => {
  const first = await fullGrant("https://w1eold.example/cb", ["alpha"], "w1eoldpeer");
  assert.equal(await mcpStatus(first.access_token), 200);
  gatewayOf(broker).state.updatePeer("oauth:w1eoldpeer", { disabled: 1 });
  const second = await fullGrant("https://w1enew.example/cb", ["alpha"], "w1eoldpeer");
  assert.equal(await mcpStatus(second.access_token), 200, "a fresh pairing after re-enable works");
  assert.equal(await mcpStatus(first.access_token), 401, "the re-enable revokes the old-version grant instead of reviving it");
  const stale = await first.tok({ grant_type: "refresh_token", client_id: first.client, refresh_token: first.refresh_token });
  assert.equal(stale.status, 400, "the old refresh token stays dead after the re-enable");
});

test("disable drops outstanding pairing and authorization codes", async () => {
  const gw = gatewayOf(broker);
  await fullGrant("https://w1epre.example/cb", ["alpha"], "w1ecodepeer");
  const redirect = "https://w1ecode.example/cb";
  const reg = await raw(pub, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", ...fresh() }, body: JSON.stringify({ client_name: "w1ecode", redirect_uris: [redirect] }) });
  assert.equal(reg.status, 201);
  const client = clientIdOf(reg.json());
  const { verifier, challenge } = pkce();
  const pairing = (await call<{ code: string }>("gateway_pair", { name: "w1ecodepeer", mayMessage: ["alpha"] })).code;
  const c = await raw(pub, "/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...fresh() },
    body: new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", code: pairing }).toString(),
  });
  assert.equal(c.status, 302);
  const authCode = new URL(c.headers.get("location")!).searchParams.get("code")!;
  const pairing2 = (await call<{ code: string }>("gateway_pair", { name: "w1ecodepeer", mayMessage: ["alpha"] })).code;
  disableGatewayState(gw.state);
  const t = await raw(pub, "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...fresh() }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client, code: authCode, redirect_uri: redirect, code_verifier: verifier }).toString() });
  assert.equal(t.status, 400, "a pre-disable authorization code cannot be exchanged after the disable");
  assert.equal(gw.state.getPeer("oauth:w1ecodepeer")?.disabled, 1, "the failed exchange does not re-enable the peer");
  const { verifier: v2, challenge: ch2 } = pkce();
  const c2 = await raw(pub, "/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...fresh() },
    body: new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: redirect, code_challenge: ch2, code_challenge_method: "S256", code: pairing2 }).toString(),
  });
  assert.notEqual(c2.status, 302, "a pre-disable pairing code cannot be redeemed after the disable");
});

test("revoking the last live family still disables the peer", async () => {
  const gw = gatewayOf(broker);
  const a = await fullGrant("https://w1efama.example/cb", ["alpha"], "w1efampeer");
  const b = await fullGrant("https://w1efamb.example/cb", ["alpha"], "w1efampeer");
  const fams = () => new OAuthStore(broker.store.db).families().filter((f) => f.peer_id === "oauth:w1efampeer");
  const famA = fams().find((f) => f.client_id === a.client)!.family;
  await call("gateway_token_revoke", { id: famA });
  assert.equal(gw.state.getPeer("oauth:w1efampeer")!.disabled, 0, "the peer stays live while a family survives");
  assert.equal(await mcpStatus(a.access_token), 401, "the revoked family is dead");
  assert.equal(await mcpStatus(b.access_token), 200, "the surviving family still works");
  const famB = fams().find((f) => f.client_id === b.client)!.family;
  await call("gateway_token_revoke", { id: famB });
  assert.equal(gw.state.getPeer("oauth:w1efampeer")!.disabled, 1, "revoking the last live family disables the peer");
  assert.equal(await mcpStatus(b.access_token), 401, "the last family is dead too");
  const d = await fullGrant("https://w1efamd.example/cb", ["beta"], "w1efampeer");
  assert.equal(await mcpStatus(d.access_token), 200, "a fresh pairing after a full revoke works");
  assert.deepEqual(JSON.parse(gw.state.getPeer("oauth:w1efampeer")!.may_message), ["beta"], "the fresh pairing applies its list to the switched-off peer");
});

test("gateway pair over a live peer prints the list that applies", async () => {
  await fullGrant("https://w1elive.example/cb", ["alpha"], "w1elive");
  const { value, out } = await quiet(() => gatewayCommand(["pair", "chatgpt", "--name", "w1elive", "--may-message", "*"], "agentsocks gateway"));
  assert.equal(value, 0);
  const line = out.split("\n").find((l) => l.startsWith("That connection may message:"));
  assert.ok(line, `the pair output states the list; got:\n${out}`);
  assert.match(line, /alpha/, "the live list is what prints");
  assert.doesNotMatch(line, /\*/, "the requested narrowing is not what prints");
});

test("gateway public off runs funnel off before clearing exposed", async () => {
  const gw = gatewayOf(broker);
  const dir = tempDir("w1e-puboff-");
  const log = join(dir, "calls.log");
  const shim = join(dir, "tailscale");
  writeFileSync(shim, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(shim, 0o755);
  process.env.AGENTSOCKS_TAILSCALE_BIN = shim;
  try {
    gw.savePublic({ ...gw.publicSettings(), exposed: true });
    const port = gw.publicSettings().port;
    await call("gateway_public_off");
    assert.match(readFileSync(log, "utf8"), new RegExp(`funnel.*${port}.*off`), "the funnel-off command runs on public off");
    assert.equal(gw.publicSettings().exposed, false, "exposed clears once funnel off succeeds");
    assert.equal(gw.publicSettings().enabled, false, "the listener is still wanted off");
  } finally {
    delete process.env.AGENTSOCKS_TAILSCALE_BIN;
  }
  const dir2 = tempDir("w1e-puboff-fail-");
  const log2 = join(dir2, "calls.log");
  const shim2 = join(dir2, "tailscale");
  writeFileSync(shim2, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log2)}\nexit 1\n`);
  chmodSync(shim2, 0o755);
  process.env.AGENTSOCKS_TAILSCALE_BIN = shim2;
  try {
    gw.savePublic({ ...gw.publicSettings(), enabled: true, exposed: true });
    await call("gateway_public_off");
    assert.match(readFileSync(log2, "utf8"), /funnel/, "the funnel-off command is attempted before the flag is touched");
    assert.equal(gw.publicSettings().exposed, true, "exposed survives a failed funnel-off");
    assert.equal(gw.publicSettings().enabled, false, "the listener is still wanted off");
  } finally {
    delete process.env.AGENTSOCKS_TAILSCALE_BIN;
  }
});

test("broker-up uninstall keeps served/exposed when the off commands fail", async () => {
  const gw = gatewayOf(broker);
  const dir = tempDir("w1e-uninst-");
  const shim = join(dir, "tailscale");
  writeFileSync(shim, "#!/bin/sh\nexit 1\n");
  chmodSync(shim, 0o755);
  process.env.AGENTSOCKS_TAILSCALE_BIN = shim;
  try {
    gw.savePrivate({ ...gw.privateSettings(), enabled: true, served: true });
    gw.savePublic({ ...gw.publicSettings(), enabled: true, exposed: true });
    const res = (await call<{ stopped: { serveUndone: boolean; funnelUndone: boolean }; disabled: number }>("gateway_uninstall")).stopped;
    assert.equal(res.serveUndone, false, "the failed serve-off is reported");
    assert.equal(res.funnelUndone, false, "the failed funnel-off is reported");
    assert.equal(gw.privateSettings().served, true, "served survives a failed off command through uninstall");
    assert.equal(gw.publicSettings().exposed, true, "exposed survives a failed off command through uninstall");
  } finally {
    delete process.env.AGENTSOCKS_TAILSCALE_BIN;
  }
});

test("SPEC decision 39: a tailnet guest login starts with an empty allowlist, the owner keeps *", () => {
  const owner = "sam@example.com";
  const me = { login: owner, node: "laptop", nodeId: "n-9", os: "Linux", ip: "100.64.0.9" };
  assert.deepEqual(tailnetPeer(me, "agent", owner).mayMessage, ["*"]);
  assert.deepEqual(tailnetPeer({ ...me, login: "friend@example.com", ip: "100.64.0.3" }, "agent", owner).mayMessage, [], "guests message nobody until allowed");
});
