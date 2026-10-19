import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import "./support.ts";
import { DEFAULT_CLASSIFIER, effectiveConfig, findApiKey, loadClassifier, loadEffective, parseClassifierConfig, readConfig, resolveApiKey, watchClassifier, type Classifier } from "../src/classifier.ts";
import { changeClassifier } from "../src/classifiercmd.ts";
import { agentsocksEnvPath } from "../src/paths.ts";
import { Broker } from "../src/broker.ts";
import { decide, type BudgetView, type MessageView, type ReceiverView } from "../src/router.ts";
import { tempDir } from "./tmp.ts";

interface Seen {
  method?: string;
  url?: string;
  authorization?: string;
  body: Record<string, unknown>;
}

let seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end("{}");

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
    handler(req, res);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const reply = (payload: unknown, status = 200) => (_req: IncomingMessage, res: ServerResponse) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
};

const input = { receiverKind: "codex", receiverTask: "Fixing the flaky checkout test", receiverLastTool: "Edit", message: "Stop: main is red." };
const receiver: ReceiverView = { kind: "codex", state: "busy", currentTask: input.receiverTask, lastTool: input.receiverLastTool, awaitingReplyFromSender: false };
const message: MessageView = { body: input.message, urgency: "normal", duplicateOfRecent: false };
const budget: BudgetView = { receiverNowLast10m: 0, senderToReceiverLast10m: 0 };

function must(c: Classifier | undefined): Classifier {
  assert.ok(c, "classifier should load");
  return c;
}

test("systemone: posts the relational question with the receiver's context and takes the chosen route's probability as confidence", async () => {
  seen = [];
  handler = reply({ model: "jev-1", answers: { delivery: { type: "choice", choice: "now", confidence: 0.83, probabilities: { now: 0.87, pause: 0.08, digest: 0.05 } } } });
  process.env.TEST_JEV_KEY = "k-123";
  const c = must(loadClassifier({ backend: "systemone", url: base, model: "jev-latest", apiKeyEnv: "TEST_JEV_KEY" }));
  const r = await c.classify(input, AbortSignal.timeout(2000));
  assert.deepEqual([r.route, r.confidence], ["now", 0.87]);
  assert.equal(c.remote, false);
  const req = seen[0]!;
  assert.deepEqual([req.method, req.url, req.authorization], ["POST", "/v1/systemone", "Bearer k-123"]);
  assert.equal(req.body.model, "jev-latest");
  assert.deepEqual(req.body.state, { receiver: { kind: "codex", current_task: input.receiverTask, last_tool: "Edit" }, message: input.message });
  const delivery = (req.body.questions as { delivery: { type: string; instructions: string; criteria: Record<string, string> } }).delivery;
  assert.equal(delivery.type, "choice");
  assert.match(delivery.instructions, /does this message need it to stop or change course now\?/);
  assert.deepEqual(Object.keys(delivery.criteria), ["now", "pause", "digest"]);
  delete process.env.TEST_JEV_KEY;
});

test("systemone: no model and no key means neither is sent", async () => {
  seen = [];
  handler = reply({ answers: { delivery: { choice: "digest", probabilities: { now: 0.1, pause: 0.2, digest: 0.7 } } } });
  const c = must(loadClassifier({ backend: "systemone", url: `${base}/` }));
  await c.classify({ receiverKind: "claude", message: "thanks" }, AbortSignal.timeout(2000));
  assert.equal(seen[0]!.authorization, undefined);
  assert.equal("model" in seen[0]!.body, false);
  assert.deepEqual((seen[0]!.body.state as { receiver: unknown }).receiver, { kind: "claude", current_task: null, last_tool: null });
});

