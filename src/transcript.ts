import { constants, lstatSync, readdirSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectsDir } from "./paths.ts";
import { redactSecrets } from "./redact.ts";

const CHUNK = 4 * 1024 * 1024;
const MAX_PER_SCAN = 32 * 1024 * 1024;
const LOOKBACK = 8 * 1024 * 1024;
const ORIGIN = /"origin"\s*:\s*\{[^{}]*\}/g;
const PEER = /"kind"\s*:\s*"peer"/;
const MSG_ID = /"msg_id"\s*:\s*"([^"]+)"/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

const MAX_NODES = 50_000;

const PROMPT_CHUNK = 256 * 1024;
const PROMPT_LOOKBACK = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 200;
const MAX_CACHED_PROMPTS = 512;
const MAX_PART_CHARS = 64 * 1024;
const NOT_A_PROMPT = /^\s*(?:This session is being continued from a previous conversation|<(?:command-name|command-message|command-args|local-command-[\w-]+|task-notification|bash-[\w-]+|user-prompt-submit-hook)\b|Caveat: The messages below|\[Request interrupted)/;
const NEVER_BLOCK = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

function withoutBlocks(text: string, tag: string): string {
  const opening = `<${tag}`;
  const closing = `</${tag}>`;
  let out = "";
  let from = 0;
  for (;;) {
    let open = text.indexOf(opening, from);
    while (open !== -1 && !/[\s>]/.test(text[open + opening.length] ?? "")) open = text.indexOf(opening, open + opening.length);
    if (open === -1) return out + text.slice(from);
    out += text.slice(from, open);
    const close = text.indexOf(closing, open);
    if (close === -1) return out;
    from = close + closing.length;
  }
}

const withoutWrappers = (text: string): string => withoutBlocks(withoutBlocks(text, "system-reminder"), "cross-session-message");

const isRegularFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

export async function openRegularFile(path: string): Promise<{ handle: FileHandle; size: number; mtimeMs: number }> {
  const handle = await open(path, NEVER_BLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    return { handle, size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

function typedText(content: unknown): string | undefined {
  const blocks: unknown[] = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object") {
      const { type, text } = block as { type?: unknown; text?: unknown };
      if (type === "tool_result") return undefined;
      if (type === "text" && typeof text === "string") parts.push(text);
    }
  }
  const text = parts
    .map((part) => withoutWrappers(part).slice(0, MAX_PART_CHARS))
    .filter((part) => part.trim() !== "" && !NOT_A_PROMPT.test(part))
    .join("\n")
    .trim();
  return text || undefined;
}

export function realUserPrompt(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as { type?: unknown; isMeta?: unknown; isSidechain?: unknown; isCompactSummary?: unknown; origin?: { kind?: unknown } | null; message?: { content?: unknown } | null };
  if (e.type !== "user" || e.isMeta === true || e.isSidechain === true || e.isCompactSummary === true || e.origin?.kind === "peer") return undefined;
  return typedText(e.message?.content);
}

export function latestUserPrompt(tail: string): string | undefined {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"user"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const prompt = realUserPrompt(entry);
    if (prompt) return redactSecrets(prompt).replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_CHARS);
  }
  return undefined;
}

function flatOrigins(line: string, wanted: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const origin of line.match(ORIGIN) ?? []) {
    if (!PEER.test(origin)) continue;
    const id = origin.match(MSG_ID)?.[1];
    if (id && wanted.has(id)) found.push(id);
  }
  return found;
}

function collectOrigins(root: unknown, wanted: ReadonlySet<string>, found: Set<string>): void {
  const stack: unknown[] = [root];
  let seen = 0;
  while (stack.length > 0 && seen++ < MAX_NODES) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const origin = (node as { origin?: unknown }).origin;
    if (origin && typeof origin === "object") {
      const { kind, msg_id: id } = origin as { kind?: unknown; msg_id?: unknown };
      if (kind === "peer" && typeof id === "string" && wanted.has(id)) found.add(id);
    }
    stack.push(...Object.values(node));
  }
}

export function peerOriginMsgIds(line: string, wanted: ReadonlySet<string>): string[] {
  if (![...wanted].some((id) => line.includes(id))) return [];
  try {
    const found = new Set<string>();
    collectOrigins(JSON.parse(line), wanted, found);
    return [...found];
  } catch {
    return flatOrigins(line, wanted);
  }
}

