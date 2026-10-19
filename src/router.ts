import type { Classifier, ClassifierInput, ClassifierResult } from "./classifier.ts";
import { redactSecrets } from "./redact.ts";

export type Route = "now" | "pause" | "digest" | "merge";
export type Urgency = "urgent" | "normal" | "fyi";

export interface ReceiverView {
  kind: "claude" | "codex";
  state: "idle" | "busy" | "waiting" | "unknown";
  currentTask?: string;
  lastTool?: string;
  awaitingReplyFromSender: boolean;
  driverAddr?: string | null;
  driverName?: string | null;
  senderIsDriver?: boolean;
  senderDrivenByReceiver?: boolean;
}

export interface MessageView {
  body: string;
  urgency: Urgency;
  duplicateOfRecent: boolean;
  duplicateOfPending?: "digest" | "pause";
}

export interface BudgetView {
  receiverNowLast10m: number;
  senderToReceiverLast10m: number;
  drivenPairLastHour?: number;
  senderRatings?: { rated: number; low: number };
}

export interface Decision {
  route: Route;
  by: "rule" | "budget" | "classifier" | "default";
  rule?: string;
  confidence?: number;
  backend?: string;
  latencyMs?: number;
  escalates?: true;
  urgency?: Urgency;
  awaited?: true;
  floored?: true;
  driverName?: string | null;
  reason: string;
}

export const RECEIVER_NOW_BUDGET = 3;
export const URGENT_NOW_BUDGET = 6;
export const SENDER_BUDGET = 10;
export const SENDER_MIN_RATED = 5;
export const DRIVEN_FLOOR_PER_HOUR = 12;
export const DRIVEN_FLOOR_WINDOW_MS = 3_600_000;
export const SENDER_LOW_SHARE = 0.6;
export const SENDER_HISTORY_RULE = "sender-history";
export const RECEIVER_IDLE_RULE = "receiver-idle";
export const AWAITED_REPLY_RULE = "awaited-reply";
export const NOT_FROM_DRIVER_RULE = "not-from-driver";
export const DRIVEN_REPORT_RULE = "report-to-driver";
// rows decided by these rules never interrupted a busy receiver, so they do not use its budget
export const NON_INTERRUPT_RULES: readonly string[] = [RECEIVER_IDLE_RULE, AWAITED_REPLY_RULE];
export interface DriverId {
  threadId?: string | null;
  session?: string | null;
  addr?: string | null;
}

export const DRIVER_EVIDENCE_WINDOW_MS = 24 * 3_600_000;

export const isDriverSender = (driver: DriverId, sender: DriverId): boolean => {
  const dThread = driver.threadId || null;
  const sThread = sender.threadId || null;
  if (dThread && (dThread === sThread || dThread === (sender.session || null))) return true;
  const dSession = driver.session || null;
  if (dSession && (dSession === (sender.session || null) || dSession === sThread)) return true;
  const dAddr = driver.addr || null;
  return !!dAddr && dAddr === (sender.addr || null);
};
export interface DriverScope {
  canon(addr: string | null | undefined): string | null;
  threadIdForAddr(canonAddr: string): string | undefined;
  claudeSessionForAddr(canonAddr: string): string | undefined;
  knownSessionForAddr(canonAddr: string): string | null | undefined;
}

export const senderIdOf = (scope: DriverScope, addr: string | null | undefined, session?: string | null): DriverId => {
  const c = scope.canon(addr);
  const id: DriverId = {};
  if (c) {
    const threadId = scope.threadIdForAddr(c);
    if (threadId) id.threadId = threadId;
    id.addr = c;
  }
  const known = session || (c ? scope.knownSessionForAddr(c) : undefined);
  if (known) id.session = known;
  return id;
};

export const driverIdOf = (scope: DriverScope, driverAddr: string | null | undefined): DriverId => {
  const c = scope.canon(driverAddr);
  if (!c) return {};
  const threadId = scope.threadIdForAddr(c);
  if (threadId) return { threadId, addr: c };
  const live = scope.claudeSessionForAddr(c);
  if (live) return { session: live, addr: c };
  const known = scope.knownSessionForAddr(c);
  return known ? { session: known, addr: c } : { addr: c };
};
export interface DriverBinding {
  addr: string | null;
  sid: string | null;
}

