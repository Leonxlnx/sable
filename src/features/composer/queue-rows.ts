import type { QueuedMessage } from '@shared/protocol';

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

/** A submitted row keeps its provisional element. Older and remote rows use their bridge id. */
export const keyOf = (row: QueuedMessage) => row.submitId ? 'expect:' + row.submitId : row.id;
