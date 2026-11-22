import type { TimelineItem } from '@shared/protocol';
import { noticeLevel } from '@shared/notice';
import { isNobodysWords, syntheticOf } from '@shared/synthetic';
import { isLeadIn } from '@desk/features/timeline/lead-in';

/**
 * A conversation as turns, read the way the desktop reads it (src/features/timeline/turns.ts, the
 * same rules at hand size). A turn is a sequence of checkpoints: a run of work (steps, thinking,
 * task updates, lead-ins) closed by something in view (a note the agent wrote, a widget, files, a
 * plan, an error). While the turn runs each closed checkpoint reads as its work line and its note,
 * and the live line stands under the newest; once it has ended the turn is one line and what never
 * folds (things shown, a steered message with its reply, the answer). One-line lead-ins ("Let me run
 * the tests.") fold with the steps they announce and name the live line while those run.
 *
 * Each root item is one character (`shapeOf`):
 *   U a sent message that starts a turn   S a message steered in   Q a queued one (floats to the end)
 *   t the agent's words (an answer candidate)   l a lead-in (folds with the steps it announces)
 *   c command output   p a plan   g a widget or files handed over (all in view, in their place)
 *   w a step (a tool call)   h thinking   k a task list update   n another notice (folded with the work)
 *   i "Interrupted"   e an error notice   T turn end   F turn end with an error
 *   Z a line of its own that closes a turn left open: a /until loop's end, a switch of agent, a rewind's result
 *   x a check of a turn by the other agent (never part of a turn: shown under the turn it checks)
 *   N a notification Claude Code wrote in the person's place (a task finished; shared/synthetic.ts):
 *     a line that opens a turn, or in a running one a segment of its own
 *   u such a message with nothing to show (a reminder): opens a turn between turns, left out when
 *     nothing comes in it (a slash command opens a turn as a message does, U; what it printed is n)
 *   ? an item of a type this phone does not know (a newer desktop's): one calm line in its place
 *   . nothing to show
 */

/**
 * One piece of a segment, in the order it happened: `text` something the agent said (a note along
 * the way, the reply to a steered message, the answer), `show` what never folds (command output, a
 * widget, files, a plan, an error notice), `steps` a run of work between them: one checkpoint.
 */
export type FlowChunk = { kind: 'text'; id: string } | { kind: 'show'; id: string } | StepsChunk;
export interface StepsChunk {
  kind: 'steps';
  key: string;
  ids: string[];
  /** Tool calls in the run. */
  count: number;
}

export interface Segment {
  key: string;
  /** The message that opened it (the turn's own, or one steered in); null for work no message opened. */
  lead: string | null;
  steered: boolean;
  /** Every item of the segment's work, in order (the ids of its `steps` chunks). */
  work: string[];
  /** The segment as it happened; a steered segment starts with the reply to its message. */
  flow: FlowChunk[];
  /** Tool calls in `work`. */
  steps: number;
  /** The answer, never folded: the last thing said that is not a lead-in or a nod. */
  answer: string | null;
  /** A steered segment's first words, when more followed: the direct reply, never folded. */
  reply: string | null;
  /** The last words before a failure, when the segment has no answer: in view over the error. */
  last: string | null;
  /** What was said after the answer (or those last words): a nod, in view under it. */
  tail: string[];
  /** The texts that fold with the work once the turn has ended (empty in a turn with no work at all). */
  notes: string[];
  /**
   * The error notices shown in the flow (the footer then does not say the failure again). Notices
   * that are all a segment holds show in the flow too, but are not errors.
   */
  errors: string[];
  /** Lead-ins folded since the last piece in view, oldest first: the live line names the newest. */
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
  /** Ended before the agent finished (`endedEarly`), as the desktop reads it. Only a settled turn. */
  early?: true;
}

const AFTER_LAST = new Set(['.', 'n']);
const UNFINISHED = new Set(['w', 'h', 'k']);

/**
 * Whether a settled turn ended before the agent finished, by the desktop's rule
 * (src/features/timeline/turns.ts `endedEarly`): no turn record closed it, it was not stopped and
 * did not fail, and its last act was work with nothing said after it. `closedBy`: what closed it,
 * when not the next message or the end of the timeline.
 */
