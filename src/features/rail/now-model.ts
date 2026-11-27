import type { TimelineItem, ToolItem, TrackedWork } from '@shared/protocol';
import { runsTask, tracksWork, worksInBackground } from '@shared/background';
import { delegateEnded } from '../timeline/delegate-word';

/**
 * What works in a chat now, and where a row of it stands: the pure part of the Agents tab's model
 * (agents-model.ts re-exports all of it), with no import of the window's own, so the phone's "Working
 * now" sheet and its conversation read work by the same rules as the desktop's tab.
 */

type Items = Record<string, TimelineItem | undefined>;

/** A sub-agent or a workflow: a step of kind `agent`. */
export const isAgentItem = (it: TimelineItem | undefined): it is ToolItem => it?.type === 'tool' && it.kind === 'agent';

/** Working now: its call runs, or it works on in the background (a background agent, a workflow). */
export const isAgentLive = (item: ToolItem | undefined): boolean => {
  if (!item) return false;
  // A report that waits is no running child: it never counts where the window counts who works.
  if (delegateEnded(item)) return false;
  // The same rule as the bridge's count of background work (shared/background.ts).
  if (!item.workflow && (item.status === 'running' || item.status === 'pending' || item.status === 'awaiting')) return true;
  return worksInBackground(item);
};

/**
 * A command the agent left running after its step returned (a build, a test run, a dev server, a
 * monitor): the bridge marks it (`ToolItem.task`), and a chat saved before it did says so on the
 * shell step alone (`run_in_background`).
 */
export function isBackgroundCommand(it: TimelineItem | undefined): it is ToolItem {
  if (it?.type !== 'tool' || it.check) return false;
  if (it.task) return true;
  if (it.kind !== 'bash') return false;
  return !!it.detail.background || (it.input as { run_in_background?: unknown } | undefined)?.run_in_background === true;
}

// ── every row's state, first ──

/** Where a row of the tab stands, whatever it is (a sub-agent, a workflow, a background command). */
export type RowState = 'running' | 'serving' | 'waiting' | 'done' | 'failed' | 'stopped' | 'denied' | 'lost' | 'unknown';

/**
 * The mark every row leads with: its state, never its kind (no terminal or tree glyph in that
 * column). Running is the ring, waiting on the person the amber dot, done the quiet check, failed
 * the red cross, stopped a dash, denied the prohibit sign, lost the dashed circle (its process went),
 * unknown a question mark (it gave no word of its end). Each row's words say the same beside it.
 */
export const STATE_MARK: Record<RowState, 'ring' | 'wait' | 'check' | 'x' | 'minus' | 'prohibit' | 'circle-dashed' | 'question'> = {
  running: 'ring',
  serving: 'minus',
  waiting: 'wait',
  done: 'check',
  failed: 'x',
  stopped: 'minus',
  denied: 'prohibit',
  lost: 'circle-dashed',
  unknown: 'question',
};

// ── tracked jobs (`track_work`) ──

/** A step that carries tracked work: a process the agent started outside its tools and asked Sable to watch. */
export function isJob(it: TimelineItem | undefined): it is ToolItem & { tracked: TrackedWork } {
  return it?.type === 'tool' && !!it.tracked;
}

/** Where a tracked job stands as a row's state: gone is done (Sable knows no exit code), let go is a dash. */
export function jobRowState(t: TrackedWork): RowState {
  return t.state === 'running' ? 'running' : t.state === 'ended' ? 'done' : 'stopped';
}

/** How long a job ran, as far as Sable saw it: 0 while it runs or when its end's time is not known. */
export function jobRan(t: TrackedWork): number {
  return t.state === 'ended' && t.endedAt ? Math.max(0, t.endedAt - t.since) : 0;
}

/** The agent a job's "who runs it" names (its mark stands for the word), or null for any other word. */
export function jobAgent(by: string | undefined): 'codex' | 'claude' | 'opencode' | null {
  if (!by) return null;
  if (/\bcodex\b/i.test(by)) return 'codex';
  if (/\bclaude\b/i.test(by)) return 'claude';
  if (/\bopencode\b/i.test(by)) return 'opencode';
  return null;
}

/**
 * The word a job that is over says where a time would stand: "Not tracked" for one the person let
 * go, "Ended" when the time of its end is not known; '' when it ran a known time (shown as that time).
 */
export function jobEndWord(t: TrackedWork): '' | 'Not tracked' | 'Ended' {
  if (t.state === 'running') return '';
  return t.state === 'left' ? 'Not tracked' : jobRan(t) >= 1000 ? '' : 'Ended';
}

// ── what works now, as one list ──

export interface NowRow {
  id: string;
  kind: 'agent' | 'job' | 'command';
}

