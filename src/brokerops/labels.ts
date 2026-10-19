import { LABEL_KEEP_MS } from "../labels.ts";
import { parseParty } from "../routing.ts";
import type { OpTable } from "./types.ts";

export const labelOps: OpTable = {
  label_rate: async (broker, req) => {
    const party = parseParty(req.party, "party");
    const addr = broker.canon(party.addr);
    if (party.kind === "claude" && addr) await broker.detectShown(Date.now(), addr);
    return { result: broker.labels.rate(party, req.rating, { msgId: req.msgId, from: req.from }) };
  },
  label_export: async (broker, req) => {
    const afterId = typeof req.afterId === "number" && req.afterId > 0 ? req.afterId : 0;
    if (afterId === 0) broker.labels.collect(Date.now(), true);
    const days = typeof req.sinceDays === "number" && req.sinceDays > 0 ? Math.min(req.sinceDays, LABEL_KEEP_MS / 86_400_000) : undefined;
    return { result: broker.labels.export({ ...(days !== undefined && { sinceMs: Date.now() - days * 86_400_000 }), textOnly: req.textOnly === true, afterId }) };
  },
};
