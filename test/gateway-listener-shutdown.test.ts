import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Agent, createServer, request, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { sleep } from "./support.ts";
import { tempDir } from "./tmp.ts";
import { Broker } from "../src/broker.ts";
import { Gateway } from "../src/gateway/runtime.ts";
import { gatewayState } from "../src/gateway/state.ts";
import { runCommand } from "../src/gateway/expose.ts";
import { sourceCheck } from "../src/gateway/source.ts";

const broker = new Broker();
const OWNER = "sam@example.com";
const noTailnet = { whois: async () => undefined, self: async () => undefined };
const homeTailnet = { whois: async () => undefined, self: async () => ({ login: OWNER, dnsName: "mybox.tail99.ts.net" }) };
before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
});

const shim = (body: string): string => {
  const path = join(tempDir("agentsocks-w1e-"), "shim.sh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

const refused = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    sock.once("connect", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(true));
  });

test("a source-check refusal closes the connection instead of leaving it in keep-alive", async () => {
  const gw = new Gateway(broker, homeTailnet);
  gw.savePrivate({ enabled: true, port: 0, served: false });
  await gw.reconcile();
  const port = gw.port("private")!;
  const uid = process.getuid!();
  const original = gw.source;
  Object.defineProperty(gw, "source", { value: sourceCheck({ platform: "linux", ownUid: uid, expectedUid: () => uid + 1 }), configurable: true });
  const agent = new Agent({ keepAlive: true });
  try {
    const { status, socket } = await new Promise<{ status: number; socket: Socket | null }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/mcp", agent }, (res) => {
        res.resume();
        res.once("end", () => resolve({ status: res.statusCode ?? 0, socket: req.socket }));
      });
      req.once("error", reject);
      req.end("{}");
    });
    assert.equal(status, 403, "forged direct loopback request refused at admission");
    assert.ok(socket, "the refused request travelled on a socket");
    await new Promise<void>((resolve, reject) => {
      if (socket.destroyed) return resolve();
      // Real clock: the close must arrive from the platform socket, which fake timers cannot produce.
      socket.once("close", () => resolve());
      setTimeout(() => reject(new Error("the refused socket lingered in keep-alive instead of closing")), 2000).unref();
    });
  } finally {
    Object.defineProperty(gw, "source", { value: original, configurable: true });
    agent.destroy();
    await gw.stop();
  }
});

test("gateway off closes the listener before the tailscale serve-off finishes", async () => {
  const gw = new Gateway(broker, homeTailnet);
  gw.savePrivate({ enabled: true, port: 0, served: true });
  await gw.reconcile();
  const port = gw.port("private")!;
  const mark = join(tempDir("agentsocks-w1e-"), "serve-off-ran");
  const prior = process.env.AGENTSOCKS_TAILSCALE_BIN;
  process.env.AGENTSOCKS_TAILSCALE_BIN = shim(`touch ${JSON.stringify(mark)}\nsleep 2`);
  try {
    const done = gw.shutdown("gateway off");
    // Real clock: probes mid-shutdown while a live subprocess sleeps, which fake timers cannot stage.
    await sleep(300);
    assert.equal(await refused(port), true, "the private listener stops accepting while serve-off is still running");
    const summary = await done;
    assert.equal(summary.serveUndone, true, "the slow serve-off still ran to completion");
  } finally {
    if (prior === undefined) delete process.env.AGENTSOCKS_TAILSCALE_BIN;
    else process.env.AGENTSOCKS_TAILSCALE_BIN = prior;
    await gw.stop();
  }
});

test("a hung tailscale command does not hang runCommand forever", async () => {
  const env = {
    ...process.env,
    AGENTSOCKS_TAILSCALE_BIN: shim("exec sleep 30"),
    AGENTSOCKS_TAILSCALE_TIMEOUT_MS: "300",
  };
  const start = Date.now();
  const code = await Promise.race([
    runCommand(["tailscale", "serve", "--https=443", "http://127.0.0.1:9", "off"], env),
    // Real clock: exercises a live subprocess kill deadline, which fake timers cannot fire.
    sleep(5000).then((): string => "hung"),
  ]);
  assert.notEqual(code, "hung", "runCommand returns even when the tailscale CLI never exits");
  assert.notEqual(code, 0, "a killed command reports failure");
  assert.ok(Date.now() - start < 5000, "the timeout bounds the wait");
});

test("the unknown-own-name guard holds for an undotted machine name", async () => {
  const gw = new Gateway(broker, noTailnet);
  try {
    await assert.rejects(gw.federation.handshake("https://evil"), /tailnet/, "refusal names the missing tailnet domain");
    assert.equal(gatewayState(broker.store).host("evil"), undefined, "the undotted name is not recorded");
  } finally {
    await gw.federation.stop();
  }
});

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
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") throw new Error("stub server has no port");
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });

test("a loopback claim outside the machine-name charset is refused", async () => {
  const stub = await stubPeers("Hetzner-Lab/x");
  const gw = new Gateway(broker, homeTailnet);
  try {
    await assert.rejects(gw.federation.handshake(stub.url), /machine name/, "Hetzner-Lab/x never becomes a host");
    const proxies = gatewayState(broker.store).listPeers().filter((p) => p.id.startsWith("fed:hetzner-lab/x/"));
    assert.equal(proxies.length, 0, "no proxy is recorded under the dirty claim");
  } finally {
    await gw.federation.stop();
    await stub.close();
  }
  const sane = await stubPeers("Hetzner-Lab");
  try {
    const { host } = await gw.federation.handshake(sane.url);
    assert.equal(host, "hetzner-lab", "a charset-clean claim still links, lowercased");
  } finally {
    await gw.federation.stop();
    await sane.close();
  }
});
