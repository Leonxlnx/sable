import { memo, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Todo } from '@shared/protocol';
import { Ring as Spinner } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { Icon } from '@/icons';
import { useStore } from '@/state/store';

const NONE_T: Todo[] = [];

/** As the composer's other strips rise out from behind the pane's edge (UntilStrip.tsx). */
const rise = {
  initial: { opacity: 0, y: 10, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, transition: { duration: 0.14, ease: [0.5, 0, 0.9, 0.4] as const } },
  transition: { type: 'spring' as const, stiffness: 460, damping: 36 },
};

/** How long "All tasks done" stays after the last task is checked off. */
const DONE_HOLD = 1600;

/**
 * The strip shows while a task is open. When the last one is checked off it stays a moment, full,
 * then leaves; a finished list never comes back with the next turn.
 */
function useTaskStrip(todos: Todo[]): boolean {
  const open = todos.some((t) => t.status !== 'completed');
  const [held, setHeld] = useState(false);
  const was = useRef(open);
  useEffect(() => {
    const before = was.current;
    was.current = open;
    if (open) return setHeld(false);
    if (!before || !todos.length) return;
    setHeld(true);
    const t = window.setTimeout(() => setHeld(false), DONE_HOLD);
    return () => window.clearTimeout(t);
  }, [open, todos.length]);
  return todos.length > 0 && (open || held);
}

/**
 * The task strip in the composer's stack (Composer.tsx): the farthest of the strips tucked behind
 * the pane's top edge (until.css), so it stays with the composer whatever card asks above it and
 * nothing of the conversation shows between it and the pane.
 */
export const TaskSlot = memo(function TaskSlot({ sessionId }: { sessionId: string }) {
  const todos = useStore((s) => s.data[sessionId]?.todos ?? NONE_T);
  const status = useStore((s) => s.sessions[sessionId]?.status);
  const running = status === 'running' || status === 'awaiting' || status === 'starting';
  const show = useTaskStrip(todos);
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div key="tasks" className="us-slot" data-slot="tasks" {...rise}>
          <TaskStrip sessionId={sessionId} todos={todos} running={running} />
        </motion.div>
      )}
    </AnimatePresence>
  );
});

/** Expanded/collapsed per session while the app is open. */
const openBySession = new Map<string, boolean>();

function Ring({ done, total }: { done: number; total: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const p = total ? done / total : 0;
  return (
    <svg className="ts-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r={r} className="ts-ring-track" />
      <circle cx="9" cy="9" r={r} className="ts-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform="rotate(-90 9 9)" />
      {/* Closed, a ring alone reads like an empty one: every task done carries a check. */}
      {total > 0 && done === total && <path d="M6.1 9.3l1.9 1.9 3.9-4" className="ts-ring-check" />}
    </svg>
  );
}

/** One slim row of progress over the composer; opens into the checklist. */
export function TaskStrip({ sessionId, todos, running }: { sessionId: string; todos: Todo[]; running: boolean }) {
  const [open, setOpenState] = useState(() => openBySession.get(sessionId) ?? false);
  const setOpen = (v: boolean) => {
    openBySession.set(sessionId, v);
    setOpenState(v);
  };
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending');
  // "Running the tests" only while the agent is at it: a turn that stopped halfway names the task.
  const label = current ? (current.status === 'in_progress' && running ? (current.activeForm ?? current.content) : current.content) : 'All tasks done';
  const listId = `tasks-${sessionId}`;

  return (
    <section className="ts" data-spot data-open={open || undefined}>
      <button type="button" className="ts-row" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <Ring done={done} total={todos.length} />
        <span className="ts-count num">
          {done} of {todos.length}
        </span>
        <span key={label} className={running && current?.status === 'in_progress' ? 'ts-label truncate shimmer' : 'ts-label truncate'}>
          {label}
        </span>
        <Icon name="caret-up" size={12} className="ts-caret" />
      </button>
      <Collapse open={open}>
        <ul className="ts-list scroll" id={listId}>
          {todos.map((t, i) => (
            <li key={t.id ?? i} className="ts-item" data-status={t.status}>
              <span className="ts-mark" aria-hidden>
                {t.status === 'completed' ? <Icon name="check" size={11} /> : t.status === 'in_progress' ? <Spinner size={10} active={running} label={null} /> : <i />}
              </span>
              <span className="ts-text">{t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}</span>
              <span className="sr-only">{t.status === 'completed' ? 'Done' : t.status === 'in_progress' ? 'In progress' : 'Pending'}</span>
            </li>
          ))}
        </ul>
      </Collapse>
    </section>
  );
}
