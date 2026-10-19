import { ASK_MAX_SECONDS, ASK_MAX_TARGETS, ASK_MIN_SECONDS, type AskOutcome, type AskSnapshot } from "./asks.ts";
import { isChannelAddress } from "./channels.ts";
import { brokerCall, outcomeUnknown } from "./client.ts";
import { listPeers, RESOLVABLE, type Me, type Peer } from "./peers.ts";
import type { PickResult } from "./pick.ts";
import { partyOf, resolveTarget, targetOf } from "./send.ts";

export interface AskInput {
  to: string[];
  question: string;
  timeoutSeconds?: number;
  pick?: "best";
}

export interface AskScope {
  peers?: Peer[];
  adopt?: boolean;
}

export async function askSessions(me: Me, input: AskInput, scope: AskScope = {}): Promise<AskOutcome> {
  const names = input.to.map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("name at least one session or channel to ask");
  if (names.length > ASK_MAX_TARGETS) throw new Error(`an ask goes to at most ${ASK_MAX_TARGETS} sessions (this one names ${names.length})`);
  const known = scope.peers ?? (await listPeers(RESOLVABLE));
  const targets = [];
  for (const name of names.filter((n) => !isChannelAddress(n))) targets.push(targetOf(await resolveTarget(known, name, me, { adopt: scope.adopt ?? true })));
  const seconds = Math.min(ASK_MAX_SECONDS, Math.max(ASK_MIN_SECONDS, Math.round(input.timeoutSeconds ?? 60)));
  const party = partyOf(me);
  const created = await brokerCall<AskSnapshot>(
    "ask_create",
    { from: party, targets, channels: names.filter(isChannelAddress), question: input.question, timeoutSeconds: seconds, ...(input.pick && { pick: input.pick }) },
    { timeoutMs: 60_000 },
  ).catch((err) => {
    if (outcomeUnknown(err)) throw new Error("The broker did not answer in time. The question may already have gone out to some sessions; their answers would reach you as ordinary messages if they send them.");
    throw err;
  });
  const ask = await brokerCall<AskSnapshot>("ask_wait", { askId: created.id, party }, { timeoutMs: seconds * 1000 + 15_000 });
  if (input.pick !== "best") return { ask };
  const pick = await brokerCall<PickResult>("ask_pick", { askId: ask.id, party }, { timeoutMs: 30_000 }).catch(
    (err): PickResult => ({ status: "failed", note: `the pick could not be asked for (${(err as Error).message.replace(/\s+/g, " ").slice(0, 80)})` }),
  );
  return { ask, pick };
}

export const answerAsk = (me: Me, askId: string, answer: string): Promise<{ remaining: number }> => brokerCall("ask_answer", { party: partyOf(me), askId, answer });
