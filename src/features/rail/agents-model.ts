import { emptyIndex } from '@/state/revision';
import type { TaskMark, TimelineItem, ToolItem, WorkflowRun } from '@shared/protocol';
import { syntheticOf, type TaskOutcome } from '@shared/synthetic';
import { workflowGlance } from '@/features/timeline/agent-line';
import { changedSince } from '@/state/revision';
import { isAgentItem, isAgentLive, isBackgroundCommand, isJob, type RowState } from './now-model';

// The pure part (what works now, a row's state, jobs), which the phone reads too: now-model.ts.
export { STATE_MARK, isBackgroundCommand, isJob, jobRan, jobRowState, lastLine, nowRows, progressIndex, readProgress, type NowRow, type Progress, type RowState } from './now-model';

/**
 * What the Agents tab reads from a session, worked out so that a streamed step costs next to
 * nothing: every index below remembers the arrays it last saw (the store replaces an array only
 * when an item joins it) and scans only what joined since. Pure, so it is tested without a page.
 */

type Items = Record<string, TimelineItem | undefined>;

export interface Timeline {
  items: Items;
  roots: readonly string[];
  children: Record<string, readonly string[] | undefined>;
  /** The items' revision, as the store keeps it (`SessionData.rev`, `changed`): what changed since a reader last looked. */
  rev?: number;
  changed?: { since: number; ids: readonly string[] };
}

const NONE: readonly string[] = [];

/** Matches found in one list (the roots, or one item's children). */
interface Scan<T> {
  arr: readonly string[];
  found: readonly T[];
}

/**
 * The matches in `arr`, reusing `prev` when the list only grew at its end (the usual case: an item
 * joined). The found array keeps its identity while nothing new matched.
 */
export function grow<T>(prev: Scan<T> | undefined, arr: readonly string[], pick: (id: string) => T | undefined): Scan<T> {
  if (prev?.arr === arr) return prev;
  const n = prev?.arr.length ?? 0;
  const appended = !!prev && n > 0 && arr.length >= n && arr[0] === prev.arr[0] && arr[n - 1] === prev.arr[n - 1];
  let found: T[] | readonly T[] = appended ? prev.found : [];
  let copied = !appended;
  for (let i = appended ? n : 0; i < arr.length; i++) {
    const v = pick(arr[i]);
    if (v === undefined) continue;
    if (!copied) {
      found = found.slice();
      copied = true;
    }
    (found as T[]).push(v);
  }
  return { arr, found };
}

/**
 * Every sub-agent and workflow of a session (top level and nested under another agent), oldest
 * first. Returns the same array until one joins or leaves; a streamed word or a new step of an
 * agent costs one identity check, a new step one more look at that step.
 */
export function agentIndex(): (t: Timeline | undefined) => readonly string[] {
  const scans = new Map<string, Scan<string>>();
  let roots: unknown = null;
  let children: unknown = null;
  let out: readonly string[] = NONE;
  return (t) => {
    if (!t) return NONE;
    if (t.roots === roots && t.children === children) return out;
    roots = t.roots;
    children = t.children;
    const ids: string[] = [];
    const pick = (id: string) => (isAgentItem(t.items[id]) ? id : undefined);
    const visit = (key: string, arr: readonly string[] | undefined, depth: number) => {
      if (!arr?.length || depth > 8) return;
      const scan = grow(scans.get(key), arr, pick);
      scans.set(key, scan);
      for (const id of scan.found) {
        ids.push(id);
        visit(id, t.children[id], depth + 1);
      }
    };
    visit('', t.roots, 0);
    if (ids.length > 1) ids.sort((a, b) => (t.items[a]?.ts ?? 0) - (t.items[b]?.ts ?? 0));
    if (ids.length === out.length && ids.every((id, i) => id === out[i])) return out;
    out = ids.length ? ids : NONE;
    return out;
  };
}

/**
 * Whether a message is one the person sent (their words, or a command they ran): the only kind a
 * wave of agents is named after. What the agent's harness wrote in their place (a notification that
 * a background task finished, a command's output, a reminder) and Sable's own /until message never
 * are: agents started in the turn such a message opened belong to the person's message before it.
 */
