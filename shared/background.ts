import { lastDevUrl, servingCommand } from './dev-url';
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
 * state `running`; counted in `SessionMeta.commands` or `SessionMeta.serving`). The task's own state is the bridge's word
 * from the agent's task events, so it outranks the step's status: a call that was cut while its
 * command went on in the background still has a command running.
 */
export function runsTask(i: TimelineItem | undefined): i is ToolItem & { task: NonNullable<ToolItem['task']> } {
  return !!i && i.type === 'tool' && i.task?.state === 'running';
}

/**
 * A step whose tracked process Sable still sees running (`ToolItem.tracked`, the `track_work` tool:
 * work the agent started outside its own tools; counted in `SessionMeta.tracked`). The bridge owns
 * the state, from its own look at the process, so it outranks the step's status.
 */
export function tracksWork(i: TimelineItem | undefined): i is ToolItem & { tracked: NonNullable<ToolItem['tracked']> } {
  return !!i && i.type === 'tool' && i.tracked?.state === 'running';
}

/** The evidence carried by the task for its lifetime, including after its output is trimmed. */
export function taskServing(item: ToolItem, output = item.output, result = item.result): string | true | undefined {
  if (item.task?.kind !== 'command' || item.name === 'Monitor') return undefined;
  const input = item.input as { command?: unknown } | undefined;
  const command = item.detail.command ?? (typeof input?.command === 'string' ? input.command : '');
  return lastDevUrl(output, command)?.label ?? lastDevUrl(result?.text, command)?.label ?? lastDevUrl(result?.stderr, command)?.label
    ?? item.task.serving ?? (servingCommand(command) || undefined);
}
