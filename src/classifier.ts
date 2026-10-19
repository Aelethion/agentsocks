import { readFileSync, statSync } from "node:fs";
import { agentsocksEnvPath, configPath, expandHome } from "./paths.ts";
import { VERSION } from "./version.ts";

export interface ClassifierInput {
  receiverKind: string;
  receiverTask?: string;
  receiverLastTool?: string;
  message: string;
}

export interface ClassifierResult {
  route: "now" | "pause" | "digest";
  confidence: number;
  probabilities?: Record<string, number>;
}

export interface ChooseInput {
  question: string;
  options: { id: string; text: string }[];
}

export interface ChooseResult {
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

export interface Classifier {
  name: string;
  remote: boolean;
  threshold: number;
  timeoutMs: number;
  classify(input: ClassifierInput, signal: AbortSignal): Promise<ClassifierResult>;
  choose?(input: ChooseInput, signal: AbortSignal): Promise<ChooseResult>;
}

export interface ClassifierConfig {
  backend: "none" | "systemone" | "gliner2";
  url?: string;
  model?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  allowRemote?: boolean;
  threshold?: number;
  timeoutMs?: number;
}

export interface AgentsocksConfig {
  classifier?: ClassifierConfig;
}

export type Warn = (message: string) => void;

const BACKENDS = new Set(["none", "systemone", "gliner2"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 100_000;
export const DEFAULT_KEY_VARIABLE = "AGENTSOCKS_CLASSIFIER_KEY";

export const DEFAULT_CLASSIFIER: Readonly<ClassifierConfig> = {
  backend: "systemone",
  url: "https://api.typesafe.ai",
  model: "jev-latest",
  apiKeyEnv: "TYPESAFE_API_KEY",
  allowRemote: true,
  threshold: DEFAULT_THRESHOLD,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};
const ROUTES = ["now", "pause", "digest"] as const;

const warned = new Set<string>();
const warnOnce: Warn = (message) => {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`agentsocks: ${message}`);
};

export function parseClassifierConfig(raw: unknown): ClassifierConfig | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "classifier config must be an object";
  const c = raw as Record<string, unknown>;
  if (typeof c.backend !== "string" || !BACKENDS.has(c.backend)) return `classifier.backend must be one of ${[...BACKENDS].join(", ")}`;
  const text = (key: string): string | undefined | "bad" => (c[key] === undefined ? undefined : typeof c[key] === "string" && c[key] ? (c[key] as string) : "bad");
  const url = text("url");
  const model = text("model");
  const apiKeyEnv = text("apiKeyEnv");
  const apiKeyFile = text("apiKeyFile");
  for (const [key, value] of Object.entries({ url, model, apiKeyEnv, apiKeyFile })) if (value === "bad") return `classifier.${key} must be a non-empty string`;
  if (c.allowRemote !== undefined && typeof c.allowRemote !== "boolean") return "classifier.allowRemote must be true or false";
  if (c.threshold !== undefined && !(typeof c.threshold === "number" && c.threshold >= 0 && c.threshold <= 1)) return "classifier.threshold must be a number from 0 to 1";
  if (c.timeoutMs !== undefined && !(typeof c.timeoutMs === "number" && c.timeoutMs >= 50 && c.timeoutMs <= MAX_TIMEOUT_MS)) return `classifier.timeoutMs must be a number from 50 to ${MAX_TIMEOUT_MS}`;
  return {
    backend: c.backend as ClassifierConfig["backend"],
    ...(typeof url === "string" && url !== "bad" && { url }),
    ...(typeof model === "string" && model !== "bad" && { model }),
    ...(typeof apiKeyEnv === "string" && apiKeyEnv !== "bad" && { apiKeyEnv }),
    ...(typeof apiKeyFile === "string" && apiKeyFile !== "bad" && { apiKeyFile }),
    ...(c.allowRemote !== undefined && { allowRemote: c.allowRemote as boolean }),
    ...(c.threshold !== undefined && { threshold: c.threshold as number }),
    ...(c.timeoutMs !== undefined && { timeoutMs: c.timeoutMs as number }),
  };
}

export function readConfig(path = configPath()): { config: AgentsocksConfig; exists: boolean; error?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { config: {}, exists: false } : { config: {}, exists: false, error: `cannot read ${path}: ${(err as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { config: {}, exists: true, error: `${path} is not valid JSON` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config: {}, exists: true, error: `${path} must contain a JSON object` };
  const section = (raw as { classifier?: unknown }).classifier;
  if (section === undefined) return { config: {}, exists: true };
  const parsed = parseClassifierConfig(section);
  return typeof parsed === "string" ? { config: {}, exists: true, error: parsed } : { config: { classifier: parsed }, exists: true };
}

export interface EffectiveConfig {
  classifier: ClassifierConfig;
  source: "default" | "file" | "invalid";
  path: string;
  exists: boolean;
  error?: string;
}

export function effectiveConfig(path = configPath()): EffectiveConfig {
  const { config, exists, error } = readConfig(path);
  if (error) return { classifier: { backend: "none" }, source: "invalid", path, exists, error };
  if (config.classifier) return { classifier: config.classifier, source: "file", path, exists };
  const storedOnPurpose = readKeyFile(agentsocksEnvPath(), DEFAULT_CLASSIFIER.apiKeyEnv!) !== undefined;
  return { classifier: storedOnPurpose ? { ...DEFAULT_CLASSIFIER } : { backend: "none" }, source: "default", path, exists };
}

export function isLocalUrl(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname);
}

export function readKeyFile(path: string, variable: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === variable) return m[2]!.replace(/^(['"])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}

export interface FoundKey {
  key: string;
  from: "environment" | "apiKeyFile" | "env file";
}

// a key somebody stored on purpose beats one a shell happened to export, so `classifier jev --key -` reaches a broker that started with an older variable
export function findApiKey(config: Pick<ClassifierConfig, "apiKeyEnv" | "apiKeyFile">): FoundKey | undefined {
  const variable = config.apiKeyEnv ?? DEFAULT_KEY_VARIABLE;
  const fromConfiguredFile = config.apiKeyFile ? readKeyFile(expandHome(config.apiKeyFile), variable) : undefined;
  if (fromConfiguredFile) return { key: fromConfiguredFile, from: "apiKeyFile" };
  const fromEnvFile = readKeyFile(agentsocksEnvPath(), variable);
  if (fromEnvFile) return { key: fromEnvFile, from: "env file" };
  const fromEnvironment = process.env[variable];
  return fromEnvironment ? { key: fromEnvironment, from: "environment" } : undefined;
}

export const resolveApiKey = (config: Pick<ClassifierConfig, "apiKeyEnv" | "apiKeyFile">): string | undefined => findApiKey(config)?.key;

async function postJson(url: string, body: unknown, config: ClassifierConfig, signal: AbortSignal): Promise<unknown> {
  const key = resolveApiKey(config);
  if (!key && (config.apiKeyEnv || config.apiKeyFile)) throw new Error("the API key is no longer available");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": `agentsocks/${VERSION}`, ...(key && { authorization: `Bearer ${key}` }) },
    body: JSON.stringify(body),
    signal,
    // a redirect could carry the message text, and the key, to a host the config never allowed
    redirect: "error",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await readCapped(res));
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel();
    throw new Error("response too large");
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const SYSTEMONE_INSTRUCTIONS = "Given what the receiving coding-agent session is doing (receiver), does this message need it to stop or change course now?";
const SYSTEMONE_CRITERIA: Record<(typeof ROUTES)[number], string> = {
  now: "The message changes, blocks or endangers what the receiver is doing right now, or answers something it is waiting for, so it should see it at its next step.",
  pause: "Useful or a request, but it can wait until the receiver finishes its current step.",
  digest: "Status, thanks, FYI, reminders or chatter that can be read later in a batch.",
};

const GLINER_LABELS: Record<(typeof ROUTES)[number], string> = {
  now: "interrupt now: it blocks or changes the current work",
  pause: "wait until the current step is finished",
  digest: "batch for later: status, thanks or FYI",
};

const isRoute = (v: unknown): v is (typeof ROUTES)[number] => typeof v === "string" && (ROUTES as readonly string[]).includes(v);

function systemoneEndpoint(url: string): string {
  const base = url.replace(/\/+$/, "");
  return base.endsWith("/v1/systemone") ? base : `${base}/v1/systemone`;
}

const SYSTEMONE_CHOOSE_INSTRUCTIONS = "Which reply best answers the question?";

function systemone(config: ClassifierConfig, url: string): Pick<Classifier, "name" | "classify" | "choose"> {
  return {
    name: "systemone",
    async choose(input, signal) {
      const body = {
        ...(config.model && { model: config.model }),
        state: { question: input.question },
        questions: { best: { type: "choice", instructions: SYSTEMONE_CHOOSE_INSTRUCTIONS, criteria: Object.fromEntries(input.options.map((o) => [o.id, o.text])) } },
      };
      const json = (await postJson(systemoneEndpoint(url), body, config, signal)) as { answers?: { best?: { choice?: unknown; confidence?: unknown; probabilities?: unknown } } };
      const answer = json.answers?.best;
      if (!answer || typeof answer.choice !== "string" || !input.options.some((o) => o.id === answer.choice)) throw new Error("no choice among the replies in the answer");
      const probabilities = answer.probabilities && typeof answer.probabilities === "object" ? (answer.probabilities as Record<string, number>) : undefined;
      const values = probabilities ? Object.values(probabilities).filter((v) => typeof v === "number") : [];
      const chosen = probabilities?.[answer.choice];
      const confidence = typeof chosen === "number" ? chosen : values.length > 0 ? Math.max(...values) : answer.confidence;
      if (typeof confidence !== "number") throw new Error("no probabilities in the answer");
      return { choice: answer.choice, confidence, ...(probabilities && { probabilities }) };
    },
    async classify(input, signal) {
      const body = {
        ...(config.model && { model: config.model }),
        state: { receiver: { kind: input.receiverKind, current_task: input.receiverTask ?? null, last_tool: input.receiverLastTool ?? null }, message: input.message },
        questions: { delivery: { type: "choice", instructions: SYSTEMONE_INSTRUCTIONS, criteria: SYSTEMONE_CRITERIA } },
      };
      const json = (await postJson(systemoneEndpoint(url), body, config, signal)) as { answers?: { delivery?: { choice?: unknown; confidence?: unknown; probabilities?: unknown } } };
      const answer = json.answers?.delivery;
      if (!answer || !isRoute(answer.choice)) throw new Error("no delivery choice in the answer");
      const probabilities = answer.probabilities && typeof answer.probabilities === "object" ? (answer.probabilities as Record<string, number>) : undefined;
      const values = probabilities ? Object.values(probabilities).filter((v) => typeof v === "number") : [];
      const chosen = probabilities?.[answer.choice];
      const confidence = typeof chosen === "number" ? chosen : values.length > 0 ? Math.max(...values) : answer.confidence;
      if (typeof confidence !== "number") throw new Error("no probabilities in the answer");
      return { route: answer.choice, confidence, ...(probabilities && { probabilities }) };
    },
  };
}

function gliner2(config: ClassifierConfig, url: string): Pick<Classifier, "name" | "classify"> {
  const labels = ROUTES.map((r) => GLINER_LABELS[r]);
  return {
    name: "gliner2",
    async classify(input, signal) {
      const text = `Receiver is working on: ${input.receiverTask ?? "unknown"}. Last tool: ${input.receiverLastTool ?? "none"}. Incoming message: ${input.message}`;
      const json = (await postJson(`${url.replace(/\/+$/, "")}/classify`, { text, labels }, config, signal)) as { label?: unknown; confidence?: unknown };
      const route = ROUTES.find((r) => GLINER_LABELS[r] === json.label);
      if (!route) throw new Error("unknown label in the answer");
      if (typeof json.confidence !== "number") throw new Error("no confidence in the answer");
      return { route, confidence: json.confidence };
    },
  };
}

export function loadClassifier(cfg: ClassifierConfig, warn: Warn = warnOnce): Classifier | undefined {
  if (cfg.backend === "none") return undefined;
  if (!cfg.url) {
    warn(`classifier backend ${cfg.backend} needs a url, so no classifier is used`);
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(cfg.url);
  } catch {
    warn(`classifier url is not a valid URL, so no classifier is used`);
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    warn(`classifier url must be http or https, so no classifier is used`);
    return undefined;
  }
  const remote = !isLocalUrl(url);
  if (remote && cfg.allowRemote !== true) {
    warn(`classifier ${cfg.backend} at ${url.host} is not on this machine; message text would leave it, so it is refused unless the config sets "allowRemote": true`);
    return undefined;
  }
  if (remote && url.protocol !== "https:") {
    warn(`classifier ${cfg.backend} at ${url.host} is remote and not https, so it is refused`);
    return undefined;
  }
  if ((cfg.apiKeyEnv || cfg.apiKeyFile) && !resolveApiKey(cfg)) {
    warn(`key ${cfg.apiKeyEnv ?? DEFAULT_KEY_VARIABLE} not set: classifier off`);
    return undefined;
  }
  const adapter = cfg.backend === "systemone" ? systemone(cfg, cfg.url) : gliner2(cfg, cfg.url);
  return { ...adapter, remote, threshold: cfg.threshold ?? DEFAULT_THRESHOLD, timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

export const loadEffective = (effective: EffectiveConfig, warn: Warn = warnOnce): Classifier | undefined => loadClassifier(effective.classifier, warn);

function fileStamp(path: string): string {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return "absent";
  }
}

export function watchClassifier(warn: Warn = warnOnce, path = configPath()): () => Classifier | undefined {
  let stamp = "";
  let current: Classifier | undefined;
  let keyFile: string | undefined;
  const keyStamp = (): string => (keyFile ? fileStamp(expandHome(keyFile)) : "");
  return () => {
    const files = `${fileStamp(path)}|${fileStamp(agentsocksEnvPath())}`;
    if (`${files}|${keyStamp()}` !== stamp) {
      const effective = effectiveConfig(path);
      if (effective.error) warn(effective.error);
      keyFile = effective.classifier.apiKeyFile;
      // the config and env files are stamped before they are read and the key file before its key is, so a change made during the read differs from the stamp and is loaded on the next call
      stamp = `${files}|${keyStamp()}`;
      current = loadEffective(effective, warn);
    }
    return current;
  };
}
