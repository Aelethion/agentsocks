import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import "./support.ts";
import { Broker } from "../src/broker.ts";
import { gateway as gatewayCommand } from "../src/commands/gateway.ts";
import { authenticateTailnet } from "../src/gateway/auth.ts";
import { offCallTimeoutMs, tailscaleTimeoutCapMs, tailscaleTimeoutMs } from "../src/gateway/expose.ts";
import { gatewayOf } from "../src/gateway/runtime.ts";
import { uninstallGatewayState } from "../src/install.ts";
import { tempDir } from "./tmp.ts";

const broker = new Broker();
const defaultBin = process.env.AGENTSOCKS_TAILSCALE_BIN;

function shim(body: string): { calls: string } {
  const dir = tempDir("w1g-lows-");
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

const call = async <T>(op: string, args: Record<string, unknown> = {}): Promise<T> => (await broker.dispatch({ op, ...args })).result as T;

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

const offCalls = (calls: string): string[] =>
  !existsSync(calls) ? [] : readFileSync(calls, "utf8").split("\n").filter((l) => l.includes("off"));

before(async () => {
  await broker.start();
});

after(async () => {
  await broker.stop();
  unshim();
});

test("gateway off through the CLI waits out serve-off plus funnel-off back to back", async () => {
  process.env.AGENTSOCKS_TAILSCALE_TIMEOUT_MS = "4000";
  const { calls } = shim("sleep 3\nexit 0");
  try {
    await call("gateway_on", { port: 0 });
    await call("gateway_public", { via: "funnel", port: 0 });
    const gw = gatewayOf(broker);
    gw.savePrivate({ ...gw.privateSettings(), enabled: true, served: true });
    gw.savePublic({ ...gw.publicSettings(), enabled: true, exposed: true });
    const { value, out } = await quiet(() => gatewayCommand(["off"], "agentsocks gateway"));
    assert.equal(value, 0, "two 3 s off commands outlast the old 5 s default; the pinned budget waits them out");
    assert.match(out, /stopped/);
    assert.equal(offCalls(calls).length, 2, "the broker ran serve-off and funnel-off; the CLI ran neither");
    assert.equal(gw.privateSettings().served, false, "a clean serve-off clears served");
    assert.equal(gw.publicSettings().exposed, false, "a clean funnel-off clears exposed");
  } finally {
    unshim();
  }
});

test("broker-up uninstall waits out the same back-to-back off commands", async () => {
  process.env.AGENTSOCKS_TAILSCALE_TIMEOUT_MS = "4000";
  shim("sleep 3\nexit 0");
  try {
    await call("gateway_on", { port: 0 });
    await call("gateway_public", { via: "funnel", port: 0 });
    const gw = gatewayOf(broker);
    gw.savePrivate({ ...gw.privateSettings(), enabled: true, served: true });
    gw.savePublic({ ...gw.publicSettings(), enabled: true, exposed: true });
    const lines = await uninstallGatewayState(false);
    const text = lines.join("\n");
    assert.equal(lines.failed, undefined, "slow but clean off commands are reported, not fatal");
    assert.match(text, /undid the tailscale serve/, "uninstall names the undone serve");
    assert.match(text, /undid the tailscale funnel/, "uninstall names the undone funnel");
    assert.equal(gw.privateSettings().served, false, "a clean serve-off clears served");
    assert.equal(gw.publicSettings().exposed, false, "a clean funnel-off clears exposed");
  } finally {
    unshim();
  }
});

test("a small one-environment knob cannot shrink the CLI bound", async () => {
  assert.equal(tailscaleTimeoutMs(), 30_000, "the default tailscale window is 30 s");
  assert.equal(offCallTimeoutMs(), tailscaleTimeoutCapMs * 2 + 5_000, "the CLI bound covers two capped windows plus slack");
  process.env.AGENTSOCKS_TAILSCALE_TIMEOUT_MS = "4000";
  try {
    assert.equal(tailscaleTimeoutMs(), 4_000, "a small knob still narrows one tailscale window");
    assert.equal(offCallTimeoutMs(), 605_000, "but the CLI bound stays at the maximum");
  } finally {
    delete process.env.AGENTSOCKS_TAILSCALE_TIMEOUT_MS;
  }
  process.env.AGENTSOCKS_TAILSCALE_TIMEOUT_MS = "2000000";
  try {
    assert.equal(tailscaleTimeoutMs(), tailscaleTimeoutCapMs, "a large knob never widens one window past the cap");
    assert.equal(offCallTimeoutMs(), 605_000, "so the bound always covers the broker's worst case");
  } finally {
    delete process.env.AGENTSOCKS_TAILSCALE_TIMEOUT_MS;
  }
});

test("tailnet auth takes a plain checks object with no trust hook", async () => {
  const tailnet = {
    whois: async (ip: string) => (ip === "100.64.0.21" ? { login: "sam@example.com", displayName: "sam", node: "laptop", nodeId: "n-laptop", os: "linux", tagged: false } : undefined),
    self: async () => ({ login: "sam@example.com", dnsName: "mybox.tail99.ts.net" }),
  };
  const req = { headers: { "tailscale-user-login": "sam@example.com", "x-forwarded-for": "100.64.0.21" } } as unknown as IncomingMessage;
  const id = await authenticateTailnet(req, { tailnet, extraLogins: () => [] });
  assert.equal(id.login, "sam@example.com", "the owner is still let in with no trustSource on the checks");
  assert.equal(id.nodeId, "n-laptop");
});
