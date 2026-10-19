import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tmp.ts";
import { ownRunPids } from "./procs.ts";

const LIVE_SKIP = process.platform === "linux" ? false : "the live scripts need GNU coreutils (timeout, setsid, sha256sum), so they run on Linux only";

const repo = fileURLToPath(new URL("..", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/agents/omp/fake-omp.mjs", import.meta.url));

function runScript(extra: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const bin = tempDir("agentsocks-fake-bin-");
  writeFileSync(join(bin, "omp"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`);
  chmodSync(join(bin, "omp"), 0o755);
  for (const other of ["claude", "codex"]) {
    writeFileSync(join(bin, other), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, other), 0o755);
  }
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: process.env.TMPDIR ?? "/tmp", ANTHROPIC_API_KEY: "not-a-real-key", ...(process.env.NODE_OPTIONS && { NODE_OPTIONS: process.env.NODE_OPTIONS }), ...extra };
  return new Promise((resolve) => {
    const child = spawn("bash", [join(repo, "scripts/live/omp.sh")], { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
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

const strays = () => ownRunPids((l) => l.includes("fake-omp.mjs"));

test("the live script runs end to end against a fake OMP that loads the generated extension in RPC mode, and every check it prints passes", { skip: LIVE_SKIP, timeout: 280_000 }, async () => {
  const { code, out } = await runScript({});
  for (const name of [
    "install wrote the extension with the agentsocks marker on its first line",
    "install put it in the isolated agent folder and nowhere else",
    "doctor reports the OMP integration wired",
    "omp --mode rpc came up with the extension directory",
    "the OMP session registered as a peer at startup",
    "exactly one OMP peer exists",
    "the first message was sent to the OMP session",
    "the first turn finished (session_settled)",
    "the turn read the inbox through agentsocks_read_inbox",
    "the model's final answer contains the marker word kumquat",
    "the content-free notice reached the model",
    "the second message was sent to the idle session",
    "the broker woke the idle session",
    "OMP started a turn with nobody typing",
    "the woken session read its inbox with nobody typing",
    "the event stream holds the second message",
    "the wake line went in as a custom message of its own type, not as the user",
    "with the kill switch on, a send is refused",
    "with the kill switch off again, a send goes through",
    "a subagent ran and still only one OMP peer exists",
    "no subagent thread was ever registered, ended or not",
    "OMP reported no extension_error frame",
    "closing omp's input ended it by itself",
    "the session left the peer list with it",
    "no wake poll of the extension is left running",
    "uninstall removed the extension file",
    "the user's own OMP files are byte-identical",
    "doctor no longer reports the OMP integration wired",
  ]) assert.ok(out.includes(`PASS ${name}`), `missing PASS ${name}\n${out}`);
  assert.doesNotMatch(out, /^FAIL /m, out);
  assert.doesNotMatch(out, /^UNCONFIRMED /m, out);
  assert.match(out, /RESULT: PASS \(\d+ passed, 0 failed\) for omp/);
  assert.equal(code, 0);
  assert.deepEqual(strays(), [], "the script left nothing running");
});

test("the live script skips with exit 3 when it has no model credential", { skip: LIVE_SKIP, timeout: 60_000 }, async () => {
  const { code, out } = await runScript({ ANTHROPIC_API_KEY: "" });
  assert.match(out, /^SKIP omp: no model credential/m);
  assert.equal(code, 3);
});
