import type { FileDiff, LimitHit, NoticeItem, ProviderId, TextItem, TimelineItem, ToolItem, ToolResult, UserItem } from '../../shared/protocol';
import { partOfTurn, syntheticOf, userText } from '../../shared/synthetic';
import type { AgentCall } from '../providers/agent-tool';
import type { SessionRuntime } from './runtime';

/**
 * "Check with Codex" (or Claude Code): the other agent reviews a finished turn's changes.
 *
 * Sable builds a compact brief from the turn (what was asked, what the agent answered, the diffs of
 * its edits) and runs the other agent on it as a child of the session (core/sub-agent.ts), in the
 * same folder and read-only: its own read-only mode, every permission it asks for denied, no
 * question put to the user. Its steps nest under one root step (`ToolItem.check`) that the window
 * shows under the checked turn; the step is never part of a turn and never reaches the session's
 * own agent (the agents keep their own transcripts; Sable's summaries leave it out, `withoutChecks`).
 * Its last answer is the findings, the step's `result.text`.
 */

/** The root step's tool name. */
export const CHECK_TOOL = 'sable_check';
/** How every brief begins (the Demo agent knows a check by it). */
export const CHECK_LEAD = 'Review the changes another coding agent just made in this folder.';
export const NO_PROBLEMS = 'No problems found.';

const NAMES: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', demo: 'Demo' };
export const agentName = (id: ProviderId) => NAMES[id] ?? id;

/** The agent that checks a turn of `provider`: the other one. A Demo chat checks with Demo. */
export function checkerOf(provider: ProviderId): ProviderId | undefined {
  if (provider === 'claude') return 'codex';
  if (provider === 'codex') return 'claude';
  if (provider === 'demo') return 'demo';
  return undefined;
}

/** The checker's own read-only mode: Codex's read-only sandbox, Claude Code's (and the Demo's) plan mode. */
export const readOnlyMode = (agent: ProviderId) => (agent === 'codex' ? 'read-only' : 'plan');

/** A summary for an agent never carries a check: it is the user's, not the conversation's. */
export const withoutChecks = (items: TimelineItem[]) => items.filter((i) => !(i.type === 'tool' && i.check));

const isCheck = (i: TimelineItem) => i.type === 'tool' && !!i.check;

// ── the turn ──

export interface TurnSlice {
  /** The message that started it, then any steered into it. */
  asks: UserItem[];
  /** Its root items after that first message, in order (checks left out). */
  roots: TimelineItem[];
  /** It is over: its turn record came, it was interrupted, or the next turn began. */
  ended: boolean;
}

/** The root items of the turn that the message `turnId` started; null when there is no such message. */
export function turnSlice(items: TimelineItem[], turnId: string): TurnSlice | null {
  const at = items.findIndex((i) => i.id === turnId);
  const first = items[at];
  if (at < 0 || first.type !== 'user' || first.parentId) return null;
  const asks: UserItem[] = [first];
  const roots: TimelineItem[] = [];
  let ended = false;
  for (let i = at + 1; i < items.length; i++) {
    const it = items[i];
    if (it.parentId || isCheck(it)) continue;
    if (it.type === 'user') {
      // Read as the window groups turns (timeline/turns.ts): a notification the agent took (a task
      // finished) joins the turn as a steered message does; a command's output or a reminder is
      // only part of it.
      const syn = syntheticOf(it);
      if (it.steered || syn?.role === 'notification') {
        asks.push(it);
        continue;
      }
      if (partOfTurn(syn)) continue;
      // Queued and not taken yet: not part of any turn so far.
      if (it.state === 'queued') continue;
      ended = true;
      break;
    }
    roots.push(it);
    if (it.type === 'turn' || (it.type === 'notice' && it.variant === 'interrupted')) {
      ended = true;
      break;
    }
  }
  return { asks, roots, ended };
}

