import { z } from "zod";
import { formatAsk } from "../asks.ts";
import { answerAsk, askSessions } from "../askclient.ts";
import { fail, peerText, text } from "./result.ts";
import { defineTool } from "./types.ts";

export const askTools = [
  defineTool({
    name: "ask",
    title: "Ask several sessions one question",
    annotations: { destructiveHint: false, openWorldHint: false },
    description:
      'Send one question to several sessions at once, wait for their answers, and get them back together. `to` lists session names or refs, and "#channel" names to ask a channel\'s subscribers; at most 16 sessions. Each message names the answer tool and the ask id. The call returns when all have answered or after timeout_seconds, and says who did not answer. With pick "best" the smart-routing model, if your user turned it on, also says which reply answers best and how likely each is; that is its opinion, every reply is still shown, and the question and replies are sent to that model. A Claude session cannot ask Claude sessions this way: they are listed so you can use SendMessage.',
    inputSchema: {
      to: z.array(z.string().min(1)).min(1).max(16).describe('Session names or refs from list_peers, and "#channel" names; at most 16 sessions in all'),
      question: z.string().min(1).describe("The question, in plain text. Include everything the others need; they cannot see this conversation."),
      timeout_seconds: z.number().int().min(1).max(280).default(60).describe("How long to wait for the answers, at most 280 seconds"),
      pick: z.enum(["best"]).optional().describe('Set "best" to also get the smart-routing model\'s opinion on which reply answers best, with probabilities. It sends the question and the replies to that model.'),
    },
    host: "both",
    handler: async ({ to, question, timeout_seconds, pick }, ctx) => {
      try {
        return peerText(formatAsk(await askSessions(await ctx.identify(), { to, question, timeoutSeconds: timeout_seconds, ...(pick && { pick }) })));
      } catch (err) {
        return fail(`Not asked: ${(err as Error).message}`);
      }
    },
  }),
  defineTool({
    name: "answer",
    title: "Answer an ask",
    annotations: { destructiveHint: false, openWorldHint: false },
    description: "Answer a question another session sent you with ask (its message names an ask id). The asker receives your answer together with the others. Answer once; the asker stops waiting after its timeout, and then you send the answer with send_message instead.",
    inputSchema: {
      ask_id: z.string().regex(/^A-[0-9a-f]{6}$/).describe("The ask id from the question, such as A-1a2b3c"),
      answer: z.string().min(1).max(4000).describe("Your answer, in plain text, at most 4000 characters; for more, answer with a file path"),
    },
    host: "both",
    handler: async ({ ask_id, answer }, ctx) => {
      try {
        const { remaining } = await answerAsk(await ctx.identify(), ask_id, answer);
        return text(`Answer sent for ${ask_id}. ${remaining === 0 ? "You were the last one the asker was waiting for." : `${remaining} other ${remaining === 1 ? "session has" : "sessions have"} not answered yet.`}`);
      } catch (err) {
        return fail(`Not answered: ${(err as Error).message}`);
      }
    },
  }),
];