export function startsWave(it: TimelineItem | undefined): boolean {
  if (it?.type !== 'user' || it.until) return false;
  const s = syntheticOf(it);
  return !s || s.role === 'command';
}

/** The ids of the person's own messages (`startsWave`), in order: the same array until one is added. */
export function userIndex(): (t: Timeline | undefined) => readonly string[] {
  let scan: Scan<string> | undefined;
  return (t) => {
    if (!t) return NONE;
    scan = grow(scan, t.roots, (id) => (startsWave(t.items[id]) ? id : undefined));
    return scan.found;
  };
}

// ── what the harness said of background work ──

/** The end of a background task as its notification told it. */
export interface EndNote {
  /** When the notification arrived: when the task ended, as near as is known. */
  ts: number;
  outcome: TaskOutcome;
  exitCode?: number;
}

const NO_NOTES: ReadonlyMap<string, EndNote> = new Map();

/**
 * Every task notification of a session by the step it names (`tool-use-id`): how a background
 * command ended (the bridge keeps that on no step) and when a background agent did. The same map
 * until another notification arrives; a later word of the same step replaces the earlier one.
 */
export function noteIndex(): (t: Timeline | undefined) => ReadonlyMap<string, EndNote> {
  let scan: Scan<[string, EndNote][]> | undefined;
  let from: unknown = null;
  let map = NO_NOTES;
  return (t) => {
    if (!t) return NO_NOTES;
    scan = grow(scan, t.roots, (id) => {
      const it = t.items[id];
      const s = it?.type === 'user' ? syntheticOf(it) : null;
      if (!it || !s || s.role !== 'notification') return undefined;
      const out: [string, EndNote][] = [];
      for (const p of s.parts) {
        if (p.kind !== 'task' || !p.task.toolUseId || p.task.outcome === 'running') continue;
        out.push([p.task.toolUseId, { ts: it.ts, outcome: p.task.outcome, ...(p.task.exitCode != null ? { exitCode: p.task.exitCode } : {}) }]);
      }
      return out.length ? out : undefined;
    });
    if (scan.found !== from) {
      from = scan.found;
      map = scan.found.length ? new Map(scan.found.flat()) : NO_NOTES;
    }
    return map;
  };
}

// ── background commands ──

/** A shell step still being written or running: it may yet turn out to be sent to the background. */
const isOpenCommand = (it: TimelineItem | undefined) => it?.type === 'tool' && it.kind === 'bash' && (it.status === 'pending' || it.status === 'running' || it.status === 'awaiting');

/**
 * The chat's background commands, its own and those its sub-agents started (nested under their
 * agent's step), oldest first: the same array until one is started.
 */
export function commandIndex(): (t: Timeline | undefined) => readonly string[] {
  const scans = new Map<string, Scan<string>>();
  // Shell steps seen while still open and not (yet) in the background. A streamed call arrives with
  // empty input and gets its `run_in_background` in a later patch, which changes no list: these few
  // are looked at again each time, and one that turned reads the lists afresh (to keep their order).
  let open = new Set<string>();
  let roots: unknown = null;
  let children: unknown = null;
  let rev = -1;
  let known = new Set<string>();
  let out: readonly string[] = NONE;
  return (t) => {
    if (!t) return NONE;
    let turned = false;
    for (const id of open) {
      const it = t.items[id];
      if (isBackgroundCommand(it)) turned = true;
      else if (!isOpenCommand(it)) open.delete(id);
    }
    // A step the bridge marks afterwards (`task`: a command sent to the background by its timeout,
    // or by the person in the agent's own terminal) changes no list either: the write that marked it says.
    if (t.rev !== undefined && t.rev !== rev) {
      const changed = changedSince({ items: t.items, rev: t.rev, changed: t.changed }, rev);
      // Not known which (writes it did not see while the pane was hidden, a new timeline): all again.
      if (!changed) turned = rev >= 0;
      else for (const id of changed) if (!known.has(id) && isBackgroundCommand(t.items[id])) turned = true;
      rev = t.rev;
    }
    if (!turned && t.roots === roots && t.children === children) return out;
    roots = t.roots;
    children = t.children;
    if (turned) {
      scans.clear();
      open = new Set();
    }
    const ids: string[] = [];
    let nested = false;
    const pick = (id: string) => {
      const it = t.items[id];
      if (isBackgroundCommand(it) || isAgentItem(it)) return id;
      if (isOpenCommand(it)) open.add(id);
      return undefined;
    };
    const visit = (key: string, arr: readonly string[] | undefined, depth: number) => {
      if (!arr?.length || depth > 8) return;
      const scan = grow(scans.get(key), arr, pick);
      scans.set(key, scan);
      for (const id of scan.found) {
        const it = t.items[id];
        if (isBackgroundCommand(it)) {
          ids.push(id);
          if (depth) nested = true;
        }
        if (isAgentItem(it)) visit(id, t.children[id], depth + 1);
      }
    };
    visit('', t.roots, 0);
    // Commands of sub-agents stand where they were started among the chat's own.
    if (nested) ids.sort((a, b) => (t.items[a]?.ts ?? 0) - (t.items[b]?.ts ?? 0));
    known = new Set(ids);
    if (ids.length === out.length && ids.every((id, i) => id === out[i])) return out;
    out = ids.length ? ids : NONE;
    return out;
  };
}

