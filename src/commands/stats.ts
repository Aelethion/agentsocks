import { stats as fetchStats } from "../ops.ts";
import { formatStats } from "../render.ts";
import { flag } from "./args.ts";
import { frame } from "./frame.ts";
import type { Handler } from "./types.ts";

export const stats: Handler = async (args) => {
  const json = flag(args, "--json");
  const out = await fetchStats(args[0]);
  console.log(json ? JSON.stringify(out, null, 2) : out.destinations.length === 0 ? formatStats(out) : await frame(formatStats(out)));
  return 0;
};
