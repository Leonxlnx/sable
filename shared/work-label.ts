import type { SessionMeta } from './protocol';

/**
 * What a chat still works on once its own turn is over, in one place for the desktop and the phone
 * (the sidebar, the palette, the quick switcher, the conversation's tail, the phone's home and chat):
 * sub-agents and workflows (`SessionMeta.background`) and background commands and monitors
 * (`SessionMeta.commands`), and a check between /until rounds.
 */

type Work = Pick<SessionMeta, 'background' | 'commands' | 'serving' | 'until'>;

/** A count as the bridge sent it, read safely: anything that is not a whole positive number is none. */
const count = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** How many sub-agents (and workflows) and background commands still work. */
export function workCounts(s: Work): { agents: number; commands: number } {
  return { agents: count(s.background), commands: count(s.commands) };
}

/** Whether anything of the chat still works in the background: the chat is not at rest. */
export function hasWork(s: Work): boolean {
  return s.until?.phase === 'checking' || count(s.background) > 0 || count(s.commands) > 0;
}

/** "1 command running", "2 sub-agents working", "2 sub-agents, 1 command"; null when nothing works. */
export function workLabel(s: Work): string | null {
  if (s.until?.phase === 'checking') return 'Running the check';
  const { agents, commands } = workCounts(s);
  const a = `${agents} ${agents === 1 ? 'sub-agent' : 'sub-agents'}`;
  const c = `${commands} ${commands === 1 ? 'command' : 'commands'}`;
  if (agents && commands) return `${a}, ${c}`;
  if (agents) return `${a} working`;
  if (commands) return `${c} running`;
  return null;
}

/** Quiet text inside a chat whose only live commands serve. */
export function servingLabel(s: Pick<SessionMeta, 'serving' | 'servingAddress'>): string | null {
  const n = count(s.serving);
  if (n === 1) return s.servingAddress ? `Serving ${s.servingAddress}` : 'Serving 1 local server';
  return n ? `Serving ${n} local servers` : null;
}

/** "45s", "4m", "1h 5m": how long a background command has run, to the minute once past one. */
export function waited(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The conversation's tail line while the chat's own turn is over and its work goes on: "2 sub-agents
 * working", "Waiting for 1 background command", "Waiting for 1 monitor", "2 sub-agents, 1 command
 * working"; null when nothing works. `monitors`: how many of `commands` are monitors.
 */
export function tailLabel(s: { agents: number; commands: number; monitors?: number }): string | null {
  const agents = count(s.agents);
  const all = count(s.commands);
  const monitors = Math.min(count(s.monitors), all);
  const commands = all - monitors;
  const parts: string[] = [];
  if (agents) parts.push(`${agents} ${agents === 1 ? 'sub-agent' : 'sub-agents'}`);
  if (commands) parts.push(`${commands} ${commands === 1 ? 'command' : 'commands'}`);
  if (monitors) parts.push(`${monitors} ${monitors === 1 ? 'monitor' : 'monitors'}`);
  if (!parts.length) return null;
  if (agents) return `${parts.join(', ')} working`;
  if (commands && !monitors) return `Waiting for ${commands} background ${commands === 1 ? 'command' : 'commands'}`;
  return `Waiting for ${parts.join(', ')}`;
}