export const threadDriverSid = (threadId: string): string => `thread:${threadId}`;
export const sessionDriverSid = (sessionId: string): string => `session:${sessionId}`;

const SESSION_SID = "session:";
const THREAD_SID = "thread:";

export const isDriver = (scope: DriverScope | undefined, driver: DriverBinding, senderAddr: string | null | undefined, senderSession?: string | null): boolean => {
  const sid = driver.sid ?? null;
  if (sid !== null) {
    if (sid.startsWith(SESSION_SID)) {
      const want = sid.slice(SESSION_SID.length);
      if ((senderSession ?? null) === want) return true;
      if (!scope || (senderSession ?? null) !== null) return false;
      const c = scope.canon(senderAddr);
      return c !== null && scope.claudeSessionForAddr(c) === want;
    }
    if (sid.startsWith(THREAD_SID)) {
      const want = sid.slice(THREAD_SID.length);
      if ((senderSession ?? null) === want) return true;
      if (!scope) return false;
      const c = scope.canon(senderAddr);
      return c !== null && scope.threadIdForAddr(c) === want;
    }
  }
  if (driver.addr === null) return false;
  if (!scope) return senderAddr === driver.addr;
  return isDriverSender(driverIdOf(scope, driver.addr), senderIdOf(scope, senderAddr, senderSession));
};

export const makeDriverScope = (deps: {
  canon: DriverScope["canon"];
  threadIdForAddr: DriverScope["threadIdForAddr"];
  claudeSessionForAddr: DriverScope["claudeSessionForAddr"];
  knownSessionForAddr: DriverScope["knownSessionForAddr"];
}): DriverScope => ({ ...deps });

const CLASSIFIER_ROUTES = new Set(["now", "pause", "digest"]);
const MAX_CLASSIFIER_MESSAGE = 2000;
const RANK: Record<Route, number> = { merge: 0, digest: 1, pause: 2, now: 3 };

function byRule(route: Route, rule: string, reason: string): Decision {
  return { route, by: "rule", rule, reason };
}

const DUPLICATE_REASON = "The same text from this sender reached this session in the last 10 minutes, so it is recorded and not delivered again.";

export function decideByRules(r: ReceiverView, m: MessageView, b: BudgetView): Decision | undefined {
  if (m.duplicateOfRecent && !m.duplicateOfPending) return byRule("merge", "duplicate", DUPLICATE_REASON);
  if (r.senderDrivenByReceiver === true && (b.drivenPairLastHour ?? 0) < DRIVEN_FLOOR_PER_HOUR) return drivenReport(r, m, b);
  if (r.driverAddr !== undefined && r.driverAddr !== null && r.senderIsDriver !== true) {
    const reason = r.awaitingReplyFromSender
      ? "This session works for a driver and this message is not from the receiver's driver, but it answers a message the session sent this sender, so it waits for the end of the turn."
      : "This session works for a driver and this message is not from the receiver's driver, so it is batched as information.";
    return { ...byRule(r.awaitingReplyFromSender ? "pause" : "digest", NOT_FROM_DRIVER_RULE, reason), ...(r.driverName !== undefined && { driverName: r.driverName }) };
  }
  const exempt = m.urgency === "urgent" || r.awaitingReplyFromSender;
  if (!exempt && b.senderToReceiverLast10m >= SENDER_BUDGET) {
    return {
      route: "digest",
      by: "budget",
      rule: "sender-budget",
      reason: `This sender already sent ${SENDER_BUDGET} messages to this session in the last 10 minutes, so further ones are batched.`,
    };
  }
  if (m.urgency === "fyi") return byRule("digest", "fyi", "The sender marked it as FYI, so it is batched for the next idle moment.");
  if (r.state === "idle") return byRule("now", RECEIVER_IDLE_RULE, "The receiver is idle, so delivering now interrupts nothing.");
  if (r.awaitingReplyFromSender) return byRule("now", AWAITED_REPLY_RULE, "The receiver messaged this sender in the last 30 minutes and has not had an answer.");
  if (m.urgency === "urgent") {
    if (b.receiverNowLast10m < URGENT_NOW_BUDGET) return byRule("now", "urgent", "The sender marked it urgent and the receiver is within its interrupt budget.");
    return overBudget(`The receiver was already interrupted ${URGENT_NOW_BUDGET} times in the last 10 minutes, so this waits for the end of its turn.`);
  }
  return undefined;
}

