import type { Classifier } from "./classifier.ts";
import { redactSecrets } from "./redact.ts";
import { isTimeout, within } from "./router.ts";

export const MAX_PICK_QUESTION = 1000;
export const MAX_PICK_REPLY = 1500;
export const PICK_TIMEOUT_FACTOR = 3;
export const MAX_PICK_TIMEOUT_MS = 5000;

export interface PickResult {
  status: "picked" | "unsure" | "unavailable" | "failed";
  backend?: string;
  remote?: boolean;
  choice?: string;
  choiceRef?: string;
  confidence?: number;
  threshold?: number;
  probabilities?: { name: string; ref: string; p: number }[];
  note: string;
}

const none = (status: PickResult["status"], note: string, classifier?: Classifier): PickResult => ({
  status,
  note,
  ...(classifier && { backend: classifier.name, remote: classifier.remote }),
});

export async function pickBest(classifier: Classifier | undefined, question: string, replies: { name: string; ref: string; text: string }[]): Promise<PickResult> {
  if (!classifier) return none("unavailable", "smart routing is off (see `agentsocks classifier`)");
  if (replies.length < 2) return none("unavailable", replies.length === 0 ? "there are no replies" : "there is only one reply", classifier);
  const choose = classifier.choose?.bind(classifier);
  if (!choose) return none("unavailable", `the ${classifier.name} model cannot choose between replies`, classifier);
  const input = {
    question: redactSecrets(question).slice(0, MAX_PICK_QUESTION),
    options: replies.map((r, i) => ({ id: `r${i + 1}`, text: redactSecrets(r.text).slice(0, MAX_PICK_REPLY) })),
  };
  try {
    const answer = await within(Math.min(MAX_PICK_TIMEOUT_MS, classifier.timeoutMs * PICK_TIMEOUT_FACTOR), (signal) => choose(input, signal));
    const index = input.options.findIndex((o) => o.id === answer.choice);
    if (index === -1 || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return none("failed", `the ${classifier.name} model returned an answer agentsocks could not use`, classifier);
    const confidence = Number(answer.confidence.toFixed(3));
    const probabilities = answer.probabilities && input.options.map((o, i) => ({ name: replies[i]!.name, ref: replies[i]!.ref, p: Number((answer.probabilities![o.id] ?? 0).toFixed(3)) }));
    const common = { backend: classifier.name, remote: classifier.remote, confidence, threshold: classifier.threshold, ...(probabilities && { probabilities }) };
    if (confidence < classifier.threshold) return { status: "unsure", ...common, note: `the model was not sure (confidence ${confidence}, below its threshold ${classifier.threshold})` };
    return { status: "picked", ...common, choice: replies[index]!.name, choiceRef: replies[index]!.ref, note: "" };
  } catch (err) {
    const why = isTimeout(err) ? err.message : `failed (${(err as Error).message.replace(/\s+/g, " ").slice(0, 80)})`;
    return none("failed", `the ${classifier.name} model ${why}`, classifier);
  }
}
