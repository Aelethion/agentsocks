import { brokerCall } from "../client.ts";
import { callerIsAgent } from "../peers.ts";
import { FUNNEL_EXPLAINED, SERVE_EXPLAINED, cloudflaredCommand, funnelCommand, funnelOffCommand, offCallTimeoutMs, render, runCommand, serveCommand, serveOffCommand } from "../gateway/expose.ts";
import { flag, option } from "./args.ts";
import { frame } from "./frame.ts";
import type { Handler } from "./types.ts";

interface ListenerReport {
  wanted: boolean;
  listening: boolean;
  port: number | null;
  configuredPort?: number;
  exposed?: boolean;
  error?: string;
  served?: boolean;
  serveCommand?: string;
  serveOffCommand?: string;
  via?: string;
  url?: string;
  command?: string;
  offCommand?: string | null;
}

export interface SourceCheckReport {
  enforced: boolean;
  detail: string;
}

export interface StoppedReport {
  reason: string;
  privateStopped: boolean;
  publicStopped: boolean;
  federationLinks: number;
  apiPeers: number;
  polls: number;
  serveUndone: boolean;
  funnelUndone: boolean;
}

export interface GatewayReport {
  killSwitch: boolean;
  requests: number;
  lastActivity: number | null;
  sourceCheck?: SourceCheckReport;
  stopped?: StoppedReport;
  private: ListenerReport & { served: boolean; serveCommand: string; serveOffCommand: string };
  public: ListenerReport & { via: string; command: string };
  peers: { name: string; via: string; machine: string | null; mayMessage: string[]; disabled: boolean; lastSeen: number | null }[];
  tokens?: { id: string; label: string; createdAt: number; lastUsedAt: number | null }[];
  users?: string[];
  hosts?: { host: string; allowed: boolean; linked: boolean; url?: string | null; connected?: boolean; error?: string }[];
}

export function requirePerson(what: string): void {
  if (callerIsAgent()) throw new Error(`${what} is for you to run in your own terminal. An agent session does not set up network access or credentials.`);
}

export function multiOption(args: string[], name: string): string[] {
  const i = args.indexOf(name);
  if (i === -1) return [];
  let end = i + 1;
  while (end < args.length && !args[end]!.startsWith("--")) end++;
  return args.splice(i, end - i).slice(1);
}