function drivenReport(r: ReceiverView, m: MessageView, b: BudgetView): Decision {
  if (m.duplicateOfRecent) return { ...byRule("pause", DRIVEN_REPORT_RULE, "It repeats a report from a session this receiver drives, so it waits at most for the end of the turn instead of being batched."), floored: true as const };
  if (r.state === "idle") return { ...byRule("now", RECEIVER_IDLE_RULE, "The receiver is idle, so delivering now interrupts nothing."), floored: true as const };
  if (r.awaitingReplyFromSender) return { ...byRule("now", AWAITED_REPLY_RULE, "The receiver messaged this sender in the last 30 minutes and has not had an answer."), floored: true as const };
  if (m.urgency === "urgent") {
    if (b.receiverNowLast10m < URGENT_NOW_BUDGET) return { ...byRule("now", "urgent", "The sender marked it urgent and the receiver is within its interrupt budget."), floored: true as const };
    return overBudget(`The receiver was already interrupted ${URGENT_NOW_BUDGET} times in the last 10 minutes, so this waits for the end of its turn.`);
  }
  return { ...byRule("pause", DRIVEN_REPORT_RULE, "This message is from a session this receiver drives, so it waits at most for the end of the turn instead of being batched."), floored: true as const };
}

function overBudget(reason: string, extra: Partial<Decision> = {}): Decision {
  return { route: "pause", by: "budget", rule: "receiver-budget", ...extra, reason };
}

export type ClassifierOutcome = { backend: string; threshold: number; latencyMs: number } & (
  | { result: ClassifierResult; failure?: undefined }
  | { failure: string; result?: undefined }
);

class ClassifierTimeout extends Error {}

export const isTimeout = (err: unknown): err is Error => err instanceof ClassifierTimeout;

export async function within<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ClassifierTimeout(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const classifyWithin = (classifier: Classifier, prepare: () => Promise<ClassifierInput>): Promise<ClassifierResult> =>
  within(classifier.timeoutMs, async (signal) => {
    const input = await prepare();
    signal.throwIfAborted();
    return classifier.classify(input, signal);
  });

const short = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}...` : text).replace(/\s+/g, " ");

export async function classify(
  classifier: Classifier,
  r: ReceiverView,
  m: MessageView,
  now: () => number = Date.now,
  describe: (r: ReceiverView) => Promise<ReceiverView> = (view) => Promise.resolve(view),
): Promise<ClassifierOutcome> {
  const started = now();
  const base = { backend: classifier.name, threshold: classifier.threshold };
  try {
    const result = await classifyWithin(classifier, async () => {
      const receiver = await describe(r);
      return {
        receiverKind: receiver.kind,
        ...(receiver.currentTask && { receiverTask: redactSecrets(receiver.currentTask) }),
        ...(receiver.lastTool && { receiverLastTool: receiver.lastTool }),
        message: redactSecrets(m.body).slice(0, MAX_CLASSIFIER_MESSAGE),
      };
    });
    return { ...base, latencyMs: now() - started, result };
  } catch (err) {
    const failure = err instanceof ClassifierTimeout ? err.message : `failed (${short((err as Error).message)})`;
    return { ...base, latencyMs: now() - started, failure };
  }
}

function validResult(result: ClassifierResult | undefined): result is ClassifierResult {
  return !!result && CLASSIFIER_ROUTES.has(result.route) && Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1;
}

function greyZone(b: BudgetView, outcome: ClassifierOutcome | undefined): Decision {
  const overDefault = b.receiverNowLast10m >= RECEIVER_NOW_BUDGET;
  const fallback = (lead: string, extra: Partial<Decision> = {}): Decision =>
    overDefault
      ? overBudget(`${lead}, but the receiver was already interrupted ${RECEIVER_NOW_BUDGET} times in the last 10 minutes, so it waits for the end of its turn.`, extra)
      : { route: "now", by: "default", ...extra, reason: `${lead}, so it is delivered at the receiver's next tool call.` };
  if (!outcome) return fallback("Nothing marked it urgent and no classifier decided it");
  const { backend, latencyMs } = outcome;
  const seen = { backend, latencyMs };
  if (outcome.failure !== undefined) return fallback(`The ${backend} classifier ${outcome.failure}`, seen);
  const result = outcome.result;
  if (!validResult(result)) return fallback(`The ${backend} classifier returned an answer agentsocks could not use`, seen);
  const confidence = Number(result.confidence.toFixed(3));
  if (confidence < outcome.threshold) return fallback(`The ${backend} classifier was unsure (confidence ${confidence}, below ${outcome.threshold})`, { ...seen, confidence });
  if (result.route === "now" && overDefault) {
    return overBudget(`The ${backend} classifier wanted it delivered now, but the receiver was already interrupted ${RECEIVER_NOW_BUDGET} times in the last 10 minutes.`, { ...seen, confidence });
  }
  return { route: result.route, by: "classifier", ...seen, confidence, reason: `The ${backend} classifier chose ${result.route} with confidence ${confidence}.` };
}

