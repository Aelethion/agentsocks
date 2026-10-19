import { brokerCall } from "../client.ts";
import { option } from "./args.ts";
import { frame } from "./frame.ts";
import { multiOption, requirePerson } from "./gateway.ts";
import type { Handler } from "./types.ts";

interface ApiPeerInfo {
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  keyFile: string | null;
  mayMessage: string[];
  maxCallsPerHour: number;
}

const USAGE = "usage: agentsocks peer add <name> --api xai|openai [--model <id>] [--key-file <file>] --may-message <peer>... [--max-calls-per-hour 30] | peer remove <name> | peer list";

export const peer: Handler = async (args) => {
  const action = args.shift() ?? "list";
  if (action === "list") {
    const { peers } = await brokerCall<{ peers: ApiPeerInfo[] }>("peer_api_list");
    const lines = peers.map((p) => `${p.name}  ${p.provider} ${p.model}, may message ${p.mayMessage.join(", ")}, at most ${p.maxCallsPerHour} calls an hour`);
    console.log(lines.length === 0 ? "No API peers." : await frame(lines.join("\n")));
    return 0;
  }
  if (action === "remove") {
    const name = args.shift();
    if (!name) throw new Error(USAGE);
    const done = await brokerCall<{ removed: string }>("peer_api_remove", { name });
    console.log(`removed ${done.removed}. It makes no more API calls.`);
    return 0;
  }
  if (action !== "add") throw new Error(USAGE);
  requirePerson("agentsocks peer add");
  const provider = option(args, "--api");
  const model = option(args, "--model");
  const keyFile = option(args, "--key-file");
  const baseUrl = option(args, "--base-url");
  const calls = option(args, "--max-calls-per-hour");
  const may = multiOption(args, "--may-message");
  const name = args.shift();
  if (!name || (provider !== "xai" && provider !== "openai")) throw new Error(USAGE);
  const made = await brokerCall<ApiPeerInfo>(
    "peer_api_add",
    { name, provider, mayMessage: may, ...(model && { model }), ...(keyFile && { keyFile }), ...(baseUrl && { baseUrl }), ...(calls !== undefined && { maxCallsPerHour: Number(calls) }) },
    { timeoutMs: 15_000 },
  );
  console.log(`added ${made.name}: ${made.provider} ${made.model} at ${made.baseUrl}.`);
  console.log(`It answers a message by calling that API with agentsocks tools (list_peers, send_message, read_inbox). Each answer takes one to six paid API calls, at most ${made.maxCallsPerHour} calls an hour.`);
  console.log(`It may message: ${made.mayMessage.join(", ")}. Its key is read from ${made.keyFile ?? "the agentsocks env file"} each time and is never printed or stored here.`);
  return 0;
};
