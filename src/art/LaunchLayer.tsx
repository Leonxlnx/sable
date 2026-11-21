import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dropBootLight, fieldWorkerPort } from './DitherField';
import { FIELD_EVENT, type FieldEventDetail } from './events';
import { LAUNCH, LAUNCH_MARK_CELLS, launchColours, launchMeasure, type LaunchGeometry, type LaunchMessage, type LaunchReply } from './launch-light';
import { MARK_PATH, markCell } from './Logo';
import { bootMark, takeBootLaunch, type BootLaunch } from '@/lib/boot';

/**
 * The launch: one piece from the window's first frame to the home screen at rest.
 *
 * The light is drawn in the field worker (launch-light.ts) on a canvas over the whole window; this file
 * is the page's half: the mark as an element once it stands (pixel for pixel over the canvas's
 * copy), its move to the home screen, the headline and composer arriving, and the rules:
 *
 * - The app mounts the moment the bridge is ready, under the ink, with the composer focused: a key
 *   typed lands in it and the piece yields at once (everything opens in 150 ms); a click skips it.
 * - While the bridge starts, the piece holds (the mark, a halo, a ring now and then) and releases
 *   whenever the bridge answers, early or late. A sentence shows only after four seconds.
 * - The light starts with the page (src/boot.ts), before the app's code has loaded; the layer takes
 *   its canvas and worker over when it mounts. An app that is ready before the mark stands whole
 *   quickens the build (`LAUNCH.hurry`), so the piece never holds a ready app back.
 * - Reduced motion, or no worker: the mark on ink, then a short fade into the app.
 * - When it ends nothing is left: no canvas, no listeners, no timers.
 *
 * Everything on the page side is `element.animate` on transform and opacity.
 */

interface HomeParts {
  mark: HTMLElement | null;
  title: HTMLElement | null;
  composer: HTMLElement | null;
}

interface DevHook {
  /** Play the launch although the page is automated (headless screenshots skip it otherwise). */
  on?: boolean;
  /** The clock stands still until `step(t)` moves it (frame sheets). */
  frozen?: boolean;
  step?: (t: number) => void;
  /** Counts from the last run, for the performance check: the worker's frames and its slowest one, and the page's own work for the piece (ms, by step). */
  last?: { frames?: number; worst?: number; ended: number; main: Record<string, number> };
  main?: Record<string, number>;
}

const dev = (): DevHook | undefined => (import.meta.env.DEV ? (window as unknown as { __sableLaunch?: DevHook }).__sableLaunch : undefined);

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Whether this page load plays the launch. Automated development pages (headless screenshots, the
 * performance scripts) skip it unless they ask for it, so their first frame is the home screen.
 */
export function launchPlays() {
  if (typeof window === 'undefined') return false;
  if (import.meta.env.DEV && navigator.webdriver && !dev()?.on) return false;
  return true;
}

interface Run {
  root: HTMLDivElement;
  mark: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  port: ReturnType<typeof fieldWorkerPort>;
  /** No light: the mark on ink, then a fade (reduced motion, or no worker). */
  plain: boolean;
  cell: number;
  geometry: LaunchGeometry;
  ready: boolean;
  /** The worker has drawn its first frame. */
  ignited: boolean;
  /** The mark element is on screen over the canvas's copy. */
  painted: boolean;
  released: boolean;
  yielded: boolean;
  /** A key or a click arrived before the bridge did. */
  impatient: boolean;
  /** What was typed before there was a composer to type into. */
  typed: string;
  /** A hand-over of `typed` to the composer is waiting for a frame. */
  handing?: boolean;
  ended: boolean;
  parts: HomeParts | null;
  /** Keeps the home mark out of sight until the launch mark has landed on it. */
  hold: Animation | null;
  anims: { a: Animation; t0: number }[];
  cues: { at: number; fn: () => void; timer: number }[];
  frozen: boolean;
  clock: number;
  onDone: () => void;
  onSlow: () => void;
  off: (() => void)[];
}

let run: Run | null = null;
let pendingStop = 0;

const time = (r: Run) => (r.frozen ? r.clock : performance.now());

