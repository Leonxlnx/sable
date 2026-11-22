/**
 * The agent's pointer in the Browser tab: one calm mark of the app's own, drawn by the tab over the
 * page (never inside the page's DOM), that travels to what the agent is about to click, presses,
 * and only then lets the click happen. One layer, transform and opacity only, nothing at rest.
 *
 * Every number of its motion is here, in `POINTER`, so the curve and the timings can be tuned in one
 * place. A move takes `moveMin` to `moveMax` by distance on a slight bow; the press is `pressDown` +
 * `pressUp` (the mark gives, a ring leaves from the point). With reduced motion the mark simply
 * appears at the target and presses without travel.
 */

export const POINTER = {
  /** Travel: `moveMin` for a short hop, growing by `msPerPx` with the distance, never past `moveMax`. */
  moveMin: 250,
  moveMax: 450,
  msPerPx: 0.5,
  /** The path bows to one side by this share of its length (0: a straight line), at most `bowMax` px. */
  bow: 0.12,
  bowMax: 60,
  /** Keyframes sampled along the path. */
  samples: 14,
  /** Starts briskly, lands softly: the arrival reads as a decision. */
  ease: 'cubic-bezier(0.3, 0.0, 0.16, 1)',
  /** The press: the mark gives to `pressScale` in `pressDown`, then springs back in `pressUp`. */
  pressDown: 50,
  pressUp: 70,
  pressScale: 0.82,
  /** The ring that leaves from the point on a press. */
  ring: 420,
  ringFrom: 0.3,
  ringTo: 1.7,
  ringOpacity: 0.5,
  /** Where the mark first appears, relative to its first target (it fades in on the way). */
  enterFrom: { x: -48, y: 56 },
  /** Fade in and out. */
  fade: 140,
  /** After the last action the mark rests this long, then fades. */
  restAfter: 2400,
} as const;

/** How long a move of `dist` px takes. */
export function moveDuration(dist: number): number {
  return Math.round(Math.min(POINTER.moveMax, Math.max(POINTER.moveMin, POINTER.moveMin + Math.max(0, dist - 40) * POINTER.msPerPx)));
}

/** Points along the bowed path from `a` to `b` (a quadratic curve; the bow always turns the same way for a direction). */
export function pathPoints(a: { x: number; y: number }, b: { x: number; y: number }, n: number = POINTER.samples): { x: number; y: number }[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const bow = Math.min(POINTER.bowMax, len * POINTER.bow);
  // The control point: off the midpoint, perpendicular to the line.
  const cx = (a.x + b.x) / 2 + (len ? (-dy / len) * bow : 0);
  const cy = (a.y + b.y) / 2 + (len ? (dx / len) * bow : 0);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const u = 1 - t;
    out.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y });
  }
  return out;
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const px = (p: { x: number; y: number }) => `translate3d(${Math.round(p.x * 2) / 2}px, ${Math.round(p.y * 2) / 2}px, 0)`;

export interface AgentPointer {
  /** Travels to `p` (pixels of the layer); resolves on arrival. */
  moveTo(p: { x: number; y: number }): Promise<void>;
  /** Presses: resolves at the bottom of the press (the moment the click lands); the release plays on by itself. */
  press(): Promise<void>;
  /** Fades out now. */
  hide(): void;
  dispose(): void;
}

/** The pointer inside `layer` (an element that covers the page, pointer-events none). */
export function createPointer(layer: HTMLElement): AgentPointer {
  const root = document.createElement('div');
  root.className = 'bw-pointer';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML =
    '<span class="bw-pointer-ring"></span>' +
    // An arrow with its point at (1.5, 1.5): ivory face, ink edge, a soft drop drawn as a second shape (no filter).
    '<svg class="bw-pointer-mark" width="20" height="22" viewBox="0 0 20 22">' +
    '<path class="bw-pointer-drop" d="M2.5 3.2 L2.5 18.2 L6.4 14.6 L9 20.4 L12 19.1 L9.5 13.4 L14.9 13.2 Z"/>' +
    '<path class="bw-pointer-face" d="M1.5 1.5 L1.5 16.5 L5.4 12.9 L8 18.7 L11 17.4 L8.5 11.7 L13.9 11.5 Z"/>' +
    '</svg>';
  layer.appendChild(root);
  const mark = root.querySelector('svg') as SVGSVGElement;
  const ring = root.querySelector('.bw-pointer-ring') as HTMLElement;

  let at: { x: number; y: number } | null = null;
  let shown = false;
  let travel: Animation | undefined;
  let restTimer: ReturnType<typeof setTimeout> | undefined;

  const show = () => {
    if (shown) return;
    shown = true;
    root.dataset.on = '';
    if (!reduced()) root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: POINTER.fade, easing: 'linear' });
  };
  const rest = () => {
    clearTimeout(restTimer);
    restTimer = setTimeout(hide, POINTER.restAfter);
  };
  const hide = () => {
    clearTimeout(restTimer);
    if (!shown) return;
    shown = false;
    at = null;
    const done = () => {
      if (!shown) delete root.dataset.on;
    };
    if (reduced()) return done();
    root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: POINTER.fade, easing: 'linear' }).finished.then(done, done);
  };

  return {
    async moveTo(p) {
      clearTimeout(restTimer);
      // Will-change only while it moves.
      root.style.willChange = 'transform';
      const from = at ?? { x: p.x + POINTER.enterFrom.x, y: p.y + POINTER.enterFrom.y };
      if (travel) {
        // A move that comes while one runs starts from where the mark is now.
        try {
          travel.commitStyles();
        } catch {
          /* not rendered */
        }
        travel.cancel();
      }
      show();
      if (reduced()) {
        root.style.transform = px(p);
        at = p;
        root.style.willChange = '';
        return;
      }
      const dist = Math.hypot(p.x - from.x, p.y - from.y);
      const frames = pathPoints(from, p).map((q) => ({ transform: px(q) }));
      root.style.transform = px(p);
      travel = root.animate(frames, { duration: moveDuration(dist), easing: POINTER.ease });
      at = p;
      try {
        await travel.finished;
      } catch {
        /* replaced by the next move */
      }
      root.style.willChange = '';
      rest();
    },
    async press() {
      clearTimeout(restTimer);
      show();
      if (reduced()) {
        rest();
        return;
      }
      const total = POINTER.pressDown + POINTER.pressUp;
      const k = POINTER.pressDown / total;
      mark.animate([{ transform: 'scale(1)' }, { transform: `scale(${POINTER.pressScale})`, offset: k }, { transform: 'scale(1)' }], { duration: total, easing: 'ease-out' });
      ring.animate(
        [
          { transform: `scale(${POINTER.ringFrom})`, opacity: 0 },
          { transform: `scale(${POINTER.ringFrom + (POINTER.ringTo - POINTER.ringFrom) * 0.12})`, opacity: POINTER.ringOpacity, offset: 0.1 },
          { transform: `scale(${POINTER.ringTo})`, opacity: 0 },
        ],
        { duration: POINTER.ring, delay: POINTER.pressDown * 0.6, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
      );
      await new Promise((r) => setTimeout(r, POINTER.pressDown));
      rest();
    },
    hide,
    dispose() {
      clearTimeout(restTimer);
      travel?.cancel();
      root.remove();
    },
  };
}
