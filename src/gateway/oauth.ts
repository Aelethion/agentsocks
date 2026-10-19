import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../audit.ts";
import { cleanText } from "../limits.ts";
import { header, HttpError, lastForwardedFor, readBody, sendJson, sendText } from "./http.ts";
import { FailureWindow } from "./failures.ts";
import { ensurePeer } from "./remote.ts";
import type { RequestContext, Route } from "./routes.ts";
import type { Gateway } from "./runtime.ts";
import { parseAllow, type PeerRow } from "./state.ts";

export const PAIRING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 3_600_000;
const REFRESH_TTL_MS = 30 * 86_400_000;
const MAX_CLIENTS = 50;
const IDLE_CLIENT_MS = 10 * 60_000;
const MAX_REDIRECTS = 5;
const SCOPE = "agentsocks";
export const ACCESS_PREFIX = "oat_";
export const REFRESH_PREFIX = "ort_";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const secret = (): string => randomBytes(32).toString("base64url");

export interface ClientRow {
  client_id: string;
  name: string;
  redirect_uris: string;
  created_at: number;
}

interface CodeRow {
  client_id: string;
  redirect_uri: string;
  challenge: string;
  peer_name: string;
  may_message: string;
  family: string;
  expires_at: number;
}

interface TokenRowOf {
  hash: string;
  kind: "access" | "refresh";
  peer_id: string;
  client_id: string;
  family: string;
  expires_at: number;
  revoked_at: number | null;
}

