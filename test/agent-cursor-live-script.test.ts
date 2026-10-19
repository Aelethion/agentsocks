import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownRunWithEnviron } from "./procs.ts";
import { tempDir } from "./tmp.ts";

const LIVE_SKIP = process.platform === "linux" ? false : "the live scripts need GNU coreutils (timeout, setsid, sha256sum), so they run on Linux only";

const script = fileURLToPath(new URL("../scripts/live/cursor.sh", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/agents/cursor/fake-cursor-agent.ts", import.meta.url));

function toolbox(withCursor: boolean): string {
  const bin = tempDir("cursor-live-bin-");
  const exec = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  symlinkSync(process.execPath, join(bin, "node"));
  for (const stub of ["claude", "codex"]) exec(stub, "#!/bin/sh\nexit 1\n");
  if (withCursor) for (const name of ["cursor-agent", "agent"]) exec(name, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  return bin;
}

interface Run {
  code: number | null;
  out: string;
}

function rehearse(bin: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], { env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: process.env.TMPDIR ?? "/tmp", LIVE_CURSOR_TIMEOUT: "90", ...(process.env.NODE_OPTIONS && { NODE_OPTIONS: process.env.NODE_OPTIONS }), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

const runs: Record<string, Run> = {};
const lines = (run: Run, prefix: string) => run.out.split("\n").filter((l) => l.startsWith(prefix));
const verdicts = (run: Run) => run.out.split("\n").filter((l) => /^(PASS|FAIL) /.test(l));

before(async () => {
  if (LIVE_SKIP) return;
  const withCursor = toolbox(true);
  const entries: [string, Promise<Run>][] = [
    ["good", rehearse(withCursor, {})],
    ["stampIgnored", rehearse(withCursor, { FAKE_CURSOR: "ignore-updated-input" })],
    ["stopIgnored", rehearse(withCursor, { FAKE_CURSOR: "blind-stop" })],
    ["envScrubbed", rehearse(withCursor, { FAKE_CURSOR: "scrub-env" })],
    ["denyOverridden", rehearse(withCursor, { FAKE_CURSOR: "hook-overrides-deny" })],
    ["noHooks", rehearse(withCursor, { FAKE_CURSOR: "no-hooks" })],
    ["notLoggedIn", rehearse(withCursor, { FAKE_CURSOR_AUTH: "0" })],
    ["missing", rehearse(toolbox(false), {})],
  ];
  const done = await Promise.all(entries.map(([, p]) => p));
  entries.forEach(([name], i) => (runs[name] = done[i]!));
});

test("the toolbox the rehearsals run in can reach neither a real claude, a real codex nor a real Cursor", { skip: LIVE_SKIP }, () => {
  const bin = toolbox(true);
  for (const name of ["claude", "codex", "cursor-agent", "agent", "node"]) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" }).stdout.trim();
    assert.ok(found.startsWith(bin), `${name} resolves to ${found || "nothing"}`);
  }
});

test("against a Cursor that behaves as its docs say, every check of the live script passes", { skip: LIVE_SKIP }, () => {
  const run = runs.good!;
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^RESULT: PASS \(12 passed, 0 failed\) for cursor$/m);
  const expected = [
    "PASS install changes only ~/.cursor/mcp.json and ~/.cursor/hooks.json",
    "PASS install leaves ~/.claude alone",
    "PASS doctor reports Cursor wired: ok",
    "PASS the session registers as a cursor peer (cursor_",
    "PASS read_inbox ran as cursor_",
    "PASS the model read the message: its answer carries the marker word MARK",
    "PASS the content-free notice reached the model after a tool call",
    "PASS the end-of-turn nudge fired (stop_blocked=1) and the model then read the message",
    "PASS a deny rule for read_inbox in .cursor/cli.json still blocked it",
    "PASS with AGENTSOCKS_OFF=1 in its environment a session ran and Cursor registered no new thread",
    "PASS uninstall restores the Cursor config",
    "PASS doctor no longer reports Cursor wired after uninstall",
  ];
  const seen = verdicts(run);
  assert.equal(seen.length, expected.length, seen.join("\n"));
  expected.forEach((start, i) => assert.ok(seen[i]!.startsWith(start), `${seen[i]} should start with ${start}`));
  assert.match(run.out, /^NOTE no idle-wake check/m);
});

test("when Cursor ignores updated_input, the stamp never arrives, the script fails the stamp and read checks, and its message shows what Cursor sent", { skip: LIVE_SKIP }, () => {
  const run = runs.stampIgnored!;
  assert.notEqual(run.code, 0);
  const stamp = lines(run, "FAIL read_inbox ran as this Cursor session");
  assert.equal(stamp.length, 1, run.out);
  assert.match(stamp[0]!, /preToolUse tool_name=MCP:read_inbox mcp_server_name=undefined tool_input is object with keys \[\]/, "what Cursor handed the hook");
  assert.match(stamp[0]!, /afterMCPExecution mcp_server_name=agentsocks tool_name=read_inbox tool_input keys \[\]/, "what the tool then received");
  assert.match(stamp[0]!, /Hooks Cursor ran: .*sessionStart=\d+/);
  assert.equal(lines(run, "FAIL the model read the message").length, 1, run.out);
  assert.equal(lines(run, "PASS the session registers as a cursor peer").length, 1, "registration does not need the stamp");
});

test("when Cursor drops a stop hook's followup_message, the nudge check fails and says the hook had asked for one", { skip: LIVE_SKIP }, () => {
  const run = runs.stopIgnored!;
  assert.notEqual(run.code, 0);
  const nudge = lines(run, "FAIL the end-of-turn nudge made the model read its inbox");
  assert.equal(nudge.length, 1, run.out);
  assert.match(nudge[0]!, /the stop hook asked for a follow-up \(stop_blocked=1\)/);
  assert.equal(lines(run, "PASS read_inbox ran as cursor_").length, 1, "the notice path still worked");
});

test("when Cursor runs hooks with a bare environment, the pinned variables still find the broker and the kill switch check says it could not reach them", { skip: LIVE_SKIP }, () => {
  const run = runs.envScrubbed!;
  assert.notEqual(run.code, 0);
  assert.equal(lines(run, "PASS the session registers as a cursor peer").length, 1, run.out);
  assert.equal(lines(run, "PASS read_inbox ran as cursor_").length, 1, run.out);
  const off = lines(run, "FAIL the kill switch silences the Cursor hooks");
  assert.equal(off.length, 1, run.out);
  assert.match(off[0]!, /if Cursor does not pass its environment on to hooks, the switch cannot reach them/);
});

test("when Cursor lets a hook's decision override the user's deny rule, the deny check fails and says the rule was overridden", { skip: LIVE_SKIP }, () => {
  const run = runs.denyOverridden!;
  assert.notEqual(run.code, 0);
  const deny = lines(run, "FAIL a deny rule for read_inbox in .cursor/cli.json still blocks it");
  assert.equal(deny.length, 1, run.out);
  assert.match(deny[0]!, /the hook's answer overrode the user's rule/);
  assert.equal(lines(run, "PASS the end-of-turn nudge fired").length, 1, "the rest still works");
});

test("when no hook ever runs, the registration check fails with the hooks Cursor ran and the agent's own output", { skip: LIVE_SKIP }, () => {
  const run = runs.noHooks!;
  assert.notEqual(run.code, 0);
  const none = lines(run, "FAIL the session registers as a cursor peer");
  assert.equal(none.length, 1, run.out);
  assert.match(none[0]!, /Hooks Cursor ran: no hook ever ran/);
});

test("when Cursor is not logged in, the failures quote its own message", { skip: LIVE_SKIP }, () => {
  const run = runs.notLoggedIn!;
  assert.notEqual(run.code, 0);
  assert.match(lines(run, "FAIL the session registers as a cursor peer")[0] ?? run.out, /Not authenticated/);
  const off = lines(run, "FAIL the kill switch silences the Cursor hooks");
  assert.equal(off.length, 1, "a run that never started cannot pass the kill switch check");
  assert.match(off[0]!, /never started a session/);
  assert.equal(lines(run, "PASS with AGENTSOCKS_OFF").length, 0);
});

test("without cursor-agent or agent on the path the script skips with exit 3 and starts nothing", { skip: LIVE_SKIP }, () => {
  const run = runs.missing!;
  assert.equal(run.code, 3, run.out);
  assert.match(run.out, /^SKIP cursor: cursor-agent is not installed here$/m);
  assert.equal(verdicts(run).length, 0);
});

test("a rehearsal leaves no process of its own behind, the broker and the MCP servers included", { skip: process.platform !== "linux" }, async () => {
  const left = () => ownRunWithEnviron("asl-cursor-");
  for (let i = 0; i < 100 && left().length > 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(left(), []);
});