/**
 * Where a background command stands. The bridge's own word comes first (`ToolItem.task`): running,
 * how it ended, or `lost` with the process that held it. Without it (a chat saved before the bridge
 * kept it, a provider that does not say) only a notification tells its end, and `unknown` is a
 * command that gave no word of its end since it was started: it may have gone with its process long
 * ago, so it is never called running.
 */
export type CommandState = 'starting' | 'running' | 'serving' | 'done' | 'failed' | 'stopped' | 'lost' | 'unknown';

const TASK_STATE: Record<TaskMark['state'], CommandState> = { running: 'running', done: 'done', failed: 'failed', stopped: 'stopped', lost: 'lost' };

export function commandState(item: ToolItem, note: EndNote | undefined): CommandState {
  if (item.task?.state === 'running' && item.task.serving) return 'serving';
  if (item.task) return TASK_STATE[item.task.state] ?? 'unknown';
  if (item.status === 'error' || item.status === 'denied') return 'failed';
  if (item.status === 'cancelled') return 'stopped';
  if (note) return note.outcome === 'failed' ? 'failed' : note.outcome === 'stopped' ? 'stopped' : 'done';
  if (item.status === 'running' || item.status === 'pending' || item.status === 'awaiting') return 'starting';
  return 'unknown';
}

export interface Commands {
  /** Running first (the longest runner on top), then what failed, then the rest, newest first. */
  ids: string[];
  serving: number;
  running: number;
  failed: number;
  /** The same, apart: what works now, what serves, and what is over (failed first, then newest first). */
  live: string[];
  servers: string[];
  past: string[];
}

export function commandRows(ids: readonly string[], items: Items, notes: ReadonlyMap<string, EndNote>): Commands {
  const live: string[] = [];
  // A command whose step still runs (it may yet go to the background): it works, and stands with what
  // works now, but the bridge counts it with the turn, not among the commands.
  const starting: string[] = [];
  const serving: string[] = [];
  const bad: string[] = [];
  const rest: string[] = [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const it = items[ids[i]];
    if (!isBackgroundCommand(it)) continue;
    const state = commandState(it, notes.get(it.id));
    (state === 'running' ? live : state === 'starting' ? starting : state === 'serving' ? serving : state === 'failed' ? bad : rest).push(it.id);
  }
  // The oldest running first, as the working agents stand.
  if (live.length > 1) live.sort((a, b) => ((items[a] as ToolItem).task?.since ?? 0) - ((items[b] as ToolItem).task?.since ?? 0));
  return { ids: [...live, ...starting, ...serving, ...bad, ...rest], serving: serving.length, running: live.length, failed: bad.length, live: [...live, ...starting], servers: serving, past: [...bad, ...rest] };
}

/**
 * What each command's state hangs on, one entry per command: its task mark (the bridge's word:
 * running, done, lost...) and its step's status. A change of any of them changes the key, while the
 * lists of commands and notifications keep their identity (the bridge patches the step in place).
 */
export function commandKey(items: Items | undefined, ids: readonly string[]): string {
  let k = '';
  for (const id of ids) {
    const it = items?.[id];
    k += it?.type === 'tool' ? `${it.task?.state ?? ''}:${!!it.task?.serving}:${it.status},` : ',';
  }
  return k;
}