export class OAuthStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createPairing(name: string, mayMessage: readonly string[], redirectHost: string | null = null, now = Date.now()): string {
    this.db.prepare("DELETE FROM gateway_pairings WHERE expires_at < ? OR used_at IS NOT NULL").run(now);
    for (;;) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const hash = sha(code);
      if (this.db.prepare("SELECT 1 FROM gateway_pairings WHERE hash = ?").get(hash)) continue;
      this.db
        .prepare("INSERT INTO gateway_pairings (hash, peer_name, may_message, redirect_host, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(hash, name, JSON.stringify(mayMessage), redirectHost, now + PAIRING_TTL_MS);
      return code;
    }
  }

  consumePairing(code: string, redirectHost: string, now = Date.now()): { peer_name: string; may_message: string } | undefined {
    const hash = sha(code);
    const row = this.db.prepare("SELECT peer_name, may_message, redirect_host FROM gateway_pairings WHERE hash = ? AND used_at IS NULL AND expires_at >= ?").get(hash, now) as
      | { peer_name: string; may_message: string; redirect_host: string | null }
      | undefined;
    if (!row || (row.redirect_host !== null && row.redirect_host !== redirectHost.toLowerCase())) return undefined;
    const claimed = this.db.prepare("UPDATE gateway_pairings SET used_at = ? WHERE hash = ? AND used_at IS NULL").run(now, hash);
    return Number(claimed.changes) === 1 ? { peer_name: row.peer_name, may_message: row.may_message } : undefined;
  }

  registerClient(name: string, redirectUris: string[], now = Date.now()): ClientRow | undefined {
    this.pruneIdleClients(now);
    const count = Number((this.db.prepare("SELECT COUNT(*) AS n FROM gateway_oauth_clients").get() as { n: number }).n);
    if (count >= MAX_CLIENTS) return undefined;
    const row: ClientRow = { client_id: `agc_${randomBytes(12).toString("base64url")}`, name, redirect_uris: JSON.stringify(redirectUris), created_at: now };
    this.db.prepare("INSERT INTO gateway_oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)").run(row.client_id, row.name, row.redirect_uris, row.created_at);
    return row;
  }

  pruneIdleClients(now = Date.now()): void {
    this.db
      .prepare(
        "DELETE FROM gateway_oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM gateway_oauth_tokens) AND client_id NOT IN (SELECT client_id FROM gateway_oauth_codes WHERE used_at IS NULL AND expires_at >= ?)",
      )
      .run(now - IDLE_CLIENT_MS, now);
  }

  client(id: string): ClientRow | undefined {
    return this.db.prepare("SELECT * FROM gateway_oauth_clients WHERE client_id = ?").get(id) as ClientRow | undefined;
  }

  issueCode(input: { clientId: string; redirectUri: string; challenge: string; peerName: string; mayMessage: string }, now = Date.now()): string {
    const code = secret();
    this.db
      .prepare("INSERT INTO gateway_oauth_codes (hash, client_id, redirect_uri, challenge, peer_name, may_message, family, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sha(code), input.clientId, input.redirectUri, input.challenge, input.peerName, input.mayMessage, `g-${randomBytes(4).toString("hex")}`, now + CODE_TTL_MS);
    return code;
  }

  takeCode(code: string, now = Date.now()): { row?: CodeRow; reused: boolean } {
    const hash = sha(code);
    const row = this.db.prepare("SELECT * FROM gateway_oauth_codes WHERE hash = ?").get(hash) as (CodeRow & { used_at: number | null }) | undefined;
    if (!row) return { reused: false };
    const claimed = this.db.prepare("UPDATE gateway_oauth_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL").run(now, hash);
    if (Number(claimed.changes) !== 1) return { reused: true };
    return row.expires_at < now ? { reused: false } : { row, reused: false };
  }

  revokeFamilyOfCode(code: string, now = Date.now()): string | undefined {
    const row = this.db.prepare("SELECT family FROM gateway_oauth_codes WHERE hash = ?").get(sha(code)) as { family: string } | undefined;
    if (row) this.revokeFamily(row.family, now);
    return row?.family;
  }

  peersOfFamily(family: string): string[] {
    return (this.db.prepare("SELECT DISTINCT peer_id AS id FROM gateway_oauth_tokens WHERE family = ?").all(family) as { id: string }[]).map((r) => r.id);
  }

  issueTokens(peerId: string, clientId: string, family: string, now = Date.now()): { access: string; refresh: string; expiresIn: number } {
    const access = `${ACCESS_PREFIX}${secret()}`;
    const refresh = `${REFRESH_PREFIX}${secret()}`;
    const insert = this.db.prepare("INSERT INTO gateway_oauth_tokens (hash, kind, peer_id, client_id, family, expires_at) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run(sha(access), "access", peerId, clientId, family, now + ACCESS_TTL_MS);
    insert.run(sha(refresh), "refresh", peerId, clientId, family, now + REFRESH_TTL_MS);
    return { access, refresh, expiresIn: ACCESS_TTL_MS / 1000 };
  }

  token(value: string): TokenRowOf | undefined {
    return this.db.prepare("SELECT * FROM gateway_oauth_tokens WHERE hash = ?").get(sha(value)) as TokenRowOf | undefined;
  }

  revokeToken(value: string, now = Date.now()): void {
    this.db.prepare("UPDATE gateway_oauth_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL").run(now, sha(value));
  }

  revokeFamily(family: string, now = Date.now()): number {
    return Number(this.db.prepare("UPDATE gateway_oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL").run(now, family).changes);
  }

  families(): { family: string; peer_id: string; client_id: string; created: number; live: number }[] {
    return this.db
      .prepare("SELECT family, peer_id, client_id, MIN(expires_at) AS created, SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS live FROM gateway_oauth_tokens GROUP BY family")
      .all() as unknown as { family: string; peer_id: string; client_id: string; created: number; live: number }[];
  }

  sweep(now = Date.now()): void {
    this.db.prepare("DELETE FROM gateway_oauth_codes WHERE expires_at < ?").run(now - 3_600_000);
    this.db.prepare("DELETE FROM gateway_pairings WHERE expires_at < ?").run(now - 3_600_000);
    this.db.prepare("DELETE FROM gateway_oauth_tokens WHERE expires_at < ?").run(now - 86_400_000);
  }
}

export function publicBase(gateway: Gateway, _req: IncomingMessage): string {
  const configured = gateway.publicSettings().url;
  if (configured) return configured;
  const port = gateway.port("public");
  return port === null ? "http://127.0.0.1" : `http://127.0.0.1:${port}`;
}

export function bearerChallenge(gateway: Gateway, req: IncomingMessage): Record<string, string> {
  return { "WWW-Authenticate": `Bearer realm="agentsocks", resource_metadata="${publicBase(gateway, req)}/.well-known/oauth-protected-resource"` };
}

const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function validRedirect(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 512) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.hash || url.username || url.password) return undefined;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return raw;
  return undefined;
}