export function endedEarly(state: TurnState, end: string | null, lastChars: readonly string[], closedBy?: 'line'): boolean {
  if (state !== 'done' || end || closedBy) return false;
  for (let i = lastChars.length - 1; i >= 0; i--) {
    const ch = lastChars[i];
    if (AFTER_LAST.has(ch)) continue;
    return UNFINISHED.has(ch);
  }
  return false;
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
      // What a command printed is command output: in view in its place, never folded with the work
      // (a compaction's summary keeps its own path: a notice that folds).
      return syn.role === 'notification' ? 'N' : syn.role === 'hidden' ? 'u' : syn.role === 'command' ? 'U' : syn.role === 'output' ? 'c' : 'n';
    }
    case 'text':
      // Claude Code's stand-in where a cut turn has no answer ("No response requested.") and its own
      // sign-in failure line in a chat saved before 0.2.20: nobody's words.
      if (!item.streaming && (!item.text.trim() || isNobodysWords(item.text))) return '.';
      return isLeadIn(item.text, !!item.streaming) ? 'l' : 't';
    case 'thinking':
      return 'h';
    case 'tool':
      if (item.check) return 'x';
      // A file handed over shows in view, as a widget does (the phone draws it as a card with Download).
      return item.kind === 'plan' ? 'p' : item.kind === 'widget' || item.kind === 'share' ? 'g' : item.kind === 'todo' ? 'k' : 'w';
    case 'notice':
      // An until loop's end, a switch of agent, a rewind: a line of its own that closes a turn left
      // open (a rewind to a steered message keeps a turn with no end; its result must not fold into it).
      if (item.until || item.agentSwitch || item.variant === 'rewind') return 'Z';
      if (item.variant === 'interrupted') return 'i';
      // A card either way; only a real error is a failure of its turn ('a': a warning, or words that only inform).
      if (item.variant === 'error') return noticeLevel(item) === 'error' ? 'e' : 'a';
      if (item.variant === 'command') return 'c';
      return 'n';
    case 'turn':
      return item.error ? 'F' : 'T';
    default:
      // A type a newer desktop sends that this phone does not know: one calm line in its place.
      return '?';
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
/** Always in view, in their place: command output, widgets and files, plans, and what the phone cannot draw (its line). */
const SHOW = new Set(['c', 'g', 'p', '?']);
/** What the agent does or says: outside any turn, it opens one of its own. */
const OWN = new Set(['w', 'h', 'k', 'l', 't', 'g', 'p']);
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

function buildSegment(raw: RawSeg, index: number, turnKey: string, failed: boolean, live = false, cut = false): Segment {
  const chars = settleLeads(raw.chars, live, raw.steered, !live && !failed && !cut);
  const errors: string[] = [];
  // A lead-in or a nod said in view after all (nothing followed it): never what the person waits for.
  const nod = (i: number) => chars[i] === 't' && raw.chars[i] === 'l';
  let answerAt = -1;
  // What stays in view of a failed segment's words (`last`).
  let lastAt = -1;
  if (live) {
    for (let i = chars.length - 1; i >= 0; i--) {
      if (ANSWER.has(chars[i])) {
        answerAt = i;
        break;
      }
      // While the segment runs, a text the agent has gone on from is a note along the way.
      if (chars[i] !== '.' && chars[i] !== 'i' && chars[i] !== 'e' && chars[i] !== 'a') break;
    }
  } else {
    // Settled, the answer is the last thing said that is not a lead-in or a nod; with nothing but
    // those, the last of them.
    let nodAt = -1;
    let textAt = -1;
    for (let i = chars.length - 1; i >= 0 && (answerAt < 0 || lastAt < 0); i--) {
      const ch = chars[i];
      if (!ANSWER.has(ch)) continue;
      if (ch === 't' && textAt < 0) textAt = i;
      if (nod(i)) {
        if (nodAt < 0) nodAt = i;
        continue;
      }
      if (answerAt < 0) answerAt = i;
      if (ch === 't' && lastAt < 0) lastAt = i;
    }
    if (answerAt < 0) answerAt = nodAt;
    if (lastAt < 0) lastAt = textAt;
  }
  // A failed segment answers with its error; a segment a steered message cut said its words on the way.
  if (failed || cut) answerAt = -1;
  if (!failed || cut || answerAt >= 0) lastAt = -1;
  const keptAt = answerAt >= 0 ? answerAt : lastAt;
  const tail = !live && keptAt >= 0 ? raw.ids.filter((_, i) => i > keptAt && chars[i] === 't') : [];
  // Nothing but notices (a /compact, a model change on its own): they are the turn, so they show.
  const lone = !chars.some((c) => c !== 'n' && c !== '.' && c !== 'i' && c !== 'e' && c !== 'a');
  let replyAt = -1;
  if (raw.steered) {
    const first = chars.indexOf('t');
    if (first >= 0 && first !== answerAt) replyAt = first;
  }
  const flow: FlowChunk[] = [];
  const work: string[] = [];
  let steps = 0;
  let run: string[] = [];
  let runCount = 0;
  // A checkpoint's identity (its `key`): its first item that is not a lead-in, so it stays the same
  // checkpoint when a lead-in that opened it is said in view once the turn settles.
  let runAt: string | null = null;
  let narr: string[] = [];
  let replied = !raw.steered;
  // A piece in view closes the run before it: one checkpoint.
  const close = () => {
    if (!run.length) return;
    flow.push({ kind: 'steps', key: runAt ?? run[0], ids: run, count: runCount });
    run = [];
    runCount = 0;
    runAt = null;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const id = raw.ids[i];
    if (ch === '.' || ch === 'i') continue;
    // An error, or a notice that is all the segment holds: shown where it happened. Only an error
    // counts as the failure shown (`errors`): a model change in view says nothing of what went wrong.
    if (ch === 'e' || ch === 'a' || (lone && ch === 'n')) {
      close();
      narr = [];
      if (ch === 'e') errors.push(id);
      flow.push({ kind: 'show', id });
      continue;
    }
    if (ch === 't' && !replied) {
      // The first words after a steered message are the reply to it: the pair reads as one, and a
      // step still under way when the message came goes on under the pair, in the run it began.
      replied = true;
      flow.unshift({ kind: 'text', id });
      continue;
    }
    if (ch === 't' || SHOW.has(ch)) {
      close();
      narr = [];
      flow.push({ kind: ch === 't' ? 'text' : 'show', id });
      continue;
    }
    if (ch === 'l') narr.push(id);
    work.push(id);
    run.push(id);
    if (runAt === null && raw.chars[i] !== 'l') runAt = id;
    if (ch === 'w') {
      steps++;
      runCount++;
    }
  }
  close();
  return {
    key: raw.lead ?? `${turnKey}:${index}`,
    lead: raw.lead,
    steered: raw.steered,
    work,
    flow,
    steps,
    answer: answerAt >= 0 ? raw.ids[answerAt] : null,
    reply: replyAt >= 0 ? raw.ids[replyAt] : null,
    last: lastAt >= 0 ? raw.ids[lastAt] : null,
    tail,
    notes: [],
    errors,
    narr,
  };
}

