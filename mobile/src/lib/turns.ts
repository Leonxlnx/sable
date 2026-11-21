import type { TimelineItem } from '@shared/protocol';
import { syntheticOf } from '@shared/synthetic';
import { isLeadIn } from '@desk/features/timeline/lead-in';

/**
 * A conversation as turns, read the way the desktop reads it (src/features/timeline/turns.ts, the
 * same rules at hand size): each message, what the agent said along the way (always in view, one
 * tone back), one line for the work behind it, and the answer. One-line lead-ins ("Let me run the
 * tests.") fold with the steps they announce and name the live line while those run. A message
 * steered into a running turn opens a segment of its own, so its reply sits right under it and the
 * work goes on below.
 *
 * Each root item is one character (`shapeOf`):
 *   U a sent message that starts a turn   S a message steered in   Q a queued one (floats to the end)
 *   t the agent's words (an answer candidate)   l a lead-in (folds with the steps it announces)
 *   c command output   p a plan   g a widget (all in view, in their place)
 *   w a step (a tool call)   h thinking   k a task list update   n another notice (folded with the work)
 *   i "Interrupted"   e an error notice   T turn end   F turn end with an error
 *   Z a line of its own that closes a turn left open: a /until loop's end, or a switch of agent
 *   x a check of a turn by the other agent (never part of a turn: shown under the turn it checks)
 *   N a notification Claude Code wrote in the person's place (a task finished; shared/synthetic.ts):
 *     a line that opens a turn, or in a running one a segment of its own
 *   u such a message with nothing to show (a reminder): opens a turn between turns, left out when
 *     nothing comes in it (a slash command opens a turn as a message does, U; what it printed is n)
 *   . nothing to show
 */

export type FlowChunk = { kind: 'text'; id: string } | { kind: 'show'; id: string } | { kind: 'steps'; key: string; ids: string[]; count: number } | { kind: 'line' };

/** The work line's place in a flow (one shared object, found by identity). */
export const LINE: FlowChunk = { kind: 'line' };

export interface Segment {
  key: string;
  /** The message that opened it (the turn's own, or one steered in). */
  lead: string | null;
  steered: boolean;
  /** Everything folded behind the work line, in order. */
  work: string[];
  /** The segment as it reads; the line stands before the first run of steps (a steered one after its reply). */
  flow: FlowChunk[];
  /** Tool calls in `work`. */
  steps: number;
  /** The last thing said: full strength. */
  answer: string | null;
  /** A steered segment's first words, when more followed: full strength too. */
  reply: string | null;
  /** Error notices, and notices that are all a segment holds: in view, after the flow. */
  errors: string[];
  /** Lead-ins folded since the agent last said something in view, oldest first: the live line names the newest. */
  narr: string[];
}

export type TurnState = 'running' | 'done' | 'failed' | 'interrupted';

export interface TurnGroup {
  kind: 'turn';
  key: string;
  segments: Segment[];
  end: string | null;
  state: TurnState;
  ids: string[];
  /** Checks of this turn by the other agent, oldest first. */
  checks?: string[];
}

export interface ItemGroup {
  kind: 'item';
  key: string;
  id: string;
}

export type Group = TurnGroup | ItemGroup;

export interface TurnLayout {
  groups: Group[];
  queued: string[];
}

const shapes = new WeakMap<object, string>();

function shapeRaw(item: TimelineItem): string {
  switch (item.type) {
    case 'user': {
      if (item.steered) return 'S';
      if (item.state === 'queued') return 'Q';
      const syn = syntheticOf(item);
      if (!syn) return 'U';
      return syn.role === 'notification' ? 'N' : syn.role === 'hidden' ? 'u' : syn.role === 'command' ? 'U' : 'n';
    }
    case 'text':
      if (!item.streaming && !item.text.trim()) return '.';
      return isLeadIn(item.text, !!item.streaming) ? 'l' : 't';
    case 'thinking':
      return 'h';
    case 'tool':
      if (item.check) return 'x';
      // A file handed over shows in view, as a widget does (the phone draws it as a card with Download).
      return item.kind === 'plan' ? 'p' : item.kind === 'widget' || item.kind === 'share' ? 'g' : item.kind === 'todo' ? 'k' : 'w';
    case 'notice':
      // An until loop's end, or a switch of agent: a line of its own that closes a turn left open.
      if (item.until || item.agentSwitch) return 'Z';
      if (item.variant === 'interrupted') return 'i';
      if (item.variant === 'error') return 'e';
      if (item.variant === 'command') return 'c';
      return 'n';
    case 'turn':
      return item.error ? 'F' : 'T';
    default:
      return '.';
  }
}

