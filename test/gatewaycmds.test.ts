import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { root } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { cat } from "./fakes.ts";
import { tempDir } from "./tmp.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker();
const shim = join(root, "tailscale-cmds.sh");
const shimLog = join(root, "tailscale-cmds.log");

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
const AGENT = { CODEX_THREAD_ID: "thread-cmds-agent" };

before(async () => {
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(shimLog)}\n`);
  chmodSync(shim, 0o755);
  await broker.start();
});

after(async () => {
  await broker.stop();
});

test("a token is printed once with how to send it, and neither status nor list shows it again", async () => {
  const made = await run(["gateway", "token", "add", "grok", "--may-message", "api-worker", "codex-web"]);
  assert.equal(made.code, 0, made.err);
  const token = /^ {2}(agk_[0-9a-f]{8}_[A-Za-z0-9_-]{43})$/m.exec(made.out)![1]!;
  const id = /\(id ([0-9a-f]{8})\)/.exec(made.out)![1]!;
  assert.match(made.out, /It may message: api-worker, codex-web\./);
  assert.match(made.out, /Authorization: Bearer <token>.*\?key=<token>/);
  const status = await run(["gateway", "status"]);
  assert.match(status.out, new RegExp(`${id} {2}grok`));
  assert.ok(!status.out.includes(token));
  const list = await run(["gateway", "token", "list"]);
  assert.match(list.out, new RegExp(id));
  assert.ok(!list.out.includes(token));
  const revoked = await run(["gateway", "token", "revoke", id]);
  assert.match(revoked.out, new RegExp(`revoked ${id}`));
  assert.equal((await run(["gateway", "token", "revoke", id])).code, 1);
});

test("a token with no --may-message may message nobody, and gateway may changes the list afterwards", async () => {
  const made = await run(["gateway", "token", "add", "quiet-one"]);
  assert.match(made.out, /It may message: nobody/);
  const set = await run(["gateway", "may", "quiet-one", "alpha", "beta"]);
  assert.match(set.out, /quiet-one may now message: alpha, beta\./);
  assert.match((await run(["gateway", "may", "quiet-one"])).out, /may now message: nobody/);
  assert.match((await run(["gateway", "may", "nobody-by-that-name", "alpha"])).err, /no remote peer named nobody-by-that-name/);
  assert.match((await run(["gateway", "token", "add", "bad<name>"])).err, /a peer name is 1 to 48/);
});

test("pair chatgpt prints a six-digit code that lasts ten minutes and works once", async () => {
  const r = await run(["gateway", "pair", "chatgpt", "--may-message", "api-worker"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /pairing code for chatgpt: \d{6}\n/);
  assert.match(r.out, /works once and expires in 10 minutes/);
  assert.match(r.out, /may message: api-worker/);
  assert.match((await run(["gateway", "pair", "gemini"])).err, /usage: agentsocks gateway pair chatgpt/);
});

test("gateway public prints the exposure command and runs nothing without --yes, and runs only the funnel command with it", async () => {
  const printed = await run(["gateway", "public", "--via", "funnel", "--port", "0"]);
  assert.equal(printed.code, 0, printed.err);
  const port = /public listener is on 127\.0\.0\.1:(\d+)/.exec(printed.out)![1]!;
  assert.match(printed.out, new RegExp(`  tailscale funnel --bg --https=8443 http://127\\.0\\.0\\.1:${port}\\n`));
  assert.match(printed.out, /makes the public listener reachable by anyone on the internet who has a token or the pairing code/);
  assert.match(printed.out, /agentsocks will not run it without --yes/);
  assert.equal(invoked(), "");
  const yes = await run(["gateway", "public", "--via", "funnel", "--port", "0", "--yes"]);
  assert.equal(yes.code, 0, yes.err);
  assert.match(invoked(), /^funnel --bg --https=8443 http:\/\/127\.0\.0\.1:\d+\n$/);
  const before = invoked();
  const cf = await run(["gateway", "public", "--via", "cloudflared", "--port", "0", "--yes"]);
  assert.match(cf.out, /cloudflared tunnel --url http:\/\/127\.0\.0\.1:\d+/);
  assert.match(cf.out, /does not start long-running tunnels for you/);
  assert.equal(invoked(), before, "cloudflared is never run by agentsocks");
  const off = await run(["gateway", "public", "off"]);
  assert.match(off.out, /public listener is stopped/);
  assert.equal(((JSON.parse((await run(["gateway", "status", "--json"])).out) as { public: { listening: boolean } }).public.listening), false);
  assert.match((await run(["gateway", "public"])).err, /usage: agentsocks gateway public --via funnel\|cloudflared/);
});

