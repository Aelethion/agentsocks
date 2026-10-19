import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

test("the version is one number: src/version.ts, package.json, both places in package-lock.json, and the newest changelog entry agree", () => {
  const pkg = JSON.parse(read("package.json")) as { version: string };
  const lock = JSON.parse(read("package-lock.json")) as { version: string; packages: Record<string, { version?: string }> };
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, VERSION);
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[""]!.version, VERSION);
  assert.match(/^## (\S+)/m.exec(read("CHANGELOG.md"))![1]!, new RegExp(`^${VERSION.replaceAll(".", "\\.")}$`));
});
