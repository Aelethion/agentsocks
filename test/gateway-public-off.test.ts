import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { gateway as gatewayCommand } from "../src/commands/gateway.ts";
import { offCallTimeoutMs, tailscaleTimeoutMs } from "../src/gateway/expose.ts";
import { gatewayOf } from "../src/gateway/runtime.ts";
import { uninstallGatewayState } from "../src/install.ts";
import { tempDir } from "./tmp.ts";

// These tests sleep through real tailscale hangs on purpose: they pin close
// ordering while an off command hangs, and client budgets against real
// subprocess kill timeouts, neither of which fake timers can drive.

const broker = new Broker();
const defaultBin = process.env.AGENTSOCKS_TAILSCALE_BIN;

function shim(body: string): { calls: string } {
  const dir = tempDir("w1f-off-");
  const bin = join(dir, "tailscale");
  const calls = join(dir, "calls.log");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n${body}\n`);
  chmodSync(bin, 0o755);
  process.env.AGENTSOCKS_TAILSCALE_BIN = bin;
  return { calls };
}

function unshim(): void {
  if (defaultBin === undefined) delete process.env.AGENTSOCKS_TAILSCALE_BIN;
  else process.env.AGENTSOCKS_TAILSCALE_BIN = defaultBin;
  delete process.env.AGENTSOCKS_TAILSCALE_TIMEOUT_MS;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const call = async <T>(op: string, args: Record<string, unknown> = {}): Promise<T> => (await broker.dispatch({ op, ...args })).result as T;

const funnelOffCalls = (calls: string): string[] =>
  !existsSync(calls) ? [] : readFileSync(calls, "utf8").split("\n").filter((l) => l.includes("funnel") && l.includes("off"));

const accepts = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });

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
  await broker.start();
});

after(async () => {
  await broker.stop();
  unshim();
});

test("gateway_public_off closes the public listener before funnel-off returns", async () => {
  const { calls } = shim("sleep 6\nexit 0");
  try {
    await call("gateway_on", { port: 0 });
    const pub = (await call<{ public: { port: number } }>("gateway_public", { via: "funnel", port: 0 })).public.port;
    const gw = gatewayOf(broker);
    gw.savePublic({ ...gw.publicSettings(), enabled: true, exposed: true });
    assert.equal(await accepts(pub), true, "the public listener answers first");
    const off = call("gateway_public_off");
    await sleep(2500);
    assert.equal(await accepts(pub), false, "the listener is closed while funnel-off still hangs");
    await off;
    assert.equal(gatewayOf(broker).publicSettings().exposed, false, "funnel-off succeeded after the wait");
    assert.equal(funnelOffCalls(calls).length, 1, "funnel-off ran once");
  } finally {
    unshim();
  }
});

test("gateway public off runs funnel-off once and says the flag is kept when it fails", async () => {
  const { calls } = shim("exit 1");
  try {
    await call("gateway_on", { port: 0 });
    await call("gateway_public", { via: "funnel", port: 0 });
    const gw = gatewayOf(broker);
    gw.savePublic({ ...gw.publicSettings(), enabled: true, exposed: true });
    const { value, out } = await quiet(() => gatewayCommand(["public", "off"], "agentsocks gateway"));
    assert.equal(value, 0);
    assert.match(out, /public listener is stopped/);
    assert.equal(funnelOffCalls(calls).length, 1, "the broker runs funnel-off; the CLI does not run it again");
    assert.match(out, /funnel-off command failed/, "the output names the off command that failed");
    assert.match(out, /exposed flag is kept/, "the output says the flag was kept");
    assert.equal(gw.publicSettings().exposed, true, "exposed survives a failed funnel-off");
  } finally {
    unshim();
  }
});

test("the public-off CLI waits out a slow tailscale instead of timing out first", async () => {
  const { calls } = shim("sleep 7\nexit 0");
  try {
    await call("gateway_on", { port: 0 });
    await call("gateway_public", { via: "funnel", port: 0 });
    const gw = gatewayOf(broker);
    gw.savePublic({ ...gw.publicSettings(), enabled: true, exposed: true });
    const { value, out } = await quiet(() => gatewayCommand(["public", "off"], "agentsocks gateway"));
    assert.equal(value, 0, "a 7 s tailscale outlasts the old 5 s broker-call default but the CLI still reports it");
    assert.match(out, /Undid the tailscale funnel/);
    assert.equal(funnelOffCalls(calls).length, 1);
  } finally {
    unshim();
  }
});

test("the off CLI waits out serve-off plus funnel-off back to back", async () => {
  process.env.AGENTSOCKS_TAILSCALE_TIMEOUT_MS = "6000";
  const { calls } = shim("sleep 30\nexit 0");
  try {
    await call("gateway_on", { port: 0 });
    await call("gateway_public", { via: "funnel", port: 0 });
    const gw = gatewayOf(broker);
    gw.savePublic({ ...gw.publicSettings(), enabled: true, exposed: true });
    const { value, out } = await quiet(() => gatewayCommand(["public", "off"], "agentsocks gateway"));
    assert.equal(value, 0, "a 6 s funnel-off outlasts the old 5 s default; the tailscale timeout bounds it instead");
    assert.match(out, /funnel-off command failed/);
    assert.match(out, /exposed flag is kept/);
    assert.equal(funnelOffCalls(calls).length, 1);
  } finally {
    unshim();
  }
});

test("the off-call budget covers two capped tailscale windows plus slack", async () => {
  assert.equal(tailscaleTimeoutMs(), 30_000, "the default tailscale window is 30 s");
  assert.equal(offCallTimeoutMs(), 605_000, "the CLI bound covers two capped windows plus slack");
  process.env.AGENTSOCKS_TAILSCALE_TIMEOUT_MS = "2000000";
  try {
    assert.equal(tailscaleTimeoutMs(), 300_000, "the knob never widens one tailscale window past the cap");
    assert.equal(offCallTimeoutMs(), 605_000, "a knob set in one environment cannot move the CLI bound");
  } finally {
    delete process.env.AGENTSOCKS_TAILSCALE_TIMEOUT_MS;
  }
});

test("gateway off names each failed off command and its kept flag", async () => {
  shim("exit 1");
  try {
    await call("gateway_on", { port: 0 });
    await call("gateway_public", { via: "funnel", port: 0 });
    const gw = gatewayOf(broker);
    gw.savePrivate({ ...gw.privateSettings(), enabled: true, served: true });
    gw.savePublic({ ...gw.publicSettings(), enabled: true, exposed: true });
    const { value, out } = await quiet(() => gatewayCommand(["off"], "agentsocks gateway"));
    assert.equal(value, 0);
    assert.match(out, /serve-off command failed/, "the output names the serve off command that failed");
    assert.match(out, /served flag is kept/, "the output says the served flag was kept");
    assert.match(out, /funnel-off command failed/, "the output names the funnel off command that failed");
    assert.match(out, /exposed flag is kept/, "the output says the exposed flag was kept");
    assert.equal(gw.privateSettings().served, true, "served survives");
    assert.equal(gw.publicSettings().exposed, true, "exposed survives");
  } finally {
    unshim();
  }
});

test("broker-up uninstall names each failed off command and its kept flag", async () => {
  shim("exit 1");
  try {
    await call("gateway_on", { port: 0 });
    await call("gateway_public", { via: "funnel", port: 0 });
    const gw = gatewayOf(broker);
    gw.savePrivate({ ...gw.privateSettings(), enabled: true, served: true });
    gw.savePublic({ ...gw.publicSettings(), enabled: true, exposed: true });
    const lines = await uninstallGatewayState(false);
    const text = lines.join("\n");
    assert.equal(lines.failed, undefined, "kept flags are reported, not fatal");
    assert.match(text, /serve-off command failed/, "the output names the serve off command that failed");
    assert.match(text, /served flag is kept/, "the output says the served flag was kept");
    assert.match(text, /funnel-off command failed/, "the output names the funnel off command that failed");
    assert.match(text, /exposed flag is kept/, "the output says the exposed flag was kept");
    assert.equal(gw.privateSettings().served, true, "served survives a failed uninstall off command");
    assert.equal(gw.publicSettings().exposed, true, "exposed survives a failed uninstall off command");
  } finally {
    unshim();
  }
});