function demoteBySenderHistory(d: Decision, b: BudgetView): Decision {
  const h = b.senderRatings;
  if (d.route !== "now" || !h || h.rated < SENDER_MIN_RATED || h.low / h.rated < SENDER_LOW_SHARE) return d;
  const had = d.by === "classifier" ? ` The ${d.backend} classifier had chosen now (confidence ${d.confidence}).` : "";
  return {
    ...d,
    route: "pause",
    by: "rule",
    rule: SENDER_HISTORY_RULE,
    reason: `${h.low} of ${h.rated} of this sender's earlier messages delivered now were rated could-wait or noise by their receivers, so its ordinary messages wait for the end of the turn.${had}`,
  };
}

function settleDuplicate(d: Decision, m: MessageView): Decision {
  if (!m.duplicateOfPending) return d;
  if (RANK[d.route] <= RANK[m.duplicateOfPending]) return byRule("merge", "duplicate", DUPLICATE_REASON);
  return { ...d, escalates: true, reason: `${d.reason.replace(/\.$/, "")}, and it repeats the same text that was still waiting.` };
}

export function resolve(r: ReceiverView, m: MessageView, b: BudgetView, outcome?: ClassifierOutcome): Decision {
  const decision = settleDuplicate(decideByRules(r, m, b) ?? demoteBySenderHistory(greyZone(b, outcome), b), m);
  const deliveredDup = decision.route === "merge" && m.duplicateOfRecent && !m.duplicateOfPending;
  if (r.senderDrivenByReceiver === true && (b.drivenPairLastHour ?? 0) < DRIVEN_FLOOR_PER_HOUR && RANK[decision.route] < RANK.pause && !deliveredDup) {
    return { ...decision, route: "pause", by: "rule", rule: DRIVEN_REPORT_RULE, floored: true as const, urgency: m.urgency, reason: "This message is from a session this receiver drives, so it waits at most for the end of the turn instead of being batched." };
  }
  return { ...decision, urgency: m.urgency, ...(r.awaitingReplyFromSender && { awaited: true as const }) };
}

export async function decide(r: ReceiverView, m: MessageView, b: BudgetView, classifier?: Classifier, now: () => number = Date.now): Promise<Decision> {
  const ruled = decideByRules(r, m, b);
  const outcome = !ruled && classifier ? await classify(classifier, r, m, now) : undefined;
  return resolve(r, m, b, outcome);
}
