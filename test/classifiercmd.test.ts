import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import "./support.ts";
import { effectiveConfig, findApiKey, watchClassifier } from "../src/classifier.ts";
import { CHANGE_COMMANDS, changeClassifier, routingLine } from "../src/classifiercmd.ts";
import { agentsocksEnvPath, configPath } from "../src/paths.ts";
import { tempDir } from "./tmp.ts";
import { cat } from "./fakes.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const saved = { config: process.env.AGENTSOCKS_CONFIG, xdg: process.env.XDG_CONFIG_HOME, home: process.env.HOME };

function sandbox(): string {
  const dir = tempDir("agentsocks-clf-");
  process.env.AGENTSOCKS_CONFIG = join(dir, "cfg", "config.json");
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.HOME = join(dir, "home");
  delete process.env.TYPESAFE_API_KEY;
  return dir;
}

afterEach(() => {
  process.env.AGENTSOCKS_CONFIG = saved.config;
  process.env.XDG_CONFIG_HOME = saved.xdg;
  if (saved.home === undefined) delete process.env.HOME;
  else process.env.HOME = saved.home;
  delete process.env.TYPESAFE_API_KEY;
});

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("classifier jev writes the hosted Jev section, keeps every other key, and leaves no temporary file", () => {
  const dir = sandbox();
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ other: { keep: [1, 2] }, classifier: { backend: "gliner2", url: "http://127.0.0.1:8765", threshold: 0.9 } }));
  const before = statSync(path).ino;
  const out = changeClassifier(["jev"]);
  assert.deepEqual(readJson(path), { other: { keep: [1, 2] }, classifier: { backend: "systemone", url: "https://api.typesafe.ai", model: "jev-latest", apiKeyEnv: "TYPESAFE_API_KEY", allowRemote: true } });
  assert.notEqual(statSync(path).ino, before, "replaced by rename, never written in place");
  assert.deepEqual(readdirSync(dirname(path)), ["config.json"]);
  assert.match(out.at(-1)!, /^Smart routing is off until you set TYPESAFE_API_KEY/);
  assert.equal(existsSync(join(dir, "xdg")), false, "no key given, no env file");
});

test("classifier jev --key stores the key in the 0600 env file, replaces an old value, keeps other lines, and never prints it", () => {
  sandbox();
  const secret = cat("tsk-live", "-0123456789abcdef");
  const out = changeClassifier(["jev", "--key", secret]);
  const envFile = agentsocksEnvPath();
  assert.equal(readFileSync(envFile, "utf8"), `TYPESAFE_API_KEY=${secret}\n`);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(envFile)).mode & 0o777, 0o700);
  assert.ok(!out.join("\n").includes(secret), "the key is not echoed");
  assert.match(out.at(-1)!, /^Smart routing: TypeSafe Jev \(grey-zone messages and the receiver's redacted task are sent to api\.typesafe\.ai\)\. Change it with `agentsocks classifier`\.$/);
  writeFileSync(envFile, `# mine\nOTHER=1\nexport TYPESAFE_API_KEY=old\nLAST=2\n`, { mode: 0o600 });
  changeClassifier(["jev", "--key", "new-key-1"]);
  assert.equal(readFileSync(envFile, "utf8"), `# mine\nOTHER=1\nLAST=2\nTYPESAFE_API_KEY=new-key-1\n`);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(envFile)), ["env"]);
});

test("a key that could break out of its line, or a second key source, is refused before anything is written", () => {
  sandbox();
  for (const bad of ["two words", "line\nTYPESAFE_API_KEY=other", 'quo"te', "tab\tkey"]) {
    assert.throws(() => changeClassifier(["jev", "--key", bad]), /one visible token/, JSON.stringify(bad));
  }
  assert.throws(() => changeClassifier(["jev", "--key", "a", "--key-file", "/x"]), /not both/);
  assert.throws(() => changeClassifier(["jev", "--key"]), /--key needs a value/);
  assert.throws(() => changeClassifier(["jev", "--bogus"]), /unexpected --bogus/);
  assert.equal(existsSync(configPath()), false);
  assert.equal(existsSync(agentsocksEnvPath()), false);
});

