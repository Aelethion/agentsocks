import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { root, until } from "./support.ts";
import { cat } from "./fakes.ts";
import { tempDir } from "./tmp.ts";
import { Broker } from "../src/broker.ts";
import { hermesAgent } from "../src/agents/hermes.ts";
import { sendWake, wakeConfig, WAKE_LIMITS } from "../src/agents/hermes/wake.ts";
import { agentsocksEnvPath, configPath } from "../src/paths.ts";
import { encodeAddress } from "../src/envelope.ts";

const KEY = cat("hk", "_test_", "0123456789abcdef");
const BODY = "please look at the failing migration ZEBRA-PASSWORD-1234";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let port = 0;
const seen: Seen[] = [];
let reply: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      reply(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  await broker.start();
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await broker.stop();
});

const broker = new Broker({ ttyScan: () => [], agents: [hermesAgent] });

const writeConfig = (hermes: Record<string, unknown> | undefined): void => {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(hermes ? { hermes } : {}));
};
const writeKey = (value: string | undefined): void => {
  mkdirSync(dirname(agentsocksEnvPath()), { recursive: true });
  if (value === undefined) rmSync(agentsocksEnvPath(), { force: true });
  else writeFileSync(agentsocksEnvPath(), `HERMES_API_SERVER_KEY=${value}\n`);
};
const configure = (extra: Record<string, unknown> = {}): void => {
  writeConfig({ apiUrl: `http://127.0.0.1:${port}`, ...extra });
  writeKey(KEY);
};

const audit = (event: string): string[] => {
  const file = join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes(`"event":"${event}"`)) : [];
};

let n = 0;
async function idleThreadWithMessage(): Promise<string> {
  const raw = `20261013_3${String(++n).padStart(5, "0")}_w${n}`;
  const id = `hermes_${raw}`;
  broker.store.upsertThread(id, { agent: "hermes", state: "idle", hooks_active: 1 }, "hermes-wake");
  broker.store.enqueue({ id: `m-${raw}`, msg_id: `m-${raw}`, to_thread: id, kind: "message", from_addr: encodeAddress(`${root}/cc-socks/ann.sock`), from_name: "ann", from_kind: "claude", from_session: null, from_mode: null, body: BODY, received_at: Date.now(), route: "now", decision: null });
  return id;
}

