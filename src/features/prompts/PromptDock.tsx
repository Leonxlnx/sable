import { AnimatePresence, motion } from 'motion/react';
import type { PermissionRequest, QuestionRequest } from '@shared/protocol';
import { useStore } from '@/state/store';
import { CardWarmup, PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import './prompts.css';

const NONE_P: PermissionRequest[] = [];
const NONE_Q: QuestionRequest[] = [];

const rise = {
  initial: { opacity: 0, y: 18, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, transition: { duration: 0.14, ease: [0.5, 0, 0.9, 0.4] as const } },
  transition: { type: 'spring' as const, stiffness: 440, damping: 36 },
};

/**
 * What waits above the composer: the oldest question or permission request (one at a time).
 * Rendered as direct children of the dock column. The task strip is the composer's own (its
 * stack, `TaskSlot` in Composer.tsx), so it stays with the pane whatever card asks here.
 */
export function PromptDock({ sessionId }: { sessionId: string }) {
  const permissions = useStore((s) => s.data[sessionId]?.permissions ?? NONE_P);
  const questions = useStore((s) => s.data[sessionId]?.questions ?? NONE_Q);
  const status = useStore((s) => s.sessions[sessionId]?.status);
  const running = status === 'running' || status === 'awaiting' || status === 'starting';

  const queue: ({ kind: 'permission'; req: PermissionRequest } | { kind: 'question'; req: QuestionRequest })[] = [
    ...permissions.map((req) => ({ kind: 'permission' as const, req })),
    ...questions.map((req) => ({ kind: 'question' as const, req })),
  ].sort((a, b) => a.req.createdAt - b.req.createdAt);
  const head = queue[0];
  const more = queue.length - 1;

  return (
    <>
      <CardWarmup active={running} />
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