test("classifier jev --key-file records the path (relative made absolute, ~/ kept) and warns when the file has no key", () => {
  const dir = sandbox();
  const keyFile = join(dir, "typesafe.env");
  writeFileSync(keyFile, "TYPESAFE_API_KEY=from-that-file\n");
  const ok = changeClassifier(["jev", "--key-file", keyFile]);
  assert.equal(readJson(configPath()).classifier.apiKeyFile, keyFile);
  assert.match(ok.at(-1)!, /^Smart routing: TypeSafe Jev/);
  assert.ok(!ok.join("\n").includes("from-that-file"));
  const empty = join(dir, "empty.env");
  writeFileSync(empty, "SOMETHING_ELSE=1\n");
  const warned = changeClassifier(["jev", "--key-file", empty]);
  assert.match(warned.join("\n"), /has no TYPESAFE_API_KEY line yet/);
  const relative = changeClassifier(["jev", "--key-file", "keys-here.env"]);
  assert.equal(readJson(configPath()).classifier.apiKeyFile, join(process.cwd(), "keys-here.env"));
  assert.match(relative.join("\n"), /keys-here\.env has no TYPESAFE_API_KEY line yet/);
  changeClassifier(["jev", "--key-file", "~/.config/typesafe/jev.env"]);
  assert.equal(readJson(configPath()).classifier.apiKeyFile, "~/.config/typesafe/jev.env");
});

test("classifier local points at your own hardware: loopback needs nothing, another host must be https and is allowed remote on purpose", () => {
  sandbox();
  changeClassifier(["local", "http://127.0.0.1:8765"]);
  assert.deepEqual(readJson(configPath()).classifier, { backend: "systemone", url: "http://127.0.0.1:8765" });
  const out = changeClassifier(["local", "http://localhost:8765", "--backend", "gliner2"]);
  assert.deepEqual(readJson(configPath()).classifier, { backend: "gliner2", url: "http://localhost:8765" });
  assert.match(out.at(-1)!, /^Smart routing: gliner2 at localhost:8765 on this machine/);
  assert.throws(() => changeClassifier(["local", "https://laya.internal.example:8443"]), /laya\.internal\.example:8443 is not this machine.*run the command again with --allow-remote/);
  assert.equal(readJson(configPath()).classifier.url, "http://localhost:8765", "a refused remote changes nothing");
  const remote = changeClassifier(["local", "https://laya.internal.example:8443", "--allow-remote"]);
  assert.deepEqual(readJson(configPath()).classifier, { backend: "systemone", url: "https://laya.internal.example:8443", allowRemote: true });
  assert.match(remote.join("\n"), /laya\.internal\.example:8443 is not this machine/);
  assert.throws(() => changeClassifier(["local", "https://user:pw@laya.internal.example", "--allow-remote"]), /must not carry a user name or password/);
  assert.throws(() => changeClassifier(["local", "http://user:pw@127.0.0.1:8765"]), /must not carry a user name or password/);
  assert.throws(() => changeClassifier(["local", "http://10.0.0.5:8765"]), /must be https/);
  assert.throws(() => changeClassifier(["local", "ftp://box"]), /http or https/);
  assert.throws(() => changeClassifier(["local", "not a url"]), /not a valid URL/);
  assert.throws(() => changeClassifier(["local"]), /a url is needed/);
  assert.throws(() => changeClassifier(["local", "http://127.0.0.1:1", "--backend", "gpt"]), /--backend must be/);
  assert.equal(readJson(configPath()).classifier.url, "https://laya.internal.example:8443", "a refused command changes nothing");
});

test("classifier off writes backend none, which stays off even with a key; jev switches it back on", () => {
  sandbox();
  process.env.TYPESAFE_API_KEY = "present";
  changeClassifier(["off"]);
  assert.deepEqual(readJson(configPath()), { classifier: { backend: "none" } });
  const e = effectiveConfig();
  assert.deepEqual([e.source, e.classifier.backend], ["file", "none"]);
  assert.equal(routingLine(e), "Smart routing is off (rules only). Change it with `agentsocks classifier`.");
  assert.match(changeClassifier(["jev"]).at(-1)!, /^Smart routing: TypeSafe Jev/);
  assert.throws(() => changeClassifier(["off", "now"]), /unexpected argument/);
  assert.throws(() => changeClassifier(["teleport"]), /unknown classifier command "teleport"[\s\S]*agentsocks classifier jev/);
});

