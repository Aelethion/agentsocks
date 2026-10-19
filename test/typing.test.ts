import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCodexTtys, typingGuard, type TtyActivity } from "../src/typing.ts";
import { tempDir } from "./tmp.ts";

const NOW = 1_000_000_000;

function fakeProc(): string {
  const root = tempDir("agentsocks-proc-");
  const proc = (pid: number, cmdline: string[], fd0?: string) => {
    mkdirSync(join(root, String(pid), "fd"), { recursive: true });
    writeFileSync(join(root, String(pid), "cmdline"), `${cmdline.join("\0")}\0`);
    if (fd0) symlinkSync(fd0, join(root, String(pid), "fd", "0"));
  };
  proc(100, ["codex"], "/dev/pts/3");
  proc(101, ["codex", "app-server", "--listen", "unix://"], "/dev/pts/4");
  proc(102, ["/usr/bin/codex", "exec", "do something"], "/dev/pts/5");
  proc(103, ["codex", "queue", "--thread", "x"], "/dev/pts/6");
  proc(104, ["codex", "mcp", "serve"], "/dev/pts/7");
  proc(105, ["node", "/work/codex-notes.js"], "/dev/pts/8");
  proc(106, ["codex"], "/dev/null");
  proc(107, ["/home/u/.npm/bin/codex", "resume", "--last"], "/dev/pts/9");
  proc(108, ["codex"]);
  mkdirSync(join(root, "self"));
  mkdirSync(join(root, "net"));
  return root;
}

test("scanCodexTtys finds interactive Codex terminals only, with the age of their last input", () => {
  const atimes: Record<string, number | undefined> = { "/dev/pts/3": NOW - 5_000, "/dev/pts/9": NOW - 120_000, "/dev/pts/4": NOW, "/dev/pts/5": NOW, "/dev/pts/6": NOW, "/dev/pts/7": NOW, "/dev/pts/8": NOW };
  const found = scanCodexTtys(NOW, fakeProc(), (path) => atimes[path], "linux");
  assert.deepEqual(
    found.sort((a, b) => a.pid - b.pid),
    [
      { pid: 100, tty: "/dev/pts/3", inputAgeMs: 5_000 },
      { pid: 107, tty: "/dev/pts/9", inputAgeMs: 120_000 },
    ],
  );
});

test("scanCodexTtys skips a terminal it cannot stat, and a missing proc tree means no terminals", () => {
  assert.deepEqual(scanCodexTtys(NOW, fakeProc(), () => undefined, "linux"), []);
  assert.deepEqual(scanCodexTtys(NOW, join(tmpdir(), "agentsocks-no-such-proc"), () => NOW, "linux"), []);
});

test("off Linux nothing is scanned, so a wake is delivered even with a busy Codex terminal in view", () => {
  const root = fakeProc();
  const typing = () => NOW - 1_000;
  assert.equal(scanCodexTtys(NOW, root, typing, "linux").length, 2);
  for (const platform of ["darwin", "freebsd", "win32"] as const) {
    const found = scanCodexTtys(NOW, root, typing, platform);
    assert.deepEqual(found, [], platform);
    assert.equal(typingGuard(found, null, NOW), "deliver", platform);
  }
});

const tty = (inputAgeMs: number, pid = 1): TtyActivity => ({ pid, tty: `/dev/pts/${pid}`, inputAgeMs });

test("typingGuard: no Codex terminal means deliver, recent input means hold", () => {
  assert.equal(typingGuard([], null, NOW), "deliver");
  assert.equal(typingGuard([], NOW - 3_600_000, NOW), "deliver");
  assert.equal(typingGuard([tty(37_999)], null, NOW), "hold", "38 s: a pty's atime moves in steps of about 8 s, so a 30 s window could really be 22 s");
  assert.equal(typingGuard([tty(38_000)], null, NOW), "deliver");
  assert.equal(typingGuard([tty(500_000), tty(2_000, 2)], null, NOW), "hold", "any one typing terminal holds");
  assert.equal(typingGuard([tty(5_000)], NOW - 599_999, NOW), "hold", "still within the 10 minute hold");
});

test("typingGuard: after 10 minutes of holding, deliver only into an 18 second quiet gap", () => {
  const heldSince = NOW - 10 * 60_000;
  assert.equal(typingGuard([tty(17_999)], heldSince, NOW), "hold");
  assert.equal(typingGuard([tty(18_000)], heldSince, NOW), "deliver");
  assert.equal(typingGuard([tty(25_000), tty(3_000, 2)], heldSince, NOW), "hold");
  assert.equal(typingGuard([tty(25_000), tty(30_000, 2)], heldSince, NOW), "deliver");
});
