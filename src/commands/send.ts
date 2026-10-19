import { formatPost, isChannelAddress } from "../channels.ts";
import { postToChannel } from "../channelclient.ts";
import { kindLabel } from "../agents/types.ts";
import { detectIdentity } from "../peers.ts";
import { sendMessage } from "../send.ts";
import { option, readStdin } from "./args.ts";
import { frame } from "./frame.ts";
import type { Handler } from "./types.ts";

export const send: Handler = async (args) => {
  const urgency = option(args, "--urgency") ?? "normal";
  if (urgency !== "urgent" && urgency !== "normal" && urgency !== "fyi") throw new Error("--urgency must be urgent, normal or fyi");
  const to = args.shift();
  if (!to || args.length === 0) throw new Error("usage: agentsocks send [--urgency urgent|normal|fyi] <to> <message...>");
  const body = args.length === 1 && args[0] === "-" ? await readStdin() : args.join(" ");
  const me = await detectIdentity();
  if (isChannelAddress(to)) {
    console.log(await frame(formatPost(await postToChannel(me, to, body, urgency))));
    return 0;
  }
  const r = await sendMessage(me, to, body, undefined, { urgency, refuseClaudeTargets: me.kind === "claude" });
  console.log(await frame(`${r.delivered ? "sent" : "not sent"} ${r.msgId} to @${r.to.name} [${r.to.ref}] (${kindLabel(r.to.kind, r.to.agent)}) as @${me.name}${r.route ? `, routed ${r.route}` : ""}\n${r.note}`));
  return 0;
};
