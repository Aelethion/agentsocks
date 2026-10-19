import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./support.ts";
import { tempDir } from "./tmp.ts";
import { threadSocketName } from "../src/paths.ts";

const tmpMod = fileURLToPath(new URL("./tmp.ts", import.meta.url));

function launch(body: string): { child: ChildProcess; file: string } {
  const dir = tempDir("harness-child-");
  const file = join(dir, "child.mjs");
  writeFileSync(file, body);
  const child = spawn(process.execPath, [file], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  return { child, file };
}

async function exited(child: ChildProcess, ms = 30_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const end = Date.now() + ms;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
    if (Date.now() > end) {
      child.kill("SIGKILL");
      throw new Error("child never exited");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("tempDir creates per-file dirs under this run's root", () => {
  const dir = tempDir("harness-own-");
  assert.ok(dir.startsWith(`${process.env.TMPDIR}/`), "dirs live under the inherited run root");
  assert.ok(existsSync(dir));
  assert.match(dir, /harness-own-/, "the needing file is named by the path");
});

test("SIGTERM to a test process kills it; the runner owns what is left", async () => {
  const { child } = launch(`
setInterval(() => {}, 1000);
await new Promise(() => {});
`);
  await new Promise((r) => setTimeout(r, 1000));
  child.kill("SIGTERM");
  const out = await exited(child);
  assert.equal(out.code, null);
  assert.equal(out.signal, "SIGTERM", "the default disposition kills, nothing re-raises");
});

test("the longest runtime socket path the suite can create fits unix limits", () => {
  const testDir = fileURLToPath(new URL(".", import.meta.url));
  let longestPrefix = 0;
  for (const name of readdirSync(testDir)) {
    if (!name.endsWith(".test.ts")) continue;
    const src = readFileSync(join(testDir, name), "utf8");
    for (const m of src.matchAll(/tempDir\("([^"]*)"\)/g)) longestPrefix = Math.max(longestPrefix, m[1]!.length);
  }
  const cap = Number(/slice\(0,\s*(\d+)\)/.exec(readFileSync(tmpMod, "utf8"))?.[1]);
  assert.ok(Number.isInteger(cap) && cap > 0, "the filekey cap is read from test/tmp.ts");
  const runtime = join(`/tmp/asr-${"X".repeat(6)}`, `${"a".repeat(cap)}-${"b".repeat(longestPrefix)}XXXXXX`, "run");
  const worst = join(runtime, "t", threadSocketName("u".repeat(36)));
  assert.ok(worst.length <= 103, `worst path is ${worst.length} chars, must stay at 103 or under (macOS 104 minus NUL)`);
});
