import { z } from "zod";
import { formatChange, formatChannels, formatPost } from "../channels.ts";
import { listChannels, postToChannel, subscribeTo, unsubscribeFrom } from "../channelclient.ts";
import { fail, peerText } from "./result.ts";
import { defineTool } from "./types.ts";

const channel = z.string().min(1).max(49).describe('Channel name such as "#deploys": up to 48 lower-case letters, digits, dots, dashes or underscores');

export const channelTools = [
  defineTool({
    name: "subscribe",
    title: "Subscribe to a channel",
    description:
      'Join a channel such as "#deploys" so messages other sessions post to it reach you. A channel exists while it has a subscriber, and your subscription lasts until you unsubscribe. Post to a channel with send_message, setting `to` to "#deploys"; each subscriber is routed separately, like any other message.',
    inputSchema: { channel },
    host: "both",
    handler: async ({ channel }, ctx) => {
      try {
        return peerText(formatChange("subscribed", await subscribeTo(await ctx.identify(), channel)));
      } catch (err) {
        return fail(`Not subscribed: ${(err as Error).message}`);
      }
    },
  }),
  defineTool({
    name: "unsubscribe",
    title: "Leave a channel",
    description: "Stop receiving messages posted to a channel. It does nothing if you were not subscribed.",
    inputSchema: { channel },
    host: "both",
    handler: async ({ channel }, ctx) => {
      try {
        return peerText(formatChange("unsubscribed", await unsubscribeFrom(await ctx.identify(), channel)));
      } catch (err) {
        return fail(`Not unsubscribed: ${(err as Error).message}`);
      }
    },
  }),
  defineTool({
    name: "list_channels",
    title: "List channels",
    description: "List the channels that have subscribers, with who is subscribed, which of them are not running, and which one is you.",
    inputSchema: {},
    host: "both",
    annotations: { readOnlyHint: true },
    handler: async (_args, ctx) => {
      try {
        return peerText(formatChannels(await listChannels(await ctx.identify())));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  }),
  defineTool({
    name: "broadcast",
    title: "Message every live session",
    description:
      "Send one plain-text message to every live Claude Code and Codex session except yourself, each routed separately by its own state and budgets. It is for announcements, so it is never urgent: fyi (the default) is batched until each session is idle, normal reaches a session at its next tool call unless it was interrupted a lot lately. To reach one session or a group, use send_message or a channel instead.",
    inputSchema: {
      message: z.string().min(1).describe("The message text. Plain text; include file paths rather than file contents."),
      urgency: z.enum(["normal", "fyi"]).default("fyi").describe("fyi: batched until each session is idle. normal: delivered at each session's next tool call unless it was interrupted a lot lately."),
    },
    host: "both",
    handler: async ({ message, urgency }, ctx) => {
      try {
        return peerText(formatPost(await postToChannel(await ctx.identify(), "#all", message, urgency)));
      } catch (err) {
        return fail(`Not sent: ${(err as Error).message}`);
      }
    },
  }),
];
