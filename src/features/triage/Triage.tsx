import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion, useIsPresent, type Variants } from 'motion/react';
import { Dialog as RD } from 'radix-ui';
import type { PermissionOption } from '@shared/protocol';
import { fieldBeat } from '@/art/events';
import { Icon } from '@/icons';
import { openSession, respondPermission, respondQuestion, setTriage } from '@/state/actions';
import { selectPending, type PendingPrompt } from '@/state/pending';
import { useStore } from '@/state/store';
import { deckAction, deckKeyAllowed, deckReducer, emptyDeck, exitOf, type Exit } from './deck';
import { onFront, takeFront } from './front';
import { CardBody, type CardHandle, type CardProps } from './TriageCard';
import '@/features/prompts/prompts.css';
import './triage.css';

/** Cards drawn: the front and two behind it. */
const SHOWN = 3;
/** How far each card behind shows below the one in front. */
const PEEK = 12;
/** How much narrower each card behind is. */
const SHRINK = 0.05;
/** A card that has just come forward takes no answer for this long, so a quick second key cannot answer it unseen. */
const ARM_MS = 220;
/** How long the end state stays before the deck closes. */
const END_HOLD = 900;
/** The stack's height while it shows the end state. */
const END_H = 44;
/** Cards taking their place: crisp, with the smallest settle. */
const SPRING = { type: 'spring', stiffness: 480, damping: 34 } as const;
/** An answered card leaving: stiffer, it is gone before the next one has arrived. */
const LEAVE = { type: 'spring', stiffness: 520, damping: 40 } as const;

const pose = (depth: number) => ({ y: depth * PEEK, x: 0, rotate: 0, scale: 1 - depth * SHRINK, opacity: 1 });

/** Where a leaving card goes: up when answered yes, tossed aside when no, behind the stack when moved back, a fade when answered elsewhere. */
function exitPose(exit: Exit) {
  // Quick enough that the leaving card's words are gone before the next card's come in.
  const fade = { duration: 0.15, ease: [0.3, 0, 0.7, 0.5] as const };
  // An answered card leaves above the stack; one sent back goes under it.
  const over = { zIndex: SHOWN + 1 };
  const now = { zIndex: { duration: 0 } };
  switch (exit) {
    case 'allow':
      return { ...over, y: -60, x: 0, rotate: 0, scale: 1.02, opacity: 0, transition: { ...now, y: LEAVE, scale: LEAVE, opacity: fade } };
    case 'deny':
      return { ...over, x: -110, y: 10, rotate: -4, scale: 0.97, opacity: 0, transition: { ...now, x: LEAVE, y: LEAVE, rotate: LEAVE, scale: LEAVE, opacity: fade } };
    case 'back':
      return { ...pose(SHOWN), opacity: 0, zIndex: 0, transition: { ...SPRING, ...now, opacity: { duration: 0.14 } } };
    default:
      return { ...over, opacity: 0, scale: 0.98, transition: { ...now, duration: 0.16 } };
  }
}

/** The triage deck: every permission request and question waiting across sessions, as a stack of glass cards answered by key or click. */
export function Triage() {
  const open = useStore((s) => !!s.ui.triageOpen);
  return (
    <RD.Root open={open} onOpenChange={setTriage}>
      <RD.Portal>
        <RD.Overlay className="tri-overlay" />
        <Deck />
      </RD.Portal>
    </RD.Root>
  );
}