/** The last thing of substance a raw segment said (a text that is not a lead-in or a nod; with `any`, also command output or a plan), or -1. */
function lastSaid(raw: RawSeg, any: boolean): number {
  for (let i = raw.chars.length - 1; i >= 0; i--) if (any ? ANSWER.has(raw.chars[i]) : raw.chars[i] === 't') return i;
  return -1;
}

/** Whether `id` is something of substance the raw segment said (not a lead-in or a nod said in view). */
function said(raw: RawSeg, id: string | null, any: boolean): boolean {
  if (!id) return false;
  const i = raw.ids.indexOf(id);
  return i >= 0 && (any ? ANSWER.has(raw.chars[i]) : raw.chars[i] === 't');
}

/**
 * A settled turn keeps the last report it holds in view, across its segments: a report before a
 * steered message is never replaced by the nod that answered the steer. The report is the turn's
 * answer (after a failure, its last words over the error); the nod stays in view where it was
 * said: the reply to its message, or a quiet line under it.
 */
function keepReport(segments: Segment[], raws: RawSeg[], turnKey: string, failed: boolean) {
  const last = segments.length - 1;
  const end = segments[last];
  if (failed) {
    if (said(raws[last], end.last, false) || said(raws[last], end.answer, true)) return;
    for (let i = last - 1; i >= 0; i--) {
      const at = lastSaid(raws[i], false);
      if (at < 0) continue;
      segments[i] = { ...segments[i], last: raws[i].ids[at] };
      return;
    }
    return;
  }
  if (said(raws[last], end.answer, true)) return;
  for (let i = last - 1; i >= 0; i--) {
    if (lastSaid(raws[i], true) < 0) continue;
    segments[i] = buildSegment(raws[i], i, turnKey, false);
    const nod = end.answer;
    if (nod) {
      const first = end.flow[0];
      segments[last] =
        end.steered && !end.reply && first?.kind === 'text' && first.id === nod
          ? { ...end, answer: null, reply: nod }
          : { ...end, answer: null, tail: [nod, ...end.tail] };
    }
    return;
  }
}

/** Which texts of a turn fold with its work: every one not kept in view, when the turn has work at all. */
function foldNotes(segments: Segment[]) {
  if (!segments.some((s) => s.work.length > 0)) return;
  for (const s of segments) {
    for (const c of s.flow) if (c.kind === 'text' && c.id !== s.answer && c.id !== s.reply && c.id !== s.last && !s.tail.includes(c.id)) s.notes.push(c.id);
  }
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
 * message); steered messages and notifications taken mid-turn split it into segments. Work the
 * agent began with no message before it is a turn too, with no message at its head. `busy`: the
 * chat is working, so a turn left open at the end is the running one.
 */