test("gliner2: posts text and labels to /classify and maps the returned label back to a route", async () => {
  seen = [];
  const labels: string[] = [];
  handler = (req, res) => {
    labels.push(...((seen.at(-1)!.body.labels as string[]) ?? []));
    reply({ label: labels[1], confidence: 0.77 })(req, res);
  };
  const c = must(loadClassifier({ backend: "gliner2", url: base }));
  const r = await c.classify(input, AbortSignal.timeout(2000));
  assert.deepEqual([r.route, r.confidence], ["pause", 0.77]);
  assert.equal(seen[0]!.url, "/classify");
  assert.equal(seen[0]!.body.text, "Receiver is working on: Fixing the flaky checkout test. Last tool: Edit. Incoming message: Stop: main is red.");
  assert.equal((seen[0]!.body.labels as string[]).length, 3);
  handler = reply({ label: "something we never asked for", confidence: 0.9 });
  await assert.rejects(c.classify(input, AbortSignal.timeout(2000)), /unknown label/);
});

test("a slow backend times out into the default route, and the in-flight request is cancelled", async () => {
  let cancelled = false;
  handler = (req) => req.on("close", () => (cancelled = true));
  const c = must(loadClassifier({ backend: "gliner2", url: base, timeoutMs: 80 }));
  const t0 = Date.now();
  const d = await decide(receiver, message, budget, c);
  assert.deepEqual([d.route, d.by], ["now", "default"]);
  assert.match(d.reason, /timed out after 80 ms/);
  assert.ok(Date.now() - t0 < 1000);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(cancelled, true);
});

test("low confidence from a real adapter falls back to the default; a confident answer decides", async () => {
  handler = reply({ answers: { delivery: { choice: "now", probabilities: { now: 0.45, pause: 0.35, digest: 0.2 } } } });
  const c = must(loadClassifier({ backend: "systemone", url: base }));
  const unsure = await decide(receiver, message, budget, c);
  assert.deepEqual([unsure.route, unsure.by, unsure.confidence], ["now", "default", 0.45]);
  handler = reply({ answers: { delivery: { choice: "now", probabilities: { now: 0.9, pause: 0.07, digest: 0.03 } } } });
  const sure = await decide(receiver, message, budget, c);
  assert.deepEqual([sure.route, sure.by, sure.backend], ["now", "classifier", "systemone"]);
  const strict = must(loadClassifier({ backend: "systemone", url: base, threshold: 0.95 }));
  assert.equal((await decide(receiver, message, budget, strict)).by, "default", "the configured threshold applies");
});

test("at the default threshold an answer holding half of the probability decides and a near three-way tie does not, as measured on hosted Jev", async () => {
  const c = must(loadClassifier({ backend: "systemone", url: base }));
  const probabilities = (digest: number, pause: number, now: number) => reply({ answers: { delivery: { choice: digest >= Math.max(pause, now) ? "digest" : "pause", probabilities: { now, pause, digest } } } });
  handler = probabilities(0.54, 0.41, 0.05);
  const decided = await decide(receiver, message, budget, c);
  assert.deepEqual([decided.route, decided.by, decided.confidence], ["digest", "classifier", 0.54]);
  handler = probabilities(0.45, 0.4, 0.15);
  const tie = await decide(receiver, message, budget, c);
  assert.deepEqual([tie.route, tie.by, tie.confidence], ["now", "default", 0.45]);
});

test("HTTP errors, garbage bodies and redirects never produce a route", async () => {
  const c = must(loadClassifier({ backend: "systemone", url: base }));
  for (const bad of [reply({ error: "boom" }, 500), (_q: IncomingMessage, res: ServerResponse) => res.end("not json"), reply({ answers: {} }), reply({ answers: { delivery: { choice: "explode", probabilities: { explode: 1 } } } })]) {
    handler = bad;
    assert.equal((await decide(receiver, message, budget, c)).by, "default");
  }
  seen = [];
  handler = (req, res) => {
    if (req.url === "/steal") return res.end("{}");
    res.statusCode = 302;
    res.setHeader("location", `${base}/steal`);
    res.end();
  };
  const d = await decide(receiver, message, budget, c);
  assert.deepEqual([d.route, d.by], ["now", "default"]);
  assert.equal(seen.filter((s) => s.url?.includes("steal")).length, 0);
});

