import { createHash } from "node:crypto";
import { PINNED } from "./config.ts";

export interface HookEntry {
  event: string;
  item: string[];
}

export interface Plan {
  server?: string[];
  hooks: HookEntry[];
}

export type Added = { ok: true; text: string; skipped: string[]; adopted: number } | { ok: false; reason: string };

export interface Removed {
  text: string;
  removed: number;
  problem?: string;
}

export interface Found {
  server: string | undefined;
  hooks: string[];
  foreignServer: boolean;
  problem?: string;
}

interface Line {
  text: string;
  eol: string;
}

interface Key {
  name: string;
  quoted: boolean;
  keyText: string;
  line: number;
  indent: number;
  rest: string;
  end: number;
}

interface Block {
  id: string;
  inner: string[];
}

const BEGIN = /^( *)# >>> agentsocks:([A-Za-z0-9_.-]+) sha=([0-9a-f]{12})(?: restore=("(?:[^"\\]|\\.)*"))? >>>(?: .*)?$/;
const END = /^( *)# <<< agentsocks:([A-Za-z0-9_.-]+) <<<(?: .*)?$/;
const EMPTY_MAP = /^(\{\}|~|null|Null|NULL)?\s*(?:#.*)?$/;
const EMPTY_LIST = /^(\[\]|~|null|Null|NULL)?\s*(?:#.*)?$/;
const DASH = /^-(?: |$)/;
const KEEP_SCALAR = /[|>](?:[0-9]\+|\+[0-9]?)\s*(?:#.*)?$/;
const BLOCK_HEADER = /(?:^|[\s:-])[|>][0-9+-]*\s*(?:#.*)?$/;
const LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`);
const OWN_ENV: readonly string[] = ["NODE_NO_WARNINGS", ...PINNED];
const NOTE = "added by agentsocks install; agentsocks uninstall removes it";

const MCP = "mcp_servers";
const HOOKS = "hooks";

function split(src: string): Line[] {
  const out: Line[] = [];
  let at = 0;
  while (at < src.length) {
    const nl = src.indexOf("\n", at);
    if (nl === -1) {
      out.push({ text: src.slice(at), eol: "" });
      break;
    }
    const cr = nl > at && src[nl - 1] === "\r";
    out.push({ text: src.slice(at, cr ? nl - 1 : nl), eol: cr ? "\r\n" : "\n" });
    at = nl + 1;
  }
  return out;
}

const join = (lines: Line[]): string => lines.map((l) => l.text + l.eol).join("");

const indentOf = (s: string): number => /^ */.exec(s)![0].length;
const blank = (s: string): boolean => /^ *$/.test(s);
const comment = (s: string): boolean => /^ *#/.test(s);
const content = (s: string): boolean => !blank(s) && !comment(s);
const closing = (s: string, indent: number): boolean => s === "" || (comment(s) && indentOf(s) <= indent);
const pad = (n: number): string => " ".repeat(n);

function eolFor(lines: Line[], at: number): string {
  return lines[at - 1]?.eol || lines[at]?.eol || lines.find((l) => l.eol)?.eol || "\n";
}

function refuseUnsafe(lines: Line[]): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.text;
    if (/^[ \t]*\t/.test(t)) return `line ${i + 1} is indented with a tab character`;
    if (t.includes("\r")) return `line ${i + 1} holds a stray carriage return`;
    if (LINE_BREAKS.test(t)) return `line ${i + 1} holds a Unicode line separator that a YAML reader takes for a line break`;
  }
  return undefined;
}

const digest = (id: string, restore: string, body: string[]): string => createHash("sha256").update(`${id}\0${restore}\0${body.join("\n")}`).digest("hex").slice(0, 12);

function stripMarked(lines: Line[]): { lines: Line[]; blocks: Block[]; removed: number } | string {
  const out: Line[] = [];
  const blocks: Block[] = [];
  let noFinalEol = false;
  for (let i = 0; i < lines.length; i++) {
    const begin = BEGIN.exec(lines[i]!.text);
    if (!begin) {
      if (END.test(lines[i]!.text)) return `line ${i + 1} ends a managed block that never began`;
      out.push({ ...lines[i]! });
      continue;
    }
    const id = begin[2]!;
    let j = i + 1;
    while (j < lines.length && !END.test(lines[j]!.text)) {
      if (BEGIN.test(lines[j]!.text)) return `line ${j + 1} begins a managed block inside another`;
      j++;
    }
    if (j >= lines.length || END.exec(lines[j]!.text)![2] !== id) return `the managed block ${id} that begins at line ${i + 1} has no matching end`;
    const inner = lines.slice(i + 1, j).map((l) => l.text);
    if (digest(id, begin[4] ?? "", inner) !== begin[3]) return `the managed block ${id} at line ${i + 1} was edited, or is not one agentsocks wrote; remove it by hand or put it back as it was`;
    if (begin[4]) {
      const previous = out.at(-1);
      if (!previous || !content(previous.text)) return `the managed block ${id} at line ${i + 1} has no line above it to restore`;
      try {
        previous.text = JSON.parse(begin[4]) as string;
      } catch {
        return `the managed block ${id} at line ${i + 1} holds a restore note that cannot be read`;
      }
    }
    blocks.push({ id, inner });
    if (j === lines.length - 1 && lines[j]!.eol === "") noFinalEol = true;
    i = j;
  }
  if (noFinalEol && out.length > 0) out[out.length - 1] = { ...out[out.length - 1]!, eol: "" };
  return { lines: out, blocks, removed: blocks.length };
}

interface Split {
  name: string;
  quoted: boolean;
  keyText: string;
  rest: string;
}

function splitKey(body: string): Split | "escaped" | undefined {
  const quote = body[0];
  if (quote === '"' || quote === "'") {
    let k = 1;
    for (; k < body.length; k++) {
      if (quote === '"' && body[k] === "\\") return "escaped";
      if (body[k] === quote) {
        if (quote === "'" && body[k + 1] === "'") {
          k++;
          continue;
        }
        break;
      }
    }
    if (k >= body.length) return undefined;
    const after = /^( *):(?: +(.*))?$/.exec(body.slice(k + 1));
    if (!after) return undefined;
    return { name: body.slice(1, k).replace(/''/g, "'"), quoted: true, keyText: body.slice(0, k + 1 + after[1]!.length), rest: (after[2] ?? "").trim() };
  }
  if (/^[\s#"'[\]{},&*!|>%@`?:]/.test(body) || /^-(?:[\s#:]|$)/.test(body)) return undefined;
  const at = /:(?: |$)/.exec(body)?.index;
  if (at === undefined) return undefined;
  const head = body.slice(0, at);
  if (head.includes("#") || head.trim() === "") return undefined;
  return { name: head.trimEnd(), quoted: false, keyText: head, rest: body.slice(at + 1).trim() };
}

function keysIn(lines: Line[], from: number, to: number, indent: number): Key[] | string {
  const keys: Key[] = [];
  for (let i = from; i < to; i++) {
    const text = i === 0 ? lines[i]!.text.replace(/^\uFEFF/, "") : lines[i]!.text;
    if (!content(text)) continue;
    const here = indentOf(text);
    if (here < indent) return `line ${i + 1} is indented less than the lines around it`;
    if (here > indent) {
      if (keys.length === 0) return `line ${i + 1} is indented with nothing above it to belong to`;
      continue;
    }
    const body = text.slice(indent);
    const found = splitKey(body);
    if (found === "escaped") return `line ${i + 1} has a quoted key with escape sequences, which the editor does not read`;
    if (found) {
      if (found.name === "<<") return `line ${i + 1} uses a YAML merge key (<<), which can supply keys the editor cannot see`;
      keys.push({ ...found, line: i, indent, end: to });
      continue;
    }
    if (keys.length > 0 && (DASH.test(body) || (indent === 0 && /^[\]}]/.test(body)))) continue;
    if (indent === 0 && body === "---" && keys.length === 0) continue;
    return `line ${i + 1} is not a "key: value" line the editor reads`;
  }
  for (let k = 0; k < keys.length; k++) {
    let end = keys[k + 1]?.line ?? to;
    while (end - 1 > keys[k]!.line && closing(lines[end - 1]!.text, keys[k]!.indent)) end--;
    keys[k]!.end = end;
  }
  return keys;
}

function topKeys(lines: Line[]): Key[] | string {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.text;
    if ((t === "---" || t.startsWith("--- ") || t === "...") && lines.slice(0, i).some((l) => content(l.text) && l.text !== "---")) return `the file holds more than one YAML document (line ${i + 1})`;
  }
  const keys = keysIn(lines, 0, lines.length, 0);
  if (typeof keys === "string") return keys;
  const seen = new Map<string, number>();
  for (const k of keys) {
    const first = seen.get(k.name);
    if (first !== undefined) return `the top-level key ${k.name} appears more than once (lines ${first + 1} and ${k.line + 1})`;
    seen.set(k.name, k.line);
  }
  return keys;
}

interface Section {
  key: Key;
  mode: "missing" | "empty" | "flow-empty" | "block";
  childIndent: number;
  children: Key[];
}

function contentIn(lines: Line[], from: number, to: number): number[] {
  const at: number[] = [];
  for (let i = from; i < to; i++) if (content(lines[i]!.text)) at.push(i);
  return at;
}

function mapSection(lines: Line[], key: Key): Section | string {
  if (key.quoted) return `the key ${key.name} is quoted, which the editor does not edit`;
  const m = EMPTY_MAP.exec(key.rest);
  if (!m) return `${key.name} has a value written on its own line (${key.rest.slice(0, 40)}), which the editor does not edit`;
  const inside = contentIn(lines, key.line + 1, key.end);
  for (const i of contentIn(lines, key.line, key.end)) if (KEEP_SCALAR.test(lines[i]!.text.trimEnd())) return `${key.name} holds a block scalar that keeps trailing blank lines (line ${i + 1})`;
  if (m[1]) return inside.length > 0 ? `${key.name} is written as empty and also has lines under it` : { key, mode: "flow-empty", childIndent: 2, children: [] };
  if (inside.length === 0) return { key, mode: "empty", childIndent: 2, children: [] };
  const childIndent = indentOf(lines[inside[0]!]!.text);
  if (childIndent === 0) return `${key.name} is a list, not a mapping`;
  const children = keysIn(lines, key.line + 1, key.end, childIndent);
  if (typeof children === "string") return `${key.name}: ${children}`;
  const seen = new Set<string>();
  for (const c of children) {
    if (seen.has(c.name)) return `${key.name} has the key ${c.name} twice`;
    seen.add(c.name);
  }
  return { key, mode: "block", childIndent, children };
}

interface Items {
  mode: "empty" | "flow-empty" | "seq";
  dash: number;
  spans: [number, number][];
}

function listItems(lines: Line[], event: Key): Items | string {
  if (event.quoted) return `the key ${event.name} is quoted, which the editor does not edit`;
  const m = EMPTY_LIST.exec(event.rest);
  if (!m) return `${event.name} is written inline (${event.rest.slice(0, 40)}), which the editor does not edit`;
  const inside = contentIn(lines, event.line + 1, event.end);
  if (m[1]) return inside.length > 0 ? `${event.name} is written as empty and also has lines under it` : { mode: "flow-empty", dash: event.indent + 2, spans: [] };
  if (inside.length === 0) return { mode: "empty", dash: event.indent + 2, spans: [] };
  const dash = indentOf(lines[inside[0]!]!.text);
  const starts: number[] = [];
  for (const i of inside) {
    const here = indentOf(lines[i]!.text);
    if (here < dash) return `${event.name}: line ${i + 1} is indented less than the list items`;
    if (here === dash) {
      if (!DASH.test(lines[i]!.text.slice(dash))) return `${event.name} is not a list (line ${i + 1})`;
      starts.push(i);
    }
  }
  const spans = starts.map((start, n): [number, number] => {
    const limit = starts[n + 1] ?? event.end;
    let end = limit;
    while (end - 1 > start && !content(lines[end - 1]!.text)) end--;
    return [start, end];
  });
  return { mode: "seq", dash, spans };
}

const textOf = (lines: Line[], from: number, to: number): string => lines.slice(from, to).map((l) => l.text).join("\n");

const valueOf = (lines: Line[], key: Key): string => [key.rest, ...lines.slice(key.line + 1, key.end).map((l) => l.text.trim())].join(" ").replace(/\s+/g, " ").trim();

function ownHook(lines: Line[], from: number, to: number): boolean {
  const sub = lines.slice(from, to).map((l) => ({ ...l }));
  sub[0]!.text = sub[0]!.text.replace(/^( *)-( *)/, (_m, a: string, b: string) => `${a} ${b}`);
  const first = sub.findIndex((l) => content(l.text));
  if (first === -1) return false;
  const keys = keysIn(sub, 0, sub.length, indentOf(sub[first]!.text));
  if (typeof keys === "string" || !keys.every((k) => k.name === "matcher" || k.name === "command" || k.name === "timeout")) return false;
  const command = keys.find((k) => k.name === "command");
  return !!command && /^env AGENTSOCKS_HOOK=1 .* hook hermes [a-z_]+$/.test(valueOf(sub, command).replace(/^["']|["']$/g, ""));
}

function ownServer(lines: Line[], child: Key): boolean {
  if (child.rest !== "" && !child.rest.startsWith("#")) return false;
  const inside = contentIn(lines, child.line + 1, child.end);
  if (inside.length === 0) return false;
  const keys = keysIn(lines, child.line + 1, child.end, indentOf(lines[inside[0]!]!.text));
  if (typeof keys === "string" || !keys.every((k) => k.name === "command" || k.name === "args" || k.name === "env")) return false;
  const args = keys.find((k) => k.name === "args");
  if (!args) return false;
  const words = valueOf(lines, args).replace(/[[\],"']/g, " ").split(/\s+/).filter((w) => w !== "" && w !== "-");
  if (words.length !== 4 || words.slice(1).join(" ") !== "mcp --agent hermes") return false;
  const env = keys.find((k) => k.name === "env");
  if (!env) return true;
  if (env.rest !== "" && !env.rest.startsWith("#")) return false;
  const names = contentIn(lines, env.line + 1, env.end);
  if (names.length === 0) return true;
  const listed = keysIn(lines, env.line + 1, env.end, indentOf(lines[names[0]!]!.text));
  return typeof listed !== "string" && listed.every((k) => OWN_ENV.includes(k.name));
}

interface Adopted {
  lines: Line[];
  server: string | undefined;
  hooks: string[];
  foreignServer: boolean;
  count: number;
}

function adoptUnmarked(lines: Line[]): Adopted | string {
  const top = topKeys(lines);
  if (typeof top === "string") return top;
  const doomed: [number, number][] = [];
  let server: string | undefined;
  let foreignServer = false;
  const hooks: string[] = [];
  const mcp = top.find((k) => k.name === MCP);
  const mcpSection = mcp && mapSection(lines, mcp);
  if (typeof mcpSection === "string") return mcpSection;
  if (mcp && mcpSection?.mode === "block") {
    const mine = mcpSection.children.find((c) => c.name === "agentsocks");
    if (mine) {
      if (ownServer(lines, mine)) {
        server = textOf(lines, mine.line, mine.end);
        doomed.push(mcpSection.children.length === 1 ? [mcp.line, mcp.end] : [mine.line, mine.end]);
      } else foreignServer = true;
    }
  }
  const hk = top.find((k) => k.name === HOOKS);
  const hookSection = hk && mapSection(lines, hk);
  if (typeof hookSection === "string") return hookSection;
  if (hk && hookSection?.mode === "block") {
    const whole: Key[] = [];
    const partial: [number, number][] = [];
    for (const event of hookSection.children) {
      const items = listItems(lines, event);
      if (typeof items === "string") continue;
      const mine = items.spans.filter(([s, e]) => ownHook(lines, s, e));
      for (const [s, e] of mine) hooks.push(textOf(lines, s, e));
      if (mine.length === 0) continue;
      if (mine.length === items.spans.length) whole.push(event);
      else partial.push(...mine);
    }
    if (whole.length > 0 && whole.length === hookSection.children.length) doomed.push([hk.line, hk.end]);
    else doomed.push(...whole.map((e): [number, number] => [e.line, e.end]), ...partial);
  }
  const kept = lines.filter((_, i) => !doomed.some(([s, e]) => i >= s && i < e));
  return { lines: kept, server, hooks, foreignServer, count: (server === undefined ? 0 : 1) + hooks.length };
}

function insertBlock(lines: Line[], at: number, indent: number, id: string, inner: string[], restore?: string): Line[] {
  const eol = eolFor(lines, at);
  const note = restore ? JSON.stringify(restore).replace(/>/g, "\\u003e") : "";
  const body = inner.map((s) => (s === "" ? s : pad(indent) + s));
  const texts = [`${pad(indent)}# >>> agentsocks:${id} sha=${digest(id, note, body)}${note ? ` restore=${note}` : ""} >>> ${NOTE}`, ...body, `${pad(indent)}# <<< agentsocks:${id} <<<`];
  const out = lines.map((l) => ({ ...l }));
  const atEnd = at === out.length;
  if (atEnd && out.length > 0 && out.at(-1)!.eol === "") out.at(-1)!.eol = eol;
  const trailing = atEnd && lines.length > 0 && lines.at(-1)!.eol === "";
  const added = texts.map((text, n) => ({ text, eol: trailing && n === texts.length - 1 ? "" : eol }));
  out.splice(at, 0, ...added);
  return out;
}

function flatten(inner: string[], lead: number): string[] {
  return inner.map((s) => (s === "" ? s : pad(lead) + s));
}

function convertKey(lines: Line[], key: Key): { lines: Line[]; restore: string } {
  const out = lines.map((l) => ({ ...l }));
  const original = out[key.line]!.text;
  out[key.line]!.text = `${pad(key.indent)}${key.keyText}:`;
  return { lines: out, restore: original };
}

function addServer(lines: Line[], entry: string[]): { lines: Line[]; skipped: boolean } | string {
  const top = topKeys(lines);
  if (typeof top === "string") return top;
  const key = top.find((k) => k.name === MCP);
  if (!key) return { lines: insertBlock(lines, lines.length, 0, MCP, [`${MCP}:`, ...flatten(entry, 2)]), skipped: false };
  const section = mapSection(lines, key);
  if (typeof section === "string") return section;
  if (section.children.some((c) => c.name === "agentsocks")) return { lines, skipped: true };
  if (section.mode === "flow-empty") {
    const c = convertKey(lines, key);
    return { lines: insertBlock(c.lines, key.line + 1, 2, `${MCP}.agentsocks`, entry, c.restore), skipped: false };
  }
  return { lines: insertBlock(lines, key.end, section.childIndent, `${MCP}.agentsocks`, entry), skipped: false };
}

function addHooks(lines: Line[], hooks: HookEntry[]): { lines: Line[] } | string {
  const top = topKeys(lines);
  if (typeof top === "string") return top;
  const eventLines = (list: HookEntry[], lead: number): string[] => list.flatMap((h) => [`${h.event}:`, ...flatten(h.item, lead)]);
  const key = top.find((k) => k.name === HOOKS);
  if (!key) return { lines: insertBlock(lines, lines.length, 0, HOOKS, [`${HOOKS}:`, ...flatten(eventLines(hooks, 2), 2)]) };
  const section = mapSection(lines, key);
  if (typeof section === "string") return section;
  if (section.mode === "empty" || section.mode === "flow-empty") {
    const converted = section.mode === "flow-empty" ? convertKey(lines, key) : undefined;
    return { lines: insertBlock(converted?.lines ?? lines, key.line + 1, 2, `${HOOKS}.events`, eventLines(hooks, 2), converted?.restore) };
  }
  let current = lines;
  const fresh: HookEntry[] = [];
  const existing = new Map(section.children.map((c) => [c.name, c]));
  const edits: { at: number; rank: number; indent: number; id: string; inner: string[]; convert?: Key }[] = [];
  for (const h of hooks) {
    const event = existing.get(h.event);
    if (!event) {
      fresh.push(h);
      continue;
    }
    const items = listItems(current, event);
    if (typeof items === "string") return items;
    if (items.mode === "seq") edits.push({ at: event.end, rank: 1, indent: items.dash, id: `${HOOKS}.${h.event}`, inner: h.item });
    else edits.push({ at: event.line + 1, rank: 1, indent: items.dash, id: `${HOOKS}.${h.event}`, inner: h.item, ...(items.mode === "flow-empty" && { convert: event }) });
  }
  if (fresh.length > 0) edits.push({ at: key.end, rank: 0, indent: section.childIndent, id: `${HOOKS}.events`, inner: eventLines(fresh, 2) });
  for (const edit of edits.sort((a, b) => b.at - a.at || a.rank - b.rank)) {
    if (edit.convert) {
      const c = convertKey(current, edit.convert);
      current = insertBlock(c.lines, edit.at, edit.indent, edit.id, edit.inner, c.restore);
    } else current = insertBlock(current, edit.at, edit.indent, edit.id, edit.inner);
  }
  return { lines: current };
}

function scanScalars(lines: Line[]): { problem?: string; inBlockScalar: boolean } {
  let dq = false;
  let sq = false;
  let depth = 0;
  let block: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text;
    if (block !== undefined) {
      if (blank(text) || indentOf(text) > block) continue;
      block = undefined;
    }
    if ((dq || sq || depth > 0) && content(text) && indentOf(text) === 0 && !/^[\]}]/.test(text)) return { problem: `line ${i + 1} continues a quoted or flow value at column 0, which the editor does not follow`, inBlockScalar: false };
    let prev = "";
    for (let k = 0; k < text.length; k++) {
      const c = text[k]!;
      if (dq) {
        if (c === "\\") k++;
        else if (c === '"') {
          dq = false;
          prev = c;
        }
        continue;
      }
      if (sq) {
        if (c === "'") {
          if (text[k + 1] === "'") k++;
          else {
            sq = false;
            prev = c;
          }
        }
        continue;
      }
      if (c === " ") continue;
      if (c === "#" && (k === 0 || text[k - 1] === " ")) break;
      const starts = prev === "" || ":-[{,?".includes(prev);
      if (c === '"' && starts) dq = true;
      else if (c === "'" && starts) sq = true;
      else if ((c === "[" || c === "{") && starts) depth++;
      else if ((c === "]" || c === "}") && depth > 0) depth--;
      prev = c;
    }
    if (!dq && !sq && depth === 0 && !comment(text) && BLOCK_HEADER.test(text)) {
      const lead = /^( *(?:- +)*)(.*)$/.exec(text)!;
      block = /^[|>]/.test(lead[2]!) ? Math.max(lead[1]!.lastIndexOf("-"), 0) : lead[1]!.length;
    }
  }
  return dq || sq || depth > 0 ? { problem: "a quoted or flow value is still open at the end of the file", inBlockScalar: false } : { inBlockScalar: block !== undefined };
}

export function addManaged(source: string, plan: Plan): Added {
  const original = split(source);
  const unsafe = refuseUnsafe(original);
  if (unsafe) return { ok: false, reason: unsafe };
  const stripped = stripMarked(original);
  if (typeof stripped === "string") return { ok: false, reason: stripped };
  const adopted = adoptUnmarked(stripped.lines);
  if (typeof adopted === "string") return { ok: false, reason: adopted };
  const clean = adopted.lines;
  const scalars = scanScalars(clean);
  if (scalars.problem) return { ok: false, reason: scalars.problem };
  if (scalars.inBlockScalar && clean.at(-1)?.eol === "") return { ok: false, reason: "the file ends inside a block scalar with no final newline, and adding lines would change its value" };
  const skipped: string[] = [];
  let lines = clean;
  if (plan.server) {
    const r = addServer(lines, plan.server);
    if (typeof r === "string") return { ok: false, reason: r };
    lines = r.lines;
    if (r.skipped) skipped.push(`${MCP}.agentsocks`);
  }
  if (plan.hooks.length > 0) {
    const r = addHooks(lines, plan.hooks);
    if (typeof r === "string") return { ok: false, reason: r };
    lines = r.lines;
  }
  const check = stripMarked(lines);
  if (typeof check === "string" || join(check.lines) !== join(clean)) return { ok: false, reason: "the edit did not round-trip, so nothing was changed" };
  return { ok: true, text: join(lines), skipped, adopted: adopted.count };
}

export function removeManaged(source: string): Removed {
  const original = split(source);
  const stripped = stripMarked(original);
  if (typeof stripped === "string") return { text: source, removed: 0, problem: stripped };
  const adopted = adoptUnmarked(stripped.lines);
  if (typeof adopted === "string") return { text: join(stripped.lines), removed: stripped.removed, problem: adopted };
  return { text: join(adopted.lines), removed: stripped.removed + adopted.count };
}

export function inspectManaged(source: string): Found {
  const stripped = stripMarked(split(source));
  if (typeof stripped === "string") return { server: undefined, hooks: [], foreignServer: false, problem: stripped };
  const marked = stripped.blocks.map((b) => ({ id: b.id, text: b.inner.join("\n") }));
  const adopted = adoptUnmarked(stripped.lines);
  const unmarked = typeof adopted === "string" ? { server: undefined, hooks: [] as string[], foreignServer: false } : adopted;
  const server = marked.find((b) => b.id.startsWith(`${MCP}`))?.text ?? unmarked.server;
  return {
    server,
    hooks: [...marked.filter((b) => b.id.startsWith(HOOKS)).map((b) => b.text), ...unmarked.hooks],
    foreignServer: unmarked.foreignServer,
    ...(typeof adopted === "string" && { problem: adopted }),
  };
}
