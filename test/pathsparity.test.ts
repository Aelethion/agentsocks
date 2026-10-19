import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import * as current from "../src/paths.ts";
import * as v020 from "./reference/paths-v0.2.0.ts";

const UID = 54321;
const STD = `/run/user/${UID}`;
const THREAD = "019a5f2e-7c3b-7d11-9a42-0123456789ab";

interface Host {
  env?: Record<string, string>;
  present?: string[];
}

function onHost<T>(host: Host, run: () => T): T {
  const saved = { env: { ...process.env }, getuid: process.getuid, lstatSync: fs.lstatSync, platform: Object.getOwnPropertyDescriptor(process, "platform")! };
  const present = new Set(host.present ?? []);
  const lstat = (path: fs.PathLike) => {
    if (!present.has(String(path))) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return { isDirectory: () => true, isSymbolicLink: () => false, uid: UID, mode: 0o40700 };
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { HOME: "/home/tester", ...host.env });
  process.getuid = () => UID;
  Object.defineProperty(process, "platform", { value: "linux" });
  Object.assign(fs, { lstatSync: lstat });
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
    process.getuid = saved.getuid;
    Object.defineProperty(process, "platform", saved.platform);
    Object.assign(fs, { lstatSync: saved.lstatSync });
    syncBuiltinESMExports();
  }
}

type Paths = Pick<typeof current, "runtimeDir" | "brokerSocketPath" | "threadSocketPath" | "codexHexName" | "ccSocksDir" | "namespacedSocketPath" | "stateDir" | "dbPath" | "claudeSessionsDir" | "configPath" | "inboxKind">;

function dump(paths: Paths): Record<string, string | undefined> {
  const namespaced = paths.namespacedSocketPath(THREAD);
  return {
    runtimeDir: paths.runtimeDir(),
    brokerSocketPath: paths.brokerSocketPath(),
    threadSocketPath: paths.threadSocketPath(THREAD),
    codexHexName: paths.codexHexName(THREAD),
    ccSocksDir: paths.ccSocksDir(),
    namespacedSocketPath: namespaced,
    stateDir: paths.stateDir(),
    dbPath: paths.dbPath(),
    claudeSessionsDir: paths.claudeSessionsDir(),
    configPath: paths.configPath(),
    inboxOfThread: paths.inboxKind(paths.threadSocketPath(THREAD)),
    inboxOfNamespaced: namespaced && paths.inboxKind(namespaced),
  };
}

const bytes = (path: string): number => Buffer.byteLength(path);
const xdgOfLength = (n: number): string => `${STD}/`.padEnd(n, "a");
const brokerAt = (xdg: string): string => join(xdg, "agentsocks", "broker.sock");
const BROKER_SUFFIX = bytes("/agentsocks/broker.sock");

const sameAsV020: [string, Host][] = [
  ["XDG_RUNTIME_DIR is the standard directory, with Claude's cc-socks beside it", { env: { XDG_RUNTIME_DIR: STD }, present: [STD, `${STD}/cc-socks`] }],
  ["XDG_RUNTIME_DIR with a trailing slash", { env: { XDG_RUNTIME_DIR: `${STD}/` }, present: [`${STD}/`, `${STD}/cc-socks`] }],
  ["XDG_RUNTIME_DIR unset and the standard directory present", { present: [STD, `${STD}/cc-socks`] }],
  ["XDG_RUNTIME_DIR unset, the standard directory present, TMPDIR set", { env: { TMPDIR: "/tmp/zz" }, present: [STD, `${STD}/cc-socks`] }],
  ["B: XDG_RUNTIME_DIR unset and the standard directory absent", {}],
  ["C2: XDG_RUNTIME_DIR unset, the standard directory absent, TMPDIR=/var/tmp/zz", { env: { TMPDIR: "/var/tmp/zz" } }],
  ["C2: the same with a TMPDIR deep enough that a thread socket would not fit", { env: { TMPDIR: `/var/tmp/${"z".repeat(70)}` } }],
  ["F: XDG_RUNTIME_DIR long enough that a thread socket cannot fit but the broker socket does", { env: { XDG_RUNTIME_DIR: xdgOfLength(107 - BROKER_SUFFIX) } }],
  ["AGENTSOCKS_RUNTIME_DIR overrides XDG_RUNTIME_DIR", { env: { XDG_RUNTIME_DIR: STD, AGENTSOCKS_RUNTIME_DIR: "/tmp/ar" }, present: [STD, `${STD}/cc-socks`] }],
  ["AGENTSOCKS_RUNTIME_DIR with AGENTSOCKS_CCSOCKS_DIR", { env: { XDG_RUNTIME_DIR: STD, AGENTSOCKS_RUNTIME_DIR: "/tmp/ar", AGENTSOCKS_CCSOCKS_DIR: "/tmp/ar-cc" }, present: ["/tmp/ar-cc"] }],
  ["only AGENTSOCKS_RUNTIME_DIR", { env: { AGENTSOCKS_RUNTIME_DIR: "/tmp/ar-live" } }],
  ["XDG_STATE_HOME set", { env: { XDG_RUNTIME_DIR: STD, XDG_STATE_HOME: "/home/tester/.state" }, present: [STD, `${STD}/cc-socks`] }],
  ["AGENTSOCKS_STATE_DIR set", { env: { XDG_RUNTIME_DIR: STD, AGENTSOCKS_STATE_DIR: "/tmp/st" }, present: [STD, `${STD}/cc-socks`] }],
];

for (const [name, host] of sameAsV020) {
  test(`on Linux every path is what v0.2.0 gives: ${name}`, () => {
    assert.deepEqual(onHost(host, () => dump(current)), onHost(host, () => dump(v020)));
  });
}

test("the longest XDG_RUNTIME_DIR whose broker socket fits sun_path keeps v0.2.0's runtime directory", () => {
  const xdg = xdgOfLength(107 - BROKER_SUFFIX);
  assert.equal(bytes(brokerAt(xdg)), 107);
  assert.equal(onHost({ env: { XDG_RUNTIME_DIR: xdg } }, () => current.runtimeDir()), join(xdg, "agentsocks"));
});

for (const length of [108 - BROKER_SUFFIX, 90]) {
  test(`an XDG_RUNTIME_DIR of ${length} bytes, whose broker socket would not fit sun_path, falls back to /tmp/agentsocks-<uid>`, () => {
    const xdg = xdgOfLength(length);
    assert.ok(bytes(brokerAt(xdg)) > 107);
    const host = { env: { XDG_RUNTIME_DIR: xdg } };
    assert.equal(onHost(host, () => current.runtimeDir()), `/tmp/agentsocks-${UID}`);
    assert.equal(onHost(host, () => current.brokerSocketPath()), `/tmp/agentsocks-${UID}/broker.sock`);
    assert.equal(onHost(host, () => v020.runtimeDir()), join(xdg, "agentsocks"), "v0.2.0 kept the directory its broker could not bind in");
  });
}
