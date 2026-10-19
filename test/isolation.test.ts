import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeIsTemporary } from "./isolation.ts";
import { tempDir } from "./tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));

function importSupport(home: string, extra: Record<string, string>, then = ""): ReturnType<typeof spawnSync> {
  const nested = tempDir("iso-nested-");
  const env: Record<string, string> = {
    ...extra,
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: nested,
  };
  if (process.env.NODE_OPTIONS) env.NODE_OPTIONS = process.env.NODE_OPTIONS;
  return spawnSync(process.execPath, ["--input-type=module", "-e", `await import("./test/support.ts"); ${then}`], { cwd: repo, env, encoding: "utf8", timeout: 30_000 });
}

test("a home counts as temporary only when it is a real directory inside a temporary root", () => {
  const parent = tempDir("agentsocks-iso-");
  const root = join(parent, "root");
  const sibling = join(parent, "root-evil");
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(sibling);
  const roots = [realpathSync(root)];
  assert.equal(homeIsTemporary(join(root, "home"), roots), true);
  assert.equal(homeIsTemporary(sibling, roots), false, "a sibling that shares the prefix is outside");
  assert.equal(homeIsTemporary(root, roots), false, "the root itself is not a home inside it");
  assert.equal(homeIsTemporary(join(root, "missing"), roots), false, "a home that cannot be resolved is refused");
  assert.equal(homeIsTemporary(undefined, roots), false);
  assert.equal(homeIsTemporary(repo), false, "a checkout is not temporary");
});

test("the support module refuses to load when HOME is outside the temporary directories, so a run without the preload cannot reach a real home", () => {
  const r = importSupport(repo, {});
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr), /refusing to run: HOME is not inside a temporary directory/);
});

test("the support module drops the classifier keys and every AGENTSOCKS_ variable itself, with or without the preload", () => {
  const then = `console.log("SEEN:" + JSON.stringify(["TYPESAFE_API_KEY", "AGENTSOCKS_CLASSIFIER_KEY", "AGENTSOCKS_WAKE"].filter((name) => name in process.env)));`;
  const r = importSupport(tempDir("agentsocks-iso-home-"), { TYPESAFE_API_KEY: "k-iso", AGENTSOCKS_CLASSIFIER_KEY: "k-iso", AGENTSOCKS_WAKE: "0" }, then);
  assert.equal(r.status, 0, String(r.stderr));
  assert.match(String(r.stdout), /^SEEN:\[\]$/m);
});

test("a source checkout under /tmp never counts as a temporary home", () => {
  const checkout = tempDir("iso-checkout-");
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "package.json"), "{}");
  assert.equal(homeIsTemporary(checkout), false, "a checkout is judged by what it is, not its path");
  const r = importSupport(checkout, {});
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr), /refusing to run: HOME is not inside a temporary directory/);
});

test("the real home never counts as temporary, even under a TMPDIR that contains it", () => {
  const home = realpathSync(userInfo().homedir);
  assert.equal(homeIsTemporary(home, [dirname(home)]), false);
});