export function groupTurns(ids: readonly string[], shape: string, busy: boolean, checkOf?: (id: string) => string | undefined): TurnLayout {
  const groups: Group[] = [];
  const queued: string[] = [];
  const checks: { id: string; at: number }[] = [];
  let open: Open | null = null;

  const close = (end: string | null, failedEnd: boolean, atEnd: boolean, closedBy?: 'line') => {
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
    if (state !== 'running') keepReport(segments, o.segs, key, state === 'failed');
    // A settled turn whose last segment said nothing (only steps after a steered message): the
    // newest segment that did say something answers it, so the turn keeps its answer and its foot.
    if ((state === 'done' || state === 'interrupted') && !segments.some((sg) => sg.answer)) {
      for (let i = last - 1; i >= 0; i--) {
        const seg = buildSegment(o.segs[i], i, key, false);
        if (!seg.answer) continue;
        segments[i] = seg;
        break;
      }
    }
    foldNotes(segments);
    const early = endedEarly(state, end, o.segs[last].chars, closedBy);
    groups.push({ kind: 'turn', key, segments, end, state, ids: o.ids, ...(early ? { early } : {}) });
  };

  const start = (id: string, steered: boolean, quiet = false) => {
    open = { ids: [id], segs: [{ lead: id, steered, ids: [], chars: [] }], interrupted: false, failed: false, ...(quiet ? { quiet } : {}) };
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
        start(id, false, true);
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
      start(id, false);
      continue;
    }
    // A check runs beside the conversation: it never joins (or ends) the turn around it.
    if (ch === 'x') {
      checks.push({ id, at: groups.length });
      continue;
    }
    if (ch === 'U' || (ch === 'S' && !open)) {
      close(null, false, false);
      start(id, ch === 'S');
      continue;
    }
    if (ch === 'Z') {
      close(null, false, false, 'line');
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
      // Some providers write "Interrupted" after the turn record: it still belongs to that turn.
      if (ch === 'i' && prev?.kind === 'turn' && prev.state !== 'running') {
        prev.state = prev.state === 'failed' ? 'failed' : 'interrupted';
        prev.ids.push(id);
        continue;
      }
      if (!OWN.has(ch)) {
        if (ch !== '.') groups.push({ kind: 'item', key: id, id });
        continue;
      }
      // The agent's own work with no message before it (a wake-up, a page that starts inside a
      // turn): a turn of its own, with no message at its head.
      open = { ids: [], segs: [{ lead: null, steered: false, ids: [], chars: [] }], interrupted: false, failed: false };
    }
    const o: Open = open;
    // An interrupted turn has ended even without its record: a notice after it stands on its own.
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

const chunkSig = (c: FlowChunk) => (c.kind === 'steps' ? `${c.key}+${c.ids.length}+${c.count}` : c.id);
const segSig = (s: Segment) => `${s.lead}>${s.flow.map(chunkSig).join(',')}>${s.reply}>${s.answer}>${s.last}>${s.tail.join(',')}>${s.notes.length}>${s.errors.join(',')}>${s.narr.join(',')}`;
const turnSig = (g: TurnGroup) => `${g.state}|${g.end}|${g.ids.length}|${g.checks?.join(',') ?? ''}|${g.segments.map(segSig).join(';')}`;

/**
 * Keeps the objects of turns, segments and runs of steps that did not change since the last
 * layout, so their memoized views skip rendering: a new step in the running turn renders that turn
 * and its live run, not the checkpoints it closed before.
 */
export function stabilize(next: TurnLayout, prev: Map<string, unknown>): TurnLayout {
  const seen = new Map<string, unknown>();
  const keepChunk = (c: FlowChunk): FlowChunk => {
    if (c.kind !== 'steps') return c;
    const k = `c|${c.key}`;
    const old = (seen.get(k) ?? prev.get(k)) as StepsChunk | undefined;
    const same = old && old.count === c.count && old.ids.length === c.ids.length && old.ids[old.ids.length - 1] === c.ids[c.ids.length - 1];
    const chunk = same ? old : c;
    seen.set(k, chunk);
    return chunk;
  };
  const keepSeg = (s: Segment) => {
    for (const c of s.flow) if (c.kind === 'steps') seen.set(`c|${c.key}`, c);
  };
  const groups = next.groups.map((g): Group => {
    if (g.kind !== 'turn') return g;
    const k = `t|${turnSig(g)}`;
    const old = prev.get(k) as TurnGroup | undefined;
    if (old) {
      seen.set(k, old);
      for (const s of old.segments) {
        seen.set(`s|${segSig(s)}`, s);
        keepSeg(s);
      }
      return old;
    }
    const segments = g.segments.map((s) => {
      const sk = `s|${segSig(s)}`;
      const os = (prev.get(sk) ?? seen.get(sk)) as Segment | undefined;
      const seg = os ?? { ...s, flow: s.flow.map(keepChunk) };
      if (os) keepSeg(os);
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

/** "2 sub-agents working": a chat's background work in words (`SessionMeta.background`), as the desktop says it. */
export const backgroundLabel = (n: number) => `${n} ${n === 1 ? 'sub-agent' : 'sub-agents'} working`;
