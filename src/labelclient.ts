import { brokerCall } from "./client.ts";
import type { LabelExport, Rating, RateResult } from "./labels.ts";
import type { Me } from "./peers.ts";
import { partyOf } from "./send.ts";

export const rateMessage = (me: Me, input: { rating: Rating; messageId?: string; from?: string }): Promise<RateResult> =>
  brokerCall("label_rate", { party: partyOf(me), rating: input.rating, ...(input.messageId && { msgId: input.messageId }), ...(input.from && { from: input.from }) });

export async function exportLabels(opts: { sinceDays?: number; textOnly?: boolean } = {}): Promise<LabelExport[]> {
  const rows: LabelExport[] = [];
  for (let afterId = 0; ; ) {
    const page = await brokerCall<{ rows: LabelExport[]; next: number | null }>("label_export", { ...opts, afterId });
    rows.push(...page.rows);
    if (page.next === null) return rows;
    afterId = page.next;
  }
}