test("a remote backend is refused unless the config allows it, and only over https", () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  assert.equal(loadClassifier({ backend: "systemone", url: "https://api.typesafe.ai" }, warn), undefined);
  assert.match(warnings[0]!, /allowRemote/);
  const allowed = must(loadClassifier({ backend: "systemone", url: "https://api.typesafe.ai", allowRemote: true }, warn));
  assert.equal(allowed.remote, true);
  assert.equal(loadClassifier({ backend: "systemone", url: "http://api.typesafe.ai", allowRemote: true }, warn), undefined, "plain http to another host is refused even when allowed");
  assert.match(warnings.at(-1)!, /not https/);
  for (const local of ["http://localhost:9", "http://127.0.0.1:9", "http://[::1]:9"]) {
    assert.equal(must(loadClassifier({ backend: "gliner2", url: local }, warn)).remote, false, local);
  }
  assert.equal(loadClassifier({ backend: "gliner2", url: "http://localhost.evil.example:9" }, warn), undefined, "a lookalike host is not local");
  assert.equal(loadClassifier({ backend: "none" }, warn), undefined);
  assert.equal(loadClassifier({ backend: "gliner2" }, warn), undefined, "a backend without a url is not usable");
});

test("defaults: threshold 0.5 and timeout 1500 ms", () => {
  const c = must(loadClassifier({ backend: "gliner2", url: base }));
  assert.deepEqual([c.threshold, c.timeoutMs, c.name], [0.5, 1500, "gliner2"]);
});

test("the config file is validated, API keys come from a KEY=VALUE file or the environment, and edits are picked up", () => {
  const dir = tempDir("agentsocks-cfg-");
  const path = join(dir, "config.json");
  assert.deepEqual(readConfig(path), { config: {}, exists: false });
  writeFileSync(path, "{ nope");
  assert.match(readConfig(path).error!, /not valid JSON/);
  writeFileSync(path, JSON.stringify({ classifier: { backend: "gliner2", url: base, threshold: 2 } }));
  assert.match(readConfig(path).error!, /threshold/);
  writeFileSync(path, JSON.stringify({ classifier: { backend: "skynet" } }));
  assert.match(readConfig(path).error!, /backend/);

  writeFileSync(path, JSON.stringify({ classifier: { backend: "gliner2", url: base, timeoutMs: 900 } }));
  const warnings: string[] = [];
  const current = watchClassifier((m) => warnings.push(m), path);
  assert.equal(current()!.timeoutMs, 900);
  writeFileSync(path, JSON.stringify({ classifier: { backend: "none" } }));
  assert.equal(current(), undefined, "an edited config takes effect without a restart");
  writeFileSync(path, "{ broken");
  assert.equal(current(), undefined);
  assert.ok(warnings.some((w) => /not valid JSON/.test(w)));

  const keyFile = join(dir, "keys.env");
  writeFileSync(keyFile, ["# comment", "OTHER=nope", `export TS_KEY="from-file"`, ""].join("\n"));
  delete process.env.TS_KEY;
  assert.equal(resolveApiKey({ apiKeyEnv: "TS_KEY", apiKeyFile: keyFile }), "from-file");
  process.env.TS_KEY = "from-env";
  assert.equal(resolveApiKey({ apiKeyEnv: "TS_KEY", apiKeyFile: keyFile }), "from-file", "a stored key beats the environment");
  assert.equal(resolveApiKey({ apiKeyEnv: "TS_KEY", apiKeyFile: join(dir, "absent.env") }), "from-env", "the environment is the last resort");
  delete process.env.TS_KEY;
  assert.equal(resolveApiKey({ apiKeyEnv: "MISSING_KEY", apiKeyFile: keyFile }), undefined);
  assert.equal(resolveApiKey({ apiKeyEnv: "TS_KEY", apiKeyFile: join(dir, "absent.env") }), undefined);
});

