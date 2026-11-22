import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion, Reorder, useDragControls, useReducedMotion } from 'motion/react';
import type { QueuedMessage } from '@shared/protocol';
import { Icon } from '@/icons';
import { Tip } from '@/ui';
import { shatter } from './shatter';
import { landInTray, launchFromTray } from './flight';
import { removeQueued, reorderQueue, sendQueuedNow } from '@/state/actions';
import { Roll } from './Roll';

const NONE: QueuedMessage[] = [];
/** Rows the person removed or took back to edit: they leave without flying. */
const gone = new Set<string>();
export const NO_QUEUE = NONE;

const firstLine = (t: string) => t.split('\n').find((l) => l.trim())?.trim() ?? '';

/** The tray unfolds from behind the composer's top edge: about 140 ms with a 2 px overshoot. */
const UNFOLD = { type: 'spring' as const, stiffness: 700, damping: 40 };
/** Rows making room, closing up and settling after a drag. */
const ROW = { type: 'spring' as const, stiffness: 520, damping: 38 };

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
    const textOf = (id: string) => host.querySelector<HTMLElement>(`[data-qid="${CSS.escape(id)}"] .cq-text`);
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
        {queue.length > 0 && (
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
            <TrayBody sessionId={sessionId} queue={queue} running={running} steerable={steerable} onEdit={onEdit} onFocusComposer={onFocusComposer} reduced={!!reduced} />
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
});

function TrayBody({ sessionId, queue, running, steerable, onEdit, onFocusComposer, reduced }: QueueTrayProps & { reduced: boolean }) {
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

  const commit = (next: QueuedMessage[]) => {
    const ids = next.map((q) => q.id);
    if (ids.join() !== queue.map((q) => q.id).join()) void reorderQueue(sessionId, ids);
  };

  const focusRow = (i: number) => {
    window.requestAnimationFrame(() => {
      const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-qrow]') ?? [])];
      const el = els[Math.min(i, els.length - 1)];
      if (el) el.focus({ preventScroll: true });
      else onFocusComposer();
    });
  };

  const remove = (q: QueuedMessage, i: number, el: Element | null) => {
    gone.add(q.id);
    shatter(el);
    void removeQueued(sessionId, q.id);
    if (el?.contains(document.activeElement)) focusRow(i);
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
              key={q.id}
              q={q}
              i={i}
              count={rows.length}
              running={running}
              steerable={steerable}
              reduced={reduced}
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
                const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-qrow]') ?? [])];
                if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                  e.preventDefault();
                  move(i, e.key === 'ArrowUp' ? -1 : 1);
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  els[(i + (e.key === 'ArrowDown' ? 1 : els.length - 1)) % els.length]?.focus();
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
}

function Row({ q, i, count, running, steerable, reduced, onDragStart, onDragEnd, onSend, onEdit, onRemove, onKey }: RowProps) {
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
