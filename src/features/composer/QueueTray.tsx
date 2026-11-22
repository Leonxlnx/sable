import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion, Reorder, useDragControls, useReducedMotion } from 'motion/react';
import type { QueuedMessage } from '@shared/protocol';
import { Icon } from '@/icons';
import { Tip } from '@/ui';
import { dissolve } from '@/lib/dissolve';
import { play, reducedMotion, spring } from '@/lib/motion';
import { landInTray, launchFromTray } from './flight';
import { removeQueued, reorderQueue, sendQueuedNow } from '@/state/actions';
import { useStore } from '@/state/store';
import { Roll } from './Roll';

const NONE: QueuedMessage[] = [];
const NOBODY: ReadonlySet<string> = new Set();
/** Rows the person removed or took back to edit: they leave without flying. */
const gone = new Set<string>();
export const NO_QUEUE = NONE;

const firstLine = (t: string) => t.split('\n').find((l) => l.trim())?.trim() ?? '';

/** The tray unfolds from behind the composer's top edge: about 140 ms with a 2 px overshoot. */
const UNFOLD = { type: 'spring' as const, stiffness: 700, damping: 40 };
/** Rows making room, closing up and settling after a drag. */
const ROW = { type: 'spring' as const, stiffness: 520, damping: 38 };
/** The same spring for the tray closing after a row was removed by hand, on the compositor. */
const CLOSE = spring(ROW.stiffness, ROW.damping);
/** How deep the tray is tucked behind the composer's top edge (composer.css `.cq-clip`, `.cq`). */
const TUCK = 20;
/** The beat the leaving row has to itself before the tray closes over it (ms), as in the sidebar. */
const BEAT = 50;

/**
 * The tray closes over a row that was taken out of its layout in this task.
 *
 * The tray stands on the composer and grows upward: without the row its box is shorter and its top
 * edge lower, at once. So the whole tray starts lifted and springs home, and what did not move in
 * the layout (the rows under the removed one, the dissolving copy) is held still by the opposite
 * slide. Translate only, one spring, started together: it runs on the compositor, and a queue is
 * used exactly while a turn streams and the page is busy (the height animated by script got five
 * frames a second there: the gap stood for 200 ms and closed in two steps). The lift is at most the
 * tuck's depth, so the tray's lower edge never comes out from behind the composer: the rest of a
 * row's height is taken in the first frame. The list is a scroller and would cut the rows held
 * still at its lower edge: it does not clip meanwhile (it is only closed this way while it has
 * nothing to scroll).
 */
