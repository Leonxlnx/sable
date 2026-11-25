import type { ProviderId, ToolItem, WorkflowRun } from '@shared/protocol';
import { worksInBackground } from '@shared/background';
import { clock } from '@/features/usage/format';
import { limitTitle } from '@/features/usage/scope';
import { formatTokens, plural } from '@/lib/format';
import { delegateEnded, delegateWord, type DelegateWord } from './delegate-word';
import { shortDuration } from './util';

/**
 * How a sub-agent reads in one line: who it is ("Explore", "Codex"), and once it has finished,
 * "Done · 14 steps · 41k tokens · 1m 12s". Pure, so the conversation and the Agents tab say the same.
 */

/** The other agent a call hands its task to (Claude to Codex, Codex to Claude): the line carries that agent's mark. */
export function agentProvider(item: ToolItem): ProviderId | null {
  if (item.name.endsWith('delegate_to_codex')) return 'codex';
  if (item.name.endsWith('delegate_to_claude')) return 'claude';
  return null;
}

/** "Explore", "General purpose", "Codex": the kind of sub-agent, or '' when the agent names none worth showing. */
export function agentType(item: ToolItem): string {
  const raw = item.detail.subagent?.trim();
  if (!raw) return '';
  if (agentProvider(item)) return raw;
  // Codex's own sub-agents carry a model id here, which is never shown raw.
  if (item.name !== 'Task' && item.name !== 'Agent') return '';
  // A plugin's agent is "plugin:name": the name is enough.
  const words = raw
    .slice(raw.lastIndexOf(':') + 1)
    .replace(/[-_]+/g, ' ')
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

export const agentTask = (item: ToolItem): string => item.detail.description || item.title;

// Where a handed-over task's report stands (delegate-word.ts, which the phone reads too).
export { delegateWord, type DelegateWord };

/** Working now: its call runs, or it works on in the background (a background agent, a workflow). */
export const isAgentLive = (item: ToolItem | undefined): boolean => {
  if (!item) return false;
  // A report that waits is no running child: it never counts where the window counts who works.
  if (delegateEnded(item)) return false;
  // The same rule as the bridge's count of background work (shared/background.ts).
  if (!item.workflow && (item.status === 'running' || item.status === 'pending' || item.status === 'awaiting')) return true;
  return worksInBackground(item);
};

/** "Fable weekly limit reached · resets Sat 00:00": a sub-agent the plan stopped. */
export function agentLimitText(item: ToolItem, now = Date.now()): string | undefined {
  const limit = item.result?.agent?.limit;
  if (!limit) return undefined;
  const reset = limit.resetsAt && limit.resetsAt > now ? ` · resets ${clock(limit.resetsAt, now)}` : '';
  return `${limitTitle(limit.window)} reached${reset}`;
}

export interface AgentLine {
  state: string;
  tone?: 'error';
  /** Why it stopped, after the state ("Fable weekly limit reached · resets Sat 00:00"). */
  why?: string;
  /** Where a handed-over task's report stands, after the state ("Report pending", "With your next message"). */
  report?: string;
  /** Steps, tokens and time, each only when known. */
  parts: string[];
}

/**
 * The line a sub-agent settles into. `childSteps`: the tool calls seen under it, used when the
 * agent gave no count of its own. Tokens only when the agent reported them.
 */
export function agentLine(item: ToolItem, childSteps: number): AgentLine {
  const line = settledLine(item, childSteps);
  const report = delegateWord(item);
  // (A row that is stopping still runs: it has no settled line; its live row says the word.)
  return report && report !== 'Stopping' ? { ...line, report } : line;
}

function settledLine(item: ToolItem, childSteps: number): AgentLine {
  const stats = item.result?.agent;
  const bg = stats?.background;
  const parts: string[] = [];
  const steps = stats?.steps ?? childSteps;
  if (steps > 0) parts.push(plural(steps, 'step'));
  if (stats?.tokens) parts.push(`${formatTokens(stats.tokens)} tokens`);
  // A background agent's call returns at once: only the agent's own figure says how long it worked.
  const launched = !!bg || !!item.detail.background;
  const ms = stats?.durationMs ?? (launched || !item.endedAt ? 0 : Math.max(0, item.endedAt - item.ts - (item.waitedMs ?? 0)));
  if (ms >= 1000) parts.push(shortDuration(ms));

  const limit = agentLimitText(item);
  if (limit) return { state: 'Stopped', why: limit, parts };
  if (item.workflow) return workflowLine(item.workflow, item.status === 'error');
  if (item.status === 'error' || bg === 'failed') return { state: 'Failed', tone: 'error', parts };
  if (item.status === 'denied') return { state: 'Denied', parts: [] };
  if (item.status === 'cancelled') return { state: 'Interrupted', parts };
  if (bg === 'running') return { state: 'Working in the background', parts };
  if (bg === 'stopped') return { state: 'Stopped', parts };
  if (launched && !bg) return { state: 'Started in the background', parts };
  return { state: 'Done', parts };
}

/**
 * What a working sub-agent shows under its line: `${steps}|${ids of its latest steps}|${now}`.
 * `now` is what it does when that is not a step (thinking, writing its report); it takes one of the
 * `tail` places, so the trail keeps its height.
 */
export function agentTrail(items: Record<string, { type: string } | undefined> | undefined, kids: readonly string[] | undefined, tail: number): string {
  if (!items || !kids?.length) return '0||Starting';
  const tools: string[] = [];
  let latest = '';
  for (const k of kids) {
    const it = items[k];
    if (!it) continue;
    if (it.type === 'tool') {
      tools.push(k);
      latest = '';
    } else if (it.type === 'thinking') latest = 'Thinking';
    else if (it.type === 'text') latest = 'Writing the report';
  }
  const room = Math.max(0, tail - (latest ? 1 : 0));
  return `${tools.length}|${room ? tools.slice(-room).join(',') : ''}|${latest}`;
}

export function readTrail(trail: string): { steps: number; ids: string[]; now: string } {
  const a = trail.indexOf('|');
  const b = trail.indexOf('|', a + 1);
  const ids = trail.slice(a + 1, b);
  return { steps: Number(trail.slice(0, a)), ids: ids ? ids.split(',') : [], now: trail.slice(b + 1) };
}

// ── workflows ──

export interface WorkflowGlance {
  /** Phases the script declares (or the run named), and how many have started. */
  phases: number;
  phase: number;
  /** Title of the phase that runs now (or ran last). */
  current?: string;
  agents: number;
  done: number;
  failed: number;
  running: number;
}

export function workflowGlance(run: WorkflowRun): WorkflowGlance {
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const a of run.agents) {
    if (a.state === 'done') done++;
    else if (a.state === 'error') failed++;
    else if (a.state === 'running') running++;
  }
  const phases = Math.max(run.phases.length, run.phase);
  return { phases, phase: run.phase, current: run.phase ? run.phases[run.phase - 1]?.title : undefined, agents: run.agents.length, done, failed, running };
}

