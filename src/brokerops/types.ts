import type { Broker } from "../broker.ts";

export interface Reply {
  result: unknown;
  commit?: () => void;
}

export interface Conn {
  isClosed: () => boolean;
  onClose: (fn: () => void) => void;
}

export type OpRequest = { op?: unknown; [k: string]: unknown };

export type OpHandler = (broker: Broker, req: OpRequest, conn: Conn) => Promise<Reply>;

export type OpTable = Readonly<Record<string, OpHandler>>;