/** When a thing that works began: a job when it was tracked, a command when its task started, an agent at its step. */
export function began(it: TimelineItem | undefined): number {
  if (it?.type !== 'tool') return 0;
  return it.tracked?.since ?? it.task?.since ?? it.ts;
}

/**
 * Everything that works now as one list in one grammar (sub-agents and workflows, tracked jobs,
 * running commands and monitors), the longest runner first: what the top of the tab shows. Servers
 * are not work: they stand apart, after it.
 */
export function nowRows(agents: readonly string[], jobs: readonly string[], commands: readonly string[], items: Items): NowRow[] {
  const rows: NowRow[] = [
    ...agents.map((id): NowRow => ({ id, kind: 'agent' })),
    ...jobs.map((id): NowRow => ({ id, kind: 'job' })),
    ...commands.map((id): NowRow => ({ id, kind: 'command' })),
  ];
  // A stable order: by start, then as given.
  return rows
    .map((row, at) => ({ row, at, ts: began(items[row.id]) }))
    .sort((a, b) => a.ts - b.ts || a.at - b.at)
    .map((r) => r.row);
}

/** A command that works now: its task runs and does not only serve (a server is no work: it stands apart). */
export const commandWorks = (it: TimelineItem | undefined): boolean => runsTask(it) && !it.task.serving;

/** A command that serves a local address or watches for changes now. */
export const commandServes = (it: TimelineItem | undefined): boolean => runsTask(it) && !!it.task.serving;

/** A tracked job that Sable still sees running. */
export const jobWorks = tracksWork;

// ── a working sub-agent ──

interface Kids {
  arr: readonly string[];
  tools: number;
  /** The latest task-list step (TodoWrite) under it, if any. */
  todo: string;
}

function scanKids(prev: Kids | undefined, arr: readonly string[], items: Items): Kids {
  if (prev?.arr === arr) return prev;
  const n = prev?.arr.length ?? 0;
  const appended = !!prev && n > 0 && arr.length >= n && arr[0] === prev.arr[0] && arr[n - 1] === prev.arr[n - 1];
  let tools = appended ? prev.tools : 0;
  let todo = appended ? prev.todo : '';
  for (let i = appended ? n : 0; i < arr.length; i++) {
    const it = items[arr[i]];
    if (it?.type !== 'tool') continue;
    tools++;
    if (it.kind === 'todo') todo = arr[i];
  }
  return { arr, tools, todo };
}

export interface Progress {
  steps: number;
  /** What it does now: the latest step's title, "Thinking", or "Writing the report". */
  now: string;
  /** Its own task list, when it keeps one: the only honest measure of how far it is. */
  todo?: { done: number; total: number };
  /** Its latest step waits for the person's approval. */
  waiting?: boolean;
}

const SEP = '\u0001';

/**
 * How far one working sub-agent is, as one string (`steps`, `now`, `done/total`): its card renders
 * when that string changes, never on a streamed word. Counting is incremental.
 */
export function progressIndex(): (items: Items | undefined, kids: readonly string[] | undefined) => string {
  let scan: Kids | undefined;
  return (items, kids) => {
    if (!items || !kids?.length) return `0${SEP}${SEP}${SEP}`;
    scan = scanKids(scan, kids, items);
    const last = items[kids[kids.length - 1]];
    const now = !last ? '' : last.type === 'tool' ? last.title : last.type === 'thinking' ? 'Thinking' : last.type === 'text' ? 'Writing the report' : '';
    const todos = scan.todo ? (items[scan.todo] as ToolItem | undefined)?.detail.todos : undefined;
    const todo = todos?.length ? `${todos.filter((t) => t.status === 'completed').length}/${todos.length}` : '';
    const waiting = last?.type === 'tool' && last.status === 'awaiting' ? 'w' : '';
    return `${scan.tools}${SEP}${now}${SEP}${todo}${SEP}${waiting}`;
  };
}

export function readProgress(key: string): Progress {
  const [steps, now, todo, waiting] = key.split(SEP);
  const out: Progress = { steps: Number(steps) || 0, now: now ?? '' };
  if (todo) {
    const [done, total] = todo.split('/').map(Number);
    out.todo = { done, total };
  }
  if (waiting) out.waiting = true;
  return out;
}

/** The last line a step's live output shows, as one plain line, cut: what a running command does now. */
export function lastLine(output: string | undefined, max = 160): string {
  if (!output) return '';
  const end = output.length > 4096 ? output.slice(-4096) : output;
  const rows = end.split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    // eslint-disable-next-line no-control-regex
    const row = rows[i].slice(rows[i].lastIndexOf('\r') + 1).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (row) return row.length > max ? `${row.slice(0, max - 1).trimEnd()}…` : row;
  }
  return '';
}
