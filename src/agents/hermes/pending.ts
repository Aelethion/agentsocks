import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { WAKE_PREFIX } from "../../codexframe.ts";
import { ensurePrivateDir, stateDir } from "../../paths.ts";

const dir = (): string => join(stateDir(), "hermes-pending");
const file = (thread: string): string => join(dir(), `${thread}.txt`);

export function stashNotice(thread: string, line: string): void {
  ensurePrivateDir(stateDir());
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  appendFileSync(file(thread), `${line}\n`, { mode: 0o600 });
}

export function dropNotice(thread: string): string | undefined {
  try {
    const text = readFileSync(file(thread), "utf8");
    unlinkSync(file(thread));
    return [...new Set(text.split("\n").filter((line) => line.startsWith(WAKE_PREFIX)))].join("\n") || undefined;
  } catch {
    return undefined;
  }
}
