import type { TimelineItem } from '@shared/protocol';
import { noticeLevel } from '@shared/notice';
import { isNobodysWords, syntheticOf } from '@shared/synthetic';
import { changedSince, type ItemsRevision } from '@/state/revision';
import { isLeadIn } from './lead-in';

/**
 * Turn structure for the conversation: which root items belong to which turn, how each segment
 * reads, and what folds away as the work behind it. Pure and string-driven, so the view
 * recomputes it only when the shape of the timeline changes, never on a streamed word.
 *
 * A turn is a sequence of checkpoints: a run of work (steps, thinking, task updates, lead-ins)
 * closed by something in view (a note the agent wrote, a widget, files, a plan, an error). While the
 * turn runs each closed checkpoint reads as its work line and its note, and the live line stands
 * under the newest; once it has ended the turn is one line and what never folds (see `Segment`).
 *
 * Each root item is reduced to one character (`shapeOf`):
 *   U  a sent message that starts a turn       Q  a queued message, not taken yet (floats to the end)
 *   S  a message steered into the running turn  t  assistant prose (an answer candidate)
 *   N  a notification the agent's harness wrote in the person's place (a background task finished, a
 *      message from another session; `shared/synthetic.ts`), shown as a line: it opens a turn, or
 *      inside a running one a segment of its own, as a steered message does
 *   u  such a message with nothing to show (a reminder, a caveat): between turns it opens one, so
 *      the work after it folds as a turn's; a turn with nothing else in it is not shown
 *      (a slash command opens a turn as a message does, `U`; what it printed is command output, `c`)
 *   l  a lead-in: a one-line announcement of the next step ("Let me run the tests."), or a text
 *      still being written that may turn out one (see `lead-in.ts`): folded with the steps it
 *      announces, said in view when no step follows it, and never the answer of a turn that said more
 *   c  command output (an answer candidate): a command notice, or what a command printed written in
 *      the person's place (`<local-command-stdout>` / `-stderr>`, `!` output)
 *                                               p  a plan (an answer candidate)
 *   w  a step: a tool call                      n  any other notice (mode, model, compaction, retry): not a step
 *   h  thinking: part of the work, not counted as a step
 *   k  a task list update: kept in the work, not counted as a step (the dock shows the list)
 *   i  "Interrupted"                            e  an error notice
 *   T  turn end                                 F  turn end with an error
 *   g  a widget (generative UI): never folded, shown in its place
 *   f  files the agent hands over (SendUserFile): their cards, never folded, shown in their place
 *   Z  an until loop's end line, a switch of agent, a rewind's result: closes a turn left open (an
 *      interrupted one, the kept part of a rewound one), stands on its own
 *   x  a check of a turn by the other agent: never part of a turn, shown under the turn it checks
 *   .  nothing to show (an empty, finished text)
 */

/**
 * One piece of a segment, in the order it happened:
 * - `text`: something the agent said: a note along the way (it closes a checkpoint, and folds with
 *   the work once the turn has ended: `Segment.notes`), the reply to a steered message, the answer;
 * - `show`: what never folds: command output, a widget, files handed over, a plan, an error notice;
 * - `steps`: a run of work between them (tool calls, thinking, task updates, notices, lead-ins): one
 *   checkpoint's work, behind its own line (`count`: its tool calls).
 */
export type FlowChunk = { kind: 'text'; id: string } | { kind: 'show'; id: string } | StepsChunk;
export interface StepsChunk {
  kind: 'steps';
  key: string;
  ids: string[];
  count: number;
}