test("every command that sets up access or credentials refuses to be run by an agent, and the ones that only look or undo still work", async () => {
  const refused: string[][] = [
    ["gateway", "public", "--via", "funnel"],
    ["gateway", "token", "add", "agentmade"],
    ["gateway", "pair", "chatgpt"],
    ["gateway", "allow", "somebox"],
    ["gateway", "may", "grok", "alpha"],
    ["link", "somebox"],
    ["peer", "add", "grok", "--api", "xai", "--may-message", "alpha"],
  ];
  for (const args of refused) {
    const r = await run(args, AGENT);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, /is for you to run in your own terminal/, args.join(" "));
  }
  for (const args of [["gateway", "status"], ["gateway", "routes"], ["link"], ["peer", "list"]]) assert.equal((await run(args, AGENT)).code, 0, args.join(" "));
});

test("gateway allow and link say what is needed on the other machine, and list what is linked", async () => {
  const allow = await run(["gateway", "allow", "hetzner-lab"]);
  assert.match(allow.out, /hetzner-lab may link to this machine's gateway/);
  assert.match((await run(["gateway", "allow", "not a host"])).err, /give the machine's tailnet name/);
  const status = await run(["gateway", "status"]);
  assert.match(status.out, /hetzner-lab {2}allowed to link here/);
  assert.match((await run(["gateway", "disallow", "hetzner-lab"])).out, /may no longer link/);
  assert.match((await run(["link"])).out, /No machines are linked\./);
  assert.match((await run(["link", "ftp://x"])).err, /give the machine's tailnet name/);
});

test("peer add names the peer with (api), says what each answer costs, never prints the key, and peer remove stops it", async () => {
  const keyFile = join(tempDir("agentsocks-cmdkey-"), "xai.env");
  const KEY = cat("xai-", "cmdKEY9876543210zyxwvutsrqponmlkjihgfedcba");
  writeFileSync(keyFile, `XAI_API_KEY=${KEY}\n`, { mode: 0o600 });
  assert.match((await run(["peer", "add", "grok", "--api", "xai", "--key-file", keyFile])).err, /say who it may message/);
  assert.match((await run(["peer", "add", "grok", "--api", "mistral", "--may-message", "alpha"])).err, /usage: agentsocks peer add/);
  const added = await run(["peer", "add", "grok", "--api", "xai", "--key-file", keyFile, "--may-message", "alpha", "--base-url", "http://127.0.0.1:9/v1", "--max-calls-per-hour", "5"]);
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /added grok \(api\): xai grok-4 at http:\/\/127\.0\.0\.1:9\/v1\./);
  assert.match(added.out, /Each answer takes one to six paid API calls, at most 5 calls an hour\./);
  assert.match(added.out, new RegExp(`Its key is read from ${keyFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} each time`));
  assert.ok(!added.out.includes(KEY) && !added.err.includes(KEY));
  const list = await run(["peer", "list"]);
  assert.match(list.out, /grok \(api\) {2}xai grok-4, may message alpha, at most 5 calls an hour/);
  assert.ok(!list.out.includes(KEY));
  const removed = await run(["peer", "remove", "grok"]);
  assert.match(removed.out, /removed grok \(api\)\. It makes no more API calls\./);
  assert.match((await run(["peer", "list"])).out, /No API peers\./);
});