/** The turn's edits that went through, sub-agents' included, in the order they were made. */
export function editsOf(items: TimelineItem[], roots: TimelineItem[]): ToolItem[] {
  const kids = new Map<string, TimelineItem[]>();
  for (const it of items) if (it.parentId) (kids.get(it.parentId) ?? kids.set(it.parentId, []).get(it.parentId)!).push(it);
  const out: ToolItem[] = [];
  const walk = (list: TimelineItem[], depth: number) => {
    for (const it of list) {
      if (it.type !== 'tool') continue;
      if ((it.kind === 'edit' || it.kind === 'write') && it.status === 'done') out.push(it);
      else if (it.kind === 'agent' && depth < 4) walk(kids.get(it.id) ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

// ── the brief ──

/** Caps (characters): the request and the answer each, and the diffs together. */
export const BRIEF_CAPS = { request: 3_000, answer: 3_000, diff: 24_000 };

/** A path as the checker reads it: relative to the folder, forward slashes. */
export function relTo(cwd: string, p: string): string {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const n = norm(p);
  const r = norm(cwd);
  if (r && n.toLowerCase().startsWith(r.toLowerCase() + '/')) return n.slice(r.length + 1);
  return n;
}

function fileDiffText(d: FileDiff, cwd: string): string {
  const path = relTo(cwd, d.path);
  const a = d.status === 'added' ? '/dev/null' : `a/${d.oldPath ? relTo(cwd, d.oldPath) : path}`;
  const b = d.status === 'deleted' ? '/dev/null' : `b/${path}`;
  if (d.binary) return `--- ${a}\n+++ ${b}\n(a binary file)`;
  const hunks = d.hunks.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]);
  return [`--- ${a}`, `+++ ${b}`, ...hunks].join('\n');
}

/** One edit as a unified diff: its own diff when the agent reported one, else what its input says. */
export function editText(t: ToolItem, cwd: string): string {
  const diffs = t.result?.diff;
  if (diffs?.length) return diffs.map((d) => fileDiffText(d, cwd)).join('\n');
  const path = t.detail.path ? relTo(cwd, t.detail.path) : '';
  if (!path) return '';
  const lines = (s: string, mark: string) => s.replace(/\n$/, '').split('\n').map((l) => mark + l);
  if (t.kind === 'write' && typeof t.detail.content === 'string') return [`--- /dev/null`, `+++ b/${path}`, '@@ @@', ...lines(t.detail.content, '+')].join('\n');
  if (typeof t.detail.oldText === 'string' || typeof t.detail.newText === 'string') {
    return [`--- a/${path}`, `+++ b/${path}`, '@@ @@', ...lines(t.detail.oldText ?? '', '-'), ...lines(t.detail.newText ?? '', '+')].join('\n');
  }
  return '';
}

export interface BriefFile {
  path: string;
  added: boolean;
  additions: number;
  deletions: number;
}

export interface Brief {
  text: string;
  files: BriefFile[];
  /** The diffs did not all fit. */
  cut: boolean;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}\n(cut here)` : t;
}

/** The changed files with what each gained and lost, in the order they were first changed. */
function filesOf(edits: ToolItem[], cwd: string): BriefFile[] {
  const files = new Map<string, BriefFile>();
  for (const t of edits) {
    const diffs = t.result?.diff;
    if (diffs?.length) {
      for (const d of diffs) {
        const path = relTo(cwd, d.path);
        const f = files.get(path) ?? { path, added: d.status === 'added', additions: 0, deletions: 0 };
        f.additions += d.additions;
        f.deletions += d.deletions;
        files.set(path, f);
      }
    } else if (t.detail.path) {
      const path = relTo(cwd, t.detail.path);
      if (!files.has(path)) files.set(path, { path, added: t.kind === 'write', additions: 0, deletions: 0 });
    }
  }
  return [...files.values()];
}

const fileLine = (f: BriefFile) => {
  const counts = [f.additions ? `+${f.additions}` : '', f.deletions ? `-${f.deletions}` : ''].filter(Boolean).join(' ');
  const what = [f.added ? 'new' : '', counts].filter(Boolean).join(', ');
  return `- ${f.path}${what ? ` (${what})` : ''}`;
};

/**
 * The checker's task: what the user asked, what the agent said when it finished, which files
 * changed and how. Compact: the request and the answer are capped, the diffs too (said when cut).
 */
export function buildBrief(items: TimelineItem[], turnId: string, cwd: string, caps = BRIEF_CAPS): Brief | null {
  const slice = turnSlice(items, turnId);
  if (!slice) return null;
  const edits = editsOf(items, slice.roots);
  const files = filesOf(edits, cwd);
  const request = slice.asks.map((u, i) => (i === 0 ? userText(u.text) : `(Added while it worked) ${userText(u.text)}`)).join('\n\n');
  const answer = [...slice.roots].reverse().find((i): i is TextItem => i.type === 'text' && !!i.text.trim())?.text ?? '';

  const parts: string[] = [];
  let used = 0;
  let cut = false;
  let left = 0;
  for (let i = 0; i < edits.length; i++) {
    const text = editText(edits[i], cwd);
    if (!text) continue;
    if (cut) {
      left++;
      continue;
    }
    const room = caps.diff - used;
    if (text.length + 1 <= room) {
      parts.push(text);
      used += text.length + 1;
      continue;
    }
    cut = true;
    // Part of this edit when a useful part fits, cut at a line.
    if (room > 1_500) {
      const head = text.slice(0, room);
      parts.push(head.slice(0, Math.max(0, head.lastIndexOf('\n'))));
    } else left++;
  }

  const lines = [
    CHECK_LEAD,
    'You are the reviewer: read the files and run read-only commands as you need, but change nothing. Do not present a plan; your answer is the review.',
    '',
    'Look only for correctness bugs, regressions and parts of the request the changes miss. Leave style, naming and formatting alone.',
    '',
    'Answer with one line per finding, the most severe first, in this form:',
    '- `path/to/file.ts:42` High: one sentence on what goes wrong and when.',
    `Severity is High, Medium or Low. Paths are relative to this folder and line numbers are as the files are now. Write nothing else. If you find no problem, answer exactly: ${NO_PROBLEMS}`,
    '',
    '<request>',
    clip(request, caps.request) || '(no words, only attachments)',
    '</request>',
    '',
    '<answer>',
    clip(answer, caps.answer) || '(the agent finished without a written answer)',
    '</answer>',
    '',
    'Changed files:',
    ...files.map(fileLine),
    '',
    '<changes>',
    parts.join('\n'),
    '</changes>',
  ];
  if (cut) lines.push(`The changes are cut here${left ? ` (${left} more ${left === 1 ? 'edit' : 'edits'} left out)` : ''}. Read the changed files for the rest.`);
  return { text: lines.join('\n'), files, cut };
}

/** The changed files a brief names (the Demo agent reads them back). */
export function briefFiles(text: string): string[] {
  const at = text.indexOf('\nChanged files:\n');
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of text.slice(at + 16).split('\n')) {
    const m = /^- (\S+)/.exec(line);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

// ── running checks ──

export interface CheckDeps {
  /** Whether `agent` can check now (installed and signed in). */
  available: (agent: ProviderId) => boolean;
  /** Runs the checker read-only as a child of `parent`, its steps nested under `itemId`; its final answer. */
  run: (parent: SessionRuntime, call: AgentCall, itemId: string, signal: AbortSignal) => Promise<{ ok: boolean; text: string }>;
  /** The session's agent is in a turn now. */
  busy: (rt: SessionRuntime) => boolean;
  log: (...a: unknown[]) => void;
}

interface Running {
  rt: SessionRuntime;
  turn: string;
  ctrl: AbortController;
  done: Promise<void>;
}

/** The turn checks that run now, by their root step. */
export class TurnChecks {
  private running = new Map<string, Running>();

  constructor(private deps: CheckDeps) {}

  /** Starts a check of the turn `turnId` of `rt`; answers its step, or why it cannot. One at a time per turn. */
  start(rt: SessionRuntime, turnId: string): { ok: boolean; itemId?: string; error?: string } {
    const agent = checkerOf(rt.meta.provider);
    if (!agent) return { ok: false, error: 'This chat has no other agent to check with.' };
    const who = agentName(agent);
    if (!this.deps.available(agent)) return { ok: false, error: `${who} is not signed in.` };
    for (const [id, r] of this.running) if (r.rt === rt && r.turn === turnId && rt.get(id)) return { ok: true, itemId: id };
    const slice = turnSlice(rt.items, turnId);
    if (!slice) return { ok: false, error: 'That turn is no longer in the conversation.' };
    if (!slice.ended && this.deps.busy(rt)) return { ok: false, error: 'The turn is still running.' };
    const brief = buildBrief(rt.items, turnId, rt.meta.cwd);
    if (!brief?.files.length) return { ok: false, error: 'This turn changed no files.' };

    const root = rt.add<ToolItem>({
      type: 'tool',
      name: CHECK_TOOL,
      kind: 'agent',
      title: `${who} checked this turn`,
      status: 'running',
      detail: { subagent: who, description: 'Check this turn', prompt: brief.text },
      check: { turn: turnId, agent, ...(brief.cut ? { cut: true } : {}) },
    });
    rt.apart.add(root.id);
    const ctrl = new AbortController();
    const done = this.run(rt, root.id, { agent, description: 'Check this turn', prompt: brief.text }, ctrl).finally(() => {
      this.running.delete(root.id);
      rt.apart.delete(root.id);
    });
    this.running.set(root.id, { rt, turn: turnId, ctrl, done });
    return { ok: true, itemId: root.id };
  }

  private async run(rt: SessionRuntime, rootId: string, call: AgentCall, ctrl: AbortController) {
    let res: { ok: boolean; text: string };
    try {
      res = await this.deps.run(rt, call, rootId, ctrl.signal);
    } catch (err) {
      res = { ok: false, text: (err as Error).message };
    }
    // Gone with a rewind (or the session): nothing to report on.
    if (!rt.get(rootId)) return;
    const endedAt = Date.now();
    const limit = this.takeLimit(rt, rootId);
    if (ctrl.signal.aborted) {
      rt.patch<ToolItem>(rootId, { status: 'cancelled', endedAt, result: { interrupted: true } });
    } else if (limit) {
      rt.patch<ToolItem>(rootId, { status: 'error', endedAt, result: { text: res.text, agent: { limit } } });
    } else if (!res.ok) {
      rt.patch<ToolItem>(rootId, { status: 'error', endedAt, result: { text: res.text } });
    } else {
      const findings = findingsOf(res.text);
      if (findings) rt.patch<ToolItem>(rootId, { status: 'done', endedAt, result: { text: findings } satisfies ToolResult });
      else rt.patch<ToolItem>(rootId, { status: 'error', endedAt, result: { text: 'It finished without writing any findings.' } });
    }
  }

  /**
   * A plan limit stopped the checker: its limit notice (written for a turn of the session's own,
   * with actions that would move this chat) leaves the check's steps, and the step says it in one line.
   */
  private takeLimit(rt: SessionRuntime, rootId: string): { window: string; resetsAt?: number } | undefined {
    let hit: LimitHit | undefined;
    for (const it of [...rt.items]) {
      if (it.parentId !== rootId || it.type !== 'notice' || !(it as NoticeItem).limit) continue;
      hit ??= (it as NoticeItem).limit;
      rt.remove(it.id);
    }
    if (!hit) return undefined;
    return { window: hit.window ?? 'Plan limit', ...(hit.resetsAt ? { resetsAt: hit.resetsAt } : {}) };
  }

  /** Stops the check whose step is `itemId`. */
  stop(rt: SessionRuntime, itemId: string): boolean {
    const r = this.running.get(itemId);
    if (!r || r.rt !== rt) return false;
    r.ctrl.abort();
    return true;
  }

  /** The session closes or goes: its checks stop, and this waits a moment for them to wind down (so nothing writes to it after). */
  async closed(rt: SessionRuntime) {
    const mine = [...this.running.values()].filter((r) => r.rt === rt);
    for (const r of mine) r.ctrl.abort();
    if (mine.length) await Promise.race([Promise.allSettled(mine.map((r) => r.done)), new Promise((r) => setTimeout(r, 3_000))]);
  }

  /** After a rewind: checks whose step went with it stop. */
  pruned(rt: SessionRuntime) {
    for (const [id, r] of this.running) if (r.rt === rt && !rt.get(id)) r.ctrl.abort();
  }

  isRunning(itemId: string) {
    return this.running.has(itemId);
  }

  /** Stops every check and waits a moment for their agents to close. */
  async dispose() {
    const all = [...this.running.values()];
    for (const r of all) r.ctrl.abort();
    await Promise.race([Promise.allSettled(all.map((r) => r.done)), new Promise((r) => setTimeout(r, 3_000))]);
  }
}

/** The answer as findings: the agent's words, trimmed; '' when it wrote none. */
export function findingsOf(text: string): string {
  const t = text.trim();
  if (!t || /^the sub-agent finished without a written answer\.?$/i.test(t)) return '';
  return t;
}