const form = async (req: IncomingMessage): Promise<URLSearchParams> => {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") throw new HttpError(415, "content-type must be application/x-www-form-urlencoded");
  return new URLSearchParams((await readBody(req, 16 * 1024)).toString("utf8"));
};

const source = (req: IncomingMessage): string => lastForwardedFor(req) ?? req.socket.remoteAddress ?? "unknown";

interface PollCloser {
  closePollsFor?: (match: (peerId: string) => boolean) => void;
}

function endPolls(gateway: Gateway, peerId: string): void {
  const registry: PollCloser = gateway as unknown as PollCloser;
  registry.closePollsFor?.((id) => id === peerId);
}

function oauthError(res: ServerResponse, status: number, error: string, description: string): void {
  sendJson(res, status, { error, error_description: description }, { Pragma: "no-cache" });
}

const oauthAll = new FailureWindow(600, 60_000);

function guard(ctx: RequestContext): void {
  const key = source(ctx.req);
  const calls = ctx.gateway.limits.oauthCalls;
  if (calls.blocked(key)) throw new HttpError(429, "too many requests", { "Retry-After": String(calls.retryAfterSeconds(key)) });
  calls.record(key);
  if (oauthAll.blocked("all")) throw new HttpError(429, "too many requests", { "Retry-After": String(oauthAll.retryAfterSeconds("all")) });
  oauthAll.record("all");
}
async function protectedResource(ctx: RequestContext): Promise<void> {
  const base = publicBase(ctx.gateway, ctx.req);
  sendJson(ctx.res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: [SCOPE], resource_name: "agentsocks" });
}

async function authorizationServer(ctx: RequestContext): Promise<void> {
  const base = publicBase(ctx.gateway, ctx.req);
  sendJson(ctx.res, 200, {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  });
}

async function register(ctx: RequestContext): Promise<void> {
  guard(ctx);
  const type = String(ctx.req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "content-type must be application/json");
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse((await readBody(ctx.req, 16 * 1024)).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return oauthError(ctx.res, 400, "invalid_client_metadata", "the body must be a JSON object");
    body = parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 413 || err.status === 408)) throw err;
    return oauthError(ctx.res, 400, "invalid_client_metadata", "the body is not JSON");
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(validRedirect) : [];
  if (uris.length === 0 || uris.length > MAX_REDIRECTS || uris.some((u) => !u)) return oauthError(ctx.res, 400, "invalid_redirect_uri", "give one to five https redirect_uris (http only for localhost)");
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") return oauthError(ctx.res, 400, "invalid_client_metadata", "only public clients (token_endpoint_auth_method none) are accepted");
  const name = cleanText(body.client_name, 60) || "an application";
  const client = new OAuthStore(ctx.broker.store.db).registerClient(name, uris as string[]);
  if (!client) throw new HttpError(429, "too many applications are registered; try again in a few minutes", { "Retry-After": "600" });
  sendJson(
    ctx.res,
    201,
    {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(client.created_at / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
    { Pragma: "no-cache" },
  );
}

interface AuthorizeRequest {
  client: ClientRow;
  redirectUri: string;
  challenge: string;
  state: string | null;
}

function parseAuthorize(store: OAuthStore, params: URLSearchParams): AuthorizeRequest | string {
  if (params.get("response_type") !== "code") return "response_type must be code";
  const client = store.client(params.get("client_id") ?? "");
  if (!client) return "unknown client";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!(JSON.parse(client.redirect_uris) as string[]).includes(redirectUri)) return "redirect_uri is not one this client registered";
  if (params.get("code_challenge_method") !== "S256") return "code_challenge_method must be S256";
  const challenge = params.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return "code_challenge must be the base64url of a SHA-256 digest";
  const state = params.get("state");
  if (state !== null && state.length > 512) return "state is too long";
  return { client, redirectUri, challenge, state };
}