test("apiKeyFile may start with ~/, and the documented TypeSafe Jev config loads with its key from that file", () => {
  const home = tempDir("agentsocks-home-");
  mkdirSync(join(home, ".config", "typesafe"), { recursive: true });
  writeFileSync(join(home, ".config", "typesafe", "jev.env"), "TYPESAFE_API_KEY=from-home-file\n");
  const saved = { home: process.env.HOME, key: process.env.TYPESAFE_API_KEY };
  process.env.HOME = home;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const config = parseClassifierConfig({
      backend: "systemone",
      url: "https://api.typesafe.ai",
      model: "jev-latest",
      apiKeyEnv: "TYPESAFE_API_KEY",
      apiKeyFile: "~/.config/typesafe/jev.env",
      allowRemote: true,
    });
    assert.equal(typeof config, "object");
    assert.equal(resolveApiKey(config as Parameters<typeof resolveApiKey>[0]), "from-home-file");
    const loaded = must(loadClassifier(config as Parameters<typeof loadClassifier>[0], () => {}));
    assert.deepEqual([loaded.name, loaded.remote], ["systemone", true]);
    assert.equal(resolveApiKey({ apiKeyEnv: "TYPESAFE_API_KEY", apiKeyFile: "~other/.config/typesafe/jev.env" }), undefined, "only ~/ is expanded");
  } finally {
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.key !== undefined) process.env.TYPESAFE_API_KEY = saved.key;
  }
});

test("a response is streamed with a 100 kB cap and abandoned past it, so a hostile endpoint cannot make the broker buffer without end", async () => {
  let written = 0;
  let closed = false;
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const timer = setInterval(() => {
      written += res.write("x".repeat(64 * 1024)) ? 64 * 1024 : 0;
    }, 1);
    res.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
  };
  const c = must(loadClassifier({ backend: "gliner2", url: base, timeoutMs: 3000 }));
  await assert.rejects(c.classify(input, AbortSignal.timeout(3000)), /response too large/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(closed, true, "the connection was dropped");
  assert.ok(written < 4_000_000, `${written} bytes were sent before it was dropped`);
  handler = reply({ label: "wait until the current step is finished", confidence: 0.9 });
  assert.equal((await c.classify(input, AbortSignal.timeout(2000))).route, "pause", "an ordinary answer is unaffected");
});

test("the classifier timeout is capped at 5000 ms, and a configured key that is not set switches the classifier off", () => {
  assert.match(String(parseClassifierConfig({ backend: "gliner2", url: base, timeoutMs: 6000 })), /timeoutMs must be a number from 50 to 5000/);
  assert.equal(typeof parseClassifierConfig({ backend: "gliner2", url: base, timeoutMs: 5000 }), "object");
  const warnings: string[] = [];
  delete process.env.NOPE_KEY;
  assert.equal(loadClassifier({ backend: "gliner2", url: base, apiKeyEnv: "NOPE_KEY" }, (m) => warnings.push(m)), undefined);
  assert.deepEqual(warnings, ["key NOPE_KEY not set: classifier off"]);
  process.env.NOPE_KEY = "now-set";
  assert.ok(loadClassifier({ backend: "gliner2", url: base, apiKeyEnv: "NOPE_KEY" }, () => {}));
  delete process.env.NOPE_KEY;
});

const jevEnv = "TYPESAFE_API_KEY";
const clearJevKey = () => {
  delete process.env[jevEnv];
  rmSync(agentsocksEnvPath(), { force: true });
};

test("with no config file, or a file without a classifier key, no classifier is chosen: the source is the default and the backend is none", () => {
  clearJevKey();
  const dir = tempDir("agentsocks-j1-");
  const absent = effectiveConfig(join(dir, "absent.json"));
  assert.equal(absent.source, "default");
  assert.deepEqual(absent.classifier, { backend: "none" });
  assert.deepEqual(DEFAULT_CLASSIFIER, { backend: "systemone", url: "https://api.typesafe.ai", model: "jev-latest", apiKeyEnv: "TYPESAFE_API_KEY", allowRemote: true, threshold: 0.5, timeoutMs: 1500 }, "the hosted Jev preset that `classifier jev` writes");
  const other = join(dir, "other.json");
  writeFileSync(other, JSON.stringify({ unrelated: { keep: true } }));
  const e = effectiveConfig(other);
  assert.deepEqual([e.source, e.exists, e.error, e.classifier.backend], ["default", true, undefined, "none"]);
});

