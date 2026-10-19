import { frameUntrusted } from "../codexframe.ts";
import type { ToolResult } from "./types.ts";

export const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
export const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: frameUntrusted(t) }], isError: true });
export const peerText = (t: string): ToolResult => text(frameUntrusted(t));
export const refuse = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });
