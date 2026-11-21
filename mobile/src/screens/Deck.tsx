import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { deckReducer, emptyDeck } from '@desk/features/triage/deck';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { usePending } from '@m/lib/pending';
import { useStore } from '@m/lib/store';
import { Icon } from '@m/ui/icons';
import { ProviderMark } from '@m/ui/marks';
import { SNAP } from '@m/ui/motion';
import { Sheet } from '@m/ui/Sheet';
import { PermissionBody, QuestionBody } from './Prompts';

// Its own chunk (with the prompt sheets and the markdown they render), loaded when home has something waiting.

/**
 * The deck: what waits on you across chats, one card at a time in a sheet (as the desktop's triage
 * deck): the chat it is from over it, its answers under it. An answer brings the next card in;
 * "Later" puts this one at the back (with one card left, it closes the deck). When nothing is left the deck says so and closes.
 */
export function Deck({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cards = usePending();
  const keys = useMemo(() => cards.map((c) => c.key), [cards]);
  const [deck, act] = useReducer(deckReducer, keys, emptyDeck);
  const [dir, setDir] = useState<1 | -1>(1);
  useEffect(() => act({ type: 'sync', keys }), [keys]);
  const byKey = useMemo(() => new Map(cards.map((c) => [c.key, c])), [cards]);
  const front = deck.order.map((k) => byKey.get(k)).find(Boolean);
  const total = deck.order.filter((k) => byKey.has(k)).length;
  const done = open && !front;
  const s = useStore((st) => (front ? st.sessions[front.sessionId] : undefined));

  // Nothing left: the deck says so for a moment, then goes.
  useEffect(() => {
    if (!done) return;
    haptic('success');
    const t = window.setTimeout(onClose, 900);
    return () => clearTimeout(t);
  }, [done, onClose]);

  const next = () => {
    if (total < 2) return onClose();
    setDir(1);
    act({ type: 'next' });
  };

  return (
    <Sheet open={open} onClose={onClose} label="Waiting for you" tall={!!front?.question}>
      <div className="deck">
        {front && (
          <div className="deck-head">
            {s && <ProviderMark provider={s.provider} size={15} />}
            <span className="deck-chat">{s?.title ?? ''}</span>
            {total > 1 && (
              <span className="deck-count num">
                {Math.max(1, cards.indexOf(front) + 1)} of {total}
              </span>
            )}
            <button
              type="button"
              className="deck-open"
              onClick={() => {
                haptic('tap');
                onClose();
                nav.chat(front.sessionId);
              }}
            >
              Open
              <Icon name="next" size={12} weight="bold" />
            </button>
          </div>
        )}
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          {front ? (
            <motion.div
              key={front.key}
              className="deck-card"
              custom={dir}
              initial={{ opacity: 0, x: dir * 36 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: dir * -36, transition: { duration: 0.16 } }}
              transition={SNAP}
            >
              {front.perm ? (
                <PermissionBody sid={front.sessionId} req={front.perm} more={0} onLater={next} />
              ) : (
                <QuestionBody sid={front.sessionId} req={front.question!} onLater={next} />
              )}
            </motion.div>
          ) : (
            <motion.div key="done" className="deck-done" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={SNAP}>
              <span className="deck-done-mark">
                <Icon name="check" size={20} weight="bold" />
              </span>
              <span>Nothing waits for you</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Sheet>
  );
}