test("an explicit backend none, and a config that cannot be read, turn the classifier off instead of falling back to the default", () => {
  const dir = tempDir("agentsocks-j1-");
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ classifier: { backend: "none" } }));
  const off = effectiveConfig(path);
  assert.deepEqual([off.source, off.classifier.backend], ["file", "none"]);
  process.env[jevEnv] = "k-present";
  assert.equal(loadEffective(off, () => {}), undefined, "even with a key");
  writeFileSync(path, "{ broken");
  const broken = effectiveConfig(path);
  assert.deepEqual([broken.source, broken.classifier.backend], ["invalid", "none"]);
  assert.match(broken.error!, /not valid JSON/);
  assert.equal(loadEffective(broken, () => {}), undefined, "a broken file never switches on a remote classifier");
  writeFileSync(path, JSON.stringify({ classifier: { backend: "systemone", url: "https://api.typesafe.ai", threshold: 7 } }));
  assert.equal(effectiveConfig(path).source, "invalid");
  clearJevKey();
});

test("a TYPESAFE_API_KEY in the environment alone never switches hosted Jev on, and nothing is said about it", () => {
  clearJevKey();
  const warnings: string[] = [];
  const path = join(tmpdir(), "agentsocks-no-such-config.json");
  process.env[jevEnv] = "k-from-env";
  assert.equal(loadEffective(effectiveConfig(path), (m) => warnings.push(m)), undefined);
  assert.equal(watchClassifier((m) => warnings.push(m), path)(), undefined);
  assert.deepEqual(warnings, []);
  clearJevKey();
});

test("an explicit `classifier jev` switches Jev on, with the key from the environment, the env file or a key file", () => {
  clearJevKey();
  const dir = tempDir("agentsocks-a5-");
  const path = join(dir, "config.json");
  const preset = { backend: "systemone", url: "https://api.typesafe.ai", model: "jev-latest", apiKeyEnv: jevEnv, allowRemote: true };
  writeFileSync(path, JSON.stringify({ classifier: preset }));
  assert.equal(watchClassifier(() => {}, path)(), undefined, "opted in, but there is no key yet");
  process.env[jevEnv] = "k-from-env";
  const on = must(watchClassifier(() => {}, path)());
  assert.deepEqual([on.name, on.remote, on.threshold, on.timeoutMs], ["systemone", true, 0.5, 1500]);
  clearJevKey();
  const keyFile = join(dir, "typesafe.env");
  writeFileSync(keyFile, "TYPESAFE_API_KEY=from-key-file\n");
  writeFileSync(path, JSON.stringify({ classifier: { ...preset, apiKeyFile: keyFile } }));
  assert.equal(must(watchClassifier(() => {}, path)()).name, "systemone");
  clearJevKey();
});

test("the operator's current config, which names an apiKeyFile, keeps hosted Jev on with nothing in the environment", () => {
  clearJevKey();
  const dir = tempDir("agentsocks-a5-");
  const keyFile = join(dir, "typesafe.env");
  writeFileSync(keyFile, "TYPESAFE_API_KEY=operator-key\n");
  const path = join(dir, "config.json");
  for (const classifier of [
    { backend: "systemone", url: "https://api.typesafe.ai", model: "jev-latest", apiKeyEnv: jevEnv, allowRemote: true, apiKeyFile: keyFile },
    { backend: "systemone", url: "https://api.typesafe.ai", apiKeyEnv: jevEnv, allowRemote: true, apiKeyFile: keyFile, threshold: 0.5, timeoutMs: 1500 },
  ]) {
    writeFileSync(path, JSON.stringify({ classifier }));
    const e = effectiveConfig(path);
    assert.equal(e.source, "file");
    const c = must(loadEffective(e, () => {}));
    assert.deepEqual([c.name, c.remote], ["systemone", true]);
    assert.deepEqual(findApiKey(e.classifier), { key: "operator-key", from: "apiKeyFile" });
  }
  clearJevKey();
});

