import type { SessionMeta } from '@shared/protocol';
import { hasWork, workLabel } from '@shared/work-label';
import type { StatusTone } from '@/art/Logo';

/**
 * A chat's state, in one rule for every place that names a chat: its sidebar row, a closed folder's
 * header, the session header beside the title, the palette and the quick switcher. Pure (no React),
 * so the sidebar's grouping and the tests read the same rule.
 *
 * Working: its turn runs (or starts), an /until loop runs its check between turns, or its own turn
 * is over but sub-agents, workflows or background commands it started still work (`hasWork`). That
 * outranks an error of its last turn: the chat is not at rest. Waiting on the person outranks
 * everything: it is the one thing to act on.
 */
export function statusTone(s: SessionMeta): StatusTone {
  if (s.status === 'awaiting') return 'awaiting';
  if (s.status === 'running' || s.status === 'starting') return 'working';
  // Its own turn ended (also with an error), but sub-agents or background commands it started still
  // work: the chat is not at rest.
  if (hasWork(s)) return 'working';
  if (s.status === 'error') return 'error';
  return s.unread ? 'unread' : 'idle';
}

/** Whether the chat is at work by the rule above (its turn, a check, sub-agents or commands). */
export const isWorking = (s: SessionMeta) => statusTone(s) === 'working';

/**
 * The state in words, for tooltips and screen readers: what it does now ("Editing app.ts"),
 * "Running the check", "Waiting for you", "2 sub-agents working", "1 command running"; null at rest.
 * Its own turn running names its activity, with the background work after it when there is some
 * ("Working · 2 sub-agents working" would say it twice: "Editing app.ts · 2 sub-agents").
 */
export function statusLabel(s: SessionMeta): string | null {
  const work = workLabel(s);
  if (s.status === 'running' || s.status === 'starting') {
    const own = s.activity || 'Working';
    return work && hasWork(s) ? `${own} · ${work.replace(/ (working|running)$/, '')}` : own;
  }
  if (s.status === 'awaiting') return 'Waiting for you';
  // "2 sub-agents working", "1 command running" (shared/work-label.ts, the phone says the same).
  if (work) return work;
  if (s.status === 'error') return s.lastError ? `Error: ${s.lastError}` : 'Error';
  return null;
}
