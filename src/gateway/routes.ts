import type { IncomingMessage, ServerResponse } from "node:http";
import type { Broker } from "../broker.ts";
import type { Gateway } from "./runtime.ts";
import type { PeerRow, Via } from "./state.ts";
import type { TailnetIdentity } from "./auth.ts";

export type Surface = "private" | "public";
export type RouteAuth = "tailnet" | "bearer" | "none" | "pairing";
export type Principal = "agent" | "app" | "host";
export type Toolset = "full" | "reduced";

export interface Caller {
  peer: PeerRow;
  via: Via;
  surface: Surface;
  toolset: Toolset;
  identity?: TailnetIdentity;
}

export type Authenticated = { kind: "peer"; caller: Caller } | { kind: "host"; host: string; identity: TailnetIdentity } | { kind: "none" };

export interface RequestContext {
  broker: Broker;
  gateway: Gateway;
  surface: Surface;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  auth: Authenticated;
  afterResponse(fn: () => void): void;
}

export interface Route {
  method: "GET" | "POST" | "DELETE";
  path: string;
  surface: Surface;
  auth: RouteAuth;
  principal?: Principal;
  summary: string;
  handler(ctx: RequestContext): Promise<void>;
}

export function routes(...lists: (readonly Route[])[]): readonly Route[] {
  const all = lists.flat();
  const seen = new Set<string>();
  for (const r of all) {
    const key = `${r.surface} ${r.method} ${r.path}`;
    if (seen.has(key)) throw new Error(`gateway route ${key} is registered twice`);
    seen.add(key);
  }
  return all;
}

export function callerOf(ctx: RequestContext): Caller {
  if (ctx.auth.kind !== "peer") throw new Error("route handler asked for a peer on a route that does not authenticate one");
  return ctx.auth.caller;
}

const AUTH_TEXT: Record<RouteAuth, string> = {
  tailnet: "tailnet identity (via tailscale serve)",
  bearer: "bearer token or OAuth access token",
  none: "none",
  pairing: "one-time pairing code",
};

export const authText = (route: Pick<Route, "auth" | "principal">): string => (route.principal === "host" ? "tailnet identity of an allowed machine" : AUTH_TEXT[route.auth]);