const port = (value: string | undefined, what: string): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${what} must be a whole number from 0 to 65535`);
  return n;
};

const ago = (ms: number | null): string => {
  if (ms === null) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function formatReport(r: GatewayReport): string {
  const listener = (name: string, l: ListenerReport, extra = ""): string => {
    const state = l.listening ? `listening on 127.0.0.1:${l.port}` : l.wanted ? `wanted but not listening${l.error ? ` (${l.error})` : r.killSwitch ? " (kill switch)" : ""}` : "off";
    return `  ${name.padEnd(17)}${state}${extra}`;
  };
  const lines = ["gateway", listener("private listener", r.private, r.private.served ? ", tailscale serve set up by agentsocks" : ""), listener("public listener", r.public, r.public.wanted ? `, via ${r.public.via}${r.public.url ? ` at ${r.public.url}` : ""}` : "")];
  lines.push(`  kill switch      ${r.killSwitch ? "ON, the gateway answers nothing" : "off"}`);
  lines.push(`  requests         ${r.requests}, last activity ${ago(r.lastActivity)}`);
  if (r.sourceCheck) lines.push(`  source check     ${r.sourceCheck.enforced ? "enforced" : "NOT enforced"}: ${r.sourceCheck.detail.replace(/^not enforced: /, "")}`);
  lines.push("peers");
  if (r.peers.length === 0) lines.push("  none");
  for (const p of r.peers) lines.push(`  ${p.name}  via ${p.via}${p.machine ? ` (${p.machine})` : ""}, last seen ${ago(p.lastSeen)}, may message ${p.mayMessage.length ? p.mayMessage.join(", ") : "nobody"}${p.disabled ? ", switched off" : ""}`);
  if (r.tokens) {
    lines.push("tokens (ids only)");
    if (r.tokens.length === 0) lines.push("  none");
    for (const t of r.tokens) lines.push(`  ${t.id}  ${t.label}, created ${ago(t.createdAt)}, last used ${ago(t.lastUsedAt)}`);
  }
  if (r.users && r.users.length > 0) lines.push(`other users allowed in: ${r.users.join(", ")}`);
  if (r.hosts) {
    lines.push("machines");
    if (r.hosts.length === 0) lines.push("  none");
    for (const h of r.hosts) lines.push(`  ${h.host}  ${h.allowed ? "allowed to link here" : ""}${h.allowed && h.linked ? ", " : ""}${h.linked ? `linked from here, ${h.connected ? "connected" : `not connected${h.error ? ` (${h.error})` : ""}`}` : ""}`);
  }
  return lines.join("\n");
}

async function on(args: string[]): Promise<number> {
  requirePerson("agentsocks gateway on");
  const serve = flag(args, "--serve");
  const allowUnverified = flag(args, "--allow-unverified-local-source");
  const wanted = port(option(args, "--port"), "--port");
  const check = (await brokerCall<GatewayReport>("gateway_status")).sourceCheck;
  if (check && !check.enforced) {
    if (!allowUnverified) {
      throw new Error(
        `the gateway cannot check who opened a connection to it: ${check.detail.replace(/^not enforced: /, "")}. Without that check, any program on this machine could present itself as one of your tailnet devices. Fix that (run tailscaled as its own user on Linux), or accept the risk for this machine with: agentsocks gateway on --allow-unverified-local-source`,
      );
    }
    console.log(`Source check not enforced (${check.detail.replace(/^not enforced: /, "")}). --allow-unverified-local-source means any program on this machine can present itself as a tailnet device to the gateway; only run it on a machine where you trust every local user and process.`);
  } else if (check) {
    console.log(`Source check enforced: ${check.detail}.`);
  }
  const report = await brokerCall<GatewayReport>("gateway_on", { ...(wanted !== undefined && { port: wanted }) }, { timeoutMs: 15_000 });
  if (!report.private.listening) throw new Error(`the gateway could not start: ${report.private.error ?? "unknown error"}`);
  const command = serveCommand(report.private.port!);
  console.log(`agentsocks gateway: listening on 127.0.0.1:${report.private.port}, on this machine only. Nothing else can reach it yet.`);
  if (!serve) {
    console.log("To reach it from your own devices on your tailnet, run:");
    console.log(`  ${render(command)}`);
    console.log(`That command ${SERVE_EXPLAINED}. Undo it with: ${render(serveOffCommand(report.private.port!))}`);
    console.log("Or let agentsocks run it: agentsocks gateway on --serve");
    return 0;
  }
  console.log(`Running: ${render(command)}`);
  console.log(`This ${SERVE_EXPLAINED}.`);
  const code = await runCommand(command);
  if (code !== 0) throw new Error(`${command[0]} exited with ${code}; the gateway is still listening on 127.0.0.1 only`);
  await brokerCall("gateway_served", { served: true });
  return 0;
}

export function stoppedLines(stopped: StoppedReport, privatePort: number | null, publicPort: number | null): string[] {
  const lines = ["agentsocks gateway: stopped. Nothing is listening."];
  const did: string[] = [];
  if (stopped.privateStopped) did.push(`private listener${privatePort ? ` (127.0.0.1:${privatePort})` : ""}`);
  if (stopped.publicStopped) did.push(`public listener${publicPort ? ` (127.0.0.1:${publicPort})` : ""}`);
  if (stopped.federationLinks > 0) did.push(`${stopped.federationLinks} federation link${stopped.federationLinks === 1 ? "" : "s"}`);
  if (stopped.apiPeers > 0) did.push(`${stopped.apiPeers} API peer${stopped.apiPeers === 1 ? "" : "s"} paused`);
  if (stopped.polls > 0) did.push(`${stopped.polls} in-flight request${stopped.polls === 1 ? "" : "s"} ended`);
  lines.push(did.length ? `Stopped: ${did.join(", ")}.` : "Nothing was running.");
  return lines;
}

async function off(): Promise<number> {
  const before = await brokerCall<GatewayReport>("gateway_status");
  const report = await brokerCall<GatewayReport>("gateway_off", {}, { timeoutMs: offCallTimeoutMs() });
  const stopped = report.stopped;
  if (!stopped) throw new Error("the broker did not say what it stopped; run agentsocks gateway status");
  const privatePort = before.private.port ?? before.private.configuredPort ?? 0;
  const publicPort = before.public.port ?? before.public.configuredPort ?? 0;
  for (const line of stoppedLines(stopped, before.private.port, before.public.port)) console.log(line);
  if (before.private.served) {
    const undo = render(serveOffCommand(privatePort));
    console.log(`Undoing the tailscale serve that agentsocks set up: ${undo}`);
    if (!stopped.serveUndone) console.log("That did not succeed: the tailscale serve-off command failed, so the served flag is kept and a later gateway off or uninstall retries it. Run it yourself to stop serving.");
  } else {
    console.log(`If you ran tailscale serve for it yourself, undo it with: ${render(serveOffCommand(privatePort))}`);
  }
  if (before.public.exposed) {
    const undo = render(funnelOffCommand(publicPort));
    console.log(`Undoing the tailscale funnel that agentsocks set up: ${undo}`);
    if (!stopped.funnelUndone) console.log("That did not succeed: the tailscale funnel-off command failed, so the exposed flag is kept and a later gateway off or uninstall retries it. Run it yourself to stop the funnel.");
  }
  return 0;
}

async function routes(): Promise<number> {
  const { ROUTES } = await import("../gateway/table.ts");
  const { authText } = await import("../gateway/routes.ts");
  const rows = ROUTES.map((r) => [r.surface, r.method, r.path, authText(r), r.summary]);
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((row) => row[i]!.length)));
  for (const row of rows) console.log(`${row.slice(0, 4).map((cell, i) => cell.padEnd(widths[i]!)).join("  ")}  ${row[4]}`);
  return 0;
}

async function status(args: string[]): Promise<number> {
  const json = flag(args, "--json");
  const report = await brokerCall<GatewayReport>("gateway_status");
  console.log(json ? JSON.stringify(report, null, 2) : await frame(formatReport(report)));
  return 0;
}

async function publicCommand(args: string[]): Promise<number> {
  if (args[0] === "off") {
    const before = await brokerCall<GatewayReport>("gateway_status");
    const after = await brokerCall<GatewayReport>("gateway_public_off", {}, { timeoutMs: offCallTimeoutMs() });
    console.log("agentsocks gateway: the public listener is stopped.");
    if (before.public.exposed && before.public.offCommand) {
      if (after.public.exposed) console.log(`That did not succeed: the tailscale funnel-off command failed (${before.public.offCommand}), so the exposed flag is kept and a later public off or uninstall retries it. Run it yourself to stop the funnel.`);
      else console.log(`Undid the tailscale funnel that agentsocks set up: ${before.public.offCommand}.`);
    } else if (before.public.offCommand) console.log(`If you exposed it with tailscale funnel, undo that with: ${before.public.offCommand}`);
    else console.log("If cloudflared is still running for it, stop that process.");
    return 0;
  }
  requirePerson("agentsocks gateway public");
  const yes = flag(args, "--yes");
  const via = option(args, "--via");
  if (via !== "funnel" && via !== "cloudflared") throw new Error("usage: agentsocks gateway public --via funnel|cloudflared [--port <port>] [--url https://...] [--yes]");
  const wanted = port(option(args, "--port"), "--port");
  const url = option(args, "--url");
  const report = await brokerCall<GatewayReport>("gateway_public", { via, ...(wanted !== undefined && { port: wanted }), ...(url && { url }) }, { timeoutMs: 15_000 });
  if (!report.public.listening) throw new Error(`the public listener could not start: ${report.public.error ?? "unknown error"}`);
  const listenPort = report.public.port!;
  const command = via === "funnel" ? funnelCommand(listenPort) : cloudflaredCommand(listenPort);
  console.log(`agentsocks gateway: the public listener is on 127.0.0.1:${listenPort}, on this machine only. It is not reachable from the internet until you expose it.`);
  console.log("Exposing it is a decision for you. The command is:");
  console.log(`  ${render(command)}`);
  if (via === "funnel") console.log(`That command ${FUNNEL_EXPLAINED}. Undo it with: ${render(funnelOffCommand(listenPort))}`);
  else console.log("cloudflared stays in the foreground, so run it in its own terminal or service. It gives the public listener a public address.");
  if (!yes) {
    console.log("agentsocks will not run it without --yes.");
    return 0;
  }
  if (via === "cloudflared") {
    console.log("agentsocks does not start long-running tunnels for you; run the command above yourself.");
    return 0;
  }
  console.log(`Running: ${render(command)}`);
  const code = await runCommand(command);
  if (code !== 0) throw new Error(`${command[0]} exited with ${code}; the public listener is still on 127.0.0.1 only`);
  await brokerCall("gateway_public", { via, port: listenPort, exposed: true });
  return 0;
}

async function token(args: string[]): Promise<number> {
  const action = args.shift();
  if (action === "list" || action === undefined) {
    const report = await brokerCall<GatewayReport>("gateway_status");
    const tokens = (await brokerCall<{ tokens: NonNullable<GatewayReport["tokens"]> }>("gateway_token_list")).tokens;
    console.log(await frame(formatReport({ ...report, tokens })));
    return 0;
  }
  if (action === "revoke") {
    const id = args.shift();
    if (!id) throw new Error("usage: agentsocks gateway token revoke <id>");
    await brokerCall("gateway_token_revoke", { id });
    console.log(`revoked ${id}. Requests that use it are refused from now on.`);
    return 0;
  }
  if (action !== "add") throw new Error("usage: agentsocks gateway token add <name> [--may-message <peer>...] | list | revoke <id>");
  requirePerson("agentsocks gateway token add");
  const may = multiOption(args, "--may-message");
  const name = args.shift();
  if (!name) throw new Error("usage: agentsocks gateway token add <name> [--may-message <peer>...]");
  const made = await brokerCall<{ id: string; token: string; name: string; mayMessage: string[] }>("gateway_token_add", { name, mayMessage: may });
  console.log(`token for ${made.name} (id ${made.id}), shown once. Keep it; only a hash is stored.`);
  console.log(`  ${made.token}`);
  console.log(`It may message: ${made.mayMessage.length ? made.mayMessage.join(", ") : "nobody (add --may-message to allow some)"}.`);
  console.log("Send it as 'Authorization: Bearer <token>', or as ?key=<token> where a client cannot set headers.");
  return 0;
}

async function pair(args: string[]): Promise<number> {
  requirePerson("agentsocks gateway pair");
  const what = args.shift();
  if (what !== "chatgpt") throw new Error("usage: agentsocks gateway pair chatgpt [--may-message <peer>...] [--name <peer name>] [--redirect-host <host>]");
  const may = multiOption(args, "--may-message");
  const name = option(args, "--name") ?? "chatgpt";
  const redirectHost = option(args, "--redirect-host");
  const made = await brokerCall<{ code: string; expiresInMinutes: number; name: string; mayMessage: string[]; redirectHost: string | null }>("gateway_pair", { name, mayMessage: may, ...(redirectHost && { redirectHost }) });
  console.log(`pairing code for ${made.name}: ${made.code}`);
  console.log(`Type it into the consent page when ChatGPT sends you there. It works once and expires in ${made.expiresInMinutes} minutes.`);
  console.log(made.redirectHost ? `It only works for an application that returns to ${made.redirectHost}.` : "Read the host the consent page says it returns to; pin it next time with --redirect-host <host>.");
  const live = (await brokerCall<GatewayReport>("gateway_status")).peers.find((p) => p.name.toLowerCase() === made.name.toLowerCase());
  const applies = live?.mayMessage ?? made.mayMessage;
  console.log(`That connection may message: ${applies.length ? applies.join(", ") : "nobody (add --may-message to allow some)"}.${live ? " It keeps the list it already had." : ""}`);
  return 0;
}

async function may(args: string[]): Promise<number> {
  requirePerson("agentsocks gateway may");
  const peer = args.shift();
  if (!peer) throw new Error("usage: agentsocks gateway may <peer> [<name>...]   (no names means nobody; * means every session)");
  try {
    const made = await brokerCall<{ peer: string; mayMessage: string[] }>("gateway_may", { peer, mayMessage: args });
    console.log(`${made.peer} may now message: ${made.mayMessage.length ? made.mayMessage.join(", ") : "nobody"}.`);
  } catch (err) {
    const message = (err as Error).message;
    if (/no remote peer named/.test(message)) throw new Error(`${message}; if it was revoked or switched off, pair it again with agentsocks gateway pair chatgpt --may-message <peer>... to create a fresh grant`);
    throw err;
  }
  return 0;
}

async function allow(args: string[], allowed: boolean): Promise<number> {
  if (allowed) requirePerson("agentsocks gateway allow");
  const user = option(args, "--user");
  if (user !== undefined) {
    await brokerCall("gateway_allow", { user, allowed });
    console.log(allowed ? `${user} may use this machine's gateway from their own tailnet devices, as well as the user this node belongs to.` : `${user} may no longer use this machine's gateway.`);
    return 0;
  }
  const host = args.shift();
  if (!host) throw new Error(`usage: agentsocks gateway ${allowed ? "allow" : "disallow"} <host> | --user <login>`);
  await brokerCall("gateway_allow", { host, allowed });
  console.log(allowed ? `${host} may link to this machine's gateway (it still needs to run agentsocks link on its side).` : `${host} may no longer link to this machine's gateway.`);
  return 0;
}

const SUBCOMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  on,
  off: () => off(),
  status,
  routes,
  public: publicCommand,
  token,
  pair,
  may,
  allow: (args) => allow(args, true),
  disallow: (args) => allow(args, false),
};

export async function gatewayPortLine(): Promise<string> {
  try {
    const report = await brokerCall<GatewayReport>("gateway_status", {}, { autoStart: false, timeoutMs: 1000 });
    const port = report.private.configuredPort ?? report.private.port;
    if (port) return `This install's gateway port is ${port}: agentsocks gateway on uses it unless --port overrides it.`;
  } catch {}
  return "This install's gateway port is picked at random when the broker first runs: agentsocks gateway on uses it unless --port overrides it (gateway status shows it).";
}

 export const gateway: Handler = async (args) => {
   const sub = args.shift() ?? "status";
   const run = Object.hasOwn(SUBCOMMANDS, sub) ? SUBCOMMANDS[sub] : undefined;
   if (!run) throw new Error("usage: agentsocks gateway on|off|status|routes|public|token|pair|may|allow|disallow (see agentsocks help)");
   return run(args);
 };
