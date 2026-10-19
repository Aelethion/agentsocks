import { brokerCall } from "../client.ts";
import { runningBuildLine } from "../install.ts";
import { messageStatus, peerStatus } from "../ops.ts";
import { detectIdentity } from "../peers.ts";
import { formatMessageStatus, formatPeerStatus } from "../render.ts";
import { flag } from "./args.ts";
import { frame } from "./frame.ts";
import type { Handler } from "./types.ts";

export const status: Handler = async (args) => {
  const subject = args.find((a) => !a.startsWith("--"));
  if (!subject) {
    const pong = await brokerCall<{ pid: number; build?: string }>("ping");
    console.log(JSON.stringify(pong, null, 2));
    const buildLine = runningBuildLine(pong.pid, pong.build);
    if (buildLine !== undefined) console.error(buildLine);
    return 0;
  }
  const json = flag(args, "--json");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subject)) {
    const out = await messageStatus(await detectIdentity(), subject);
    console.log(json ? JSON.stringify(out, null, 2) : await frame(formatMessageStatus(out)));
  } else {
    const out = await peerStatus(await detectIdentity(), subject);
    console.log(json ? JSON.stringify(out, null, 2) : await frame(formatPeerStatus(out)));
  }
  return 0;
};
