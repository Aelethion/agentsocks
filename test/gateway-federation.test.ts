import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { Gateway } from "../src/gateway/runtime.ts";
import { gatewayState } from "../src/gateway/state.ts";
import { Store } from "../src/store.ts";
import { dbPath } from "../src/paths.ts";
import { uninstallGatewayState } from "../src/install.ts";
import { fakeLocalApi, fakeServe, mcpClient, raw, type FakeLocalApi, type FakeServe } from "./gatewaysupport.ts";
import { tempDir } from "./tmp.ts";

const broker = new Broker();
let api: FakeLocalApi;
let serve: FakeServe | undefined;
const priorTsSocket = process.env.TS_SOCKET;
const priorTailscaleBin = process.env.AGENTSOCKS_TAILSCALE_BIN;

async function op<T>(opName: string, req: Record<string, unknown> = {}): Promise<T> {
  const reply: unknown = await broker.dispatch({ op: opName, ...req });
  if (reply && typeof reply === "object" && "result" in reply) return reply.result as T;
  throw new Error(`${opName} returned no result`);
}
const field = (value: unknown, name: string): unknown => {
  if (value && typeof value === "object" && name in value) return (value as Record<string, unknown>)[name];
  throw new Error(`response has no ${name}`);
};

const textField = (value: unknown, name: string): string => {
  const got: unknown = field(value, name);
  if (typeof got === "string") return got;
  throw new Error(`response field ${name} is not a string`);
};

before(async () => {
  api = await fakeLocalApi({ login: "sam@example.com", dnsName: "w1cbox.tail1234.ts.net" });
  process.env.TS_SOCKET = api.socketPath;
  await broker.start();
});

after(async () => {
  await serve?.close();
  await broker.stop();
  await api.close();
  if (priorTsSocket === undefined) delete process.env.TS_SOCKET;
  else process.env.TS_SOCKET = priorTsSocket;
  if (priorTailscaleBin === undefined) delete process.env.AGENTSOCKS_TAILSCALE_BIN;
  else process.env.AGENTSOCKS_TAILSCALE_BIN = priorTailscaleBin;
});