test("a key stored in the agentsocks env file keeps Jev on for an install whose config names no classifier, and an ambient key beside it changes nothing", () => {
  clearJevKey();
  const path = join(tempDir("agentsocks-a5-"), "config.json");
  mkdirSync(dirname(agentsocksEnvPath()), { recursive: true });
  writeFileSync(agentsocksEnvPath(), "TYPESAFE_API_KEY=stored-on-purpose\n", { mode: 0o600 });
  const e = effectiveConfig(path);
  assert.deepEqual([e.source, e.classifier.backend], ["default", "systemone"]);
  assert.equal(must(loadEffective(e, () => {})).remote, true);
  clearJevKey();
  assert.equal(effectiveConfig(path).classifier.backend, "none", "removing the stored key turns it off again");
});

test("a broker started with a TYPESAFE_API_KEY in its environment has no classifier until `classifier jev` is run, and then has hosted Jev", () => {
  clearJevKey();
  const saved = process.env.AGENTSOCKS_CONFIG;
  const config = join(tempDir("agentsocks-a5-"), "config.json");
  process.env.AGENTSOCKS_CONFIG = config;
  try {
    process.env[jevEnv] = "k-in-the-broker-environment";
    const broker = new Broker();
    assert.deepEqual(broker.classifierState(), { active: false });
    changeClassifier(["jev"]);
    assert.deepEqual(broker.classifierState(), { active: true, backend: "systemone", remote: true });
    changeClassifier(["off"]);
    assert.deepEqual(broker.classifierState(), { active: false });
  } finally {
    if (saved === undefined) delete process.env.AGENTSOCKS_CONFIG;
    else process.env.AGENTSOCKS_CONFIG = saved;
    clearJevKey();
  }
});

test("the opted-in default posts to api.typesafe.ai with the bearer key and refuses redirects", async () => {
  process.env[jevEnv] = "k-for-wire";
  const realFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ answers: { delivery: { choice: "pause", probabilities: { now: 0.1, pause: 0.8, digest: 0.1 } } } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const optedIn = join(tempDir("agentsocks-j1-"), "config.json");
    writeFileSync(optedIn, JSON.stringify({ classifier: { backend: "systemone", url: "https://api.typesafe.ai", model: "jev-latest", apiKeyEnv: jevEnv, allowRemote: true } }));
    const c = must(loadEffective(effectiveConfig(optedIn), () => {}));
    const r = await c.classify(input, AbortSignal.timeout(2000));
    assert.deepEqual([r.route, r.confidence], ["pause", 0.8]);
    assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer k-for-wire");
    assert.equal(calls[0]!.init.redirect, "error");
    assert.equal(JSON.parse(calls[0]!.init.body as string).model, "jev-latest");
  } finally {
    globalThis.fetch = realFetch;
    clearJevKey();
  }
});

test("a user config that names another remote host still needs allowRemote and https", () => {
  const warnings: string[] = [];
  assert.equal(loadClassifier({ backend: "systemone", url: "https://classifier.example.com" }, (m) => warnings.push(m)), undefined);
  assert.match(warnings[0]!, /allowRemote/);
  assert.equal(loadClassifier({ backend: "systemone", url: "https://api.typesafe.ai" }, () => {}), undefined, "naming the default's own host in a file is not the built-in default");
});

