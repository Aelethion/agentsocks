import { z } from "zod";
import { formatRate, RATINGS } from "../labels.ts";
import { rateMessage } from "../labelclient.ts";
import { fail, peerText } from "./result.ts";
import { defineTool } from "./types.ts";

export const labelTools = [
  defineTool({
    name: "rate_message",
    title: "Rate a message you received",
    annotations: { destructiveHint: false, openWorldHint: false },
    description:
      "Tell agentsocks whether a message another session sent you was worth the interruption: useful-now (right to reach you now), could-wait (fine, but it could have waited until you finished) or noise (not worth reading). Ratings stay on this machine. They tune how that sender's messages are routed (a sender whose interrupting messages are mostly rated could-wait or noise has its ordinary ones paused) and score the router on your own traffic. Without message_id or from it rates the latest message you received.",
    inputSchema: {
      rating: z.enum(RATINGS as [string, ...string[]]).describe("useful-now, could-wait or noise"),
      message_id: z.string().max(128).optional().describe("The id of the message, from the id attribute where your inbox shows one"),
      from: z.string().max(64).optional().describe("The sender's name: rates the latest message you received from it"),
    },
    host: "both",
    handler: async ({ rating, message_id, from }, ctx) => {
      try {
        return peerText(formatRate(await rateMessage(await ctx.identify(), { rating: rating as (typeof RATINGS)[number], ...(message_id && { messageId: message_id }), ...(from && { from }) })));
      } catch (err) {
        return fail(`Not rated: ${(err as Error).message}`);
      }
    },
  }),
];
