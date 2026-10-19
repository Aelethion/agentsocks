import { frameUntrusted } from "../codexframe.ts";

export async function frame(text: string): Promise<string> {
  const { framesPeerText } = await import("../peers.ts");
  return framesPeerText(!!process.stdout.isTTY) ? frameUntrusted(text) : text;
}