/** Development: how long the page's own steps of the piece take (`__sableLaunch.last.main`). */
function timed<T>(name: string, fn: () => T): T {
  const hook = dev();
  if (!hook) return fn();
  const t = performance.now();
  try {
    return fn();
  } finally {
    const m = (hook.main ??= {});
    m[name] = Math.round(((m[name] ?? 0) + performance.now() - t) * 100) / 100;
  }
}

/** Runs `fn` after `ms` of the piece's clock. */
function cue(r: Run, ms: number, fn: () => void) {
  const c = { at: time(r) + ms, fn, timer: 0 };
  if (!r.frozen)
    c.timer = window.setTimeout(() => {
      r.cues.splice(r.cues.indexOf(c), 1);
      if (!r.ended) fn();
    }, ms);
  r.cues.push(c);
}

function track(r: Run, a: Animation | null | undefined) {
  if (!a) return;
  if (r.frozen) a.pause();
  r.anims.push({ a, t0: time(r) });
}

function animate(r: Run, el: Element | null | undefined, frames: Keyframe[], opts: KeyframeAnimationOptions) {
  if (!el || typeof el.animate !== 'function') return null;
  const a = el.animate(frames, opts);
  track(r, a);
  return a;
}

/** Cells of about 6 px (larger on a large window), in whole device pixels. */
const measure = () => launchMeasure(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);

/**
 * Takes over the light the page's first script started (src/boot.ts): its canvas moves into the
 * layer and its worker becomes the shared field worker, so the piece goes on from where it is (its
 * clock started with the page). False when it cannot be used; it is then stopped and removed.
 */
function adopt(r: Run, root: HTMLDivElement, early: BootLaunch): boolean {
  const port = early.failed ? null : fieldWorkerPort((d) => onReply(r, d as LaunchReply), () => goPlain(r), early);
  if (!port) {
    dropBootLight(early);
    return false;
  }
  r.port = port;
  r.canvas = early.canvas;
  r.plain = false;
  r.cell = early.cell;
  r.geometry = early.geometry;
  // Placed by the layer from here (the boot script held it over the window by itself).
  early.canvas.removeAttribute('style');
  root.prepend(early.canvas);
  // The window may have changed size since the light started: it follows, as on a resize.
  const now = measure();
  if (now.cell !== r.cell || now.geometry.cols !== r.geometry.cols || now.geometry.rows !== r.geometry.rows) {
    Object.assign(r, now);
    port.post({ type: 'launch', id: port.id, op: 'size', geometry: r.geometry } satisfies LaunchMessage);
  }
  return true;
}

function place(r: Run) {
  const { cell, geometry: g } = r;
  if (r.canvas) {
    r.canvas.style.width = `${g.cols * cell}px`;
    r.canvas.style.height = `${g.rows * cell}px`;
  }
  const side = LAUNCH_MARK_CELLS * cell;
  const s = r.mark.style;
  s.left = `${g.mx * cell}px`;
  s.top = `${g.my * cell}px`;
  s.width = s.height = `${side}px`;
}

