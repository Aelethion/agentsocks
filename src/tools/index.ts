import { askTools } from "./asks.ts";
import { channelTools } from "./channels.ts";
import { inboxTools } from "./inbox.ts";
import { labelTools } from "./labels.ts";
import { messagingTools } from "./messaging.ts";
import { statusTools } from "./status.ts";
import { taskTools } from "./tasks.ts";
import type { Host, Tool } from "./types.ts";

export type { Host, Tool, ToolContext, ToolResult } from "./types.ts";

export function tools(...lists: (readonly Tool[])[]): readonly Tool[] {
  const all = lists.flat();
  const names = new Set<string>();
  for (const { name } of all) {
    if (names.has(name)) throw new Error(`MCP tool ${name} is registered twice`);
    names.add(name);
  }
  return all;
}

export const TOOLS = tools(messagingTools, taskTools, statusTools, inboxTools, channelTools, askTools, labelTools);

export const toolsFor = (host: Host, all: readonly Tool[] = TOOLS): Tool[] => all.filter((t) => t.host === "both" || t.host === host);

export const describeFor = (tool: Tool, host: Host): string => (typeof tool.description === "string" ? tool.description : tool.description[host]);
