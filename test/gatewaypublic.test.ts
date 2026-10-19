import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { until, fakeClaude, livePid, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { messageContent, parseEnvelope } from "../src/envelope.ts";
import { codexIdentity } from "../src/peers.ts";
import { sendMessage } from "../src/send.ts";
import { mcpClient, raw } from "./gatewaysupport.ts";

const broker = new Broker();
let alpha: FakeClaude;
let beta: FakeClaude;
let base = "";

type Created = { id: string; token: string; name: string; mayMessage: string[] };
const tokenFor = async (name: string, mayMessage: string[]): Promise<Created> => (await broker.dispatch({ op: "gateway_token_add", name, mayMessage })).result as Created;
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const callAs = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: (r.content as { text: string }[]).map((c) => c.text).join("\n"), isError: r.isError === true };
};
const b64 = (buf: Buffer): string => buf.toString("base64url");

const GHOST = "0199cccc-0000-7000-8000-00000000000a";

before(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  const codexDb = new DatabaseSync(join(process.env.CODEX_HOME!, "state_5.sqlite"));
  codexDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, approval_mode TEXT, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER)");
  codexDb.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, archived, archived_at) VALUES (?, ?, ?, ?, ?, 0, NULL)").run(GHOST, "GHOST-ONE", "/work/ghost", "never", Date.now() - 3_600_000);
  codexDb.close();
  await broker.start();
  alpha = await fakeClaude("alpha", livePid(), "idle");
  beta = await fakeClaude("beta", livePid(), "idle");
  const r = (await broker.dispatch({ op: "gateway_public", via: "funnel", port: 0 })).result as { public: { listening: boolean; port: number } };
  assert.equal(r.public.listening, true);
  base = `http://127.0.0.1:${r.public.port}`;
});

after(async () => {
  await closeServer(alpha.server);
  await closeServer(beta.server);
  await broker.stop();
});

test("the public listener serves only the reduced tool set to a peer with a token, and lists only the peers that token may message", async () => {
  const grok = await tokenFor("grok", ["alpha"]);
  const client = await mcpClient(base, bearer(grok.token));
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["answer", "list_peers", "read_inbox", "send_message", "wait_for_message"]);
    const peers = await callAs(client, "list_peers");
    assert.match(peers.text, /alpha \[[0-9a-f]{6,}\] claude/);
    assert.doesNotMatch(peers.text, /beta/);
    assert.doesNotMatch(peers.text, /\/work\//, "no working directories leave the machine");
    const sent = await callAs(client, "send_message", { to: "alpha", message: "from grok via token" });
    assert.equal(sent.isError, false);
    const frame = await until(() => alpha.frames.find((f) => parseEnvelope(messageContent(f))?.body === "from grok via token"));
    assert.equal(parseEnvelope(messageContent(frame))!.fromName, "grok (remote)");
    const blocked = await callAs(client, "send_message", { to: "beta", message: "should not arrive" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /no running session named "beta"/);
    assert.equal(beta.frames.length, 0);
  } finally {
    await client.close();
  }
});

test("a public peer cannot reach a Codex thread that is not connected, even when its list says everyone", async () => {
  const everyone = await tokenFor("wide-open", ["*"]);
  const client = await mcpClient(base, bearer(everyone.token));
  try {
    const listed = await callAs(client, "list_peers");
    assert.doesNotMatch(listed.text, /GHOST-ONE/);
    const sent = await callAs(client, "send_message", { to: "GHOST-ONE", message: "wake up" });
    assert.equal(sent.isError, true);
    assert.match(sent.text, /no running session named "GHOST-ONE"/);
    assert.equal(broker.store.getThread(GHOST), undefined, "the thread was not registered on a remote peer's behalf");
  } finally {
    await client.close();
  }
});

test("an urgent message from a public peer is delivered as normal, and the sender is told", async () => {
  const peer = await tokenFor("urgent-try", ["alpha"]);
  const client = await mcpClient(base, bearer(peer.token));
  try {
    const sent = await callAs(client, "send_message", { to: "alpha", message: "this is urgent!!", urgency: "urgent" });
    assert.match(sent.text, /Urgent is not available on this connection, so it was sent as normal/);
    await until(() => alpha.frames.find((f) => parseEnvelope(messageContent(f))?.body === "this is urgent!!"));
    const row = broker.store.db.prepare("SELECT urgency FROM outbox WHERE body_chars = ? ORDER BY created_at DESC LIMIT 1").get("this is urgent!!".length) as { urgency: string };
    assert.equal(row.urgency, "normal");
  } finally {
    await client.close();
  }
});

