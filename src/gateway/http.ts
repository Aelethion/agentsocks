import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

export function sendText(res: ServerResponse, status: number, contentType: string, body: string | Buffer, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": contentType, "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, err.headers);
  sendJson(res, 500, { error: "internal error" });
}

const CLOSE = { Connection: "close" };

const bodyDeadlineMs = (): number => Number(process.env.AGENTSOCKS_GATEWAY_BODY_MS) || 10_000;

export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) return reject(new HttpError(413, "request body too large", CLOSE));
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => reject(new HttpError(408, "the request body arrived too slowly", CLOSE)), bodyDeadlineMs());
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) return settle(() => reject(new HttpError(413, "request body too large", CLOSE)));
      chunks.push(chunk);
    });
    req.on("end", () => settle(() => resolve(Buffer.concat(chunks))));
    req.on("error", (err) => settle(() => reject(err)));
    req.on("aborted", () => settle(() => reject(new HttpError(400, "request aborted"))));
  });
}

export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "content-type must be application/json");
  const raw = await readBody(req, maxBytes);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

export function readForm(raw: string): URLSearchParams {
  return new URLSearchParams(raw);
}

export const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

// Only the last entry is trusted: tailscale serve appends the real tailnet address there, while anything earlier in the list is written by the caller and can be spoofed.
 export function lastForwardedFor(req: IncomingMessage): string | undefined {
   const raw = req.headers["x-forwarded-for"];
   const joined = Array.isArray(raw) ? raw.join(",") : raw;
   const last = joined?.split(",").at(-1)?.trim();
   return last || undefined;
 }

export function isCanonicalPath(pathname: string): boolean {
  if (!pathname.startsWith("/")) return false;
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  for (const text of [pathname, decoded]) {
    if (text.includes("\\")) return false;
    if (text.includes("//") || text === "/." || text === "/.." || text.includes("/./") || text.endsWith("/.") || text.includes("/../") || text.endsWith("/..")) return false;
  }
  return true;
}

export function hostName(host: string | undefined): string {
  if (!host) return "";
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.replace(/:\d+$/, "").replace(/\.$/, "");
}
