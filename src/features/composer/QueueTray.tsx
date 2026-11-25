import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion, Reorder, useDragControls, useReducedMotion } from 'motion/react';
import type { QueuedMessage } from '@shared/protocol';
import { Icon } from '@/icons';
import { Tip } from '@/ui';
import { dissolve, ghostOf } from '@/lib/dissolve';
import { play, reducedMotion } from '@/lib/motion';
import { acknowledgedOrder, bindRow, keyOf, rowActs, rowDelivery, withExpected, type ExpectedRow } from './queue-rows';
import { landInTray, launchFromTray } from './flight';
import { STACK_EASE, STACK_MS, aboveTray, clearFor, glideY, rowMoves, trayShare } from './stack-glide';
import { removeQueued, reorderQueue, sendQueuedNow } from '@/state/actions';
import { useStore } from '@/state/store';

const NONE: QueuedMessage[] = [];
const NOBODY: ReadonlySet<string> = new Set();
/** Rows the person removed or took back to edit: they leave without flying. */
const gone = new Set<string>();
export const NO_QUEUE = NONE;

const firstLine = (t: string) => t.split('\n').find((l) => l.trim())?.trim() ?? '';

// ── a row in place at the press ──
// A message queued from the composer has its row in the tray in the frame of the press, before
// the bridge has it: the dock takes its final layout at once and the words fly into a row that is
// there (they stood over the last row, or over nothing, for the bridge's round trip). When the
// bridge's row comes it takes the same element (keyed by submission); a refusal takes the row away again.

const expected = new Map<string, ExpectedRow[]>();
const expectWatch = new Set<() => void>();
const NO_EXPECT: ExpectedRow[] = [];
const deferredOrders = new Map<string, QueuedMessage[]>();

function commitOrder(sessionId: string, order: QueuedMessage[], queue: QueuedMessage[]) {
  const ids = acknowledgedOrder(order, queue);
  if (!ids) {
    deferredOrders.set(sessionId, order);
    return;
  }
  deferredOrders.delete(sessionId);
  if (ids.some((id, i) => id !== queue[i]?.id)) void reorderQueue(sessionId, ids);
}

const expectChanged = () => {
  for (const f of expectWatch) f();
};
const watchExpected = (f: () => void) => {
  expectWatch.add(f);
  return () => void expectWatch.delete(f);
};
const dropExpected = (sessionId: string, pid: string) => {
  const list = expected.get(sessionId);
  if (!list?.some((e) => e.pid === pid)) return;
  const next = list.filter((e) => e.pid !== pid);
  if (next.length) expected.set(sessionId, next);
  else expected.delete(sessionId);
  expectChanged();
};

/**
 * A message is being queued in `sessionId`: its row stands in the tray from now on. Call the
 * returned function with the bridge's answer: taken, the bridge's row takes this one's place (or,
 * not in the queue at all, it simply goes); refused, the row goes.
 */
export function expectQueued(sessionId: string, text: string, submitId: string): (ok: boolean) => void {
  const e: ExpectedRow = { pid: 'expect:' + submitId, text, submitId };
  expected.set(sessionId, [...(expected.get(sessionId) ?? NO_EXPECT), e]);
  expectChanged();
  const stop = useStore.subscribe((s, prev) => {
    const queue = s.data[sessionId]?.queue;
    if (!e.bound && queue && queue !== prev.data[sessionId]?.queue) e.bound = bindRow(e, queue);
  });
  return () => {
    stop();
    dropExpected(sessionId, e.pid);
    const order = deferredOrders.get(sessionId);
    if (!order) return;
    const queue = useStore.getState().data[sessionId]?.queue ?? NONE;
    // A refused or already delivered submission no longer participates in the reorder.
    const real = queue.find(q => q.submitId === submitId);
    commitOrder(sessionId, order.flatMap(q => q.id === e.pid ? real ?? [] : q), queue);
  };
}

// ── a row taken back to edit ──
// The row leaves in the frame of the click (its words go into the field on the same clock,
// Composer `editQueued`), before the bridge has given the message back: a row that waited for that
// round trip vanished and its words came into the field a frame later. A refusal brings it back.
const taking = new Map<string, ReadonlySet<string>>();