test("a config that is not valid JSON is never overwritten", () => {
  sandbox();
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ my notes, not json");
  assert.throws(() => changeClassifier(["off"]), /not valid JSON; fix or remove it/);
  assert.equal(readFileSync(path, "utf8"), "{ my notes, not json");
  writeFileSync(path, "[1,2]");
  assert.throws(() => changeClassifier(["off"]), /must contain a JSON object/);
  assert.equal(readFileSync(path, "utf8"), "[1,2]");
});

test("a running daemon's watcher sees each change without a restart", () => {
  sandbox();
  const current = watchClassifier(() => {});
  assert.equal(current(), undefined);
  changeClassifier(["jev", "--key", "watched-key"]);
  assert.equal(current()!.name, "systemone");
  changeClassifier(["local", "http://127.0.0.1:9", "--backend", "gliner2"]);
  assert.equal(current()!.name, "gliner2");
  changeClassifier(["off"]);
  assert.equal(current(), undefined);
});

test("the CLI runs the subcommands, exits 1 with a message on a bad one, and never prints the key", async () => {
  const dir = sandbox();
  const env = { ...process.env, AGENTSOCKS_CONFIG: configPath(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME! };
  const run = async (...args: string[]) => {
    try {
      const r = await exec(process.execPath, [cli, "classifier", ...args], { env, timeout: 30_000 });
      return { code: 0, out: r.stdout, err: r.stderr };
    } catch (e) {
      const x = e as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof x.code === "number" ? x.code : 1, out: x.stdout ?? "", err: x.stderr ?? "" };
    }
  };
  const set = await run("jev", "--key", "cli-secret-key-123");
  assert.equal(set.code, 0, set.err);
  assert.ok(!(set.out + set.err).includes("cli-secret-key-123"));
  assert.equal(readFileSync(join(dir, "xdg", "agentsocks", "env"), "utf8"), "TYPESAFE_API_KEY=cli-secret-key-123\n");
  const shown = await run();
  assert.match(shown.out, /classifier: systemone, active, REMOTE/);
  assert.match(shown.out, /api key: found in the agentsocks env file \(TYPESAFE_API_KEY\)/);
  assert.ok(!(shown.out + shown.err).includes("cli-secret-key-123"));
  assert.equal((await run("off")).code, 0);
  assert.deepEqual(readJson(configPath()), { classifier: { backend: "none" } });
  const bad = await run("local");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /a url is needed/);
  assert.equal((await run("sideways")).code, 1);
});

test("--key=value works, a stray flag's value is never echoed, and --key - reads the key from stdin", () => {
  sandbox();
  changeClassifier(["jev", "--key=eq-form-key-1"]);
  assert.equal(readFileSync(agentsocksEnvPath(), "utf8"), "TYPESAFE_API_KEY=eq-form-key-1\n");
  let message = "";
  try {
    changeClassifier(["jev", cat("--bogus=sk_", "live_notreallyasecret")]);
  } catch (err) {
    message = (err as Error).message;
  }
  assert.match(message, /unexpected --bogus\./);
  assert.ok(!message.includes("notreallyasecret"), message);
  const dir = process.env.XDG_CONFIG_HOME!;
  const piped = spawnSync(process.execPath, [cli, "classifier", "jev", "--key", "-"], { input: "key-from-stdin-9\n", env: { ...process.env, XDG_CONFIG_HOME: dir, AGENTSOCKS_CONFIG: configPath() }, encoding: "utf8" });
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(readFileSync(agentsocksEnvPath(), "utf8"), "TYPESAFE_API_KEY=key-from-stdin-9\n");
  assert.ok(!(piped.stdout + piped.stderr).includes("key-from-stdin-9"));
});

