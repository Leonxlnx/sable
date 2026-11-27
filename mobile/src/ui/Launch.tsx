import { animate } from 'motion';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LogoMark } from './marks';
import { reduced, SPRING } from './motion';
import { veil } from './veil';
import { saver } from '@m/lib/saver';

/**
 * The launch, as on the desktop but at hand speed: the mark builds from its own cells where
 * Android's splash left it, then a crest opens the ink in dither order onto home while the mark
 * glides to its place in the bar. After pairing it starts from the pairing screen's mark instead.
 * A touch ends it at once; nothing is left running.
 */
let from: DOMRect | null = null;
/** The pairing screen's mark, to glide from when home first shows. */
export const launchFrom = (r: DOMRect) => void (from = r);

export function Launch({ onDone }: { onDone: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const [start] = useState(() => from);
  useEffect(() => {
    from = null;
  }, []);
  const done = useRef(onDone);
  done.current = onDone;

  useLayoutEffect(() => {
    const el = mark.current;
    if (!el || !start) return;
    // From the pairing screen's mark: start where it was, at its size.
    const size = 64;
    el.style.transform = `translate(${start.left + start.width / 2 - innerWidth / 2}px, ${start.top + start.height / 2 - innerHeight / 2}px) scale(${start.width / size})`;
  }, [start]);

  useEffect(() => {
    const h = host.current;
    const m = mark.current;
    if (!h || !m) return;
    let over = false;
    const stops: { stop: () => void }[] = [];
    const finish = () => {
      if (over) return;
      over = true;
      stops.forEach((s) => s.stop());
      done.current();
    };
    if (reduced() || saver()) {
      const t = setTimeout(finish, 60);
      return () => clearTimeout(t);
    }
    const target = document.querySelector('.home-mark');
    const go = () => {
      if (over) return;
      // The ink opens from the bottom (where the field's light is) in dither order...
      h.style.background = 'transparent';
      const v = veil(h, 'reveal', { color: '#070708', bands: 9, from: 'bottom', duration: 380, cell: 4, z: 0 });
      // ...while the mark glides to its place (or simply goes, when a screen covers home).
      // A chat restored over home: the mark has no place in sight to go to; it simply goes.
      const r = document.querySelector('.layer') ? undefined : target?.getBoundingClientRect();
      if (r && r.width && r.top > -10) {
        const size = 64;
        const x = r.left + r.width / 2 - innerWidth / 2;
        const y = r.top + r.height / 2 - innerHeight / 2;
        stops.push(animate(m, { transform: [m.style.transform || 'translate(0px, 0px) scale(1)', `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${(r.width / size).toFixed(4)})`] }, SPRING));
        stops.push(animate(m, { opacity: [1, 0] }, { duration: 0.12, delay: 0.32 }));
      } else stops.push(animate(m, { opacity: [1, 0], transform: ['scale(1)', 'scale(0.9)'] }, { duration: 0.2 }));
      void v.done.then(() => setTimeout(finish, 40));
    };
    // The cells build (CSS, in dither order), hold a beat, then open.
    const t = setTimeout(go, start ? 40 : 240);
    const skip = () => finish();
    window.addEventListener('pointerdown', skip, { once: true });
    const safety = setTimeout(finish, 1600);
    return () => {
      clearTimeout(t);
      clearTimeout(safety);
      window.removeEventListener('pointerdown', skip);
      stops.forEach((s) => s.stop());
    };
  }, [start]);

  return (
    <div className="launch" ref={host} aria-hidden>
      <div className="launch-mark" ref={mark} data-from={start ? '' : undefined}>
        <LogoMark size={64} cells />
      </div>
    </div>
  );
}
