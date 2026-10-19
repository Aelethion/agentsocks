export const TAG = "cross-session-message";

export type Mode = "bypass" | "prompting";

export interface Envelope {
  from?: string;
  fromSession?: string;
  hopChain?: string[];
  fromName?: string;
  fromMode?: Mode;
  fromPlugin?: string;
  body: string;
}

const SESSION = /^[A-Za-z0-9_-]{1,80}$/;
const HOP_ITEM = "[0-9a-f]{24}";
const HOP_CHAIN = new RegExp(`^${HOP_ITEM}(?:,${HOP_ITEM}){0,31}$`);
const ADDRESS_CHARS = "A-Za-z0-9%:_/.\\\\-";
const MODES: Mode[] = ["bypass", "prompting"];
const STRIP = /[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu;
const TAG_LOOKALIKE = /cross[\s\p{Cf}_-]{0,3}session[\s\p{Cf}_-]{0,3}message/iu;

export function encodeAddress(path: string): string {
  const encoder = new TextEncoder();
  const encoded = path.replace(/[^A-Za-z0-9:_/.\\-]/gu, (ch) =>
    Array.from(encoder.encode(ch), (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
  return `uds:${encoded}`;
}

export function decodeAddress(address: string): string | undefined {
  if (!address.startsWith("uds:")) return undefined;
  try {
    return decodeURIComponent(address.slice(4));
  } catch {
    return address.slice(4);
  }
}

export function sanitizeName(name: string): string {
  const cleaned = name.replace(/["<>]/g, "").replace(STRIP, "").trim();
  const chars = [...cleaned];
  return chars.length > 64 ? `${chars.slice(0, 64).join("")}…` : cleaned;
}

export function neutralizeBody(body: string): string {
  return TAG_LOOKALIKE.test(body) ? body.replace(/</g, "＜") : body;
}

function attributes(e: Omit<Envelope, "body">): string {
  const parts: string[] = [];
  if (e.from) parts.push(`from="${e.from}"`);
  if (e.fromSession && SESSION.test(e.fromSession)) parts.push(`from-session="${e.fromSession}"`);
  if (e.hopChain && e.hopChain.length > 0) {
    const joined = e.hopChain.join(",");
    if (HOP_CHAIN.test(joined)) parts.push(`hop-chain="${joined}"`);
  }
  const name = e.fromName === undefined ? undefined : sanitizeName(e.fromName);
  if (name) parts.push(`from-name="${name}"`);
  if (e.fromMode) parts.push(`from-mode="${e.fromMode}"`);
  const plugin = e.fromPlugin === undefined ? undefined : sanitizeName(e.fromPlugin);
  if (plugin) parts.push(`from-plugin="${plugin}"`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function buildEnvelope(e: Envelope, neutralize = true): string {
  return `<${TAG}${attributes(e)}>\n${neutralize ? neutralizeBody(e.body) : e.body}\n</${TAG}>`;
}

const PARSER = new RegExp(
  `^<${TAG}(?: from="([${ADDRESS_CHARS}]+)")?(?: from-session="([A-Za-z0-9_-]{1,80})")?` +
    `(?: hop-chain="(${HOP_ITEM}(?:,${HOP_ITEM}){0,31})")?(?: from-name="([^"<>\\n\\r]+)")?` +
    `(?: from-mode="(${MODES.join("|")})")?(?: from-plugin="([^"<>\\n\\r]+)")?>\\n([\\s\\S]*)\\n</${TAG}>$`,
);

export function parseEnvelope(content: unknown): Envelope | undefined {
  if (typeof content !== "string") return undefined;
  const m = content.match(PARSER);
  if (!m) return undefined;
  const parsed: Envelope = {
    ...(m[1] !== undefined && { from: m[1] }),
    ...(m[2] !== undefined && { fromSession: m[2] }),
    ...(m[3] !== undefined && { hopChain: m[3].split(",") }),
    ...(m[4] !== undefined && { fromName: m[4] }),
    ...(m[5] !== undefined && { fromMode: m[5] as Mode }),
    ...(m[6] !== undefined && { fromPlugin: m[6] }),
    body: m[7] ?? "",
  };
  return buildEnvelope(parsed, false) === content ? parsed : undefined;
}

export interface UserFrame {
  type: "user";
  message: { role: "user"; content: string };
  priority: "now" | "next" | "later";
  from?: string;
  msg_id: string;
}

export function userFrame(envelope: Envelope, msgId: string, priority: UserFrame["priority"] = "next"): UserFrame {
  return {
    type: "user",
    message: { role: "user", content: buildEnvelope(envelope) },
    priority,
    ...(envelope.from && { from: envelope.from }),
    msg_id: msgId,
  };
}

export function messageContent(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const message = (frame as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("");
  }
  return undefined;
}
