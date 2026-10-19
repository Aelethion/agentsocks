import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chain, fakeClaude, livePid, procSource, root, type FakeClaude } from "./support.ts";
import { closeServer } from "../src/ccsocks.ts";
import { findOwnClaudeSession, listClaudeSessions, namesClaude } from "../src/claude.ts";
import { processStart, type ProcSource } from "../src/procinfo.ts";

const started: FakeClaude[] = [];
after(async () => {
  for (const c of started) await closeServer(c.server);
});

async function claudeAt(pid: number, patch: Record<string, unknown> = {}): Promise<FakeClaude> {
  const c = started.find((x) => x.pid === pid) ?? (await fakeClaude(`claude-${pid}`, pid, "idle"));
  if (!started.includes(c)) started.push(c);
  const file = join(root, "claude-sessions", `${pid}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
  return c;
}

const statLine = (pid: number, comm: string, start: string, ppid = 1): string =>
  `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 1000000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;

const cmdline = (...args: string[]): string => `${args.join("\0")}\0`;

test("a registry record names this process's session only if its socket exists and is a socket", async () => {
  const c = await claudeAt(5101);
  assert.equal(findOwnClaudeSession(5101, chain({ 5101: 0 }), "linux", procSource({}))?.socketPath, c.socketPath);

  await claudeAt(5102, { messagingSocketPath: join(root, "never-created.sock") });
  assert.equal(findOwnClaudeSession(5102, chain({ 5102: 0 }), "linux", procSource({})), undefined, "no such file");

  const notSocket = join(root, "regular-file.sock");
  writeFileSync(notSocket, "");
  await claudeAt(5103, { messagingSocketPath: notSocket });
  assert.equal(findOwnClaudeSession(5103, chain({ 5103: 0 }), "linux", procSource({})), undefined, "a file that is not a socket");

  await claudeAt(5104, { messagingSocketPath: undefined });
  assert.equal(findOwnClaudeSession(5104, chain({ 5104: 0 }), "linux", procSource({})), undefined, "no socket path at all");
});

test("a record that fails the check does not hide the real session further up", async () => {
  await claudeAt(5111, { messagingSocketPath: join(root, "never-created.sock") });
  const real = await claudeAt(5112);
  assert.equal(findOwnClaudeSession(5110, chain({ 5110: 5111, 5111: 5112, 5112: 0 }), "linux", procSource({}))?.socketPath, real.socketPath);
});

test("a record whose file name and pid disagree names nobody", async () => {
  await claudeAt(5121, { pid: 5122 });
  assert.equal(findOwnClaudeSession(5121, chain({ 5121: 0 }), "linux", procSource({})), undefined);
});

test("on Linux a record with procStart has to match field 22 of /proc/<pid>/stat, and one that cannot be compared is refused", async () => {
  await claudeAt(5131, { procStart: "987654" });
  const stat = (start: string) => procSource({ "/proc/5131/stat": statLine(5131, "claude", start) });
  assert.equal(findOwnClaudeSession(5131, chain({ 5131: 0 }), "linux", stat("987654"))?.name, "claude-5131");
  assert.equal(findOwnClaudeSession(5131, chain({ 5131: 0 }), "linux", stat("987655")), undefined, "the pid was reused by another process");
  assert.equal(findOwnClaudeSession(5131, chain({ 5131: 0 }), "linux", procSource({})), undefined, "stat cannot be read");
  assert.equal(findOwnClaudeSession(5131, chain({ 5131: 0 }), "android", stat("987655"))?.name, "claude-5131", "Termux has /proc, but the comparison is not verified there");
  assert.equal(findOwnClaudeSession(5131, chain({ 5131: 0 }), "darwin", stat("987655"))?.name, "claude-5131", "off Linux there is no /proc to compare with");
  assert.equal((await claudeAt(5132)).name, "claude-5132");
  assert.equal(findOwnClaudeSession(5132, chain({ 5132: 0 }), "linux", procSource({}))?.name, "claude-5132", "a record without procStart has nothing to compare");
});

test("the session list applies the same start-time proof: on Linux a record whose procStart does not match its pid is not listed", async () => {
  const pid = livePid();
  await claudeAt(pid, { procStart: "555" });
  const stat = (start: string) => procSource({ [`/proc/${pid}/stat`]: statLine(pid, "claude", start) });
  const listed = (platform: NodeJS.Platform, src: ProcSource) => listClaudeSessions(platform, src).some((s) => s.pid === pid);
  assert.equal(listed("linux", stat("555")), true);
  assert.equal(listed("linux", stat("556")), false, "the pid was reused by another process");
  assert.equal(listed("linux", procSource({})), false, "stat cannot be read");
  assert.equal(listed("android", stat("556")), true, "not compared on Termux until it is verified there");
  assert.equal(listed("darwin", stat("556")), true, "off Linux there is no /proc to compare with");
  await claudeAt(pid, { procStart: undefined });
  assert.equal(listed("linux", procSource({})), true, "a record without procStart has nothing to compare");
});

test("the session list reads the real /proc by default", { skip: process.platform !== "linux" && "needs /proc" }, async () => {
  const pid = livePid();
  await claudeAt(pid, { procStart: processStart(pid) });
  assert.ok(listClaudeSessions().some((s) => s.pid === pid), "the record of a live process with its own start time is listed");
  await claudeAt(pid, { procStart: "1" });
  assert.ok(!listClaudeSessions().some((s) => s.pid === pid), "a record with another process's start time is not");
});

test("the start time is field 22 of /proc/<pid>/stat even when the command name holds spaces and parentheses", () => {
  const src = procSource({ "/proc/7/stat": statLine(7, "a b) (c", "424242") });
  assert.equal(processStart(7, "linux", src), "424242");
  assert.equal(processStart(7, "darwin", src), undefined);
  assert.equal(processStart(8, "linux", src), undefined);
});

test("processStart on a real Linux process is the time it started, in clock ticks since boot, as Claude Code records it", { skip: process.platform !== "linux" && "needs /proc" }, () => {
  const start = processStart(process.pid);
  assert.match(start ?? "", /^\d+$/);
  const bootSeconds = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  const ageSeconds = bootSeconds - Number(start) / 100;
  assert.ok(Math.abs(ageSeconds - process.uptime()) < 10, `${ageSeconds}s old by /proc, ${process.uptime()}s by node`);
});

test("pid 1 is this process's Claude session only if pid 1 is Claude Code; any other pid is taken on its record", async () => {
  const c = await claudeAt(1, { name: "devcontainer-claude" });
  const as = (...args: string[]) => procSource({ "/proc/1/cmdline": cmdline(...args) });
  const walk = (src: ProcSource) => findOwnClaudeSession(4242, chain({ 4242: 77, 77: 1, 1: 0 }), "linux", src);

  assert.equal(walk(as("claude"))?.socketPath, c.socketPath);
  assert.equal(walk(as("/home/dev/.local/bin/claude", "--resume"))?.name, "devcontainer-claude");
  assert.equal(walk(as("node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"))?.name, "devcontainer-claude");
  assert.equal(walk(as("/home/dev/.local/share/claude/versions/2.1.295"))?.name, "devcontainer-claude");

  assert.equal(walk(as("/sbin/init")), undefined);
  assert.equal(walk(as("sleep", "infinity")), undefined);
  assert.equal(walk(as("sh", "-c", "cd /work/claude-notes && make")), undefined);
  assert.equal(walk(procSource({})), undefined, "the arguments of pid 1 cannot be read");
  assert.equal(findOwnClaudeSession(1, chain({ 1: 0 }), "linux", as("/sbin/init")), undefined, "a shell that is itself pid 1");

  await claudeAt(77);
  assert.equal(walk(as("/sbin/init"))?.name, "claude-77", "a record at another pid does not look at pid 1");
});

test("namesClaude takes a binary called claude or claude.exe, a Claude Code install path, and a process title such as `claude bg-spare`", () => {
  for (const args of [["claude"], ["/home/dev/.local/bin/claude", "--resume"], ["C:/Users/dev/bin/claude.exe", "--resume"], ["claude.exe"], ["claude bg-spare"], ["claude bg-spare", ""]]) {
    assert.equal(namesClaude(args), true, JSON.stringify(args));
  }
  assert.equal(namesClaude(["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"]), true);
  assert.equal(namesClaude(["/home/dev/.local/share/claude/versions/2.1.295"]), true);
  for (const args of [undefined, [], [""], ["claudette"], ["claude-helper"], ["xclaude bg-spare"], ["notclaude.exe"], ["claude bg-spare", "--other"], ["sh", "-c", "claude --resume"], ["sh", "-c", "cd /work/claude-notes && make"]]) {
    assert.equal(namesClaude(args), false, JSON.stringify(args));
  }
});

test("pid 1 is Claude Code when its process title is `claude bg-spare`, as the kernel shows a retitled process", async () => {
  await claudeAt(1, { name: "devcontainer-claude" });
  const retitled = procSource({ "/proc/1/cmdline": "claude bg-spare\0" });
  assert.equal(findOwnClaudeSession(1, chain({ 1: 0 }), "linux", retitled)?.name, "devcontainer-claude");
});

test("the pid-1 check reads the arguments the way the platform gives them", async () => {
  await claudeAt(1, { name: "devcontainer-claude" });
  const ps: ProcSource = { read: () => undefined, ps: (args) => (args.includes("args=") ? "/Users/dev/.local/bin/claude --resume\n" : undefined) };
  assert.equal(findOwnClaudeSession(1, chain({ 1: 0 }), "darwin", ps)?.name, "devcontainer-claude");
  assert.equal(findOwnClaudeSession(1, chain({ 1: 0 }), "darwin", { read: () => undefined, ps: () => "/sbin/launchd\n" }), undefined);
});
