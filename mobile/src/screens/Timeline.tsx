import { AnimatePresence, motion } from 'motion/react';
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NoticeItem, PhoneItem, ProviderId, TextItem, ThinkingItem, TimelineItem, ToolItem, TurnItem, UntilCheck, UserItem } from '@shared/protocol';
import { noticeLevel } from '@shared/notice';
import { stripWrappers, syntheticOf } from '@shared/synthetic';
import { formatDuration, formatTokens, plural, resetIn } from '@desk/lib/format';
import { leadTitle } from '@desk/features/timeline/lead-in';
import { useNow } from '@m/lib/useNow';
import { cancelDownload, downloadKey, installable, openDownload, startDownload, useDownload } from '@m/lib/downloads';
import { PLAIN_OFF } from '@m/lib/download-core';
import { canonicalName, isPackageName } from '@shared/file-name';
import { conn } from '@m/lib/conn';
import { diffLines, renderMarkdown, settledCut } from '@m/lib/md';
import { haptic, openExternal } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { putDraft } from '@m/lib/put-draft';
import { readReview, type PhoneReview } from '@m/lib/review';
import { applyChildren, applyFull, fetchItem, getState, sessionData, setState, useStore, type State } from '@m/lib/store';
import { claimFlight } from '@m/lib/flight';
import { checkOpener, foldTarget, limitAction, limitProvider, showKind, turnChanges } from '@m/lib/chat-rules';
import { foldKey, keepDetail, keepOpen, keptDetail, stepKey, wasOpen } from '@m/lib/folds';
import { useChanges } from '@m/lib/changes';
import { runSpan, turnSpan, type Segment, type StepsChunk, type TurnGroup } from '@m/lib/turns';
import { hasWork } from '@shared/work-label';
import { Icon, TOOL_ICON, type IconName } from '@m/ui/icons';
import { FileGlyph, kindName } from '@m/ui/FileGlyph';
import { PROVIDER_NAME, ProviderMark, Ring, StatusMark, Tiles } from '@m/ui/marks';
import { REVEAL, reduced } from '@m/ui/motion';
import { keptPic, loadPic } from '@m/lib/pics';
import { useThumb } from '@m/lib/thumbs';
import { openViewer, viewerLoaded } from '@m/ui/Viewer';
import { holdMessage } from './MessageMenu';
import { SynLine } from './Synthetic';

const useItem = <T extends TimelineItem>(sid: string, id: string | null | undefined) => useStore((s) => (id ? (sessionData(s, sid).items[id] as T | undefined) : undefined));

/** "8s", "1m 12s": whole seconds, as the desktop's work line says them. */
function shortDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A reasoning summary's own heading ("**Checking the store**"): what the thinking is about. */
function thinkingHeadline(text: string): string {
  const tail = text.length > 3000 ? text.slice(-3000) : text;
  const re = /(?:^|\n)\s*\*\*([^*\n]{3,80})\*\*\s*(?:\n|$)/g;
  let last = '';
  for (let m = re.exec(tail); m; m = re.exec(tail)) last = m[1].trim();
  return last;
}

/** Holds each value at least `ms`: quick steps in a row read as a calm sequence of titles, not a flicker. */
function useHeld<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const at = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const show = () => {
      at.current = performance.now();
      setShown(value);
    };
    const wait = at.current + ms - performance.now();
    if (wait <= 0) return show();
    const t = window.setTimeout(show, wait);
    return () => window.clearTimeout(t);
  }, [value, shown, ms]);
  return shown;
}

