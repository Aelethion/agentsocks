import { THREAD_ID } from "../limits.ts";
import type { OpRequest } from "./types.ts";

export function needThread(req: OpRequest): string {
  const threadId = typeof req.threadId === "string" ? req.threadId : undefined;
  if (!threadId || !THREAD_ID.test(threadId)) throw new Error("threadId required");
  return threadId;
}