function closeTray(clip: HTMLElement, list: HTMLElement, still: (HTMLElement | null | undefined)[], height: number) {
  const by = Math.min(height, TUCK);
  const timing = { duration: CLOSE.duration, easing: CLOSE.easing, delay: BEAT, fill: 'backwards' as const };
  list.style.overflow = 'visible';
  const edge = play(clip, [{ translate: `0 ${-by}px` }, { translate: '0 0' }], timing);
  for (const el of still) if (el) play(el, [{ translate: `0 ${by}px` }, { translate: '0 0' }], timing);
  const done = () => {
    // A second removal right behind this one holds the list open itself.
    if (!clip.getAnimations().some((a) => a !== edge && a.playState === 'running')) list.style.overflow = '';
  };
  if (edge) edge.finished.then(done, done);
  else done();
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
  const shown = left.size ? queue.filter((q) => !left.has(q.id)) : queue;
  const before = useRef<QueuedMessage[]>(NONE);
  const beforeSession = useRef(sessionId);
  useLayoutEffect(() => {
    const host = clip.current;
    const prev = before.current;
    before.current = queue;
    // Another chat's queue (a switch): its rows neither land nor leave here.
    const same = beforeSession.current === sessionId;
    beforeSession.current = sessionId;
    if (!host || prev === queue || !same) return;
    const now = new Set(queue.map((q) => q.id));
    const was = new Set(prev.map((q) => q.id));
    // (The row itself, never one removed by hand that is still folding away, hidden.)
    const textOf = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-qid="${CSS.escape(id)}"]`)].find((el) => el.style.display !== 'none')?.querySelector<HTMLElement>('.cq-text') ?? null;
    for (const q of queue) {
      if (was.has(q.id)) continue;
      const el = textOf(q.id);
      if (el) landInTray(el, q.text, sessionId);
    }
    for (const q of prev) {
      if (now.has(q.id) || gone.delete(q.id)) continue;
      const el = textOf(q.id);
      if (el) launchFromTray(el, q.text, sessionId);
    }
  }, [queue, sessionId]);
  return (
    <div className="cq-clip" ref={clip}>
      <AnimatePresence initial={false}>
        {shown.length > 0 && (
          <motion.section
            key="tray"
            className="cq"
            data-spot
            aria-label="Queued messages"
            initial={reduced ? { opacity: 0 } : { y: '100%' }}
            animate={reduced ? { opacity: 1 } : { y: 0 }}
            exit={reduced ? { opacity: 0 } : { y: '100%', transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
            transition={reduced ? { duration: 0.12, layout: { duration: 0 } } : UNFOLD}
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
  // When motion measures the rows for its own slides (a drag, a row the agent took): whenever the
  // bridge's queue or the order in hand changes, but not when a row is removed by hand, which is
  // not in the bridge's answer yet: that close is `closeTray`'s, and two slides would add up.
  const measure = `${held.map((q) => q.id).join()}/${order.map((q) => q.id).join()}`;

  const commit = (next: QueuedMessage[]) => {
    const ids = next.map((q) => q.id);
    if (ids.join() !== queue.map((q) => q.id).join()) void reorderQueue(sessionId, ids);
  };

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
  // so the tray closes on the click. Its dead copy (`lib/dissolve.ts`) is held by the list's lower
  // edge, which stays while the tray's top comes down, and stands under the rows: one that comes
  // down into its place covers it.
  const remove = (q: QueuedMessage, i: number, el: Element | null) => {
    gone.add(q.id);
    const focused = !!el?.contains(document.activeElement);
    const list = listRef.current;
    const row = el instanceof HTMLElement ? el : null;
    const clip = row?.closest<HTMLElement>('.cq-clip');
    const first = list?.firstElementChild;
    if (row && list && clip && first instanceof HTMLElement && !reducedMotion()) {
      // Reads: the row's height, whether the tray gets shorter without it (a list that scrolls does
      // not), and the rows that stay where they are.
      const height = row.offsetHeight;
      const shrinks = rows.length > 1 && list.scrollHeight <= list.clientHeight + 1;
      const under: HTMLElement[] = [];
      for (let n = row.nextElementSibling; n; n = n.nextElementSibling) if (n instanceof HTMLElement && n.hasAttribute('data-qrow')) under.push(n);
      // Writes.
      const leaving = dissolve(row, { ground: '--panel', anchor: 'bottom', before: first });
      row.style.display = 'none';
      if (shrinks) closeTray(clip, list, [...under, leaving?.ghost], height);
    } else if (row) row.style.display = 'none';
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
      <div className="cq-head">
        <Icon name="queue" size={14} className="cq-head-icon" />
        <span className="cq-title">Queued</span>
        <Roll value={queue.length} className="cq-count num" />
      </div>
      <Reorder.Group as="ul" axis="y" values={rows} onReorder={setOrder} className="cq-list scroll" ref={listRef} role="list">
        <AnimatePresence initial={false}>
          {rows.map((q, i) => (
            <Row
              key={`${q.id}/${lives.get(q.id) ?? 0}`}
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
                if (e.target !== e.currentTarget) return;
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
  const sendLabel = running && steerable ? 'Steer now' : 'Send now';

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
      tabIndex={0}
      aria-label={`Queued message ${i + 1} of ${count}: ${text}${atts ? `, ${atts} attached` : ''}. Alt+Arrow keys move it.`}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, transition: { opacity: { duration: 0 }, height: ROW } }}
      transition={reduced ? { duration: 0.12, layout: { duration: 0 } } : { opacity: { duration: 0.11, ease: [0.16, 1, 0.3, 1] }, y: { duration: 0.11, ease: [0.16, 1, 0.3, 1] }, layout: ROW, default: ROW }}
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
      onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && onEdit()}
    >
      {/* Kept from a Spare wait: it goes out only when sent by hand, not when the turn ends. */}
      {q.byHand ? (
        <Tip label="Goes out when you send it" side="top">
          <span className="cq-n" data-hand>
            <Icon name="hand" size={12} />
          </span>
        </Tip>
      ) : (
        <span className="cq-n num" aria-hidden>
          {i + 1}
        </span>
      )}
      <span className="cq-text truncate">{text || ' '}</span>
      {atts > 0 && (
        <span className="cq-att" aria-hidden>
          <Icon name="attach" size={12} />
          <span className="num">{atts}</span>
        </span>
      )}
      <span className="cq-actions">
        <Act icon={running && steerable ? 'fast-forward' : 'arrow-up'} label={sendLabel} onClick={onSend} />
        <Act icon="pencil" label="Edit" onClick={onEdit} />
        <Act icon="trash" label="Remove" onClick={() => onRemove(ref.current)} />
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