/**
 * The Agents tab's commands (`commandRows`), worked out again whenever a command is started, a
 * notification tells an end, or a command's own state changes (its task started, ended, was lost
 * with its process or reconciled as stopped: none of those writes a new list, review window-F2).
 * The same object while none of that changed.
 */
export function commandsView(commands: (t: Timeline | undefined) => readonly string[], notes: (t: Timeline | undefined) => ReadonlyMap<string, EndNote>): (t: Timeline | undefined) => Commands {
  let ids: readonly string[] | null = null;
  let ended: ReadonlyMap<string, EndNote> | null = null;
  let key = '';
  let out: Commands = { ids: [], serving: 0, running: 0, failed: 0, live: [], servers: [], past: [] };
  return (t) => {
    const started = commands(t);
    const seen = notes(t);
    const k = commandKey(t?.items, started);
    if (started === ids && seen === ended && k === key) return out;
    ids = started;
    ended = seen;
    key = k;
    out = commandRows(started, t?.items ?? emptyIndex, seen);
    return out;
  };
}

/** The sub-agent whose work a nested step is (the nearest agent above it); undefined for the chat's own. */
export function ownerAgent(items: Items, item: TimelineItem): ToolItem | undefined {
  let up = item.parentId ? items[item.parentId] : undefined;
  for (let n = 0; up && n < 64; n++) {
    if (isAgentItem(up)) return up;
    up = up.parentId ? items[up.parentId] : undefined;
  }
  return undefined;
}

/** One character per agent, `1` while it works: the list's sections follow it, nothing else. */
export function liveKey(items: Items | undefined, ids: readonly string[]): string {
  let k = '';
  for (const id of ids) k += isAgentLive(items?.[id] as ToolItem | undefined) ? '1' : '0';
  return k;
}

// ── a working sub-agent (how far it is: `progressIndex`, `readProgress` in now-model.ts) ──

/** The ids of its latest `n` steps, oldest first, as one string. */
export function latestSteps(items: Items | undefined, kids: readonly string[] | undefined, n: number): string {
  if (!items || !kids?.length) return '';
  const out: string[] = [];
  for (let i = kids.length - 1; i >= 0 && out.length < n; i--) if (items[kids[i]]?.type === 'tool') out.push(kids[i]);
  return out.reverse().join(',');
}

/** How many steps it took, counted under it (for agents that gave no count of their own). */
export function stepCount(items: Items | undefined, kids: readonly string[] | undefined): number {
  if (!items || !kids) return 0;
  let n = 0;
  for (const k of kids) if (items[k]?.type === 'tool') n++;
  return n;
}

// ── a working workflow ──

export interface WorkflowNow {
  /** "Phase 2 of 3", or '' with one phase. */
  phase: string;
  /** The title of the phase that runs now. */
  title: string;
  /** What one of its working agents does now. */
  doing: string;
  /** Agents finished of agents started. */
  done: number;
  agents: number;
}

export function workflowNow(run: WorkflowRun): WorkflowNow {
  const g = workflowGlance(run);
  let doing = '';
  for (let i = run.agents.length - 1; i >= 0; i--) {
    const a = run.agents[i];
    if (a.state === 'running' && a.activity) {
      doing = a.activity;
      break;
    }
  }
  if (!doing && g.running) doing = `${g.running} ${g.running === 1 ? 'agent' : 'agents'} working`;
  if (!doing && run.limitWait) doing = 'Waiting for a plan limit';
  return { phase: g.phases > 1 && g.phase > 0 ? `Phase ${g.phase} of ${g.phases}` : '', title: g.current ?? '', doing, done: g.done + g.failed, agents: g.agents };
}

// ── a finished agent ──

export type Outcome = 'done' | 'failed' | 'stopped' | 'interrupted' | 'denied' | 'unknown';