function start(root: HTMLDivElement, mark: HTMLDivElement, onDone: () => void, onSlow: () => void) {
  const hook = dev();
  const r: Run = {
    root,
    mark,
    canvas: null,
    port: null,
    plain: true,
    ...measure(),
    ready: false,
    ignited: false,
    painted: false,
    released: false,
    yielded: false,
    impatient: false,
    typed: '',
    ended: false,
    parts: null,
    hold: null,
    anims: [],
    cues: [],
    frozen: !!hook?.frozen,
    clock: 0,
    onDone,
    onSlow,
    off: [],
  };
  run = r;
  bootMark('launch-start');

  // The light may be running already, started by the page's first script before the app loaded.
  const early = takeBootLaunch();
  let adopted = false;
  if (early) {
    if (!r.frozen && !reducedMotion()) adopted = adopt(r, root, early);
    else dropBootLight(early);
  }
  if (adopted) {
    // A worker that never answers (it failed to load) must not leave the window in ink.
    cue(r, 1600, () => !r.ignited && goPlain(r));
  } else if (!reducedMotion()) {
    const canvas = document.createElement('canvas');
    canvas.className = 'launch-light';
    canvas.setAttribute('aria-hidden', 'true');
    const port = 'transferControlToOffscreen' in canvas ? fieldWorkerPort((d) => onReply(r, d as LaunchReply), () => goPlain(r)) : null;
    if (port) {
      r.port = port;
      r.canvas = canvas;
      r.plain = false;
      root.prepend(canvas);
      const off = canvas.transferControlToOffscreen();
      const init: LaunchMessage = { type: 'launch', id: port.id, op: 'init', canvas: off, geometry: r.geometry, colours: launchColours(getComputedStyle(document.documentElement)), frozen: r.frozen };
      port.post(init, [off]);
      // A worker that never answers (it failed to load) must not leave the window in ink.
      cue(r, 1600, () => !r.ignited && goPlain(r));
    }
  }
  place(r);
  if (r.plain) showPlain(r);

  const onResize = () => {
    if (r.released) return;
    Object.assign(r, measure());
    place(r);
    if (r.port) r.port.post({ type: 'launch', id: r.port.id, op: 'size', geometry: r.geometry } satisfies LaunchMessage);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    // Typed before the bridge answered: kept, and handed to the composer when it exists.
    // So is anything typed before a composer has the keyboard (a restored session's view loads on demand).
    const fielded = document.activeElement instanceof HTMLTextAreaElement && document.activeElement.matches(COMPOSER_FIELD);
    if ((!r.ready || !fielded) && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && r.typed.length < 200) {
      e.preventDefault();
      r.typed += e.key;
      if (r.yielded) handOver(r);
    }
    yieldNow(r);
  };
  const onPointer = () => yieldNow(r);
  // A click on the ink skips the piece and nothing else: the composer keeps the focus.
  const keepFocus = (e: MouseEvent) => e.preventDefault();
  root.addEventListener('mousedown', keepFocus);
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onPointer, true);
  r.off.push(() => {
    root.removeEventListener('mousedown', keepFocus);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onPointer, true);
  });
  // The quietest line, and only when the bridge takes long.
  cue(r, 4000, () => !r.ready && r.onSlow());

  if (hook) {
    // Frame sheets: the piece's clock, its animations and every other animation on the page move
    // together, one step at a time (and keep stepping after the layer has gone).
    const seen = new WeakSet<Animation>();
    hook.step = (t) => {
      if (!r.frozen) return;
      for (const { a } of r.anims) seen.add(a);
      for (const a of document.getAnimations()) {
        if (seen.has(a)) continue;
        seen.add(a);
        a.pause();
        r.anims.push({ a, t0: r.clock - Number(a.currentTime ?? 0) });
      }
      r.clock = t;
      if (r.port) r.port.post({ type: 'launch', id: r.port.id, op: 'clock', t } satisfies LaunchMessage);
      for (const { a, t0 } of r.anims) {
        // A cancelled animation stays cancelled (setting its time would bring it back).
        if (a.playState === 'idle') continue;
        try {
          a.currentTime = Math.max(0, t - t0);
        } catch {
          /* a cancelled animation */
        }
      }
      for (const c of r.cues.filter((c) => c.at <= t)) {
        r.cues.splice(r.cues.indexOf(c), 1);
        c.fn();
      }
    };
  }
  // What the adopted light said before the layer was there (it has lit, perhaps formed already).
  if (adopted && early) for (const m of early.replies.splice(0)) onReply(r, m as LaunchReply);
}

function onReply(r: Run, m: LaunchReply) {
  if (r.ended) return;
  timed(m.launch, () => answer(r, m));
}

function answer(r: Run, m: LaunchReply) {
  if (m.launch === 'ignite') {
    bootMark('launch-ignite');
    r.ignited = true;
  } else if (m.launch === 'formed') {
    bootMark('launch-formed');
    // The element takes over from the canvas's copy of the mark: the same pixels, so nothing shows.
    r.mark.style.opacity = '1';
    r.root.dataset.lit = '';
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        r.painted = true;
        tryRelease(r);
      }),
    );
  } else if (m.launch === 'done') {
    const hook = dev();
    end(r);
    if (hook) hook.last = { frames: m.frames, worst: m.worst, ended: performance.now(), main: hook.main ?? {} };
  }
}

