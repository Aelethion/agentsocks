import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import "./support.ts";
import { evaluate, formatReport, loadCases, type EvalCase } from "../src/evalrouter.ts";
import type { Classifier, ClassifierResult } from "../src/classifier.ts";
import { tempDir } from "./tmp.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../contrib/router-eval.json", import.meta.url));
const dir = tempDir("agentsocks-eval-");

async function run(args: string[], config?: unknown) {
  const configPath = join(dir, "config.json");
  if (config !== undefined) writeFileSync(configPath, JSON.stringify(config));
  const env = { ...process.env, AGENTSOCKS_CONFIG: config !== undefined ? configPath : join(dir, "absent.json") };
  try {
    const r = await exec(process.execPath, [cli, "eval-router", ...args], { env, timeout: 30_000 });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

const cases: EvalCase[] = [
  { task: "t", message: "a", decision: "now" },
  { task: "t", message: "b", decision: "now" },
  { task: "t", message: "c", decision: "pause" },
  { task: "t", message: "d", decision: "digest" },
  { task: "t", message: "e", decision: "digest" },
  { task: "t", message: "f", decision: "pause" },
];

const scripted = (answers: Record<string, () => Promise<ClassifierResult>>): Classifier => ({
  name: "scripted",
  remote: false,
  threshold: 0.6,
  timeoutMs: 200,
  classify: (input) => answers[input.message]!(),
});

test("evaluate scores accuracy, per-route precision and recall and the confusion matrix against the no-classifier baseline", async () => {
  const classifier = scripted({
    a: async () => ({ route: "now", confidence: 0.9 }),
    b: async () => ({ route: "pause", confidence: 0.9 }),
    c: async () => ({ route: "pause", confidence: 0.9 }),
    d: async () => ({ route: "digest", confidence: 0.9 }),
    e: async () => ({ route: "digest", confidence: 0.3 }),
    f: async () => {
      throw new Error("backend down");
    },
  });
  const r = await evaluate(cases, classifier);
  assert.deepEqual(r.confusion, { now: { now: 1, pause: 1, digest: 0 }, pause: { now: 1, pause: 1, digest: 0 }, digest: { now: 1, pause: 0, digest: 1 } });
  assert.equal(r.accuracy, 0.5);
  assert.equal(r.baselineAccuracy, 0.333);
  assert.deepEqual(r.perRoute.now, { precision: 0.333, recall: 0.5, cases: 2 });
  assert.deepEqual(r.perRoute.pause, { precision: 0.5, recall: 0.5, cases: 2 });
  assert.deepEqual(r.perRoute.digest, { precision: 1, recall: 0.5, cases: 2 });
  assert.deepEqual(r.fellBack, { lowConfidence: 1, failed: 1 });
  assert.equal(r.backend, "scripted");
  assert.ok(r.latencyMs.p95 >= r.latencyMs.p50 && r.latencyMs.p50 >= 0);
  const text = formatReport(r);
  assert.match(text, /accuracy 50% \(3\/6\); no-classifier baseline \(everything delivered now\) 33\.3% \(2\/6\); \+16\.7 points/);
  assert.match(text, /answers that fell back to the default \(now\): 2 \(1 low confidence, 1 timeout or failure\)/);
});

test("with no classifier every case is delivered now, which is exactly the baseline", async () => {
  const r = await evaluate(cases, undefined);
  assert.equal(r.accuracy, r.baselineAccuracy);
  assert.deepEqual(r.confusion.now, { now: 2, pause: 0, digest: 0 });
  assert.equal(r.perRoute.pause.precision, null);
});

test("a malformed evaluation set is refused with a pointer to the bad case", () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ cases: [{ task: "t", message: "m", decision: "now" }, { task: "t", message: "m", decision: "explode" }] }));
  assert.throws(() => loadCases(bad), /case 2 .* needs task, message and a decision/);
  writeFileSync(bad, JSON.stringify({ nope: [] }));
  assert.throws(() => loadCases(bad), /no "cases" array/);
  assert.throws(() => loadCases(join(dir, "missing.json")), /cannot read the evaluation set/);
  assert.equal(loadCases(fixture).length, 40);
});

test("eval-router --backend none scores the shipped evaluation set at the no-classifier baseline", async () => {
  const r = await run(["--backend", "none", "--file", fixture]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /40 cases, receiver busy, urgency normal, backend none/);
  assert.match(r.out, /accuracy 42\.5% \(17\/40\); no-classifier baseline \(everything delivered now\) 42\.5% \(17\/40\); \+0 points/);
  const json = JSON.parse((await run(["--backend", "none", "--json"])).out);
  assert.equal(json.cases, 40);
  assert.deepEqual(json.confusion.digest, { now: 14, pause: 0, digest: 0 });
});

test("eval-router rejects bad arguments, and --backend config without a classifier says it ran the baseline", async () => {
  assert.equal((await run(["--backend", "gpt"])).code, 1);
  const missing = await run(["--file", join(dir, "nope.json")]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /cannot read the evaluation set/);
  const baseline = await run(["--backend", "config"]);
  assert.equal(baseline.code, 0, baseline.err);
  assert.match(baseline.err, /no classifier is active/);
  assert.match(baseline.out, /backend none/);
});

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const { text, labels } = JSON.parse(Buffer.concat(chunks).toString()) as { text: string; labels: string[] };
    const pick = text.includes("STOP") ? 0 : text.includes("FYI") ? 2 : 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ label: labels[pick], confidence: 0.9 }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
after(() => server.close());

test("eval-router --backend config runs the configured classifier over the set and reports it as local", async () => {
  const file = join(dir, "small.json");
  writeFileSync(
    file,
    JSON.stringify({
      cases: [
        { task: "x", message: "STOP the deploy", decision: "now" },
        { task: "x", message: "review when free", decision: "pause" },
        { task: "x", message: "FYI done", decision: "digest" },
        { task: "x", message: "FYI also done, but it is urgent", decision: "now" },
      ],
    }),
  );
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const r = await run(["--backend", "config", "--file", file], { classifier: { backend: "gliner2", url } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /backend gliner2 \(local\)/);
  assert.match(r.out, /accuracy 75% \(3\/4\); no-classifier baseline \(everything delivered now\) 50% \(2\/4\); \+25 points/);
  assert.match(r.out, /answers that fell back to the default \(now\): 0/);
});
