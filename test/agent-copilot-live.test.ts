import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import "./support.ts";
import { tempDir } from "./tmp.ts";

const LIVE_SKIP = process.platform === "linux" ? false : "the live scripts need GNU coreutils (timeout, setsid, sha256sum), so they run on Linux only";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/live/copilot.sh", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/agents/copilot/fake-copilot.mjs", import.meta.url));
const TOOLS = ["bash", "env", "sh", "grep", "sed", "tr", "cut", "sort", "uniq", "head", "tail", "wc", "cat", "printf", "mktemp", "mkdir", "rm", "touch", "kill", "sleep", "timeout", "cksum", "date", "chmod", "dirname", "basename", "tee", "ls", "cp", "mv"];

function sandbox(withCopilot: boolean): string {
  const bin = tempDir("agentsocks-livebin-");
  for (const tool of TOOLS) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found.startsWith("/")) symlinkSync(found, join(bin, tool));
  }
  symlinkSync(process.execPath, join(bin, "node"));
  if (withCopilot) {
    writeFileSync(join(bin, "copilot"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    chmodSync(join(bin, "copilot"), 0o755);
  }
  return bin;
}

interface Outcome {
  code: number;
  out: string;
  root: string;
}

async function live(extra: Record<string, string>, withCopilot = true): Promise<Outcome> {
  const env = {
    PATH: sandbox(withCopilot),
    HOME: tempDir("agentsocks-livehome-"),
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    FAKE_COPILOT_SLEEP_MS: "12000",
    COPILOT_LIVE_PEER_WAIT: "30",
    ...(process.env.NODE_OPTIONS && { NODE_OPTIONS: process.env.NODE_OPTIONS }),
    ...extra,
  };
  let code = 0;
  let out = "";
  try {
    out = (await exec("bash", [script], { env, timeout: 240_000 })).stdout;
  } catch (e) {
    const x = e as { code?: number; stdout?: string };
    code = typeof x.code === "number" ? x.code : 1;
    out = x.stdout ?? "";
  }
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  return { code, out, root: new RegExp(`root (${tmp}/asl-copilot-\\w+)`).exec(out)?.[1] ?? "" };
}

const lines = (o: Outcome, prefix: string): string[] => o.out.split("\n").filter((l) => l.startsWith(prefix));

function assertClean(o: Outcome): void {
  assert.ok(o.root, "the script announced its temp root");
  assert.equal(existsSync(o.root), false, "the temp root is removed");
  const ps = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout;
  assert.ok(!ps.includes(o.root), "no process of the script is left running");
}

test("the live script passes end to end against a Copilot CLI that follows the documented hook protocol, and cleans up after itself", { skip: LIVE_SKIP }, async () => {
  const o = await live({});
  assert.equal(o.code, 0, o.out);
  assert.match(o.out, /RESULT: PASS \(\d+ passed, 0 failed\) for copilot/);
  for (const check of [
    "install is wired",
    "copilot mcp list names the agentsocks server",
    "copilot started the agentsocks server and listed read_inbox",
    "copilot -p answers",
    "user-level hook files load and fire in -p mode",
    "our sessionStart hook registered",
    "our sessionEnd hook ended the thread",
    "the session registers",
    "the session read the message with read_inbox",
    "the answer contains the marker word",
    "the content-free notice reached the model",
    "the stamp rewrite applied",
    "the kill switch stops the integration",
    "uninstall left the user's own config byte-identical",
    "no agentsocks entry is left",
    "our hooks file is gone",
  ]) {
    assert.ok(lines(o, "PASS ").some((l) => l.includes(check)), `${check}\n${o.out}`);
  }
  assert.equal(lines(o, "FAIL").length, 0);
  assertClean(o);
});

test("a CLI that ignores modifiedArgs fails the stamp check and the read checks, and the failure says which tool names the hooks saw", { skip: LIVE_SKIP }, async () => {
  const o = await live({ FAKE_COPILOT_DROP_MODIFIED_ARGS: "1", FAKE_COPILOT_SLEEP_MS: "500" });
  assert.equal(o.code, 1, o.out);
  const failed = lines(o, "FAIL ").join("\n");
  assert.match(failed, /FAIL the stamp rewrite applied -- tool names the hooks saw: .*preToolUse:agentsocks-list_peers.*refusals in tool results: [1-9]/s);
  assert.match(failed, /FAIL the session read the message with read_inbox/);
  assert.ok(lines(o, "PASS ").some((l) => l.includes("our sessionStart hook registered")), "hooks themselves worked");
  assertClean(o);
});

test("a CLI that loads no hook files fails the hook-loading check with what it saw, and the script still finishes and cleans up", { skip: LIVE_SKIP }, async () => {
  const o = await live({ FAKE_COPILOT_NO_HOOKS: "1", FAKE_COPILOT_SLEEP_MS: "500", COPILOT_LIVE_PEER_WAIT: "5" });
  assert.equal(o.code, 1, o.out);
  assert.match(lines(o, "FAIL ").join("\n"), /FAIL user-level hook files load and fire in -p mode -- events seen: none/);
  assert.match(lines(o, "FAIL ").join("\n"), /FAIL our sessionStart hook registered/);
  assertClean(o);
});

test("without the copilot binary the script skips with exit 3 and starts nothing", { skip: LIVE_SKIP }, async () => {
  const o = await live({}, false);
  assert.equal(o.code, 3, o.out);
  assert.match(o.out, /SKIP copilot: copilot is not installed here/);
  assert.equal(existsSync(o.root), false);
});