test("a local agent answers a public peer by name and the peer reads the answer with its token", async () => {
  const peer = await tokenFor("grok-reader", ["alpha"]);
  const codex = await codexIdentity("codex-pub-1", "/work/pub");
  await sendMessage(codex, "grok-reader", "what do you think of the plan?");
  const client = await mcpClient(base, bearer(peer.token));
  try {
    const inbox = await callAs(client, "read_inbox");
    assert.match(inbox.text, /what do you think of the plan\?/);
    assert.doesNotMatch(inbox.text, /uds:|\.sock|reply-to/);
  } finally {
    await client.close();
  }
});

test("?key= works for /mcp like a bearer header", async () => {
  const peer = await tokenFor("grok-query", ["alpha"]);
  const r = await raw(base, `/mcp?key=${peer.token}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(r.status, 200);
});

test("no token, a wrong token and a revoked token are refused, and the refusal points at the OAuth metadata", async () => {
  const post = (headers: Record<string, string>, path = "/mcp") => raw(base, path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  const none = await post({});
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /Bearer realm="agentsocks", resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
  const made = await tokenFor("short-lived", ["alpha"]);
  const wrongSecret = made.token.slice(0, -3) + (made.token.endsWith("aaa") ? "bbb" : "aaa");
  assert.equal((await post(bearer(wrongSecret))).status, 401);
  assert.equal((await post(bearer("agk_00000000_" + "A".repeat(43)))).status, 401);
  assert.equal((await post(bearer(made.token))).status, 200);
  await broker.dispatch({ op: "gateway_token_revoke", id: made.id });
  assert.equal((await post(bearer(made.token))).status, 401);
  assert.equal((await post({ "tailscale-user-login": "sam@example.com", "x-forwarded-for": "100.64.0.2" })).status, 401, "Tailscale headers mean nothing on the public listener");
});

test("a token is stored hashed with a salt, never in the clear, and listing shows ids only", async () => {
  const made = await tokenFor("hashed", []);
  const rows = JSON.stringify(broker.store.db.prepare("SELECT * FROM gateway_tokens").all());
  assert.ok(!rows.includes(made.token));
  assert.ok(!rows.includes(made.token.replace(/^agk_[0-9a-f]{8}_/, "")));
  const listed = (await broker.dispatch({ op: "gateway_token_list" })).result as { tokens: { id: string; label: string }[] };
  assert.ok(listed.tokens.some((t) => t.id === made.id && t.label === "hashed"));
  assert.ok(!JSON.stringify(listed).includes(made.token));
  await assert.rejects(tokenFor("hashed", []), /a remote peer named hashed already exists/);
});

test("repeated wrong tokens from one source are slowed down with a 429", async () => {
  let last = 0;
  for (let i = 0; i < 25; i++) {
    const r = await raw(base, "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer agk_deadbeef_" + "B".repeat(43), "x-forwarded-for": "203.0.113.7" }, body: "{}" });
    last = r.status;
    if (last === 429) break;
  }
  assert.equal(last, 429);
  const other = await raw(base, "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer agk_deadbeef_" + "B".repeat(43), "x-forwarded-for": "203.0.113.8" }, body: "{}" });
  assert.equal(other.status, 401, "another source is not slowed down");
});

test("a client with a valid token is not slowed down by someone else's failed attempts from the same address", async () => {
  const good = await tokenFor("steady", ["alpha"]);
  const noise = (n: number) => raw(base, "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer agk_deadbeef_${"C".repeat(43)}`, "x-forwarded-for": "203.0.113.50" }, body: n ? "{}" : "{}" });
  let last = 0;
  for (let i = 0; i < 25 && last !== 429; i++) last = (await noise(i)).status;
  assert.equal(last, 429);
  const ok = await raw(base, "/mcp", { method: "POST", headers: { ...bearer(good.token), "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "203.0.113.50" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(ok.status, 200);
});

test("a request that sends its body too slowly is answered with 408 and the connection is closed, so slow clients cannot hold connections", async () => {
  process.env.AGENTSOCKS_GATEWAY_BODY_MS = "400";
  try {
    const url = new URL(base);
    const answer = await new Promise<string>((resolve, reject) => {
      const sock = createConnection({ host: url.hostname, port: Number(url.port) });
      let received = "";
      sock.setEncoding("utf8");
      sock.on("data", (d: string) => (received += d));
      sock.on("close", () => resolve(received));
      sock.on("error", reject);
      sock.on("connect", () => sock.write(`POST /oauth/token HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 400\r\n\r\ngrant_type=refresh`));
      setTimeout(() => sock.destroy(), 5000).unref();
    });
    assert.match(answer, /^HTTP\/1\.1 408 /);
    assert.match(answer, /the request body arrived too slowly/);
  } finally {
    delete process.env.AGENTSOCKS_GATEWAY_BODY_MS;
  }
});

test("routes that belong to the tailnet listener are not on the public one", async () => {
  for (const path of ["/app", "/app/api/state", "/federation/peers"]) assert.equal((await raw(base, path)).status, 404, path);
});

async function oauthClient(redirect = "https://chatgpt.example/callback") {
  const reg = await raw(base, "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
  assert.equal(reg.status, 201);
  const client = reg.json() as { client_id: string };
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash("sha256").update(verifier).digest());
  const params = (extra: Record<string, string> = {}) => new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", ...extra });
  return { id: client.client_id, redirect, verifier, challenge, params };
}

const postForm = (path: string, form: URLSearchParams, headers: Record<string, string> = {}) => raw(base, path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: form.toString() });

