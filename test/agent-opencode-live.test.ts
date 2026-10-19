import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tempDir } from "./tmp.ts";
import { ownRunPids } from "./procs.ts";

const LIVE_SKIP = process.platform === "linux" ? false : "the live scripts need GNU coreutils (timeout, setsid, sha256sum), so they run on Linux only";

const repo = fileURLToPath(new URL("..", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/agents/opencode/fake-opencode.mjs", import.meta.url));
const zodV4 = join(dirname(createRequire(import.meta.url).resolve("zod/package.json")), "v4", "index.js");

function runScript(extra: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const bin = tempDir("agentsocks-fake-bin-");
  writeFileSync(join(bin, "opencode"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`);
  chmodSync(join(bin, "opencode"), 0o755);
  for (const other of ["claude", "codex"]) {
    writeFileSync(join(bin, other), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, other), 0o755);
  }
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: process.env.TMPDIR ?? "/tmp", ANTHROPIC_API_KEY: "not-a-real-key", FAKE_OPENCODE_ZOD: zodV4, ...(process.env.NODE_OPTIONS && { NODE_OPTIONS: process.env.NODE_OPTIONS }), ...extra };
  return new Promise((resolve) => {
    const child = spawn("bash", [join(repo, "scripts/live/opencode.sh")], { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 20_000).unref();
    }, 240_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const strays = () => ownRunPids((l) => l.includes("fake-opencode.mjs"));

test("the live script runs end to end against a fake OpenCode host that loads the generated plugin, and every check it prints passes", { skip: LIVE_SKIP, timeout: 280_000 }, async () => {
  const { code, out } = await runScript({});
  for (const name of [
    "install wrote the plugin with the agentsocks marker on its first line",
    "doctor reports the OpenCode integration wired",
    "the OpenCode session registered as a peer",
    "the first message was sent to the OpenCode session",
    "the turn read the inbox through agentsocks_read_inbox",
    "the model's final answer contains the marker word kumquat",
    "the content-free notice reached the model at the end of a tool result",
    "the broker woke the idle session",
    "the woken session read its inbox with nobody typing",
    "the session's own record holds the second message",
    "with the kill switch on, a send is refused",
    "with the kill switch off again, a send goes through",
    "uninstall removed the plugin file",
    "the user's own opencode.jsonc and plugins/mine.js are byte-identical",
    "doctor no longer reports the OpenCode integration wired",
  ]) assert.ok(out.includes(`PASS ${name}`), `missing PASS ${name}\n${out}`);
  assert.doesNotMatch(out, /^FAIL /m, out);
  assert.match(out, /RESULT: PASS \(16 passed, 0 failed\) for opencode/);
  assert.equal(code, 0);
  assert.deepEqual(strays(), [], "the script left nothing running");
});

test("the live script skips with exit 3 when it has no model credential", { skip: LIVE_SKIP, timeout: 60_000 }, async () => {
  const { code, out } = await runScript({ ANTHROPIC_API_KEY: "" });
  assert.match(out, /^SKIP opencode: no model credential/m);
  assert.equal(code, 3);
});
