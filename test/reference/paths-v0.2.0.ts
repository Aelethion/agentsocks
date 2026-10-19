import { createHash } from "node:crypto";
import { existsSync, mkdirSync, chmodSync, lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const uid = (): number => process.getuid?.() ?? 0;

function systemRuntimeDir(): string | undefined {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return xdg;
  const standard = `/run/user/${uid()}`;
  try {
    const st = lstatSync(standard);
    if (st.isDirectory() && st.uid === uid()) return standard;
  } catch {}
  return undefined;
}

export function runtimeDir(): string {
  const override = process.env.AGENTSOCKS_RUNTIME_DIR;
  if (override) return override;
  const base = systemRuntimeDir();
  return base ? join(base, "agentsocks") : join(tmpdir(), `agentsocks-${uid()}`);
}

export const brokerSocketPath = (): string => join(runtimeDir(), "broker.sock");

export const threadSocketPath = (threadId: string): string => join(runtimeDir(), "t", `${threadId}.sock`);

export function ccSocksDirPath(): string | undefined {
  const override = process.env.AGENTSOCKS_CCSOCKS_DIR;
  if (override) return override;
  if (process.env.AGENTSOCKS_RUNTIME_DIR) return undefined;
  const base = systemRuntimeDir();
  return base ? join(base, "cc-socks") : undefined;
}

export function ccSocksDir(): string | undefined {
  const dir = ccSocksDirPath();
  if (!dir) return undefined;
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid() || (st.mode & 0o777) !== 0o700) return undefined;
  } catch {
    return undefined;
  }
  return dir;
}

export const codexHexName = (threadId: string): string =>
  `a${createHash("sha256").update(`${runtimeDir()}\0${threadId}`).digest("hex").slice(0, 15)}.sock`;

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    return absolute;
  }
}

export function namespacedSocketPath(threadId: string): string | undefined {
  const dir = ccSocksDir();
  return dir ? join(dir, codexHexName(threadId)) : undefined;
}

export function stateDir(): string {
  const override = process.env.AGENTSOCKS_STATE_DIR;
  if (override) return override;
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "agentsocks");
}

export const dbPath = (): string => join(stateDir(), "agentsocks.db");

export const auditLogPath = (): string => join(stateDir(), "audit.log");

export function claudeSessionsDir(): string {
  const override = process.env.AGENTSOCKS_CLAUDE_SESSIONS_DIR;
  if (override) return override;
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "sessions");
}

export function claudeProjectsDir(): string {
  const override = process.env.AGENTSOCKS_CLAUDE_PROJECTS_DIR;
  if (override) return override;
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

const configDir = (): string => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentsocks");

export function configPath(): string {
  const override = process.env.AGENTSOCKS_CONFIG;
  if (override) return override;
  return join(configDir(), "config.json");
}

export const agentsocksEnvPath = (): string => join(configDir(), "env");

export const expandHome = (path: string): string => (path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

export function killSwitchOn(): boolean {
  if (process.env.AGENTSOCKS_OFF === "1") return true;
  return existsSync(join(configDir(), "off"));
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing to use ${dir}: not a real directory`);
  if (st.uid !== uid()) throw new Error(`refusing to use ${dir}: owned by uid ${st.uid}`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

const CC_SOCKS_DIR_NAME = /^cc-socks(?:-\d+)?$/;

export function inboxKind(raw: string): "codex" | "claude" | "agent" {
  const path = canonicalPath(raw);
  if (path.startsWith(`${canonicalPath(join(runtimeDir(), "t"))}/`)) return "codex";
  const parent = dirname(path);
  const dir = ccSocksDirPath();
  return (dir && parent === canonicalPath(dir)) || CC_SOCKS_DIR_NAME.test(basename(parent)) ? "claude" : "agent";
}