export interface Segment {
  key: string;
  /** The message that opened this segment (the turn's own message, or one steered into it). */
  lead: string | null;
  steered: boolean;
  /** Every item of the segment's work, in order (the ids of the `steps` chunks). */
  work: string[];
  /**
   * The segment in the order it happened: runs of work, and what closed each (a text, something
   * shown). A steered segment starts with the reply to its message, whatever ran before it came.
   * While the turn runs every run reads as a line of its own with its closer under it, and the
   * live line stands at the end. Once the turn has ended one line stands where its first folded
   * piece stood (the first run, or a note before it) and holds every run and every note of every
   * segment; what never folds keeps its place after it, in order: things shown, a steered message
   * and its reply, the answer.
   */
  flow: FlowChunk[];
  /** Tool calls in `work` (thinking, task updates and notices are not steps). */
  steps: number;
  /**
   * The answer, never folded: the last thing said in this segment that is not a lead-in or a nod
   * ("Committed.", "Done.", an announcement nothing followed). With nothing but those, the last one.
   */
  answer: string | null;
  /** A steered segment's first words, when more followed: the direct reply, never folded. */
  reply: string | null;
  /** The last words before a failure, when the segment has no answer: they stay in view over the error. */
  last: string | null;
  /** What was said after the answer (or after those last words): a nod, in view under it as a quiet last line. */
  tail: string[];
  /**
   * The texts that fold with the work once the turn has ended: the notes along the way (every text
   * but the answer, a nod after it, the reply and the last words before a failure). Empty in a turn
   * with no work at all: with nothing to fold behind, its texts simply stand.
   */
  notes: string[];
  /**
   * The error notices shown in the flow: the failure is in view, so the turn's foot does not say it
   * again. Notices that are all a segment holds (a /compact, a model change) stand in the flow as
   * shown pieces too, but are not errors: a turn that then fails still says why.
   */
  errors: string[];
  /** The lead-ins folded into the work since the last piece in view, oldest first: the live line names the newest. */
  narr: string[];
}

export type TurnState = 'running' | 'done' | 'failed' | 'interrupted';

export interface TurnGroup {
  kind: 'turn';
  key: string;
  segments: Segment[];
  /** The closing turn item, when the provider wrote one. */
  end: string | null;
  state: TurnState;
  /** Every root id in the turn, in order (for copy, previews and reveal). */
  ids: string[];
  /** Checks of this turn by the other agent ("Check with Codex"), shown under it, oldest first. */
  checks?: string[];
  /**
   * The turn ended before the agent finished (`endedEarly`): no record of its end came, and its last
   * act was work (a step, thinking, a task update) with nothing said after it. Only a settled turn.
   */
  early?: true;
}

/** What may stand after a turn's last act without saying anything: empty texts, notices, a warning's card. */
const AFTER_LAST = new Set(['.', 'n', 'a']);
/** Acts that leave something to say: a turn whose last act was one of these had more to do. */
const UNFINISHED = new Set(['w', 'h', 'k']);

/**
 * Whether a settled turn ended before the agent finished, from what its provider wrote: no turn
 * record closed it (Claude Code writes one for every turn it finishes, Codex one for every turn it
 * ends, also an interrupted or failed one), it was not stopped and did not fail (those say so
 * themselves), and its last act was work with nothing said after it (cut after a step, or while
 * thinking). `closedBy`: what closed it, when not the next message or the end of the timeline.
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
  /** Queued messages, shown after everything else until the agent takes them. */
  queued: string[];
}