/** The time, once a second while `active`. */
function useSecond(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/**
 * One turn, as the desktop reads it (src/features/timeline/TurnView.tsx), at hand size: a sequence
 * of checkpoints. While it runs, each closed checkpoint is two lines (its work, folded: "Worked 45s ·
 * 5 steps", and the note that closed it) and the live line stands under the newest; no step rows.
 * Once it has ended everything gathers into one line ("Worked 15m 52s · 36 steps", the change) with
 * what never folds after it, in order: things shown, a steered message with its reply, the answer.
 * The line opens the checkpoints one level in, each opening to its own steps; a turn with one run
 * opens straight to its steps.
 *
 * The end is one calm motion (transform and opacity only): the pieces that fold fade, then fold at
 * once, and what stays glides from where it stood to its new place (FLIP), the reader's place kept:
 * at the newest the answer stays where it is, scrolled up the first thing in view that stays.
 */
export const TurnView = memo(function TurnView({ sid, turn, newest, reveal }: { sid: string; turn: TurnGroup; newest?: boolean; reveal?: string }) {
  const running = turn.state === 'running';
  // What was opened is remembered per turn and per checkpoint (lib/folds.ts).
  const turnFold = foldKey(sid, turn.key);
  const [open, setOpen] = useState(() => wasOpen(turnFold));
  useEffect(() => keepOpen(turnFold, open), [turnFold, open]);
  // Asked to show an item it holds (a search hit): the folds around it open, the line and its checkpoint.
  const target = useMemo(() => (reveal ? foldTarget(turn, reveal) : null), [turn, reveal]);
  useLayoutEffect(() => {
    if (target?.fold && !running) setOpen(true);
  }, [target, running]);
  // 'live' laid out as while it ran; 'closing' the same, the pieces that fold fading; 'settled' folded.
  const [phase, setPhase] = useState<'live' | 'closing' | 'settled'>(running ? 'live' : 'settled');
  const laidLive = running || phase !== 'settled';
  const box = useRef<HTMLElement>(null);
  const snap = useRef<Snap | null>(null);
  const { pieces, multi, head } = useMemo(() => piecesOf(turn), [turn]);

  // The fade before the gather: its own timer, not tied to the phase it starts (a phase change must not cancel it).
  const leave = useRef(0);
  useEffect(() => () => window.clearTimeout(leave.current), []);
  // The turn's height while it ran: when it ends, the live line under the answer goes at once, and
  // a reader at the newest (the view pinned to the bottom) would see the answer drop by that much in
  // one frame. The turn keeps that height until it gathers (the gather keeps the answer in place).
  // (The answer grows the turn without rendering it again: its size is followed while it runs.)
  const ranH = useRef(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!running || !el) return;
    ranH.current = el.offsetHeight;
    const ro = new ResizeObserver(() => (ranH.current = el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [running]);
  useLayoutEffect(() => {
    if (running) {
      window.clearTimeout(leave.current);
      if (box.current) box.current.style.minHeight = '';
      if (phase !== 'live') setPhase('live');
      return;
    }
    if (phase !== 'live') return;
    if (reduced() || !head) return setPhase('settled');
    if (box.current && ranH.current) box.current.style.minHeight = `${ranH.current}px`;
    setPhase('closing');
    leave.current = window.setTimeout(() => {
      snap.current = box.current ? snapshot(box.current) : null;
      setPhase('settled');
    }, LEAVE_MS);
  }, [running, phase, head]);

  useLayoutEffect(() => {
    if (phase === 'settled' && box.current) box.current.style.minHeight = '';
    const s = snap.current;
    if (phase !== 'settled' || !s || !box.current) return;
    snap.current = null;
    glide(box.current, s);
  }, [phase]);

  const toggle = useCallback(() => {
    haptic('select');
    setOpen((v) => !v);
  }, []);
  const shownOpen = !laidLive && open;
  return (
    <section ref={box} className="turn" data-live={running || undefined} data-turn={turn.key}>
      {pieces.map((p) => {
        const fold = folds(p);
        // Hidden: not mounted at all (a long turn's folded work costs nothing).
        if (!laidLive && fold && !shownOpen && !(p.k === 'run' && p.head)) return null;
        if (laidLive && p.k === 'total') return null;
        const nest = shownOpen && fold && !(p.k === 'run' && p.head);
        const leaving = phase === 'closing' && fold && !(p.k === 'run' && p.head);
        return (
          <div key={p.key} className="tp" data-fp={p.key} data-k={p.k} data-nest={nest || undefined} data-leaving={leaving || undefined} data-tail={(p.k === 'text' && p.tail) || undefined}>
            {p.k === 'lead' ? (
              <UserBubble sid={sid} id={p.id} steered={p.steered} />
            ) : p.k === 'text' ? (
              <Answer sid={sid} id={p.id} tone={p.answer ? 'answer' : 'mid'} />
            ) : p.k === 'show' ? (
              <Show sid={sid} id={p.id} />
            ) : p.k === 'total' ? (
              <WorkHead sid={sid} mode="total" run={null} from={null} until={null} turn={turn} open={open} onToggle={toggle} />
            ) : (
              <RunPiece sid={sid} p={p} fold={foldKey(sid, turn.key, p.key)} settled={!laidLive} open={shownOpen} multi={multi} nest={nest} turn={p.head ? turn : undefined} onToggle={toggle} reveal={!!target?.run && target.run === p.run?.key} />
            )}
          </div>
        );
      })}
      <TurnFoot sid={sid} turn={turn} />
      {turn.checks?.map((id) => (
        <CheckBlock key={id} sid={sid} id={id} />
      ))}
      {newest && <CheckOffer sid={sid} turn={turn} />}
    </section>
  );
});

/**
 * The backstop around each turn (and each item outside one): a piece that cannot be drawn costs that
 * turn one calm line, never the conversation. Tries again when the turn changes.
 */
export class TurnGuard extends Component<{ id: string; turn: unknown; children: ReactNode }, { failed: unknown }> {
  state = { failed: null as unknown };
  static getDerivedStateFromError(err: unknown) {
    return { failed: err ?? true };
  }
  componentDidCatch(err: unknown) {
    console.error('A turn could not be shown', err);
  }
  componentDidUpdate(prev: { turn: unknown }) {
    if (this.state.failed && prev.turn !== this.props.turn) this.setState({ failed: null });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="turn-broken" data-turn={this.props.id}>
        This part of the conversation could not be shown.
      </div>
    );
  }
}

/** How long the pieces that fold take to fade before the turn gathers (ms). */
const LEAVE_MS = 170;

type RunP = { k: 'run'; key: string; run: StepsChunk | null; from: string | null; until: string | null; cap?: string; head: boolean; live: boolean; seg?: Segment };
type Piece =
  | { k: 'lead'; key: string; id: string; steered: boolean; fold: boolean }
  | { k: 'text'; key: string; id: string; note: boolean; answer: boolean; tail: boolean }
  | { k: 'show'; key: string; id: string }
  | { k: 'total'; key: string }
  | RunP;

/** A piece that folds into the turn's line once the turn has ended (the head run keeps its place: it becomes the line). */
const folds = (p: Piece) => (p.k === 'lead' ? p.fold : p.k === 'text' ? p.note : p.k === 'run');

/**
 * The turn's pieces in the order they happened, each with what it is: the messages, the agent's
 * words (notes fold, the answer, a reply and a nod do not), what is shown, the runs of work (the
 * first is the head: it becomes the turn's line), and the live line at the end of a running turn.
 */
function piecesOf(turn: TurnGroup): { pieces: Piece[]; multi: boolean; head: boolean } {
  const segs = turn.segments;
  const last = segs.length - 1;
  const active = turn.liveSegment ?? last;
  const running = turn.state === 'running';
  let headSeg = -1;
  let runs = 0;
  for (let i = 0; i <= last; i++) {
    const s = segs[i];
    if (headSeg < 0 && (s.work.length > 0 || s.notes.length > 0)) headSeg = i;
    for (const c of s.flow) if (c.kind === 'steps') runs++;
  }
  const out: Piece[] = [];
  for (let si = 0; si <= active; si++) {
    const seg = segs[si];
    const place = headSeg < 0 || si < headSeg ? -1 : si === headSeg ? 0 : 1;
    // The last run ends at the turn's record, or at the bridge's word that it was cut.
    const after = segs[si + 1]?.lead ?? turn.end ?? turn.early;
    // A notification taken up mid-turn is part of the work: it folds with it.
    if (seg.lead) out.push({ k: 'lead', key: seg.lead, id: seg.lead, steered: seg.steered, fold: si > 0 && !seg.steered && place === 1 });
    const flow = seg.flow;
    const headAt = place === 0 ? flow.findIndex((c) => c.kind === 'steps' || (c.kind === 'text' && seg.notes.includes(c.id))) : -1;
    let ord = 0;
    for (let i = 0; i < flow.length; i++) {
      const c = flow[i];
      if (i === headAt && c.kind !== 'steps') out.push({ k: 'total', key: `${seg.key}:total` });
      if (c.kind === 'show') {
        out.push({ k: 'show', key: c.id, id: c.id });
        continue;
      }
      if (c.kind === 'text') {
        out.push({ k: 'text', key: c.id, id: c.id, note: seg.notes.includes(c.id), answer: c.id === seg.answer || c.id === seg.reply, tail: seg.tail.includes(c.id) });
        continue;
      }
      const next = flow[i + 1];
      const live = running && si === active && i === flow.length - 1;
      out.push({
        k: 'run',
        key: `${seg.key}:w${ord++}`,
        run: c,
        from: i === 0 && seg.lead ? seg.lead : c.ids[0],
        until: (next ? (next.kind === 'steps' ? next.ids[0] : next.id) : after) ?? null,
        ...(!next && si === last && turn.next ? { cap: turn.next } : {}),
        head: i === headAt,
        live,
        ...(live ? { seg } : {}),
      });
    }
    if (running && si === active) {
      // Cards follow the work and precede an empty live line. Taking one
      // changes its badge in place even when several are waiting together.
      for (const taken of segs.slice(active + 1)) out.push({ k: 'lead', key: taken.key, id: taken.key, steered: true, fold: false });
      for (const id of turn.waiting ?? []) out.push({ k: 'lead', key: id, id, steered: true, fold: false });
      if (flow.at(-1)?.kind !== 'steps')
        out.push({ k: 'run', key: `${seg.key}:w${ord}`, run: null, from: flow.length ? null : seg.lead, until: null, head: false, live: true, seg });
    }
  }
  return { pieces: out, multi: runs > 1, head: headSeg >= 0 };
}

interface Snap {
  tops: Map<string, number>;
  bottom: boolean;
}

/** Where each piece of the turn stands now, and whether the reader is at the newest. */
function snapshot(box: HTMLElement): Snap {
  const tops = new Map<string, number>();
  for (const el of box.querySelectorAll<HTMLElement>(':scope > [data-fp]')) tops.set(el.dataset.fp!, el.getBoundingClientRect().top);
  const sc = box.closest<HTMLElement>('.thread');
  return { tops, bottom: !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48 };
}

const GLIDE = { duration: 420, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/**
 * The turn has gathered: the reader's place is kept (the newest stays at the bottom, or the first
 * piece in view that stayed keeps its place), then every piece that stayed glides from where it
 * stood to where it is (transform only), with what stood above the turn on screen; the line that
 * is new fades in.
 */
function glide(box: HTMLElement, s: Snap) {
  const sc = box.closest<HTMLElement>('.thread');
  const els = [...box.querySelectorAll<HTMLElement>(':scope > [data-fp]')];
  if (sc) {
    if (s.bottom) sc.scrollTop = sc.scrollHeight;
    else {
      const view = sc.getBoundingClientRect().top + 56;
      const anchor = els.find((el) => {
        const t = s.tops.get(el.dataset.fp!);
        return t !== undefined && t >= view;
      });
      if (anchor) sc.scrollTop += anchor.getBoundingClientRect().top - s.tops.get(anchor.dataset.fp!)!;
    }
  }
  let first: number | null = null;
  for (const el of els) {
    const was = s.tops.get(el.dataset.fp!);
    if (was === undefined) {
      el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 120, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'backwards' });
      continue;
    }
    const dy = was - el.getBoundingClientRect().top;
    if (first === null) first = dy;
    if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], GLIDE);
  }
  // What stood above the turn on screen moved as its top did: it glides the same way.
  if (!sc || !first || Math.abs(first) <= 1) return;
  const top = sc.getBoundingClientRect().top;
  let prev = box.previousElementSibling as HTMLElement | null;
  for (let n = 0; prev && n < 4; n++, prev = prev.previousElementSibling as HTMLElement | null) {
    if (prev.getBoundingClientRect().bottom < top) break;
    prev.animate([{ transform: `translateY(${first}px)` }, { transform: 'none' }], GLIDE);
  }
}

/** Under a turn: an interruption, or an error the turn ended with that no notice showed. */
function TurnFoot({ sid, turn }: { sid: string; turn: TurnGroup }) {
  const end = useItem<TurnItem>(sid, turn.end);
  if (turn.early) return <EndedEarly sid={sid} turn={turn} />;
  if (turn.state === 'interrupted')
    return (
      <div className="turn-note">
        <Icon name="hand" size={14} /> Interrupted
      </div>
    );
  if (turn.state === 'failed' && end?.type === 'turn' && end.error && !turn.segments.some((s) => s.errors.length))
    return (
      <div className="notice" data-variant="error">
        <span className="notice-dot" aria-hidden />
        <span className="notice-body">{end.error}</span>
      </div>
    );
  return null;
}

/** Why the bridge says a turn was cut (`NoticeItem.early`), after "Ended early", as the desktop says it. */
const EARLY_WHY: Record<NonNullable<NoticeItem['early']>, string> = {
  died: "the agent's process ended",
  closed: "Sable closed the agent's process",
  restart: 'Sable closed while it worked',
};

/**
 * A turn the bridge knows was cut before the agent finished (`TurnGroup.early`, the desktop's rule):
 * one quiet line with the reason, and while it is the chat's newest (nothing but notices after its
 * line) and the chat is at rest (no turn, no sub-agent or background command at work), one way to
 * carry on.
 */
function EndedEarly({ sid, turn }: { sid: string; turn: TurnGroup }) {
  const line = turn.early ?? '';
  const note = useItem<NoticeItem>(sid, line);
  const why = note?.type === 'notice' && note.early ? EARLY_WHY[note.early] : '';
  const canContinue = useStore((s) => {
    const meta = s.sessions[sid];
    if (!meta || meta.status === 'running' || meta.status === 'awaiting' || meta.status === 'starting' || hasWork(meta)) return false;
    const d = sessionData(s, sid);
    for (let i = d.roots.length - 1, n = 0; i >= 0 && n < 40; i--, n++) {
      if (d.roots[i] === line) return true;
      if (d.items[d.roots[i]]?.type !== 'notice') return false;
    }
    return false;
  });
  const [sent, setSent] = useState(false);
  // The process's own words, when it left any (after the bridge's reason in the notice's detail): a tap shows them.
  const words = note?.type === 'notice' ? earlyWords(note.detail) : '';
  const [shown, setShown] = useState(false);
  return (
    <>
    <div className="turn-note" onClick={words ? () => setShown(!shown) : undefined} role={words ? 'button' : undefined} aria-expanded={words ? shown : undefined}>
      <Icon name="warning" size={14} /> Ended early
      {why && <span className="work-meta">{why}</span>}
      {canContinue && (
        <button
          type="button"
          className="btn btn-sm notice-action"
          disabled={sent}
          onClick={(e) => {
            e.stopPropagation();
            setSent(true);
            haptic('send');
            void conn.call('session.send', { sessionId: sid, text: 'Continue' }).catch(() => setSent(false));
          }}
        >
          Continue
        </button>
      )}
    </div>
    {words && shown && <div className="notice-detail early-words">{words}</div>}
    </>
  );
}

/** The process's own words in a cut turn's notice (the bridge's reason, a blank line, then what it said), bounded; '' when none. */
function earlyWords(detail: string | undefined): string {
  if (!detail) return '';
  const at = detail.indexOf('\n\n');
  if (at < 0) return '';
  const rest = detail.slice(at + 2).trim();
  return rest.length > 2000 ? `${rest.slice(0, 2000)}…` : rest;
}

