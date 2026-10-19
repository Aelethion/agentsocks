import { exportLabels } from "../labelclient.ts";
import { callerIsAgent } from "../peers.ts";
import { flag, option } from "./args.ts";
import type { Handler } from "./types.ts";

const USAGE = "usage: agentsocks labels export [--since <days>] [--text-only]";

export const labels: Handler = async (args) => {
  const sub = args.shift();
  if (sub !== "export") throw new Error(USAGE);
  const textOnly = flag(args, "--text-only");
  const since = option(args, "--since");
  if (args.length > 0) throw new Error(USAGE);
  const sinceDays = since === undefined ? undefined : Number(since);
  if (sinceDays !== undefined && !(sinceDays > 0)) throw new Error("--since must be a number of days above 0");
  if (callerIsAgent()) throw new Error("labels export prints the text of messages that were rated, so it is for a person at a shell, not for an agent. Ask your user to run it.");
  const rows = await exportLabels({ ...(sinceDays !== undefined && { sinceDays }), textOnly });
  for (const row of rows) console.log(JSON.stringify(row));
  console.error(`agentsocks: ${rows.length} labels (${rows.filter((r) => r.message !== null).length} with text; only those are usable for fine-tuning)`);
  return 0;
};
