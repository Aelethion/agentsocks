import { brokerCall } from "../client.ts";
import { encodeAddress } from "../envelope.ts";
import { detectIdentity } from "../peers.ts";
import { resolveTarget } from "../send.ts";
import { frame } from "./frame.ts";
import type { Handler } from "./types.ts";

export const driver: Handler = async (args) => {
  const peer = args.shift();
  if (!peer || args.length > 0) throw new Error("usage: agentsocks driver <peer|none>");
  const me = await detectIdentity();
  if (me.kind !== "codex" || !me.session) {
    if (me.kind === "claude") throw new Error("Claude Code sessions are not broker sessions, so they have no driver to set and this command changes nothing; a broker session sets its own driver with the set_driver tool");
    throw new Error("agentsocks driver sets the driver of the session it runs in, and it cannot tell which session that is here: it works in a Codex session shell, while OMP, OpenCode, Hermes, Cursor, Gemini and Copilot shells set their driver with the set_driver tool instead");
  }
  if (peer.trim().toLowerCase() === "none") {
    await brokerCall("set_driver", { threadId: me.session });
    console.log(await frame("Driver cleared. Other sessions' messages reach you as they used to."));
    return 0;
  }
  const target = await resolveTarget(undefined, peer, me);
  await brokerCall("set_driver", { threadId: me.session, addr: encodeAddress(target.socketPath), name: target.name });
  console.log(await frame(`@${target.name} is now your driver. Their messages reach you as instructions; anyone else's arrive as information only.`));
  return 0;
};