/** The plain form: the mark fades in on ink. */
function showPlain(r: Run) {
  bootMark('launch-plain');
  r.plain = true;
  r.root.removeAttribute('data-lit');
  r.mark.style.opacity = '1';
  r.mark.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 80, easing: 'ease-out', fill: 'backwards' });
  r.painted = true;
}

function goPlain(r: Run) {
  if (r.ended || r.plain || r.released) return;
  r.port?.post({ type: 'launch', id: r.port.id, op: 'dispose' } satisfies LaunchMessage);
  r.port?.release();
  r.port = null;
  r.canvas?.remove();
  r.canvas = null;
  showPlain(r);
  tryRelease(r);
}

function tryRelease(r: Run) {
  if (r.ended || r.released || !r.ready) return;
  if (r.impatient) return yieldNow(r);
  if (r.plain) {
    r.released = true;
    r.root.dataset.phase = 'open';
    const a = r.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-out', fill: 'forwards' });
    a.finished.then(() => end(r), () => end(r));
    return;
  }
  if (r.painted) timed('release', () => release(r));
}

/** Samples of an eased move as linear keyframes (the easing is applied here, in scale's own space). */
const TRAVEL_STEPS = 30;
/** The mark's glide to its place, ms, and how far it draws in before it leaves. */
const TRAVEL = 520;
const INHALED = 0.955;

/**
 * The launch mark (drawn in `box`) receding onto `target`'s mark: it shrinks about one fixed point,
 * the way a camera pulls back, with the easing applied to the logarithm of its size so the shrink
 * reads evenly. `lead` ms pass before it (the inhale, when both are one animation).
 */
function travelFrames(box: DOMRect, target: Element, lead: number): Keyframe[] | null {
  const svg = target.querySelector('svg');
  const to = svg?.getBoundingClientRect();
  const side = box.width;
  if (!svg || !to || !to.width || !side) return null;
  const half = side / 2;
  const size = Number(svg.getAttribute('width')) || 36;
  const k = (to.width * ((4 * markCell(size)) / size)) / side;
  const c1x = to.left + to.width / 2 - box.left;
  const c1y = to.top + to.height / 2 - box.top;
  const total = lead + TRAVEL;
  const at = (s: number, cx: number, cy: number) => `translate(${(cx - s * half).toFixed(2)}px, ${(cy - s * half).toFixed(2)}px) scale(${s.toFixed(5)})`;
  const frames: Keyframe[] = [];
  for (let j = 0; j <= TRAVEL_STEPS; j++) {
    const p = j / TRAVEL_STEPS;
    // The crest leaves first; the mark gathers way behind it, then a long glide home.
    const e = 1 - (1 - p ** 1.5) ** 3;
    const s = INHALED * (k / INHALED) ** e;
    const f = (s - INHALED) / (k - INHALED);
    frames.push({ transform: at(s, half + (c1x - half) * f, half + (c1y - half) * f), offset: (lead + TRAVEL * p) / total, easing: 'linear' });
  }
  return frames;
}

