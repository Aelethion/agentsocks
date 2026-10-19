import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_CLASSIFIER, DEFAULT_KEY_VARIABLE, DEFAULT_THRESHOLD, DEFAULT_TIMEOUT_MS, effectiveConfig, findApiKey, isLocalUrl, loadEffective, readKeyFile, type ClassifierConfig, type EffectiveConfig } from "./classifier.ts";
import { agentsocksEnvPath, configPath, expandHome } from "./paths.ts";
import { brokerCall } from "./client.ts";

const JEV_HOST = "api.typesafe.ai";
const KEY_URL = "https://console.typesafe.ai/keys";
const KEY_FROM = { environment: "the environment", apiKeyFile: "the apiKeyFile", "env file": "the agentsocks env file" } as const;

export const CHANGE_COMMANDS = [
  "agentsocks classifier jev [--key - | --key-file <path>]   hosted TypeSafe Jev (off until turned on); --key-file reads a KEY=VALUE file, --key - reads the key from stdin",
  "agentsocks classifier local <url> [--backend systemone|gliner2]   a model on your own hardware",
  "agentsocks classifier off                                      rules only",
];

const hostOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
};

function shownUrl(url: string | undefined): string {
  if (!url) return "(none)";
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    return "(not a valid URL)";
  }
}

const isJev = (e: EffectiveConfig): boolean => e.classifier.backend === "systemone" && hostOf(e.classifier.url) === JEV_HOST;

const ambientKey = (e: EffectiveConfig): boolean => e.source === "default" && e.classifier.backend === "none" && !!process.env[DEFAULT_CLASSIFIER.apiKeyEnv!];

export function inspect(e: EffectiveConfig) {
  const refused: string[] = [];
  const classifier = loadEffective(e, (m) => refused.push(m));
  const c = e.classifier;
  const variable = c.apiKeyEnv ?? DEFAULT_KEY_VARIABLE;
  const found = c.backend === "none" ? undefined : findApiKey(c);
  const keyWanted = !!(c.apiKeyEnv || c.apiKeyFile);
  const ignored = found && found.from !== "environment" && process.env[variable] ? `; the ${variable} in the environment is ignored` : "";
  const apiKey = found
    ? `found in ${KEY_FROM[found.from]} (${variable})${ignored}`
    : keyWanted
      ? `key ${variable} not set: classifier off`
      : ambientKey(e)
        ? `not used (the ${DEFAULT_CLASSIFIER.apiKeyEnv} in the environment is ignored until you run \`agentsocks classifier jev\`)`
        : "not used";
  return { classifier, refused, apiKey, found: !!found, keyWanted, variable };
}

export function keySource(e: EffectiveConfig = effectiveConfig()): string | undefined {
  const { found, apiKey } = inspect(e);
  return found ? apiKey : undefined;
}

export function routingLine(e: EffectiveConfig = effectiveConfig()): string {
  const { classifier, found, variable } = inspect(e);
  const change = "Change it with `agentsocks classifier`.";
  const host = hostOf(e.classifier.url) ?? "its configured host";
  if (e.source === "invalid") return `Smart routing is off: ${e.error}. Rules still route every message. ${change}`;
  if (e.source === "default" && e.classifier.backend === "none") {
    if (ambientKey(e)) return `Smart routing is off: a ${DEFAULT_CLASSIFIER.apiKeyEnv} is in your environment; run \`agentsocks classifier jev --key-file <file>\` (or pipe it with --key -) to turn on smart routing. Rules still route every message.`;
    return `Smart routing is off. To turn on TypeSafe Jev, get a key at ${KEY_URL}, then run \`agentsocks classifier jev --key-file <file>\` on a KEY=VALUE file, or pipe it in with \`printf '%s' "$TYPESAFE_API_KEY" | agentsocks classifier jev --key -\`, which keeps it out of your shell history. Rules still route every message.`;
  }
  if (e.classifier.backend === "none") return `Smart routing is off (rules only). ${change}`;
  if (classifier?.remote) {
    const label = isJev(e) ? "TypeSafe Jev" : e.classifier.backend;
    return `Smart routing: ${label} (grey-zone messages and the receiver's redacted task are sent to ${host}). ${change}`;
  }
  if (classifier) return `Smart routing: ${e.classifier.backend} at ${host} on this machine (nothing leaves it). ${change}`;
  if (!found && isJev(e)) {
    return `Smart routing is off until you set ${variable} (get a key at ${KEY_URL}, then run \`agentsocks classifier jev --key-file <file>\` on a KEY=VALUE file, or pipe it in with \`printf '%s' "$TYPESAFE_API_KEY" | agentsocks classifier jev --key -\`, which keeps it out of your shell history). Rules still route every message.`;
  }
  return `Smart routing is off: the ${e.classifier.backend} classifier is configured but not active. Rules still route every message. ${change}`;
}

