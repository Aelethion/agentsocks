import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chain, fakeClaude, procSource, root } from "./support.ts";
import { closeServer } from "../src/ccsocks.ts";
import { findOwnClaudeSession, runsUnderClaude } from "../src/claude.ts";
import { framesPeerText } from "../src/peers.ts";

const decide = (stdoutIsTTY: boolean, env: NodeJS.ProcessEnv, agent: boolean): boolean => framesPeerText(stdoutIsTTY, env, () => agent);

test("the command line prints plain text only to a person at a terminal: no agent detected and stdout is a terminal", () => {
  assert.equal(decide(true, {}, false), false);
  assert.equal(decide(true, { AGENTSOCKS_FRAME: "0" }, false), false);
});

test("anything else is framed: a detected agent, AGENTSOCKS_FRAME=1, or output that is not a terminal", () => {
  assert.equal(decide(true, {}, true), true);
  assert.equal(decide(true, { AGENTSOCKS_FRAME: "1" }, false), true);
  assert.equal(decide(false, {}, false), true);
  assert.equal(decide(false, {}, true), true);
  assert.equal(decide(false, { AGENTSOCKS_FRAME: "0" }, false), true);
});

const claudeAsPid1 = procSource({ "/proc/1/cmdline": "claude\0--resume\0" });
async function claudeRecord(pid: number): Promise<() => Promise<void>> {
  const c = await fakeClaude(`claude-${pid}`, pid);
  return async () => {
    await closeServer(c.server);
    rmSync(join(root, "claude-sessions", `${pid}.json`), { force: true });
  };
}

test("the walk to the Claude Code ancestor reaches pid 1, so Claude Code as the first process of a container is found", async () => {
  const remove = await claudeRecord(1);
  try {
    assert.equal(findOwnClaudeSession(4242, chain({ 4242: 77, 77: 1, 1: 0 }), "linux", claudeAsPid1)?.name, "claude-1");
    assert.equal(findOwnClaudeSession(1, chain({ 1: 0 }), "linux", claudeAsPid1)?.name, "claude-1");
  } finally {
    await remove();
  }
});

test("the walk ends at pid 0, at a pid with no parent, and in a loop, and finds nothing without a record", () => {
  assert.equal(findOwnClaudeSession(4242, chain({ 4242: 77, 77: 1, 1: 0 })), undefined);
  assert.equal(findOwnClaudeSession(4242, chain({ 4242: 77 })), undefined);
  assert.equal(findOwnClaudeSession(5, chain({ 5: 6, 6: 5 })), undefined);
});

test("the nearest record wins", async () => {
  const removeFar = await claudeRecord(1);
  const removeNear = await claudeRecord(77);
  try {
    assert.equal(findOwnClaudeSession(4242, chain({ 4242: 77, 77: 1, 1: 0 }), "linux", claudeAsPid1)?.name, "claude-77");
  } finally {
    await removeFar();
    await removeNear();
  }
});

const statLine = (pid: number, start: string): string =>
  `${pid} (claude) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 1000000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;

function recordWithoutSocket(pid: number, patch: Record<string, unknown> = {}): () => void {
  const file = join(root, "claude-sessions", `${pid}.json`);
  mkdirSync(join(root, "claude-sessions"), { recursive: true });
  const record = { pid, sessionId: `framing-${pid}`, name: `claude-${pid}`, messagingSocketPath: join(root, "cc-socks", `never-${pid}.sock`), kind: "interactive", ...patch };
  writeFileSync(file, JSON.stringify(record));
  return () => rmSync(file, { force: true });
}

test("framing needs less proof than identity: the record names the pid and the start time matches, and a missing socket does not stop it", () => {
  const remove = recordWithoutSocket(6101, { procStart: "321" });
  try {
    const stat = (start: string) => procSource({ "/proc/6101/stat": statLine(6101, start) });
    assert.equal(findOwnClaudeSession(6101, chain({ 6101: 0 }), "linux", stat("321")), undefined, "the session's identity still needs its socket");
    assert.equal(runsUnderClaude(6101, chain({ 6101: 0 }), "linux", stat("321")), true);
    assert.equal(runsUnderClaude(6102, chain({ 6102: 6101, 6101: 0 }), "linux", stat("321")), true, "found from a descendant");
    assert.equal(runsUnderClaude(6101, chain({ 6101: 0 }), "linux", stat("322")), false, "the pid was reused by another process");
    assert.equal(runsUnderClaude(6101, chain({ 6101: 0 }), "linux", procSource({})), false, "the start time cannot be read");
    assert.equal(runsUnderClaude(6101, chain({ 6101: 0 }), "darwin", procSource({})), true, "off Linux the pid is all there is to compare");
  } finally {
    remove();
  }
});

test("a record with no socket path at all still frames, and a record that names another pid does not", () => {
  const removeBare = recordWithoutSocket(6111, { messagingSocketPath: undefined });
  const removeForeign = recordWithoutSocket(6112, { pid: 6113 });
  try {
    assert.equal(findOwnClaudeSession(6111, chain({ 6111: 0 }), "linux", procSource({})), undefined);
    assert.equal(runsUnderClaude(6111, chain({ 6111: 0 }), "linux", procSource({})), true);
    assert.equal(runsUnderClaude(6112, chain({ 6112: 0 }), "linux", procSource({})), false);
  } finally {
    removeBare();
    removeForeign();
  }
});

test("a record at pid 1 frames only when pid 1 is Claude Code, as it identifies only then", () => {
  const remove = recordWithoutSocket(1);
  try {
    assert.equal(runsUnderClaude(4242, chain({ 4242: 77, 77: 1, 1: 0 }), "linux", claudeAsPid1), true);
    assert.equal(runsUnderClaude(4242, chain({ 4242: 77, 77: 1, 1: 0 }), "linux", procSource({ "/proc/1/cmdline": "/sbin/init\0" })), false);
  } finally {
    remove();
  }
});