function release(r: Run) {
  const port = r.port;
  if (!port) return;
  r.released = true;
  bootMark('launch-release');
  r.root.dataset.phase = 'release';
  port.post({ type: 'launch', id: port.id, op: 'release' } satisfies LaunchMessage);

  const L = LAUNCH;
  const box = r.mark.getBoundingClientRect();
  const side = box.width;
  const half = side / 2;
  // The mark recedes into its place in what is under the ink: the home screen's mark, or the
  // welcome's (which may mount a moment later, so that one is looked for as the crest leaves).
  const home = r.parts?.mark?.isConnected ? r.parts.mark : null;
  const inhale: Keyframe[] = [
    { transform: 'translate(0px, 0px) scale(1)', easing: 'cubic-bezier(0.4, 0, 0.6, 1)' },
    { transform: `translate(${(half * (1 - INHALED)).toFixed(2)}px, ${(half * (1 - INHALED)).toFixed(2)}px) scale(${INHALED})` },
  ];
  if (home) {
    const frames = travelFrames(box, home, L.inhale);
    if (frames) animate(r, r.mark, [inhale[0], ...frames], { duration: L.inhale + TRAVEL, fill: 'forwards' });
  } else {
    r.hold?.cancel();
    r.hold = null;
    r.parts = null;
    animate(r, r.mark, inhale, { duration: L.inhale, fill: 'forwards' });
    cue(r, L.inhale, () => {
      const other = document.querySelector<HTMLElement>('.onb .onb-mark-travel');
      const frames = other && travelFrames(box, other, 0);
      if (other && frames) {
        r.hold = other.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1, fill: 'both' });
        animate(r, r.mark, frames, { duration: TRAVEL, fill: 'forwards' });
      } else {
        // Nothing to land on (a session restored, or the welcome not there yet): the mark goes with the light.
        animate(r, r.mark, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'steps(3, end)', fill: 'forwards' });
      }
    });
  }

  // The crest leaves: the real field takes the wave too, from the same point.
  cue(r, L.inhale, () => {
    window.dispatchEvent(new CustomEvent<FieldEventDetail>(FIELD_EVENT, { detail: { kind: 'send', x: box.left + half, y: box.top + half, strength: 1 } }));
  });
  // Soon the app shows through most of the window: clicks belong to it from here.
  cue(r, L.inhale + 180, () => (r.root.dataset.phase = 'open'));

  const parts = r.parts;
  if (parts) {
    resolveGlyphs(parts.title, L.inhale + 150, 10, (a) => track(r, a));
    animate(r, parts.title, [{ transform: 'translateY(12px)' }, { transform: 'translateY(0px)' }], { duration: 460, delay: L.inhale + 150, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'backwards' });
    animate(r, parts.composer, [{ opacity: 0, transform: 'translateY(22px)' }, { opacity: 1, transform: 'translateY(0px)' }], { duration: 480, delay: L.inhale + 200, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' });
  }
  // Whatever happens to the worker, the window opens.
  cue(r, L.inhale + L.burst + 500, () => end(r));
}

/** The composer that takes what was typed during the piece: home's, or a restored session's. */
const COMPOSER_FIELD = '.home-composer textarea.cmp-input:not(.cmp-mirror), .composer[data-variant=session] textarea.cmp-input:not(.cmp-mirror)';

/**
 * Hands what was typed to the composer, as if typed there, so its own input handling takes it:
 * once it has mounted (a restored session's view can take a few frames longer than home's).
 */
function handOver(r: Run, tries = 0) {
  if (!r.typed || r.handing) return;
  r.handing = true;
  requestAnimationFrame(() => {
    r.handing = false;
    const field = document.querySelector<HTMLTextAreaElement>(COMPOSER_FIELD);
    if (!field) {
      if (tries < 90) handOver(r, tries + 1);
      return;
    }
    const active = document.activeElement;
    if (active !== field) {
      if (active && active !== document.body) return;
      field.focus();
    }
    const text = r.typed;
    r.typed = '';
    document.execCommand('insertText', false, text);
  });
}

/** A key or a click: the piece gives way at once. */
function yieldNow(r: Run) {
  if (r.ended || r.yielded) return;
  if (!r.ready) {
    r.impatient = true;
    return;
  }
  r.yielded = true;
  bootMark('launch-yield');
  r.released = true;
  r.root.dataset.phase = 'open';
  // The canvas carries the ink from its first frame: the layer's own ground goes, so the opening shows.
  if (r.ignited) r.root.dataset.lit = '';
  for (const { a } of r.anims) {
    try {
      a.finish();
    } catch {
      a.cancel();
    }
  }
  r.anims.length = 0;
  // The home mark is at its place and whole; the launch mark is gone with the ink.
  r.hold?.cancel();
  r.hold = null;
  r.mark.style.visibility = 'hidden';
  handOver(r);
  // Nothing drawn yet (a key in the first instant): a plain cut, no canvas over the app.
  if (r.plain || !r.port || !r.ignited) return end(r);
  r.port.post({ type: 'launch', id: r.port.id, op: 'finish' } satisfies LaunchMessage);
  cue(r, LAUNCH.finish + 400, () => end(r));
}

function end(r: Run, silent = false) {
  if (r.ended) return;
  r.ended = true;
  bootMark('launch-end');
  for (const c of r.cues) window.clearTimeout(c.timer);
  r.cues.length = 0;
  for (const off of r.off) off();
  r.hold?.cancel();
  r.hold = null;
  if (r.port) {
    r.port.post({ type: 'launch', id: r.port.id, op: 'dispose' } satisfies LaunchMessage);
    r.port.release();
    r.port = null;
  }
  const hook = dev();
  if (hook && !r.frozen) hook.step = undefined;
  if (run === r) run = null;
  // The layer leaves in the same commit the home mark returns in.
  if (!silent) {
    r.onDone();
    settle();
  }
}

let settled = false;
const afterListeners = new Set<() => void>();

function settle() {
  settled = true;
  for (const fn of [...afterListeners]) fn();
  afterListeners.clear();
}

/**
 * Runs `fn` once the launch has gone (at once when none plays, or it is over): for start-up work
 * that can wait until the window is at rest (rows of the sidebar beyond the first screenful).
 * Returns a cancel.
 */
export function afterLaunch(fn: () => void): () => void {
  if (settled || !launchPlays()) {
    fn();
    return () => {};
  }
  afterListeners.add(fn);
  return () => void afterListeners.delete(fn);
}

/**
 * The home screen calls this when it mounts. True when the launch is still playing: it then
 * stages the arrival itself (the mark lands on the home mark, the headline resolves, the composer
 * rises) and the home screen must not play its own.
 */
export function launchArrival(parts: HomeParts): boolean {
  const r = run;
  if (!r || r.ended || r.yielded || r.plain) return false;
  r.parts = parts;
  if (parts.mark) r.hold = parts.mark.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1, fill: 'both' });
  return true;
}