test("the key is looked up in apiKeyFile, then the agentsocks env file, then the environment", () => {
  clearJevKey();
  const dir = tempDir("agentsocks-j1-");
  const keyFile = join(dir, "typesafe.env");
  writeFileSync(keyFile, "TYPESAFE_API_KEY=from-key-file\n");
  mkdirSync(dirname(agentsocksEnvPath()), { recursive: true });
  writeFileSync(agentsocksEnvPath(), "# written by agentsocks\nOTHER=1\nTYPESAFE_API_KEY=from-env-file\n", { mode: 0o600 });
  const config = { apiKeyEnv: jevEnv, apiKeyFile: keyFile };
  assert.equal(findApiKey(config)!.key, "from-key-file");
  assert.equal(findApiKey(config)!.from, "apiKeyFile");
  assert.equal(findApiKey({ apiKeyEnv: jevEnv })!.key, "from-env-file");
  assert.equal(findApiKey({ apiKeyEnv: jevEnv })!.from, "env file");
  process.env[jevEnv] = "from-environment";
  assert.deepEqual(findApiKey(config), { key: "from-key-file", from: "apiKeyFile" });
  assert.deepEqual(findApiKey({ apiKeyEnv: jevEnv }), { key: "from-env-file", from: "env file" });
  rmSync(agentsocksEnvPath());
  assert.deepEqual(findApiKey({ apiKeyEnv: jevEnv }), { key: "from-environment", from: "environment" });
  assert.equal(resolveApiKey({ apiKeyEnv: jevEnv }), "from-environment");
  clearJevKey();
  assert.equal(findApiKey({ apiKeyEnv: jevEnv }), undefined);
  assert.equal(findApiKey({ apiKeyEnv: "SOME_OTHER_VARIABLE" }), undefined);
});

test("the daemon notices a key arriving in the env file with the config untouched, and a config rewritten in place", () => {
  clearJevKey();
  const dir = tempDir("agentsocks-j1-");
  const path = join(dir, "config.json");
  const current = watchClassifier(() => {}, path);
  assert.equal(current(), undefined, "default without a key");
  mkdirSync(dirname(agentsocksEnvPath()), { recursive: true });
  writeFileSync(agentsocksEnvPath(), "TYPESAFE_API_KEY=late-key\n", { mode: 0o600 });
  assert.equal(current()!.name, "systemone", "a key stored on purpose in the env file switches Jev on");
  writeFileSync(path, JSON.stringify({ classifier: { backend: "none" } }));
  assert.equal(current(), undefined);
  writeFileSync(`${path}.next`, JSON.stringify({ classifier: { backend: "gliner2", url: base } }));
  renameSync(`${path}.next`, path);
  assert.equal(current()!.name, "gliner2", "an atomic replace is seen even when size and mtime could match");
  clearJevKey();
});

test("the daemon watches apiKeyFile too, and a key that disappears stops requests instead of sending them unauthenticated", async () => {
  clearJevKey();
  const dir = tempDir("agentsocks-keyfile-");
  const path = join(dir, "config.json");
  const keyFile = join(dir, "typesafe.env");
  writeFileSync(path, JSON.stringify({ classifier: { backend: "systemone", url: base, apiKeyEnv: jevEnv, apiKeyFile: keyFile } }));
  const current = watchClassifier(() => {}, path);
  assert.equal(current(), undefined, "the key file does not exist yet");
  writeFileSync(keyFile, "TYPESAFE_API_KEY=arrived-later\n");
  const c = must(current());
  assert.equal(c.name, "systemone", "writing the key file switches the classifier on");
  seen = [];
  handler = reply({ answers: { delivery: { choice: "now", probabilities: { now: 0.9, pause: 0.05, digest: 0.05 } } } });
  assert.equal((await c.classify(input, AbortSignal.timeout(2000))).route, "now");
  assert.equal(seen[0]!.authorization, "Bearer arrived-later");
  rmSync(keyFile);
  seen = [];
  await assert.rejects(c.classify(input, AbortSignal.timeout(2000)), /API key is no longer available/);
  assert.equal(seen.length, 0, "no request was sent without the key");
  assert.equal(current(), undefined, "and the watcher switches the classifier off");
});

