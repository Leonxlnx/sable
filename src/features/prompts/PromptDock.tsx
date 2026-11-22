import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { PermissionRequest, QuestionRequest, Todo } from '@shared/protocol';
import { useStore } from '@/state/store';
import { CardWarmup, PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { TaskStrip } from './TaskStrip';
import './prompts.css';

const NONE_P: PermissionRequest[] = [];
const NONE_Q: QuestionRequest[] = [];
const NONE_T: Todo[] = [];

const rise = {
  initial: { opacity: 0, y: 18, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, transition: { duration: 0.14, ease: [0.5, 0, 0.9, 0.4] as const } },
  transition: { type: 'spring' as const, stiffness: 440, damping: 36 },
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
 * What waits above the composer: the task strip, then the oldest question or
 * permission request (one at a time). Rendered as direct children of the dock column.
 */
export function PromptDock({ sessionId }: { sessionId: string }) {
  const permissions = useStore((s) => s.data[sessionId]?.permissions ?? NONE_P);
  const questions = useStore((s) => s.data[sessionId]?.questions ?? NONE_Q);
  const todos = useStore((s) => s.data[sessionId]?.todos ?? NONE_T);
  const status = useStore((s) => s.sessions[sessionId]?.status);
  const running = status === 'running' || status === 'awaiting' || status === 'starting';

  const queue: ({ kind: 'permission'; req: PermissionRequest } | { kind: 'question'; req: QuestionRequest })[] = [
    ...permissions.map((req) => ({ kind: 'permission' as const, req })),
    ...questions.map((req) => ({ kind: 'question' as const, req })),
  ].sort((a, b) => a.req.createdAt - b.req.createdAt);
  const head = queue[0];
  const more = queue.length - 1;
  const showTasks = useTaskStrip(todos);

  return (
    <>
      <CardWarmup active={running} />
      <AnimatePresence initial={false}>
        {showTasks && (
          <motion.div key="tasks" className="pd-slot" data-slot="tasks" {...rise}>
            <TaskStrip sessionId={sessionId} todos={todos} running={running} />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false} mode="wait">
        {head && (
          <motion.div key={head.req.id} className="pd-slot" data-req={head.req.id} {...rise}>
            {head.kind === 'permission' ? (
              <PermissionCard sessionId={sessionId} req={head.req} more={more} />
            ) : (
              <QuestionCard sessionId={sessionId} req={head.req} more={more} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
