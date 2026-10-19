import type { IncomingMessage } from "node:http";
import { FailureWindow } from "./failures.ts";
import { header, HttpError, lastForwardedFor } from "./http.ts";
import { ACCESS_PREFIX, OAuthStore, bearerChallenge } from "./oauth.ts";
import { ensurePeer } from "./remote.ts";
import type { Caller } from "./routes.ts";
import type { Gateway } from "./runtime.ts";
import { TOKEN_PREFIX, Tokens } from "./tokens.ts";

const globalFailures = new FailureWindow(200, 60_000);

function presented(req: IncomingMessage): string | undefined {
  const auth = header(req, "authorization");
  const bearer = auth && /^Bearer\s+(\S+)\s*$/i.exec(auth);
  if (bearer) return bearer[1];
  const url = new URL(req.url ?? "/", "http://gateway.invalid");
  if (url.pathname === "/mcp") return url.searchParams.get("key") ?? undefined;
  return undefined;
}

export async function authenticateBearer(gateway: Gateway, req: IncomingMessage): Promise<Caller> {
  const source = lastForwardedFor(req) ?? req.socket.remoteAddress ?? "unknown";
  const value = presented(req);
  const db = gateway.broker.store.db;
  let peerId: string | undefined;
  if (value?.startsWith(TOKEN_PREFIX)) peerId = new Tokens(db).verify(value)?.peer_id;
  else if (value?.startsWith(ACCESS_PREFIX)) {
    const row = new OAuthStore(db).token(value);
    if (row && row.kind === "access" && row.revoked_at === null && row.expires_at > Date.now()) peerId = row.peer_id;
  }
  const peer = peerId ? gateway.state.getPeer(peerId) : undefined;
  if (!peer) {
    const failures = gateway.limits.authFailures;
    if (failures.blocked(source)) throw new HttpError(429, "too many failed attempts", { "Retry-After": String(failures.retryAfterSeconds(source)) });
    failures.record(source);
    if (globalFailures.blocked("all")) throw new HttpError(429, "too many failed attempts", { "Retry-After": String(globalFailures.retryAfterSeconds("all")) });
    globalFailures.record("all");
    throw new HttpError(401, "missing, wrong or revoked token", bearerChallenge(gateway, req));
  }
  if (peer.disabled) throw new HttpError(403, "this connection is switched off");
  const row = await ensurePeer(gateway.broker, { id: peer.id, name: peer.name, via: peer.via });
  return { peer: row, via: peer.via, surface: "public", toolset: "reduced" };
}
