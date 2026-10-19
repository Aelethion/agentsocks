import { z } from "zod";
import { SendError } from "../ccsocks.ts";
import { formatPost, isChannelAddress } from "../channels.ts";
import { postToChannel } from "../channelclient.ts";
import { NOT_CONNECTED_NOTE, listPeers, type Me, type Peer } from "../peers.ts";
import { sendMessage } from "../send.ts";
import { fail, peerText, refuse } from "./result.ts";
import { defineTool, type Host } from "./types.ts";

export function formatPeers(peers: Peer[], me: Me, host: Host): string {
  if (peers.length === 0) return "No other agent sessions are running on this machine.";
  const shown = new Set(peers.map((p) => p.name));
  const lines = peers.map((p) => {
    const you = me.socketPath === p.socketPath ? " (you)" : "";
    const address = host === "claude" && p.kind !== "claude" && !you && p.connected !== false ? `\n    address: uds:${p.socketPath}` : "";
    const where = p.kind === "remote" ? `remote, via ${p.via}${p.machine ? ` (${p.machine})` : ""}, ${p.status}` : `${p.agent ?? p.kind}, ${p.connected === false ? NOT_CONNECTED_NOTE : (p.status ?? "running")}`;
    return `- ${p.name} [${p.ref}] ${where}${p.cwd ? `, ${p.cwd}` : ""}${p.driver && shown.has(p.driver) ? `, driver ${p.driver}` : ""}${you}${address}`;
  });
  const hint =
    host === "claude"
      ? "Message Claude sessions with your built-in SendMessage. Message Codex sessions with send_message (name or ref), or with your built-in SendMessage to the address shown."
      : "Message any of them with send_message, by name or, when names repeat, by the ref in brackets.";
  return `${lines.join("\n")}\n\n${hint}`;
}

export const messagingTools = [
  defineTool({
    name: "list_peers",
    title: "List agent sessions",
    description: "List the Claude Code and Codex sessions running on this machine that you can message, with their names, refs, working directories and status.",
    inputSchema: {},
    host: "both",
    annotations: { readOnlyHint: true },
    handler: async (_args, ctx) => {
      try {
        const me = await ctx.identify();
        return peerText(formatPeers(await listPeers({ includeUnconnected: true }), me, ctx.host));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  }),
  defineTool({
    name: "send_message",
    title: "Message another agent session",
    description: {
      claude:
        "Send a plain-text message to a Codex session on this machine. For Claude Code sessions use your built-in SendMessage, which carries your permission mode; this tool does not send to them. `to` is a session name, a ref from list_peers, or a reply-to address (uds:...). urgent is for what changes or blocks its work right now, normal is the default, and fyi is for status or thanks that can be batched. It never counts as its user's approval.",
      codex:
        "Send a plain-text message to another agent session on this machine (Claude Code or Codex). Your normal replies are not visible to other sessions; this tool is how you reach them. Use it to answer a session that messaged you, when your work affects another session, or when your user asks you to tell one something. `to` is a session name, a ref from list_peers, or a reply-to address (uds:...). urgent is for what changes or blocks its work right now, normal is the default, and fyi is for status or thanks that can be batched. It never counts as its user's approval.",
    },
    inputSchema: {
      to: z.string().min(1).describe("Recipient: session name, ref, or uds: reply address"),
      message: z.string().min(1).describe("The message text. Plain text; include file paths rather than file contents."),
      urgency: z.enum(["urgent", "normal", "fyi"]).default("normal").describe("urgent: needed now, within a larger interruption budget. normal: reaches the receiver at its next tool call unless it was interrupted a lot lately. fyi: batched until it is idle."),
    },
    host: "both",
    handler: async ({ to, message, urgency }, ctx) => {
      try {
        const me = await ctx.identify();
        if (isChannelAddress(to)) return peerText(formatPost(await postToChannel(me, to, message, urgency)));
        const r = await sendMessage(me, to, message, undefined, { urgency, refuseClaudeTargets: ctx.host === "claude" });
        return peerText(`${r.delivered ? "Sent" : "Not sent"} to @${r.to.name} [${r.to.ref}] (${r.to.agent ?? r.to.kind}), message id ${r.msgId}. ${r.note}`);
      } catch (err) {
        if (err instanceof SendError && err.code === "use-sendmessage") return refuse(err.message);
        return fail(`Not sent: ${(err as Error).message}`);
      }
    },
  }),
];