/** The row `id` of `sessionId` is being taken back into the field; the returned function lets it show again (if still queued). */
export function takeBackRow(sessionId: string, id: string): () => void {
  gone.add(id);
  const next = new Set(taking.get(sessionId) ?? NOBODY);
  next.add(id);
  taking.set(sessionId, next);
  expectChanged();
  return () => {
    const now = taking.get(sessionId);
    if (!now?.has(id)) return;
    const rest = new Set(now);
    rest.delete(id);
    if (rest.size) taking.set(sessionId, rest);
    else taking.delete(sessionId);
    if (useStore.getState().data[sessionId]?.queue.some((q) => q.id === id)) gone.delete(id);
    expectChanged();
  };
}

const isProvisional = (id: string) => id.startsWith('expect:');

/** Rows settling after a drag or a move by keys (motion's own layout slide). */
const ROW = { type: 'spring' as const, stiffness: 520, damping: 38 };
/** How long the words of a row that leaves with the tray take to go (ms). */
const WORDS_OUT = 140;
/**
 * How long a removed row's words take to go while the row above comes down into its place (ms):
 * gone before that row's words reach them (`clearFor`: a 28 px row, 13 px of ink at 13 px type,
 * about 43 ms). At 80 ms the two lines read over each other for two or three frames.
 */
const WORDS_GONE = Math.max(16, Math.round(clearFor(28, 13)));

/** The tray's section (an exiting one may still stand beside a new one for a frame). */
const trayOf = (clip: HTMLElement) => [...clip.querySelectorAll<HTMLElement>(':scope > .cq')].find((el) => el.style.display !== 'none') ?? null;
const rowsOf = (clip: HTMLElement) => [...clip.querySelectorAll<HTMLElement>('[data-qrow]')].filter((el) => el.style.display !== 'none');

/** Each row's distance from the tray's lower edge, and the tray's height (0: not there). Reads only. */
function readTray(clip: HTMLElement): { height: number; rows: Map<string, number> } {
  const rows = new Map<string, number>();
  const cq = clip.style.display === 'none' ? null : trayOf(clip);
  if (!cq) return { height: 0, rows };
  const list = cq.querySelector<HTMLElement>('.cq-list');
  const h = cq.offsetHeight;
  for (const r of rowsOf(clip)) {
    const id = r.getAttribute('data-qid');
    if (id && list) rows.set(id, h - (list.offsetTop + r.offsetTop));
  }
  return { height: clip.offsetHeight, rows };
}

/**
 * The tray's rows changed (one came, left, was removed or taken back): the layout is already
 * final; everything is drawn where it stood and glides home on the dock's one clock
 * (`stack-glide.ts`): the tray by its change of height, the rows that stay by what is left of
 * their own move, a removed row's dead copy held where it was, and the strips and prompt cards
 * above by what the dock's height changed. The list does not clip meanwhile (a row held still at
 * its lower edge would be cut), unless it scrolls.
 */
function glideTray(clip: HTMLElement, was: { height: number; rows: Map<string, number> }, now: { height: number; rows: Map<string, number> }) {
  const cq = trayOf(clip);
  if (!cq || reducedMotion()) return;
  const m = rowMoves(was.rows, now.rows, was.height, now.height);
  const share = trayShare(now.height) - trayShare(was.height);
  if (Math.abs(m.tray) < 0.5 && !m.rows.size) return;
  const t = performance.now();
  const list = cq.querySelector<HTMLElement>('.cq-list');
  const open = list && list.scrollHeight <= list.clientHeight + 1;
  if (open) list.style.overflow = 'visible';
  const edge = glideY(cq, m.tray, t);
  for (const r of rowsOf(clip)) {
    const own = m.rows.get(r.getAttribute('data-qid') ?? '');
    if (own) glideY(r, own, t);
  }
  // A removed row's copy stands still where the row was: against the tray's glide.
  for (const g of clip.querySelectorAll<HTMLElement>('[data-qghost]')) {
    g.removeAttribute('data-qghost');
    glideY(g, -m.tray, t);
    // Its words are gone before the row coming down into its place reaches them (the rows have no
    // fill of their own: the two lines read over each other for a few frames).
    play(g.firstElementChild, [{ opacity: 1 }, { opacity: 0 }], { duration: WORDS_GONE, easing: 'ease-out', fill: 'forwards' });
  }
  if (Math.abs(share) > 0.5) for (const el of aboveTray(clip)) glideY(el, share, t);
  if (edge && open && list) {
    const done = () => {
      if (!cq.getAnimations().some((a) => a !== edge && a.playState === 'running')) list.style.overflow = '';
    };
    edge.finished.then(done, done);
  }
}

