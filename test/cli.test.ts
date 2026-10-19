import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fakeClaude, livePid, root, shimmedEnv, until, type FakeClaude } from "./support.ts";
import { Broker } from "../src/broker.ts";
import { closeServer } from "../src/ccsocks.ts";
import { namesClaude } from "../src/claude.ts";
import { processArgs } from "../src/procinfo.ts";
import { encodeAddress } from "../src/envelope.ts";
import { agentsocksEnvPath, threadSocketPath } from "../src/paths.ts";
import { tempDir } from "./tmp.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const broker = new Broker();
let alpha: FakeClaude;

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return runWith({}, ...args);
}

type Result = { code: number; out: string; err: string };

async function launch(file: string, argv: string[], extra: Record<string, string>): Promise<Result> {
  const env = { ...process.env, ...extra } as Record<string, string | undefined>;
  if (!extra.CODEX_THREAD_ID) delete env.CODEX_THREAD_ID;
  try {
    const r = await exec(file, argv, { env: env as NodeJS.ProcessEnv, timeout: 30_000 });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

async function runWith(extra: Record<string, string>, ...args: string[]): Promise<Result> {
  return launch(process.execPath, [cli, ...args], extra);
}

const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
const hasUtilLinuxScript = process.platform === "linux" && spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

async function atTerminal(extra: Record<string, string>, ...args: string[]): Promise<Result> {
  const command = [process.execPath, cli, ...args].map(quote).join(" ");
  const r = await launch("script", ["-qec", command, "/dev/null"], extra);
  return { ...r, out: r.out.replaceAll("\r\n", "\n") };
}

before(async () => {
  await broker.start();
  alpha = await fakeClaude("alpha", livePid(), "busy");
});

after(async () => {
  await closeServer(alpha.server);
  await broker.stop();
});

test("send takes --urgency and says how the message was routed", async () => {
  const r = await run("send", "--urgency", "fyi", "alpha", "FYI from the shell");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^sent [0-9a-f-]{36} to @alpha .*routed digest/m);
  assert.match(r.out, /Batched with other low-priority messages\./);
  const bad = await run("send", "--urgency", "yesterday", "alpha", "x");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--urgency must be urgent, normal or fyi/);
  const plain = await run("send", "alpha", "plain message to a busy session");
  assert.match(plain.out, /routed now/);
});

test("status <msg-id> explains the routing; status <peer> shows the session; plain status is still broker health", async () => {
  const sent = await run("send", "--urgency", "fyi", "alpha", "another FYI");
  const id = sent.out.match(/sent ([0-9a-f-]{36})/)![1]!;
  const msg = await run("status", id);
  assert.equal(msg.code, 0, msg.err);
  assert.match(msg.out, new RegExp(`${id}: held \\(to @alpha, claude\\)`));
  assert.match(msg.out, /The sender marked it as FYI/);
  const json = JSON.parse((await run("status", id, "--json")).out);
  assert.equal(json.status, "held");
  assert.ok(!("body" in json));
  const peer = await run("status", "alpha");
  assert.equal(peer.code, 0, peer.err);
  assert.match(peer.out, /@alpha \(claude\) is busy/);
  assert.match(peer.out, /1 held in a digest|2 held in a digest|held in a digest/);
  const health = JSON.parse((await run("status")).out);
  assert.equal(typeof health.pid, "number");
  assert.equal((await run("status", "no-such-peer")).code, 1);
});

test("tasks need a session identity; stats print for a shell user, as text and as JSON", async () => {
  const none = await run("tasks");
  assert.equal(none.code, 1, "a shell with no session has no tasks to list, and never gets everyone's");
  assert.match(none.err, /tasks are listed for a session: run this from inside a Claude Code or Codex session/);
  const stats = await run("stats");
  assert.equal(stats.code, 0, stats.err);
  assert.match(stats.out, /@alpha \(claude\): \d+ messages/);
  const statsJson = JSON.parse((await run("stats", "alpha", "--json")).out);
  assert.equal(statsJson.destinations[0].to.name, "alpha");
  assert.equal((await run("tasks", "--all", "--json")).code, 1);
  assert.equal((await run("tasks", "T-abcdef")).code, 1);
});

