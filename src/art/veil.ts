/**
 * The dither dissolve: a surface covers and uncovers itself through the app's ordered dither,
 * the way the mark builds in the launch intro (sparse, then a checker, then solid).
 *
 * Four layers in the surface colour sit over the content, each holding one quarter of a 4x4 Bayer
 * tile (the same order as MARK_CELLS), so together they step from a sparse scatter to solid. Each
 * layer is painted once when it is created; after that only its opacity changes, so the whole
 * dissolve runs on the compositor and nothing under it is laid out or repainted, however busy the
 * main thread is (a view mounting underneath, for one). No masks, no filters.
 *
 * - `swap`: covers what is there, holds solid for a frame while the caller swaps the content, and
 *   uncovers the new content (`VEIL_SWAP` ms, the content swap at `VEIL_SWAP_AT` of it).
 * - `reveal`: starts solid and uncovers (new content resolving out of the ground).
 * - `cover`: covers (content dissolving into the ground before it goes).
 *
 * A change of view is two calls on one clock (`veilCover`, then `veilReveal`): the cover starts in
 * the frame of the input, before the new view is built, and stays solid for as long as building
 * takes; the reveal is tied to the cover's own time, and what goes and what comes switch at the
 * moment it is solid, by animations of their own on that same clock. The density only ever goes
 * one way: up to solid, then down. (With the views switched by the page's script instead, a view
 * that took 300 ms to build showed under the cover while it was still closing: denser, solid, then
 * sparser over content that had been in full view.)
 *
 * Reduced motion: nothing is drawn (callers fade instead).
 */

export type VeilMode = 'swap' | 'reveal' | 'cover';

/** The whole swap, and the point in it (0..1) where the cover is solid and the content changes. */
export const VEIL_SWAP = 260;
export const VEIL_SWAP_AT = 0.4;

/** 4x4 ordered dither: the rank of each cell (row-major). */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const tiles = new Map<string, string[]>();