/** Tells the conversation the reader opened something here: it stops following the newest line, so what opened stays where it is. */
function hold(el: Element | null) {
  el?.dispatchEvent(new CustomEvent('sable:hold', { bubbles: true }));
}

/**
 * One checkpoint's work: its line and, opened, its steps. The same element from the live line
 * ("Run the tests · 12s · 2 steps") through the closed checkpoint ("Worked 45s · 5 steps") to its
 * place in the finished turn's fold; on the turn's first run the line then reads the whole turn.
 */
const RunPiece = memo(function RunPiece({ sid, p, fold, settled, open, multi, nest, turn, onToggle, reveal }: { sid: string; p: RunP; fold: string; settled: boolean; open: boolean; multi: boolean; nest: boolean; turn?: TurnGroup; onToggle: () => void; reveal?: boolean }) {
  // Its steps as the reader left them: this element is gone while its turn is folded, the choice is not.
  const [runOpen, setRunOpen] = useState(() => wasOpen(fold));
  useEffect(() => keepOpen(fold, runOpen), [fold, runOpen]);
  const ref = useRef<HTMLDivElement>(null);
  // Holds the item looked for: its steps open.
  useLayoutEffect(() => {
    if (reveal) setRunOpen(true);
  }, [reveal]);
  const toggleRun = useCallback(() => {
    haptic('select');
    hold(ref.current);
    setRunOpen((v) => !v);
  }, []);
  const toggleTurn = useCallback(() => {
    hold(ref.current);
    onToggle();
  }, [onToggle]);
  const total = p.head && settled;
  // A turn with a single run opens straight to its steps: no line of its own inside the fold.
  const bare = settled && !multi;
  const stepsOpen = settled ? open && (bare || runOpen) : runOpen;
  const mode: LineMode = p.live && !settled ? 'live' : total ? 'total' : 'run';
  return (
    <div className="seg-work" ref={ref}>
      {!(bare && nest) && <WorkHead sid={sid} mode={mode} run={p.run} from={p.from} until={p.until} cap={p.cap} seg={p.seg} turn={turn} open={total ? open : stepsOpen} onToggle={total ? toggleTurn : p.run ? toggleRun : undefined} />}
      {total && p.run && open && multi && (
        <div className="tp-in" data-nest>
          <WorkHead sid={sid} mode="run" run={p.run} from={p.from} until={p.until} cap={p.cap} open={stepsOpen} onToggle={toggleRun} />
        </div>
      )}
      {p.run && <Run sid={sid} ids={p.run.ids} open={stepsOpen} />}
    </div>
  );
});