beforeEach(() => {
  seen.length = 0;
  reply = (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  writeConfig(undefined);
  writeKey(undefined);
});

test("with a Hermes API URL and key configured, an idle session is woken with a POST to /api/sessions/<its id>/chat carrying the content-free line and the bearer key, and nothing the sender wrote", async () => {
  configure();
  const id = await idleThreadWithMessage();
  await broker.wake(id, Date.now() + 5000);
  assert.equal(seen.length, 1);
  const req = seen[0]!;
  assert.equal(req.method, "POST");
  assert.equal(req.url, `/api/sessions/${id.slice("hermes_".length)}/chat`);
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  assert.match(req.headers["content-type"] ?? "", /^application\/json/);
  assert.deepEqual(JSON.parse(req.body), { input: "📨 agentsocks: new message from a Claude Code session. Read it with read_inbox." });
  assert.ok(!req.body.includes("ZEBRA") && !req.body.includes("migration"));
  assert.equal(audit("wake").filter((l) => l.includes(id)).length, 1);
  assert.equal(JSON.parse(broker.store.getThread(id)!.wake_log).length, 1);
});

test("the thread id's hermes_ prefix is removed: the API is given Hermes' own session id", async () => {
  configure();
  const id = await idleThreadWithMessage();
  await broker.wake(id, Date.now() + 5000);
  assert.ok(!seen[0]!.url.includes("hermes_"));
});

test("a base path in the URL, such as a profile prefix, is kept", async () => {
  configure({ apiUrl: `http://127.0.0.1:${port}/p/work/` });
  const id = await idleThreadWithMessage();
  await broker.wake(id, Date.now() + 5000);
  assert.equal(seen[0]!.url, `/p/work/api/sessions/${id.slice("hermes_".length)}/chat`);
});

test("without a configured URL, or with a URL and no key, nothing is sent and no failure is recorded: Hermes stays pull only", async () => {
  const id = await idleThreadWithMessage();
  const failures = audit("wake_failed").length;
  assert.equal(hermesAgent.canWake?.(), false);
  await broker.wake(id, Date.now() + 5000);
  writeConfig({ apiUrl: `http://127.0.0.1:${port}` });
  assert.equal(hermesAgent.canWake?.(), false);
  await broker.wake(id, Date.now() + 5000);
  assert.equal(seen.length, 0);
  assert.equal(audit("wake_failed").length, failures);
  assert.equal(broker.store.getThread(id)!.pending_wake_at, null);
});

test("the key can come from a file named in the config, under either its agentsocks name or Hermes' own", async () => {
  const dir = tempDir("hermes-key-");
  for (const variable of ["HERMES_API_SERVER_KEY", "API_SERVER_KEY"]) {
    writeFileSync(join(dir, ".env"), `OPENROUTER_API_KEY=other\n${variable}="${KEY}"\n`);
    writeConfig({ apiUrl: `http://127.0.0.1:${port}`, apiKeyFile: join(dir, ".env") });
    const c = wakeConfig();
    assert.equal(c.state, "on", variable);
    assert.equal(c.state === "on" && c.key, KEY);
  }
});

test("a URL that is not on this machine is refused unless the config allows it and it is https", () => {
  writeKey(KEY);
  writeConfig({ apiUrl: "http://192.0.2.7:8642" });
  assert.match((wakeConfig() as { why: string }).why, /not on this machine/);
  writeConfig({ apiUrl: "http://192.0.2.7:8642", allowRemote: true });
  assert.match((wakeConfig() as { why: string }).why, /not https/);
  writeConfig({ apiUrl: "https://hermes.example.com", allowRemote: true });
  assert.equal(wakeConfig().state, "on");
  for (const local of ["http://localhost:8642", "http://127.0.0.1:8642", "http://[::1]:8642"]) {
    writeConfig({ apiUrl: local });
    assert.equal(wakeConfig().state, "on", local);
  }
  for (const bad of ["ftp://127.0.0.1", "http://user:pw@127.0.0.1:8642", "not a url", 7]) {
    writeConfig({ apiUrl: bad });
    assert.equal(wakeConfig().state, "incomplete", String(bad));
  }
});

test("a key with spaces or control characters is not used, since it could not be a header value", () => {
  writeConfig({ apiUrl: `http://127.0.0.1:${port}` });
  writeKey("two words");
  assert.equal(wakeConfig().state, "incomplete");
  writeKey(undefined);
  assert.equal(wakeConfig().state, "incomplete");
});

test("a key set only in the broker's environment does not switch the wake on", () => {
  writeConfig({ apiUrl: `http://127.0.0.1:${port}` });
  process.env.HERMES_API_SERVER_KEY = KEY;
  try {
    assert.equal(wakeConfig().state, "incomplete");
  } finally {
    delete process.env.HERMES_API_SERVER_KEY;
  }
});

test("a 401 is a failed wake: it is audited with the status, the broker backs off, and the key is nowhere in the audit log", async () => {
  configure();
  reply = (_req, res) => res.writeHead(401, { "content-type": "application/json" }).end(`{"error":"bad key ${KEY}"}`);
  const id = await idleThreadWithMessage();
  const at = Date.now() + 5000;
  await broker.wake(id, at);
  await broker.wake(id, at + 10_000);
  assert.equal(seen.length, 1, "inside the backoff nothing is sent again");
  const failed = audit("wake_failed").filter((l) => l.includes(id));
  assert.equal(failed.length, 1);
  assert.match(failed[0]!, /HTTP 401/);
  assert.equal(JSON.parse(broker.store.getThread(id)!.wake_log).length, 0);
  const log = readFileSync(join(process.env.AGENTSOCKS_STATE_DIR!, "audit.log"), "utf8");
  assert.ok(!log.includes(KEY), "the key never reaches the audit log");
  assert.ok(!log.includes("ZEBRA"));
});

test("a 500 and a refused connection are failed wakes too", async () => {
  configure();
  reply = (_req, res) => res.writeHead(500).end("boom");
  const id = await idleThreadWithMessage();
  await broker.wake(id, Date.now() + 5000);
  assert.match(audit("wake_failed").filter((l) => l.includes(id))[0] ?? "", /HTTP 500/);
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const gone = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  writeConfig({ apiUrl: `http://127.0.0.1:${gone}` });
  const other = await idleThreadWithMessage();
  await broker.wake(other, Date.now() + 5000);
  assert.match(audit("wake_failed").filter((l) => l.includes(other))[0] ?? "", /connection refused/);
});

test("a redirect is a failure and is not followed", async () => {
  configure();
  let elsewhere = 0;
  const target = http.createServer((_req, res) => {
    elsewhere++;
    res.end();
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const to = (target.address() as AddressInfo).port;
  reply = (_req, res) => res.writeHead(307, { location: `http://127.0.0.1:${to}/steal` }).end();
  const outcome = await sendWake({ base: new URL(`http://127.0.0.1:${port}`), key: KEY }, "sess_1", "line");
  await new Promise<void>((resolve) => target.close(() => resolve()));
  assert.equal(outcome.ok, false);
  assert.equal(elsewhere, 0, "the key and the line were not sent on");
  assert.match(outcome.ok ? "" : outcome.detail, /redirects are not followed/);
});

test("the turn Hermes runs for a wake can take minutes, so a request that was accepted and has not answered by the accept window counts as delivered", async () => {
  configure();
  reply = () => {};
  const outcome = await sendWake({ base: new URL(`http://127.0.0.1:${port}`), key: KEY }, "sess_1", "line", { ...WAKE_LIMITS, acceptMs: 100, holdMs: 1000 });
  assert.deepEqual(outcome, { ok: true });
  assert.equal(seen.length, 1);
});

test("a server that rejects the request after the accept window is not mistaken for success when it answers inside it", async () => {
  configure();
  reply = (_req, res) => setTimeout(() => res.writeHead(404).end(), 20);
  const outcome = await sendWake({ base: new URL(`http://127.0.0.1:${port}`), key: KEY }, "missing", "line", { ...WAKE_LIMITS, acceptMs: 500 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.detail, /HTTP 404/);
});

test("a huge response body is cut off instead of being held in memory", async () => {
  configure();
  let cutOff = false;
  reply = (_req, res) => {
    res.writeHead(200);
    const chunk = Buffer.alloc(16 * 1024, 97);
    const timer = setInterval(() => res.write(chunk), 1);
    res.on("close", () => {
      cutOff = true;
      clearInterval(timer);
    });
  };
  const outcome = await sendWake({ base: new URL(`http://127.0.0.1:${port}`), key: KEY }, "sess_1", "line", { ...WAKE_LIMITS, maxBytes: 32 * 1024 });
  assert.deepEqual(outcome, { ok: true });
  await until(() => cutOff);
});

test("a thread that is not a Hermes session is refused before any request", async () => {
  configure();
  const out = await hermesAgent.wake!({ broker, thread: { thread_id: "019e2f00-aaaa" } as never, line: "x" });
  assert.equal(out.ok, false);
  assert.equal(seen.length, 0);
});

test("a host that never answers the connection is a failed wake that gives up at the connect limit", async () => {
  const started = Date.now();
  const outcome = await sendWake({ base: new URL("http://10.255.255.1:81"), key: KEY }, "sess_1", "line", { ...WAKE_LIMITS, connectMs: 300, acceptMs: 5000, holdMs: 5000 });
  assert.equal(outcome.ok, false);
  assert.ok(Date.now() - started < 3000, `gave up after ${Date.now() - started} ms`);
  assert.ok(!(outcome.ok ? "" : outcome.detail).includes(KEY));
});

test("an https server that accepts the connection and never speaks TLS is a failed wake at the connect limit, not a socket held for the whole hold time", async () => {
  const silent = net.createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const at = (silent.address() as AddressInfo).port;
  const started = Date.now();
  const outcome = await sendWake({ base: new URL(`https://127.0.0.1:${at}`), key: KEY }, "sess_1", "line", { ...WAKE_LIMITS, connectMs: 300, acceptMs: 5000, holdMs: 5000 });
  silent.close();
  assert.equal(outcome.ok, false);
  assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started} ms`);
});
