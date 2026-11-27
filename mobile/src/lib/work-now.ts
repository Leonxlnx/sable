import type { SessionMeta, TimelineItem, ToolItem } from '@shared/protocol';
import { runsTask } from '@shared/background';
import { hasWork } from '@shared/work-label';
import { began, commandServes, commandWorks, isAgentItem, isAgentLive, jobWorks, nowRows, type NowRow } from '@desk/features/rail/now-model';

/**
 * What works in one chat now, read from the items the phone holds by the desktop's own rules
 * (src/features/rail/now-model.ts, the pure part of the Agents tab): sub-agents and workflows that
 * work (`isAgentLive`), tracked jobs Sable still sees running, background commands and monitors that
 * work, the longest runner first (`nowRows`); servers stand apart (they are no work). The phone has
 * the conversation's newest pages: work started further back is counted by the bridge
 * (`SessionMeta`) but has no row here (`unseen`).
 */

type Items = Readonly<Record<string, TimelineItem | undefined>>;

export interface WorkNow {
  rows: NowRow[];
  /** Commands that serve a local address or watch for changes. */
  servers: string[];
  /** Work the bridge counts that the phone has no step of (it stands in an older part of the chat). */
  unseen: number;
}

const NONE: WorkNow = { rows: [], servers: [], unseen: 0 };

export function workNow(items: Items, meta?: Pick<SessionMeta, 'background' | 'commands' | 'tracked'>): WorkNow {
  const agents: string[] = [];
  const jobs: string[] = [];
  const commands: string[] = [];
  const servers: string[] = [];
  for (const id of Object.keys(items)) {
    const it = items[id];
    if (it?.type !== 'tool') continue;
    if (isAgentItem(it)) {
      if (isAgentLive(it)) agents.push(id);
    } else if (jobWorks(it)) jobs.push(id);
    else if (commandWorks(it)) commands.push(id);
    else if (commandServes(it)) servers.push(id);
  }
  if (!agents.length && !jobs.length && !commands.length && !servers.length && !meta) return NONE;
  // The bridge's counts are of background work; a sub-agent of the running turn is the turn's own.
  const bgAgents = agents.filter((id) => {
    const st = (items[id] as ToolItem).status;
    return st !== 'running' && st !== 'pending' && st !== 'awaiting';
  }).length;
  const unseen = meta ? Math.max(0, (meta.background ?? 0) - bgAgents) + Math.max(0, (meta.commands ?? 0) - commands.length) + Math.max(0, (meta.tracked ?? 0) - jobs.length) : 0;
  return { rows: nowRows(agents, jobs, commands, items), servers, unseen };
}

/** The rows as one string (kind and id): a component that lists them renders when the list changes, not on every write. */
export const workKey = (w: WorkNow) => `${w.rows.map((r) => `${r.kind}:${r.id}`).join(',')}|${w.servers.join(',')}|${w.unseen}`;

/** Monitors among the running commands (the last line says "Waiting for 1 monitor"). */
export function runningMonitors(items: Items): number {
  let n = 0;
  for (const id of Object.keys(items)) {
    const it = items[id];
    if (runsTask(it) && it.task.kind === 'monitor' && !it.task.serving) n++;
  }
  return n;
}

/**
 * Since when the oldest of a chat's background work runs, when its own turn is over: a tracked job's
 * start as the bridge keeps it (`trackedSince`), and the loaded steps of working sub-agents and
 * commands. Undefined when nothing works or nothing of it is known.
 */
export function backgroundSince(meta: SessionMeta | undefined, items: Items): number | undefined {
  if (!meta || !hasWork(meta)) return undefined;
  let at = meta.tracked && meta.trackedSince ? meta.trackedSince : Infinity;
  for (const r of workNow(items).rows) at = Math.min(at, began(items[r.id]) || Infinity);
  return Number.isFinite(at) ? at : undefined;
}