test("classifier (and its alias config) shows the classifier in effect, the key state and why a remote one is refused", async () => {
  const path = process.env.AGENTSOCKS_CONFIG!;
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const none = await run("classifier");
  assert.match(none.out, /not present/);
  assert.match(none.out, /classifier: none chosen\. Hosted TypeSafe Jev turns on only after `agentsocks classifier jev`/);
  assert.match(none.out, /api key: not used\n/);
  assert.match(none.out, /Smart routing is off\. To turn on TypeSafe Jev, get a key at https:\/\/console\.typesafe\.ai\/keys/);
  assert.match(none.out, /agentsocks classifier jev/);
  assert.match(none.out, /agentsocks classifier local <url>/);
  assert.match(none.out, /agentsocks classifier off/);
  assert.equal((await run("config")).out, none.out, "config is an alias");
  const withKey = await runWith({ TYPESAFE_API_KEY: "k-never-printed" }, "classifier");
  assert.match(withKey.out, /classifier: none chosen\./);
  assert.match(withKey.out, /api key: not used \(the TYPESAFE_API_KEY in the environment is ignored until you run `agentsocks classifier jev`\)/);
  assert.match(withKey.out, /Smart routing is off: a TYPESAFE_API_KEY is in your environment; run `agentsocks classifier jev --key-file <file>` \(or pipe it with --key -\) to turn on smart routing\./);
  assert.doesNotMatch(withKey.out + withKey.err, /k-never-printed/);
  writeFileSync(path, JSON.stringify({ classifier: { backend: "systemone", url: "https://api.typesafe.ai", model: "jev-latest", apiKeyEnv: "TYPESAFE_API_KEY", allowRemote: true } }));
  const optedIn = await runWith({ TYPESAFE_API_KEY: "k-never-printed" }, "classifier");
  assert.match(optedIn.out, /classifier: systemone, active, REMOTE \(message text leaves this machine for api\.typesafe\.ai\)/);
  assert.match(optedIn.out, /api key: found in the environment \(TYPESAFE_API_KEY\)/);
  assert.doesNotMatch(optedIn.out + optedIn.err, /k-never-printed/);
  writeFileSync(path, JSON.stringify({ classifier: { backend: "none" } }));
  assert.match((await runWith({ TYPESAFE_API_KEY: "k" }, "classifier")).out, /classifier: none/);
  writeFileSync(path, JSON.stringify({ classifier: { backend: "systemone", url: "https://api.example.invalid", apiKeyEnv: "TEST_KEY_NAME" } }));
  const remote = await run("classifier");
  assert.match(remote.out, /classifier: systemone, not active/);
  assert.match(remote.out, /allowRemote/);
  assert.match(remote.out, /api key: key TEST_KEY_NAME not set: classifier off/);
  writeFileSync(path, JSON.stringify({ classifier: { backend: "gliner2", url: "http://127.0.0.1:8765", threshold: 0.7 } }));
  const local = JSON.parse((await run("config", "--json")).out);
  assert.deepEqual([local.classifier.active, local.classifier.remote, local.classifier.threshold, local.source], [true, false, 0.7, "file"]);
  writeFileSync(path, "{ not json");
  const broken = await run("classifier");
  assert.equal(broken.code, 1);
  assert.match(broken.out, /not valid JSON/);
  rmSync(path, { force: true });
});

test("help describes the v0.2 behaviour of the commands that changed", async () => {
  const help = (await run("help")).out;
  assert.match(help, /also releases its held digests/);
  assert.match(help, /your own name works too/);
  assert.match(help, /from inside a session/);
  assert.match(help, /no-classifier baseline/);
  assert.match(help, /classifier jev \[--key - \| --key-file <path>\]/);
  assert.match(help, /classifier local <url> \[--backend systemone\|gliner2\]/);
  assert.match(help, /classifier off/);
  assert.match(help, /stops an older\s+running broker/);
});