function Deck() {
  const root = useRef<HTMLDivElement>(null);
  const pending = useStore(selectPending);
  const byKey = useMemo(() => new Map(pending.map((p) => [p.key, p])), [pending]);
  const keys = useMemo(() => pending.map((p) => p.key), [pending]);
  const live = useMemo(() => new Set(keys), [keys]);
  // Opened by a notification's click: that chat's card is in front from the first frame.
  const [state, dispatch] = useReducer(deckReducer, keys, (k) => deckReducer(emptyDeck(k), { type: 'raise', key: takeFront() ?? '' }));
  // Before paint: a request answered elsewhere leaves, a new one joins at the back, in the same frame.
  useLayoutEffect(() => dispatch({ type: 'sync', keys }), [keys]);
  useEffect(() => onFront((key) => (takeFront(), dispatch({ type: 'raise', key }))), []);

  const cards = state.order.flatMap((k) => byKey.get(k) ?? []);
  const shown = cards.slice(0, SHOWN);
  const front = shown[0];

  // Each card's place among what waits, oldest first: moving through the deck reads as 2 of 5, 3 of 5.
  const posOf = useMemo(() => {
    const inDeck = new Set(state.order);
    const m = new Map<string, number>();
    for (const k of keys) if (inDeck.has(k)) m.set(k, m.size + 1);
    return m;
  }, [keys, state.order]);

  // A card that comes forward is armed a moment later.
  const [armedKey, setArmedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!front) return;
    const t = window.setTimeout(() => setArmedKey(front.key), ARM_MS);
    return () => window.clearTimeout(t);
  }, [front?.key]);
  const armed = !!front && armedKey === front.key;

  // The cards as dealt when the deck opens come in one after another; later ones just join.
  const [dealt, setDealt] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setDealt(true), 400);
    return () => window.clearTimeout(t);
  }, []);

  // Heights: each card's own; the cards behind take the front one's, so their edges line up under it.
  const [heights, setHeights] = useState<Record<string, number>>({});
  const measure = useCallback((key: string, h: number) => setHeights((cur) => (cur[key] === h ? cur : { ...cur, [key]: h })), []);
  const frontH = front ? heights[front.key] : undefined;
  const stackH = front ? (frontH ?? 0) + PEEK * (shown.length - 1) : END_H;

  // Each card's answer keys, by card: a card still flying off must not unhook the one now in front.
  const handles = useRef(new Map<string, CardHandle>());
  const bind = useCallback((key: string, h: CardHandle | null) => {
    if (h) handles.current.set(key, h);
    else handles.current.delete(key);
  }, []);
  const refocus = useCallback(() => requestAnimationFrame(() => root.current?.focus()), []);

  // How the front last changed: after an answer the next card's words wait for the answered card
  // to clear; after a move nothing covers the stack, so they come at once (triage.css).
  const moved = useRef<'answer' | 'shift'>('answer');
  const leave = useCallback(
    (key: string, exit: Exit) => {
      moved.current = 'answer';
      // A yes lifts off the stack and the field under the deck answers it with a soft beat.
      if (exit === 'allow') fieldBeat('pulse', root.current?.querySelector('.tri-card[data-depth="0"]'), 0.4);
      dispatch({ type: 'answer', key, exit });
      refocus();
    },
    [refocus],
  );
  const onPermission = useCallback(
    (p: PendingPrompt, option: PermissionOption, note?: string) => {
      leave(p.key, option.tone === 'deny' ? 'deny' : 'allow');
      void respondPermission(p.sessionId, p.req.id, option.id, note);
    },
    [leave],
  );
  const onQuestion = useCallback(
    (p: PendingPrompt, answers: Record<string, string[]> | null) => {
      leave(p.key, answers ? 'allow' : 'deny');
      void respondQuestion(p.sessionId, p.req.id, answers);
    },
    [leave],
  );
  const onOpen = useCallback((p: PendingPrompt) => {
    setTriage(false);
    openSession(p.sessionId);
  }, []);
  // A click on a card's edge behind the front brings that card forward (as J does, once per step).
  const raise = useCallback(
    (depth: number) => {
      moved.current = 'shift';
      for (let i = 0; i < depth; i++) dispatch({ type: 'next' });
      refocus();
    },
    [refocus],
  );

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const ev = e.nativeEvent;
    if (!deckKeyAllowed(ev)) return;
    const a = deckAction(ev, front?.kind ?? null);
    if (!a || a.type === 'close') return; // Escape is the dialog's
    if (a.type === 'next' || a.type === 'prev') {
      moved.current = 'shift';
      dispatch({ type: a.type });
    } else if (a.type === 'open') front && onOpen(front);
    else if (!front || !handles.current.get(front.key)?.act(a)) return;
    e.preventDefault();
  };

  // Empty: one calm line, then the deck closes by itself and the field answers softly.
  const empty = !front;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!empty) return;
    const t = window.setTimeout(
      () => {
        fieldBeat('pulse', endRef.current, 0.6);
        setTriage(false);
      },
      state.answered ? END_HOLD : END_HOLD + 400,
    );
    return () => window.clearTimeout(t);
  }, [empty, state.answered]);

  const resolveExit = useCallback((key: string) => exitOf(state, key, live), [state, live]);

  return (
    <RD.Content
      ref={root}
      className="tri"
      data-move={moved.current}
      aria-describedby={undefined}
      // The deck takes the keys itself: nothing inside is focused first (a focused button would answer Enter on its own).
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        root.current?.focus();
      }}
      // Escape in a field (the note, "Other") steps out of the field; the deck stays.
      onEscapeKeyDown={(e) => {
        const t = e.target as HTMLElement | null;
        if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) e.preventDefault();
      }}
      onKeyDown={onKeyDown}
    >
      <RD.Title className="sr-only">Waiting on you</RD.Title>
      <motion.div className="tri-stack" initial={false} animate={{ height: stackH }} transition={SPRING}>
        <AnimatePresence custom={resolveExit}>
          {shown.map((p, depth) => (
            <Card
              key={p.key}
              p={p}
              depth={depth}
              delay={dealt ? 0 : depth * 0.05}
              height={depth === 0 ? heights[p.key] : frontH}
              onMeasure={measure}
              bind={bind}
              onRaise={raise}
              cardProps={{ p, pos: posOf.get(p.key) ?? 1, total: cards.length, armed: depth === 0 && armed, onPermission, onQuestion, onOpen, refocus }}
            />
          ))}
        </AnimatePresence>
        <AnimatePresence>
          {empty && (
            <motion.div
              key="end"
              ref={endRef}
              className="tri-end glass-rim"
              role="status"
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { ...SPRING, delay: state.answered ? 0.12 : 0 } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
            >
              <motion.span
                className="tri-end-mark"
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1, transition: { ...SPRING, delay: state.answered ? 0.2 : 0.08 } }}
              >
                <Icon name="check" size={11} />
              </motion.span>
              {state.answered ? 'All answered' : 'Nothing is waiting on you'}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </RD.Content>
  );
}

