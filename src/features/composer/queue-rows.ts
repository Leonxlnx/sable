import type { QueuedMessage } from '@shared/protocol';
import { waitReason } from '../timeline/steer-wait';

export interface ExpectedRow {
  pid: string;
  text: string;
  submitId: string;
  bound?: string;
}

/** Once bound, a submission cannot claim a different row, even after its row leaves. */
export function bindRow(e: ExpectedRow, queue: QueuedMessage[]): string | undefined {
  return e.bound ?? queue.find(q => q.submitId === e.submitId)?.id;
}

export function withExpected(queue: QueuedMessage[], waiting: ExpectedRow[]): QueuedMessage[] {
  const extra = waiting.filter(e => !bindRow(e, queue)).map(e => ({
    id: e.pid, submitId: e.submitId, text: e.text, createdAt: 0,
  }));
  return extra.length ? [...queue, ...extra] : queue;
}

export function acknowledgedOrder(order: QueuedMessage[], queue: QueuedMessage[]): string[] | null {
  const ids: string[] = [];
  for (const q of order) {
    if (q.id.startsWith('expect:')) {
      const real = queue.find(row => row.submitId === q.submitId);
      if (!real) return null;
      ids.push(real.id);
    } else if (queue.some(row => row.id === q.id)) ids.push(q.id);
  }
  return ids;
}

/**
 * What a queued message's row says of its delivery (the desktop's tray and the phone's read the same):
 * - `reason`: why it is here, in the bridge's words (`QueuedMessage.steerWait.reason`, one bounded
 *   line): "Issued to Claude. Receipt unknown.", "Delivery before the update was not confirmed.".
 * - `again`: its delivery is not known. The bridge will not send it by itself (`byHand`) and says
 *   why, so the row offers "Send again" and "Discard" in place of "Send now" and "Remove".
 * - `hand`: kept from a Spare wait (`byHand` with no reason): it only goes out when sent by hand.
 */
export interface RowDelivery {
  reason: string;
  again: boolean;
  hand: boolean;
}

export function rowDelivery(q: Pick<QueuedMessage, 'byHand' | 'steerWait'>): RowDelivery {
  const reason = waitReason(q.steerWait);
  return { reason, again: !!q.byHand && !!reason, hand: !!q.byHand && !reason };
}

/** The words on a row's two acts that change with its delivery; `steer`: a turn runs and takes a message now. */
export function rowActs(d: Pick<RowDelivery, 'again'>, steer: boolean): { send: string; remove: string } {
  return d.again ? { send: 'Send again', remove: 'Discard' } : { send: steer ? 'Steer now' : 'Send now', remove: 'Remove' };
}

/** A submitted row keeps its provisional element. Older and remote rows use their bridge id. */
export const keyOf = (row: QueuedMessage) => row.submitId ? 'expect:' + row.submitId : row.id;
