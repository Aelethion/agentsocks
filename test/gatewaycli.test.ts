import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { root } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { gatewayOf } from "../src/gateway/runtime.ts";
import { sourceCheck } from "../src/gateway/source.ts";
import { raw } from "./gatewaysupport.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker();
const shimLog = join(root, "tailscale-shim.log");
const shim = join(root, "tailscale-shim.sh");

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  try {
    const r = await exec(process.execPath, [cli, ...args], { env: { ...process.env, AGENTSOCKS_TAILSCALE_BIN: shim, ...env }, timeout: 30_000 });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}
const invoked = (): string => (existsSync(shimLog) ? readFileSync(shimLog, "utf8") : "");

before(async () => {
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(shimLog)}\n`);
  chmodSync(shim, 0o755);
  process.env.AGENTSOCKS_TAILSCALE_BIN = shim;
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("gateway on prints the tailscale serve command and a one-line description and runs nothing", async () => {
  const gateway = gatewayOf(broker);
  const original = gateway.source;
  Object.defineProperty(gateway, "source", { value: sourceCheck({ platform: "darwin", ownUid: 501, expectedUid: () => 0 }), configurable: true });
  const r = await run(["gateway", "on", "--port", "0", "--allow-unverified-local-source"]);
  assert.equal(r.code, 0, r.err);
  const port = /listening on 127\.0\.0\.1:(\d+)/.exec(r.out)![1]!;
  assert.match(r.out, new RegExp(`  tailscale serve --bg --https=443 http://127\\.0\\.0\\.1:${port}\\n`));
  assert.match(r.out, /makes this listener reachable over HTTPS by your own devices on your tailnet, and by nothing else/);
  assert.match(r.out, new RegExp(`Undo it with: tailscale serve --https=443 http://127\\.0\\.0\\.1:${port} off`));
  assert.equal(invoked(), "", "the command was only printed");
  assert.equal((await raw(`http://127.0.0.1:${port}`, "/nope")).status, 404, "and the listener is up");
  Object.defineProperty(gateway, "source", { value: original, configurable: true });
});

test("gateway status says what is listening and lists the remote peers", async () => {
  const r = await run(["gateway", "status"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /private listener +listening on 127\.0\.0\.1:\d+/);
  assert.match(r.out, /public listener +off/);
  assert.match(r.out, /kill switch +off/);
  const json = JSON.parse((await run(["gateway", "status", "--json"])).out) as { private: { listening: boolean }; peers: unknown[] };
  assert.equal(json.private.listening, true);
  assert.ok(Array.isArray(json.peers));
});

test("gateway off stops the listener and, when agentsocks did not set up serve, only prints how to undo it", async () => {
  const r = await run(["gateway", "off"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /stopped\. Nothing is listening/);
  assert.match(r.out, /If you ran tailscale serve for it yourself, undo it with: tailscale serve --https=443 http:\/\/127\.0\.0\.1:\d+ off/);
  assert.equal(invoked(), "");
  const status = JSON.parse((await run(["gateway", "status", "--json"])).out) as { private: { listening: boolean; wanted: boolean } };
  assert.deepEqual([status.private.listening, status.private.wanted], [false, false]);
});

test("gateway on --serve says what the command does, runs it, and gateway off undoes exactly that", async () => {
  const on = await run(["gateway", "on", "--port", "0", "--serve", "--allow-unverified-local-source"]);
  assert.equal(on.code, 0, on.err);
  const port = /listening on 127\.0\.0\.1:(\d+)/.exec(on.out)![1]!;
  assert.match(on.out, new RegExp(`Running: tailscale serve --bg --https=443 http://127\\.0\\.0\\.1:${port}\\nThis makes this listener reachable over HTTPS by your own devices on your tailnet, and by nothing else\\.`));
  assert.equal(invoked(), `serve --bg --https=443 http://127.0.0.1:${port}\n`);
  const off = await run(["gateway", "off"]);
  assert.equal(off.code, 0, off.err);
  assert.match(off.out, /Undoing the tailscale serve that agentsocks set up/);
  assert.equal(invoked(), `serve --bg --https=443 http://127.0.0.1:${port}\nserve --https=443 http://127.0.0.1:${port} off\n`);
});

test("a failing serve command leaves the gateway on loopback and says so", async () => {
  writeFileSync(shim, "#!/bin/sh\nexit 3\n");
  const on = await run(["gateway", "on", "--port", "0", "--serve", "--allow-unverified-local-source"]);
  assert.equal(on.code, 1);
  assert.match(on.err, /tailscale exited with 3; the gateway is still listening on 127\.0\.0\.1 only/);
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(shimLog)}\n`);
  await run(["gateway", "off"]);
});

test("an agent session cannot switch the gateway on, and a refused port is explained", async () => {
  const agent = await run(["gateway", "on", "--port", "0"], { CODEX_THREAD_ID: "thread-agent-1" });
  assert.equal(agent.code, 1);
  assert.match(agent.err, /agentsocks gateway on is for you to run in your own terminal/);
  const status = JSON.parse((await run(["gateway", "status", "--json"])).out) as { private: { listening: boolean } };
  assert.equal(status.private.listening, false);
  const bad = await run(["gateway", "on", "--port", "70000"]);
  assert.match(bad.err, /--port must be a whole number from 0 to 65535/);
});

test("gateway on refuses while the kill switch is on", async () => {
  const { mkdirSync, rmSync } = await import("node:fs");
  mkdirSync(join(root, "config", "agentsocks"), { recursive: true });
  const off = join(root, "config", "agentsocks", "off");
  writeFileSync(off, "");
  try {
    const r = await run(["gateway", "on", "--port", "0", "--allow-unverified-local-source"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /switched off on this machine \(kill switch\)/);
  } finally {
    rmSync(off, { force: true });
  }
});