export function shapeOf(item: TimelineItem | undefined): string {
  if (!item) return '.';
  switch (item.type) {
    case 'user': {
      if (item.steered) return 'S';
      if (item.state === 'queued') return 'Q';
      const syn = syntheticOf(item);
      if (!syn) return 'U';
      // What a command printed (`<local-command-stdout>`, `<local-command-stderr>`, a `!` command's
      // output) is command output, as a command notice is: never folded. A compaction summary is a notice.
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
      return item.kind === 'plan' ? 'p' : item.kind === 'widget' ? 'g' : item.kind === 'share' ? 'f' : item.kind === 'todo' ? 'k' : 'w';
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
      return '.';
  }
}

/**
 * The shape of a session's roots (one `shapeOf` character per root), followed write by write: a
 * write re-reads only the items it changed (`changedSince`), roots that grew at their end add their
 * new characters, and anything else (a new timeline, a removed root, a write it did not see) reads
 * every root again. The result is always the string `roots.map((id) => shapeOf(items[id])).join('')`.
 */
export function shapeIndex() {
  let ids: readonly string[] = [];
  let items: object | null = null;
  let rev = -1;
  let chars: string[] = [];
  let pos = new Map<string, number>();
  let out = '';
  return (d: (ItemsRevision & { items: Record<string, TimelineItem | undefined> }) | undefined, roots: readonly string[]): string => {
    if (!d) {
      items = null;
      return '';
    }
    if (d.items === items && d.rev === rev && roots === ids) return out;
    const changed = d.items === items ? changedSince(d, rev) : null;
    const n = ids.length;
    // Roots change only by joining at the end or leaving: the old last root still in its place
    // means nothing before it left (as `grow` in the Agents tab reads it).
    const grew = roots === ids || (roots.length >= n && (n === 0 || (roots[0] === ids[0] && roots[n - 1] === ids[n - 1])));
    // A root the bridge moved (a message the agent took) is a changed item no longer at its place.
    // Two taken in one write leave the first and last root where they were, so the ends alone do not say.
    const moved =
      !!changed &&
      roots !== ids &&
      changed.some((id) => {
        const i = pos.get(id);
        return i !== undefined && roots[i] !== id;
      });
    if (!changed || !grew || moved) {
      chars = new Array<string>(roots.length);
      pos = new Map();
      for (let i = 0; i < roots.length; i++) {
        chars[i] = shapeOf(d.items[roots[i]]);
        pos.set(roots[i], i);
      }
      out = chars.join('');
    } else {
      let edited = false;
      for (const id of changed) {
        const i = pos.get(id);
        if (i === undefined) continue;
        const c = shapeOf(d.items[id]);
        if (c === chars[i]) continue;
        chars[i] = c;
        edited = true;
      }
      let tail = '';
      for (let i = n; i < roots.length; i++) {
        const c = shapeOf(d.items[roots[i]]);
        chars.push(c);
        pos.set(roots[i], i);
        tail += c;
      }
      if (edited) out = chars.join('');
      else if (tail) out += tail;
    }
    items = d.items;
    rev = d.rev;
    ids = roots;
    return out;
  };
}

const ANSWER = new Set(['t', 'c', 'p']);
/** Always in view, in their place: command output, widgets, files handed over, plans. */
const SHOW = new Set(['c', 'g', 'f', 'p']);

interface Open {
  ids: string[];
  chars: string[];
  segs: { lead: string | null; steered: boolean; ids: string[]; chars: string[] }[];
  interrupted: boolean;
  failed: boolean;
  /** Opened by a message with nothing to show (`u`): left out when nothing else comes in it. */
  quiet?: boolean;
}

/** What the agent does or says: outside any turn, it opens one of its own (see `groupFrom`). */
const OWN = new Set(['w', 'h', 'k', 'l', 't', 'g', 'f', 'p']);

/** What may follow a lead-in for it to fold with the work it announces. */
const WORK_AFTER = new Set(['w', 'h', 'k', 'n', 'l']);
/** What the bridge or the agent may write after its last words without doing more work: notices, task list updates, thinking. */
const QUIET_AFTER = new Set(['.', 'n', 'k', 'h']);

/**
 * The segment's characters with each lead-in settled: it stays one (`l`, folded with the work) when
 * a step follows it, or while it is the newest thing in a running segment; otherwise it is said in
 * view after all (`t`): before more text, as the answer of a settled segment (also when only a
 * notice or a task list update came after it, as the bridge writes at a turn's end), and always as
 * the reply to a steered message.
 * `final`: a settled segment that answers (not failed, not cut by a steer). With nothing else said
 * in it, its last lead-in is its answer after all ("Let me fix the typo." then the edit): the turn
 * keeps an answer to copy, fork from and check.
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

function buildSegment(raw: Open['segs'][number], index: number, turnKey: string, failed: boolean, live = false, cut = false): Segment {
  const seg = { ...raw, chars: settleLeads(raw.chars, live, raw.steered, !live && !failed && !cut) };
  const errors: string[] = [];
  // A lead-in or a nod that is said in view after all (nothing followed it): never what the person waits for.
  const nod = (i: number) => seg.chars[i] === 't' && raw.chars[i] === 'l';
  let answerAt = -1;
  // What stays in view of a failed segment's words (`last`).
  let lastAt = -1;
  if (live) {
    for (let i = seg.chars.length - 1; i >= 0; i--) {
      if (ANSWER.has(seg.chars[i])) {
        answerAt = i;
        break;
      }
      // While the segment runs, a text the agent has gone on from is a report along the way: it is
      // the answer only while nothing has come after it.
      if (seg.chars[i] !== '.' && seg.chars[i] !== 'i' && seg.chars[i] !== 'e' && seg.chars[i] !== 'a') break;
    }
  } else {
    // Settled, the answer is the last thing said that is not a lead-in or a nod: a report stays the
    // answer when "Committed." or "Done." follows it, with steps between or without. A turn that
    // said nothing but those answers with the last of them.
    let nodAt = -1;
    let textAt = -1;
    for (let i = seg.chars.length - 1; i >= 0 && (answerAt < 0 || lastAt < 0); i--) {
      const ch = seg.chars[i];
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
  // A failed segment answers with its error card; its last text is one more report. So does a
  // segment a steered message cut: the turn went on past it, and its last words were said on the
  // way (they keep their tone when the steer arrives instead of brightening into an answer).
  if (failed || cut) answerAt = -1;
  if (!failed || cut || answerAt >= 0) lastAt = -1;
  // What was said after the piece that stays: nods, by the rule above.
  const keptAt = answerAt >= 0 ? answerAt : lastAt;
  const tail = !live && keptAt >= 0 ? seg.ids.filter((_, i) => i > keptAt && seg.chars[i] === 't') : [];
  // Nothing but notices (a /compact, a model change on its own): they are the turn, so they show.
  const lone = !seg.chars.some((c) => c !== 'n' && c !== '.' && c !== 'i' && c !== 'e' && c !== 'a');
  let replyAt = -1;
  if (seg.steered) {
    const first = seg.chars.indexOf('t');
    if (first >= 0 && first !== answerAt) replyAt = first;
  }
  const flow: FlowChunk[] = [];
  const work: string[] = [];
  let steps = 0;
  let run: string[] = [];
  let runCount = 0;
  /**
   * A checkpoint's identity (its `key`, what its open state is kept under): its first item that is
   * not a lead-in. A lead-in that opens a run may be said in view once the turn settles (it becomes
   * the answer), and the run must stay the same checkpoint when it does.
   */
  let runAt: string | null = null;
  let narr: string[] = [];
  // The reply to a steered message stands right under it: see below.
  let replied = !seg.steered;
  // A piece in view closes the run before it: one checkpoint.
  const close = () => {
    if (!run.length) return;
    flow.push({ kind: 'steps', key: runAt ?? run[0], ids: run, count: runCount });
    run = [];
    runCount = 0;
    runAt = null;
  };
  for (let i = 0; i < seg.chars.length; i++) {
    const ch = seg.chars[i];
    const id = seg.ids[i];
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
      // The first words after a steered message are the reply to it: the pair reads as one, the
      // reply right under the message. A step that was still under way when the message came
      // does not stand between them: that work goes on under the pair, in the run it began.
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
  const answer = answerAt >= 0 ? seg.ids[answerAt] : null;
  const reply = replyAt >= 0 ? seg.ids[replyAt] : null;
  // A failed segment has no answer: the last thing of substance the agent said stays in view, over the error.
  const last = lastAt >= 0 ? seg.ids[lastAt] : null;
  return {
    key: seg.lead ?? `${turnKey}:${index}`,
    lead: seg.lead,
    steered: seg.steered,
    work,
    flow,
    steps,
    answer,
    reply,
    last,
    tail,
    // Set for the whole turn once its segments are known (`foldNotes`).
    notes: [],
    errors,
    narr,
  };
}

/** The last thing of substance a raw segment said (a text that is not a lead-in or a nod; with `any`, also command output or a plan), or -1. */
function lastSaid(raw: Open['segs'][number], any: boolean): number {
  for (let i = raw.chars.length - 1; i >= 0; i--) if (any ? ANSWER.has(raw.chars[i]) : raw.chars[i] === 't') return i;
  return -1;
}

/** Whether `id` is something of substance the raw segment said (not a lead-in or a nod said in view). */
function said(raw: Open['segs'][number], id: string | null, any: boolean): boolean {
  if (!id) return false;
  const i = raw.ids.indexOf(id);
  return i >= 0 && (any ? ANSWER.has(raw.chars[i]) : raw.chars[i] === 't');
}

/**
 * A settled turn keeps the last report it holds in view, across its segments: a report before a
 * steered message is never replaced by the nod that answered the steer ("The migration requires
 * index X." then "Commit it" and "Committed."). The report is the turn's answer (or, after a
 * failure, its last words over the error); the nod stays in view where it was said: the reply to
 * its message, or a quiet line under it.
 */
function keepReport(segments: Segment[], raws: Open['segs'], turnKey: string, failed: boolean) {
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
    // Built again as a settled segment: its answer is its last report, nods after it its tail.
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

/** Which texts of a turn fold with its work (`Segment.notes`): every one that is not kept in view, when the turn has work at all. */
function foldNotes(segments: Segment[]) {
  if (!segments.some((s) => s.work.length > 0)) return;
  for (const s of segments) {
    for (const c of s.flow) if (c.kind === 'text' && c.id !== s.answer && c.id !== s.reply && c.id !== s.last && !s.tail.includes(c.id)) s.notes.push(c.id);
  }
}

/**
 * Groups root items into turns. A turn runs from a sent message to its closing turn item; when
 * there is none (an interrupted turn, history from a provider that keeps no turn records), the
 * next sent message closes it. Messages steered into a turn split it into segments, each with
 * its own answer, so a question asked mid-turn gets its reply right under it. Work the agent began
 * with no message before it is a turn too, with no message at its head. Notices outside any turn
 * (a mode change between turns, one before the first message) stay single items.
 * `busy`: the session is working, so a turn left open at the end is the running one.
 * `checkOf`: the turn a check (`x`) belongs to (its first message); a check goes under that turn,
 * wherever it sits in the timeline, or stands on its own where it is when that turn is gone.
 */
export function groupTurns(ids: readonly string[], shape: string, busy: boolean, checkOf?: (id: string) => string | undefined): TurnLayout {
  const g: Grouping = { groups: [], queued: [], checks: [] };
  groupFrom(g, ids, shape, busy, 0);
  return { groups: withChecks(g.groups, g.checks, checkOf), queued: g.queued };
}

/** What grouping has gathered so far; a check's `at` is how many groups stood before it. */
interface Grouping {
  groups: Group[];
  queued: string[];
  checks: { id: string; at: number }[];
}

/** A sent message with nothing open before it: everything grouped before it is final (see `turnsIndex`). */
interface Cut {
  at: number;
  groups: number;
  queued: number;
  checks: number;
}

/**
 * Groups `ids[from..]` onto `g`, which holds the grouping of `ids[..from)` with nothing open at
 * `from` (so `from` is 0 or a cut). Notes each sent message in `cuts`, with what stood before it.
 */
function groupFrom(g: Grouping, ids: readonly string[], shape: string, busy: boolean, from: number, cuts?: Cut[]) {
  const { groups, queued, checks } = g;
  let open: Open | null = null;

  const close = (end: string | null, failedEnd: boolean, atEnd: boolean, closedBy?: 'line') => {
    if (!open) return;
    const o = open;
    open = null;
    if (end) o.ids.push(end);
    const failed = failedEnd || o.failed;
    const state: TurnState = atEnd && !end && busy && !o.interrupted ? 'running' : failed ? 'failed' : o.interrupted ? 'interrupted' : 'done';
    // A reminder or a caveat with nothing after it (a caveat before a command): nothing to show.
    if (o.quiet && state !== 'running' && o.segs.length === 1 && o.segs[0].chars.every((c) => c === '.')) return;
    const key = o.ids[0];
    const last = o.segs.length - 1;
    const segments = o.segs.map((s, i) => buildSegment(s, i, key, failed && i === last, state === 'running' && i === last, i < last));
    if (state !== 'running') keepReport(segments, o.segs, key, state === 'failed');
    // A settled turn whose last segment said nothing (only steps after a steered message): the
    // newest segment that did say something answers it, so the turn keeps its answer and its foot.
    if ((state === 'done' || state === 'interrupted') && !segments.some((s) => s.answer)) {
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
    open = { ids: [id], chars: [], segs: [{ lead: id, steered, ids: [], chars: [] }], interrupted: false, failed: false, ...(quiet ? { quiet } : {}) };
  };

  for (let i = from; i < ids.length; i++) {
    const id = ids[i];
    let ch = shape[i] ?? '.';
    if (ch === 'Q') {
      queued.push(id);
      continue;
    }
    // A message with nothing to show: nothing at all inside a turn; between turns it opens one, so
    // the agent's work after it reads as a turn.
    if (ch === 'u') {
      if (open) ch = '.';
      else {
        start(id, false, true);
        continue;
      }
    }
    // A notification: the agent takes it at its next step, so in a running turn it opens a segment
    // of its own (as a steered message does); otherwise it opens a turn.
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
      // Nothing is open here and nothing after this point reaches back before it (an "Interrupted"
      // only joins a turn closed right before it, and this message opens one).
      if (ch === 'U') cuts?.push({ at: i, groups: groups.length, queued: queued.length, checks: checks.length });
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
        groups.push({ kind: 'item', key: id, id });
        continue;
      }
      // The agent's own work with no message before it (a turn it began by itself: a wake-up, the
      // turn of a second notification after the end of the first one's): a turn of its own, with no
      // message at its head. Left outside a turn, every step and thought stood as a row of its own.
      open = { ids: [], chars: [], segs: [{ lead: null, steered: false, ids: [], chars: [] }], interrupted: false, failed: false };
    }
    // An interrupted turn has ended even without its record: a notice after it (a lane landed, a
    // model changed) stands on its own instead of folding into that turn's work and its time.
    if (ch === 'n' && (open as Open).interrupted) {
      close(null, false, false);
      groups.push({ kind: 'item', key: id, id });
      continue;
    }
    const o: Open = open;
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
    // The agent recovered and went on to say something: the error was not the end.
    else if (ANSWER.has(ch)) o.failed = false;
  }
  close(null, false, true);
}

const textOf = (it: TimelineItem | undefined) => (it?.type === 'text' && !isNobodysWords(it.text) ? it.text.trim() : '');

/**
 * The words of what a turn can show as its answer (`ANSWER`): a text as written, a plan as its
 * card shows it, command output as printed (a command notice's output, else its line; what a
 * command printed in the person's place, every part of it). '' for anything else.
 */
export function answerText(it: TimelineItem | undefined): string {
  if (!it) return '';
  switch (it.type) {
    case 'text':
      return it.text.trim();
    case 'tool':
      if (it.kind !== 'plan') return '';
      return (it.detail.plan ?? (typeof (it.input as { plan?: unknown } | undefined)?.plan === 'string' ? (it.input as { plan: string }).plan : '')).trim();
    case 'notice':
      return it.variant === 'command' ? (it.detail?.trim() || it.text.trim()) : '';
    case 'user': {
      const syn = syntheticOf(it);
      if (syn?.role !== 'output') return '';
      return syn.parts
        .flatMap((p) => (p.kind === 'output' ? [p.text.trim()] : []))
        .filter(Boolean)
        .join('\n\n');
    }
    default:
      return '';
  }
}

/** What a copy of a turn's response holds: the answers of every segment (whatever kind each is), or failing that every text. */
export function responseText(items: Record<string, TimelineItem | undefined>, turn: TurnGroup): string {
  const answers = turn.segments.map((s) => answerText(s.answer ? items[s.answer] : undefined)).filter(Boolean);
  if (answers.length) return answers.join('\n\n');
  return turn.ids
    .map((id) => textOf(items[id]))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * What `/copy` copies: the response of the newest settled turn, the same text as that turn's
 * "Copy response" (`responseText`), or null when it has none (or no turn has settled yet). It never
 * reaches past that turn: an older turn's answer is not the last answer.
 */
export function lastResponse(items: Record<string, TimelineItem | undefined>, roots: readonly string[], busy: boolean): string | null {
  const shape = roots.map((id) => shapeOf(items[id])).join('');
  const { groups } = groupTurns(roots, shape, busy);
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.kind !== 'turn' || g.state === 'running') continue;
    return responseText(items, g) || null;
  }
  return null;
}