/** One character per item; items are replaced, never changed, so each object is read once. */
export function shapeOf(item: TimelineItem | undefined): string {
  if (!item) return '.';
  let c = shapes.get(item);
  if (c === undefined) {
    c = shapeRaw(item);
    shapes.set(item, c);
  }
  return c;
}

export const shapeString = (roots: string[], items: Record<string, TimelineItem>) => {
  let s = '';
  for (const id of roots) s += shapeOf(items[id]);
  return s;
};

/**
 * A shape string with the characters of `ids` read again, and nothing else: the store keeps each
 * open chat's shape this way, so a streamed word never walks the loaded history (a changed item is
 * near the end: its place is looked for from there).
 */
export function reshape(shape: string, roots: readonly string[], items: Record<string, TimelineItem>, ids: Iterable<string>): string {
  for (const id of ids) {
    const it = items[id];
    if (!it || it.parentId) continue;
    const i = roots.lastIndexOf(id);
    if (i < 0) continue;
    const c = shapeOf(it);
    if (shape[i] !== c) shape = shape.slice(0, i) + c + shape.slice(i + 1);
  }
  return shape;
}

const ANSWER = new Set(['t', 'c', 'p']);
const SHOW = new Set(['c', 'g', 'p']);
const WORK_AFTER = new Set(['w', 'h', 'k', 'n', 'l']);
/** What the bridge or the agent may write after its last words without doing more work: notices, task list updates, thinking. */
const QUIET_AFTER = new Set(['.', 'n', 'k', 'h']);

interface RawSeg {
  lead: string | null;
  steered: boolean;
  ids: string[];
  chars: string[];
}

/**
 * A lead-in stays folded when a step follows it (or while it is the newest thing of a running
 * segment); else it is said in view: before more text, as the answer of a settled segment (also
 * when only a notice, a task list update or thinking came after it), and always as the reply to a
 * steered message. `final`: a settled segment that answers (not failed, not cut by a steer); with
 * nothing else said in it, its last lead-in is its answer after all ("Let me fix the typo." then
 * the edit), so the turn keeps an answer.
 */
function settleLeads(chars: string[], live: boolean, steered: boolean, final = false): string[] {
  if (!chars.includes('l')) return chars;
  const out = chars.slice();
  let replied = !steered;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === 't') replied = true;
    if (ch !== 'l') continue;
    if (!replied) {
      out[i] = 't';
      replied = true;
      continue;
    }
    let j = i + 1;
    while (j < out.length && out[j] === '.') j++;
    let k = j;
    while (k < out.length && QUIET_AFTER.has(out[k])) k++;
    // Nothing but quiet entries after it: the last words of the segment.
    if (k >= out.length) {
      if (!live) out[i] = 't';
      continue;
    }
    if (!WORK_AFTER.has(out[j])) out[i] = 't';
  }
  if (final && !out.some((c) => ANSWER.has(c))) {
    const last = out.lastIndexOf('l');
    if (last >= 0) out[last] = 't';
  }
  return out;
}

