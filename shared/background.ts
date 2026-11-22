import type { TimelineItem } from './protocol';

/**
 * A step whose sub-agent or workflow still works in the background (its own call returned, the work
 * goes on). One rule for the bridge's count (`SessionMeta.background`) and the Agents tab: a step in a
 * terminal state (failed, stopped, denied) never works on, and a workflow's own status outranks what
 * its launch result said (review wave 7, #6).
 */
export function worksInBackground(i: TimelineItem | undefined): boolean {
  if (!i || i.type !== 'tool') return false;
  if (i.status === 'error' || i.status === 'cancelled' || i.status === 'denied') return false;
  if (i.workflow) return i.workflow.status === 'running';
  return i.result?.agent?.background === 'running';
}