/**
 * The groups with their checks: under the turn each checks (a copy of that turn, so the groups
 * passed in are left as they are), or on their own where they stand when that turn is gone.
 */
function withChecks(groups: Group[], checks: Grouping['checks'], checkOf?: (id: string) => string | undefined): Group[] {
  const out = groups.slice();
  if (!checks.length) return out;
  const turns = new Map<string, number>();
  for (let i = 0; i < out.length; i++) if (out[i].kind === 'turn') turns.set(out[i].key, i);
  const loose: { id: string; at: number }[] = [];
  for (const c of checks) {
    const at = turns.get(checkOf?.(c.id) ?? '');
    if (at === undefined) {
      loose.push(c);
      continue;
    }
    const turn = out[at] as TurnGroup;
    out[at] = { ...turn, checks: [...(turn.checks ?? []), c.id] };
  }
  // From the end, so the places counted before stay right.
  for (let i = loose.length - 1; i >= 0; i--) out.splice(loose[i].at, 0, { kind: 'item', key: loose[i].id, id: loose[i].id });
  return out;
}

/**
 * `groupTurns`, followed run by run (one per TurnList): the groups before the last sent message
 * that the timeline has not changed since the last run are kept as they are (the same objects),
 * and only what follows it is grouped again. A step joining a running turn regroups that turn,
 * not the whole conversation. Always equal to `groupTurns` of the same arguments.
 */