test("a config that cannot be rewritten leaves the stored key alone, and ~/ in --key-file means the temporary HOME", () => {
  sandbox();
  mkdirSync(dirname(agentsocksEnvPath()), { recursive: true });
  writeFileSync(agentsocksEnvPath(), "TYPESAFE_API_KEY=original\n", { mode: 0o600 });
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), "{ not json");
  assert.throws(() => changeClassifier(["jev", "--key", "replacement"]), /not valid JSON/);
  assert.equal(readFileSync(agentsocksEnvPath(), "utf8"), "TYPESAFE_API_KEY=original\n");
  rmSync(configPath());
  const homeRelative = changeClassifier(["jev", "--key-file", "~/.config/typesafe/jev.env"]);
  assert.match(homeRelative.join("\n"), /has no TYPESAFE_API_KEY line yet/, "~/ is the temporary HOME, where that file does not exist");
});

test("the show output strips credentials from a configured url, and config does not take change arguments", async () => {
  sandbox();
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ classifier: { backend: "gliner2", url: "http://user:hunter22@127.0.0.1:8765" } }));
  const env = { ...process.env, AGENTSOCKS_CONFIG: configPath(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME! };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  for (const args of [["classifier"], ["classifier", "--json"], ["config"]]) {
    const r = run(...args);
    assert.ok(!(r.stdout + r.stderr).includes("hunter22"), args.join(" "));
    assert.match(r.stdout, /127\.0\.0\.1:8765/);
  }
  const alias = run("config", "jev", "--key", "x");
  assert.equal(alias.status, 1);
  assert.match(alias.stderr, /config only shows the classifier/);
  assert.equal(existsSync(agentsocksEnvPath()), false, "nothing was stored");
});

