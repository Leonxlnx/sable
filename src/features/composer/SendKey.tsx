import { memo, useLayoutEffect, useRef, useState, type ReactElement, useSyncExternalStore } from 'react';
import { Tip } from '@/ui';
import { keyTipOffset } from './key-tip';
import { sendKeys } from './enter-keys';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export type SendGlyph = 'send' | 'steer';

// ── the modifier key (one set of listeners for the app) ──

let held = false;
const subs = new Set<() => void>();
const setHeld = (v: boolean) => {
  if (held === v) return;
  held = v;
  subs.forEach((f) => f());
};
let listening = false;
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const key = MAC ? 'Meta' : 'Control';
  window.addEventListener('keydown', (e) => setHeld(e.key === key || (MAC ? e.metaKey : e.ctrlKey)), true);
  window.addEventListener('keyup', (e) => e.key === key && setHeld(false), true);
  window.addEventListener('blur', () => setHeld(false));
}
const subscribe = (f: () => void) => {
  listen();
  subs.add(f);
  return () => subs.delete(f);
};

/** True while the platform's modifier (Ctrl, or Cmd on a Mac) is held and `on`. Lets go when the window loses focus. */
export function useModHeld(on: boolean): boolean {
  const v = useSyncExternalStore(subscribe, () => held, () => false);
  return on && v;
}

/**
 * The send key's glyph: one arrow.
 * - send: straight up. While a turn runs Enter queues and the key keeps this arrow: the message
 *   still goes up, only after the turn (the tooltip says so).
 * - steer (the modifier held while a turn runs): the arrow leans into the turn, up and to the right.
 * Ultra and ultracode are shown by the effort chip, never by the key.
 */
export function SendGlyphSvg({ glyph }: { glyph: SendGlyph }) {
  return (
    <svg className="sk-glyph" data-glyph={glyph} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <g className="sk-arrow">
        <path className="sk-shaft" d="M8 12.75V3.75" />
        <path className="sk-head" d="M4.25 7.5 8 3.75l3.75 3.75" />
      </g>
    </svg>
  );
}

export interface SendKeyProps {
  canSend: boolean;
  /** A turn is running (not an agent that only starts): Enter queues, Ctrl+Enter steers. */
  busy: boolean;
  /** Show the stop key in the slot (busy with nothing typed). */
  showStop: boolean;
  /** The agent takes messages mid-turn. */
  steerable: boolean;
  sendWithEnter: boolean;
  shell: boolean;
  /** Only the session composer has a stop key. */
  stoppable: boolean;
  onSend: (steer: boolean) => void;
  onStop: () => void;
}

/**
 * The send and stop keys, sharing the cove in the pane's corner (composer.css `.cmp-keys`): one
 * 40 px disc, an object of its own beside the pane.
 * Send is a solid ivory disc with a dark glyph; stop an ivory disc with a dark square, static.
 */
export const SendKey = memo(function SendKey({ canSend, busy, showStop, steerable, sendWithEnter, shell, stoppable, onSend, onStop }: SendKeyProps) {
  // The send and stop keys share one slot. Pressed with the pointer, or swapped under a pointer
  // that has not moved off the slot, the key there shows no tooltip until the pointer leaves: a tip
  // is something asked for by pointing at a key, not a hint left lying beside it after a press.
  const slot = useRef<HTMLDivElement>(null);
  const [quiet, setQuiet] = useState(false);
  // The tip keeps off the rim's corner and the cove's horn (key-tip.ts): measured as the pointer or
  // the keys reach the slot, before the tip's delay is over.
  const [tipAt, setTipAt] = useState(() => keyTipOffset(90));
  const measure = () => {
    const card = slot.current?.closest<HTMLElement>('.cmp-card');
    if (card) setTipAt(keyTipOffset(card.offsetHeight));
  };
  const shown = useRef(showStop);
  useLayoutEffect(() => {
    if (shown.current === showStop) return;
    shown.current = showStop;
    if (slot.current?.matches(':hover')) setQuiet(true);
  }, [showStop]);
  const tip = (label: string, keys: string, el: ReactElement) =>
    quiet ? (
      el
    ) : (
      <Tip label={label} keys={keys} side="top" offset={tipAt}>
        {el}
      </Tip>
    );
  const queueing = busy && !shell;
  const held = useModHeld(queueing && steerable);
  const steer = queueing && steerable && held;
  const glyph: SendGlyph = steer ? 'steer' : 'send';
  const label = shell ? 'Run in terminal' : steer ? 'Steer into this turn' : queueing ? 'Queue message' : 'Send';
  // Ctrl+Enter sends now (a steer while a turn runs); a queue is the plain send key, or Ctrl+Shift+Enter
  // where Enter makes a new line. An agent that takes nothing mid-turn queues on Ctrl+Enter too (OpenCode).
  const keys = sendKeys(steer ? 'steer' : queueing ? 'queue' : 'send', { steerable, sendWithEnter });

  return (
    <div className="cmp-keys" ref={slot} onPointerEnter={measure} onFocus={measure} onPointerLeave={() => quiet && setQuiet(false)}>
      {tip(
        label,
        keys,
        <button
          type="button"
          className="cmp-send"
          data-on={!showStop || undefined}
          data-ready={canSend || undefined}
          aria-label={label}
          aria-disabled={!canSend}
          tabIndex={showStop ? -1 : 0}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            if (!canSend) return;
            if (e.detail > 0) setQuiet(true);
            onSend(queueing && steerable && (MAC ? e.metaKey : e.ctrlKey));
          }}
        >
          <SendGlyphSvg glyph={glyph} />
        </button>,
      )}
      {stoppable &&
        tip(
          'Stop',
          'esc',
          <button
            type="button"
            className="cmp-stop"
            data-on={showStop || undefined}
            aria-label="Stop"
            tabIndex={showStop ? 0 : -1}
            aria-hidden={!showStop}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              if (e.detail > 0) setQuiet(true);
              onStop();
            }}
          >
            <span className="cmp-stop-sq" aria-hidden />
          </button>,
        )}
    </div>
  );
});