export function turnsIndex() {
  let ids: readonly string[] = [];
  let shape = '';
  let g: Grouping = { groups: [], queued: [], checks: [] };
  let cuts: Cut[] = [];
  return (nextIds: readonly string[], nextShape: string, busy: boolean, checkOf?: (id: string) => string | undefined): TurnLayout => {
    // The first place this timeline differs from the last one grouped.
    const n = Math.min(ids.length, nextIds.length);
    let d = 0;
    while (d < n && ids[d] === nextIds[d] && (shape[d] ?? '.') === (nextShape[d] ?? '.')) d++;
    // The last cut before it: grouping starts again there (the cut itself is noted again).
    let k = cuts.length - 1;
    while (k >= 0 && cuts[k].at >= d) k--;
    if (k >= 0) {
      const cut = cuts[k];
      g.groups.length = cut.groups;
      g.queued.length = cut.queued;
      g.checks.length = cut.checks;
      cuts.length = k;
      groupFrom(g, nextIds, nextShape, busy, cut.at, cuts);
    } else {
      g = { groups: [], queued: [], checks: [] };
      cuts = [];
      groupFrom(g, nextIds, nextShape, busy, 0, cuts);
    }
    ids = nextIds;
    shape = nextShape;
    return { groups: withChecks(g.groups, g.checks, checkOf), queued: g.queued.slice() };
  };
}
