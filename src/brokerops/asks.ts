import { ASK_MAX_TARGETS } from "../asks.ts";
import { parseParty, parseTarget } from "../routing.ts";
import type { OpTable } from "./types.ts";

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, ASK_MAX_TARGETS * 4) : []);

export const askOps: OpTable = {
  ask_create: async (broker, req) => ({
    result: await broker.asks.create({
      from: parseParty(req.from),
      targets: list(req.targets).map(parseTarget),
      channels: list(req.channels).map(String),
      question: req.question,
      timeoutSeconds: typeof req.timeoutSeconds === "number" && Number.isFinite(req.timeoutSeconds) ? req.timeoutSeconds : 60,
      ...(req.pick === "best" && { pick: "best" as const }),
    }),
  }),
  ask_wait: async (broker, req, conn) => ({ result: await broker.asks.wait(req.askId, parseParty(req.party, "party"), conn) }),
  ask_answer: async (broker, req) => ({ result: broker.asks.answer(parseParty(req.party, "party"), req.askId, req.answer) }),
  ask_pick: async (broker, req) => ({ result: await broker.asks.pick(req.askId, parseParty(req.party, "party")) }),
};
