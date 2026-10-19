import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempDir } from "./tmp.ts";

const script = fileURLToPath(new URL("../scripts/live/hermes.sh", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/agents/hermes/fake-hermes.mjs", import.meta.url));
const hasPyYaml = spawnSync("python3", ["-I", "-c", "import yaml"], { stdio: "ignore" }).status === 0;
const runnable = process.platform === "linux" && hasPyYaml;

function drive(extra: Record<string, string>) {
  const bin = tempDir("fake-hermes-bin-");
  chmodSync(fake, 0o755);
  symlinkSync(fake, join(bin, "hermes"));
  const liveHome = tempDir("live-home-");
  mkdirSync(join(liveHome, ".hermes"));
  writeFileSync(join(liveHome, ".hermes", "config.yaml"), "# your model settings\nmodel:\n  default: fake/model\n");
  const env = { PATH: `${bin}:${process.env.PATH}`, LIVE_HOME: liveHome, LANG: "C.UTF-8", NODE_NO_WARNINGS: "1", TMPDIR: process.env.TMPDIR ?? "/tmp", ...(process.env.NODE_OPTIONS && { NODE_OPTIONS: process.env.NODE_OPTIONS }), ...extra };
  const r = spawnSync("bash", [script], { env, encoding: "utf8", timeout: 280_000 });
  return { out: `${r.stdout}\n${r.stderr}`, status: r.status };
}

test("scripts/live/hermes.sh, driven against a fake Hermes that follows the documented hook and MCP behaviour, passes every check it can run", { skip: !runnable, timeout: 300_000 }, () => {
  const { out, status } = drive({ FAKE_HERMES_TOOL_STYLE: "double" });
  for (const check of ["(1) install wrote the agentsocks MCP server", "(1) install wrote the five shell hooks", "(2) a Hermes session registered", "(3) the answer carries the marker", "(4) Hermes' hook runner returned the content-free notice", "(5) the stamp rewrite worked", "(6) with the kill switch on", "(7) config.yaml is byte-identical"]) assert.ok(out.includes(`PASS ${check}`), `${check}\n${out}`);
  assert.match(out, /^NOTE \(1\) doctor says partly wired and gives the pending hook approval as the reason; that is not a pass/m);
  assert.ok(!out.includes("PASS (1) doctor reports Hermes wired"), "partly wired is not counted as wired");
  assert.ok(out.includes("SKIP (8)"));
  assert.ok(!/^FAIL/m.test(out), out);
  assert.match(out, /RESULT: PASS/);
  assert.equal(status, 0, out);
});

test("the same script fails check 5 and says why when Hermes ignores the pre_tool_call rewrite for MCP tools", { skip: !runnable, timeout: 300_000 }, () => {
  const { out, status } = drive({ FAKE_HERMES_IGNORE_MODIFY: "1" });
  assert.match(out, /FAIL \(5\) the session stamp did not reach the MCP call/);
  assert.ok(!out.includes("PASS (5)"));
  assert.match(out, /RESULT: FAIL/);
  assert.notEqual(status, 0);
});