function buildSegment(raw: RawSeg, index: number, turnKey: string, failed: boolean, live: boolean, cut: boolean): Segment {
  const chars = settleLeads(raw.chars, live, raw.steered, !live && !failed && !cut);
  const errors: string[] = [];
  let answerAt = -1;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (ANSWER.has(chars[i])) {
      answerAt = i;
      break;
    }
    if (live && chars[i] !== '.' && chars[i] !== 'i' && chars[i] !== 'e') break;
  }
  if (failed || cut) answerAt = -1;
  const lone = !chars.some((c) => c !== 'n' && c !== '.' && c !== 'i' && c !== 'e');
  let replyAt = -1;
  if (raw.steered) {
    const first = chars.indexOf('t');
    if (first >= 0 && first !== answerAt) replyAt = first;
  }
  const flow: FlowChunk[] = [];
  const work: string[] = [];
  let steps = 0;
  let lined = false;
  let ready = !raw.steered;
  let run: string[] = [];
  let runCount = 0;
  let narr: string[] = [];
  const flush = () => {
    if (!run.length) return;
    if (!lined && ready) {
      flow.push(LINE);
      lined = true;
    }
    flow.push({ kind: 'steps', key: run[0], ids: run, count: runCount });
    run = [];
    runCount = 0;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const id = raw.ids[i];
    if (ch === '.' || ch === 'i') continue;
    if (ch === 'e' || (lone && ch === 'n')) {
      errors.push(id);
      continue;
    }
    if (ch === 't' || SHOW.has(ch)) {
      flush();
      flow.push({ kind: ch === 't' ? 'text' : 'show', id });
      if (ch === 't') {
        ready = true;
        narr = [];
      }
      continue;
    }
    if (ch === 'l') narr.push(id);
    work.push(id);
    run.push(id);
    if (ch === 'w') {
      steps++;
      runCount++;
    }
  }
  flush();
  if (!lined && (live || work.length)) flow.push(LINE);
  return {
    key: raw.lead ?? `${turnKey}:${index}`,
    lead: raw.lead,
    steered: raw.steered,
    work,
    flow,
    steps,
    answer: answerAt >= 0 ? raw.ids[answerAt] : null,
    reply: replyAt >= 0 ? raw.ids[replyAt] : null,
    errors,
    narr,
  };
}

interface Open {
  ids: string[];
  segs: RawSeg[];
  interrupted: boolean;
  failed: boolean;
  /** Opened by a message with nothing to show (u): left out when nothing else comes in it. */
  quiet?: boolean;
}

/**
 * Root items into turns. A turn runs from a sent message to its closing turn item (or the next
 * message); steered messages split it into segments. `busy`: the chat is working, so a turn left
 * open at the end is the running one.
 */
