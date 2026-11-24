import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { fieldBeat } from '@/art/events';
import { Icon, playIcons } from '@/icons';
import { isMac } from '@/lib/format';
import { reducedMotion } from '@/lib/motion';
import { Tip } from '@/ui';
import { Chip, type ChipPart } from './Chip';
import { CoveRing } from './Cove';
import { ultraKeys } from './effort-track';

/**
 * Ultracode on the bar: a switch of its own beside the phrase, at any level (it is no level and
 * never takes the level's word; effort-track.ts).
 * - Off: its mark alone, a bare round chip of 28 in a quiet tone, like every chip without a fill.
 * - On: a chip that is on (the hover fill held, the hairline a step up, the mark ivory) with the
 *   word "Ultracode" after the mark; a narrow pane keeps the mark alone (composer.css).
 * The chip's end by the phrase holds. Turning on, its other end opens away from the phrase with
 * the mark riding on it, and the word rolls up into the room behind (Chip.tsx: one glide on the
 * compositor, about 150 ms); off is the same backwards. A click, Alt+U from anywhere in the
 * composer, or its row in the model and effort panel: one switch, three ways to it.
 */
export const UltraChip = memo(function UltraChip({ on, onToggle, late }: { on: boolean; onToggle: (on: boolean) => void; late?: boolean }) {
  // A chip that joins a bar already standing (the agent said only now that it offers ultracode)
  // comes in once, as the chips that stood as placeholders do (composer.css `data-late`).
  const [cameLate] = useState(!!late);
  // The word rolls the way the switch went, only in the render that switches it.
  const was = useRef(on);
  const roll = was.current === on ? undefined : on ? 'up' : 'down';
  useLayoutEffect(() => {
    was.current = on;
  });
  // Turned on from elsewhere (the key, the panel's switch): the mark answers as it does under the
  // pointer, one step up and home (icons/animated/play.ts). Pressed here, it already has.
  const chip = useRef<HTMLButtonElement>(null);
  const pressed = useRef(false);
  const first = useRef(true);
  // Turning off, the chip closes as it opened: its fill stays while its far end comes home with
  // the mark riding on it, and lets go only then (composer.css `data-closing`). Without it the
  // fill was gone in three frames and the mark slid along the bar alone.
  const wasOn = useRef(on);
  useLayoutEffect(() => {
    const el = chip.current;
    const closing = wasOn.current && !on;
    wasOn.current = on;
    if (!el || !closing || reducedMotion()) return;
    el.setAttribute('data-closing', '');
    const t = window.setTimeout(() => el.removeAttribute('data-closing'), CLOSE_MS);
    return () => {
      window.clearTimeout(t);
      el.removeAttribute('data-closing');
    };
  }, [on]);
  useEffect(() => {
    const own = pressed.current;
    pressed.current = false;
    if (first.current) {
      first.current = false;
      return;
    }
    if (on && !own && chip.current && !reducedMotion()) playIcons(chip.current);
  }, [on]);
  const parts: ChipPart[] = [{ k: 'mark', className: 'ux-mark', node: <Icon name="ultracode" size={14} /> }];
  if (on) parts.push({ k: 'word', className: 'ux-word', node: 'Ultracode' });
  return (
    <Tip label="Ultracode" keys={ultraKeys(isMac)} side="top">
      <Chip
        ref={chip}
        className="tb-chip ux"
        anchor="right"
        data-on={on || undefined}
        data-roll={roll}
        data-late={cameLate || undefined}
        aria-label="Ultracode"
        aria-pressed={on}
        aria-keyshortcuts={`${isMac ? 'Meta+Alt' : 'Alt'}+U`}
        parts={parts}
        onClick={() => {
          pressed.current = true;
          onToggle(!on);
        }}
      />
    </Tip>
  );
});

/** How long the closing chip keeps its fill: until its end is home (Chip.tsx: a shrinking skin waits 36 ms, then glides about 140). */
const CLOSE_MS = 180;

/** When the field answers: as the word arrives on the chip. */
const BEAT_AT = 70;
/** How strong: a real beat (the send wave's own shape at about its strength, with no flash where it starts). */
const BEAT = 1.5;
/** How long the clearer hairline takes to come up, and to let go. */
const RISE_MS = 340;
const DRAIN_MS = 280;

type Phase = 'rise' | 'on' | 'drain';

/**
 * The composer's "ultra" edge (ultracode on, or an Ultra level), and the moment it turns on.
 *
 * Even, all of it: the chip turns on (above), the pane's rim takes one slightly clearer hairline
 * that comes up all round at once (the same strength on every side and round every corner, the
 * cove included: it is the rim's own ring, Cove.tsx `CoveRing`), and the field answers once with
 * a wave from the chip. Off is the small version: the hairline lets go while the chip closes.
 *
 * Opacity only, monochrome, nothing runs round the rim and nothing loops; reduced motion swaps the
 * states. A view that opens with it on shows it on, without the moment.
 */
export const UltraEdge = memo(function UltraEdge({ on, card }: { on: boolean; card: RefObject<HTMLElement | null> }) {
  const [phase, setPhase] = useState<Phase | null>(on ? 'on' : null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reducedMotion()) return setPhase(on ? 'on' : null);
    if (on) {
      setPhase('rise');
      // The field answers from where it was turned on: ultracode's chip (the phrase for an Ultra level).
      const beat = window.setTimeout(() => fieldBeat('pulse', beatFrom(card.current), BEAT), BEAT_AT);
      const t = window.setTimeout(() => setPhase('on'), RISE_MS + 40);
      return () => {
        window.clearTimeout(beat);
        window.clearTimeout(t);
      };
    }
    setPhase((p) => (p ? 'drain' : null));
    const t = window.setTimeout(() => setPhase(null), DRAIN_MS + 40);
    return () => window.clearTimeout(t);
  }, [on, card]);

  if (!phase) return null;
  return (
    <span className="uc" data-phase={phase} aria-hidden>
      <CoveRing className="uc-line" />
    </span>
  );
});

/** Where the beat starts: ultracode's chip when it is on, else the phrase, else the pane. */
function beatFrom(card: HTMLElement | null): Element | null {
  return card?.querySelector('.ux[data-on]') ?? card?.querySelector('.ph') ?? card;
}
