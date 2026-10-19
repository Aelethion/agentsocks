import { z } from "zod";
import { messageStatus, peerStatus } from "../ops.ts";
import { formatMessageStatus, formatPeerStatus } from "../render.ts";
import { fail, peerText } from "./result.ts";
import { defineTool } from "./types.ts";

export const statusTools = [
  defineTool({
    name: "message_status",
    title: "Check what happened to a message",
    description: "Show how a message you sent was routed (now, after the current step, batched or merged) and whether it was sent, shown to the receiver or answered.",
    inputSchema: { message_id: z.string().min(1).describe("The message id returned by send_message") },
    host: "both",
    annotations: { readOnlyHint: true },
    handler: async ({ message_id }, ctx) => {
      try {
        const me = await ctx.identify();
        return peerText(formatMessageStatus(await messageStatus(me, message_id)));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  }),
  defineTool({
    name: "peer_status",
    title: "See what a session is doing and what is asked of it",
    description: "Show what another session is working on, what is waiting for it (unread messages, held digests, open tasks), when it last showed or answered a message, and any drift between the two.",
    inputSchema: { peer: z.string().min(1).describe("Session name or ref from list_peers") },
    host: "both",
    annotations: { readOnlyHint: true },
    handler: async ({ peer }, ctx) => {
      try {
        const me = await ctx.identify();
        return peerText(formatPeerStatus(await peerStatus(me, peer)));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  }),
];
