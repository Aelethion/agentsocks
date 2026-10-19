import { VERSION } from "../version.ts";
import { AGENT_LABELS } from "../agents/types.ts";
import { COMMANDS } from "./index.ts";
import type { Command, Handler, Usage } from "./types.ts";

const SUMMARY_COLUMN = 41;

function usageRows(usage: readonly Usage[]): string[] {
  const rows: string[] = [];
  for (const { synopsis, summary } of usage) {
    const [first = "", ...rest] = summary.split("\n");
    const head = `  agentsocks ${synopsis}`;
    if (head.length < SUMMARY_COLUMN) rows.push(`${head.padEnd(SUMMARY_COLUMN)}${first}`);
    else rows.push(head, `${" ".repeat(SUMMARY_COLUMN)}${first}`);
    for (const line of rest) rows.push(`${" ".repeat(SUMMARY_COLUMN)}${line}`);
  }
  return rows;
}

export function helpText(all: readonly Command[] = COMMANDS): string {
  const lines = [`agentsocks ${VERSION} — native messaging between Claude Code and Codex sessions on this machine`];
  if (all === COMMANDS) lines.push(`Supported agents: Claude Code, ${Object.values(AGENT_LABELS).join(", ")}.`);
  lines.push("", "Usage:");
  for (const command of all) lines.push(...usageRows(command.usage));
  return `${lines.join("\n")}\n`;
}

export function commandHelp(command: Command): string {
  if (command.usage.length === 0) return helpText();
  return `${[`agentsocks ${command.name} — usage:`, ...usageRows(command.usage)].join("\n")}\n`;
}

export const help: Handler = async () => {
  console.log(helpText());
  return 0;
};

export const version: Handler = async () => {
  console.log(VERSION);
  return 0;
};