/** How it ended. "unknown": sent to the background and never heard from again. */
export function outcomeOf(item: ToolItem): Outcome {
  const stats = item.result?.agent;
  if (stats?.limit) return 'stopped';
  if (item.workflow) {
    if (item.status === 'error' || item.workflow.status === 'failed') return 'failed';
    if (item.status === 'cancelled' || item.status === 'denied') return 'interrupted';
    if (item.workflow.status === 'stopped') return 'stopped';
    return 'done';
  }
  if (item.status === 'error' || stats?.background === 'failed') return 'failed';
  if (item.status === 'denied') return 'denied';
  if (item.status === 'cancelled') return 'interrupted';
  if (stats?.background === 'stopped') return 'stopped';
  if (!stats?.background && item.detail.background) return 'unknown';
  return 'done';
}

export const OUTCOME_WORD: Record<Outcome, string> = {
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  denied: 'Denied',
  unknown: 'In the background',
};

export interface Figures {
  /** Its own working time, 0 when unknown. */
  ms: number;
  tokens: number;
  /** Steps as the agent counted them, when it did. */
  steps?: number;
  /** A workflow's agents, and how many of them failed. */
  agents?: number;
  failed?: number;
}

export function figuresOf(item: ToolItem): Figures {
  const run = item.workflow;
  if (run) {
    const g = workflowGlance(run);
    return { ms: run.durationMs ?? 0, tokens: run.tokens ?? 0, steps: run.steps, agents: g.agents, failed: g.failed };
  }
  const stats = item.result?.agent;
  // A background agent's call returns at once: only its own figure says how long it worked.
  const launched = !!stats?.background || !!item.detail.background;
  const ms = stats?.durationMs ?? (launched || !item.endedAt ? 0 : Math.max(0, item.endedAt - item.ts - (item.waitedMs ?? 0)));
  return { ms, tokens: stats?.tokens ?? 0, steps: stats?.steps };
}

// ── grouping ──

export interface Group {
  /** The message whose turn started them ('' before the first message). */
  user: string;
  /** Newest first. */
  ids: string[];
}

/**
 * Finished agents under the message whose turn started them (the latest message before the
 * agent), newest message first, newest agent first within it. `ids` and `users` come oldest first.
 * With `roots`, "before" is the conversation's own order (a nested agent stands where its topmost
 * parent does); without, the time each was sent. The order is the truth: a message sent into a
 * running turn keeps the time it was sent but stands where the agent took it, so an agent started
 * in between never saw it and is not filed under it.
 */
export function groupDone(ids: readonly string[], items: Items, users: readonly string[], roots?: readonly string[]): Group[] {
  const place = new Map<string, number>();
  if (roots) roots.forEach((id, i) => place.set(id, i));
  const placeOf = (id: string): number => {
    if (!roots) return items[id]?.ts ?? 0;
    let it = items[id];
    for (let up = 0; it?.parentId && up < 64; up++) it = items[it.parentId];
    return (it && place.get(it.id)) ?? -1;
  };
  const ts = users.map(placeOf);
  const byUser = new Map<string, string[]>();
  for (const id of ids) {
    const t = placeOf(id);
    // The last message at or before the agent's start (binary search: messages are in order).
    let lo = 0;
    let hi = ts.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const key = at >= 0 ? users[at] : '';
    const list = byUser.get(key);
    if (list) list.push(id);
    else byUser.set(key, [id]);
  }
  const order = (u: string) => (u ? placeOf(u) : -1);
  return [...byUser]
    .map(([user, list]) => ({ user, ids: list.reverse() }))
    .sort((a, b) => order(b.user) - order(a.user));
}

/** The first line of a message, short enough for a heading. */
export function promptLine(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 90 ? line.slice(0, 89).trimEnd() + '…' : line || 'Message';
}

// ── the overview ──

/** Finished agents of one wave: everything the person's message set going, across the turns that followed it. */
export interface Wave {
  /** The message that started it ('' before the first message). */
  user: string;
  /** What failed first, then newest first. */
  ids: string[];
  failed: number;
  /** When its message was sent (0 before the first message). */
  at: number;
  /**
   * How many of those failures are news: in the newest wave, or failed since the person last looked
   * at the tab (`seenAt`). Only news is red; an older failure is a quiet word.
   */
  news: number;
}

export interface Overview {
  /** Working now, oldest first: the longest runner on top. */
  working: string[];
  /** Newest first. */
  waves: Wave[];
  done: number;
  failed: number;
}

