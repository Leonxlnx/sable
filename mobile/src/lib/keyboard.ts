/**
 * The page's edges and the keyboard, as the native side reports them (android/…/PageInsets.java),
 * in one place: how far the status bar, the gesture pill and a camera cutout reach into each edge
 * (`--sat` `--sar` `--sab` `--sal`, base.css), and how far the keyboard lifts the page's bottom and
 * over how long it slides (`--kb`, `--kb-ms`: CSS lifts on the keyboard's curve; `onKeyboard` lets
 * a scroller glide its newest line up with it). The page keeps its size; nothing else reads the
 * bars or the keyboard. In a browser (no native side) `env(safe-area-inset-*)` and the visual
 * viewport stand in.
 *
 * Where a pane that floats at the foot stands (2.18, `--pane-foot`, base.css): the bottom edge the
 * native side reports is the larger of the navigation bar and the strip where the system's own
 * gestures win. That strip already holds its own room (on a Pixel 32 px against a 24 px bar; some
 * phones report a bar of 0 and a strip of 32 or more), so a pane stands ON it, with a hair of air,
 * never a whole comfort gap above it again: that double gap stood the prompt bars far up. When the
 * native side also says how tall the navigation bar itself is (`nav`, a fourth argument), the pane
 * stands one gap above the bar and may reach into the gesture strip, as the system's own apps do.
 *
 * The keyboard's lift is believed only while a field has the focus (a lift the native side never
 * took back after the keyboard went, as some phones' keyboards leave it, stood every bar a keyboard
 * high), and never counted twice: when the system made the page itself shorter for the keyboard
 * (the window resized, or the WebView's visual viewport shrank), only what is left is lifted.
 */
type Sub = (lift: number, prev: number, ms: number) => void;

/** Each edge's bars in CSS px: top, right, bottom, left. */
export type Edges = [number, number, number, number];

declare global {
  interface Window {
    __sableInsets?: (edges: Edges, lift: number, ms: number, nav?: number) => void;
    __sableInsetsState?: [Edges, number, number, number?];
  }
}

let lift = 0;
/** What the native side last said the keyboard lifts, before the page's own checks. */
let raw = 0;
let rawMs = 280;
const subs = new Set<Sub>();
const root = document.documentElement;

/** The CSS value for one edge: whole CSS px, never negative (a value that is not a number is none). */
export const edgePx = (v: unknown) => `${typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0}px`;

/** How far the page's bottom rises: the keyboard's top over the screen's bottom, less the gesture bar's room the page keeps anyway. */
export const liftPx = (keyboard: unknown) => (typeof keyboard === 'number' && Number.isFinite(keyboard) && keyboard > 0 ? Math.round(keyboard) : 0);

/**
 * The lift the page applies: none while no field has the focus (a keyboard cannot be typing into
 * nothing), and less whatever the system already took off the page's height for the keyboard.
 */
export function effectiveLift(o: { raw: number; focused: boolean; full: number; height: number; visual?: number }): number {
  if (!o.focused || !(o.raw > 0)) return 0;
  const shorter = Math.max(0, o.full - o.height);
  const panned = o.visual !== undefined ? Math.max(0, o.height - o.visual) : 0;
  return Math.max(0, Math.round(o.raw - shorter - panned));
}

/** A field the keyboard types into. */
export const editable = (el: Element | null | undefined) => {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !/^(button|checkbox|radio|range|file|submit|reset|color|hidden|image)$/i.test((el as HTMLInputElement).type ?? '');
  return !!(el as HTMLElement).isContentEditable;
};

let edgesKey = '';
function setEdges(edges: Edges, nav?: number) {
  const navKey = typeof nav === 'number' && Number.isFinite(nav) && nav >= 0 ? edgePx(nav) : '';
  const key = edges.map(edgePx).join(' ') + '|' + navKey;
  if (key === edgesKey) return;
  edgesKey = key;
  const [t, r, b, l] = key.split('|')[0].split(' ');
  root.style.setProperty('--sat', t);
  root.style.setProperty('--sar', r);
  root.style.setProperty('--sab', b);
  root.style.setProperty('--sal', l);
  if (navKey) {
    root.style.setProperty('--sab-nav', navKey);
    root.setAttribute('data-nav', '');
  } else if (root.hasAttribute?.('data-nav')) {
    root.style.removeProperty('--sab-nav');
    root.removeAttribute('data-nav');
  }
  root.setAttribute('data-insets', '');
}

/** The page's own height for this orientation with no keyboard: the tallest seen since it last turned. */
let full = { key: '', h: 0 };
function fullHeight(): number {
  const h = window.innerHeight ?? 0;
  const key = (window.innerWidth ?? 0) > h ? 'land' : 'port';
  if (full.key !== key) full = { key, h: 0 };
  full.h = Math.max(full.h, h);
  return full.h || h;
}

function applyLift(ms: number) {
  const native = 'Capacitor' in window && !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  const next = native
    ? effectiveLift({ raw, focused: editable(document.activeElement), full: fullHeight(), height: window.innerHeight ?? 0, visual: window.visualViewport?.height })
    : editable(document.activeElement)
      ? raw
      : 0;
  const prev = lift;
  if (next === prev) return;
  lift = next;
  root.style.setProperty('--kb-ms', `${Math.round(ms)}ms`);
  root.style.setProperty('--kb', `${next}px`);
  if (next > 0) root.setAttribute('data-kb', '');
  else root.removeAttribute('data-kb');
  subs.forEach((f) => f(next, prev, ms));
}

function setLift(value: number, ms: number) {
  raw = liftPx(value);
  rawMs = ms;
  applyLift(ms);
}

function apply(edges: Edges, value: number, ms: number, nav?: number) {
  if (Array.isArray(edges) && edges.length === 4) setEdges(edges, nav);
  setLift(value, ms);
}

window.__sableInsets = apply;
if (window.__sableInsetsState) {
  const [e, l, , nav] = window.__sableInsetsState;
  apply(e, l, 0, nav);
}

// Focus leaving every field (a tap outside, a sheet opening, the field going away): the bars come
// down with the keyboard, whatever the native side says later. A focus moving from one field to the
// next keeps the lift (checked once the move is done).
let focusTimer = 0;
const recheck = () => {
  clearTimeout(focusTimer);
  focusTimer = window.setTimeout(() => applyLift(rawMs || 280), 60);
};
document.addEventListener?.('focusin', recheck);
document.addEventListener?.('focusout', recheck);
// Back on screen, or the page's size changed under it (a turn, a system that resized the window):
// what is lifted is worked out again.
document.addEventListener?.('visibilitychange', () => !document.hidden && applyLift(0));
window.addEventListener?.('resize', () => applyLift(0));
window.visualViewport?.addEventListener('resize', () => applyLift(0));

// A browser: the visual viewport shrinks for the keyboard (dev and the web preview only).
if (!('Capacitor' in window && (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) && window.visualViewport) {
  const vv = window.visualViewport;
  vv.addEventListener('resize', () => {
    const k = Math.max(0, window.innerHeight - vv.height);
    if (k > 120 || raw > 0) setLift(k > 120 ? k : 0, 260);
  });
}

export const keyboardLift = () => lift;

export function onKeyboard(f: Sub) {
  subs.add(f);
  return () => void subs.delete(f);
}