export async function brokerDisagrees(e: EffectiveConfig = effectiveConfig()): Promise<string | undefined> {
  const { classifier, variable } = inspect(e);
  if (!classifier) return undefined;
  try {
    const pong = await brokerCall<{ classifier?: { active?: boolean } }>("ping", {}, { autoStart: false, timeoutMs: 1000 });
    if (pong.classifier?.active !== false) return undefined;
  } catch {
    return undefined;
  }
  return `note: the running broker reports its classifier as off. If it was started without ${variable} in its environment (Codex starts MCP servers with a small one), give it the key with \`agentsocks classifier jev --key-file <file>\` on a KEY=VALUE file, or pipe it in with \`printf '%s' "$TYPESAFE_API_KEY" | agentsocks classifier jev --key -\`; the broker picks that up without a restart.`;
}

export async function showClassifier(json: boolean, e: EffectiveConfig = effectiveConfig()): Promise<number> {
  const { classifier, refused, apiKey } = inspect(e);
  const c = e.classifier;
  if (json) {
    const out = {
      configFile: e.path,
      present: e.exists,
      source: e.source,
      ...(e.error && { error: e.error }),
      classifier: { ...c, ...(c.url && { url: shownUrl(c.url) }), active: !!classifier, remote: classifier?.remote ?? null, apiKey, ...(refused.length && { refused }) },
    };
    console.log(JSON.stringify(out, null, 2));
    return e.error ? 1 : 0;
  }
  console.log(`config file: ${e.path} (${e.exists ? "present" : "not present"})`);
  if (e.error) console.log(`problem: ${e.error}`);
  if (c.backend === "none") {
    console.log(`classifier: none${e.source === "default" ? " chosen. Hosted TypeSafe Jev turns on only after `agentsocks classifier jev`" : ""}. Messages the rules do not decide are delivered at the receiver's next tool call, unless it was interrupted 3 times in the last 10 minutes.`);
    if (e.source === "default") console.log(`  api key: ${apiKey}\n  ${routingLine(e)}`);
  } else {
    const label = e.source === "default" ? `${c.backend} (TypeSafe Jev, using the key stored in the agentsocks env file)` : c.backend;
    const state = classifier ? (classifier.remote ? `active, REMOTE (message text leaves this machine for ${hostOf(c.url)})` : "active, local") : "not active";
    console.log(`classifier: ${label}, ${state}`);
    console.log(`  url ${shownUrl(c.url)}${c.model ? `, model ${c.model}` : ""}, threshold ${c.threshold ?? DEFAULT_THRESHOLD}, timeout ${c.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`);
    console.log(`  api key: ${apiKey}`);
    for (const w of refused) console.log(`  refused: ${w}`);
    if (!classifier && e.source === "default") console.log(`  ${routingLine(e)}`);
  }
  const disagreement = await brokerDisagrees(e);
  if (disagreement) console.log(`\n${disagreement}`);
  console.log("\nChange it:");
  for (const line of CHANGE_COMMANDS) console.log(`  ${line}`);
  return e.error ? 1 : 0;
}

const KEY_VALUE = /^[\x21-\x7e]+$/;

function resolveLinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path;
    } catch {
      return path;
    }
  }
}

function writeAtomic(path: string, text: string): void {
  const target = resolveLinks(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    renameSync(temp, target);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {}
    throw err;
  }
}

function existingConfig(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must contain a JSON object; fix or remove it and run this again`);
    return raw as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err instanceof SyntaxError ? new Error(`${path} is not valid JSON; fix or remove it and run this again`) : err;
  }
}

function storeKey(variable: string, key: string): string {
  if (!KEY_VALUE.test(key) || /["'\\]/.test(key)) throw new Error("the key must be one visible token with no spaces or quotes");
  const path = agentsocksEnvPath();
  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  while (lines.at(-1) === "") lines.pop();
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`);
  const kept = lines.filter((l) => !assignment.test(l));
  writeAtomic(path, `${[...kept, `${variable}=${key}`].join("\n")}\n`);
  return path;
}