/** The four quarter tiles (ranks 0-3, 4-7, 8-11, 12-15) as SVG data URLs, for one colour and cell size. */
export function quarterTiles(color: string, cell: number): string[] {
  const key = `${color}/${cell}`;
  let t = tiles.get(key);
  if (t) return t;
  const size = cell * 4;
  t = [0, 1, 2, 3].map((q) => {
    let d = '';
    for (let i = 0; i < 16; i++) {
      if (BAYER4[i] >> 2 !== q) continue;
      const x = (i & 3) * cell;
      const y = (i >> 2) * cell;
      d += `M${x} ${y}h${cell}v${cell}h-${cell}z`;
    }
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' shape-rendering='crispEdges'><path fill='${color}' d='${d}'/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  });
  tiles.set(key, t);
  return t;
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The surface colour, resolved once per token (the veil must match what is under the content). */
const colours = new Map<string, string>();
export function resolve(token: string): string {
  let c = colours.get(token);
  if (c) return c;
  if (!token.startsWith('--')) return token;
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  // An SVG fill takes any CSS colour; fall back to the stage colour if the token is missing.
  c = v || '#0c0c0e';
  colours.set(token, c);
  return c;
}

/** The running veil per host: a new one replaces it (a quick second navigation restarts cleanly). */
const live = new WeakMap<HTMLElement, { el: HTMLElement; anims: Animation[] }>();

/** Each quarter's window, as offsets into the run: when it turns on and when it turns off. */
function windows(mode: VeilMode): [number, number][] {
  if (mode === 'cover') return [0, 1, 2, 3].map((q) => [q * 0.24, 2]);
  if (mode === 'reveal') return [0, 1, 2, 3].map((q) => [-1, 1 - (q + 1) * 0.24]);
  // swap: on in Bayer order up to the hold, off in reverse after it, so the new content resolves sparse first.
  const a = VEIL_SWAP_AT;
  return [0, 1, 2, 3].map((q) => [q * (a / 4) - 0.02, a + 0.04 + (3 - q) * ((1 - a - 0.06) / 4)]);
}

/**
 * Plays a dither dissolve over `host` (positioned; the veil fills it). Returns a promise that
 * settles when it is gone. `color` is the surface colour under the content (a token or a colour).
 */
export function veil(host: HTMLElement | null, mode: VeilMode, opts: { duration?: number; color?: string; cell?: number } = {}): Promise<void> {
  if (!host || reduced() || typeof host.animate !== 'function') return Promise.resolve();
  const duration = opts.duration ?? (mode === 'swap' ? VEIL_SWAP : 200);
  const layers = quarterTiles(resolve(opts.color ?? '--sheet'), opts.cell ?? 4);
  live.get(host)?.el.remove();
  // The veil fills its host: a static host would let it spread over whatever ancestor is positioned.
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const el = document.createElement('div');
  el.className = 'veil';
  el.setAttribute('aria-hidden', 'true');
  const step = 16 / duration;
  const anims: Animation[] = [];
  windows(mode).forEach(([on, off], q) => {
    const layer = document.createElement('i');
    layer.style.backgroundImage = layers[q];
    layer.style.backgroundSize = `${(opts.cell ?? 4) * 4}px`;
    el.appendChild(layer);
    // A quarter switches over about one frame, so each step reads as a step of the dither, not a fade.
    const frames: Keyframe[] = [];
    const push = (offset: number, opacity: number) => {
      const o = Math.min(1, Math.max(0, offset));
      if (frames.length && o <= (frames[frames.length - 1].offset as number)) frames[frames.length - 1].opacity = opacity;
      else frames.push({ offset: o, opacity });
    };
    push(0, on <= 0 ? 1 : 0);
    if (on > 0 && on < 1) {
      push(on, 0);
      push(on + step, 1);
    }
    if (off > 0 && off < 1) {
      push(off, 1);
      push(off + step, 0);
    }
    push(1, off >= 1 ? 1 : 0);
    if (frames.length === 1) frames.push({ offset: 1, opacity: frames[0].opacity });
    anims.push(layer.animate(frames, { duration, easing: 'linear', fill: 'both' }));
  });
  host.appendChild(el);
  const entry = { el, anims };
  live.set(host, entry);
  return Promise.all(anims.map((a) => a.finished)).then(
    () => {
      if (live.get(host) === entry) live.delete(host);
      // A cover stays until its host goes (the caller removes the content under it).
      if (mode !== 'cover') el.remove();
    },
    () => {
      if (live.get(host) === entry) live.delete(host);
      el.remove();
    },
  );
}

// ── a change of view: cover at the input, reveal when the new view is there ──

/** The cover's steps and the uncovering's (ms each); a step's two states are a frame apart. */
export const VEIL_STEP_IN = 22;
export const VEIL_STEP_OUT = 34;
const FRAME = 16;
/** The rise of what arrives, as it resolves (ms). */
const RISE_MS = 320;

interface Cover {
  el: HTMLElement;
  layers: HTMLElement[];
  /** The cover's animations: their start is the clock everything else is tied to. */
  anims: Animation[];
  /** Milliseconds from the cover's start to solid. */
  solidIn: number;
  /** When it was made (`performance.now()`), and when each quarter comes on after its start (-1: on from the start). */
  born: number;
  at: number[];
  /** Set once the reveal has begun; then each quarter's animation off, and its delay. */
  revealing: boolean;
  offs?: Animation[];
  offAt?: number[];
  /** What stands on the solid veil when the new view takes long (unseen until then). */
  wait?: HTMLElement;
}

/**
 * A view that is not there this long after the veil went solid gets its waiting state. It comes
 * slowly (ease in and out over `WAIT_IN`), so a view that arrives a moment later has shown almost
 * nothing of it: never a flash of a skeleton. It goes quickly, before the veil opens.
 */
export const VEIL_WAIT_AFTER = 180;
const WAIT_IN = 360;
const WAIT_OUT = 70;

const covers = new WeakMap<HTMLElement, Cover>();

/**
 * Now, on the clock the animations run on (the document timeline counts from the same origin).
 * Never the timeline's own `currentTime`, nor a computed style: both are as of the page's last
 * frame, and after a long task (a view being built) that is far behind what is on screen. A cover
 * taken over by a second change of view read its quarters as off that way while they stood solid,
 * and what had just been covered showed again for three frames.
 */
const timeNow = () => performance.now();

/**
 * Which quarters of a veil are on at `now`, from its own schedule. Where a start is not known yet
 * the guess leans to "on": a quarter taken for on comes on a frame early at worst, one taken for
 * off would open the veil over what it had covered.
 */
export function quartersOn(c: { born: number; at: number[]; start: number | null; offStart?: (number | null)[]; offAt?: number[] }, now: number): boolean[] {
  return c.at.map((t, q) => {
    const on = t < 0 || now >= (c.start ?? c.born) + t;
    const offStart = c.offStart?.[q];
    const off = offStart != null && c.offAt != null && now >= offStart + c.offAt[q] + FRAME;
    return on && !off;
  });
}

/** The cover's keyframes for each quarter, given which are on already: the rest turn on in the dither's order. */
export function coverSteps(on: boolean[]): { at: number[]; solidIn: number } {
  let step = 0;
  const at = on.map((x) => (x ? -1 : step++ * VEIL_STEP_IN));
  return { at, solidIn: step ? (step - 1) * VEIL_STEP_IN + FRAME : 0 };
}

/**
 * Starts covering `host` now (the first step is in the next frame) and stays solid until
 * `veilReveal`. Called again while a veil is on the host (a second change of view right behind
 * the first), it carries on from the density that is drawn: nothing ever steps back before solid.
 * `waiting` builds what stands on the solid veil should the new view take long (a quiet skeleton):
 * it is in the page from the start, unseen, and fades in `VEIL_WAIT_AFTER` ms after solid by an
 * animation of its own, so it shows even while the page is busy building the view.
 * Says whether a cover is on (false under reduced motion: callers fade instead).
 */
export function veilCover(host: HTMLElement | null, opts: { color?: string; cell?: number; waiting?: () => HTMLElement | null } = {}): boolean {
  if (!host || reduced() || typeof host.animate !== 'function') return false;
  const cell = opts.cell ?? 4;
  const old = covers.get(host);
  // The quarters drawn right now (a reveal under way has some off again).
  const on = old
    ? quartersOn(
        { born: old.born, at: old.at, start: (old.anims[0]?.startTime as number | null) ?? null, offStart: old.offs?.map((a) => a.startTime as number | null), offAt: old.offAt },
        timeNow(),
      )
    : [false, false, false, false];
  let el: HTMLElement;
  let layers: HTMLElement[];
  if (old) {
    el = old.el;
    layers = old.layers;
    for (const l of [el, ...layers]) for (const a of l.getAnimations()) a.cancel();
    // A waiting state already fading out (a reveal was under way) has gone: the next cover brings its own.
    if (old.revealing) el.querySelector('.veil-wait')?.remove();
  } else {
    live.get(host)?.el.remove();
    live.delete(host);
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const tiles = quarterTiles(resolve(opts.color ?? '--sheet'), cell);
    el = document.createElement('div');
    el.className = 'veil';
    el.setAttribute('aria-hidden', 'true');
    layers = tiles.map((tile) => {
      const layer = document.createElement('i');
      layer.style.backgroundImage = tile;
      layer.style.backgroundSize = `${cell * 4}px`;
      el.appendChild(layer);
      return layer;
    });
    host.appendChild(el);
  }
  const { at, solidIn } = coverSteps(on);
  const total = Math.max(solidIn, FRAME);
  const anims = layers.map((layer, q) => {
    // On already, or the first to come: there from the first frame.
    const frames: Keyframe[] =
      at[q] <= 0
        ? [{ opacity: 1 }, { opacity: 1 }]
        : [
            { opacity: 0, offset: 0 },
            { opacity: 0, offset: at[q] / total },
            { opacity: 1, offset: Math.min(1, (at[q] + FRAME) / total) },
            { opacity: 1, offset: 1 },
          ];
    return layer.animate(frames, { duration: total, easing: 'linear', fill: 'both' });
  });
  // The waiting state of a cover that is taken over stays as it is (seen or not): it never starts again.
  let wait = old?.wait;
  if (!wait && opts.waiting) {
    const w = opts.waiting();
    if (w) {
      w.classList.add('veil-wait');
      el.appendChild(w);
      w.animate([{ opacity: 0 }, { opacity: 1 }], { duration: WAIT_IN, delay: solidIn + VEIL_WAIT_AFTER, easing: 'cubic-bezier(0.5, 0, 0.5, 1)', fill: 'both' });
      wait = w;
    }
  }
  covers.set(host, { el, layers, anims, solidIn, born: timeNow(), at, revealing: false, wait });
  return true;
}

export interface VeilSwitch {
  /** What goes: seen until the veil is solid, then not. */
  hide?: HTMLElement[];
  /** What comes: unseen until the veil is solid, then there, rising `rise` px as it resolves. */
  show?: HTMLElement[];
  rise?: number;
}

export interface VeilRun {
  /** Settles when the veil is solid and the views have switched (what went may be removed). */
  solid: Promise<void>;
  /** Settles when the veil has gone. */
  done: Promise<void>;
}

const SETTLED: VeilRun = { solid: Promise.resolve(), done: Promise.resolve() };
const quiet = (p: Promise<unknown>) =>
  p.then(
    () => {},
    () => {},
  );

/**
 * Uncovers `host` (covered by `veilCover`): at once when the cover is solid, else the moment it
 * is. Every part is an animation on the cover's own clock: what goes and what comes switch on the
 * frame the veil is solid, however late the page's script runs. Without a cover (reduced motion)
 * nothing is animated and both promises are settled.
 */
export function veilReveal(host: HTMLElement | null, sw: VeilSwitch = {}): VeilRun {
  const cover = host ? covers.get(host) : undefined;
  if (!host || !cover) return SETTLED;
  cover.revealing = true;
  // How long until solid. A cover made in this same frame has not started: it starts with these.
  const started = cover.anims[0]?.startTime as number | null | undefined;
  const wait = started == null ? cover.solidIn : Math.max(0, started + cover.solidIn - timeNow());
  // A waiting state in view goes first; one that never showed is simply dropped.
  const waiting = cover.wait;
  cover.wait = undefined;
  const seen = !!waiting && getComputedStyle(waiting).opacity !== '0';
  if (waiting && !seen) waiting.remove();
  if (waiting && seen) {
    const from = getComputedStyle(waiting).opacity;
    for (const a of waiting.getAnimations()) a.cancel();
    waiting.animate([{ opacity: from }, { opacity: 0 }], { duration: WAIT_OUT, easing: 'linear', fill: 'forwards' });
  }
  const hold = wait + FRAME + (seen ? WAIT_OUT : 0);
  const at = (ms: number, total: number) => Math.min(1, Math.max(0, ms / total));
  for (const el of sw.hide ?? []) {
    const cur = getComputedStyle(el).opacity;
    el.animate(wait > 0 ? [{ opacity: cur, offset: 0 }, { opacity: cur, offset: at(wait, hold) }, { opacity: 0, offset: 1 }] : [{ opacity: 0 }, { opacity: 0 }], { duration: hold, easing: 'linear', fill: 'forwards' });
  }
  const from = sw.rise ? `translateY(${sw.rise}px)` : 'none';
  for (const el of sw.show ?? []) {
    const total = hold + RISE_MS;
    el.animate(
      [
        { opacity: 0, transform: from, offset: 0, easing: 'linear' },
        { opacity: 0, transform: from, offset: at(wait, total), easing: 'linear' },
        { opacity: 1, transform: from, offset: at(hold, total), easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        { opacity: 1, transform: 'none', offset: 1 },
      ],
      { duration: total, fill: 'backwards' },
    );
  }
  // Off in the reverse of the order they came on, so the content resolves sparse last.
  const offAt = cover.layers.map((_, q) => hold + (3 - q) * VEIL_STEP_OUT);
  const offs = cover.layers.map((layer, q) => layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FRAME, delay: offAt[q], easing: 'linear', fill: 'forwards' }));
  cover.offs = offs;
  cover.offAt = offAt;
  const gate = cover.el.animate([{ opacity: 1 }, { opacity: 1 }], { duration: Math.max(1, hold) });
  const end = () => {
    window.clearTimeout(cap);
    // A new cover took the element over meanwhile: it is that one's now.
    if (covers.get(host) !== cover) return;
    covers.delete(host);
    cover.el.remove();
  };
  // A hidden window finishes no animation: the veil never outlives its run by long.
  const cap = window.setTimeout(end, hold + 3 * VEIL_STEP_OUT + 1500);
  return { solid: quiet(gate.finished), done: quiet(Promise.all(offs.map((a) => a.finished))).then(end) };
}

/** Whether a cover is on `host` and still waits for its reveal. */
export function veilHeld(host: HTMLElement | null): boolean {
  const c = host ? covers.get(host) : undefined;
  return !!c && !c.revealing;
}