test("classifier writes through a symlinked config.json and a symlinked env file instead of replacing the links", () => {
  const dir = sandbox();
  const store = join(dir, "dotfiles");
  mkdirSync(store, { recursive: true });
  mkdirSync(dirname(configPath()), { recursive: true });
  mkdirSync(dirname(agentsocksEnvPath()), { recursive: true });
  const realConfig = join(store, "agentsocks-config.json");
  const realEnv = join(store, "agentsocks-env");
  writeFileSync(realConfig, JSON.stringify({ keep: { me: true }, classifier: { backend: "none" } }));
  writeFileSync(realEnv, "OTHER=1\n", { mode: 0o600 });
  symlinkSync(realConfig, configPath());
  symlinkSync(realEnv, agentsocksEnvPath());
  const out = changeClassifier(["jev", "--key", "stored-through-a-link-1"]);
  assert.ok(lstatSync(configPath()).isSymbolicLink(), "config.json is still a link");
  assert.ok(lstatSync(agentsocksEnvPath()).isSymbolicLink(), "the env file is still a link");
  assert.equal(readlinkSync(configPath()), realConfig);
  assert.equal(readJson(realConfig).classifier.backend, "systemone");
  assert.deepEqual(readJson(realConfig).keep, { me: true });
  assert.equal(readFileSync(realEnv, "utf8"), "OTHER=1\nTYPESAFE_API_KEY=stored-through-a-link-1\n");
  assert.equal(statSync(realEnv).mode & 0o777, 0o600);
  assert.match(out[0]!, new RegExp(`\\(through the symlink to ${realpathSync(realConfig).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  assert.deepEqual(readdirSync(store).sort(), ["agentsocks-config.json", "agentsocks-env"], "no temporary file is left next to the target");
  changeClassifier(["off"]);
  assert.ok(lstatSync(configPath()).isSymbolicLink());
  assert.equal(readJson(realConfig).classifier.backend, "none");
});

test("a dangling config.json symlink is written at its target", () => {
  const dir = sandbox();
  const target = join(dir, "dotfiles", "later.json");
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(dirname(configPath()), { recursive: true });
  symlinkSync(target, configPath());
  changeClassifier(["off"]);
  assert.ok(lstatSync(configPath()).isSymbolicLink());
  assert.equal(readJson(target).classifier.backend, "none");
});

test("the classifier command says which source holds the key in use, and that the environment's is ignored while a stored one exists", async () => {
  sandbox();
  mkdirSync(dirname(agentsocksEnvPath()), { recursive: true });
  writeFileSync(agentsocksEnvPath(), "TYPESAFE_API_KEY=stored-key-1\n", { mode: 0o600 });
  const base = { ...process.env, AGENTSOCKS_CONFIG: configPath(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME! };
  const run = async (env: Record<string, string | undefined>, ...args: string[]) => (await exec(process.execPath, [cli, "classifier", ...args], { env: { ...base, ...env } as Record<string, string>, timeout: 30_000 })).stdout;
  const both = await run({ TYPESAFE_API_KEY: "shell-key-2" });
  assert.match(both, /api key: found in the agentsocks env file \(TYPESAFE_API_KEY\); the TYPESAFE_API_KEY in the environment is ignored/);
  assert.ok(!both.includes("shell-key-2") && !both.includes("stored-key-1"));
  assert.match(JSON.parse(await run({ TYPESAFE_API_KEY: "shell-key-2" }, "--json")).classifier.apiKey, /^found in the agentsocks env file \(TYPESAFE_API_KEY\); the TYPESAFE_API_KEY in the environment is ignored$/);
  rmSync(agentsocksEnvPath());
  assert.match(await run({ TYPESAFE_API_KEY: "shell-key-2" }), /api key: not used \(the TYPESAFE_API_KEY in the environment is ignored until you run `agentsocks classifier jev`\)\n/);
  changeClassifier(["jev"]);
  assert.match(await run({ TYPESAFE_API_KEY: "shell-key-2" }), /api key: found in the environment \(TYPESAFE_API_KEY\)\n/);
});

test("no hint in the classifier output asks for the key on the command line", async () => {
  sandbox();
  const env = { ...process.env, AGENTSOCKS_CONFIG: configPath(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME! } as Record<string, string>;
  const shown = (await exec(process.execPath, [cli, "classifier"], { env, timeout: 30_000 })).stdout;
  const help = (await exec(process.execPath, [cli, "help"], { env, timeout: 30_000 })).stdout;
  for (const text of [shown, help, routingLine(), CHANGE_COMMANDS.join("\n")]) {
    assert.doesNotMatch(text, /--key <key>/);
    assert.match(text, /--key -/);
  }
});

test("the two ways the README gives a key work as written, one from a file and one piped in with no trailing newline", () => {
  const dir = sandbox();
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const block = readme.split("**Turn it on.**")[1]!.split("```")[1]!;
  const commands = block.split("\n").filter((line) => line.startsWith("agentsocks ") || line.startsWith("printf "));
  assert.equal(commands.length, 2, block);
  assert.ok(!readme.includes("press Ctrl-D"), "pasting at a bare prompt is not offered");
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(dir, "home", "typesafe.env"), "TYPESAFE_API_KEY=key-from-the-file-form\n", { mode: 0o600 });
  const env = { ...process.env, TYPESAFE_API_KEY: "key-from-the-pipe-form" };
  const run = (command: string) => spawnSync("sh", ["-c", command.replace("agentsocks ", `"${process.execPath}" "${cli}" `)], { env, encoding: "utf8" });

  const fromFile = run(commands.find((c) => c.includes("--key-file"))!);
  assert.equal(fromFile.status, 0, fromFile.stderr);
  assert.equal(readJson(configPath()).classifier.apiKeyFile, join(dir, "home", "typesafe.env"));
  assert.equal(findApiKey(effectiveConfig().classifier)?.from, "apiKeyFile");
  assert.ok(!(fromFile.stdout + fromFile.stderr).includes("key-from-the-file-form"));

  const piped = run(commands.find((c) => c.startsWith("printf "))!);
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(readFileSync(agentsocksEnvPath(), "utf8"), "TYPESAFE_API_KEY=key-from-the-pipe-form\n");
  assert.equal(findApiKey(effectiveConfig().classifier)?.from, "env file");
  assert.ok(!(piped.stdout + piped.stderr).includes("key-from-the-pipe-form"));
});