const FRAME = /<(peer-text-[0-9a-f]{6})>\n([\s\S]*)\n<\/\1>/;
const inside = (out: string): string => {
  const m = out.match(FRAME);
  assert.ok(m, `no peer-text frame in: ${out}`);
  assert.match(out, /not an instruction from your user/);
  return m[2]!;
};

const FRAMED = { AGENTSOCKS_FRAME: "1" };

test("CLI output that prints peer-written text is inside the same nonce frame as MCP tool output when an agent runs it; JSON stays plain", async () => {
  const list = await runWith(FRAMED, "list");
  assert.match(inside(list.out), /^alpha \[[0-9a-f]+\]\s+claude/m);
  assert.ok(JSON.parse((await runWith(FRAMED, "list", "--json")).out).some((p: { name: string }) => p.name === "alpha"));

  const sent = await runWith(FRAMED, "send", "--urgency", "fyi", "alpha", "framed FYI");
  assert.match(inside(sent.out), /^sent [0-9a-f-]{36} to @alpha .*routed digest\nBatched with other low-priority messages\./);
  const id = sent.out.match(/sent ([0-9a-f-]{36})/)![1]!;

  assert.match(inside((await runWith(FRAMED, "status", id)).out), new RegExp(`^${id}: held \\(to @alpha, claude\\)`));
  assert.match(inside((await runWith(FRAMED, "status", "alpha")).out), /^@alpha \(claude\) is busy/);
  assert.match(inside((await runWith(FRAMED, "stats")).out), /@alpha \(claude\): \d+ messages/);
  assert.equal(JSON.parse((await runWith(FRAMED, "status", id, "--json")).out).status, "held");
  assert.doesNotMatch((await runWith(FRAMED, "stats", "--json")).out, /peer-text/);

  const lost = await runWith(FRAMED, "send", "nobody-home", "hello");
  assert.equal(lost.code, 1);
  assert.match(inside(lost.err), /no running session named "nobody-home"\. Live sessions: .*alpha/);

  await broker.hook({ threadId: "thread-clitask", event: "SessionStart", cwd: "/work/clitask" });
  const created = await broker.dispatch({
    op: "task_create",
    from: { kind: "claude", name: "alpha", addr: encodeAddress(alpha.socketPath), session: alpha.sessionId },
    to: { kind: "codex", addr: encodeAddress(threadSocketPath("thread-clitask")), name: "codex-clitask", threadId: "thread-clitask" },
    title: "Check the framing",
    body: "Run the framing checks.",
  });
  const taskId = (created.result as { task: { id: string } }).task.id;
  const tasks = await runWith({ CODEX_THREAD_ID: "thread-clitask" }, "tasks");
  assert.equal(tasks.code, 0, tasks.err);
  assert.match(inside(tasks.out), new RegExp(`^${taskId} \\[open\\] Check the framing`));
  assert.equal(JSON.parse((await runWith({ CODEX_THREAD_ID: "thread-clitask" }, "tasks", "--json")).out)[0].id, taskId);
  assert.equal((await runWith({ CODEX_THREAD_ID: "thread-clitask" }, "tasks", "--created")).out.trim(), "No tasks.", "an empty list is plain text");
});