/**
 * One card of the stack. The front one is the composer's frosted glass and shows its request; the
 * two behind are the same glass one step deeper each (lower, narrower, darker), the first of them
 * already laid out unseen so it comes forward without building anything. A click on a card's edge
 * behind brings it forward.
 */
function Card({
  p,
  depth,
  delay,
  height,
  onMeasure,
  bind,
  onRaise,
  cardProps,
}: {
  p: PendingPrompt;
  depth: number;
  delay: number;
  height: number | undefined;
  onMeasure: (key: string, h: number) => void;
  bind: (key: string, h: CardHandle | null) => void;
  onRaise: (depth: number) => void;
  cardProps: Omit<CardProps, 'handle'>;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const withBody = depth <= 1;
  // A card on its way out takes no pointer and no key.
  const present = useIsPresent();
  const handle = useCallback((h: CardHandle | null) => bind(p.key, h), [bind, p.key]);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    onMeasure(p.key, el.offsetHeight);
    const ro = new ResizeObserver(() => onMeasure(p.key, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.key, onMeasure, withBody]);

  const variants: Variants = {
    enter: { ...pose(depth + 1), opacity: 0 },
    exit: (resolve: (key: string) => Exit) => exitPose(resolve(p.key)),
  };
  const behind = depth > 0;

  return (
    <motion.article
      className="tri-card glass-rim"
      data-depth={depth}
      data-spot={(!behind && present) || undefined}
      aria-hidden={behind || !present || undefined}
      inert={!present}
      onClick={behind && present ? () => onRaise(depth) : undefined}
      style={{ zIndex: SHOWN - depth }}
      variants={variants}
      initial="enter"
      animate={{ ...pose(depth), ...(height ? { height } : {}), transition: { ...SPRING, delay, opacity: { duration: 0.18, delay } } }}
      exit="exit"
    >
      <div ref={inner} className="tri-card-inner" inert={behind}>
        {withBody && <CardBody {...cardProps} handle={depth === 0 && present ? handle : null} />}
      </div>
    </motion.article>
  );
}
