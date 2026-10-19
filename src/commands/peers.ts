import { NOT_CONNECTED_NOTE, detectIdentity, listPeers } from "../peers.ts";
import { flag } from "./args.ts";
import { frame } from "./frame.ts";
import type { Handler } from "./types.ts";

export const list: Handler = async (args) => {
  const json = flag(args, "--json");
  const peers = await listPeers({ includeStale: flag(args, "--all"), includeUnconnected: true });
  if (json) console.log(JSON.stringify(peers, null, 2));
  else if (peers.length === 0) console.log("No agent sessions found.");
  else console.log(await frame(peers.map((p) => `${p.name} [${p.ref}]  ${p.agent ?? p.kind}  ${p.connected === false ? NOT_CONNECTED_NOTE : (p.status ?? "")}  ${p.cwd ?? ""}${p.driver ? `  driver ${p.driver}` : ""}`).join("\n")));
  return 0;
};

export const whoami: Handler = async () => {
  const me = await detectIdentity();
  console.log(JSON.stringify(me, null, 2));
  return 0;
};
