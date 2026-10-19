import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmodSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir } from "./paths.ts";

export const MAX_LINE = 1_048_576;
const FIRST_LINE_TIMEOUT_MS = 30_000;

export class SendError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function vetTarget(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new SendError("no-inbox", `no inbox socket at ${path} (the session is not running)`);
  }
  if (st.isSymbolicLink()) throw new SendError("symlink", "refusing to send: target is a symlink");
  if (!st.isSocket()) throw new SendError("not-socket", `refusing to send: ${path} is not a socket`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new SendError("foreign", "refusing to send: socket belongs to another user");
}

export async function postLines(path: string, lines: string[], timeoutMs = 5000): Promise<void> {
  vetTarget(path);
  const payload = `${lines.join("\n")}\n`;
  if (lines.some((l) => l.length > MAX_LINE)) throw new SendError("too-large", `message frame exceeds ${MAX_LINE} characters`);
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    sock.setTimeout(timeoutMs, () => finish(new SendError("timeout", `timed out sending to ${path}`)));
    sock.on("error", (err) => finish(new SendError("connect", `could not deliver to ${path}: ${err.message}`)));
    sock.on("connect", () => sock.end(payload, () => finish()));
  });
}

export type Liveness = "alive" | "stale" | "unknown";

// a unix listener with a full backlog is refused on macOS, so there a refusal proves nothing listens unless only this process could have bound the name
export function refusalProvesStale(platform: NodeJS.Platform, nameIsOurs: boolean): boolean {
  return platform !== "darwin" || nameIsOurs;
}

// a timeout or any other error may be a live server that is merely slow or busy
export function probe(path: string, refusalIsProof: boolean, timeoutMs = 1000): Promise<Liveness> {
  return new Promise((resolve) => {
    const sock = createConnection({ path });
    const done = (state: Liveness) => {
      sock.destroy();
      resolve(state);
    };
    sock.setTimeout(timeoutMs, () => done("unknown"));
    sock.on("connect", () => done("alive"));
    sock.on("error", (err) => done(refusalIsProof && (err as NodeJS.ErrnoException).code === "ECONNREFUSED" ? "stale" : "unknown"));
  });
}

export type LineHandler = (value: unknown, raw: string, socket: Socket) => void;

const IDLE_AFTER_LINE_MS = 30_000;

export function readLines(socket: Socket, onLine: (raw: string) => void, firstLineTimeoutMs = FIRST_LINE_TIMEOUT_MS, idleMs = IDLE_AFTER_LINE_MS): void {
  let buffer = "";
  let sawLine = false;
  const timer = setTimeout(() => {
    if (!sawLine) socket.destroy();
  }, firstLineTimeoutMs);
  timer.unref();
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!sawLine && idleMs > 0) socket.setTimeout(idleMs, () => socket.destroy());
      sawLine = true;
      if (raw.trim()) onLine(raw);
    }
    if (buffer.length > MAX_LINE) socket.destroy();
  });
  socket.on("end", () => {
    clearTimeout(timer);
    if (buffer.trim() && buffer.length <= MAX_LINE) onLine(buffer);
    buffer = "";
  });
  socket.on("close", () => clearTimeout(timer));
  socket.on("error", () => socket.destroy());
}

interface Tracked {
  sockets: Set<Socket>;
  path: string;
  ino: number;
}

const tracked = new WeakMap<Server, Tracked>();

export interface ListenOptions {
  replaceStale?: boolean;
  platform?: NodeJS.Platform;
  ownsName?: boolean;
}

export async function listenUnix(path: string, onConnection: (socket: Socket) => void, opts: ListenOptions = {}): Promise<Server> {
  ensurePrivateDir(dirname(path));
  try {
    const st = lstatSync(path);
    if (!st.isSocket()) throw new Error(`refusing to replace non-socket file at ${path}`);
    const liveness = await probe(path, refusalProvesStale(opts.platform ?? process.platform, opts.ownsName === true));
    if (liveness === "alive") throw Object.assign(new Error(`a live server already listens at ${path}`), { code: "EADDRINUSE" });
    if (liveness === "unknown") throw Object.assign(new Error(`cannot tell whether a server still listens at ${path}, so it is left alone`), { code: "EADDRINUSE" });
    if (opts.replaceStale === false) throw Object.assign(new Error(`stale socket at ${path}`), { code: "EADDRINUSE" });
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  server.maxConnections = 256;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  tracked.set(server, { sockets, path, ino: lstatSync(path).ino });
  return server;
}

export function serveInbox(path: string, onFrame: LineHandler, opts: ListenOptions = {}): Promise<Server> {
  return listenUnix(
    path,
    (socket) => {
      readLines(socket, (raw) => {
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          return;
        }
        if (value && typeof value === "object" && (value as { type?: unknown }).type === "auth") return;
        onFrame(value, raw, socket);
      });
    },
    opts,
  );
}

export function closeServer(server: Server): Promise<void> {
  const t = tracked.get(server);
  let parked: string | undefined;
  if (t) {
    try {
      if (lstatSync(t.path).ino === t.ino) unlinkSync(t.path);
      else {
        parked = `${t.path}.parked-${process.pid}`;
        renameSync(t.path, parked);
      }
    } catch {}
    for (const s of t.sockets) s.destroy();
  }
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // libuv unlinks the path whatever now sits there, so another server's socket is stepped aside while ours closes
  if (t && parked) {
    try {
      renameSync(parked, t.path);
    } catch {}
  }
  return closed;
}
