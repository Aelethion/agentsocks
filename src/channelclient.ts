import { randomUUID } from "node:crypto";
import { brokerCall, outcomeUnknown } from "./client.ts";
import type { ChannelChange, ChannelList, PostResult } from "./channels.ts";
import type { Me } from "./peers.ts";
import type { Urgency } from "./router.ts";
import { partyOf } from "./send.ts";

export const subscribeTo = (me: Me, channel: string): Promise<ChannelChange> => brokerCall("channel_subscribe", { party: partyOf(me), channel });

export const unsubscribeFrom = (me: Me, channel: string): Promise<ChannelChange> => brokerCall("channel_unsubscribe", { party: partyOf(me), channel });

export const listChannels = (me: Me): Promise<ChannelList> => brokerCall("channel_list", { party: partyOf(me) });

export function postToChannel(me: Me, channel: string, body: string, urgency: Urgency): Promise<PostResult> {
  return brokerCall<PostResult>("channel_send", { from: partyOf(me), channel, body, urgency, requestId: randomUUID() }, { timeoutMs: 60_000 }).catch((err) => {
    if (outcomeUnknown(err)) throw new Error("The broker did not answer in time. The post may already be delivered to some subscribers; check with message_status before posting again.");
    throw err;
  });
}
