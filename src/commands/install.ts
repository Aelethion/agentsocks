import { agentReports, install as installAgentsocks, stopRunningBroker, uninstall as uninstallAgentsocks, uninstallGatewayState } from "../install.ts";
import { AGENT_IDS, type InboxAgentId } from "../agents/types.ts";
import { flag } from "./args.ts";
import type { Handler } from "./types.ts";

const INBOX_AGENTS = AGENT_IDS.filter((id): id is InboxAgentId => id !== "codex");

export const install: Handler = async (args) => {
  const dryRun = flag(args, "--dry-run");
  const trustHooks = !flag(args, "--no-trust-hooks");
  const picks = { claude: flag(args, "--claude"), codex: flag(args, "--codex"), hooks: flag(args, "--codex-hooks") };
  const agents = INBOX_AGENTS.filter((id) => flag(args, `--${id}`));
  const claudeListAgents = flag(args, "--claude-listagents");
  if (args.length > 0) throw new Error(`install does not take ${args.join(" ")}; see agentsocks help`);
  const all = !picks.claude && !picks.codex && !picks.hooks && agents.length === 0 && !claudeListAgents;
  const lines = await installAgentsocks({
    claude: all || picks.claude,
    codexMcp: all || picks.codex,
    codexHooks: all || picks.hooks,
    trustHooks,
    dryRun,
    agents: all ? "detected" : agents,
    claudeListAgents,
    codexOptional: all,
  });
  for (const line of lines) console.log(line);
  const refused = (id: string): boolean => lines.some((l) => l.startsWith(`${id}: `) && /left untouched|not wired \(/.test(l));
  const unwired = dryRun ? [] : agentReports().filter((r) => agents.includes(r.id) && (r.status.state === "not wired" || r.status.state === "not installed" || refused(r.id)));
  for (const r of unwired) console.error(`${r.id} is not wired${r.status.detail.length ? `: ${r.status.detail.join("; ")}` : ""}`);
  return lines.failed || unwired.length > 0 ? 1 : 0;
};

export const uninstall: Handler = async (args) => {
  const dryRun = flag(args, "--dry-run");
  if (args.length > 0) throw new Error(`uninstall does not take ${args.join(" ")}; see agentsocks help`);
  const gatewayLines = await uninstallGatewayState(dryRun);
  const lines = uninstallAgentsocks(dryRun);
  await stopRunningBroker(lines, dryRun);
  for (const line of [...gatewayLines, ...lines]) console.log(line);
  return lines.failed || gatewayLines.failed ? 1 : 0;
};