async function pairCode(name = "chatgpt", may = ["alpha"]): Promise<string> {
  return ((await broker.dispatch({ op: "gateway_pair", name, mayMessage: may })).result as { code: string }).code;
}

async function authorize(c: Awaited<ReturnType<typeof oauthClient>>, code: string, headers: Record<string, string> = {}) {
  const form = c.params();
  form.set("code", code);
  return postForm("/oauth/authorize", form, headers);
}

test("OAuth metadata names the endpoints, S256 only, public clients only", async () => {
  const resource = (await raw(base, "/.well-known/oauth-protected-resource")).json() as { resource: string; authorization_servers: string[] };
  assert.equal(resource.resource, `${base}/mcp`);
  assert.deepEqual(resource.authorization_servers, [base]);
  const meta = (await raw(base, "/.well-known/oauth-authorization-server")).json() as Record<string, unknown>;
  assert.equal(meta.issuer, base);
  assert.equal(meta.authorization_endpoint, `${base}/oauth/authorize`);
  assert.equal(meta.token_endpoint, `${base}/oauth/token`);
  assert.equal(meta.registration_endpoint, `${base}/oauth/register`);
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(meta.token_endpoint_auth_methods_supported, ["none"]);
});

test("the OAuth flow ChatGPT uses: register, consent with the pairing code, PKCE token exchange, then the reduced tools as a peer named after the pairing", async () => {
  const c = await oauthClient();
  const page = await raw(base, `/oauth/authorize?${c.params().toString()}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /ChatGPT/);
  assert.match(page.text, /chatgpt\.example/);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);

  const wrong = await authorize(c, "000000");
  assert.equal(wrong.status, 200, "a wrong code shows the page again and redirects nowhere");
  assert.match(wrong.text, /That code did not work/);

  const code = await pairCode();
  const consent = await authorize(c, code);
  assert.equal(consent.status, 302);
  const back = new URL(consent.headers.get("location")!);
  assert.equal(`${back.origin}${back.pathname}`, "https://chatgpt.example/callback");
  assert.equal(back.searchParams.get("state"), "xyz");
  const granted = back.searchParams.get("code")!;

  const reuse = await authorize(c, code);
  assert.match(reuse.text, /That code did not work/, "a pairing code works once");

  const form = new URLSearchParams({ grant_type: "authorization_code", code: granted, redirect_uri: c.redirect, client_id: c.id, code_verifier: c.verifier });
  const token = await postForm("/oauth/token", form);
  assert.equal(token.status, 200);
  assert.equal(token.headers.get("cache-control"), "no-store");
  const issued = token.json() as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
  assert.equal(issued.token_type, "Bearer");
  assert.equal(issued.expires_in, 3600);

  const client = await mcpClient(base, bearer(issued.access_token));
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["answer", "list_peers", "read_inbox", "send_message", "wait_for_message"]);
    const sent = await callAs(client, "send_message", { to: "alpha", message: "hello from chatgpt" });
    assert.equal(sent.isError, false);
    const frame = await until(() => alpha.frames.find((f) => parseEnvelope(messageContent(f))?.body === "hello from chatgpt"));
    assert.equal(parseEnvelope(messageContent(frame))!.fromName, "chatgpt (remote)");
    assert.equal((await callAs(client, "send_message", { to: "beta", message: "no" })).isError, true);
  } finally {
    await client.close();
  }
});

test("the authorization code is bound to its PKCE verifier, client and redirect, and a replayed code revokes what it produced", async () => {
  const c = await oauthClient();
  const exchange = async (granted: string, over: Record<string, string> = {}) =>
    postForm("/oauth/token", new URLSearchParams({ grant_type: "authorization_code", code: granted, redirect_uri: c.redirect, client_id: c.id, code_verifier: c.verifier, ...over }));
  const grant = async () => new URL((await authorize(c, await pairCode("chatgpt", ["alpha"]))).headers.get("location")!).searchParams.get("code")!;

  assert.equal((await exchange(await grant(), { code_verifier: b64(randomBytes(32)) })).status, 400, "another verifier");
  assert.equal((await exchange(await grant(), { redirect_uri: "https://chatgpt.example/other" })).status, 400, "another redirect");
  assert.equal((await exchange(await grant(), { client_id: "agc_unknown" })).status, 401, "another client");
  assert.equal((await exchange("not-a-code")).status, 400);

  const good = await grant();
  const first = await exchange(good);
  assert.equal(first.status, 200);
  const access = (first.json() as { access_token: string }).access_token;
  const check = () => raw(base, "/mcp", { method: "POST", headers: { ...bearer(access), "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal((await check()).status, 200);
  assert.equal((await exchange(good)).status, 400, "the same code twice");
  assert.equal((await check()).status, 401, "and the token it gave is revoked");
});

test("refresh tokens rotate, and presenting an old one revokes the whole grant", async () => {
  const c = await oauthClient();
  const granted = new URL((await authorize(c, await pairCode("chatgpt", []))).headers.get("location")!).searchParams.get("code")!;
  const first = (await postForm("/oauth/token", new URLSearchParams({ grant_type: "authorization_code", code: granted, redirect_uri: c.redirect, client_id: c.id, code_verifier: c.verifier }))).json() as { access_token: string; refresh_token: string };
  const refresh = (token: string) => postForm("/oauth/token", new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: c.id }));
  const second = await refresh(first.refresh_token);
  assert.equal(second.status, 200);
  const next = second.json() as { access_token: string; refresh_token: string };
  assert.notEqual(next.refresh_token, first.refresh_token);
  assert.equal((await refresh(first.refresh_token)).status, 400, "the old refresh token is dead");
  const probe = (access: string) => raw(base, "/mcp", { method: "POST", headers: { ...bearer(access), "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal((await probe(next.access_token)).status, 401, "using the old one also revoked the new grant");
});

test("the consent page refuses what is not a plain S256 request for a registered redirect", async () => {
  const c = await oauthClient();
  const bad = async (over: Record<string, string>) => (await raw(base, `/oauth/authorize?${c.params(over).toString()}`)).status;
  assert.equal(await bad({ code_challenge_method: "plain" }), 400);
  assert.equal(await bad({ redirect_uri: "https://evil.example/callback" }), 400);
  assert.equal(await bad({ client_id: "agc_unknown" }), 400);
  assert.equal(await bad({ response_type: "token" }), 400);
  assert.equal(await bad({ code_challenge: "short" }), 400);
  const reg = (uris: unknown) => raw(base, "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: uris }) });
  assert.equal((await reg(["http://evil.example/cb"])).status, 400, "plain http only for localhost");
  assert.equal((await reg(["https://ok.example/cb#frag"])).status, 400);
  assert.equal((await reg([])).status, 400);
  assert.equal((await reg(["http://127.0.0.1:8123/cb"])).status, 201);
});

test("wrong pairing codes lock the consent page for everyone, even for the right code", async () => {
  const c = await oauthClient();
  const code = await pairCode("locked-out", []);
  const wrongCode = code === "123456" ? "654321" : "123456";
  const from = { "x-forwarded-for": "198.51.100.1" };
  let refused = 0;
  for (let i = 0; i < 6 && refused === 0; i++) if ((await authorize(c, wrongCode, from)).status === 429) refused = i + 1;
  assert.ok(refused > 0 && refused <= 6, "five wrong codes in ten minutes lock the page for that source");
  const locked = await authorize(c, code, from);
  assert.equal(locked.status, 429);
  assert.match(locked.text, /Too many attempts/);
  const elsewhere = await authorize(c, code, { "x-forwarded-for": "198.51.100.2" });
  assert.equal(elsewhere.status, 302, "a different source is not locked out by it");
});

test("registrations stop at the cap instead of evicting, so a grant that exists keeps working; idle registrations expire", async () => {
  const c = await oauthClient("https://real.example/callback");
  const granted = new URL((await authorize(c, await pairCode("cap-peer", []), { "x-forwarded-for": "198.51.100.30" })).headers.get("location")!).searchParams.get("code")!;
  const first = (await postForm("/oauth/token", new URLSearchParams({ grant_type: "authorization_code", code: granted, redirect_uri: c.redirect, client_id: c.id, code_verifier: c.verifier }))).json() as { refresh_token: string };
  let refused = 0;
  for (let i = 0; i < 60 && refused === 0; i++) {
    const r = await raw(base, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${100 + (i % 100)}` }, body: JSON.stringify({ redirect_uris: [`https://spam${i}.example/cb`] }) });
    if (r.status === 429) refused = i + 1;
  }
  assert.ok(refused > 0, "registration was refused at the cap");
  const refresh = await postForm("/oauth/token", new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.id }));
  assert.equal(refresh.status, 200, "the real client's grant still refreshes");
  broker.store.db.prepare("UPDATE gateway_oauth_clients SET created_at = created_at - 3600000").run();
  const again = await raw(base, "/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.250" }, body: JSON.stringify({ redirect_uris: ["https://late.example/cb"] }) });
  assert.equal(again.status, 201, "idle registrations were pruned");
  assert.equal(broker.store.db.prepare("SELECT COUNT(*) AS n FROM gateway_oauth_clients WHERE client_id = ?").get(c.id) && (broker.store.db.prepare("SELECT COUNT(*) AS n FROM gateway_oauth_clients WHERE client_id = ?").get(c.id) as { n: number }).n, 1, "while the one with tokens stayed");
});

