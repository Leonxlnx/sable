import type { TimelineItem, ToolItem } from './protocol';

/**
 * A step whose sub-agent or workflow still works in the background (its own call returned, the work
 * goes on). One rule for the bridge's count (`SessionMeta.background`) and the Agents tab: a step in a
 * terminal state (failed, stopped, denied) never works on, and a workflow's own status outranks what
 * its launch result said (review wave 7, #6). Background commands and monitors are not counted here
 * (`runsTask`): phones already installed read `background` as "sub-agents working".
 */
export function worksInBackground(i: TimelineItem | undefined): boolean {
  if (!i || i.type !== 'tool') return false;
  if (i.status === 'error' || i.status === 'cancelled' || i.status === 'denied') return false;
  if (i.workflow) return i.workflow.status === 'running';
  return i.result?.agent?.background === 'running';
}

/**
 * A step whose background command or monitor still runs in the agent's process (`ToolItem.task`,
 * state `running`; `SessionMeta.commands` is their count). The task's own state is the bridge's word
 * from the agent's task events, so it outranks the step's status: a call that was cut while its
 * command went on in the background still has a command running.
 */
export function runsTask(i: TimelineItem | undefined): i is ToolItem & { task: NonNullable<ToolItem['task']> } {
  return !!i && i.type === 'tool' && i.task?.state === 'running';
}
