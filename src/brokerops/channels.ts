import { parseParty } from "../routing.ts";
import { validId } from "../limits.ts";
import type { Urgency } from "../router.ts";
import type { OpTable } from "./types.ts";

const URGENCIES = new Set(["urgent", "normal", "fyi"]);

export const channelOps: OpTable = {
  channel_subscribe: async (broker, req) => ({ result: broker.channels.subscribe(parseParty(req.party, "party"), req.channel) }),
  channel_unsubscribe: async (broker, req) => ({ result: broker.channels.unsubscribe(parseParty(req.party, "party"), req.channel) }),
  channel_list: async (broker, req) => ({ result: broker.channels.list(req.party ? parseParty(req.party, "party") : undefined) }),
  channel_send: async (broker, req) => {
    const requestId = validId(req.requestId)?.slice(0, 100);
    return {
      result: await broker.channels.post({
        from: parseParty(req.from),
        channel: req.channel,
        body: req.body,
        urgency: typeof req.urgency === "string" && URGENCIES.has(req.urgency) ? (req.urgency as Urgency) : "normal",
        ...(requestId && { requestId }),
      }),
    };
  },
};
