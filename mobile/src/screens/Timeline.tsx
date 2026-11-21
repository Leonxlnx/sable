import { AnimatePresence, motion } from 'motion/react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NoticeItem, PhoneItem, ProviderId, TextItem, ThinkingItem, TimelineItem, ToolItem, TurnItem, UntilCheck, UserItem } from '@shared/protocol';
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
import { LINE, type FlowChunk, type Segment, type TurnGroup } from '@m/lib/turns';
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
 * One turn, as the desktop reads it: each segment (your message, what the agent said along the
 * way, one line for the work, the answer), and how it ended when that needs saying.
 */
export const TurnView = memo(function TurnView({ sid, turn, newest }: { sid: string; turn: TurnGroup; newest?: boolean }) {
  const last = turn.segments.length - 1;
  const running = turn.state === 'running';
  return (
    <section className="turn" data-live={running || undefined} data-turn={turn.key}>
      {turn.segments.map((seg, i) => (
        <SegmentView key={seg.key} sid={sid} seg={seg} turn={turn} index={i} live={running && i === last} />
      ))}
      <TurnFoot sid={sid} turn={turn} />
      {turn.checks?.map((id) => (
        <CheckBlock key={id} sid={sid} id={id} />
      ))}
      {newest && <CheckOffer sid={sid} turn={turn} />}
    </section>
  );
});

