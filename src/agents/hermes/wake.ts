import { readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { isLocalUrl, readKeyFile } from "../../classifier.ts";
import { THREAD_ID } from "../../limits.ts";
import { agentsocksEnvPath, configPath, expandHome } from "../../paths.ts";
import { VERSION } from "../../version.ts";
import { isRecord } from "../files.ts";
import { listeningSinks, offerWake, sinkId } from "../opencode/sink.ts";
import type { WakeRequest, WakeOutcome } from "../types.ts";
import { PLUGIN_NAME } from "./plugin.ts";

export const KEY_VARIABLE = "HERMES_API_SERVER_KEY";
const HERMES_OWN_VARIABLE = "API_SERVER_KEY";
const KEY_TOKEN = /^[\x21-\x7e]+$/;

export interface WakeSettings {
  base: URL;
  key: string;
}

export type WakeConfig = { state: "off" } | { state: "incomplete"; why: string } | ({ state: "on" } & WakeSettings);

function configured(path: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(doc) && isRecord(doc.hermes) ? doc.hermes : undefined;
  } catch {
    return undefined;
  }
}

export function wakeConfig(path = configPath()): WakeConfig {
  const c = configured(path);
  if (!c || c.apiUrl === undefined) return { state: "off" };
  if (typeof c.apiUrl !== "string") return { state: "incomplete", why: "hermes.apiUrl in the agentsocks config must be a string" };
  let base: URL;
  try {
    base = new URL(c.apiUrl);
  } catch {
    return { state: "incomplete", why: "hermes.apiUrl in the agentsocks config is not a valid URL" };
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return { state: "incomplete", why: "hermes.apiUrl must be http or https" };
  if (base.username || base.password) return { state: "incomplete", why: "hermes.apiUrl must not carry a user name or password" };
  if (!isLocalUrl(base)) {
    if (c.allowRemote !== true) return { state: "incomplete", why: `the Hermes API at ${base.host} is not on this machine; the wake line would leave it, so set "allowRemote": true in the hermes config to allow that` };
    if (base.protocol !== "https:") return { state: "incomplete", why: `the Hermes API at ${base.host} is remote and not https, so it is refused` };
  }
  const file = typeof c.apiKeyFile === "string" && c.apiKeyFile ? expandHome(c.apiKeyFile) : undefined;
  const key =
    (file && (readKeyFile(file, KEY_VARIABLE) ?? readKeyFile(file, HERMES_OWN_VARIABLE))) ||
    readKeyFile(agentsocksEnvPath(), KEY_VARIABLE);
  if (!key) return { state: "incomplete", why: `no ${KEY_VARIABLE} found in ${file ?? agentsocksEnvPath()}` };
  if (!KEY_TOKEN.test(key)) return { state: "incomplete", why: `the ${KEY_VARIABLE} value has characters that cannot go in an Authorization header` };
  return { state: "on", base, key };
}

// Hermes 0.23 runs every CLI, TUI and Desktop turn through its gateway's session authority, and its API server
// starts a turn only in a session whose source is the API server itself (gateway/session_api_turn.py refuses any
// other with permission_denied, HTTP 409). So the API wake reaches API-created sessions and nothing else.
export const HERMES_API_WAKE_REACH =
  "the Hermes API wake reaches only sessions created through Hermes's API server; Hermes 0.23 refuses it (HTTP 409) for CLI, TUI and Desktop sessions, which wait for their next turn";
export const NO_PLUGIN = "no agentsocks Hermes plugin is listening for this session";
export const HERMES_NO_WAKE =
  "No agentsocks Hermes plugin is polling, so a message waits until the next turn. Run `agentsocks install --hermes` and keep Hermes running with the chat open; see \"Waking an idle Hermes session\" in docs/GUIDE.md.";

export const pluginDir = (home: string): string => join(home, "plugins", PLUGIN_NAME);

// The plugin wakes CLI, TUI and Desktop chats; the API wake is an optional extra, so leaving it off says nothing.
export function describeWake(config: WakeConfig): string | undefined {
  if (config.state === "on") return `API wake on through ${config.base.origin}; ${HERMES_API_WAKE_REACH}`;
  if (config.state === "incomplete") return `API wake is not active: ${config.why}`;
  return undefined;
}

export interface WakeLimits {
  connectMs: number;
  acceptMs: number;
  holdMs: number;
  maxBytes: number;
}

export const WAKE_LIMITS: WakeLimits = { connectMs: 3000, acceptMs: 8000, holdMs: 15 * 60_000, maxBytes: 64 * 1024 };

export function sendWake(settings: WakeSettings, sessionId: string, line: string, limits: WakeLimits = WAKE_LIMITS): Promise<WakeOutcome> {
  const { base } = settings;
  const secure = base.protocol === "https:";
  const where = base.host;
  const body = JSON.stringify({ input: line });
  return new Promise((resolve) => {
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (outcome: WakeOutcome): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolve(outcome);
    };
    const after = (ms: number, fn: () => void): NodeJS.Timeout => {
      const t = setTimeout(fn, ms);
      t.unref();
      timers.push(t);
      return t;
    };
    const req = (secure ? https : http).request(
      {
        hostname: base.hostname.replace(/^\[|\]$/g, ""),
        port: base.port || (secure ? 443 : 80),
        method: "POST",
        path: `${base.pathname.replace(/\/+$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/chat`,
        agent: false,
        headers: {
          authorization: `Bearer ${settings.key}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": `agentsocks/${VERSION}`,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        let seen = 0;
        res.on("data", (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > limits.maxBytes) req.destroy();
        });
        res.on("error", () => {});
        done(
          status >= 200 && status < 300
            ? { ok: true }
            : {
                ok: false,
                detail:
                  status >= 300 && status < 400
                    ? `HTTP ${status} from ${where}; redirects are not followed`
                    : status === 409
                      ? `HTTP 409 from ${where}: Hermes starts API turns only in sessions its API server created, not in a CLI, TUI or Desktop session`
                      : `HTTP ${status} from ${where}`,
              },
        );
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => done({ ok: false, detail: `${err.code === "ECONNREFUSED" ? "connection refused" : (err.code ?? "request failed")} at ${where}` }));
    const connect = after(limits.connectMs, () => {
      done({ ok: false, detail: `no connection to ${where} within ${limits.connectMs} ms` });
      req.destroy();
    });
    req.on("socket", (socket) => (socket.connecting ? socket.once(secure ? "secureConnect" : "connect", () => clearTimeout(connect)) : clearTimeout(connect)));
    req.on("finish", () => after(limits.acceptMs, () => done({ ok: true })));
    const hold = setTimeout(() => req.destroy(), limits.holdMs);
    hold.unref();
    req.on("close", () => clearTimeout(hold));
    req.end(body);
  });
}

const SESSION = /^hermes_([A-Za-z0-9_-]+)$/;

export const hermesWake = {
  wake: async ({ broker, thread, line }: WakeRequest): Promise<WakeOutcome> => {
    const session = THREAD_ID.test(thread.thread_id) ? SESSION.exec(thread.thread_id)?.[1] : undefined;
    if (!session) return { ok: false, detail: "not a Hermes session id" };
    const sink = sinkId(thread.remote);
    if (sink && offerWake(broker, sink, { session, line, agent: "hermes" })) return { ok: true };
    // A chat no plugin has attached yet may still be open in a backend: every listening plugin is offered it,
    // and Hermes starts a turn only in the backend that holds that chat.
    const offered = listeningSinks(broker, "hermes-").filter((id) => id !== sink).map((id) => offerWake(broker, id, { session, line, agent: "hermes" }));
    if (offered.includes(true)) return { ok: true };
    const config = wakeConfig();
    if (config.state === "on") return sendWake(config, session, line);
    return { ok: false, detail: config.state === "incomplete" ? `${NO_PLUGIN}; ${config.why}` : NO_PLUGIN };
  },
};