/**
 * The tab's list at a glance: who works now, then what finished, by the message that set it going.
 * `ids`, `users` oldest first (`agentIndex`, `userIndex`); `live` from `liveKey`.
 */
export function overview(ids: readonly string[], live: string, items: Items, users: readonly string[], roots?: readonly string[], seenAt = Infinity): Overview {
  const working: string[] = [];
  const done: string[] = [];
  ids.forEach((id, i) => (live[i] === '1' ? working : done).push(id));
  let failed = 0;
  const waves = groupDone(done, items, users, roots).map((g, index): Wave => {
    const bad: string[] = [];
    const rest: string[] = [];
    let news = 0;
    for (const id of g.ids) {
      const it = items[id];
      if (it?.type === 'tool' && outcomeOf(it) === 'failed') {
        bad.push(id);
        if (failureIsNews(it, index === 0, seenAt)) news++;
      } else rest.push(id);
    }
    failed += bad.length;
    return { user: g.user, ids: bad.length ? [...bad, ...rest] : g.ids, failed: bad.length, at: items[g.user]?.ts ?? 0, news };
  });
  return { working, waves, done: done.length, failed };
}

/** The waves of one earlier day, as one line of history. */
export interface Day {
  /** The local day ("2026-10-25": year, month from 0, day). */
  key: string;
  /** When its newest wave began. */
  at: number;
  /** Newest first. */
  waves: Wave[];
  /** Its finished agents, and what failed among them. */
  count: number;
  failed: number;
  news: number;
}

const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/**
 * History by day: the waves of the newest wave's own day stand as they are (`recent`); every
 * earlier day folds to one line that holds its waves, so five days of work are a handful of
 * lines. `waves` newest first, as `overview` gives them.
 */
export function historyDays(waves: readonly Wave[]): { recent: Wave[]; days: Day[] } {
  if (!waves.length) return { recent: [], days: [] };
  const first = dayKey(waves[0].at);
  const recent: Wave[] = [];
  const days: Day[] = [];
  for (const w of waves) {
    const key = dayKey(w.at);
    if (key === first && !days.length) {
      recent.push(w);
      continue;
    }
    let day = days[days.length - 1];
    if (!day || day.key !== key) days.push((day = { key, at: w.at, waves: [], count: 0, failed: 0, news: 0 }));
    day.waves.push(w);
    day.count += w.ids.length;
    day.failed += w.failed;
    day.news += w.news;
  }
  return { recent, days };
}