test("a caller whose output is not a terminal gets the frame whether or not it was recognised as an agent; --json is never framed", async () => {
  const list = await run("list");
  assert.match(inside(list.out), /^alpha \[[0-9a-f]+\]\s+claude/m);
  assert.match(inside((await run("stats")).out), /@alpha \(claude\): \d+ messages?/);
  assert.match(inside((await run("status", "alpha")).out), /^@alpha \(claude\) is busy/);

  const lost = await run("send", "nobody-home", "hello");
  assert.equal(lost.code, 1);
  assert.match(lost.err, /^agentsocks: no recipient chosen\.\n/);
  assert.match(inside(lost.err), /^no running session named "nobody-home"\. Live sessions: .*alpha/);

  assert.match(inside((await runWith({ CODEX_THREAD_ID: "thread-l8" }, "list")).out), /^alpha \[/m);
  assert.match(inside((await runWith({ AGENTSOCKS_FRAME: "1" }, "list")).out), /^alpha \[/m);
  assert.match(inside((await runWith({ AGENTSOCKS_FRAME: "0" }, "list")).out), /^alpha \[/m, "AGENTSOCKS_FRAME=0 is not an opt-out");

  const variants: Record<string, string>[] = [{}, { CODEX_THREAD_ID: "thread-l8" }, { AGENTSOCKS_FRAME: "1" }, { AGENTSOCKS_FRAME: "0" }];
  for (const extra of variants) {
    const json = await runWith(extra, "list", "--json");
    assert.ok(JSON.parse(json.out).some((p: { name: string }) => p.name === "alpha"));
    assert.doesNotMatch(json.out, /peer-text/);
  }
});

test("a Claude Code ancestor makes the caller an agent, so the output is framed without any variable", async () => {
  const me = await fakeClaude("l8-owner", process.pid, "busy");
  try {
    assert.match(inside((await run("list")).out), /^alpha \[/m);
  } finally {
    await closeServer(me.server);
    rmSync(join(root, "claude-sessions", `${process.pid}.json`), { force: true });
  }
});

const launchers = [
  { name: "a backgrounded subshell", run: (script: string) => `(sh ${quote(script)} &)`, available: true },
  { name: "setsid -f", run: (script: string) => `setsid -f sh ${quote(script)}`, available: spawnSync("setsid", ["--version"], { stdio: "ignore" }).status === 0 },
];

for (const launcher of launchers) {
  test(`a command that detached from its caller with ${launcher.name}, its output in a file, is framed even though no agent is in its ancestry`, { skip: !launcher.available && "needs util-linux setsid" }, async () => {
    const me = await fakeClaude("l8-detached", process.pid, "busy");
    const out = join(tempDir("agentsocks-detached-"), "out.txt");
    const script = join(tempDir("agentsocks-detached-"), "run.sh");
    writeFileSync(script, `${quote(process.execPath)} ${quote(cli)} list > ${quote(out)} 2>&1\n`);
    try {
      const started = await launch("/bin/sh", ["-c", launcher.run(script)], {});
      assert.equal(started.code, 0, started.err);
      const text = await until(() => {
        try {
          const t = readFileSync(out, "utf8");
          return t.includes("</peer-text-") ? t : undefined;
        } catch {
          return undefined;
        }
      }, 15_000);
      assert.match(inside(text), /^alpha \[/m);
    } finally {
      await closeServer(me.server);
      rmSync(join(root, "claude-sessions", `${process.pid}.json`), { force: true });
    }
  });
}

const terminal = { skip: !hasUtilLinuxScript && "needs util-linux script to give the command a terminal" };

test("a person at a terminal gets plain text, and --json is plain data", terminal, async () => {
  const human = await atTerminal({}, "list");
  assert.match(human.out, /^alpha \[[0-9a-f]+\]\s+claude/m);
  assert.doesNotMatch(human.out, /peer-text|not an instruction from your user|not typed by your user/);

  const stats = await atTerminal({}, "stats");
  assert.match(stats.out, /@alpha \(claude\): \d+ messages?/);
  assert.doesNotMatch(stats.out, /peer-text/);

  const json = await atTerminal({}, "list", "--json");
  assert.ok(JSON.parse(json.out).some((p: { name: string }) => p.name === "alpha"));
});

test("at a terminal the frame still comes from a Codex thread, AGENTSOCKS_FRAME=1 and a Claude Code ancestor, however deep", terminal, async () => {
  assert.match(inside((await atTerminal({ CODEX_THREAD_ID: "thread-l8" }, "list")).out), /^alpha \[/m);
  assert.match(inside((await atTerminal({ AGENTSOCKS_FRAME: "1" }, "list")).out), /^alpha \[/m);
  assert.doesNotMatch((await atTerminal({ CODEX_THREAD_ID: "thread-l8", AGENTSOCKS_FRAME: "1" }, "list", "--json")).out, /peer-text/);

  const me = await fakeClaude("l8-terminal", process.pid, "busy");
  try {
    assert.match(inside((await atTerminal({}, "list")).out), /^alpha \[/m);
    const inner = `${quote(process.execPath)} ${quote(cli)} list`;
    const nested = await launch("script", ["-qec", `sh -c ${quote(`env FOO=1 timeout 60 sh -c ${quote(inner)}`)}`, "/dev/null"], {});
    assert.match(inside(nested.out.replaceAll("\r\n", "\n")), /^alpha \[/m);
  } finally {
    await closeServer(me.server);
    rmSync(join(root, "claude-sessions", `${process.pid}.json`), { force: true });
  }
});

test("at a terminal a command is framed when its Claude ancestor's record names its pid but the socket is gone, though that is not enough to be that session", terminal, async () => {
  const file = join(root, "claude-sessions", `${process.pid}.json`);
  mkdirSync(join(root, "claude-sessions"), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: "i6-session", name: "i6-claude", cwd: "/work/i6", messagingSocketPath: join(root, "cc-socks", "i6-gone.sock"), kind: "interactive" }));
  try {
    assert.match(inside((await atTerminal({}, "list")).out), /^alpha \[/m);
    assert.equal(JSON.parse((await atTerminal({}, "whoami")).out).kind, "cli");
  } finally {
    rmSync(file, { force: true });
  }
});

test("an error that names live sessions is plain for a person at a terminal and framed for an agent", terminal, async () => {
  const human = await atTerminal({}, "send", "nobody-home", "hello");
  assert.match(human.out, /no recipient chosen\.\nno running session named "nobody-home"\. Live sessions: .*alpha/);
  assert.doesNotMatch(human.out, /peer-text/);
  const agent = await atTerminal({ AGENTSOCKS_FRAME: "1" }, "send", "nobody-home", "hello");
  assert.match(inside(agent.out), /no running session named "nobody-home"\. Live sessions: .*alpha/);
});

test("agentsocks send from inside a Claude session to a Claude session prints the built-in SendMessage advice and exits 1; to Codex and from a plain shell it still sends", async () => {
  const framesBefore = alpha.frames.length;
  const fromShell = await run("send", "alpha", "from a plain shell");
  assert.equal(fromShell.code, 0, fromShell.err);
  await until(() => alpha.frames.length > framesBefore);
  const framesAfterShell = alpha.frames.length;

  const me = await fakeClaude("cli-owner", process.pid, "busy");
  await broker.hook({ threadId: "thread-clij9", event: "SessionStart", cwd: "/work/clij9" });
  try {
    const refused = await run("send", "alpha", "via agentsocks from a Claude session");
    assert.equal(refused.code, 1);
    assert.equal(refused.out, "");
    assert.equal(refused.err.trim(), `agentsocks: For Claude Code sessions use your built-in SendMessage with to: "alpha". It carries your permission mode, so the message is not held for the receiver's approval.`);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(alpha.frames.length, framesAfterShell, "nothing was posted to the Claude session");

    const toCodex = await run("send", "codex-clij9", "Codex targets are unchanged");
    assert.equal(toCodex.code, 0, toCodex.err);
    assert.match(toCodex.out, /sent [0-9a-f-]{36} to @codex-clij9 .*\(codex\) as @cli-owner/);
  } finally {
    await closeServer(me.server);
    rmSync(join(root, "claude-sessions", `${process.pid}.json`), { force: true });
  }
});

const pid1Skip = { skip: namesClaude(processArgs(1)) && "pid 1 is Claude Code on this machine" };

async function withRecordAtPid1(contents: string, run: () => Promise<void>): Promise<void> {
  const file = join(root, "claude-sessions", "1.json");
  mkdirSync(join(root, "claude-sessions"), { recursive: true });
  writeFileSync(file, contents);
  try {
    await run();
  } finally {
    rmSync(file, { force: true });
  }
}

const STALE_PID1_RECORD = JSON.stringify({ pid: 1, sessionId: "container-sess", name: "devcontainer-claude", cwd: "/workspace", messagingSocketPath: join(root, "does-not-exist.sock"), kind: "interactive" });

test("a record at pid 1 that is stale, has no socket path or is not JSON does not make a plain shell a Claude session", pid1Skip, async () => {
  assert.equal(JSON.parse((await run("whoami")).out).kind, "cli");
  for (const contents of [STALE_PID1_RECORD, '{"pid":1}', "garbage"]) {
    await withRecordAtPid1(contents, async () => {
      assert.equal(JSON.parse((await run("whoami")).out).kind, "cli", contents);
    });
  }
});

test("a record at pid 1 with a live socket does not make a plain shell a Claude session while pid 1 is not Claude Code", pid1Skip, async () => {
  const foreign = await fakeClaude("devcontainer-claude", 1, "idle");
  try {
    assert.equal(JSON.parse((await run("whoami")).out).kind, "cli");
  } finally {
    await closeServer(foreign.server);
    rmSync(join(root, "claude-sessions", "1.json"), { force: true });
  }
});

test("with a stale record at pid 1, a plain shell still sends to a Claude session", pid1Skip, async () => {
  const framesBefore = alpha.frames.length;
  await withRecordAtPid1(STALE_PID1_RECORD, async () => {
    const sent = await run("send", "alpha", "from a plain shell with a stale record at pid 1");
    assert.equal(sent.code, 0, sent.err);
    assert.match(sent.out, /sent [0-9a-f-]{36} to @alpha \[[0-9a-f]+\] \(claude\) as @cli-/);
    assert.doesNotMatch(sent.err, /built-in SendMessage/);
  });
  await until(() => alpha.frames.length > framesBefore);
});

const NO_KEY_LINE = "Smart routing is off. To turn on TypeSafe Jev, get a key at https://console.typesafe.ai/keys, then run `agentsocks classifier jev --key-file <file>` on a KEY=VALUE file, or pipe it in with `printf '%s' \"$TYPESAFE_API_KEY\" | agentsocks classifier jev --key -`, which keeps it out of your shell history. Rules still route every message.";
const AMBIENT_LINE = "Smart routing is off: a TYPESAFE_API_KEY is in your environment; run `agentsocks classifier jev --key-file <file>` (or pipe it with --key -) to turn on smart routing. Rules still route every message.";
const KEY_LINE = "Smart routing: TypeSafe Jev (grey-zone messages and the receiver's redacted task are sent to api.typesafe.ai). Change it with `agentsocks classifier`.";
const JEV_CONFIG = JSON.stringify({ classifier: { backend: "systemone", url: "https://api.typesafe.ai", model: "jev-latest", apiKeyEnv: "TYPESAFE_API_KEY", allowRemote: true } });

test("doctor prints one line about smart routing, with or without a key", async () => {
  rmSync(process.env.AGENTSOCKS_CONFIG!, { force: true });
  const shim = shimmedEnv();
  const without = await runWith(shim, "doctor");
  const lines = (r: { out: string }) => r.out.split("\n").filter((l) => l.startsWith("Smart routing"));
  assert.deepEqual(lines(without), [NO_KEY_LINE]);
  const withKey = await runWith({ ...shim, TYPESAFE_API_KEY: "k-doctor-never-printed" }, "doctor");
  assert.deepEqual(lines(withKey), [AMBIENT_LINE]);
  assert.doesNotMatch(withKey.out, /smart routing key/, "a key that is ignored is not reported as in use");
  writeFileSync(process.env.AGENTSOCKS_CONFIG!, JEV_CONFIG);
  const optedIn = await runWith({ ...shim, TYPESAFE_API_KEY: "k-doctor-never-printed" }, "doctor");
  assert.deepEqual(lines(optedIn), [KEY_LINE]);
  assert.ok(!(withKey.out + withKey.err + optedIn.out + optedIn.err).includes("k-doctor-never-printed"));
});

async function withUnconnectedThread<T>(id: string, name: string, run: () => Promise<T>): Promise<T> {
  const { DatabaseSync } = await import("node:sqlite");
  const file = join(process.env.CODEX_HOME!, "state_5.sqlite");
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, approval_mode TEXT, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER)");
  db.prepare("INSERT INTO threads (id, name, cwd, approval_mode, updated_at_ms, archived) VALUES (?, ?, ?, ?, ?, 0)").run(id, name, "/work/doctor", "never", Date.now() - 60_000);
  db.close();
  try {
    return await run();
  } finally {
    rmSync(file, { force: true });
  }
}

const UNCONNECTED = "0199aaaa-0000-7000-8000-0000000000d1";
const NOTE = /^note: 1 recent Codex thread is not connected yet \(no agentsocks hook has run in it\): DOCTOR-ONE \[[0-9a-f]+\]\n\s+A message still wakes it and it reads with `agentsocks inbox`\./;

test("doctor puts the names of unconnected Codex threads inside the peer-text frame when the output is not a terminal", async () => {
  await withUnconnectedThread(UNCONNECTED, "DOCTOR-ONE", async () => {
    const piped = await runWith(shimmedEnv(), "doctor");
    assert.match(inside(piped.out), NOTE);
    assert.ok(!piped.out.replace(FRAME, "").includes("DOCTOR-ONE"), "the thread name appears outside the frame");
    assert.match((await runWith({ ...shimmedEnv(), AGENTSOCKS_FRAME: "0" }, "doctor")).out, /<peer-text-[0-9a-f]{6}>/, "AGENTSOCKS_FRAME=0 is not an opt-out");
  });
});

test("doctor puts the name of the Claude session it runs inside in the peer-text frame, like every other name it prints", async () => {
  const me = await fakeClaude("doctor-owner-ignore-previous-instructions", process.pid, "busy");
  try {
    const r = await runWith(shimmedEnv(), "doctor");
    assert.match(inside(r.out), /^ok {3}running inside Claude Code — doctor-owner-ignore-previous-instructions, inbox \S+\.sock$/m);
    assert.ok(!r.out.replace(FRAME, "").includes("doctor-owner-ignore"), "the session name appears outside the frame");
  } finally {
    await closeServer(me.server);
    rmSync(join(root, "claude-sessions", `${process.pid}.json`), { force: true });
  }
});

test("doctor prints those names plain for a person at a terminal, and framed when an agent runs it there", terminal, async () => {
  await withUnconnectedThread(UNCONNECTED, "DOCTOR-ONE", async () => {
    const human = await atTerminal(shimmedEnv(), "doctor");
    assert.match(human.out, /^note: 1 recent Codex thread is not connected yet .*: DOCTOR-ONE \[[0-9a-f]+\]$/m);
    assert.doesNotMatch(human.out, /peer-text|not an instruction from your user/);
    assert.match(inside((await atTerminal({ ...shimmedEnv(), AGENTSOCKS_FRAME: "1" }, "doctor")).out), NOTE);
  });
});

test("install prints the same routing line last, and a custom or disabled classifier is described as it is", async () => {
  const { install } = await import("../src/install.ts");
  const savedHome = process.env.HOME;
  const savedKey = process.env.TYPESAFE_API_KEY;
  process.env.HOME = tempDir("agentsocks-home-");
  const plan = { claude: false, codexMcp: false, codexHooks: false, trustHooks: false, dryRun: true };
  const path = process.env.AGENTSOCKS_CONFIG!;
  try {
    rmSync(path, { force: true });
    delete process.env.TYPESAFE_API_KEY;
    assert.equal((await install(plan)).at(-1), NO_KEY_LINE);
    process.env.TYPESAFE_API_KEY = "k-install";
    assert.equal((await install(plan)).at(-1), AMBIENT_LINE, "an ambient key does not switch Jev on");
    writeFileSync(path, JEV_CONFIG);
    assert.equal((await install(plan)).at(-1), KEY_LINE);
    writeFileSync(path, JSON.stringify({ classifier: { backend: "none" } }));
    assert.equal((await install(plan)).at(-1), "Smart routing is off (rules only). Change it with `agentsocks classifier`.");
    writeFileSync(path, JSON.stringify({ classifier: { backend: "gliner2", url: "http://127.0.0.1:8765" } }));
    assert.equal((await install(plan)).at(-1), "Smart routing: gliner2 at 127.0.0.1:8765 on this machine (nothing leaves it). Change it with `agentsocks classifier`.");
    writeFileSync(path, "{ broken");
    assert.match((await install(plan)).at(-1)!, /^Smart routing is off: .*not valid JSON\. Rules still route every message\./);
  } finally {
    rmSync(path, { force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedKey;
  }
});

test("doctor reports which source holds the key in use", async () => {
  rmSync(process.env.AGENTSOCKS_CONFIG!, { force: true });
  const shim = shimmedEnv();
  const ignored = await runWith({ ...shim, TYPESAFE_API_KEY: "k-doctor-shell" }, "doctor");
  assert.doesNotMatch(ignored.out, /smart routing key/, "an ambient key alone is not in use");
  writeFileSync(process.env.AGENTSOCKS_CONFIG!, JEV_CONFIG);
  const onlyEnvironment = await runWith({ ...shim, TYPESAFE_API_KEY: "k-doctor-shell" }, "doctor");
  assert.match(onlyEnvironment.out, /^ok   smart routing key — found in the environment \(TYPESAFE_API_KEY\)$/m);
  rmSync(process.env.AGENTSOCKS_CONFIG!, { force: true });
  mkdirSync(dirname(agentsocksEnvPath()), { recursive: true });
  writeFileSync(agentsocksEnvPath(), "TYPESAFE_API_KEY=k-doctor-stored\n", { mode: 0o600 });
  try {
    const both = await runWith({ ...shim, TYPESAFE_API_KEY: "k-doctor-shell" }, "doctor");
    assert.match(both.out, /^ok   smart routing key — found in the agentsocks env file \(TYPESAFE_API_KEY\); the TYPESAFE_API_KEY in the environment is ignored$/m);
    assert.ok(!(both.out + both.err).includes("k-doctor-stored") && !(both.out + both.err).includes("k-doctor-shell"));
    const lines = both.out.split("\n").filter((l) => l.startsWith("Smart routing"));
    assert.deepEqual(lines, [KEY_LINE]);
  } finally {
    rmSync(agentsocksEnvPath(), { force: true });
  }
  const none = await runWith(shim, "doctor");
  assert.doesNotMatch(none.out, /smart routing key/);
});

test("uninstall says the env file still holds the key and gives the exact command to remove it", async () => {
  const shim = shimmedEnv();
  const without = await runWith(shim, "uninstall", "--dry-run");
  assert.doesNotMatch(without.out, /holds your TypeSafe key/);
  mkdirSync(dirname(agentsocksEnvPath()), { recursive: true });
  writeFileSync(agentsocksEnvPath(), "TYPESAFE_API_KEY=k-uninstall-never-printed\n", { mode: 0o600 });
  try {
    const withKey = await runWith(shim, "uninstall", "--dry-run");
    assert.ok(withKey.out.includes(`key: ${agentsocksEnvPath()} holds your TypeSafe key and is left in place (mode 600). To remove it: rm '${agentsocksEnvPath()}'`), withKey.out);
    assert.ok(!(withKey.out + withKey.err).includes("k-uninstall-never-printed"));
  } finally {
    rmSync(agentsocksEnvPath(), { force: true });
  }
});

test("uninstall says the env file only may hold the key unless it has a key line", async () => {
  const shim = shimmedEnv();
  mkdirSync(dirname(agentsocksEnvPath()), { recursive: true });
  const remove = `To remove it: rm '${agentsocksEnvPath()}'`;
  try {
    for (const content of ["", "SOMETHING_ELSE=1\n", "# TYPESAFE_API_KEY=commented-out\n", "TYPESAFE_API_KEY=\n"]) {
      writeFileSync(agentsocksEnvPath(), content, { mode: 0o600 });
      const out = (await runWith(shim, "uninstall", "--dry-run")).out;
      assert.ok(out.includes(`key: ${agentsocksEnvPath()} may hold your TypeSafe key and is left in place (mode 600). ${remove}`), `${JSON.stringify(content)}: ${out}`);
      assert.doesNotMatch(out, / holds your TypeSafe key/);
    }
    writeFileSync(agentsocksEnvPath(), "export TYPESAFE_API_KEY='k-quoted'\n", { mode: 0o600 });
    assert.ok((await runWith(shim, "uninstall", "--dry-run")).out.includes(`${agentsocksEnvPath()} holds your TypeSafe key and is left in place`));
  } finally {
    rmSync(agentsocksEnvPath(), { force: true });
  }
});
