import { getTask, listTasks } from "../ops.ts";
import { detectIdentity } from "../peers.ts";
import { formatTasks } from "../render.ts";
import { flag } from "./args.ts";
import { frame } from "./frame.ts";
import type { Handler } from "./types.ts";

export const tasks: Handler = async (args) => {
  const json = flag(args, "--json");
  const finished = flag(args, "--all");
  const scope = flag(args, "--created") ? "created_by_me" : flag(args, "--assigned") ? "assigned_to_me" : "all";
  const id = args.find((a) => /^T-[0-9a-f]{6}$/.test(a));
  const me = await detectIdentity();
  const found = id ? [await getTask(me, id)] : await listTasks(me, scope, finished);
  console.log(json ? JSON.stringify(found, null, 2) : found.length === 0 ? formatTasks(found) : await frame(formatTasks(found)));
  return 0;
};
