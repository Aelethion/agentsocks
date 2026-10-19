import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tempDir } from "./tmp.ts";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));

function project(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tempDir("agentsocks-build-");
  for (const name of ["package.json", "tsconfig.json", "tsconfig.build.json"]) cpSync(join(repo, name), join(dir, name));
  cpSync(join(repo, "src"), join(dir, "src"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
  const env = { ...process.env, npm_config_cache: join(dir, ".npm"), npm_config_logs_max: "0", npm_config_update_notifier: "false", npm_config_fund: "false" };
  return { dir, env };
}

test("npm run build compiles into dist without deleting what is already there, so a running install of the same checkout keeps its files", { timeout: 120_000 }, async () => {
  const { dir, env } = project();
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "in-use.js"), "export {};\n");
  await exec("npm", ["run", "build"], { cwd: dir, env });
  assert.ok(existsSync(join(dir, "dist", "in-use.js")), "build removed a file from dist");
  assert.ok(statSync(join(dir, "dist", "cli.js")).mode & 0o100, "dist/cli.js is built and executable");
});

test("npm run clean removes dist, and npm pack's prepack cleans before it builds so a deleted module cannot be packed", { timeout: 120_000 }, async () => {
  const { dir, env } = project();
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "deleted-module.js"), "export {};\n");
  await exec("npm", ["run", "clean"], { cwd: dir, env });
  assert.equal(existsSync(join(dir, "dist")), false);
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "deleted-module.js"), "export {};\n");
  await exec("npm", ["run", "prepack"], { cwd: dir, env });
  assert.equal(existsSync(join(dir, "dist", "deleted-module.js")), false);
  assert.ok(existsSync(join(dir, "dist", "cli.js")));
});
