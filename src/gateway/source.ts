import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { socketCandidates } from "./tailscale.ts";

export interface SourceCheckOptions {
  platform?: NodeJS.Platform;
  ownUid?: number | undefined;
  expectedUid?: () => number | undefined;
  tcpTables?: () => string[];
  tcpTablesAsync?: () => Promise<string[]>;
  tableTtlMs?: number;
}

export interface SourceVerdict {
  enforced: boolean;
  detail: string;
}

const ipv4Hex = (address: string): string => address.split(".").reverse().map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase();
const portHex = (port: number): string => port.toString(16).toUpperCase().padStart(4, "0");

export function ownerUid(tables: string[], from: { address: string; port: number }, to: { address: string; port: number }): number | undefined {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(from.address) || !/^\d+\.\d+\.\d+\.\d+$/.test(to.address)) return undefined;
  const local = `${ipv4Hex(from.address)}:${portHex(from.port)}`;
  const remote = `${ipv4Hex(to.address)}:${portHex(to.port)}`;
  for (const table of tables) {
    for (const line of table.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[1] === local && cols[2] === remote) {
        const uid = Number(cols[7]);
        return Number.isInteger(uid) ? uid : undefined;
      }
    }
  }
  return undefined;
}

export function connectionOwner(socket: Socket, tables: string[]): number | undefined {
  if (!socket.remoteAddress || socket.remotePort === undefined || !socket.localAddress || socket.localPort === undefined) return undefined;
  const strip = (a: string): string => a.replace(/^::ffff:/, "");
  return ownerUid(tables, { address: strip(socket.remoteAddress), port: socket.remotePort }, { address: strip(socket.localAddress), port: socket.localPort });
}

const TCP_FILES = ["/proc/net/tcp", "/proc/net/tcp6"];

function readTcpTables(): string[] {
  const out: string[] = [];
  for (const file of TCP_FILES) {
    try {
      out.push(readFileSync(file, "utf8"));
    } catch {}
  }
  return out;
}

async function readTcpTablesAsync(): Promise<string[]> {
  const out: string[] = [];
  for (const file of TCP_FILES) {
    try {
      out.push(await readFile(file, "utf8"));
    } catch {}
  }
  return out;
}

export function tailscaledUid(): number | undefined {
  for (const path of socketCandidates()) {
    try {
      return statSync(path).uid;
    } catch {}
  }
  return undefined;
}

export interface SourceCheck {
  checkSource(req: IncomingMessage): Promise<boolean>;
  getSourceVerdict(): SourceVerdict;
  describe(): string;
}

export function sourceCheck(opts: SourceCheckOptions = {}): SourceCheck {
  const platform = opts.platform ?? process.platform;
  const own = opts.ownUid ?? process.getuid?.();
  const expected = opts.expectedUid ?? tailscaledUid;
  const tablesAsync = opts.tcpTablesAsync ?? readTcpTablesAsync;
  const ttl = opts.tableTtlMs ?? 2000;
  const decided = new WeakMap<Socket, boolean>();
  let cached: { at: number; tables: string[] } | undefined;
  const tablesAwaited = async (): Promise<string[]> => {
    if (cached && Date.now() - cached.at < ttl) return cached.tables;
    const read = await tablesAsync();
    cached = { at: Date.now(), tables: read };
    return read;
  };
  const tablesFresh = async (): Promise<string[]> => {
    const read = await tablesAsync();
    cached = { at: Date.now(), tables: read };
    return read;
  };
  const active = (): number | undefined => {
    const uid = expected();
    return platform === "linux" && uid !== undefined && own !== undefined && uid !== own ? uid : undefined;
  };
  const decide = (socket: Socket, tableList: string[]): boolean => {
    const hit = decided.get(socket);
    if (hit !== undefined) return hit;
    const uid = active();
    const ok = uid === undefined || connectionOwner(socket, tableList) === uid;
    decided.set(socket, ok);
    return ok;
  };
  const verdict = (): SourceVerdict => {
    const uid = active();
    if (uid !== undefined) return { enforced: true, detail: `a request is accepted only from a connection that user ${uid} (tailscaled) opened` };
    return {
      enforced: false,
      detail:
        platform === "linux"
          ? "not enforced: tailscaled's socket is not visible, or it runs as the same user as agentsocks, so a local process cannot be told from tailscaled"
          : "not enforced: only Linux can tell who opened a loopback connection",
    };
  };
  return {
    async checkSource(req) {
      const hit = decided.get(req.socket);
      if (hit !== undefined) return hit;
      if (active() === undefined) {
        decided.set(req.socket, true);
        return true;
      }
      let tableList = await tablesAwaited();
      if (connectionOwner(req.socket, tableList) === undefined) tableList = await tablesFresh();
      return decide(req.socket, tableList);
    },
    getSourceVerdict() {
      return verdict();
    },
    describe() {
      return verdict().detail;
    },
  };
}
