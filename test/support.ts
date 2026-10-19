import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:net";
import { requireTemporaryHome, scrubEnvironment } from "./isolation.ts";
import { tempDir } from "./tmp.ts";
import type { ProcSource } from "../src/procinfo.ts";

scrubEnvironment();
requireTemporaryHome();

export const root = tempDir("agentsocks-test-");
process.env.AGENTSOCKS_RUNTIME_DIR = join(root, "run");
process.env.AGENTSOCKS_STATE_DIR = join(root, "state");
process.env.AGENTSOCKS_CLAUDE_SESSIONS_DIR = join(root, "claude-sessions");
process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR = join(root, "claude-projects");
process.env.AGENTSOCKS_CCSOCKS_DIR = join(root, "cc-socks");
process.env.AGENTSOCKS_PROC_ROOT = join(root, "proc");
process.env.AGENTSOCKS_CONFIG = join(root, "config", "agentsocks.json");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.CODEX_HOME = join(root, "codex-home");
process.env.AGENTSOCKS_SWEEP_MS = "3600000";
process.env.AGENTSOCKS_TAILSCALE_BIN = join(root, "no-tailscale");
process.env.TS_SOCKET = join(root, "no-localapi.sock");
process.env.AGENTSOCKS_SESSION_CACHE_MS = "0";
process.env.AGENTSOCKS_UNCONNECTED_CACHE_MS = "0";

export const wakeLog = join(root, "wake.log");
const fakeCodex = join(root, "fake-codex.sh");
writeFileSync(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(wakeLog)}\n`);
chmodSync(fakeCodex, 0o755);
process.env.AGENTSOCKS_CODEX_BIN = fakeCodex;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sleepers: ChildProcess[] = [];
process.on("exit", () => {
  for (const child of sleepers) child.kill();
});

export function livePid(): number {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  child.unref();
  sleepers.push(child);
  return child.pid!;
}

export async function until<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
}

export interface FakeClaude {
  name: string;
  pid: number;
  sessionId: string;
  socketPath: string;
  frames: Record<string, unknown>[];
  server: Server;
  setStatus(status: string | undefined): void;
}

export async function fakeClaude(name: string, pid: number, status?: string, sockName = `${pid}.sock`): Promise<FakeClaude> {
  const { serveInbox } = await import("../src/ccsocks.ts");
  const dir = join(root, "cc-socks");
  mkdirSync(join(root, "claude-sessions"), { recursive: true });
  const socketPath = join(dir, sockName);
  const frames: Record<string, unknown>[] = [];
  const server = await serveInbox(socketPath, (frame) => frames.push(frame as Record<string, unknown>));
  const sessionId = `${name}-session`;
  const write = (s: string | undefined) =>
    writeFileSync(join(root, "claude-sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: `/work/${name}`, name, messagingSocketPath: socketPath, kind: "interactive", ...(s && { status: s }) }));
  write(status);
  return { name, pid, sessionId, socketPath, frames, server, setStatus: write };
}

export function inTranscript(c: Pick<FakeClaude, "name" | "sessionId">, msgId: string): void {
  const dir = join(process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR!, `-work-${c.name}`);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${c.sessionId}.jsonl`), `${JSON.stringify({ type: "user", origin: { kind: "peer", from: "uds:/x", msg_id: msgId }, message: { content: "<cross-session-message>" } })}\n`);
}

export const chain = (links: Record<number, number>) => (pid: number): number | undefined => links[pid];

export const procSource = (files: Record<string, string> = {}): ProcSource => ({ read: (path) => files[path], ps: () => undefined });

export function shimmedEnv(): Record<string, string> {
  const dir = tempDir("agentsocks-shim-");
  for (const tool of ["claude", "codex"]) {
    writeFileSync(join(dir, tool), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, tool), 0o755);
  }
  return { PATH: `${dir}:/usr/bin:/bin`, HOME: tempDir("agentsocks-home-") };
}
