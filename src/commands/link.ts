import { brokerCall } from "../client.ts";
import { flag, option } from "./args.ts";
import { frame } from "./frame.ts";
import { requirePerson, type GatewayReport } from "./gateway.ts";
import type { Handler } from "./types.ts";

export const link: Handler = async (args) => {
  const remove = option(args, "--remove");
  if (remove) {
    await brokerCall("gateway_unlink", { host: remove });
    console.log(`unlinked ${remove}. Its sessions no longer appear here.`);
    return 0;
  }
  const json = flag(args, "--json");
  const target = args.shift();
  if (!target) {
    const report = await brokerCall<GatewayReport>("gateway_status");
    const linked = (report.hosts ?? []).filter((h) => h.linked);
    console.log(json ? JSON.stringify(linked, null, 2) : linked.length === 0 ? "No machines are linked." : await frame(linked.map((h) => `${h.host}  ${h.url ?? ""}  ${h.connected ? "connected" : `not connected${h.error ? `: ${h.error}` : ""}`}`).join("\n")));
    return 0;
  }
  requirePerson("agentsocks link");
  const made = await brokerCall<{ host: string; url: string; peers: number }>("gateway_link", { target }, { timeoutMs: 30_000 });
  console.log(`linked ${made.host} (${made.url}); ${made.peers} session${made.peers === 1 ? "" : "s"} there appear here as name@${made.host}.`);
  console.log(`${made.host} must have run: agentsocks gateway allow <this machine's tailnet name>. If it has not, this link says so in agentsocks gateway status.`);
  return 0;
};
