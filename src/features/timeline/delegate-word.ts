import type { ToolItem } from '@shared/protocol';

/**
 * A task handed to the other agent whose child ran apart from its call (`ToolItem.delegateReport`):
 * where its report stands, in the row's own words. Pure and with no import of the window's own, so
 * the conversation, the Agents tab and the phone's row say the same.
 *
 * "Stopping" while the person's stop is under way. For a child that has ended and whose report the
 * chat's agent has not read yet: "With your next message" when the bridge holds it for the person's
 * next message (`delegateWait`: the allowance of automatic continuations is spent, or the person
 * pressed Stop), else "Report pending". '' for a child that still works (it reads as working), a
 * delivered or stopped report, and a row with no delivery fields (a call that stayed with its
 * caller, a fork's copy: plain history).
 *
 * Ahead of those, what is not known about a report that did go out (`delegateReceiptState`):
 * "Checking delivery" while the bridge looks up whether the agent got it, "Delivery unknown" when it
 * could not tell. The answer is saved on the step either way; for the second the person decides
 * (`delegateRetry`).
 */
export type DelegateWord = '' | 'Stopping' | 'Checking delivery' | 'Delivery unknown' | 'Report pending' | 'With your next message';

export function delegateWord(item: Pick<ToolItem, 'delegateReport' | 'delegateWait' | 'delegateReceiptState'>): DelegateWord {
  if (item.delegateReceiptState === 'checking') return 'Checking delivery';
  if (item.delegateReceiptState === 'unknown') return 'Delivery unknown';
  if (item.delegateReport === 'stopping') return 'Stopping';
  if (item.delegateReport !== 'pending') return '';
  return item.delegateWait === 'budget' || item.delegateWait === 'stop' ? 'With your next message' : 'Report pending';
}

/** What the row's one action is called where a report's delivery is unknown. */
export const DELEGATE_RETRY_LABEL = 'Send report again';

/**
 * The message that sends a report again whose delivery is unknown: the bridge's own command with the
 * token of that one decision (`/report-retry <delegateRetryId>`, what its notice names; it is used up
 * by the first send). Null where there is nothing to decide: no receipt in doubt, a lookup still
 * running, or no token.
 */
export function delegateRetry(item: Pick<ToolItem, 'delegateReceiptState' | 'delegateRetryId'>): string | null {
  return item.delegateReceiptState === 'unknown' && item.delegateRetryId ? `/report-retry ${item.delegateRetryId}` : null;
}

/** A child that has ended, whatever its launch result still says: its report is in, was delivered, or it was stopped. */
export const delegateEnded = (item: Pick<ToolItem, 'delegateReport'>): boolean => item.delegateReport === 'pending' || item.delegateReport === 'delivered' || item.delegateReport === 'stopped';