test("a pairing can be pinned to the host the application returns to, and a wrong host does not burn the code", async () => {
  const pinned = (await broker.dispatch({ op: "gateway_pair", name: "pinned-peer", mayMessage: [], redirectHost: "Chatgpt.Example" })).result as { code: string; redirectHost: string };
  assert.equal(pinned.redirectHost, "chatgpt.example");
  const attacker = await oauthClient("https://attacker.example/callback");
  const wrongHost = await authorize(attacker, pinned.code, { "x-forwarded-for": "198.51.100.40" });
  assert.equal(wrongHost.status, 200);
  assert.match(wrongHost.text, /That code did not work/);
  const real = await oauthClient("https://chatgpt.example/callback");
  assert.equal((await authorize(real, pinned.code, { "x-forwarded-for": "198.51.100.41" })).status, 302);
  await assert.rejects(broker.dispatch({ op: "gateway_pair", name: "bad-pin", redirectHost: "not a host" }), /--redirect-host must be a host name/);
});

test("a redirect address is matched exactly as the application registered it, whatever its case", async () => {
  const c = await oauthClient("https://Mixed.Example/Callback");
  const code = await pairCode("mixed-case", []);
  const r = await authorize(c, code, { "x-forwarded-for": "198.51.100.50" });
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get("location")!).host, "mixed.example");
});

