import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Classifier } from "./classifier.ts";
import { decide, type BudgetView, type MessageView, type ReceiverView } from "./router.ts";

export type EvalRoute = "now" | "pause" | "digest";
export const EVAL_ROUTES: readonly EvalRoute[] = ["now", "pause", "digest"];

export interface EvalCase {
  task: string;
  message: string;
  decision: EvalRoute;
}

export interface RouteScore {
  precision: number | null;
  recall: number | null;
  cases: number;
}

export interface EvalReport {
  cases: number;
  backend: string;
  remote: boolean | null;
  accuracy: number;
  baselineAccuracy: number;
  perRoute: Record<EvalRoute, RouteScore>;
  confusion: Record<EvalRoute, Record<EvalRoute, number>>;
  fellBack: { lowConfidence: number; failed: number };
  latencyMs: { p50: number; p95: number };
}

export const defaultEvalFile = (): string => fileURLToPath(new URL("../contrib/router-eval.json", import.meta.url));

export function loadCases(path: string): EvalCase[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read the evaluation set ${path}: ${(err as Error).message}`);
  }
  const list = (raw as { cases?: unknown }).cases;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${path} has no "cases" array`);
  return list.map((c, i) => {
    const x = c as Partial<EvalCase>;
    if (typeof x.task !== "string" || typeof x.message !== "string" || !EVAL_ROUTES.includes(x.decision as EvalRoute)) {
      throw new Error(`case ${i + 1} in ${path} needs task, message and a decision of now, pause or digest`);
    }
    return { task: x.task, message: x.message, decision: x.decision as EvalRoute };
  });
}

const percentile = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
const ratio = (num: number, den: number): number | null => (den === 0 ? null : Number((num / den).toFixed(3)));

export async function evaluate(cases: EvalCase[], classifier: Classifier | undefined, clock: () => number = Date.now): Promise<EvalReport> {
  const noBudget: BudgetView = { receiverNowLast10m: 0, senderToReceiverLast10m: 0 };
  const confusion = Object.fromEntries(EVAL_ROUTES.map((a) => [a, Object.fromEntries(EVAL_ROUTES.map((b) => [b, 0]))])) as EvalReport["confusion"];
  const latencies: number[] = [];
  const fellBack = { lowConfidence: 0, failed: 0 };
  for (const c of cases) {
    const receiver: ReceiverView = { kind: "codex", state: "busy", currentTask: c.task, awaitingReplyFromSender: false };
    const message: MessageView = { body: c.message, urgency: "normal", duplicateOfRecent: false };
    const started = clock();
    const d = await decide(receiver, message, noBudget, classifier, clock);
    latencies.push(clock() - started);
    confusion[c.decision][d.route as EvalRoute]++;
    if (classifier && d.by === "default") fellBack[d.confidence === undefined ? "failed" : "lowConfidence"]++;
  }
  const total = (route: EvalRoute) => EVAL_ROUTES.reduce((n, other) => n + confusion[route][other], 0);
  const predicted = (route: EvalRoute) => EVAL_ROUTES.reduce((n, truth) => n + confusion[truth][route], 0);
  const perRoute = Object.fromEntries(EVAL_ROUTES.map((r) => [r, { precision: ratio(confusion[r][r], predicted(r)), recall: ratio(confusion[r][r], total(r)), cases: total(r) }])) as EvalReport["perRoute"];
  const correct = EVAL_ROUTES.reduce((n, r) => n + confusion[r][r], 0);
  latencies.sort((a, b) => a - b);
  return {
    cases: cases.length,
    backend: classifier?.name ?? "none",
    remote: classifier ? classifier.remote : null,
    accuracy: Number((correct / cases.length).toFixed(3)),
    baselineAccuracy: Number((total("now") / cases.length).toFixed(3)),
    perRoute,
    confusion,
    fellBack,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  };
}

const pct = (v: number | null): string => (v === null ? "n/a" : `${Math.round(v * 1000) / 10}%`);

export function formatReport(r: EvalReport): string {
  const out: string[] = [];
  const where = r.remote === null ? "no classifier: rules, then now" : r.remote ? "REMOTE" : "local";
  out.push(`Router evaluation: ${r.cases} cases, receiver busy, urgency normal, backend ${r.backend} (${where})`);
  const correct = Math.round(r.accuracy * r.cases);
  const base = Math.round(r.baselineAccuracy * r.cases);
  const delta = Math.round(((correct - base) / r.cases) * 1000) / 10;
  out.push(`accuracy ${pct(r.accuracy)} (${correct}/${r.cases}); no-classifier baseline (everything delivered now) ${pct(r.baselineAccuracy)} (${base}/${r.cases}); ${delta >= 0 ? "+" : ""}${delta} points against the baseline`);
  if (r.remote !== null) out.push(`answers that fell back to the default (now): ${r.fellBack.lowConfidence + r.fellBack.failed} (${r.fellBack.lowConfidence} low confidence, ${r.fellBack.failed} timeout or failure)`);
  out.push("", "route    precision  recall  cases");
  for (const route of EVAL_ROUTES) {
    const s = r.perRoute[route];
    out.push(`${route.padEnd(8)} ${pct(s.precision).padStart(9)}  ${pct(s.recall).padStart(6)}  ${String(s.cases).padStart(5)}`);
  }
  out.push("", "confusion (rows: labelled, columns: routed)", `${"".padEnd(8)} ${EVAL_ROUTES.map((c) => c.padStart(6)).join(" ")}`);
  for (const row of EVAL_ROUTES) out.push(`${row.padEnd(8)} ${EVAL_ROUTES.map((c) => String(r.confusion[row][c]).padStart(6)).join(" ")}`);
  out.push("", `latency p50 ${r.latencyMs.p50} ms, p95 ${r.latencyMs.p95} ms`);
  return out.join("\n");
}