test("a config file that is a JSON array is invalid and turns the classifier off", () => {
  const dir = tempDir("agentsocks-array-");
  const path = join(dir, "config.json");
  writeFileSync(path, "[]");
  const e = effectiveConfig(path);
  assert.deepEqual([e.source, e.classifier.backend], ["invalid", "none"]);
  assert.match(e.error!, /must contain a JSON object/);
});

test("a key stored with classifier jev --key - reaches a running daemon that started with an older key in its environment", async () => {
  clearJevKey();
  const dir = tempDir("agentsocks-k5-");
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ classifier: { backend: "systemone", url: base, apiKeyEnv: jevEnv, allowRemote: true } }));
  process.env[jevEnv] = "older-key-from-the-environment";
  const current = watchClassifier(() => {}, path);
  handler = reply({ answers: { delivery: { choice: "now", probabilities: { now: 0.9, pause: 0.05, digest: 0.05 } } } });
  seen = [];
  await must(current()).classify(input, AbortSignal.timeout(2000));
  assert.equal(seen[0]!.authorization, "Bearer older-key-from-the-environment");
  mkdirSync(dirname(agentsocksEnvPath()), { recursive: true });
  writeFileSync(agentsocksEnvPath(), "TYPESAFE_API_KEY=newer-key-stored-on-purpose\n", { mode: 0o600 });
  seen = [];
  await must(current()).classify(input, AbortSignal.timeout(2000));
  assert.equal(seen[0]!.authorization, "Bearer newer-key-stored-on-purpose", "the stored key takes effect without a restart");
  rmSync(agentsocksEnvPath());
  clearJevKey();
});

test("a config that changes while the daemon is reading it is loaded on the next call, not lost", () => {
  clearJevKey();
  const dir = tempDir("agentsocks-k12-");
  const path = join(dir, "config.json");
  writeFileSync(path, "{ broken");
  let rewritten = false;
  const current = watchClassifier(() => {
    if (rewritten) return;
    rewritten = true;
    writeFileSync(path, JSON.stringify({ classifier: { backend: "gliner2", url: base } }));
  }, path);
  assert.equal(current(), undefined, "the broken file was what this call read");
  assert.equal(current()!.name, "gliner2", "the rewrite that landed during the read is picked up");
  assert.equal(current()!.name, "gliner2");
});

test("confidence is the probability of the chosen route, the highest one only when the chosen route has none", async () => {
  const c = must(loadClassifier({ backend: "systemone", url: base }));
  const ask = async (choice: string, probabilities: Record<string, number>, extra: Record<string, unknown> = {}) => {
    handler = reply({ answers: { delivery: { choice, probabilities, ...extra } } });
    return c.classify(input, AbortSignal.timeout(2000));
  };
  const chosenNotHighest = await ask("digest", { now: 0.6, pause: 0.3, digest: 0.1 });
  assert.deepEqual([chosenNotHighest.route, chosenNotHighest.confidence], ["digest", 0.1]);
  const chosenHighest = await ask("now", { now: 0.8, pause: 0.15, digest: 0.05 });
  assert.deepEqual([chosenHighest.route, chosenHighest.confidence], ["now", 0.8]);
  const noProbabilityForIt = await ask("digest", { now: 0.7, pause: 0.2 });
  assert.deepEqual([noProbabilityForIt.route, noProbabilityForIt.confidence], ["digest", 0.7]);
  const outcome = await decide(receiver, message, budget, c);
  assert.ok(outcome);
});

test("a chosen route with a low probability is unsure, so the default applies instead of the classifier", async () => {
  const c = must(loadClassifier({ backend: "systemone", url: base, threshold: 0.5 }));
  handler = reply({ answers: { delivery: { choice: "digest", probabilities: { now: 0.6, pause: 0.3, digest: 0.1 } } } });
  const decision = await decide(receiver, message, budget, c);
  assert.equal(decision.by, "default");
  assert.equal(decision.confidence, 0.1);
  assert.match(decision.reason, /was unsure \(confidence 0\.1, below 0\.5\)/);
});