export function groupTurns(ids: readonly string[], shape: string, busy: boolean, checkOf?: (id: string) => string | undefined): TurnLayout {
  const groups: Group[] = [];
  const queued: string[] = [];
  const checks: { id: string; at: number }[] = [];
  let open: Open | null = null;

  const close = (end: string | null, failedEnd: boolean, atEnd: boolean) => {
    if (!open) return;
    const o: Open = open;
    open = null;
    if (end) o.ids.push(end);
    const failed = failedEnd || o.failed;
    const state: TurnState = atEnd && !end && busy && !o.interrupted ? 'running' : failed ? 'failed' : o.interrupted ? 'interrupted' : 'done';
    // A reminder or a caveat with nothing after it: nothing to show.
    if (o.quiet && state !== 'running' && o.segs.length === 1 && o.segs[0].chars.every((c) => c === '.')) return;
    const key = o.ids[0];
    const last = o.segs.length - 1;
    const segments = o.segs.map((s, i) => buildSegment(s, i, key, failed && i === last, state === 'running' && i === last, i < last));
    // A settled turn whose last segment said nothing (only steps after a steered message): the
    // newest segment that did say something answers it, so the turn keeps its answer and its foot.
    if ((state === 'done' || state === 'interrupted') && !segments.some((sg) => sg.answer)) {
      for (let i = last - 1; i >= 0; i--) {
        const seg = buildSegment(o.segs[i], i, key, false, false, false);
        if (!seg.answer) continue;
        segments[i] = seg;
        break;
      }
    }
    groups.push({ kind: 'turn', key, segments, end, state, ids: o.ids });
  };

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    let ch = shape[i] ?? '.';
    if (ch === 'Q') {
      queued.push(id);
      continue;
    }
    // A message with nothing to show: nothing inside a turn; between turns it opens one.
    if (ch === 'u') {
      if (open) ch = '.';
      else {
        open = { ids: [id], segs: [{ lead: id, steered: false, ids: [], chars: [] }], interrupted: false, failed: false, quiet: true };
        continue;
      }
    }
    // A notification: in a running turn a segment of its own (as a steered message), else a turn.
    if (ch === 'N') {
      const o = open as Open | null;
      if (o && !o.interrupted) {
        o.ids.push(id);
        o.segs.push({ lead: id, steered: false, ids: [], chars: [] });
        continue;
      }
      close(null, false, false);
      open = { ids: [id], segs: [{ lead: id, steered: false, ids: [], chars: [] }], interrupted: false, failed: false };
      continue;
    }
    // A check runs beside the conversation: it never joins (or ends) the turn around it.
    if (ch === 'x') {
      checks.push({ id, at: groups.length + (open ? 1 : 0) });
      continue;
    }
    if (ch === 'U' || (ch === 'S' && !open)) {
      close(null, false, false);
      open = { ids: [id], segs: [{ lead: id, steered: ch === 'S', ids: [], chars: [] }], interrupted: false, failed: false };
      continue;
    }
    if (ch === 'Z') {
      close(null, false, false);
      groups.push({ kind: 'item', key: id, id });
      continue;
    }
    if (ch === 'T' || ch === 'F') {
      if (open) close(id, ch === 'F', false);
      else groups.push({ kind: 'item', key: id, id });
      continue;
    }
    if (!open) {
      const prev = groups[groups.length - 1];
      if (ch === 'i' && prev?.kind === 'turn' && prev.state !== 'running') {
        prev.state = prev.state === 'failed' ? 'failed' : 'interrupted';
        prev.ids.push(id);
        continue;
      }
      // Before the first message of a page (a page that starts inside a turn): a turn of its own.
      if (ch !== '.') open = { ids: [id], segs: [{ lead: null, steered: false, ids: [id], chars: [ch] }], interrupted: ch === 'i', failed: ch === 'e' };
      continue;
    }
    const o: Open = open;
    if (ch === 'n' && o.interrupted) {
      close(null, false, false);
      groups.push({ kind: 'item', key: id, id });
      continue;
    }
    o.ids.push(id);
    if (ch === 'S') {
      o.segs.push({ lead: id, steered: true, ids: [], chars: [] });
      continue;
    }
    const seg = o.segs[o.segs.length - 1];
    seg.ids.push(id);
    seg.chars.push(ch);
    if (ch === 'i') o.interrupted = true;
    else if (ch === 'e') o.failed = true;
    else if (ANSWER.has(ch)) o.failed = false;
  }
  close(null, false, true);
  if (!checks.length) return { groups, queued };
  // Each check under the turn it checks; on its own where it stands when that turn is not here.
  const at = new Map<string, number>();
  groups.forEach((g, i) => g.kind === 'turn' && at.set(g.key, i));
  const loose: { id: string; at: number }[] = [];
  for (const c of checks) {
    const i = at.get(checkOf?.(c.id) ?? '');
    if (i === undefined) loose.push(c);
    else {
      const t = groups[i] as TurnGroup;
      t.checks = [...(t.checks ?? []), c.id];
    }
  }
  for (let i = loose.length - 1; i >= 0; i--) groups.splice(Math.min(loose[i].at, groups.length), 0, { kind: 'item', key: loose[i].id, id: loose[i].id });
  return { groups, queued };
}

const chunkSig = (c: FlowChunk) => (c.kind === 'line' ? '|' : c.kind === 'steps' ? `${c.key}+${c.ids.length}+${c.count}` : c.id);
const segSig = (s: Segment) => `${s.lead}>${s.flow.map(chunkSig).join(',')}>${s.reply}>${s.answer}>${s.errors.join(',')}>${s.narr.join(',')}`;
const turnSig = (g: TurnGroup) => `${g.state}|${g.end}|${g.ids.length}|${g.checks?.join(',') ?? ''}|${g.segments.map(segSig).join(';')}`;

/**
 * Keeps the objects of turns and segments that did not change since the last layout, so their
 * memoized views skip rendering: a new step in the running turn renders that turn alone.
 */
export function stabilize(next: TurnLayout, prev: Map<string, unknown>): TurnLayout {
  const seen = new Map<string, unknown>();
  const groups = next.groups.map((g): Group => {
    if (g.kind !== 'turn') return g;
    const k = `t|${turnSig(g)}`;
    const old = prev.get(k) as TurnGroup | undefined;
    if (old) {
      seen.set(k, old);
      for (const s of old.segments) seen.set(`s|${segSig(s)}`, s);
      return old;
    }
    const segments = g.segments.map((s) => {
      const sk = `s|${segSig(s)}`;
      const os = (prev.get(sk) ?? seen.get(sk)) as Segment | undefined;
      const seg = os ?? s;
      seen.set(sk, seg);
      return seg;
    });
    const turn = { ...g, segments };
    seen.set(k, turn);
    return turn;
  });
  prev.clear();
  for (const [k, v] of seen) prev.set(k, v);
  return { groups, queued: next.queued };
}
