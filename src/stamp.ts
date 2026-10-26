import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { threadIdFor, type InboxAgentId } from "./agents/types.ts";
import { ensurePrivateDir, stateDir } from "./paths.ts";

const STAMP = /^([A-Za-z0-9_-]{1,80})\.([0-9a-f]{32})$/;

export const stampKeyPath = (): string => join(stateDir(), "stamp.key");

function readKey(): Buffer | undefined {
  try {
    const key = Buffer.from(readFileSync(stampKeyPath(), "utf8").trim(), "hex");
    return key.length === 32 ? key : undefined;
  } catch {
    return undefined;
  }
}

function createKey(): Buffer {
  ensurePrivateDir(stateDir());
  const temp = `${stampKeyPath()}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  try {
    try {
      linkSync(temp, stampKeyPath());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!readKey()) renameSync(temp, stampKeyPath());
    }
  } finally {
    rmSync(temp, { force: true });
  }
  const key = readKey();
  if (!key) throw new Error(`${stampKeyPath()} does not hold a 32 byte key`);
  return key;
}

const mac = (key: Buffer, agent: InboxAgentId, session: string): string => createHmac("sha256", key).update(`agentsocks-stamp\0${agent}\0${session}`).digest("hex").slice(0, 32);

export function stampSession(agent: InboxAgentId, session: string): string {
  if (!threadIdFor(agent, session)) throw new Error("not a session id agentsocks can stamp");
  return `${session}.${mac(readKey() ?? createKey(), agent, session)}`;
}

export function verifyStamp(agent: InboxAgentId, value: unknown): string | undefined {
  const parts = typeof value === "string" ? STAMP.exec(value) : null;
  const key = parts ? readKey() : undefined;
  if (!parts || !key) return undefined;
  const given = Buffer.from(parts[2]!, "hex");
  const wanted = Buffer.from(mac(key, agent, parts[1]!), "hex");
  return given.length === wanted.length && timingSafeEqual(given, wanted) && threadIdFor(agent, parts[1]!) ? parts[1] : undefined;
}