/** A run of steps between two texts: nothing while folded (not even mounted), a card of rows when opened. */
const Run = memo(function Run({ sid, ids, open }: { sid: string; ids: string[]; open: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div className="run" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={REVEAL}>
          <div className="run-card">
            {ids.map((id) => (
              <StepRow key={id} sid={sid} id={id} />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

/** One piece of the work: a step, a thought, a lead-in, a notice, or a sub-agent or workflow as its block. */
const StepRow = memo(function StepRow({ sid, id }: { sid: string; id: string }) {
  const it = useItem<TimelineItem>(sid, id);
  if (!it) return null;
  if (it.type === 'tool' && (it.kind === 'agent' || it.workflow || it.name === 'Workflow')) return <Block sid={sid} id={id} />;
  if (it.type === 'notice') return <div className="step-text step-note" data-id={id}>{it.text}</div>;
  // What a command printed, in the work: its line (shown by the bubble's own reading).
  if (it.type === 'user') return <UserBubble sid={sid} id={id} />;
  return <Step sid={sid} id={id} />;
});

/**
 * In view in its place: command output, a widget, a plan, files, an error. Read by the item's own
 * type, never by where it stands: what a command printed is a user item Claude Code wrote (a line
 * under the command, Synthetic.tsx), not a step; a type it does not know is one calm line.
 */
function Show({ sid, id }: { sid: string; id: string }) {
  const it = useItem<TimelineItem>(sid, id);
  switch (showKind(it)) {
    case 'user':
      return <UserBubble sid={sid} id={id} />;
    case 'text':
      return <Answer sid={sid} id={id} tone="mid" />;
    case 'notice':
      return <Notice sid={sid} id={id} />;
    case 'check':
      return <CheckBlock sid={sid} id={id} />;
    case 'plan':
      return <PlanBlock sid={sid} it={it as ToolItem} />;
    case 'share':
      return <ShareCards sid={sid} it={it as ToolItem} />;
    case 'block':
      return <Block sid={sid} id={id} />;
    default:
      return it ? <UnknownLine id={id} /> : null;
  }
}

/** An item of a type this phone does not know (a newer desktop's): one calm line where it stands. */
function UnknownLine({ id }: { id: string }) {
  return (
    <div className="turn-broken" data-id={id}>
      Shown on the desktop
    </div>
  );
}

/** A plan: one row; a tap fetches it from the desktop and shows it. */
function PlanBlock({ sid, it }: { sid: string; it: ToolItem }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<string>();
  const html = useMemo(() => (plan ? renderMarkdown(plan, false) : ''), [plan]);
  const toggle = () => {
    haptic('select');
    if (plan === undefined && !open) void fetchItem(sid, it.id).then((r) => setPlan((r.item as ToolItem).detail?.plan ?? ''), () => setPlan(''));
    setOpen((v) => !v);
  };
  return (
    <div className="block" data-open={open || undefined}>
      <button type="button" className="block-toggle" aria-expanded={open} onClick={toggle}>
        <span className="block-head">
          <span className="block-icon">
            <Icon name="plan" size={16} />
          </span>
          <span className="block-title">Plan</span>
          <Icon name="caretDown" size={12} weight="bold" className="block-caret" />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="block-steps" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={REVEAL}>
            {plan === undefined ? <span className="skel step-detail-wait" aria-label="Loading" /> : <div className="md md-plan" dangerouslySetInnerHTML={{ __html: html }} />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** What a work line reads as: the running checkpoint, a closed one, or the whole finished turn. */
type LineMode = 'live' | 'run' | 'total';

/** A work line in its place: live while its checkpoint runs, its summary once closed, the turn's once the turn has ended. */
function WorkHead({ sid, mode, run, from, until, cap, seg, turn, open, onToggle }: { sid: string; mode: LineMode; run: StepsChunk | null; from: string | null; until: string | null; cap?: string; seg?: Segment; turn?: TurnGroup; open: boolean; onToggle?: () => void }) {
  // A checkpoint closing, and the turn ending: the line hands over to its summary, once.
  const was = useRef(mode);
  const [landed, setLanded] = useState(false);
  useLayoutEffect(() => {
    const before = was.current;
    was.current = mode;
    if (before === mode || mode === 'live' || reduced()) return;
    setLanded(true);
    const t = window.setTimeout(() => setLanded(false), 700);
    return () => window.clearTimeout(t);
  }, [mode]);
  if (mode === 'live' && seg) return <LiveLine sid={sid} seg={seg} run={run} from={from} open={open} onToggle={run ? onToggle : undefined} />;
  if (mode === 'total' && turn) return <TotalLine sid={sid} turn={turn} open={open} onToggle={onToggle} landed={landed} />;
  if (run) return <RunLine sid={sid} run={run} from={from} until={until} cap={cap} open={open} onToggle={onToggle} landed={landed} />;
  return null;
}

const workedLabel = (thought: boolean, took: string) => (thought ? (took ? `Thought for ${took}` : 'Thought') : took ? `Worked ${took}` : 'Worked');

/** "Worked 45s · 5 steps": one closed checkpoint, opening to its steps. */
function RunLine({ sid, run, from, until, cap, open, onToggle, landed }: { sid: string; run: StepsChunk; from: string | null; until: string | null; cap?: string; open: boolean; onToggle?: () => void; landed: boolean }) {
  const { span, thought } = useMemo(() => {
    const items = sessionData(getState(), sid).items;
    return { span: runSpan(items, run, from ?? run.ids[0], until, cap), thought: !run.count && run.ids.some((id) => items[id]?.type === 'thinking') };
  }, [sid, run, from, until, cap]);
  const took = span && span >= 1000 ? shortDuration(span) : '';
  return (
    <div className="work" data-landed={landed || undefined} data-open={open || undefined}>
      <button type="button" className="work-line" aria-expanded={open} onClick={onToggle}>
        <span className="work-title">{workedLabel(thought, took)}</span>
        {run.count > 0 && <span className="work-meta num">{plural(run.count, 'step')}</span>}
        <Icon name="caretDown" size={12} weight="bold" className="work-caret" />
      </button>
    </div>
  );
}

/** "Worked 15m 52s · 36 steps", and the change: the whole of a finished turn behind one line. The change opens what it changed. */
function TotalLine({ sid, turn, open, onToggle, landed }: { sid: string; turn: TurnGroup; open: boolean; onToggle?: () => void; landed: boolean }) {
  // Read again when a sub-agent's steps arrive or a step that writes files settles (its edits count too).
  const children = useStore((s) => sessionData(s, sid).children);
  const fileSteps = useStore((s) => sessionData(s, sid).fileSteps);
  const { span, add, del, thought, edits, files, steps } = useMemo(() => {
    const items = sessionData(getState(), sid).items;
    let n = 0;
    let thinking = false;
    for (const s of turn.segments) {
      n += s.steps;
      for (const id of s.work) if (items[id]?.type === 'thinking') thinking = true;
    }
    // The steps that change files, sub-agents' included (the desktop gathers the turn's changes from them).
    const c = turnChanges(items, children, turn.ids);
    return { span: turnSpan(items, turn), add: c.add, del: c.del, thought: !n && thinking, edits: c.edits, files: c.files, steps: n };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, turn, children, fileSteps]);
  const took = span && span >= 1000 ? shortDuration(span) : '';
  const lead = turn.segments[0]?.lead;
  return (
    <div className="work" data-total data-landed={landed || undefined} data-open={open || undefined}>
      <button type="button" className="work-line" aria-expanded={open} onClick={onToggle}>
        <span className="work-title">{workedLabel(thought, took)}</span>
        {steps > 0 && <span className="work-meta num">{plural(steps, 'step')}</span>}
        <Icon name="caretDown" size={12} weight="bold" className="work-caret" />
      </button>
      {(add > 0 || del > 0) && (
        <button
          type="button"
          className="work-changes"
          aria-label={`Changes in this turn: ${plural(files, 'file')}, ${add} added, ${del} removed`}
          onClick={() => {
            haptic('tap');
            nav.push({ name: 'changes', id: sid, items: edits, ...(lead ? { lead } : {}) });
          }}
        >
          {files > 0 && <span className="work-files num">{plural(files, 'file')}</span>}
          <span className="diffstat num">
            {add > 0 && <span className="add">+{add}</span>}
            {del > 0 && <span className="del">−{del}</span>}
          </span>
        </button>
      )}
    </div>
  );
}

const TITLE_HOLD_MS = 600;
const RECENT_MS = 2000;
/** How long the live line stays back after the agent stopped writing (ms): a turn that ends right after its answer never shows it under the words. */
const QUIET_LINGER_MS = 450;
const NO_IDS: string[] = [];

/** The newest lead-in since the last piece in view, while the steps it announced run; else ''. */
function currentLead(items: Record<string, TimelineItem>, seg: Segment, work: string[]): string {
  const id = seg.narr[seg.narr.length - 1];
  const it = id ? items[id] : undefined;
  if (it?.type !== 'text' || it.streaming) return '';
  const at = work.lastIndexOf(id);
  if (at < 0) return '';
  let ended = Infinity;
  for (let i = at + 1; i < work.length; i++) {
    const step = items[work[i]];
    if (!step) continue;
    if (step.type !== 'tool' || step.ts > ended) return '';
    if (step.endedAt) ended = Math.min(ended, step.endedAt);
  }
  return leadTitle(it.text);
}

/**
 * What the running checkpoint does right now, as `${waiting}|${quiet}|${title}` (a string, so the line
 * renders only when it changes). Quiet: the agent is writing something in view and no step runs, so
 * the words are the signal and the line steps back until they end.
 */
function liveSelector(sid: string, seg: Segment, run: StepsChunk | null, held: { title: string }) {
  const work = run?.ids ?? NO_IDS;
  const pieces: string[] = [];
  for (let i = seg.flow.length - 1; i >= 0 && pieces.length < 4; i--) {
    const c = seg.flow[i];
    if (c.kind === 'text' || c.kind === 'show') pieces.push(c.id);
  }
  return (s: State): string => {
    const d = s.data[sid];
    const meta = s.sessions[sid];
    if (!d || !meta) return '0|0|Working';
    let waiting = meta.status === 'awaiting' || d.permissions.length > 0 || d.questions.length > 0;
    let title = '';
    let agents = 0;
    let recent = '';
    let writing = false;
    let stepping = false;
    for (let i = work.length - 1, n = 0; i >= 0 && n < 60; i--, n++) {
      const it = d.items[work[i]];
      if (!it) continue;
      if (it.type === 'tool' && (it.status === 'running' || it.status === 'pending' || it.status === 'awaiting')) {
        stepping = true;
        if (it.status === 'awaiting') waiting = true;
        if (it.kind === 'agent') agents++;
        if (!title) title = it.title;
      } else if (it.type === 'thinking' && it.streaming && !title) title = thinkingHeadline((it as ThinkingItem).text) || 'Thinking';
      else if (n === 0 && it.type === 'text' && it.streaming) writing = true;
      else if (n === 0 && it.type === 'tool' && it.endedAt && Date.now() - it.endedAt < RECENT_MS) recent = it.title;
    }
    if (agents > 1) title = `Running ${agents} sub-agents`;
    else if (writing && held.title) title = held.title;
    else title = currentLead(d.items, seg, work) || title;
    let speaking = false;
    for (const id of pieces) {
      const it = d.items[id];
      if (it?.type === 'text' && it.streaming) speaking = true;
      else if (!title && it?.type === 'tool' && (it.status === 'pending' || it.status === 'running')) title = it.title;
    }
    if (!title) title = recent || (meta.status === 'starting' ? 'Starting' : meta.activity || 'Working');
    held.title = title;
    return `${waiting ? 1 : 0}|${speaking && !waiting && !stepping ? 1 : 0}|${title}`;
  };
}

/** True while `on`, and for `ms` after it turns off. */
function useLinger(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(on);
  useEffect(() => {
    if (on) return setHeld(true);
    const t = window.setTimeout(() => setHeld(false), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return on || held;
}

/**
 * The running checkpoint's one line: the working tiles, what it does now (the agent's own words
 * while the steps it announced run), the time since the checkpoint began and how many steps. Plain
 * dim words, no pill, no shimmer. A tap opens its steps; waiting on you it stills in amber; quiet
 * while the agent writes.
 */
function LiveLine({ sid, seg, run, from, open, onToggle }: { sid: string; seg: Segment; run: StepsChunk | null; from: string | null; open: boolean; onToggle?: () => void }) {
  const [last] = useState(() => ({ title: '' }));
  const info = useStore(useMemo(() => liveSelector(sid, seg, run, last), [sid, seg, run, last]));
  const lead = useItem<TimelineItem>(sid, from);
  const now = useSecond(true);
  const [w, q, ...rest] = info.split('|');
  const waiting = w === '1';
  const quiet = useLinger(q === '1', QUIET_LINGER_MS);
  const title = useHeld(rest.join('|'), TITLE_HOLD_MS);
  const elapsed = lead ? now - lead.ts : 0;
  const steps = run?.count ?? 0;
  const tiles = useMemo(() => <Tiles size={13} />, []);
  return (
    <div className="work" data-live data-waiting={waiting || undefined} data-quiet={(quiet && !waiting) || undefined} data-open={open || undefined} role="status" aria-live="off">
      <button type="button" className="work-line" aria-expanded={onToggle ? open : undefined} onClick={onToggle} disabled={!onToggle || quiet}>
        <span className="work-ind">{waiting ? <StatusMark tone="awaiting" size={11} /> : tiles}</span>
        {/* No shimmer: it paints on every frame of the turn; the tiles beside it say it works. */}
        <span key={waiting ? '\u0000' : title} className="work-title">
          {waiting ? 'Waiting for you' : title}
        </span>
        {elapsed >= 1000 && <span className="work-meta num">{shortDuration(elapsed)}</span>}
        {steps > 0 && <span className="work-meta num">{plural(steps, 'step')}</span>}
        {onToggle && <Icon name="caretDown" size={12} weight="bold" className="work-caret" />}
      </button>
    </div>
  );
}

/** A root item outside any turn (a /until loop's end, a queued message, a page that starts mid-turn). */
export const ItemRow = memo(function ItemRow({ sid, id, queued }: { sid: string; id: string; queued?: boolean }) {
  const it = useItem<TimelineItem>(sid, id);
  if (!it) return null;
  if (it.type === 'user') return <UserBubble sid={sid} id={id} steered={it.steered} queued={queued && !it.steered} />;
  if (it.type === 'text') return <Answer sid={sid} id={id} tone="answer" />;
  if (it.type === 'notice') return <Notice sid={sid} id={id} />;
  if (it.type === 'tool' && it.check) return <CheckBlock sid={sid} id={id} />;
  if (it.type === 'tool' && it.kind === 'share') return <ShareCards sid={sid} it={it} />;
  if (it.type === 'tool')
    return (
      <div className="run-card">
        <StepRow sid={sid} id={id} />
      </div>
    );
  if (it.type === 'thinking' || it.type === 'turn') return null;
  return <UnknownLine id={id} />;
});

const UserBubble = memo(function UserBubble({ sid, id, steered, queued }: { sid: string; id: string; steered?: boolean; queued?: boolean }) {
  const got = useItem<TimelineItem>(sid, id);
  const it = got?.type === 'user' ? got : undefined;
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);

  // A review sent from the desktop's review bar: what was typed, then the comments as a short list
  // (file and lines over the words), as the desktop's timeline shows it; not the quoted lines the agent gets.
  const text = it?.text ?? '';
  const cut = !!(it as PhoneItem | undefined)?.cut;
  const review = useMemo(() => readReview(text, cut), [text, cut]);

  // A message just sent arrives as liquid (lib/flight.ts): the bubble stays hidden while the drop
  // rises from the prompt bar and spreads into its shape, then takes over in one frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !it) return;
    // Long: the words run past about ten lines (photos and a review's comments do not count).
    setLong((el.querySelector('.user-text')?.scrollHeight ?? 0) > 240);
    claimFlight(it.text, el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!it]);

  if (!it) return null;
  // A failing `/until` check Sable sent back: the check's row, not a message.
  if (it.until?.check) return <CheckRow check={it.until.check} />;
  // Written by Claude Code in the person's place (a task finished, a slash command): a line, not a bubble.
  const syn = syntheticOf(it);
  if (syn) return syn.role === 'hidden' ? null : <SynLine sid={sid} it={it} syn={syn} />;
  const images = it.attachments?.filter((a) => a.dataUrl && a.kind === 'image') ?? [];
  const files = it.attachments?.filter((a) => !(a.dataUrl && a.kind === 'image')) ?? [];
  const waitingSteer = steered && it.state === 'queued';
  const words = review ? review.lead : stripWrappers(it.text);
  return (
    <div className="user-row" data-id={id} data-steered={steered || undefined} data-queued={queued || waitingSteer || undefined}>
      <div
        ref={ref}
        className="user-bubble"
        data-long={long && !open ? true : undefined}
        onClick={() => long && (haptic('select'), setOpen((v) => !v))}
        onContextMenu={(e) => holdMessage(e, e.currentTarget.parentElement, () => (cut ? fetchItem(sid, id).then((r) => stripWrappers((r.item as UserItem).text)) : words || it.text))}
      >
        {images.length > 0 && (
          <div className="user-images">
            {images.map((a) => (
              <img key={a.id} src={a.dataUrl} alt={a.name} />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="user-files">
            {files.map((a) => (
              <span key={a.id} className="file-chip">
                <Icon name="file" size={14} /> {a.name}
              </span>
            ))}
          </div>
        )}
        {words && <div className="user-text">{words}</div>}
        {long && !open && <div className="user-more">Show more</div>}
        {review && <ReviewList sid={sid} id={id} review={review} />}
      </div>
      {(steered || queued) && (
        <span className="user-note">
          <Icon name="steer" size={12} /> {queued ? 'Queued' : waitingSteer ? 'Steering' : 'Steered'}
        </span>
      )}
    </div>
  );
});

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A review's comments in the bubble: per comment its file (the folder dim, the name whole) and lines, then the words. */
function ReviewList({ sid, id, review }: { sid: string; id: string; review: PhoneReview }) {
  const [busy, setBusy] = useState(false);
  const n = review.comments.length;
  return (
    <>
      <ul className="rv-list" aria-label={`Review, ${n} ${n === 1 ? 'comment' : 'comments'}`}>
        {review.comments.map((c, i) => {
          const at = Math.max(c.path.lastIndexOf('/'), c.path.lastIndexOf('\\'));
          return (
            <li key={i} className="rv-item">
              <div className="rv-where">
                <Icon name="comment" size={14} />
                {at >= 0 && <span className="rv-dir">{c.path.slice(0, at + 1)}</span>}
                <span className="rv-name">{c.path.slice(at + 1)}</span>
                {c.range && <span className="rv-lines num">{upperFirst(c.range)}</span>}
              </div>
              {c.text && <div className="rv-text">{c.text}</div>}
            </li>
          );
        })}
      </ul>
      {review.more && (
        <button
          type="button"
          className="user-more rv-more"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            setBusy(true);
            haptic('select');
            void fetchItem(sid, id)
              .then((r) => applyFull(sid, r.item))
              .catch(() => setBusy(false));
          }}
        >
          {busy ? <span className="dots" /> : 'Show all'}
        </button>
      )}
    </>
  );
}

const Step = memo(function Step({ sid, id, quiet }: { sid: string; id: string; quiet?: boolean }) {
  const it = useItem<TimelineItem>(sid, id);
  // Opened or not is remembered per chat and step (lib/folds.ts): a turn folded and opened again shows it as it was left.
  const [open, setOpen] = useState(() => wasOpen(stepKey(sid, id)));
  // (A thought keeps its own, in ThinkingStep.)
  const tool = it?.type === 'tool';
  useEffect(() => {
    if (tool) keepOpen(stepKey(sid, id), open);
  }, [sid, id, open, tool]);
  // The desktop keeps a step's output and change: asked for when the step opens, and kept (a few) so reopening asks nothing.
  const [full, setFull] = useState<ToolItem | undefined>(() => keptDetail<ToolItem>(sid, id));
  const wantsFull = open && !full && !!(it as PhoneItem | undefined)?.more;
  useEffect(() => {
    if (!wantsFull) return;
    let live = true;
    void fetchItem(sid, id).then(
      (r) => {
        keepDetail(sid, id, r.item);
        if (live) setFull(r.item as ToolItem);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [wantsFull, sid, id]);
  if (!it) return null;
  if (it.type === 'thinking') return <ThinkingStep sid={sid} it={it} quiet={quiet} />;
  if (it.type === 'text') return <div className="step-text" data-id={id}>{inlineCode(it.text.length > 280 ? `${it.text.slice(0, 280)}…` : it.text)}</div>;
  if (it.type !== 'tool') return null;
  const more = !!(it as PhoneItem).more;
  const detail = toolDetail(full ?? it);
  const status = it.status;
  const toggle = () => {
    if (quiet || !(detail || more)) return;
    haptic('select');
    setOpen((v) => !v);
  };
  return (
    <div className="step" data-id={id} data-status={status} data-open={open || undefined}>
      <button type="button" className="step-line" onClick={toggle} disabled={quiet || !(detail || more)}>
        <span className="step-icon">{status === 'running' || status === 'pending' ? <Ring size={13} /> : <Icon name={TOOL_ICON[it.kind] ?? 'tool'} size={16} />}</span>
        <span className="step-title">{it.title}</span>
        {it.result?.diff && <DiffStat diff={it.result.diff} />}
        {(status === 'error' || status === 'denied') && <span className="step-flag">{status === 'denied' ? 'Denied' : 'Failed'}</span>}
      </button>
      {!!(it as PhoneItem).pics && <Pics sid={sid} id={id} n={(it as PhoneItem).pics!} />}
      <AnimatePresence initial={false}>
        {open && (detail || more) && (
          <motion.div className="step-detail-wrap" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={REVEAL}>
            <pre className="step-detail no-drag">
              {detail && <Detail d={detail} />}
              {more && !full && <span className="step-detail-wait skel" aria-label="Loading" />}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/** A step's pictures (a screenshot): thumbnails under its line, each asked of the desktop; a tap opens them full screen. */
function Pics({ sid, id, n }: { sid: string; id: string; n: number }) {
  const count = Math.min(n, 12);
  const open = (index: number, el: HTMLElement) => {
    haptic('tap');
    const srcs = Array.from({ length: count }, (_, i) => keptPic(sid, id, i) ?? null);
    // Each late picture names this opening and this step: it never lands in another step's viewer.
    const key = `${sid}\u0000${id}`;
    const gen = openViewer({ srcs, index, from: el.getBoundingClientRect(), key });
    srcs.forEach((src, i) => !src && void loadPic(sid, id, i).then((d) => viewerLoaded(gen, key, i, d), () => {}));
  };
  return (
    <div className="pics no-drag">
      {Array.from({ length: count }, (_, i) => (
        <Pic key={i} sid={sid} id={id} index={i} onOpen={open} />
      ))}
    </div>
  );
}

function Pic({ sid, id, index, onOpen }: { sid: string; id: string; index: number; onOpen: (index: number, el: HTMLElement) => void }) {
  const [src, setSrc] = useState(() => keptPic(sid, id, index));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (src) return;
    let live = true;
    void loadPic(sid, id, index).then(
      (d) => live && setSrc(d),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [sid, id, index, src]);
  return (
    <button type="button" className="pic" aria-label={`Picture ${index + 1}`} disabled={failed} onClick={(e) => onOpen(index, e.currentTarget)}>
      {src ? (
        <img src={src} alt="" decoding="async" />
      ) : failed ? (
        <span className="pic-failed">
          <Icon name="image" size={18} />
        </span>
      ) : (
        <span className="skel" aria-label="Loading" />
      )}
    </button>
  );
}

/** Text between steps: plain, with `code` set as code (not shown with its backticks). */
function inlineCode(text: string): ReactNode {
  if (!text.includes('`')) return text;
  return text.split(/(`[^`\n]+`)/g).map((part, i) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part));
}

function ThinkingStep({ sid, it, quiet }: { sid: string; it: ThinkingItem; quiet?: boolean }) {
  const [open, setOpen] = useState(() => wasOpen(stepKey(sid, it.id)));
  useEffect(() => keepOpen(stepKey(sid, it.id), open), [sid, it.id, open]);
  const secs = it.endedAt ? Math.max(1, Math.round((it.endedAt - it.ts) / 1000)) : 0;
  const toggle = () => {
    if (quiet || !it.text) return;
    haptic('select');
    if ((it as PhoneItem).cut && !open && !it.streaming) void fetchItem(sid, it.id).then((r) => applyFull(sid, r.item), () => {});
    setOpen((v) => !v);
  };
  return (
    <div className="step" data-open={open || undefined}>
      <button type="button" className="step-line" onClick={toggle} disabled={quiet || !it.text}>
        <span className="step-icon">{it.streaming ? <Ring size={13} /> : <Icon name="brain" size={16} />}</span>
        <span className="step-title">{it.streaming ? 'Thinking' : secs ? `Thought for ${secs}s` : 'Thought'}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="step-detail-wrap" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={REVEAL}>
            <div className="step-think">{inlineCode(it.text)}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** What a step did, for its detail: the command or target, the first lines of output, the first hunks of a change. */
function toolDetail(it: ToolItem): { head?: string; out?: string; diff?: string } | null {
  const d = it.detail ?? {};
  const head = d.command ? `$ ${d.command}` : d.path || d.url || (d.query || d.pattern ? String(d.query ?? d.pattern) : undefined);
  let out: string | undefined;
  const res = it.output || it.result?.text || it.result?.stderr;
  if (res) {
    const lines = res.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    out = (lines.slice(0, 24).join('\n') + (lines.length > 24 ? `\n… ${lines.length - 24} more lines` : '')).slice(0, 3000);
  }
  let diff: string | undefined;
  if (it.result?.diff?.length) {
    const parts: string[] = [];
    for (const f of it.result.diff.slice(0, 3)) for (const h of f.hunks.slice(0, 2)) parts.push(h.lines.slice(0, 16).join('\n'));
    diff = parts.join('\n').slice(0, 3000);
  }
  return head || out || diff ? { head, out: diff ? undefined : out, diff } : null;
}

function Detail({ d }: { d: NonNullable<ReturnType<typeof toolDetail>> }) {
  return (
    <>
      {d.head && <span className="step-detail-head">{d.head}</span>}
      {d.out && `${d.head ? '\n' : ''}${d.out}`}
      {d.diff && (
        <>
          {d.head ? '\n' : ''}
          <span dangerouslySetInnerHTML={{ __html: diffLines(d.diff) }} />
        </>
      )}
    </>
  );
}

function DiffStat({ diff }: { diff: NonNullable<ToolItem['result']>['diff'] }) {
  const add = diff?.reduce((n, f) => n + f.additions, 0) ?? 0;
  const del = diff?.reduce((n, f) => n + f.deletions, 0) ?? 0;
  if (!add && !del) return null;
  return (
    <span className="diffstat num">
      {add > 0 && <span className="add">+{add}</span>}
      {del > 0 && <span className="del">−{del}</span>}
    </span>
  );
}

/** Sub-agents, workflows and widgets as compact blocks. */
const Block = memo(function Block({ sid, id }: { sid: string; id: string }) {
  const it = useItem<ToolItem>(sid, id);
  const known = useStore((s) => sessionData(s, sid).children[id]?.length ?? 0);
  // Only a step is a block (anything else that reaches here shows nothing rather than break the turn).
  if (it?.type !== 'tool') return null;
  const kids = Math.max(known, (it as PhoneItem).kids ?? 0);
  if (it.kind === 'widget') {
    const title = (it.input as { title?: string } | undefined)?.title ?? it.title;
    const pics = (it as PhoneItem).pics ?? 0;
    // A widget that holds pictures: its title and the pictures (the rest of it stays on the desktop).
    if (pics > 0)
      return (
        <div className="wpics">
          <div className="wpics-head">
            <Icon name="image" size={15} />
            <span className="wpics-title">{title}</span>
          </div>
          <Pics sid={sid} id={id} n={pics} />
        </div>
      );
    return (
      <div className="block block-quiet">
        <span className="block-icon">
          <Icon name="cube" size={16} />
        </span>
        <span className="block-title">{title}</span>
        <span className="block-aside">On the desktop</span>
      </div>
    );
  }
  const w = it.workflow;
  if (w) {
    const running = w.agents.filter((a) => a.state === 'running').length;
    const done = w.agents.filter((a) => a.state === 'done').length;
    return (
      <div className="block">
        <div className="block-head">
          <span className="block-icon">{w.status === 'running' ? <Ring size={14} /> : <Icon name="workflow" size={16} />}</span>
          <span className="block-title">{w.name ?? 'Workflow'}</span>
          <span className="block-aside num">{w.phases.length ? `Phase ${Math.max(1, w.phase)} of ${w.phases.length}` : statusWord(w.status)}</span>
        </div>
        {w.agents.length > 0 && (
          <div className="block-agents" aria-label={`${running} running, ${done} done of ${w.agents.length}`}>
            {w.agents.slice(0, 40).map((a) => (
              <i key={a.index} data-state={a.state} />
            ))}
          </div>
        )}
        <div className="block-sub num">
          {[running && `${running} running`, done && `${done} done`, w.tokens && `${formatTokens(w.tokens)} tokens`, w.durationMs && formatDuration(w.durationMs)].filter(Boolean).join(' · ') || plural(w.agents.length, 'agent')}
        </div>
      </div>
    );
  }
  const stats = it.result?.agent;
  const bg = stats?.background;
  const runningNow = it.status === 'running' || it.status === 'pending' || bg === 'running';
  const name = it.detail?.subagent || it.title;
  return <AgentBlock sid={sid} id={id} it={it} name={name} running={runningNow} background={!!bg} kids={kids} />;
});

/** A sub-agent: what it was asked, how far it got; a tap opens its own steps (the last 40). */
function AgentBlock({ sid, id, it, name, running, background, kids }: { sid: string; id: string; it: ToolItem; name: string; running: boolean; background: boolean; kids: number }) {
  const [open, setOpen] = useState(false);
  const children = useStore((s) => (open ? sessionData(s, sid).children[id] : undefined));
  const stats = it.result?.agent;
  const steps = (children ?? []).slice(-40);
  // A sub-agent from the other agent (delegate_to_codex / delegate_to_claude): its own mark.
  const other = otherAgent(it);
  const toggle = () => {
    haptic('select');
    // Its steps stay on the desktop until asked for (the last 40).
    if (!open) void fetchItem(sid, id).then((r) => applyChildren(sid, id, r.children), () => {});
    setOpen((v) => !v);
  };
  return (
    <div className="block" data-open={open || undefined} data-running={running || undefined}>
      <button type="button" className="block-toggle" aria-expanded={open} disabled={!kids} onClick={toggle}>
        <span className="block-head">
          <span className="block-icon">{running ? <Tiles size={13} /> : other ? <ProviderMark provider={other} size={16} /> : <Icon name="agent" size={16} />}</span>
          <span className="block-title">{name}</span>
          <span className="block-aside">{it.status === 'error' ? 'Failed' : running ? (background ? 'In the background' : 'Working') : 'Done'}</span>
        </span>
        {it.detail?.description && it.detail.description !== name && <span className="block-desc">{it.detail.description}</span>}
        <span className="block-sub num">
          {[stats?.steps ? plural(stats.steps, 'step') : kids ? plural(kids, 'step') : '', stats?.tokens && `${formatTokens(stats.tokens)} tokens`, stats?.durationMs && formatDuration(stats.durationMs)].filter(Boolean).join(' · ')}
          {kids > 0 && <Icon name="caretDown" size={12} weight="bold" className="block-caret" />}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && steps.length > 0 && (
          <motion.div className="block-steps" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={REVEAL}>
            {steps.map((cid) => (
              <Step key={cid} sid={sid} id={cid} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The agent a cross-agent sub-agent runs on, from its tool's name or the name it carries. */
function otherAgent(it: ToolItem): ProviderId | undefined {
  const n = (it.name ?? '').toLowerCase();
  if (n.includes('delegate_to_codex') || it.detail?.subagent === 'Codex') return 'codex';
  if (n.includes('delegate_to_claude') || it.detail?.subagent === 'Claude Code') return 'claude';
  return undefined;
}

const statusWord = (s: string) => (s === 'running' ? 'Running' : s === 'done' ? 'Done' : s === 'failed' ? 'Failed' : 'Stopped');

const Notice = memo(function Notice({ sid, id }: { sid: string; id: string }) {
  const it = useItem<NoticeItem>(sid, id);
  const provider = useStore((s) => limitProvider(it?.limit, s.sessions[sid]?.provider));
  const accounts = useStore((s) => (provider ? s.providers[provider]?.accounts : undefined));
  if (!it) return null;
  // What a command printed, standing for its turn: a line under the command's (Synthetic.tsx).
  if ((it as TimelineItem).type === 'user') return <UserBubble sid={sid} id={id} />;
  // At a plan limit: carry on with the account the desktop suggests (the refused message goes again).
  const next = it.limit?.next && !it.limit.continuedWith ? accounts?.find((a) => a.id === it.limit!.next && a.auth.loggedIn) : undefined;
  if (it.limit) return <LimitCard sid={sid} it={it} next={next} went={it.limit.continuedWith ? (accounts?.find((a) => a.id === it.limit!.continuedWith)?.label ?? 'another account') : undefined} />;
  if (it.until) return <UntilEnd it={it} />;
  if (it.agentSwitch) return <AgentSwitchLine sid={sid} it={it} />;
  return (
    <div className="notice" data-variant={it.variant} data-level={noticeLevel(it)}>
      {it.variant === 'error' ? <span className="notice-dot" aria-hidden /> : <span className="notice-rule" aria-hidden />}
      <span className="notice-body">
        {it.text}
        {it.detail && <span className="notice-detail"> · {it.detail}</span>}
        {/* The sign-in itself happens in the agent's own window on the computer: the phone says where. */}
        {!it.detail && it.auth?.state === 'signedOut' && <span className="notice-detail"> · Sign in on your computer</span>}
      </span>
    </div>
  );
});

/**
 * Where the chat switched agents: one quiet line with the new agent's mark, centred between two
 * rules. The latest switch offers to switch back, between turns (right after the switch that
 * undoes it; later the agent before resumes its own conversation and hears what happened since).
 */
function AgentSwitchLine({ sid, it }: { sid: string; it: NoticeItem }) {
  const mark = it.agentSwitch!;
  const busy = useStore((s) => {
    const st = s.sessions[sid]?.status;
    return st === 'running' || st === 'starting' || st === 'awaiting';
  });
  const online = useStore((s) => s.conn === 'open');
  const [going, setGoing] = useState(false);
  const off = busy || going || !online;
  const back = () => {
    if (off) return;
    haptic('select');
    setGoing(true);
    void conn
      .call('session.switchAgent', { sessionId: sid, provider: mark.from })
      .catch((err) => setState({ toast: { text: (err as Error).message, level: 'error', at: Date.now() } }))
      .finally(() => setGoing(false));
  };
  return (
    <div className="switch-line" role="note">
      <span className="switch-rule" aria-hidden />
      <span className="switch-label">
        <ProviderMark provider={mark.to} size={14} />
        <span className="switch-text">{it.text}</span>
      </span>
      {!mark.past && (
        <button type="button" className="switch-back" aria-disabled={off || undefined} data-going={going || undefined} onClick={back}>
          Switch back
        </button>
      )}
      <span className="switch-rule" aria-hidden />
    </div>
  );
}

/** A `/until` check: one quiet row (passed or failed, its round); a tap shows the first lines of its output. */
function CheckRow({ check }: { check: UntilCheck }) {
  const [open, setOpen] = useState(false);
  const out = check.output?.trim();
  const shown = out ? out.split('\n').slice(0, 14).join('\n') : '';
  const result = check.passed ? (check.passing ? `${check.passing} passed` : '') : check.timedOut ? 'Timed out' : check.failing ? `${check.failing} failing` : check.exitCode != null ? `exit ${check.exitCode}` : '';
  return (
    <div className="step check-row" data-status={check.passed ? 'done' : 'error'}>
      <button type="button" className="step-line" disabled={!out} aria-expanded={out ? open : undefined} onClick={() => (haptic('select'), setOpen((v) => !v))}>
        <span className="step-icon">
          <Icon name={check.passed ? 'check' : 'x'} size={14} weight="bold" />
        </span>
        <span className="step-title">{check.passed ? 'Check passed' : 'Check failed'}</span>
        {result && <span className="check-result num">{result}</span>}
        <span className="check-round num">
          {check.round} of {check.rounds}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && out && (
          <motion.div className="step-detail-wrap" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={REVEAL}>
            <pre className="step-detail no-drag">
              <span className="step-detail-head">$ {check.command}</span>
              {`\n${shown}`}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Where a `/until` loop ended: its last check, then one calm line. */
function UntilEnd({ it }: { it: NoticeItem }) {
  const end = it.until?.end;
  return (
    <div className="until-end">
      {it.until?.check && <CheckRow check={it.until.check} />}
      <div className="until-line" data-end={end}>
        <Icon name={end === 'passed' ? 'check' : 'hand'} size={14} weight={end === 'passed' ? 'bold' : 'regular'} />
        <span>{it.text}</span>
      </div>
    </div>
  );
}

/** A turn refused at a plan limit: which window, when it resets, and the account to carry on with. */
function LimitCard({ sid, it, next, went }: { sid: string; it: NoticeItem; next?: { id: string; label: string }; went?: string }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const l = it.limit!;
  const waiting = useStore((s) => !!s.sessions[sid]?.spare);
  const online = useStore((s) => s.conn === 'open');
  const action = limitAction(sid, it, next, waiting, now);
  const go = async () => {
    if (!action || busy || !online) return;
    setBusy(true);
    haptic('send');
    try {
      const r = await conn.call(action.method, action.params);
      if (!r.ok) throw new Error(('error' in r && r.error) || ('message' in r && r.message) || 'Could not continue this chat');
    } catch (error) {
      setState({ toast: { text: (error as Error).message, level: 'error', at: Date.now() } });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="limit-card">
      <div className="limit-card-head">
        <StatusMark tone="awaiting" size={12} />
        <span className="limit-card-title">{l.window ? `${l.window} reached` : it.text}</span>
        {l.resetsAt && <span className="limit-card-reset num">{resetIn(l.resetsAt, now)}</span>}
      </div>
      {it.detail && <div className="limit-card-detail">{it.detail}</div>}
      {action && (
        <button
          type="button"
          className="btn btn-primary btn-block limit-card-go"
          disabled={busy || !online}
          onClick={() => void go()}
        >
          {busy ? <span className="dots" /> : action.label}
        </button>
      )}
      {went && <div className="limit-card-detail">Carried on with {went}</div>}
    </div>
  );
}

/**
 * A streaming answer, block by block: blocks that are complete (`settledCut`) are parsed once and
 * stay in the page; only the newest one is parsed and put in again as words arrive. (Parsing and
 * rebuilding the whole answer on every frame cost more the longer it grew.) Once it has ended the
 * answer is rendered whole, as any other.
 */
function useStreamed(box: React.RefObject<HTMLDivElement | null>, text: string, on: boolean) {
  const done = useRef<{ el: HTMLElement | null; prefix: string; nodes: number }>({ el: null, prefix: '', nodes: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !on) return;
    const st = done.current;
    // A new element (the answer streams again), or replaced rather than grown (a fuller copy came): start again.
    if (st.el !== el || !text.startsWith(st.prefix)) {
      st.el = el;
      el.textContent = '';
      st.prefix = '';
      st.nodes = 0;
    }
    const put = (md: string) => {
      const t = document.createElement('template');
      t.innerHTML = renderMarkdown(md, true);
      el.append(t.content);
    };
    const from = st.prefix.length;
    const cut = settledCut(text, from);
    while (el.childNodes.length > st.nodes) el.lastChild!.remove();
    if (cut > from) {
      put(text.slice(from, cut));
      st.prefix = text.slice(0, cut);
      st.nodes = el.childNodes.length;
    }
    put(text.slice(cut));
  }, [box, text, on]);
}

const Answer = memo(function Answer({ sid, id, tone = 'answer' }: { sid: string; id: string; tone?: 'answer' | 'mid' }) {
  const got = useItem<TimelineItem>(sid, id);
  // Only the agent's words are an answer (anything else that reaches here shows nothing).
  const it = got?.type === 'text' ? (got as TextItem) : undefined;
  const streaming = !!it?.streaming;
  const html = useMemo(() => (it && !it.streaming ? renderMarkdown(it.text) : ''), [it]);
  const box = useRef<HTMLDivElement>(null);
  useStreamed(box, it?.text ?? '', streaming);
  const [busy, setBusy] = useState(false);
  if (got?.type === 'user') return <UserBubble sid={sid} id={id} />;
  if (!it || !it.text.trim()) return null;
  const cut = (it as PhoneItem).cut && !it.streaming;
  return (
    <>
      <div
        key={streaming ? 'streaming' : 'whole'}
        ref={box}
        className="md"
        data-id={id}
        data-tone={tone}
        data-streaming={it.streaming || undefined}
        data-cut={cut || undefined}
        onClick={copyCode}
        onContextMenu={(e) => holdMessage(e, e.currentTarget, () => (cut ? fetchItem(sid, id).then((r) => (r.item as TextItem).text) : it.text), 'md')}
        {...(streaming ? {} : { dangerouslySetInnerHTML: { __html: html } })}
      />
      {cut && (
        <button
          type="button"
          className="btn btn-sm md-rest"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            haptic('select');
            void fetchItem(sid, id)
              .then((r) => applyFull(sid, r.item))
              .catch(() => setBusy(false));
          }}
        >
          {busy ? <span className="dots" /> : 'Show all'}
        </button>
      )}
    </>
  );
});

/** The copy key on a code block: its text to the clipboard, a short confirmation on the key itself. A file chip copies its path. */
function copyCode(e: React.MouseEvent) {
  const file = (e.target as HTMLElement).closest<HTMLElement>('.md-file');
  if (file?.dataset.path) {
    void navigator.clipboard
      ?.writeText(file.dataset.path)
      .then(() => (haptic('success'), setState({ toast: { text: 'Path copied', level: 'success', at: Date.now() } })))
      .catch(() => {});
    return;
  }
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.md-copy');
  const code = btn?.closest('.md-code')?.querySelector('code');
  if (!btn || !code) return;
  void navigator.clipboard
    ?.writeText(code.textContent ?? '')
    .then(() => {
      haptic('success');
      setState({ toast: { text: 'Copied', level: 'success', at: Date.now() } });
      btn.dataset.done = '';
      window.setTimeout(() => delete btn.dataset.done, 1400);
    })
    .catch(() => {});
}

// ───────────────────────── files the agent handed over, checks by the other agent ─────────────────────────

const KB = 1024;
function fileSize(n?: number): string {
  if (n == null) return '';
  if (n < KB) return `${n} B`;
  if (n < KB * KB) return `${Math.round(n / KB)} KB`;
  if (n < KB * KB * KB) return `${(n / KB / KB).toFixed(n < 10 * KB * KB ? 1 : 0)} MB`;
  return `${(n / KB / KB / KB).toFixed(1)} GB`;
}

/**
 * Files the agent handed over (`share`): one card, a row per file (a picture of it where the desktop
 * has one, a photo, a PDF's first page or a video's frame; else its kind drawn as a page with an
 * emblem; the name, the size and kind) with a round Download key. The download runs inside the app
 * (lib/downloads.ts: Android's DownloadManager into Downloads/Sable): the key fills as a ring with the
 * bytes counted under the name, and the file then opens from the row (an APK goes to the installer).
 */
function ShareCards({ sid, it }: { sid: string; it: ToolItem }) {
  const files = it.detail?.files ?? [];
  const caption = it.detail?.caption?.trim();
  if (!files.length) return null;
  return (
    <div className="share">
      {caption && <p className="share-caption">{caption}</p>}
      <div className="share-card">
        {files.map((f, i) => (
          <ShareRow key={`${f.path}:${i}`} sid={sid} itemId={it.id} index={i} name={f.name} size={f.size} shared={it.status === 'done'} />
        ))}
      </div>
    </div>
  );
}

function ShareRow({ sid, itemId, index, name: listed, size, shared }: { sid: string; itemId: string; index: number; name: string; size?: number; shared: boolean }) {
  const key = downloadKey(sid, itemId, index);
  const d = useDownload(key);
  // One canonical name for everything here (what shows, what it is saved as, whether it is an app), as the desktop and FilesPlugin read it.
  // Once a download has its record, the name the desktop gave it for that transfer (whole, its extension kept) decides, never the row's.
  const name = useMemo(() => (d.via === 'channel' && d.name ? d.name : canonicalName(listed)), [listed, d.via, d.name]);
  // A picture of it (a photo, a PDF's first page, a video's frame) once the share went through.
  const thumb = useThumb(sid, itemId, index, shared ? name : '', size);
  const desktop = useStore((st) => st.desktop);
  // Re-read when the connection changes (a pairing made again on the way).
  useStore((st) => st.conn);
  const paired = conn.pairedSecurely;
  const busy = d.state === 'asking' || d.state === 'pending' || d.state === 'running' || d.state === 'paused' || d.state === 'verifying';
  const total = d.total ?? size;
  const p = total && d.bytes !== undefined ? Math.min(1, d.bytes / total) : 0;
  const apk = isPackageName(name);
  // An app is installed only from bytes checked against a digest that came sealed; one fetched before that is fetched again.
  const install = apk && installable(d);
  const again = apk && d.state === 'done' && !install;
  const fail = (err: unknown) => {
    haptic('deny');
    setState({ toast: { text: (err as Error).message, level: 'error', at: Date.now() } });
  };
  const get = () => {
    haptic('tap');
    void startDownload(key, { sid, itemId, index, name, size, from: desktop ? `From ${desktop}` : undefined }).catch(fail);
  };
  const open = () => {
    haptic('tap');
    void openDownload(key).catch(fail);
  };
  const meta =
    d.state === 'failed'
      ? (d.error ?? 'The download stopped.')
      : !paired && d.state !== 'done'
        ? PLAIN_OFF
        : d.state === 'verifying'
          ? 'Checking'
          : busy && (d.state === 'asking' || !d.bytes)
            ? 'Starting'
            : busy && total
              ? `${fileSize(d.bytes ?? 0)} of ${fileSize(total)}`
              : again
                ? paired
                  ? 'Download it again to install it'
                  : 'Pair again for a secure connection to install it'
                : d.state === 'done'
                  ? `${fileSize(total)} · ${d.published === false ? 'Saved in Sable only' : 'Downloaded'}`
                  : [fileSize(size), kindName(name)].filter(Boolean).join(' · ');
  // An older, plain pairing: nothing to fetch a file with that could be trusted (pair again).
  const blocked = !paired;
  return (
    <div className="share-row" data-state={d.state}>
      <span className="share-glyph" data-pic={thumb?.kind}>
        {thumb ? (
          <span className="share-thumb">
            <img src={thumb.src} alt="" draggable={false} />
            {thumb.kind === 'video' && <span className="share-play" />}
          </span>
        ) : (
          <FileGlyph name={name} size={34} />
        )}
      </span>
      <span className="share-text">
        <span className="share-name">{name}</span>
        <span className="share-meta num" data-tone={d.state === 'failed' ? 'error' : undefined}>
          {meta}
        </span>
      </span>
      {d.state === 'done' && !again ? (
        <button type="button" className="share-open" onClick={open} aria-label={`${apk ? 'Install' : 'Open'} ${name}`}>
          {apk ? 'Install' : 'Open'}
        </button>
      ) : blocked ? null : busy ? (
        <button type="button" className="share-key" data-busy aria-label={`Stop downloading ${name}`} onClick={() => (haptic('tap'), void cancelDownload(key))}>
          <svg className="share-ring" viewBox="0 0 40 40" aria-hidden data-wait={d.state === 'asking' || d.state === 'pending' || d.state === 'verifying' || undefined}>
            <circle cx="20" cy="20" r="17" className="share-ring-track" />
            <circle cx="20" cy="20" r="17" className="share-ring-fill" pathLength={100} strokeDasharray={`${Math.max(2, p * 100)} 100`} />
          </svg>
          <span className="share-stop" />
        </button>
      ) : (
        <button type="button" className="share-key" aria-label={`${d.state === 'failed' ? 'Try again' : 'Download'} ${name}`} onClick={get}>
          <Icon name={d.state === 'failed' ? 'retry' : 'download'} size={20} />
        </button>
      )}
    </div>
  );
}

/** The agent that checks a turn of `provider`: the other one (a Demo chat checks with Demo). */
export const checkerOf = (p?: ProviderId): ProviderId | undefined => (p === 'claude' ? 'codex' : p === 'codex' ? 'claude' : p === 'demo' ? 'demo' : undefined);
const hasFindings = (text: string) => !!text.trim() && !/^no problems found\.?$/i.test(text.trim());
const findingsMessage = (checker: string, findings: string) => `${checker} reviewed your changes and found:\n\n${findings.trim()}\n\nLook into each finding and fix the ones that hold.`;

/**
 * A turn checked by the other agent, under the turn it checks: its mark and what it does; while it
 * works, the time and a stop; done, its findings in view with one action that puts them in the
 * composer for the chat's own agent. A tap on the line opens the steps it took.
 */
const CheckBlock = memo(function CheckBlock({ sid, id }: { sid: string; id: string }) {
  const it = useItem<ToolItem>(sid, id);
  const [open, setOpen] = useState(false);
  const children = useStore((s) => (open ? sessionData(s, sid).children[id] : undefined));
  const known = useStore((s) => sessionData(s, sid).children[id]?.length ?? 0);
  const now = useSecond(!!it && (it.status === 'running' || it.status === 'pending'));
  const asked = useRef(false);
  const findings = it?.status === 'done' ? (it.result?.text ?? '').trim() : '';
  const html = useMemo(() => (findings ? renderMarkdown(findings, false) : ''), [findings]);
  // The findings stay on the desktop until asked for (a page carries only the step's line).
  useEffect(() => {
    if (!it || it.status !== 'done' || findings || asked.current) return;
    asked.current = true;
    void fetchItem(sid, id).then((r) => applyFull(sid, r.item), () => {});
  }, [it, findings, sid, id]);
  if (!it?.check) return null;
  const who = PROVIDER_NAME[it.check.agent] ?? it.check.agent;
  const live = it.status === 'running' || it.status === 'pending';
  const steps = Math.max(known, (it as PhoneItem).kids ?? 0, it.result?.agent?.steps ?? 0);
  const title = live ? `${who} is checking this turn` : it.status === 'done' ? `${who} checked this turn` : it.status === 'cancelled' ? 'Check stopped' : `${who} could not check this turn`;
  const took = it.endedAt ? it.endedAt - it.ts : live ? now - it.ts : 0;
  const toggle = () => {
    if (!steps) return;
    haptic('select');
    if (!open) void fetchItem(sid, id).then((r) => applyChildren(sid, id, r.children), () => {});
    setOpen((v) => !v);
  };
  return (
    <div className="check" data-status={it.status} data-live={live || undefined} data-open={open || undefined}>
      <div className="check-head">
        <button type="button" className="check-line" aria-expanded={steps ? open : undefined} disabled={!steps} onClick={toggle}>
          <span className="check-mark">{live ? <Tiles size={12} /> : <ProviderMark provider={it.check.agent} size={15} />}</span>
          <span className="check-title">{title}</span>
          {took >= 1000 && <span className="work-meta num">{shortDuration(took)}</span>}
          {steps > 0 && <Icon name="caretDown" size={12} weight="bold" className="work-caret" />}
        </button>
        {live && (
          <button type="button" className="icon-btn sm check-stop" aria-label="Stop the check" onClick={() => (haptic('warning'), void conn.call('turn.checkStop', { sessionId: sid, itemId: id }).catch(() => {}))}>
            <span className="stop-square sm" />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (children?.length ?? 0) > 0 && (
          <motion.div className="run" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={REVEAL}>
            <div className="run-card">
              {children!.slice(-40).map((cid) => (
                <Step key={cid} sid={sid} id={cid} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {findings &&
        (hasFindings(findings) ? (
          <>
            <div className="md check-findings" data-tone="mid" onClick={copyCode} dangerouslySetInnerHTML={{ __html: html }} />
            <button
              type="button"
              className="btn check-fix"
              onClick={() => {
                haptic('select');
                putDraft(sid, findingsMessage(who, findings));
              }}
            >
              <Icon name="edit" size={16} /> Fix these
            </button>
          </>
        ) : (
          <div className="check-clean">
            <Icon name="check" size={14} weight="bold" /> No problems found
          </div>
        ))}
    </div>
  );
});

/** Under the newest settled turn that changed files: the other agent can check it. */
function CheckOffer({ sid, turn }: { sid: string; turn: TurnGroup }) {
  const provider = useStore((s) => s.sessions[sid]?.provider);
  const checker = checkerOf(provider);
  const ready = useStore((s) => (checker ? !!s.providers[checker]?.installed && !!s.providers[checker]?.auth?.loggedIn : false));
  const online = useStore((s) => s.conn === 'open');
  const children = useStore((s) => sessionData(s, sid).children);
  const fileSteps = useStore((s) => sessionData(s, sid).fileSteps);
  // The message that opened the turn (`turn.check` takes it), and what the turn changed, sub-agents' edits included.
  const { opener, changes } = useMemo(() => {
    const items = sessionData(getState(), sid).items;
    return { opener: checkOpener(turn, items), changes: turnChanges(items, children, turn.ids) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, turn, children, fileSteps]);
  const checked = useStore((s) =>
    (turn.checks ?? []).some((x) => {
      const t = sessionData(s, sid).items[x];
      return t?.type === 'tool' && (t.status === 'running' || t.status === 'pending' || t.status === 'done');
    }),
  );
  if (!checker || !ready || !opener || checked) return null;
  // A sub-agent whose steps are not here may have made the change: the desktop says (only when nothing here did).
  if (!changes.files && changes.unknown.length) return <AskedOffer sid={sid} turn={turn} ids={changes.unknown} checker={checker} online={online} />;
  if (!changes.files) return null;
  return <OfferKey sid={sid} turn={turn} checker={checker} online={online} />;
}

/** The offer for a turn whose only edits may be a sub-agent's the phone has not got: shown once the desktop counts a change. */
function AskedOffer({ sid, turn, ids, checker, online }: { sid: string; turn: TurnGroup; ids: string[]; checker: ProviderId; online: boolean }) {
  const key = ids.join();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scope = useMemo(() => ({ sid, items: ids }), [sid, key]);
  const changes = useChanges(scope, true);
  if (!changes.data?.files.length) return null;
  return <OfferKey sid={sid} turn={turn} checker={checker} online={online} />;
}

function OfferKey({ sid, turn, checker, online }: { sid: string; turn: TurnGroup; checker: ProviderId; online: boolean }) {
  const [busy, setBusy] = useState(false);
  const who = PROVIDER_NAME[checker];
  return (
    <button
      type="button"
      className="check-offer"
      disabled={busy || !online}
      onClick={() => {
        haptic('tap');
        setBusy(true);
        void conn
          .call('turn.check', { sessionId: sid, turnId: turn.key })
          .then((r) => !r.ok && r.error && setState({ toast: { text: r.error, level: 'error', at: Date.now() } }))
          .catch((err: Error) => setState({ toast: { text: err.message, level: 'error', at: Date.now() } }))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? <Ring size={13} /> : <ProviderMark provider={checker} size={14} />}
      <span>Check with {who}</span>
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