function take(args: string[], name: string): string | undefined {
  const joined = args.findIndex((a) => a.startsWith(`${name}=`));
  if (joined !== -1) return args.splice(joined, 1)[0]!.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || (value.startsWith("--") && value !== "-")) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function switchOn(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function noLeftovers(args: string[], usage: string): void {
  if (args.length > 0) throw new Error(`unexpected ${args.map((a) => (a.startsWith("--") ? a.split("=")[0] : "argument")).join(" ")}. Usage: ${usage}`);
}

const USAGE = {
  jev: "agentsocks classifier jev [--key - | --key-file <path>]",
  local: "agentsocks classifier local <url> [--backend systemone|gliner2] [--allow-remote]",
  off: "agentsocks classifier off",
};

function jev(args: string[]): { classifier: ClassifierConfig; notes: string[]; store?: () => string } {
  const given = take(args, "--key");
  const key = given === "-" ? readFileSync(0, "utf8").trim() : given;
  const keyFile = take(args, "--key-file");
  noLeftovers(args, USAGE.jev);
  if (key !== undefined && keyFile !== undefined) throw new Error("use --key or --key-file, not both");
  const { allowRemote, ...base } = DEFAULT_CLASSIFIER;
  const classifier: ClassifierConfig = { backend: base.backend, url: base.url, model: base.model, apiKeyEnv: base.apiKeyEnv, allowRemote };
  const notes: string[] = [];
  if (keyFile !== undefined) {
    classifier.apiKeyFile = keyFile.startsWith("~/") || keyFile === "~" ? keyFile : resolve(keyFile);
    if (!readKeyFile(expandHome(classifier.apiKeyFile), DEFAULT_CLASSIFIER.apiKeyEnv!)) notes.push(`${classifier.apiKeyFile} has no ${DEFAULT_CLASSIFIER.apiKeyEnv} line yet, so smart routing stays off until it does`);
  }
  if (key === undefined) return { classifier, notes };
  return { classifier, notes, store: () => storeKey(DEFAULT_CLASSIFIER.apiKeyEnv!, key) };
}

function local(args: string[]): { classifier: ClassifierConfig; notes: string[] } {
  const backend = take(args, "--backend") ?? "systemone";
  if (backend !== "systemone" && backend !== "gliner2") throw new Error("--backend must be systemone or gliner2");
  const allowRemote = switchOn(args, "--allow-remote");
  const url = args.shift();
  noLeftovers(args, USAGE.local);
  if (!url) throw new Error(`a url is needed. Usage: ${USAGE.local}`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("the url must be http or https");
  if (parsed.username || parsed.password) throw new Error("the url must not carry a user name or password; put a key in the key file instead");
  if (isLocalUrl(parsed)) return { classifier: { backend, url }, notes: [] };
  if (parsed.protocol !== "https:") throw new Error(`${parsed.host} is not on this machine, so it must be https (or use localhost, for example through an ssh tunnel)`);
  if (!allowRemote) throw new Error(`${parsed.host} is not this machine: message text and the receiver's redacted task would be sent to it. If that is what your user wants, run the command again with --allow-remote`);
  return { classifier: { backend, url, allowRemote: true }, notes: [`${parsed.host} is not this machine: message text and the receiver's redacted task will be sent to it`] };
}

export function changeClassifier(rest: string[]): string[] {
  const [sub, ...args] = [...rest];
  let change: { classifier: ClassifierConfig; notes: string[]; store?: () => string };
  if (sub === "jev") change = jev(args);
  else if (sub === "local") change = local(args);
  else if (sub === "off") {
    noLeftovers(args, USAGE.off);
    change = { classifier: { backend: "none" }, notes: [] };
  } else throw new Error(`unknown classifier command "${sub}". Use:\n  ${CHANGE_COMMANDS.join("\n  ")}`);
  const path = configPath();
  const other = existingConfig(path);
  const notes = [...change.notes];
  if (change.store) notes.push(`key stored in ${change.store()} (mode 600).`);
  writeAtomic(path, `${JSON.stringify({ ...other, classifier: change.classifier }, null, 2)}\n`);
  const through = resolveLinks(path) === path ? "" : ` (through the symlink to ${resolveLinks(path)})`;
  return [`classifier set in ${path}${through}; the daemon picks it up on its own.`, ...notes, routingLine(effectiveConfig(path))];
}