/**
 * The headline resolves glyph by glyph in ordered-dither order (far apart first, then the ones
 * between, as the mark's cells fill), each stepping in through three levels. Opacity only.
 */
export function resolveGlyphs(title: Element | null | undefined, delay: number, step: number, each?: (a: Animation) => void) {
  if (!title || reducedMotion()) return;
  const glyphs = Array.from(title.querySelectorAll<HTMLElement>('[data-g]'));
  const n = glyphs.length;
  if (!n) return;
  const rev = (i: number) => {
    let v = 0;
    for (let b = 0; b < 6; b++) v |= ((i >> b) & 1) << (5 - b);
    return v;
  };
  const order = glyphs.map((_, i) => i).sort((a, b) => rev(a) - rev(b));
  order.forEach((g, rank) => {
    const a = glyphs[g].animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: delay + rank * step, easing: 'steps(3, end)', fill: 'backwards' });
    each?.(a);
  });
}

/** The launch layer. Mount it from the first render; it calls `onDone` when nothing of it is left. */
export function Launch({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const [slow, setSlow] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;

  useLayoutEffect(() => {
    // Development runs effects twice: the second run keeps the piece the first one started.
    window.clearTimeout(pendingStop);
    pendingStop = 0;
    const el = root.current;
    const m = mark.current;
    if (!run && el && m) timed('start', () => start(el, m, () => done.current(), () => setSlow(true)));
    return () => {
      pendingStop = window.setTimeout(() => run && end(run, true), 0);
    };
  }, []);

  useEffect(() => {
    const r = run;
    if (!ready || !r || r.ready) return;
    r.ready = true;
    // From here the window is the app's: no longer a drag region, and a click skips the piece.
    r.root.dataset.ready = '';
    // The app is there before the mark stands whole: the build quickens, so the piece gives way as
    // soon as it can (launch-light.ts, LAUNCH.hurry).
    if (r.port && !r.painted && !r.frozen) r.port.post({ type: 'launch', id: r.port.id, op: 'hurry' } satisfies LaunchMessage);
    tryRelease(r);
    // The app is there: if the light cannot finish forming (a hidden window draws no frames), the ink goes anyway.
    if (!r.ended && !r.released) cue(r, 2600, () => !r.released && end(r));
  }, [ready]);

  return (
    <div ref={root} className="launch logo-intro" role="status" aria-label="Starting Sable">
      <div ref={mark} className="launch-mark">
        <svg viewBox="0 0 4 4" shapeRendering="crispEdges" aria-hidden>
          <path d={MARK_PATH} fill="currentColor" />
        </svg>
      </div>
      {slow && <p className="launch-note">Starting the bridge</p>}
    </div>
  );
}