test("a replayed code revokes only the grant it produced, not another grant of the same application", async () => {
  const c = await oauthClient("https://two-grants.example/cb");
  const grant = async () => new URL((await authorize(c, await pairCode("two-grants", []), { "x-forwarded-for": "198.51.100.60" })).headers.get("location")!).searchParams.get("code")!;
  const exchange = (code: string) => postForm("/oauth/token", new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: c.redirect, client_id: c.id, code_verifier: c.verifier }));
  const codeOne = await grant();
  const tokenOne = ((await exchange(codeOne)).json() as { access_token: string }).access_token;
  const tokenTwo = ((await exchange(await grant())).json() as { access_token: string }).access_token;
  assert.equal((await exchange(codeOne)).status, 400);
  const probe = (access: string) => raw(base, "/mcp", { method: "POST", headers: { ...bearer(access), "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal((await probe(tokenOne)).status, 401);
  assert.equal((await probe(tokenTwo)).status, 200);
});

test("many wrong codes from many sources still lock the page for everyone, so a spread-out guess cannot get through", async () => {
  const c = await oauthClient();
  const code = await pairCode("spread-out", []);
  const wrong = code === "123456" ? "654321" : "123456";
  let locked = 0;
  for (let i = 0; i < 40 && locked === 0; i++) if ((await authorize(c, wrong, { "x-forwarded-for": `192.0.2.${i + 1}` })).status === 429) locked = i + 1;
  assert.ok(locked > 0 && locked <= 31, `locked after ${locked} wrong codes`);
  assert.equal((await authorize(c, code, { "x-forwarded-for": "192.0.2.200" })).status, 429);
});
