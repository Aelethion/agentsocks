import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runtimeDir } from "../src/paths.ts";
import { tempDir } from "./tmp.ts";

const exec = promisify(execFile);
const file = (name: string): string => fileURLToPath(new URL(`../${name}`, import.meta.url));

test("every test file starts without the caller's AGENTSOCKS_ variables and with a home and runtime directory of its own", () => {
  assert.deepEqual(
    Object.keys(process.env).filter((key) => key.startsWith("AGENTSOCKS_") && key !== "AGENTSOCKS_TEST_FILE"),
    [], // only the harness-provided test file name survives the scrub
  );
  assert.notEqual(homedir(), userInfo().homedir);
  assert.ok(runtimeDir().startsWith(`${homedir()}/`), runtimeDir());
});

test("a shell that exports AGENTSOCKS_OFF=1 and AGENTSOCKS_WAKE=0 does not change what the integration tests see", { timeout: 150_000 }, async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTSOCKS_OFF: "1", AGENTSOCKS_WAKE: "0" };
  delete env.NODE_TEST_CONTEXT;
  const run = await exec(process.execPath, ["--import", file("test/setup.ts"), file("test/integration.test.ts")], { env, timeout: 120_000 }).then(
    (r) => ({ code: 0, out: r.stdout }),
    (e: { code?: number; stdout?: string }) => ({ code: e.code ?? 1, out: e.stdout ?? "" }),
  );
  assert.equal(run.code, 0, run.out.split("\n").filter((line) => line.startsWith("✖")).join("\n"));
});

test("npm test runs the single-owner runner, which loads the preload, and CI runs npm test rather than its own copy of the command", () => {
  assert.match(JSON.parse(readFileSync(file("package.json"), "utf8")).scripts.test, /^node scripts\/test\.mjs$/);
  assert.match(
    readFileSync(file("scripts/test.mjs"), "utf8"),
    /--import", "\.\/test\/setup\.ts", "--test"/,
    "the runner starts the suite with the preload",
  );
  const workflow = readFileSync(file(".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /^\s+run: npm test$/m);
  assert.doesNotMatch(workflow, /node --test/);
});

const hasStrace = process.platform === "linux" && spawnSync("strace", ["-V"], { stdio: "ignore" }).status === 0;

test("platform.test.ts, started alone from a caller's shell, reads nothing under /run/user or in the agents' home directories", { skip: !hasStrace && "needs strace on Linux", timeout: 60_000 }, async (t) => {
  const realHome = userInfo().homedir;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: realHome };
  delete env.NODE_TEST_CONTEXT;
  delete env.XDG_RUNTIME_DIR;
  const out = `${tempDir("agentsocks-strace-")}/trace.txt`;
  const traced = await exec("strace", ["-f", "-qq", "-e", "trace=%file", "-o", out, process.execPath, file("test/platform.test.ts")], { env, timeout: 50_000 }).then(
    () => 0,
    (e: { code?: number }) => e.code ?? 1,
  );
  if (!existsSync(out) || readFileSync(out, "utf8") === "") return t.skip("strace could not trace here");
  assert.equal(traced, 0);
  const touched = readFileSync(out, "utf8")
    .split("\n")
    .filter((line) => line.includes("/run/user") || [".claude", ".codex", ".config/agentsocks"].some((dir) => line.includes(`${realHome}/${dir}`)));
  assert.deepEqual(touched, []);
});
