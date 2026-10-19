import { brokerCall } from "../client.ts";
import { option } from "./args.ts";
import { frame } from "./frame.ts";
import type { Handler } from "./types.ts";

export const inbox: Handler = async (args) => {
  const thread = option(args, "--thread") ?? process.env.CODEX_THREAD_ID;
  if (!thread) throw new Error("usage: agentsocks inbox --thread <codex thread id>");
  await brokerCall("register", { threadId: thread });
  const r = await brokerCall<{ text: string; lastNote?: string }>("take", { threadId: thread, maxChars: 64_000, via: "shell" });
  console.log(r.text || (r.lastNote ? await frame(r.lastNote) : "No new messages."));
  return 0;
};
