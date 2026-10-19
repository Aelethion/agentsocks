import { effectiveConfig, loadEffective } from "../classifier.ts";
import { defaultEvalFile, evaluate, formatReport, loadCases } from "../evalrouter.ts";
import { exportLabels } from "../labelclient.ts";
import { asRouted, formatOwn, labelCases } from "../labels.ts";
import { callerIsAgent } from "../peers.ts";
import { flag, option } from "./args.ts";
import type { Handler } from "./types.ts";

export const evalRouter: Handler = async (args) => {
  const json = flag(args, "--json");
  const backend = option(args, "--backend") ?? "config";
  if (backend !== "none" && backend !== "config") throw new Error("--backend must be none or config");
  const own = flag(args, "--own");
  const allowRemote = flag(args, "--allow-remote");
  if (allowRemote && !own) throw new Error("--allow-remote only applies to --own");
  if (allowRemote && callerIsAgent()) throw new Error("--allow-remote sends the text of rated messages to another machine, so it is for a person at a shell, not for an agent. Ask your user to run it.");
  const file = option(args, "--file");
  if (own && file !== undefined) throw new Error("--own and --file are two different sets; use one");
  const labelled = own ? await exportLabels() : [];
  const cases = own ? labelCases(labelled) : loadCases(file ?? defaultEvalFile());
  if (own && cases.length === 0) throw new Error("no rated messages with text yet: receivers rate them with the rate_message tool, and only ratings made while the text is still known count");
  const notes: string[] = [];
  const active = backend === "none" ? undefined : loadEffective(effectiveConfig(), (m) => notes.push(m));
  if (backend === "config" && !active) notes.push("no classifier is active, so this is the rules-only baseline (see agentsocks classifier)");
  if (own && active?.remote && !allowRemote) {
    throw new Error("--own replays your rated messages, with their text and the receivers' tasks, through the classifier in effect, which is not on this machine. Run it again with --allow-remote if you want that text sent there, or with --backend none");
  }
  const report = await evaluate(cases, active);
  for (const n of notes) console.error(`agentsocks: ${n}`);
  const summary = own ? asRouted(labelled) : undefined;
  console.log(json ? JSON.stringify(summary ? { ...report, own: summary } : report, null, 2) : `${formatReport(report)}${summary ? `\n\n${formatOwn(summary)}` : ""}`);
  return 0;
};
