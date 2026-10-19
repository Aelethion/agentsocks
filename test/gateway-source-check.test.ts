import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { gatewayOf, isPollRoute } from "../src/gateway/runtime.ts";
import { isCanonicalPath } from "../src/gateway/http.ts";
import { sourceCheck } from "../src/gateway/source.ts";
import { fakeLocalApi, raw, type FakeLocalApi } from "./gatewaysupport.ts";

const broker = new Broker();
let api: FakeLocalApi;
let priv = "";
let pub = "";
const OWNER = "sam@example.com";
const HOST = "devbox.tail1234.ts.net";
const JRPC = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
const MHD = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const tail = (login: string, ip: string): Record<string, string> => ({ host: HOST, "tailscale-user-login": login, "x-forwarded-for": ip });
const close = { connection: "close" };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  process.env.AGENTSOCKS_GATEWAY_HEADERS_MS = "400";
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
  delete process.env.AGENTSOCKS_GATEWAY_HEADERS_MS;
  await broker.stop();
  await api.close();
});

const TABLE_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const tableRow = (n: number, local: string, remote: string, uid: number): string => `   ${n}: ${local} ${remote} 01 00000000:00000000 00:00000000 00000000  ${String(uid).padStart(4)}        0 12345 1 0000000000000000 100 0 0 10 0`;

test("a table miss reads the table fresh instead of denying the connection for life", async () => {
  const stale = [TABLE_HEADER, tableRow(9, "0100007F:1111", "0100007F:2222", 1000)].join("\n");
  const fresh = [TABLE_HEADER, tableRow(0, "0100007F:A2B4", "0100007F:1F90", 0)].join("\n");
  const socket = { remoteAddress: "127.0.0.1", remotePort: 0xa2b4, localAddress: "127.0.0.1", localPort: 0x1f90 };
  let syncReads = 0;
  let asyncReads = 0;
  const check = sourceCheck({
    platform: "linux",
    ownUid: 1000,
    expectedUid: () => 0,
    tcpTables: () => (syncReads++, [stale]),
    tcpTablesAsync: async () => (asyncReads++, [asyncReads === 1 ? stale : fresh]),
  });
  assert.equal(await check.checkSource({ socket } as never), true, "the fresh table shows tailscaled opened it");
  assert.equal(syncReads, 0, "the async path never blocks the event loop on a sync read");
  assert.equal(asyncReads, 2, "one cached read, one fresh read");
  assert.equal(await check.checkSource({ socket } as never), true, "the decision holds for the connection");
  assert.equal(asyncReads, 2, "decided once per connection");
});

test("a real new connection right after a table read is ACCEPTED", { skip: process.platform !== "linux" }, async () => {
  const uid = process.getuid!();
  const gw = gatewayOf(broker);
  const original = gw.source;
  Object.defineProperty(gw, "source", { value: sourceCheck({ platform: "linux", ownUid: uid + 1, expectedUid: () => uid }), configurable: true });
  try {
    const ping = () => raw(priv, "/mcp", { method: "POST", headers: { ...MHD, ...tail(OWNER, "100.64.0.10"), ...close }, body: JRPC });
    assert.equal((await ping()).status, 200, "cold cache accepts the connection the table shows");
    assert.equal((await ping()).status, 200, "a new connection right after a table read is accepted, not denied for life");
  } finally {
    Object.defineProperty(gw, "source", { value: original, configurable: true });
  }
});

test("canonical paths refuse backslashes and their encoded spellings", () => {
  assert.equal(isCanonicalPath("/\\evil.test/mcp"), false);
  assert.equal(isCanonicalPath("/%5Cevil.test/mcp"), false);
  assert.equal(isCanonicalPath("/%5cevil.test/mcp"), false);
  assert.equal(isCanonicalPath("/a%5cb"), false);
  assert.equal(isCanonicalPath("/a\\b"), false);
  assert.equal(isCanonicalPath("/%2e%2e/x"), false);
  assert.equal(isCanonicalPath("/%2Fetc"), false);
  assert.equal(isCanonicalPath("/mcp"), true);
  assert.equal(isCanonicalPath("/app/api/state"), true);
  assert.equal(isCanonicalPath("/.well-known/oauth-authorization-server"), true);
});

test("only poll routes skip the non-poll request timeout", () => {
  assert.equal(isPollRoute("/mcp"), true);
  assert.equal(isPollRoute("/federation/pull"), true);
  assert.equal(isPollRoute("/app/api/inbox"), true);
  assert.equal(isPollRoute("/oauth/token"), false);
  assert.equal(isPollRoute("/federation/send"), false);
});

const rawSocket = (port: number, payload: string, ms = 3000): Promise<string> =>
  new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    let got = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      got += d;
    });
    s.on("connect", () => s.write(payload));
    const done = (): void => {
      s.destroy();
      resolve(got.split("\r\n")[0] ?? "(no answer)");
    };
    s.on("close", done);
    s.on("error", done);
    setTimeout(done, ms).unref();
  });