function page(res: ServerResponse, status: number, title: string, body: string): void {
  const nonce = randomBytes(12).toString("base64");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b}input{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;letter-spacing:.3em}button{font:inherit;padding:.6rem 1.2rem;margin-top:.8rem}code{background:#eee;padding:0 .3em}@media(prefers-color-scheme:dark){body{background:#151515;color:#eee}code{background:#333}}</style></head><body>${body}</body></html>`;
  sendText(res, status, "text/html; charset=utf-8", html, { "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`, "X-Frame-Options": "DENY" });
}

function consent(res: ServerResponse, params: URLSearchParams, a: AuthorizeRequest, message = ""): void {
  const host = new URL(a.redirectUri).host;
  const hidden = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope"]
    .filter((k) => params.get(k) !== null)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params.get(k)!)}">`)
    .join("");
  page(
    res,
    200,
    "Connect to agentsocks",
    `<h1>Connect to agentsocks</h1><p><strong>${esc(a.client.name)}</strong> wants to message the agent sessions on this machine. After you approve, it returns to <code>${esc(host)}</code>.</p><p>Only approve this if you started it. Type the pairing code that <code>agentsocks gateway pair chatgpt</code> printed on this machine.</p>${message ? `<p><strong>${esc(message)}</strong></p>` : ""}<form method="post" action="/oauth/authorize">${hidden}<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus><button type="submit">Connect</button></form>`,
  );
}

async function authorizeForm(ctx: RequestContext): Promise<void> {
  guard(ctx);
  const store = new OAuthStore(ctx.broker.store.db);
  const parsed = parseAuthorize(store, ctx.url.searchParams);
  if (typeof parsed === "string") return page(ctx.res, 400, "Cannot connect", `<h1>Cannot connect</h1><p>${esc(parsed)}.</p>`);
  consent(ctx.res, ctx.url.searchParams, parsed);
}

async function authorizeSubmit(ctx: RequestContext): Promise<void> {
  const origin = header(ctx.req, "origin");
  const host = header(ctx.req, "host");
  if (origin !== undefined) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {}
    if (!host || originHost !== host.toLowerCase()) throw new HttpError(403, "cross-origin requests are refused");
  }
  guard(ctx);
  const params = await form(ctx.req);
  const store = new OAuthStore(ctx.broker.store.db);
  const parsed = parseAuthorize(store, params);
  if (typeof parsed === "string") return page(ctx.res, 400, "Cannot connect", `<h1>Cannot connect</h1><p>${esc(parsed)}.</p>`);
  const { pairing: bySource, pairingAll } = ctx.gateway.limits;
  const from = source(ctx.req);
  if (bySource.blocked(from) || pairingAll.blocked("all")) {
    audit("oauth_pairing_locked", {});
    return page(ctx.res, 429, "Too many attempts", `<h1>Too many attempts</h1><p>Pairing is locked for a few minutes after wrong codes. Try again later.</p>`);
  }
  const code = (params.get("code") ?? "").trim();
  const pairing = /^[0-9]{6}$/.test(code) ? store.consumePairing(code, new URL(parsed.redirectUri).hostname) : undefined;
  if (!pairing) {
    bySource.record(from);
    pairingAll.record("all");
    audit("oauth_pairing_failed", {});
    return consent(ctx.res, params, parsed, "That code did not work.");
  }
  const granted = store.issueCode({ clientId: parsed.client.client_id, redirectUri: parsed.redirectUri, challenge: parsed.challenge, peerName: pairing.peer_name, mayMessage: pairing.may_message });
  const back = new URL(parsed.redirectUri);
  back.searchParams.set("code", granted);
  if (parsed.state !== null) back.searchParams.set("state", parsed.state);
  audit("oauth_consent", { client: parsed.client.name, peer: pairing.peer_name });
  ctx.res.writeHead(302, { Location: back.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  ctx.res.end();
}

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  const got = createHash("sha256").update(verifier).digest("base64url");
  return got.length === challenge.length && timingSafeEqual(Buffer.from(got), Buffer.from(challenge));
}