test("a link whose URL is outside the own tailnet suffix is refused, never recorded under the remote claim", async () => {
  const gw = new Gateway(broker, {
    whois: async () => undefined,
    self: async () => ({ login: "sam@example.com", dnsName: "w1cbox.tail1234.ts.net" }),
  });
  try {
    await assert.rejects(gw.federation.handshake("https://intruder.example.com/"), /outside this tailnet/);
    assert.equal(gatewayState(broker.store).host("intruder"), undefined, "the claimed name is not recorded");
  } finally {
    await gw.federation.stop();
  }
});

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();
const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function fullGrant(publicBase: string, name: string, mayMessage: string[]): Promise<string> {
  const reg = await raw(publicBase, "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "W1cApp", redirect_uris: ["https://chatgpt.example/cb"] }) });
  const clientId = textField(reg.json(), "client_id");
  assert.ok(clientId, `the client registered: ${reg.text.slice(0, 120)}`);
  const { verifier, challenge } = pkce();
  const code = (await op<{ code: string }>("gateway_pair", { name, mayMessage })).code;
  const consent = await raw(publicBase, "/oauth/authorize", {
    method: "POST",
    headers: FORM,
    body: form({ response_type: "code", client_id: clientId, redirect_uri: "https://chatgpt.example/cb", code_challenge: challenge, code_challenge_method: "S256", code, state: "w1c" }),
  });
  assert.equal(consent.status, 302, consent.text.slice(0, 200));
  const location = consent.headers.get("location");
  assert.ok(location, "the consent redirects with a code");
  const authCode = new URL(location).searchParams.get("code")!;
  const tok = await raw(publicBase, "/oauth/token", {
    method: "POST",
    headers: FORM,
    body: form({ grant_type: "authorization_code", client_id: clientId, code: authCode, redirect_uri: "https://chatgpt.example/cb", code_verifier: verifier }),
  });
  assert.equal(tok.status, 200, tok.text);
  return textField(tok.json(), "access_token");
}

test("after the owner revokes a ChatGPT grant, pairing the same name again yields a working narrow grant", async () => {
  const pub = await op<{ public: { port: number } }>("gateway_public", { via: "funnel", port: 0 });
  const publicBase = `http://127.0.0.1:${pub.public.port}`;
  const firstAccess = await fullGrant(publicBase, "w1c-chatgpt", ["w1c-alpha"]);
  const firstClient = await mcpClient(publicBase, { Authorization: `Bearer ${firstAccess}` });
  try {
    await firstClient.listTools();
  } finally {
    await firstClient.close();
  }
  const grants = await op<{ tokens: { id: string }[] }>("gateway_token_list");
  const id = grants.tokens.find((t) => t.id.startsWith("g-"))?.id ?? grants.tokens[0]!.id;
  await op("gateway_token_revoke", { id });
  await assert.rejects(
    (async () => {
      const dead = await mcpClient(publicBase, { Authorization: `Bearer ${firstAccess}` });
      try {
        await dead.listTools();
      } finally {
        await dead.close();
      }
    })(),
    "the revoked grant stops working",
  );
  const secondAccess = await fullGrant(publicBase, "w1c-chatgpt", ["w1c-alpha"]);
  const live = await mcpClient(publicBase, { Authorization: `Bearer ${secondAccess}` });
  try {
    await live.listTools();
  } finally {
    await live.close();
  }
  const peer = gatewayState(broker.store).getPeer("oauth:w1c-chatgpt")!;
  assert.equal(peer.disabled, 0, "re-pair switches the peer back on");
  assert.equal(peer.may_message, '["w1c-alpha"]', "re-pair applies the fresh narrow list");
});

test("an in-flight federation pull ends when the host allow is removed", async () => {
  api.machines.set("100.64.9.1", { name: "w1c-fed", login: "sam@example.com", ip: "100.64.9.1" });
  await op("gateway_allow", { host: "w1c-fed" });
  const on = await op<{ private: { port: number } }>("gateway_on", { port: 0 });
  serve = await fakeServe(on.private.port, { login: "sam@example.com", ip: "100.64.9.1" }, {}, "w1cbox.tail1234.ts.net");
  const started = Date.now();
  const waited = fetch(`${serve.url}/federation/pull?wait=10`, { signal: AbortSignal.timeout(15000) }).then(async (r) => ({ status: r.status, body: await r.text() }));
  // Real delay: the point is a live long-poll hanging while the owner disallows the host mid-poll; no event signals that.
  await new Promise((r) => setTimeout(r, 700));
  await op("gateway_allow", { host: "w1c-fed", allowed: false });
  const got = await waited;
  const elapsed = Date.now() - started;
  assert.equal(got.status, 200, got.body.slice(0, 200));
  assert.deepEqual(JSON.parse(got.body), { items: [] });
  assert.ok(elapsed < 8000, `the poll ended on disallow after ${elapsed}ms instead of running the full wait`);
});

const seedServed = (): void => {
  const seed = new Store(dbPath());
  try {
    const st = gatewayState(seed);
    st.setSetting("private", JSON.stringify({ enabled: true, port: 23456, served: true }));
    st.setSetting("public", JSON.stringify({ enabled: true, port: 23457, via: "funnel", exposed: true }));
  } finally {
    seed.close();
  }
};

const flagOf = (store: Store, key: string, flag: string): unknown => {
  const raw: unknown = gatewayState(store).setting(key);
  if (typeof raw !== "string") return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && flag in parsed) return (parsed as Record<string, unknown>)[flag];
  return undefined;
};
const shimBin = (dir: string, exitZero: boolean): { bin: string; log: string } => {
  const bin = join(dir, "tailscale");
  const log = join(dir, "calls.log");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n${exitZero ? "" : "exit 1\n"}`);
  chmodSync(bin, 0o755);
  return { bin, log };
};

const withoutBrokerSocket = async <T>(fn: () => Promise<T>): Promise<T> => {
  const prior = process.env.AGENTSOCKS_RUNTIME_DIR;
  process.env.AGENTSOCKS_RUNTIME_DIR = tempDir("w1c-nobroker-");
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.AGENTSOCKS_RUNTIME_DIR;
    else process.env.AGENTSOCKS_RUNTIME_DIR = prior;
  }
};

test("broker-down uninstall runs serve off and funnel off while the state says served/exposed", async () => {
  const dir = tempDir("w1c-uninstall-");
  const { bin, log } = shimBin(dir, true);
  process.env.AGENTSOCKS_TAILSCALE_BIN = bin;
  seedServed();
  const lines = await withoutBrokerSocket(() => uninstallGatewayState(false));
  assert.equal(lines.failed, undefined, lines.join("\n"));
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "NONE";
  assert.match(calls, /serve.*off/, `serve off ran, got: ${calls}`);
  assert.match(calls, /funnel.*off/, `funnel off ran, got: ${calls}`);
  const text = lines.join("\n");
  assert.match(text, /undid the tailscale serve/);
  assert.match(text, /undid the tailscale funnel/);
  const check = new Store(dbPath());
  try {
    assert.equal(flagOf(check, "private", "served") ?? false, false);
    assert.equal(flagOf(check, "public", "exposed") ?? false, false);
  } finally {
    check.close();
  }
});

test("when an off command fails the flags are kept and the message says so", async () => {
  const dir = tempDir("w1c-uninstall-fail-");
  const { bin, log } = shimBin(dir, false);
  process.env.AGENTSOCKS_TAILSCALE_BIN = bin;
  seedServed();
  const lines = await withoutBrokerSocket(() => uninstallGatewayState(false));
  assert.equal(lines.failed, undefined, lines.join("\n"));
  assert.ok(existsSync(log), "the off commands still ran");
  const check = new Store(dbPath());
  try {
    assert.equal(flagOf(check, "private", "served"), true, "the serve flag survives a failed off");
    assert.equal(flagOf(check, "public", "exposed"), true, "the funnel flag survives a failed off");
  } finally {
    check.close();
  }
  assert.match(lines.join("\n"), /could not undo/, "the message says the exposure may remain");
});
