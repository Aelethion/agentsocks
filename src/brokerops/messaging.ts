import { needThread } from "./request.ts";
import type { OpTable } from "./types.ts";

export const messagingOps: OpTable = {
  route_send: async (broker, req) => ({ result: await broker.routeSend(req) }),
  take: async (broker, req) => broker.read(needThread(req), req.via === "shell" ? "shell" : "tool"),
  wait: async (broker, req, conn) => {
    const id = needThread(req);
    await broker.register(id, {});
    broker.releaseDigests(id);
    await broker.waitForUnread(id, typeof req.timeoutMs === "number" ? req.timeoutMs : 60_000, conn);
    return broker.read(id);
  },
};