async function tokenEndpoint(ctx: RequestContext): Promise<void> {
  guard(ctx);
  const params = await form(ctx.req);
  const store = new OAuthStore(ctx.broker.store.db);
  const grant = params.get("grant_type");
  const clientId = params.get("client_id") ?? "";
  if (!store.client(clientId)) return oauthError(ctx.res, 401, "invalid_client", "unknown client");
  if (grant === "authorization_code") {
    const code = params.get("code") ?? "";
    const taken = store.takeCode(code);
    if (taken.reused) {
      const family = store.revokeFamilyOfCode(code);
      if (family !== undefined) for (const peerId of store.peersOfFamily(family)) endPolls(ctx.gateway, peerId);
      audit("oauth_code_reuse", { client: clientId });
      return oauthError(ctx.res, 400, "invalid_grant", "the code was already used");
    }
    const row = taken.row;
    if (!row || row.client_id !== clientId || row.redirect_uri !== (params.get("redirect_uri") ?? "") || !pkceMatches(params.get("code_verifier") ?? "", row.challenge)) {
      return oauthError(ctx.res, 400, "invalid_grant", "the code, redirect_uri or code_verifier is not right");
    }
    const peer = await ensureOauthPeer(ctx.gateway, row.peer_name, parseAllow(row.may_message), true);
    const issued = store.issueTokens(peer.id, clientId, row.family);
    audit("oauth_token", { peer: peer.name, grant: "authorization_code" });
    return sendJson(ctx.res, 200, { access_token: issued.access, token_type: "Bearer", expires_in: issued.expiresIn, refresh_token: issued.refresh, scope: SCOPE }, { Pragma: "no-cache" });
  }
  if (grant === "refresh_token") {
    const presented = params.get("refresh_token") ?? "";
    const row = presented.startsWith(REFRESH_PREFIX) ? store.token(presented) : undefined;
    if (!row || row.kind !== "refresh" || row.client_id !== clientId) return oauthError(ctx.res, 400, "invalid_grant", "unknown refresh token");
    const grantPeer = ctx.gateway.state.getPeer(row.peer_id);
    if (!grantPeer || grantPeer.disabled) return oauthError(ctx.res, 400, "invalid_grant", "that grant is switched off");
    if (row.revoked_at !== null) {
      store.revokeFamily(row.family);
      endPolls(ctx.gateway, row.peer_id);
      audit("oauth_refresh_reuse", { client: clientId });
      return oauthError(ctx.res, 400, "invalid_grant", "that refresh token was already used, so this grant is revoked");
    }
    if (row.expires_at < Date.now()) return oauthError(ctx.res, 400, "invalid_grant", "the refresh token expired");
    store.revokeToken(presented);
    const issued = store.issueTokens(row.peer_id, clientId, row.family);
    return sendJson(ctx.res, 200, { access_token: issued.access, token_type: "Bearer", expires_in: issued.expiresIn, refresh_token: issued.refresh, scope: SCOPE }, { Pragma: "no-cache" });
  }
  return oauthError(ctx.res, 400, "unsupported_grant_type", "use authorization_code or refresh_token");
}

export async function ensureOauthPeer(gateway: Gateway, name: string, mayMessage: readonly string[], refreshAllow = false): Promise<PeerRow> {
  const id = `oauth:${name.toLowerCase()}`;
  const existing = gateway.state.getPeer(id);
  await ensurePeer(gateway.broker, { id, name, via: "oauth", mayMessage });
  if (refreshAllow && (!existing || existing.disabled)) {
    if (existing?.disabled) {
      const store = new OAuthStore(gateway.broker.store.db);
      for (const family of store.families()) if (family.peer_id === id) store.revokeFamily(family.family);
    }
    gateway.state.updatePeer(id, { may_message: JSON.stringify(mayMessage), disabled: 0 });
  }
  return gateway.state.getPeer(id)!;
}

export const oauthRoutes: readonly Route[] = [
  { method: "GET", path: "/.well-known/oauth-protected-resource", surface: "public", auth: "none", summary: "OAuth protected-resource metadata", handler: protectedResource },
  { method: "GET", path: "/.well-known/oauth-protected-resource/mcp", surface: "public", auth: "none", summary: "OAuth protected-resource metadata for /mcp", handler: protectedResource },
  { method: "GET", path: "/.well-known/oauth-authorization-server", surface: "public", auth: "none", summary: "OAuth authorization-server metadata", handler: authorizationServer },
  { method: "POST", path: "/oauth/register", surface: "public", auth: "none", summary: "OAuth dynamic client registration, public clients only", handler: register },
  { method: "GET", path: "/oauth/authorize", surface: "public", auth: "pairing", summary: "OAuth consent page, asks for the one-time pairing code", handler: authorizeForm },
  { method: "POST", path: "/oauth/authorize", surface: "public", auth: "pairing", summary: "OAuth consent, checks the pairing code and redirects with an authorization code", handler: authorizeSubmit },
  { method: "POST", path: "/oauth/token", surface: "public", auth: "none", summary: "OAuth token endpoint, PKCE S256 required", handler: tokenEndpoint },
];
