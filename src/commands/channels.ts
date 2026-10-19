import { listChannels } from "../channelclient.ts";
import { formatChannels } from "../channels.ts";
import { detectIdentity } from "../peers.ts";
import { flag } from "./args.ts";
import { frame } from "./frame.ts";
import type { Handler } from "./types.ts";

export const channels: Handler = async (args) => {
  const json = flag(args, "--json");
  const list = await listChannels(await detectIdentity());
  console.log(json ? JSON.stringify(list, null, 2) : list.channels.length === 0 ? formatChannels(list) : await frame(formatChannels(list)));
  return 0;
};
