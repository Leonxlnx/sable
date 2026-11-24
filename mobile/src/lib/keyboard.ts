/**
 * The page's edges and the keyboard, as the native side reports them (android/…/PageInsets.java),
 * in one place: how far the status bar, the gesture pill and a camera cutout reach into each edge
 * (`--sat` `--sar` `--sab` `--sal`, base.css), and how far the keyboard lifts the page's bottom and
 * over how long it slides (`--kb`, `--kb-ms`: CSS lifts on the keyboard's curve; `onKeyboard` lets
 * a scroller glide its newest line up with it). The page keeps its size; nothing else reads the
 * bars or the keyboard. In a browser (no native side) `env(safe-area-inset-*)` and the visual
 * viewport stand in.
 */
type Sub = (lift: number, prev: number, ms: number) => void;

/** Each edge's bars in CSS px: top, right, bottom, left. */
export type Edges = [number, number, number, number];

declare global {
  interface Window {
    __sableInsets?: (edges: Edges, lift: number, ms: number) => void;
    __sableInsetsState?: [Edges, number, number];
  }
}

let lift = 0;
const subs = new Set<Sub>();
const root = document.documentElement;

/** The CSS value for one edge: whole CSS px, never negative (a value that is not a number is none). */
export const edgePx = (v: unknown) => `${typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0}px`;

/** How far the page's bottom rises: the keyboard's top over the screen's bottom, less the gesture bar's room the page keeps anyway. */
export const liftPx = (keyboard: unknown) => (typeof keyboard === 'number' && Number.isFinite(keyboard) && keyboard > 0 ? Math.round(keyboard) : 0);

let edgesKey = '';
function setEdges(edges: Edges) {
  const key = edges.map(edgePx).join(' ');
  if (key === edgesKey) return;
  edgesKey = key;
  const [t, r, b, l] = key.split(' ');
  root.style.setProperty('--sat', t);
  root.style.setProperty('--sar', r);
  root.style.setProperty('--sab', b);
  root.style.setProperty('--sal', l);
  root.setAttribute('data-insets', '');
}

function setLift(raw: number, ms: number) {
  const next = liftPx(raw);
  const prev = lift;
  if (next === prev) return;
  lift = next;
  root.style.setProperty('--kb-ms', `${Math.round(ms)}ms`);
  root.style.setProperty('--kb', `${next}px`);
  if (next > 0) root.setAttribute('data-kb', '');
  else root.removeAttribute('data-kb');
  subs.forEach((f) => f(next, prev, ms));
}

function apply(edges: Edges, raw: number, ms: number) {
  if (Array.isArray(edges) && edges.length === 4) setEdges(edges);
  setLift(raw, ms);
}

window.__sableInsets = apply;
if (window.__sableInsetsState) {
  const [e, l] = window.__sableInsetsState;
  apply(e, l, 0);
}

// A browser: the visual viewport shrinks for the keyboard (dev and the web preview only).
if (!('Capacitor' in window && (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) && window.visualViewport) {
  const vv = window.visualViewport;
  vv.addEventListener('resize', () => {
    const k = Math.max(0, window.innerHeight - vv.height);
    if (k > 120 || lift > 0) setLift(k > 120 ? k : 0, 260);
  });
}

export const keyboardLift = () => lift;

export function onKeyboard(f: Sub) {
  subs.add(f);
  return () => void subs.delete(f);
}
