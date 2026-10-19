import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { install } from "../src/install.ts";
import { tempDir } from "./tmp.ts";

const options = { claude: false, codexMcp: true, codexHooks: true, trustHooks: false, dryRun: false, codexOptional: true } as const;

async function withoutCodexOnPath<T>(codexHome: string, body: () => Promise<T>): Promise<T> {
  const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
  process.env.PATH = tempDir("agentsocks-emptybin-");
  process.env.CODEX_HOME = codexHome;
  try {
    return await body();
  } finally {
    process.env.PATH = saved.PATH;
    process.env.CODEX_HOME = saved.CODEX_HOME;
  }
}

test("a default install on a machine with no Codex skips Codex instead of failing, and does not create its folder", async () => {
  const home = join(tempDir("agentsocks-nocodex-"), ".codex");
  const log = await withoutCodexOnPath(home, () => install({ ...options }));
  assert.ok(log.includes("codex: not installed on this machine, skipped"), log.join("\n"));
  assert.equal(existsSync(home), false);
});

test("a default install still wires Codex when its folder exists, and naming Codex wires it even when it is not found", async () => {
  const present = join(tempDir("agentsocks-codexhere-"), ".codex");
  mkdirSync(present);
  const here = await withoutCodexOnPath(present, () => install({ ...options, dryRun: true }));
  assert.ok(here.some((l) => l.startsWith("codex (dry run)")), here.join("\n"));
  const missing = join(tempDir("agentsocks-codexgone-"), ".codex");
  const named = await withoutCodexOnPath(missing, () => install({ ...options, codexOptional: false, dryRun: true }));
  assert.ok(named.some((l) => l.startsWith("codex (dry run)")), named.join("\n"));
});
