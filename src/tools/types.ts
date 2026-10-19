import type { ZodRawShape, z } from "zod";
import type { Me } from "../peers.ts";

export type Host = "claude" | "codex";

export interface ToolContext {
  host: Host;
  identify: () => Promise<Me>;
}

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export interface Tool {
  name: string;
  title: string;
  description: string | Readonly<Record<Host, string>>;
  inputSchema: ZodRawShape;
  host: Host | "both";
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolDefinition<S extends ZodRawShape> extends Omit<Tool, "inputSchema" | "handler"> {
  inputSchema: S;
  handler(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends ZodRawShape>(definition: ToolDefinition<S>): Tool {
  return definition as unknown as Tool;
}