/** A day as a line of history says it: "Yesterday", the weekday within a week, else the date ("24 Nov"). */
export function dayLabel(at: number, now: number): string {
  const day = (ts: number) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const ago = Math.round((day(now) - day(at)) / 86_400_000);
  if (ago <= 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  if (ago < 7) return new Date(at).toLocaleDateString('en', { weekday: 'long' });
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * Whether a failure is news: it stands in the newest wave, or it failed after the person last
 * looked at the tab (`seenAt`: when the pane last left the screen, or first came on it). Anything
 * else is history: said in a quiet word, never in red.
 */
export function failureIsNews(item: ToolItem, newest: boolean, seenAt: number): boolean {
  return newest || (item.endedAt ?? item.ts) > seenAt;
}

/** A wave shows this many rows until asked for all; a tab with no more finished agents than `OPEN_ALL` opens every wave. */
export const WAVE_ROWS = 8;
export const OPEN_ALL = 12;
/** However many failed, a wave that holds rows back lists at most this many. */
const WAVE_MOST = 24;

/** Whether a wave stands open: as the person left it, else only the newest one. History folds away. */
export function waveOpen(index: number, _done: number, chosen: boolean | undefined): boolean {
  return chosen ?? index === 0;
}

/**
 * The rows an open wave shows and how many it holds back. Every failure shows (they come first);
 * a wave only a row or two longer than the cut shows whole, so "Show 1 more" never stands there.
 */
export function waveRows(wave: Wave, all: boolean): { ids: readonly string[]; more: number } {
  if (all || wave.ids.length <= WAVE_ROWS + 2) return { ids: wave.ids, more: 0 };
  const n = Math.min(Math.max(WAVE_ROWS, wave.failed), WAVE_MOST);
  return { ids: wave.ids.slice(0, n), more: wave.ids.length - n };
}

// ── every row's state, first (`RowState`, `STATE_MARK`: now-model.ts) ──

/** An agent's outcome as a row's state. */
export function agentState(outcome: Outcome): RowState {
  return outcome === 'interrupted' ? 'stopped' : outcome;
}

/** A background command's state as a row's state ("starting" is running: it works). */
export function commandRowState(state: CommandState): RowState {
  return state === 'starting' ? 'running' : state;
}

/**
 * The tab's header says what is true now, as one figure: "2 working" (everything that works, the
 * cards right under it say what each is), "1 serving" when only servers run. Nothing when nothing
 * works: never a total of what ended or failed over the chat's whole life. The sidebar and the
 * conversation's last line name the work (`workLabel`); here the list itself does.
 */
export function agentsHeader(n: { serving?: number; working: number; running: number; jobs?: number }): string {
  const now = n.working + n.running + (n.jobs ?? 0);
  if (now > 0) return `${now} working`;
  return n.serving ? `${n.serving} serving` : '';
}

// ── tracked jobs (`track_work`) ──

/**
 * The chat's tracked jobs (the `track_work` call's own step, always the chat's own), oldest first:
 * the same array until one is tracked. The bridge marks the step after it joined its list, which
 * changes no list: the write that marked it says (as `commandIndex` reads a task's mark).
 */
export function jobIndex(): (t: Timeline | undefined) => readonly string[] {
  let scan: Scan<string> | undefined;
  let rev = -1;
  let known = new Set<string>();
  let out: readonly string[] = NONE;
  return (t) => {
    if (!t) return NONE;
    let turned = false;
    if (t.rev !== undefined && t.rev !== rev) {
      const changed = changedSince({ items: t.items, rev: t.rev, changed: t.changed }, rev);
      if (!changed) turned = rev >= 0;
      else for (const id of changed) if (!known.has(id) && isJob(t.items[id])) turned = true;
      rev = t.rev;
    }
    if (!turned && scan?.arr === t.roots) return out;
    if (turned) scan = undefined;
    scan = grow(scan, t.roots, (id) => (isJob(t.items[id]) ? id : undefined));
    if (scan.found.length === out.length && scan.found.every((id, i) => id === out[i])) return out;
    known = new Set(scan.found);
    out = scan.found.length ? scan.found : NONE;
    return out;
  };
}

export interface Jobs {
  /** Processes Sable still sees running, the longest runner first. */
  running: string[];
  /** Ended or no longer tracked, newest first. */
  past: string[];
}

const NO_JOBS: Jobs = { running: [], past: [] };

/** The tab's jobs, worked out again when one is tracked or one's state changes; the same object otherwise. */
export function jobsView(jobs: (t: Timeline | undefined) => readonly string[]): (t: Timeline | undefined) => Jobs {
  let ids: readonly string[] | null = null;
  let key = '';
  let out = NO_JOBS;
  return (t) => {
    const all = jobs(t);
    if (!all.length) return NO_JOBS;
    let k = '';
    for (const id of all) k += `${(t?.items[id] as ToolItem | undefined)?.tracked?.state ?? ''},`;
    if (all === ids && k === key) return out;
    ids = all;
    key = k;
    const running: string[] = [];
    const past: string[] = [];
    for (const id of all) {
      const it = t?.items[id];
      if (!isJob(it)) continue;
      if (it.tracked.state === 'running') running.push(id);
      else past.unshift(id);
    }
    out = { running, past };
    return out;
  };
}

/**
 * The end of a job's log as its report carried it (the bridge's `trackedEndReport`), at most twelve
 * lines; else its last line. A report that came cut to the window reads as its last line alone.
 */
export function jobTail(report: string | undefined, line: string | undefined): string[] {
  const head = 'The last lines of its log:\n';
  const at = report ? report.indexOf(head) : -1;
  if (report && at >= 0) {
    const rest = report.slice(at + head.length);
    const end = rest.lastIndexOf('\nCheck what it left');
    if (end >= 0) {
      const lines = rest.slice(0, end).split('\n').filter((l) => l.trim());
      if (lines.length) return lines.slice(-12);
    }
  }
  return line ? [line] : [];
}

// isJob, jobRowState, jobRan, nowRows (what works now, as one list) and lastLine: now-model.ts.