test("a raw backslash target never reaches a route", async () => {
  const port = Number(new URL(priv).port);
  const line = await rawSocket(port, `POST /\\evil.test/mcp HTTP/1.1\r\nHost: ${HOST}\r\nTailscale-User-Login: ${OWNER}\r\nX-Forwarded-For: 100.64.0.10\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
  assert.match(line, /^HTTP\/1\.1 404/, "backslash authority-smuggling is a 404");
});

const openIdle = (port: number, firstBytes = ""): Promise<Socket> =>
  new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.resume();
    s.once("connect", () => {
      if (firstBytes) s.write(firstBytes);
      resolve(s);
    });
    s.once("error", () => resolve(s));
  });

const waitsClosed = (s: Socket, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    s.once("close", () => resolve(true));
    setTimeout(() => resolve(s.destroyed), ms).unref();
  });

test("sockets that never finish headers are reaped near the headers budget", async () => {
  const port = Number(new URL(pub).port);
  const silent = await openIdle(port);
  const partial = await openIdle(port, "GET / HTTP/1.1\r\nHost: x\r\n");
  assert.deepEqual(await Promise.all([waitsClosed(silent, 3000), waitsClosed(partial, 3000)]), [true, true], "silent and stalled sockets are destroyed near the 400 ms headers budget");
  silent.destroy();
  partial.destroy();
});

test("per-source connection caps refuse the excess and spare other sources", async () => {
  process.env.AGENTSOCKS_GATEWAY_SOURCE_CONNS = "2";
  try {
    const made = (await broker.dispatch({ op: "gateway_token_add", name: "w1c-capped", mayMessage: [] })).result as { token: string };
    const auth = { authorization: `Bearer ${made.token}` };
    const wait = (xff: string, seconds: number) =>
      raw(pub, "/mcp", {
        method: "POST",
        headers: { ...MHD, ...auth, "x-forwarded-for": xff, ...close },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_message", arguments: { timeout_seconds: seconds } } }),
      });
    const inbox = (xff: string) =>
      raw(pub, "/mcp", {
        method: "POST",
        headers: { ...MHD, ...auth, "x-forwarded-for": xff, ...close },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_inbox", arguments: {} } }),
      });
    const held = [wait("198.51.100.7", 2), wait("198.51.100.7", 2)];
    await sleep(400);
    assert.equal((await inbox("198.51.100.7")).status, 503, "the third connection from a capped source is refused");
    assert.equal((await inbox("198.51.100.8")).status, 200, "another source is unaffected");
    await Promise.all(held);
  } finally {
    delete process.env.AGENTSOCKS_GATEWAY_SOURCE_CONNS;
  }
});

test("the listener stays bounded when idle sockets pile past its budget", async () => {
  const port = Number(new URL(pub).port);
  process.env.AGENTSOCKS_GATEWAY_PENDING_CONNS = "4";
  try {
    const held = await Promise.all(Array.from({ length: 6 }, () => openIdle(port)));
    await sleep(300);
    const destroyed = held.filter((s) => s.destroyed).length;
    assert.ok(destroyed >= 2, `the oldest pending sockets are shed (${destroyed} of 6 destroyed)`);
    const probe = await raw(pub, "/.well-known/oauth-authorization-server", { headers: { ...close } });
    assert.equal(probe.status, 200, "a legitimate request still gets a connection while idle sockets pile up");
    for (const s of held) s.destroy();
  } finally {
    delete process.env.AGENTSOCKS_GATEWAY_PENDING_CONNS;
  }
});

test("the global connection budget refuses the excess while polls hold it", async () => {
  const authFor = async (i: number): Promise<{ token: string; xff: string }> => {
    const made = (await broker.dispatch({ op: "gateway_token_add", name: `w1c-g${i}`, mayMessage: [] })).result as { token: string };
    return { token: made.token, xff: `198.51.100.${100 + i}` };
  };
  const creds = await Promise.all(Array.from({ length: 130 }, (_, i) => authFor(i)));
  const poll = (c: { token: string; xff: string }) =>
    raw(pub, "/mcp", {
      method: "POST",
      headers: { ...MHD, authorization: `Bearer ${c.token}`, "x-forwarded-for": c.xff, ...close },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_message", arguments: { timeout_seconds: 10 } } }),
    }).then((r) => r.status, () => -1);
  const statuses: number[] = [];
  const refused = () => statuses.filter((s) => s === 503).length;
  const held = creds.map((c) => poll(c).then((s) => void statuses.push(s)));
  try {
    const end = Date.now() + 8000;
    while (refused() < 2 && Date.now() < end) await sleep(50);
    await sleep(300);
    assert.equal(refused(), 2, "exactly the two polls past the 128 budget are refused");
    const extra = await raw(pub, "/mcp", {
      method: "POST",
      headers: { ...MHD, authorization: `Bearer ${creds[0]!.token}`, "x-forwarded-for": creds[0]!.xff, ...close },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_inbox", arguments: {} } }),
    });
    assert.equal(extra.status, 503, "a further request while the budget is held is refused");
  } finally {
    await Promise.all(held);
  }
});

test("a short request timeout spares polls but cuts stalled non-poll requests", async () => {
  process.env.AGENTSOCKS_GATEWAY_REQUEST_MS = "400";
  process.env.AGENTSOCKS_GATEWAY_BODY_MS = "6000";
  try {
    const made = (await broker.dispatch({ op: "gateway_token_add", name: "w1c-pollspared", mayMessage: [] })).result as { token: string };
    const poll = await raw(pub, "/mcp", {
      method: "POST",
      headers: { ...MHD, authorization: `Bearer ${made.token}`, "x-forwarded-for": "198.51.100.9", ...close },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_message", arguments: { timeout_seconds: 1 } } }),
    });
    assert.equal(poll.status, 200, "poll routes survive the non-poll request timeout");
    const fast = await raw(pub, "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9", ...close },
      body: JSON.stringify({ client_name: "w1c-fast", redirect_uris: ["https://fast.example/cb"] }),
    });
    assert.ok(fast.status === 201 || fast.status === 400, "a fast non-poll request is answered, not cut");
    const port = Number(new URL(pub).port);
    const cut = await new Promise<string>((resolve) => {
      const s = createConnection({ host: "127.0.0.1", port });
      let got = "";
      s.setEncoding("utf8");
      s.on("data", (d: string) => {
        got += d;
      });
      s.on("connect", () => s.write("POST /oauth/token HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 400\r\nConnection: close\r\n\r\ngrant"));
      s.on("close", () => resolve(got.includes("HTTP/") ? `answered ${got.split("\r\n")[0]}` : "destroyed"));
      s.on("error", () => resolve(got.includes("HTTP/") ? `answered ${got.split("\r\n")[0]}` : "destroyed"));
      setTimeout(() => {
        const open = !s.destroyed;
        s.destroy();
        resolve(open ? "open" : "destroyed");
      }, 2500).unref();
    });
    assert.equal(cut, "destroyed", "a stalled non-poll request is cut at the request timeout instead of held for the body deadline");
  } finally {
    delete process.env.AGENTSOCKS_GATEWAY_REQUEST_MS;
    delete process.env.AGENTSOCKS_GATEWAY_BODY_MS;
  }
});

interface R14BudgetBooks {
  requestedConns: Map<string, number>;
}

test("one flooding source is refused without starving another source", async () => {
  const probe = (xff: string) => raw(pub, "/.well-known/oauth-authorization-server", { headers: { "x-forwarded-for": xff, ...close } }).then((r) => r.status, () => -1);
  const denials = (await Promise.all(Array.from({ length: 300 }, () => probe("198.51.100.21")))).filter((s) => s === 429 || s === 503).length;
  assert.ok(denials > 0, "the flood exceeds its per-source budget");
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => probe("198.51.100.22"))), [200, 200, 200, 200, 200], "another source still passes");
  const port = Number(new URL(pub).port);
  const creds: { token: string; xff: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const made = (await broker.dispatch({ op: "gateway_token_add", name: `w1c-r14hold${i}`, mayMessage: [] })).result as { token: string };
    creds.push({ token: made.token, xff: `198.51.100.${31 + i}` });
  }
  const held = creds.flatMap(({ token, xff }) =>
    Array.from({ length: 32 }, () =>
      raw(pub, "/mcp", {
        method: "POST",
        headers: { ...MHD, authorization: `Bearer ${token}`, "x-forwarded-for": xff, ...close },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_message", arguments: { timeout_seconds: 3 } } }),
      }).then((r) => r.status, () => -1),
    ),
  );
  const books: R14BudgetBooks = gatewayOf(broker) as unknown as R14BudgetBooks;
  for (let i = 0; i < 50 && (books.requestedConns.get("public") ?? 0) < 128; i++) await sleep(100);
  const overStatus = await rawSocket(port, "GET /.well-known/oauth-authorization-server HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 198.51.100.31\r\nConnection: close\r\n\r\n");
  assert.match(overStatus, /^HTTP\/1\.1 503/, "a source past its per-source cap is refused while the budget is held");
  const overBody = await raw(pub, "/.well-known/oauth-authorization-server", { headers: { "x-forwarded-for": "198.51.100.31", ...close } }).then((r) => r.text, () => "");
  assert.match(overBody, /from this source/, "the per-source cap is checked before the global budget");
  const freshStatus = await rawSocket(port, "GET /.well-known/oauth-authorization-server HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 198.51.100.35\r\nConnection: close\r\n\r\n");
  assert.match(freshStatus, /^HTTP\/1\.1 503/, "a new source is refused while every connection is busy");
  await Promise.all(held);
});
