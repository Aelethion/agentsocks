import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./support.ts";
import { localTailnet, parseSelf, parseWhois, socketCandidates, whoisAddress } from "../src/gateway/tailscale.ts";
import { fakeLocalApi, statusJson, whoisJson } from "./gatewaysupport.ts";
import { tempDir } from "./tmp.ts";

const PHONE = { name: "iphone-14", login: "sam@example.com", ip: "100.64.5.5", os: "iOS" };

function shim(answers: { whois?: unknown; status?: unknown; fail?: boolean }): { bin: string; calls: () => string[] } {
  const dir = tempDir("agentsocks-tsshim-");
  const bin = join(dir, "tailscale");
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "whois.json"), JSON.stringify(answers.whois ?? {}));
  writeFileSync(join(dir, "status.json"), JSON.stringify(answers.status ?? {}));
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n${answers.fail ? "exit 1\n" : `case "$1" in whois) cat ${JSON.stringify(join(dir, "whois.json"))};; status) cat ${JSON.stringify(join(dir, "status.json"))};; esac\n`}`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

test("whois and status answers are read into a login, a short node name, a stable id, whether it is tagged, and the owner's name", () => {
  const who = parseWhois(whoisJson(PHONE));
  assert.deepEqual(who, { login: "sam@example.com", displayName: "sam", node: "iphone-14", nodeId: "n-iphone-14", os: "iOS", tagged: false });
  assert.equal(parseWhois(whoisJson({ ...PHONE, tags: ["tag:ci"] }))?.tagged, true);
  assert.equal(parseWhois({ Node: {}, UserProfile: {} }), undefined);
  assert.equal(parseWhois("nope"), undefined);
  assert.deepEqual(parseSelf(statusJson("sam@example.com", "devbox.tail1234.ts.net")), { login: "sam@example.com", dnsName: "devbox.tail1234.ts.net" });
  assert.equal(parseSelf({ Self: { UserID: 9, DNSName: "x.ts.net." }, User: {} }), undefined);
});

test("the address LocalAPI is asked about carries a port, in brackets for IPv6, and socket candidates start with TS_SOCKET", () => {
  assert.equal(whoisAddress("100.64.0.2"), "100.64.0.2:0");
  assert.equal(whoisAddress("fd7a:115c:a1e0::1"), "[fd7a:115c:a1e0::1]:0");
  assert.deepEqual(socketCandidates({ TS_SOCKET: "/x/ts.sock" }).slice(0, 1), ["/x/ts.sock"]);
  assert.ok(socketCandidates({}).includes("/var/run/tailscale/tailscaled.sock"));
});

test("without a LocalAPI socket the tailscale command is asked, and its answer is cached", async () => {
  const s = shim({ whois: whoisJson(PHONE), status: statusJson("sam@example.com", "devbox.tail1234.ts.net") });
  const tailnet = localTailnet({ sockets: () => [], bin: () => s.bin });
  assert.equal((await tailnet.whois("100.64.5.5"))?.node, "iphone-14");
  assert.equal((await tailnet.whois("100.64.5.5"))?.node, "iphone-14");
  assert.deepEqual(s.calls(), ["whois --json 100.64.5.5"], "asked once");
  assert.deepEqual(await tailnet.self(), { login: "sam@example.com", dnsName: "devbox.tail1234.ts.net" });
  assert.deepEqual(s.calls().slice(1), ["status --json --peers=false"]);
});

test("LocalAPI is preferred, and a LocalAPI 404 denies without falling back to the command", async () => {
  const api = await fakeLocalApi();
  const s = shim({ whois: whoisJson(PHONE) });
  try {
    api.machines.set("100.64.5.6", { ...PHONE, ip: "100.64.5.6", name: "known-to-api" });
    const tailnet = localTailnet({ sockets: () => [api.socketPath], bin: () => s.bin });
    assert.equal((await tailnet.whois("100.64.5.6"))?.node, "known-to-api");
    assert.deepEqual(s.calls(), [], "the command was not needed");
    assert.equal(await tailnet.whois("100.64.5.7"), undefined, "a definitive LocalAPI 404 denies without CLI fallback");
    assert.deepEqual(s.calls(), [], "the command is never asked after a 404");
  } finally {
    await api.close();
  }
});

test("when nothing can answer, the caller is unknown and nothing is guessed; a bad address is not even asked about", async () => {
  const s = shim({ fail: true });
  const tailnet = localTailnet({ sockets: () => [], bin: () => s.bin });
  assert.equal(await tailnet.whois("100.64.5.9"), undefined);
  assert.equal(await tailnet.self(), undefined);
  const calls = s.calls().length;
  assert.equal(await tailnet.whois("not-an-ip"), undefined);
  assert.equal(await tailnet.whois("100.64.5.9; rm -rf /"), undefined);
  assert.equal(s.calls().length, calls);
  assert.equal(await localTailnet({ sockets: () => [], bin: () => join(tempDir("agentsocks-none-"), "missing") }).whois("100.64.5.9"), undefined);
});

test("when the status has no user table, the owner is the user of this node's own address", async () => {
  const noUsers = { Self: { UserID: 7, DNSName: "devbox.tail1234.ts.net.", TailscaleIPs: ["100.64.5.1", "fd7a::1"] }, User: {} };
  const s = shim({ whois: whoisJson({ name: "devbox", login: "sam@example.com", ip: "100.64.5.1" }), status: noUsers });
  const tailnet = localTailnet({ sockets: () => [], bin: () => s.bin });
  assert.deepEqual(await tailnet.self(), { login: "sam@example.com", dnsName: "devbox.tail1234.ts.net" });
  const tagged = shim({ whois: whoisJson({ name: "devbox", login: "tagged-devices", ip: "100.64.5.1", tags: ["tag:server"] }), status: noUsers });
  assert.equal(await localTailnet({ sockets: () => [], bin: () => tagged.bin }).self(), undefined, "a tagged node has no owner to fall back to");
});