/** Under a turn: an interruption, or an error the turn ended with that no notice showed. */
function TurnFoot({ sid, turn }: { sid: string; turn: TurnGroup }) {
  const end = useItem<TurnItem>(sid, turn.end);
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

/**
 * A segment as it reads: the message, each thing the agent says in order (reports, the answer and a
 * steered message's reply, all at full strength; only thinking sits back), and one line for the work: live
 * while it runs (what it does now, the time, how many steps), the summary once it settled. A tap
 * on the line opens every run of steps in its place between the texts.
 */
const SegmentView = memo(function SegmentView({ sid, seg, turn, index, live }: { sid: string; seg: Segment; turn: TurnGroup; index: number; live: boolean }) {
  const [open, setOpen] = useState(false);
  const hasWork = seg.work.length > 0;
  const toggle = hasWork
    ? () => {
        haptic('select');
        setOpen((v) => !v);
      }
    : undefined;
  const shown = open && hasWork;
  const at = seg.flow.indexOf(LINE);
  const piece = (c: FlowChunk) => {
    if (c.kind === 'line') return null;
    if (c.kind === 'steps') return <Run key={`s:${c.key}`} sid={sid} ids={c.ids} open={shown} />;
    if (c.kind === 'show') return <Show key={c.id} sid={sid} id={c.id} />;
    return <Answer key={c.id} sid={sid} id={c.id} tone={c.id === seg.answer || c.id === seg.reply ? 'answer' : 'mid'} />;
  };
  return (
    <>
      {seg.lead && <UserBubble sid={sid} id={seg.lead} steered={seg.steered} />}
      {(at < 0 ? seg.flow : seg.flow.slice(0, at)).map(piece)}
      {at >= 0 && (
        <div className="seg-work">
          <WorkHead sid={sid} seg={seg} turn={turn} index={index} live={live} open={shown} onToggle={toggle} />
          {seg.flow.slice(at + 1).map(piece)}
        </div>
      )}
      {seg.errors.map((id) => (
        <Notice key={id} sid={sid} id={id} />
      ))}
    </>
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
  if (it.type === 'notice') return <div className="step-text step-note">{it.text}</div>;
  // What a command printed, in the work: its line (shown by the bubble's own reading).
  if (it.type === 'user') return <UserBubble sid={sid} id={id} />;
  return <Step sid={sid} id={id} />;
});

/** In view in its place: command output, a widget, a plan. */
function Show({ sid, id }: { sid: string; id: string }) {
  const it = useItem<TimelineItem>(sid, id);
  if (!it) return null;
  if (it.type === 'notice') return <Notice sid={sid} id={id} />;
  if (it.type === 'tool' && it.kind === 'plan') return <PlanBlock sid={sid} it={it} />;
  if (it.type === 'tool' && it.kind === 'share') return <ShareCards sid={sid} it={it} />;
  return <Block sid={sid} id={id} />;
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

/** The work line in its place: live while the segment runs, the summary once it settled. */
function WorkHead({ sid, seg, turn, index, live, open, onToggle }: { sid: string; seg: Segment; turn: TurnGroup; index: number; live: boolean; open: boolean; onToggle?: () => void }) {
  const hasWork = seg.work.length > 0;
  const was = useRef(live);
  const [landed, setLanded] = useState(false);
  useLayoutEffect(() => {
    const ended = was.current && !live;
    was.current = live;
    if (!ended || !hasWork || reduced()) return;
    setLanded(true);
    const t = window.setTimeout(() => setLanded(false), 700);
    return () => window.clearTimeout(t);
  }, [live, hasWork]);
  if (!live && !hasWork) return null;
  return live ? <LiveLine sid={sid} seg={seg} open={open} onToggle={onToggle} /> : <WorkLine sid={sid} seg={seg} turn={turn} index={index} open={open} onToggle={onToggle} landed={landed} />;
}

/** Start to end of a settled segment (ms), or null. */
function segmentSpan(items: Record<string, TimelineItem>, turn: TurnGroup, index: number): number | null {
  const seg = turn.segments[index];
  const first = seg.flow.find((c): c is Exclude<FlowChunk, { kind: 'line' }> => c.kind !== 'line');
  const firstId = !first ? '' : first.kind === 'steps' ? first.ids[0] : first.id;
  const start = (seg.lead ? items[seg.lead]?.ts : undefined) ?? items[firstId]?.ts;
  if (!start) return null;
  const nextLead = turn.segments[index + 1]?.lead;
  if (nextLead && items[nextLead]) return items[nextLead].ts - start;
  const end = turn.end ? items[turn.end] : undefined;
  if (end?.type === 'turn') {
    const wall = end.ts - start;
    if (turn.segments.length === 1 && end.durationMs > wall) return end.durationMs;
    return wall;
  }
  let last = start;
  for (const id of seg.work) {
    const it = items[id];
    if (it) last = Math.max(last, it.ts, ('endedAt' in it && it.endedAt) || 0);
  }
  return last - start;
}

/** "Worked 12s · 20 steps", and the change: the folded work of a settled segment. The change opens what it changed. */
function WorkLine({ sid, seg, turn, index, open, onToggle, landed }: { sid: string; seg: Segment; turn: TurnGroup; index: number; open: boolean; onToggle?: () => void; landed: boolean }) {
  const { span, add, del, thought, edits, files } = useMemo(() => {
    const items = sessionData(getState(), sid).items;
    let a = 0;
    let d = 0;
    const paths = new Set<string>();
    // The steps that change files (and sub-agents, whose own steps may): the desktop gathers this segment's changes from them.
    const steps: string[] = [];
    for (const id of seg.work) {
      const it = items[id];
      if (it?.type !== 'tool') continue;
      for (const f of it.result?.diff ?? []) (a += f.additions), (d += f.deletions), paths.add(f.path);
      if (it.kind === 'edit' || it.kind === 'write' || it.kind === 'agent') steps.push(id);
    }
    return { span: segmentSpan(items, turn, index), add: a, del: d, thought: !seg.steps && seg.work.some((id) => items[id]?.type === 'thinking'), edits: steps, files: paths.size };
  }, [sid, turn, index, seg]);
  const took = span && span >= 1000 ? shortDuration(span) : '';
  return (
    <div className="work" data-landed={landed || undefined} data-open={open || undefined}>
      <button type="button" className="work-line" aria-expanded={open} onClick={onToggle}>
        <span className="work-title">{thought ? (took ? `Thought for ${took}` : 'Thought') : took ? `Worked ${took}` : 'Worked'}</span>
        {seg.steps > 0 && <span className="work-meta num">{plural(seg.steps, 'step')}</span>}
        <Icon name="caretDown" size={12} weight="bold" className="work-caret" />
      </button>
      {(add > 0 || del > 0) && (
        <button
          type="button"
          className="work-changes"
          aria-label={`Changes in this turn: ${plural(files, 'file')}, ${add} added, ${del} removed`}
          onClick={() => {
            haptic('tap');
            nav.push({ name: 'changes', id: sid, items: edits, ...(seg.lead ? { lead: seg.lead } : {}) });
          }}
        >
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

/** The newest lead-in since the agent last said something in view, while the steps it announced run; else ''. */
function currentLead(items: Record<string, TimelineItem>, seg: Segment): string {
  const id = seg.narr[seg.narr.length - 1];
  const it = id ? items[id] : undefined;
  if (it?.type !== 'text' || it.streaming) return '';
  const at = seg.work.lastIndexOf(id);
  let ended = Infinity;
  for (let i = at + 1; i < seg.work.length; i++) {
    const step = items[seg.work[i]];
    if (!step) continue;
    if (step.type !== 'tool' || step.ts > ended) return '';
    if (step.endedAt) ended = Math.min(ended, step.endedAt);
  }
  return leadTitle(it.text);
}

/** What the running segment does right now, as `${waiting}|${title}` (a string, so the line renders only when it changes). */
function liveSelector(sid: string, seg: Segment, held: { title: string }) {
  const pieces: string[] = [];
  for (let i = seg.flow.length - 1; i >= 0 && pieces.length < 4; i--) {
    const c = seg.flow[i];
    if (c.kind === 'text' || c.kind === 'show') pieces.push(c.id);
  }
  return (s: State): string => {
    const d = s.data[sid];
    const meta = s.sessions[sid];
    if (!d || !meta) return '0|Working';
    let waiting = meta.status === 'awaiting' || d.permissions.length > 0 || d.questions.length > 0;
    let title = '';
    let agents = 0;
    let recent = '';
    let writing = false;
    for (let i = seg.work.length - 1, n = 0; i >= 0 && n < 60; i--, n++) {
      const it = d.items[seg.work[i]];
      if (!it) continue;
      if (it.type === 'tool' && (it.status === 'running' || it.status === 'pending' || it.status === 'awaiting')) {
        if (it.status === 'awaiting') waiting = true;
        if (it.kind === 'agent') agents++;
        if (!title) title = it.title;
      } else if (it.type === 'thinking' && it.streaming && !title) title = thinkingHeadline((it as ThinkingItem).text) || 'Thinking';
      else if (n === 0 && it.type === 'text' && it.streaming) writing = true;
      else if (n === 0 && it.type === 'tool' && it.endedAt && Date.now() - it.endedAt < RECENT_MS) recent = it.title;
    }
    if (agents > 1) title = `Running ${agents} sub-agents`;
    else if (writing && held.title) title = held.title;
    else title = currentLead(d.items, seg) || title;
    for (const id of pieces) {
      if (title) break;
      const it = d.items[id];
      if (it?.type === 'tool' && (it.status === 'pending' || it.status === 'running')) title = it.title;
      else if (it?.type === 'text' && it.streaming) title = 'Writing';
    }
    if (!title) title = recent || (meta.status === 'starting' ? 'Starting' : meta.activity || 'Working');
    held.title = title;
    return `${waiting ? 1 : 0}|${title}`;
  };
}

/**
 * The running segment's one line: the working tiles, what it does now (the agent's own words while
 * the steps it announced run), the time so far and how many steps. It stays in view under the
 * header while what the agent says grows past the top. Waiting on you, it stills in amber.
 */
function LiveLine({ sid, seg, open, onToggle }: { sid: string; seg: Segment; open: boolean; onToggle?: () => void }) {
  const [last] = useState(() => ({ title: '' }));
  const info = useStore(useMemo(() => liveSelector(sid, seg, last), [sid, seg, last]));
  const lead = useItem<TimelineItem>(sid, seg.lead ?? seg.work[0]);
  const now = useSecond(true);
  const cut = info.indexOf('|');
  const waiting = info.slice(0, cut) === '1';
  const title = useHeld(info.slice(cut + 1), TITLE_HOLD_MS);
  const elapsed = lead ? now - lead.ts : 0;
  const tiles = useMemo(() => <Tiles size={13} />, []);
  return (
    <div className="work" data-live data-waiting={waiting || undefined} data-open={open || undefined} role="status" aria-live="off">
      <button type="button" className="work-line" aria-expanded={onToggle ? open : undefined} onClick={onToggle} disabled={!onToggle}>
        <span className="work-ind">{waiting ? <StatusMark tone="awaiting" size={11} /> : tiles}</span>
        {/* No shimmer: it paints on every frame of the turn; the tiles beside it say it works. */}
        <span key={waiting ? '\u0000' : title} className="work-title">
          {waiting ? 'Waiting for you' : title}
        </span>
        {elapsed >= 1000 && <span className="work-meta num">{shortDuration(elapsed)}</span>}
        {seg.steps > 0 && <span className="work-meta num">{plural(seg.steps, 'step')}</span>}
        {onToggle && <Icon name="caretDown" size={12} weight="bold" className="work-caret" />}
      </button>
    </div>
  );
}

/** A root item outside any turn (a /until loop's end, a queued message, a page that starts mid-turn). */
export const ItemRow = memo(function ItemRow({ sid, id, queued }: { sid: string; id: string; queued?: boolean }) {
  const it = useItem<TimelineItem>(sid, id);
  if (!it) return null;
  if (it.type === 'user') return <UserBubble sid={sid} id={id} queued={queued} />;
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
  return null;
});

const UserBubble = memo(function UserBubble({ sid, id, steered, queued }: { sid: string; id: string; steered?: boolean; queued?: boolean }) {
  const it = useItem<UserItem>(sid, id);
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
  const [open, setOpen] = useState(false);
  // The desktop keeps a step's output and change: asked for when the step opens.
  const [full, setFull] = useState<ToolItem>();
  if (!it) return null;
  if (it.type === 'thinking') return <ThinkingStep sid={sid} it={it} quiet={quiet} />;
  if (it.type === 'text') return <div className="step-text">{inlineCode(it.text.length > 280 ? `${it.text.slice(0, 280)}…` : it.text)}</div>;
  if (it.type !== 'tool') return null;
  const more = !!(it as PhoneItem).more;
  const detail = toolDetail(full ?? it);
  const status = it.status;
  const toggle = () => {
    if (quiet || !(detail || more)) return;
    haptic('select');
    if (more && !full && !open) void fetchItem(sid, id).then((r) => setFull(r.item as ToolItem), () => {});
    setOpen((v) => !v);
  };
  return (
    <div className="step" data-status={status} data-open={open || undefined}>
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
  const [open, setOpen] = useState(false);
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
  const d = it.detail;
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
  if (!it) return null;
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
  const name = it.detail.subagent || it.title;
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
        {it.detail.description && it.detail.description !== name && <span className="block-desc">{it.detail.description}</span>}
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
  const n = it.name.toLowerCase();
  if (n.includes('delegate_to_codex') || it.detail.subagent === 'Codex') return 'codex';
  if (n.includes('delegate_to_claude') || it.detail.subagent === 'Claude Code') return 'claude';
  return undefined;
}

const statusWord = (s: string) => (s === 'running' ? 'Running' : s === 'done' ? 'Done' : s === 'failed' ? 'Failed' : 'Stopped');

const Notice = memo(function Notice({ sid, id }: { sid: string; id: string }) {
  const it = useItem<NoticeItem>(sid, id);
  const provider = useStore((s) => s.sessions[sid]?.provider);
  const accounts = useStore((s) => (provider ? s.providers[provider]?.accounts : undefined));
  const [busy, setBusy] = useState(false);
  if (!it) return null;
  // What a command printed, standing for its turn: a line under the command's (Synthetic.tsx).
  if ((it as TimelineItem).type === 'user') return <UserBubble sid={sid} id={id} />;
  // At a plan limit: carry on with the account the desktop suggests (the refused message goes again).
  const next = it.limit?.next && !it.limit.continuedWith ? accounts?.find((a) => a.id === it.limit!.next && a.auth.loggedIn) : undefined;
  if (it.limit) return <LimitCard sid={sid} it={it} next={next} went={it.limit.continuedWith ? (accounts?.find((a) => a.id === it.limit!.continuedWith)?.label ?? 'another account') : undefined} />;
  if (it.until) return <UntilEnd it={it} />;
  if (it.agentSwitch) return <AgentSwitchLine sid={sid} it={it} />;
  return (
    <div className="notice" data-variant={it.variant}>
      {it.variant === 'error' ? <span className="notice-dot" aria-hidden /> : <span className="notice-rule" aria-hidden />}
      <span className="notice-body">
        {it.text}
        {it.detail && <span className="notice-detail"> · {it.detail}</span>}
        {next && (
          <button
            type="button"
            className="btn btn-sm notice-action"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              haptic('send');
              void conn.call('session.switchAccount', { sessionId: sid, accountId: next.id, retry: true }).finally(() => setBusy(false));
            }}
          >
            Continue with {next.label}
          </button>
        )}
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
  return (
    <div className="limit-card">
      <div className="limit-card-head">
        <StatusMark tone="awaiting" size={12} />
        <span className="limit-card-title">{l.window ? `${l.window} reached` : it.text}</span>
        {l.resetsAt && <span className="limit-card-reset num">{resetIn(l.resetsAt, now)}</span>}
      </div>
      {it.detail && <div className="limit-card-detail">{it.detail}</div>}
      {next && (
        <button
          type="button"
          className="btn btn-primary btn-block limit-card-go"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            haptic('send');
            void conn.call('session.switchAccount', { sessionId: sid, accountId: next.id, retry: true }).finally(() => setBusy(false));
          }}
        >
          {busy ? <span className="dots" /> : `Continue with ${next.label}`}
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
  const it = useItem<TextItem>(sid, id);
  const streaming = !!it?.streaming;
  const html = useMemo(() => (it && !it.streaming ? renderMarkdown(it.text) : ''), [it]);
  const box = useRef<HTMLDivElement>(null);
  useStreamed(box, it?.text ?? '', streaming);
  const [busy, setBusy] = useState(false);
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
  const files = it.detail.files ?? [];
  const caption = it.detail.caption?.trim();
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
  const changed = useMemo(() => {
    const items = sessionData(getState(), sid).items;
    return turn.ids.some((x) => {
      const t = items[x];
      return t?.type === 'tool' && (!!t.result?.diff?.length || ((t.kind === 'edit' || t.kind === 'write') && t.status === 'done'));
    });
  }, [sid, turn]);
  const checked = useStore((s) =>
    (turn.checks ?? []).some((x) => {
      const t = sessionData(s, sid).items[x];
      return t?.type === 'tool' && (t.status === 'running' || t.status === 'pending' || t.status === 'done');
    }),
  );
  const [busy, setBusy] = useState(false);
  if (!checker || !ready || !changed || checked || turn.state !== 'done') return null;
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