/**
 * The tray empties: it goes down into the pane as one piece, the head with its last row. A dead
 * copy (`ghostOf`, held by its lower edge) slides down by what the tray added to the dock while
 * the tray itself is out of the layout in this frame, so the strips above and the conversation
 * (Timeline.tsx, the dock's shorter branch) come down with it on the same clock. A row whose words
 * are still in it (removed by hand, taken back to edit) lets them go first.
 */
function foldTray(clip: HTMLElement, height: number, fade: boolean) {
  const share = trayShare(height);
  const ghost = reducedMotion() ? null : ghostOf(clip, { anchor: 'bottom' });
  clip.style.display = 'none';
  if (!ghost) return;
  const copy = ghost.firstElementChild as HTMLElement | null;
  const t = performance.now();
  // (Words that already flew out of the row are hidden in it, and stay so in the copy.)
  if (fade) for (const w of ghost.querySelectorAll<HTMLElement>('.cq-text')) if (w.style.opacity !== '0') play(w, [{ opacity: 1 }, { opacity: 0 }], { duration: WORDS_OUT, easing: 'ease-out', fill: 'forwards' });
  const slide = copy ? play(copy, [{ translate: '0 0' }, { translate: `0 ${share}px` }], { duration: STACK_MS, easing: STACK_EASE, fill: 'forwards' }) : null;
  for (const el of aboveTray(clip)) glideY(el, -share, t);
  const off = () => ghost.remove();
  if (slide) slide.finished.then(off, off);
  else off();
}

export interface QueueTrayProps {
  sessionId: string;
  queue: QueuedMessage[];
  running: boolean;
  steerable: boolean;
  /** Puts a queued message into the composer (swapping with the draft when there is one). */
  onEdit: (q: QueuedMessage) => void;
  onFocusComposer: () => void;
}

/**
 * Messages sent while the agent works, held by the bridge until the turn ends. A tray tucked
 * behind the composer's top edge: numbered one-line rows, drag (or Alt+Arrow) to reorder, and
 * per-row actions on hover or focus.
 */
