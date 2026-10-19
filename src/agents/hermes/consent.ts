import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../files.ts";

export const allowlistFile = (home: string): string => join(home, "shell-hooks-allowlist.json");

export interface Pending {
  event: string;
  command: string;
}

export interface Consent {
  autoAccept: boolean;
  missing: Pending[];
  problem?: string;
}

export function autoAcceptOn(configText: string): boolean {
  return /^hooks_auto_accept:[ \t]*(?:true|True|TRUE|yes|Yes|on|On)[ \t]*(?:#.*)?\r?$/m.test(configText);
}

function approvedPairs(home: string): { pairs: Set<string>; problem?: string } {
  const path = allowlistFile(home);
  if (!existsSync(path)) return { pairs: new Set() };
  try {
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    const list = isRecord(doc) && Array.isArray(doc.approvals) ? doc.approvals : [];
    const pairs = new Set<string>();
    for (const a of list) if (isRecord(a) && typeof a.event === "string" && typeof a.command === "string") pairs.add(`${a.event}\0${a.command}`);
    return { pairs };
  } catch {
    return { pairs: new Set(), problem: `${path} could not be read` };
  }
}

export function consentFor(home: string, configText: string, wanted: Pending[]): Consent {
  const accept = autoAcceptOn(configText);
  const { pairs, problem } = approvedPairs(home);
  return { autoAccept: accept, missing: accept ? [] : wanted.filter((w) => !pairs.has(`${w.event}\0${w.command}`)), ...(problem && { problem }) };
}

export function consentInstruction(missing: number): string {
  return `Hermes asks before it runs a shell hook it has not seen. Approve the ${missing} agentsocks hook${missing === 1 ? "" : "s"} once: start \`hermes\` and answer yes at each prompt, or run \`hermes --accept-hooks chat\` once, then check with \`hermes hooks list\`. For the gateway or another run without a terminal, start it with HERMES_ACCEPT_HOOKS=1. Until they are approved, agentsocks tools in Hermes refuse every call.`;
}
