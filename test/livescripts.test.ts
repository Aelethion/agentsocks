import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, symlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tmp.ts";

const LIVE_SKIP = process.platform === "linux" ? false : "the live scripts need GNU coreutils (timeout, setsid, sha256sum), so they run on Linux only";

const live = fileURLToPath(new URL("../scripts/live", import.meta.url));
const scripts = readdirSync(live).filter((f) => f.endsWith(".sh") && f !== "lib.sh");

const run = (script: string, env: Record<string, string>) => {
  const r = spawnSync("bash", [join(live, script)], { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...env }, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

test("there is a live script for each of the six other agents", () => {
  assert.deepEqual(scripts.sort(), ["copilot.sh", "cursor.sh", "gemini.sh", "hermes.sh", "omp.sh", "opencode.sh"]);
});

test("every live script refuses a LIVE_HOME that is the home of the shell it runs in, however the path is written, before it creates or reads anything", { skip: LIVE_SKIP }, () => {
  const home = tempDir("live-callers-home-");
  const alias = join(tempDir("live-alias-"), "home-alias");
  symlinkSync(home, alias);
  for (const script of scripts) {
    for (const liveHome of [home, `${home}/`, `${home}/.`, `${home}/../${home.split("/").at(-1)}`, alias]) {
      const r = run(script, { HOME: home, LIVE_HOME: liveHome });
      assert.equal(r.status, 1, `${script} with LIVE_HOME=${liveHome}\n${r.out}`);
      assert.match(r.out, /^FAIL isolation -- LIVE_HOME is your real home/m, script);
      assert.doesNotMatch(r.out, /live test for/, `${script} stopped before it set anything up`);
    }
  }
});

test("every live script refuses the account's home directory from the password database even when HOME says something else", { skip: LIVE_SKIP }, () => {
  const decoy = tempDir("live-decoy-home-");
  for (const script of scripts) {
    const r = run(script, { HOME: decoy, LIVE_HOME: userInfo().homedir });
    assert.equal(r.status, 1, `${script}\n${r.out}`);
    assert.match(r.out, /^FAIL isolation -- LIVE_HOME is your real home/m, script);
  }
});

test("a LIVE_HOME that is somewhere else, and no LIVE_HOME at all, are not refused: the script goes on to its own skip", { skip: LIVE_SKIP }, () => {
  const home = tempDir("live-callers-home-");
  const prepared = tempDir("live-prepared-home-");
  for (const script of scripts) {
    for (const env of [{ HOME: home, LIVE_HOME: prepared }, { HOME: home }] as Record<string, string>[]) {
      const r = run(script, env);
      assert.equal(r.status, 3, `${script}\n${r.out}`);
      assert.match(r.out, /^SKIP /m, script);
      assert.doesNotMatch(r.out, /isolation/, script);
    }
  }
});

test("the doctor line decides 'wired' only when the state is exactly wired, so partly wired, not wired, a note and nothing are not a pass", () => {
  const wired = (line: string) => spawnSync("bash", ["-c", '. "$1"; live_doctor_wired "$2"', "_", join(live, "lib.sh"), line], { encoding: "utf8" }).status === 0;
  assert.equal(wired("ok   Hermes (hermes) integration — wired, untested live"), true);
  assert.equal(wired("ok   OpenCode (opencode) integration — wired, untested live: a note from the installer"), true);
  assert.equal(wired("ok   Cursor (cursor) integration — wired"), true);
  assert.equal(wired("FAIL Hermes (hermes) integration — partly wired, untested live: config.yaml has no mcp_servers entry"), false);
  assert.equal(wired("FAIL Hermes (hermes) integration — not wired, untested live"), false);
  assert.equal(wired("note: Hermes (hermes) is installed but not wired; run `agentsocks install --hermes`"), false);
  assert.equal(wired("note: Hermes (hermes) is not installed on this machine"), false);
  assert.equal(wired(""), false);
});

test("no live script decides that an integration is wired by looking for the word in the doctor line", () => {
  for (const script of scripts) {
    const source = readFileSync(join(live, script), "utf8");
    assert.doesNotMatch(source, /\*wired\*/, `${script} matches the word wired as a substring`);
    assert.doesNotMatch(source, /grep -[a-zA-Z]*q[a-zA-Z]* ["']wired["']/, `${script} greps for the word wired`);
    assert.match(source, /live_doctor_wired/, `${script} uses the shared check`);
  }
});