export class TranscriptWatcher {
  private offsets = new Map<string, number>();
  private searched = new Map<string, Set<string>>();
  private located = new Map<string, string>();
  private prompts = new Map<string, { size: number; mtimeMs: number; prompt: string | undefined }>();

  async latestPrompt(sessionId: string): Promise<string | undefined> {
    const path = this.locate(sessionId);
    if (!path) return undefined;
    const { handle, size, mtimeMs } = await openRegularFile(path);
    try {
      const cached = this.prompts.get(path);
      if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.prompt;
      const prompt = await promptBeforeEnd(handle, size);
      if (this.prompts.size >= MAX_CACHED_PROMPTS) this.prompts.delete(this.prompts.keys().next().value!);
      this.prompts.set(path, { size, mtimeMs, prompt });
      return prompt;
    } finally {
      await handle.close();
    }
  }

  locate(sessionId: string): string | undefined {
    if (!SESSION_ID.test(sessionId)) return undefined;
    const known = this.located.get(sessionId);
    if (known && isRegularFile(known)) return known;
    this.located.delete(sessionId);
    const root = claudeProjectsDir();
    try {
      for (const dir of readdirSync(root)) {
        const candidate = join(root, dir, `${sessionId}.jsonl`);
        if (isRegularFile(candidate)) {
          this.located.set(sessionId, candidate);
          return candidate;
        }
      }
    } catch {}
    return undefined;
  }

  async scan(sessionId: string, wanted: ReadonlySet<string>): Promise<string[]> {
    const path = this.locate(sessionId);
    if (!path || wanted.size === 0) return [];
    const found = new Set<string>();
    const { handle, size } = await openRegularFile(path);
    try {
      const prior = this.offsets.get(path);
      // first sight of a long transcript: only its tail can hold a message sent after we started tracking
      let offset = prior ?? Math.max(0, size - MAX_PER_SCAN);
      let searched = this.searched.get(path) ?? new Set<string>();
      if (size < offset) {
        offset = 0;
        searched = new Set();
      }
      // an id that was not wanted when the earlier bytes were read may already sit in them (Claude can write the line while a sweep is mid-scan)
      const late = prior === undefined ? [] : [...wanted].filter((id) => !searched.has(id));
      if (late.length > 0 && offset > 0) {
        for (const id of (await readRange(handle, Math.max(0, offset - LOOKBACK), offset, new Set(late))).found) found.add(id);
      }
      const forward = await readRange(handle, offset, size, wanted);
      for (const id of forward.found) found.add(id);
      this.offsets.set(path, forward.offset);
      this.searched.set(path, new Set(wanted));
    } finally {
      await handle.close();
    }
    return [...found];
  }
}

async function promptBeforeEnd(handle: FileHandle, size: number): Promise<string | undefined> {
  let end = size;
  let carry = Buffer.alloc(0);
  while (end > 0 && size - end < PROMPT_LOOKBACK) {
    const start = Math.max(0, end - PROMPT_CHUNK);
    const chunk = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
    const joined = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
    const cut = start === 0 ? -1 : joined.indexOf(0x0a);
    // the bytes before the first newline end a line that began in an earlier chunk, so they wait for it
    const whole = start === 0 ? joined : cut === -1 ? Buffer.alloc(0) : joined.subarray(cut + 1);
    carry = start === 0 ? Buffer.alloc(0) : cut === -1 ? joined : joined.subarray(0, cut);
    const prompt = latestUserPrompt(whole.toString("utf8"));
    if (prompt) return prompt;
    end = start;
  }
  return undefined;
}

async function readRange(handle: FileHandle, start: number, end: number, wanted: ReadonlySet<string>): Promise<{ found: string[]; offset: number }> {
  const found = new Set<string>();
  let offset = start;
  let budget = MAX_PER_SCAN;
  while (offset < end && budget > 0) {
    const buffer = Buffer.alloc(Math.min(CHUNK, end - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    const last = buffer.lastIndexOf(0x0a, bytesRead - 1);
    const consumed = last >= 0 ? last + 1 : bytesRead === CHUNK ? bytesRead : 0;
    if (consumed === 0) break;
    const text = buffer.toString("utf8", 0, consumed);
    if ([...wanted].some((id) => text.includes(id))) {
      for (const line of text.split("\n")) for (const id of peerOriginMsgIds(line, wanted)) found.add(id);
    }
    offset += consumed;
    budget -= consumed;
  }
  return { found: [...found], offset };
}
