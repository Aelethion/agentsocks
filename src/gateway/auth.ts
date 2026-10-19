import type { IncomingMessage } from "node:http";
import { header, hostName, HttpError, lastForwardedFor } from "./http.ts";
import type { Tailnet } from "./tailscale.ts";
import { isIP } from "node:net";
import { FailureWindow } from "./failures.ts";

export interface TailnetIdentity {
  login: string;
  node: string;
  nodeId: string;
  os: string | null;
  ip: string;
}
export interface TailnetChecks {
  tailnet: Tailnet;
  extraLogins: () => readonly string[];
}

const tailnetFailures = new FailureWindow(20, 60_000);

function deny(key: string, status: number, message: string): never {
  tailnetFailures.record(key);
  if (status === 429) throw new HttpError(status, message, { "Retry-After": String(tailnetFailures.retryAfterSeconds(key)) });
  throw new HttpError(status, message);
}

export async function authenticateTailnet(req: IncomingMessage, checks: TailnetChecks): Promise<TailnetIdentity> {
  if (req.headers["tailscale-funnel-request"] !== undefined) {
    throw new HttpError(403, "this listener serves your tailnet only; funnel traffic is refused here");
  }
  const claimed = header(req, "tailscale-user-login")?.trim();
  if (!claimed) throw new HttpError(401, "no Tailscale identity: reach this listener through tailscale serve from a node signed in as a user");
  const ip = lastForwardedFor(req);
  if (!ip || !isIP(ip)) throw new HttpError(401, "the request carries no source address to check the identity against");
  const who = await checks.tailnet.whois(ip);
  if (!who) throw new HttpError(403, "tailscale could not identify the caller");
  const key = `whois:${who.login.toLowerCase()}`;
  if (tailnetFailures.blocked(key)) throw new HttpError(429, "too many failed attempts", { "Retry-After": String(tailnetFailures.retryAfterSeconds(key)) });
  if (who.tagged) deny(key, 403, "tagged nodes have no user and are not accepted");
  if (who.login.toLowerCase() !== claimed.toLowerCase()) deny(key, 403, "the identity header does not match the node that connected");
  const own = await checks.tailnet.self();
  if (!own) throw new HttpError(503, "tailscale did not say who owns this node, so nobody is let in");
  const accepted = [own.login, ...checks.extraLogins()].map((l) => l.toLowerCase());
  if (!accepted.includes(who.login.toLowerCase())) deny(key, 403, "only the user this node belongs to may use the gateway");
  return { login: who.login, node: who.node, nodeId: who.nodeId, os: who.os, ip };
}

export async function checkBrowserOrigin(req: IncomingMessage, tailnet: Tailnet): Promise<void> {
  const own = await tailnet.self();
  const ours = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (own) ours.add(own.dnsName.toLowerCase());
  const hostHeader = header(req, "host") ?? "";
  if (!ours.has(hostName(hostHeader))) throw new HttpError(403, "unexpected Host header");
  const fetchSite = header(req, "sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") throw new HttpError(403, "cross-site requests are refused");
  const origin = header(req, "origin");
  if (origin === undefined) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, "unexpected Origin header");
  }
  if (!ours.has(hostName(parsed.host))) throw new HttpError(403, "cross-origin requests are refused");
  const fallback = parsed.protocol === "http:" ? "80" : "443";
  const headerPort = (/^\[.*\]:(\d+)$/.exec(hostHeader)?.[1] ?? (hostHeader.split(":").length === 2 ? hostHeader.split(":")[1]! : "")) || fallback;
  if ((parsed.port || fallback) !== headerPort) throw new HttpError(403, "cross-origin requests are refused");
}
