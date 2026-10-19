import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tmp.ts";
import { cat } from "./fakes.ts";

const LIVE_SKIP = process.platform === "linux" ? false : "the live scripts need GNU coreutils (timeout, setsid, sha256sum), so they run on Linux only";

const script = fileURLToPath(new URL("../scripts/live/gemini.sh", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/agents/gemini/fake-gemini.mjs", import.meta.url));

function runScript(env: Record<string, string>) {
  const bin = tempDir("fakegemini-");
  const marker = `agentsocks-test-run-${basename(bin)}`;
  writeFileSync(join(bin, "gemini"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@" --${marker}\n`);
  chmodSync(join(bin, "gemini"), 0o755);
  const merged = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LIVE_KEEP: "1", LIVE_GEMINI_REGISTER_WAIT: "60", FAKE_GEMINI_LATENCY_MS: "1500", ...env } as Record<string, string>;
  const r = spawnSync("bash", [script], { env: merged, encoding: "utf8", timeout: 280_000 });
  return { ...r, output: `${r.stdout}${r.stderr}`, root: /root (\S*asl-gemini-\w+)/.exec(r.stdout)?.[1], marker };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleepMs = (ms: number) => spawnSync("sleep", [String(ms / 1000)]);

test("scripts/live/gemini.sh passes end to end against a fake gemini that follows the documented hook protocol, and leaves nothing running", { skip: LIVE_SKIP, timeout: 300_000 }, () => {
  const r = runScript({ GEMINI_API_KEY: cat("fake", "-credential-for-test") });
  let broker = 0;
  try {
    assert.equal(r.status, 0, r.output);
    for (const check of ["(7a)", "(1)", "(1b)", "(0)", "(2)", "(2b)", "(5)", "(4)", "(4b)", "(3a)", "(3b)", "(6)", "(7)"]) {
      assert.match(r.stdout, new RegExp(`^PASS ${check.replace(/[()]/g, "\\$&")}`, "m"), `${check} passed\n${r.output}`);
    }
    assert.doesNotMatch(r.stdout, /^FAIL/m);
    assert.match(r.stdout, /^RESULT: PASS/m);
    assert.doesNotMatch(r.output, new RegExp(cat("fake", "-credential-for-test")), "the credential is never printed");
    broker = Number(readFileSync(join(r.root!, "broker.pid"), "utf8").trim());
    assert.ok(broker > 0, "the script recorded the broker it started");
  } finally {
    if (r.root) {
      assert.ok(r.root.startsWith(`${process.env.TMPDIR}/`) && r.root.includes("asl-gemini-"), `script root is inside this run: ${r.root}`);
      rmSync(r.root, { recursive: true, force: true });
    }
  }
  for (let i = 0; i < 30 && alive(broker); i++) sleepMs(100);
  assert.equal(alive(broker), false, "the broker this run of the script started was stopped, whatever else is running on the machine");
  assert.equal(spawnSync("pgrep", ["-f", "--", r.marker], { encoding: "utf8" }).stdout.trim(), "", "no fake gemini process of this run is left");
});

test("scripts/live/gemini.sh skips with exit 3 when there is no gemini binary, and when there is no credential", { skip: LIVE_SKIP }, () => {
  const nobin = spawnSync("bash", [script], { env: { ...process.env, PATH: "/usr/bin:/bin", GEMINI_API_KEY: cat("fake", "-credential-for-test") } as Record<string, string>, encoding: "utf8" });
  assert.equal(nobin.status, 3, nobin.stdout + nobin.stderr);
  assert.match(nobin.stdout, /^SKIP gemini: gemini is not installed here/m);

  const bin = tempDir("fakegemini-");
  writeFileSync(join(bin, "gemini"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "gemini"), 0o755);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` } as Record<string, string>;
  for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) delete env[key];
  const nocred = spawnSync("bash", [script], { env, encoding: "utf8" });
  assert.equal(nocred.status, 3, nocred.stdout + nocred.stderr);
  assert.match(nocred.stdout, /^SKIP gemini: no credential found/m);
});

test("scripts/live/gemini.sh reports the failing check, with what it saw, when hooks never register a peer", { skip: LIVE_SKIP, timeout: 300_000 }, () => {
  const r = runScript({ GEMINI_API_KEY: cat("fake", "-credential-for-test"), FAKE_GEMINI_NO_HOOKS: "1", FAKE_GEMINI_LATENCY_MS: "100", LIVE_GEMINI_REGISTER_WAIT: "3" });
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /^FAIL \(2\) no Gemini CLI peer appeared within 3 s/m);
    assert.match(r.stdout, /^RESULT: FAIL/m);
  } finally {
    if (r.root) {
      assert.ok(r.root.startsWith(`${process.env.TMPDIR}/`) && r.root.includes("asl-gemini-"), `script root is inside this run: ${r.root}`);
      rmSync(r.root, { recursive: true, force: true });
    }
  }
});
