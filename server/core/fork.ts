import type { TimelineItem, UserItem } from '../../shared/protocol';

/** Freeze process-owned rows before the independent fork base is written. */
export function forkHistory(items: TimelineItem[], whole: (row: TimelineItem) => TimelineItem): TimelineItem[] {
  return items.map(row => {
    if (row.type === 'user' && row.delegateContinuations !== undefined) {
      const { delegateContinuations, ...historical } = whole(row) as UserItem;
      return historical;
    }
    if ((row.type === 'text' || row.type === 'thinking') && row.streaming) return { ...whole(row) as typeof row, streaming: false };
    if (row.type !== 'tool') return row;
    const active = ['running', 'pending', 'awaiting'].includes(row.status);
    if (!active && !row.delegateReport && !row.delegateDeliveryId && row.result?.agent?.background !== 'running'
      && row.workflow?.status !== 'running' && row.task?.state !== 'running' && row.task?.state !== 'lost' && row.tracked?.state !== 'running') return row;
    const { delegateRetryId, delegateReceiptState, delegateRedelivered, delegateReceiversPending, delegateCaller, delegateReport, delegateAttempt, delegateDeliveryId, delegateContinuations, delegateWait, ...copy } = whole(row) as typeof row;
    if (active) copy.status = 'cancelled';
    if (copy.result?.agent?.background === 'running') copy.result = { ...copy.result, agent: { ...copy.result.agent, background: 'stopped' } };
    if (copy.workflow?.status === 'running') copy.workflow = { ...copy.workflow, status: 'stopped' };
    if (copy.task?.state === 'running') copy.task = { ...copy.task, state: 'stopped', lossTold: true };
    else if (copy.task?.state === 'lost') copy.task = { ...copy.task, lossTold: true };
    // A tracked process is watched by the chat that tracked it: the fork's copy is history.
    if (copy.tracked?.state === 'running') copy.tracked = { ...copy.tracked, state: 'left' };
    return copy;
  });
}

/**
 * Forking a conversation at an answer: everything up to the end of the turn that holds the
 * answer stays, the next message the person sent (and all after it) does not.
 */
export function cutAt(items: TimelineItem[], itemId: string): { kept: TimelineItem[]; next?: UserItem } | null {
  const at = items.findIndex((i) => i.id === itemId);
  if (at < 0) return null;
  const history = (row: TimelineItem) => row.type !== 'user' || row.state !== 'queued' && !row.issuedUuid;
  for (let i = at + 1; i < items.length; i++) {
    const it = items[i];
    if (it.type === 'user' && !it.parentId && history(it)) return { kept: items.slice(0, i).filter(history), next: it };
  }
  return { kept: items.filter(history) };
}

/**
 * Claude Code: the message to fork up to (inclusive), from the session's main chain of message
 * uuids. The entry right before the next sent message ends the turn; with no next message the
 * whole conversation is copied (`undefined`). `null` when the point cannot be found in the chain.
 */
export function claudeForkPoint(chain: string[], next: UserItem | undefined): string | undefined | null {
  if (!next) return undefined;
  const k = next.providerId ? chain.indexOf(next.providerId) : -1;
  return k > 0 ? chain[k - 1] : null;
}

/** Codex: the last turn to keep (item ids are `turnId:itemId`), or null when none carries one. */
export function codexForkTurn(kept: TimelineItem[]): string | null {
  for (let i = kept.length - 1; i >= 0; i--) {
    const id = kept[i].id;
    const cut = id.indexOf(':');
    if (cut > 0) return id.slice(0, cut);
  }
  return null;
}
