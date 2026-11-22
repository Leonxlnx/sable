import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { fieldBeatAt } from '@/art/events';
import { play, reducedMotion, uiZoom } from '@/lib/motion';
import { CoveRing } from './Cove';
import { rimRun, type RunStop } from './ultra-run';

/** When the lights leave the chip (the scale's pips have charged up to its end by then, composer.css `th-pip-wave`). */
const RUN_AT = 130;
/** How long they take round the outline. */
const RUN_MS = 500;
/** How long the meeting holds before the lights are gone. */
const MEET_MS = 150;
const DRAIN_MS = 300;
/** The lights' eased speed: off at once, coasting into the meeting. */
const RUN_EASE = 'cubic-bezier(0.3, 0.1, 0.25, 1)';

type Phase = 'run' | 'on' | 'drain';

const frames = (stops: RunStop[]): Keyframe[] => stops.map((s) => ({ transform: `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`, offset: s.at }));

/**
 * The composer's "ultra" edge (ultracode on, or an Ultra level), and the moment it turns on.
 *
 * One movement in three parts, a little over 700 ms on one clock:
 * - the beginning is the scale's (Thinking.tsx): its pips charge up to the end and the stop past
 *   the end fills, while the chip's word glides to its new name;
 * - the act: where the chip stands, two lights leave along the pane's rim, one each way round the
 *   outline, the cove included, at one speed (ultra-run.ts has the path);
 * - the settle: they meet on the far side, the rim keeps a still, slightly clearer hairline, and
 *   the field answers once from where they met.
 * Turning it off is the small one: the hairline lets go while the pips fall back to the level.
 *
 * The lights are soft discs moved inside rings on the rim's own pixels (the rim's two parts, as
 * the pointer's light is), so only the hairline under them shows: transform and opacity, nothing
 * else, monochrome, and nothing loops. Reduced motion swaps the states.
 */
export const UltraEdge = memo(function UltraEdge({ on, card }: { on: boolean; card: RefObject<HTMLElement | null> }) {
  const [phase, setPhase] = useState<Phase | null>(on ? 'on' : null);
  const first = useRef(true);
  const ring = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const still = reducedMotion();
    if (on) {
      if (still) return setPhase('on');
      setPhase('run');
      const t = window.setTimeout(() => setPhase('on'), RUN_AT + RUN_MS + MEET_MS + 40);
      return () => window.clearTimeout(t);
    }
    if (still) return setPhase(null);
    setPhase((p) => (p ? 'drain' : null));
    const t = window.setTimeout(() => setPhase(null), DRAIN_MS + 40);
    return () => window.clearTimeout(t);
  }, [on]);

  // The act: measured once, then four discs (two lights, each in the rim's two parts) run on the compositor.
  useLayoutEffect(() => {
    if (phase !== 'run') return;
    const host = card.current;
    const el = ring.current;
    if (!host || !el) return;
    const z = uiZoom();
    const box = host.getBoundingClientRect();
    const chip = host.querySelector('.th-chip')?.getBoundingClientRect();
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    const x0 = chip && chip.width ? (chip.left + chip.width / 2 - box.left) / z : w - 120;
    const run = rimRun(w, h, x0);
    const timing: KeyframeAnimationOptions = { duration: RUN_MS, delay: RUN_AT, easing: RUN_EASE, fill: 'both' };
    const whole = RUN_AT + RUN_MS + MEET_MS;
    // Each light comes up as it leaves, holds, and goes out where the two have met.
    const light: Keyframe[] = [
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: RUN_AT / whole },
      { opacity: 1, offset: (RUN_AT + 70) / whole },
      { opacity: 1, offset: (RUN_AT + RUN_MS) / whole },
      { opacity: 0, offset: 1 },
    ];
    for (const disc of el.querySelectorAll<HTMLElement>('b')) {
      play(disc, frames(disc.dataset.way === 'a' ? run.a : run.b), timing);
      play(disc, light, { duration: whole, easing: 'linear', fill: 'both' });
    }
    // The field answers where they meet, as they meet.
    const beat = window.setTimeout(() => fieldBeatAt('pulse', box.left + run.meet.x * z, box.top + run.meet.y * z, 0.85), RUN_AT + RUN_MS - 30);
    return () => window.clearTimeout(beat);
  }, [phase, card]);

  if (!phase) return null;
  return (
    <span className="uc" data-phase={phase} aria-hidden>
      <CoveRing className="uc-line" />
      {phase === 'run' && (
        <span ref={ring} className="cove-ring uc-run">
          <i className="cr-edge">
            <b data-way="a" />
            <b data-way="b" />
          </i>
          <i className="cr-cove">
            <b data-way="a" />
            <b data-way="b" />
          </i>
        </span>
      )}
    </span>
  );
});
