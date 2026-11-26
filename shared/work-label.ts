import type { SessionMeta } from './protocol';

/**
 * What a chat still works on once its own turn is over, in one place for the desktop and the phone
 * (the sidebar, the palette, the quick switcher, the conversation's tail, the phone's home and chat):
 * sub-agents and workflows (`SessionMeta.background`), background commands and monitors
 * (`SessionMeta.commands`), work the agent started outside its tools and asked Sable to watch
 * (`SessionMeta.tracked`, the `track_work` tool: a "job"), and a check between /until rounds.
 */

type Work = Pick<SessionMeta, 'background' | 'commands' | 'serving' | 'until' | 'tracked' | 'trackedTitle'>;

/** A count as the bridge sent it, read safely: anything that is not a whole positive number is none. */
const count = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** How many sub-agents (and workflows), background commands and tracked jobs still work. */
export function workCounts(s: Work): { agents: number; commands: number; jobs: number } {
  return { agents: count(s.background), commands: count(s.commands), jobs: count(s.tracked) };
}

/** Whether anything of the chat still works in the background: the chat is not at rest. */
export function hasWork(s: Work): boolean {
  return s.until?.phase === 'checking' || count(s.background) > 0 || count(s.commands) > 0 || count(s.tracked) > 0;
}

/** A tracked job's title as a list says it: one plain line, cut. The agent wrote it: never trusted as markup. */
export function jobTitle(title: string | undefined): string {
  const one = (title ?? '').replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 79).trimEnd()}…` : one;
}

/**
 * "1 command running", "2 sub-agents working", "2 sub-agents, 1 command"; null when nothing works.
 * A tracked job that is the chat's only work reads by its own title ("Codex builds the sign-in
 * fix"), several as "2 jobs running", beside other work as a part ("1 sub-agent, 1 job").
 */
export function workLabel(s: Work): string | null {
  if (s.until?.phase === 'checking') return 'Running the check';
  const { agents, commands, jobs } = workCounts(s);
  const parts: string[] = [];
  if (agents) parts.push(`${agents} ${agents === 1 ? 'sub-agent' : 'sub-agents'}`);
  if (commands) parts.push(`${commands} ${commands === 1 ? 'command' : 'commands'}`);
  if (jobs) parts.push(`${jobs} ${jobs === 1 ? 'job' : 'jobs'}`);
  if (!parts.length) return null;
  if (parts.length > 1) return parts.join(', ');
  if (agents) return `${parts[0]} working`;
  if (jobs === 1) return jobTitle(s.trackedTitle) || '1 job running';
  return `${parts[0]} running`;
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
 * working", a single tracked job by its title, "2 jobs running"; null when nothing works. `monitors`:
 * how many of `commands` are monitors.
 */
export function tailLabel(s: { agents: number; commands: number; monitors?: number; jobs?: number; jobTitle?: string }): string | null {
  const agents = count(s.agents);
  const all = count(s.commands);
  const monitors = Math.min(count(s.monitors), all);
  const commands = all - monitors;
  const jobs = count(s.jobs);
  const parts: string[] = [];
  if (agents) parts.push(`${agents} ${agents === 1 ? 'sub-agent' : 'sub-agents'}`);
  if (commands) parts.push(`${commands} ${commands === 1 ? 'command' : 'commands'}`);
  if (monitors) parts.push(`${monitors} ${monitors === 1 ? 'monitor' : 'monitors'}`);
  if (jobs) parts.push(`${jobs} ${jobs === 1 ? 'job' : 'jobs'}`);
  if (!parts.length) return null;
  // The one tracked job, alone: its own title ("Codex builds the sign-in fix").
  if (jobs === 1 && parts.length === 1) return jobTitle(s.jobTitle) || '1 job running';
  if (agents || jobs) return `${parts.join(', ')} ${jobs && !agents && parts.length === 1 ? 'running' : 'working'}`;
  if (commands && !monitors) return `Waiting for ${commands} background ${commands === 1 ? 'command' : 'commands'}`;
  return `Waiting for ${parts.join(', ')}`;
}
