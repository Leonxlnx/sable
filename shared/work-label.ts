import type { SessionMeta } from './protocol';

/**
 * What a chat still works on once its own turn is over, in one place for the desktop and the phone
 * (the sidebar, the palette, the quick switcher, the conversation's tail, the phone's home and chat):
 * sub-agents and workflows (`SessionMeta.background`) and background commands and monitors
 * (`SessionMeta.commands`). Kept apart, so a test run never reads as a sub-agent.
 */

type Work = Pick<SessionMeta, 'background' | 'commands'>;

/** A count as the bridge sent it, read safely: anything that is not a whole positive number is none. */
const count = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** How many sub-agents (and workflows) and background commands still work. */
export function workCounts(s: Work): { agents: number; commands: number } {
  return { agents: count(s.background), commands: count(s.commands) };
}

/** Whether anything of the chat still works in the background: the chat is not at rest. */
export function hasWork(s: Work): boolean {
  return count(s.background) > 0 || count(s.commands) > 0;
}

/** "1 command running", "2 sub-agents working", "2 sub-agents, 1 command"; null when nothing works. */
export function workLabel(s: Work): string | null {
  const { agents, commands } = workCounts(s);
  const a = `${agents} ${agents === 1 ? 'sub-agent' : 'sub-agents'}`;
  const c = `${commands} ${commands === 1 ? 'command' : 'commands'}`;
  if (agents && commands) return `${a}, ${c}`;
  if (agents) return `${a} working`;
  if (commands) return `${c} running`;
  return null;
}