/**
 * How far a workflow is, only from what is known: phases started of phases declared, agents
 * finished of agents started. Never a time.
 */
export function workflowProgressText(run: WorkflowRun): string[] {
  const g = workflowGlance(run);
  const out: string[] = [];
  if (g.phases > 1 && g.phase > 0) out.push(`Phase ${g.phase} of ${g.phases}`);
  else if (g.phases > 1) out.push(`${g.phases} phases`);
  if (g.agents) out.push(`${g.done + g.failed} of ${g.agents} agents done`);
  return out;
}

/** The line a finished workflow settles into: "Done · 6 agents · 1 failed · 101k tokens · 1m 30s". */
export function workflowLine(run: WorkflowRun, callFailed = false): AgentLine {
  const g = workflowGlance(run);
  const parts: string[] = [];
  // The phases show when it is opened; the line stays short enough for the side panel.
  if (g.agents) parts.push(plural(g.agents, 'agent'));
  else if (g.phases > 1) parts.push(plural(g.phases, 'phase'));
  if (g.failed) parts.push(`${g.failed} failed`);
  if (run.tokens) parts.push(`${formatTokens(run.tokens)} tokens`);
  if (run.durationMs && run.durationMs >= 1000) parts.push(shortDuration(run.durationMs));
  if (callFailed || run.status === 'failed') return { state: 'Failed', tone: 'error', parts };
  if (run.status === 'stopped') return { state: 'Stopped', parts };
  if (run.status === 'running') return { state: 'Working in the background', parts };
  return { state: 'Done', parts };
}
