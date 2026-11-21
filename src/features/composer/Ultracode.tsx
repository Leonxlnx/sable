import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import { pulseFrom, reducedMotion } from '@/lib/motion';

const CHARGE_MS = 520;
/** When the charge lands on the top level (composer.css: the last bar's delay plus its rise). */
const LAND_MS = 200;
const DRAIN_MS = 400;

type Phase = 'charge' | 'on' | 'drain';

/**
 * The composer's "ultra" edge (ultracode on, or an Ultra level). Turning it on is one beat: the
 * charge runs up the effort meter into its top level (composer.css `th-charge`), and as it lands
 * the card's whole edge takes the light at once and settles to a faint, still hairline, with one
 * pulse of the backdrop from it. Opacity only; nothing travels, nothing loops.
 */
export const UltraEdge = memo(function UltraEdge({ on, card }: { on: boolean; card: RefObject<HTMLElement | null> }) {
  const [phase, setPhase] = useState<Phase | null>(on ? 'on' : null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const still = reducedMotion();
    if (on) {
      if (still) return setPhase('on');
      setPhase('charge');
      // The backdrop answers when the charge reaches the top of the meter, with the edge.
      const p = window.setTimeout(() => pulseFrom(card.current, 0.9), LAND_MS);
      const t = window.setTimeout(() => setPhase('on'), CHARGE_MS);
      return () => {
        window.clearTimeout(p);
        window.clearTimeout(t);
      };
    }
    if (still) return setPhase(null);
    setPhase((p) => (p ? 'drain' : null));
    const t = window.setTimeout(() => setPhase(null), DRAIN_MS);
    return () => window.clearTimeout(t);
  }, [on, card]);

  if (!phase) return null;
  return (
    <span className="uc" data-phase={phase} aria-hidden>
      <span className="uc-ring" />
      <span className="uc-bloom" />
      {phase === 'charge' && <span className="uc-flash" />}
    </span>
  );
});