export const QueueTray = memo(function QueueTray({ sessionId, queue, running, steerable, onEdit, onFocusComposer }: QueueTrayProps) {
  const reduced = useReducedMotion();
  // Words from the composer land on a new row; a row the agent takes (or that is sent now) flies
  // up to the conversation. Rows removed or taken back to edit just go. Read here, not in the
  // tray's body: a tray that empties keeps its last rows on screen while it folds away.
  const clip = useRef<HTMLDivElement>(null);
  // Removed by the person: out of the tray in the frame of the click, before the bridge has said so
  // (the row broke up where it stood and the tray closed some hundred ms later, in steps). A
  // removal the bridge did not take brings the row back.
  const [left, setLeft] = useState(NOBODY);
  // A row that comes back is a new element (its key counts its returns): the one that left may still
  // be in the page, hidden and folding away, and would have come back unseen.
  const lives = useRef(new Map<string, number>());
  const provisional = useStore(s => s.data[sessionId]?.provisional);
  const held = useRef(queue);
  held.current = queue;
  const leave = useCallback((id: string, on: boolean) => {
    if (!on) {
      if (held.current.some((q) => q.id === id)) {
        // Still in the queue: the bridge did not take the removal. The row comes back, and when the
        // agent takes it later it flies as any row.
        lives.current.set(id, (lives.current.get(id) ?? 0) + 1);
        gone.delete(id);
      } else lives.current.delete(id);
    }
    setLeft((prev) => {
      if (prev.has(id) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const waiting = useSyncExternalStore(watchExpected, () => expected.get(sessionId) ?? NO_EXPECT);
  const all = useMemo(() => withExpected(queue, waiting), [queue, waiting]);
  const takingNow = useSyncExternalStore(watchExpected, () => taking.get(sessionId) ?? NOBODY);
  const shown = left.size || takingNow.size ? all.filter((q) => !left.has(q.id) && !takingNow.has(q.id)) : all;
  const shownKey = shown.map((q) => q.id).join('\n');
  // The rows' elements on screen after the last commit (a bridge row keeps its provisional row's).
  const landed = useRef<ReadonlySet<string>>(new Set());
  const before = useRef<QueuedMessage[]>(NONE);
  const beforeSession = useRef(sessionId);
  // Where the tray and its rows stood after the last commit (`readTray`): what the next change glides from.
  const geo = useRef<{ height: number; rows: Map<string, number> }>({ height: 0, rows: new Map() });
  useLayoutEffect(() => {
    const host = clip.current;
    const prev = before.current;
    before.current = queue;
    // Another chat's queue (a switch): its rows neither land nor leave here, and nothing glides.
    const same = beforeSession.current === sessionId;
    beforeSession.current = sessionId;
    if (!host) return;
    const keys = new Set(shown.map((q) => keyOf(q)));
    const wasKeys = landed.current;
    landed.current = keys;
    if (!same) {
      host.style.display = shown.length ? '' : 'none';
      geo.current = readTray(host);
      return;
    }
    // (The row itself, never one removed by hand that is still folding away, hidden.)
    const textOf = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-qid="${CSS.escape(id)}"]`)].find((el) => el.style.display !== 'none')?.querySelector<HTMLElement>('.cq-text') ?? null;
    // A row that is new on screen (a provisional row at the press, or one from elsewhere): words in the air land in it.
    for (const q of shown) {
      if (wasKeys.has(keyOf(q))) continue;
      const el = textOf(q.id);
      if (el) landInTray(el, q.text, sessionId, q.submitId ?? q.id);
    }
    if (prev !== queue) {
      const now = new Set(queue.map((q) => q.id));
      for (const q of prev) {
        if (now.has(q.id) || gone.delete(q.id)) continue;
        const el = textOf(q.id);
        if (el) launchFromTray(el, q.text, sessionId, q.submitId ?? q.id);
      }
    }
    const was = geo.current;
    if (!shown.length) {
      // The tray empties: it folds into the pane in one piece (an exiting section still stands).
      if (host.style.display !== 'none' && was.height > 0) foldTray(host, was.height, true);
      else host.style.display = 'none';
      geo.current = { height: 0, rows: new Map() };
      return;
    }
    host.style.display = '';
    // A row that left goes out of the layout in this frame (motion would hold its place until its
    // exit ends). One whose words are still in it (taken back to edit, removed elsewhere) breaks into
    // the tray's dither where it stood, as a removal by hand does.
    const ids = new Set(shown.map((q) => q.id));
    const first = trayOf(host)?.querySelector<HTMLElement>('.cq-list')?.firstElementChild;
    for (const r of host.querySelectorAll<HTMLElement>('[data-qrow]')) {
      if (ids.has(r.getAttribute('data-qid') ?? '') || r.style.display === 'none') continue;
      const words = r.querySelector<HTMLElement>('.cq-text');
      if (words && words.style.opacity !== '0' && first instanceof HTMLElement && !reducedMotion()) dissolve(r, { ground: '--panel', anchor: 'bottom', before: first })?.ghost.setAttribute('data-qghost', '');
      r.style.display = 'none';
    }
    const now = readTray(host);
    glideTray(host, was, now);
    geo.current = now;
  }, [queue, shownKey, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="cq-clip" ref={clip} inert={provisional}>
      <AnimatePresence initial={false}>
        {shown.length > 0 && (
          <motion.section
            key="tray"
            className="cq"
            data-spot
            aria-label="Queued messages"
            // The tray's own motion is the dock's glide (`glideTray`, `foldTray`): nothing here moves it.
            exit={{ opacity: 1, transition: { duration: 0 } }}
          >
            <TrayBody sessionId={sessionId} queue={shown} held={queue} lives={lives.current} running={running} steerable={steerable} onEdit={onEdit} onFocusComposer={onFocusComposer} reduced={!!reduced} onLeave={leave} />
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
});

function TrayBody({ sessionId, queue, held, lives, running, steerable, onEdit, onFocusComposer, reduced, onLeave }: QueueTrayProps & { held: QueuedMessage[]; lives: ReadonlyMap<string, number>; reduced: boolean; onLeave: (id: string, on: boolean) => void }) {
  // While a row is dragged the order is local; it goes to the bridge when the row is dropped.
  const [order, setOrder] = useState(queue);
  const dragging = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!dragging.current) setOrder(queue);
  }, [queue]);

  // The list the bridge has, in the order shown (a message that left mid-drag is dropped).
  const live = new Set(queue.map((q) => q.id));
  const rows = order.filter((q) => live.has(q.id)).map((q) => queue.find((x) => x.id === q.id) ?? q);
  for (const q of queue) if (!rows.some((r) => r.id === q.id)) rows.push(q);
  const shown = useRef(rows);
  shown.current = rows;
  // When motion measures the rows for its own slides: only a change of order among the same rows
  // (a drag, a move by keys). A row that comes or goes is the dock's glide (`glideTray`), and two
  // slides would add up.
  const measured = useRef({ set: '', measure: '' });
  const ids = rows.map((q) => q.id);
  const set = [...ids].sort().join();
  if (set !== measured.current.set) measured.current = { set, measure: measured.current.measure };
  else measured.current.measure = ids.join();
  const measure = measured.current.measure;
  const commit = (next: QueuedMessage[]) => commitOrder(sessionId, next, held);

  const focusRow = (i: number) => {
    window.requestAnimationFrame(() => {
      // (A row removed by hand is out of the layout but still in the page for a moment.)
      const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-qrow]') ?? [])].filter((el) => el.style.display !== 'none');
      const el = els[Math.min(i, els.length - 1)];
      if (el) el.focus({ preventScroll: true });
      else onFocusComposer();
    });
  };

  // The row breaks into the tray's own dither where it stood and is out of the list in this frame,
  // so the tray closes on the click (the tray's layout effect glides it, `glideTray`). Its dead copy
  // (`lib/dissolve.ts`) is held by the list's lower edge and stands under the rows: one that comes
  // down into its place covers it. The last row is not taken out alone: the tray folds into the
  // pane with it (`foldTray`), its words going on the way.
  const remove = (q: QueuedMessage, i: number, el: Element | null) => {
    gone.add(q.id);
    const focused = !!el?.contains(document.activeElement);
    const list = listRef.current;
    const row = el instanceof HTMLElement ? el : null;
    const first = list?.firstElementChild;
    const last = rows.length <= 1;
    if (row && !last) {
      const leaving = first instanceof HTMLElement && !reducedMotion() ? dissolve(row, { ground: '--panel', anchor: 'bottom', before: first }) : null;
      leaving?.ghost.setAttribute('data-qghost', '');
      row.style.display = 'none';
    }
    onLeave(q.id, true);
    void removeQueued(sessionId, q.id)
      .then((res) => {
        // Gone from the queue but not removed: the agent took it between the row and the click.
        if (res && res.ok === false && !shown.current.some((x) => x.id === q.id)) useStore.getState().toast('That message had already gone out.');
      })
      .finally(() => window.setTimeout(() => onLeave(q.id, false), 600));
    if (focused) focusRow(i);
  };

  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
    commit(next);
    focusRow(j);
  };

  return (
    <>
      {/* The words of the head and of every row start where the field's own words do (16 in). A
          word and no number: the rows themselves say how many. */}
      <div className="cq-head">
        <span className="cq-title">Queued</span>
      </div>
      <Reorder.Group as="ul" axis="y" values={rows} onReorder={setOrder} className="cq-list scroll" ref={listRef} role="list">
        <AnimatePresence initial={false}>
          {rows.map((q, i) => (
            <Row
              key={`${keyOf(q)}/${lives.get(q.id) ?? 0}`}
              q={q}
              i={i}
              count={rows.length}
              running={running}
              steerable={steerable}
              reduced={reduced}
              measure={measure}
              onDragStart={() => (dragging.current = true)}
              onDragEnd={() => {
                dragging.current = false;
                commit(shown.current);
              }}
              onSend={() => void sendQueuedNow(sessionId, q.id)}
              onEdit={() => {
                gone.add(q.id);
                onEdit(q);
              }}
              onRemove={(el) => remove(q, i, el)}
              onKey={(e) => {
                if (e.target !== e.currentTarget || isProvisional(q.id)) return;
                // (Live rows only: one removed by hand is still in the page for a moment, hidden.)
                const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-qrow]') ?? [])].filter((el) => el.style.display !== 'none');
                const at = els.indexOf(e.currentTarget);
                if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                  e.preventDefault();
                  move(i, e.key === 'ArrowUp' ? -1 : 1);
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  els[((at < 0 ? i : at) + (e.key === 'ArrowDown' ? 1 : els.length - 1)) % els.length]?.focus();
                } else if (e.key === 'Enter' || e.key === 'F2') {
                  e.preventDefault();
                  gone.add(q.id);
                  onEdit(q);
                } else if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault();
                  remove(q, i, e.currentTarget);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onFocusComposer();
                }
              }}
            />
          ))}
        </AnimatePresence>
      </Reorder.Group>
    </>
  );
}

interface RowProps {
  q: QueuedMessage;
  i: number;
  count: number;
  running: boolean;
  steerable: boolean;
  reduced: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onSend: () => void;
  onEdit: () => void;
  onRemove: (el: Element | null) => void;
  onKey: (e: KeyboardEvent<HTMLLIElement>) => void;
  /** When motion measures this row for a slide of its own (see `measure`). */
  measure: string;
}

function Row({ q, i, count, running, steerable, reduced, onDragStart, onDragEnd, onSend, onEdit, onRemove, onKey, measure }: RowProps) {
  const controls = useDragControls();
  const ref = useRef<HTMLLIElement>(null);
  const [lifted, setLifted] = useState(false);
  const atts = q.attachments?.length ?? 0;
  const text = firstLine(q.text);
  // Its delivery (queue-rows.ts): the bridge's reason in the row's second tone, and for a message
  // whose delivery is not known "Send again" and "Discard" in place of "Send now" and "Remove".
  const delivery = rowDelivery(q);
  const acts = rowActs(delivery, running && steerable);
  const provisional = isProvisional(q.id);

  const grab = (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    controls.start(e);
  };

  return (
    <Reorder.Item
      as="li"
      ref={ref}
      value={q}
      dragListener={false}
      dragControls={controls}
      layout="position"
      layoutDependency={measure}
      className="cq-row"
      data-qrow
      data-qid={q.id}
      data-lifted={lifted || undefined}
      data-why={delivery.reason ? '' : undefined}
      tabIndex={0}
      aria-label={`Queued message ${i + 1} of ${count}: ${text}${atts ? `, ${atts} attached` : ''}. ${delivery.reason ? `${delivery.reason} ` : ''}Alt+Arrow keys move it.`}
      // A row comes and goes with the dock's glide (QueueTray's layout effect): it is simply there,
      // its words brought by the message that flies in; one that leaves is out of the layout at once.
      initial={false}
      animate={{ scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0 } }}
      transition={reduced ? { duration: 0.12, layout: { duration: 0 } } : { layout: ROW, default: ROW }}
      whileDrag={reduced ? undefined : { scale: 1.015 }}
      onDragStart={() => {
        setLifted(true);
        onDragStart();
      }}
      onDragEnd={() => {
        setLifted(false);
        onDragEnd();
      }}
      onPointerDown={grab}
      onKeyDown={onKey}
      onDoubleClick={(e) => !provisional && !(e.target as HTMLElement).closest('button') && onEdit()}
    >
      {/* No number before the words: the order is the list's own, and the text keeps the field's edge. */}
      <span className="cq-text truncate">{text || ' '}</span>
      {/* Why it is here, in the bridge's words ("Issued to Claude. Receipt unknown."). */}
      {delivery.reason && (
        <span className="cq-why truncate" title={delivery.reason}>
          {delivery.reason}
        </span>
      )}
      {/* Kept from a Spare wait: it goes out only when sent by hand, not when the turn ends. */}
      {delivery.hand && (
        <Tip label="Goes out when you send it" side="top">
          <span className="cq-n" data-hand>
            <Icon name="hand" size={12} />
          </span>
        </Tip>
      )}
      {atts > 0 && (
        <span className="cq-att" aria-hidden>
          <Icon name="attach" size={12} />
          <span className="num">{atts}</span>
        </span>
      )}
      {/* A row standing in until the bridge has the message: nothing to act on yet. */}
      <span className="cq-actions" hidden={provisional || undefined}>
        <Act icon={running && steerable ? 'fast-forward' : 'arrow-up'} label={acts.send} onClick={onSend} />
        <Act icon="pencil" label="Edit" onClick={onEdit} />
        <Act icon="trash" label={acts.remove} onClick={() => onRemove(ref.current)} />
      </span>
    </Reorder.Item>
  );
}

/** An icon that grows a label pill to its left on hover or focus (a clip, so nothing reflows). */
function Act({ icon, label, onClick }: { icon: 'fast-forward' | 'arrow-up' | 'pencil' | 'trash'; label: string; onClick: () => void }) {
  return (
    <button type="button" className="cq-act" aria-label={label} onClick={onClick} onPointerDown={(e) => e.stopPropagation()}>
      <span className="cq-act-pill" aria-hidden>
        <span className="cq-act-label">{label}</span>
      </span>
      <Icon name={icon} size={13} />
    </button>
  );
}
