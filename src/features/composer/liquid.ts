import { reducedMotion, uiZoom } from '@/lib/motion';
import { makeRenderer, type Backdrop } from './liquid-gl';
import { liquidAt, liquidBounds, planLiquid, type Box, type LiquidPlan, type LiquidSpec, type Shift } from './liquid-shape';
import type { LiquidMessage, LiquidReply } from './liquid.worker';

/**
 * The page's side of the liquid (liquid-shape.ts): a worker draws every sent message on canvases
 * of its own (liquid.worker.ts), so nothing here runs per frame and a busy main thread cannot hold
 * the drop.
 *
 * Three canvases, a short one (a message landing above the composer), a tall one (the first
 * message from home, a long message) and a wide one (a queued row), are handed to the worker
 * once, while the page is idle, and the worker draws a clear frame into each straight away: a
 * canvas only shows a worker's frames once the page's main thread has taken in its surface, and
 * right after a send that thread is busy (a session mounting, a turn starting), so the surface
 * must be in place before. A message
 * only moves its canvas into place (its position, which needs no new surface) and puts it in the
 * page; it is never resized for one. Sized to the flight, not the window: what the worker redraws
 * each frame, and the compositor with it, stays small. Where workers or OffscreenCanvas are
 * missing (or a message does not fit), a canvas of the message's own is drawn here instead.
 */

let worker: Worker | null = null;
let broken = false;
let nextId = 0;
const ends = new Map<number, () => void>();

interface Slot {
  id: number;
  el: HTMLCanvasElement;
  /** Its size in page px (the device px follow from `scale`). */
  css: { w: number; h: number };
  scale: number;
  /** Where it stands now (page px), and the messages drawing on it. */
  at: { x: number; y: number };
  users: number;
}
let slots: Slot[] = [];
let preparing = false;

/**
 * The canvases, in page px: wide enough for the widest card and its overshoot, as tall as the
 * flights they take; the third holds a queue row (the reading column's width and its margins, a
 * hop's height), which the others are too narrow for: drawn on the main thread instead, a row's
 * ink got almost no frames on a loaded machine.
 */
const SHAPES = [
  { w: 700, h: 300 },
  { w: 700, h: 900 },
  { w: 820, h: 180 },
];
/** Room kept around a flight inside its canvas, above (late corrections) and below the bar's edge. */
const ROOM_ABOVE = 60;
const ROOM_BELOW = 8;

export type { Backdrop };

const canHandOver = () =>
  !broken && typeof Worker === 'function' && typeof OffscreenCanvas !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && 'transferControlToOffscreen' in HTMLCanvasElement.prototype;

function acquire(): Worker | null {
  if (!canHandOver()) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./liquid.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      broken = true;
      return null;
    }
    worker.onmessage = (e: MessageEvent<LiquidReply>) => {
      const m = e.data;
      if (m.type === 'lost') return fail();
      if (m.type === 'free') {
        // Nothing left on it (the worker has cleared it): out of the page until the next message.
        const s = slots.find((x) => x.id === m.layer);
        if (s && !s.users) s.el.remove();
        return;
      }
      if (import.meta.env.DEV && m.frames) {
        const w = window as unknown as { __liquidFrames?: number[][] };
        w.__liquidFrames = [...(w.__liquidFrames ?? []).slice(-4), m.frames];
      }
      const end = ends.get(m.id);
      ends.delete(m.id);
      end?.();
    };
    worker.onerror = fail;
  }
  return worker;
}

/** The worker failed (or lost its GPU context): every message in the air settles, later ones draw on the page. */
function fail() {
  broken = true;
  worker?.terminate();
  worker = null;
  for (const s of slots) s.el.remove();
  slots = [];
  const list = [...ends.values()];
  ends.clear();
  for (const f of list) f();
}

const post = (m: LiquidMessage, transfer: Transferable[] = []) => worker?.postMessage(m, transfer);

const idle = (fn: () => void, timeout = 3000) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout });
  else window.setTimeout(fn, 1200);
};

/** Device px per page px: fine enough for a soft shape and its hairline (a 3x screen does not need a 3x canvas). */
const scaleNow = () => Math.min(2, window.devicePixelRatio || 1) * uiZoom();

/** The canvases, handed to the worker while the page is idle (see the top of this file). */
function prepare() {
  // Under reduced motion nothing is ever poured: no worker, no canvases.
  if (slots.length || preparing || !canHandOver() || reducedMotion()) return;
  preparing = true;
  idle(() => {
    preparing = false;
    if (slots.length || !acquire()) return;
    make();
    window.addEventListener('resize', onResize, { passive: true });
  });
}

function make() {
  // Made once per scale: a resize and a send in the same idle window both ask for it.
  if (slots.length || !acquire()) return;
  const scale = scaleNow();
  slots = SHAPES.map((shape) => {
    const id = ++nextId;
    const el = document.createElement('canvas');
    el.className = 'send-liquid';
    el.setAttribute('aria-hidden', 'true');
    el.width = Math.round(shape.w * scale);
    el.height = Math.round(shape.h * scale);
    el.style.cssText = `left:0;top:0;width:${shape.w}px;height:${shape.h}px;`;
    const off = el.transferControlToOffscreen();
    post({ type: 'layer', id, canvas: off, size: { w: el.width, h: el.height }, scale }, [off]);
    return { id, el, css: { ...shape }, scale, at: { x: 0, y: 0 }, users: 0 };
  });
}

let resizeTimer = 0;
/** The zoom or the screen changed: new canvases at the new scale, between messages. */
function onResize() {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (!slots.length || Math.abs(scaleNow() - slots[0].scale) < 0.01) return;
    if (slots.some((s) => s.users)) return onResize();
    for (const s of slots) {
      s.el.remove();
      post({ type: 'drop', layer: s.id });
    }
    slots = [];
    idle(make);
  }, 400);
}

/** Loads the worker and hands it its canvases ahead of the first send, while the page is idle. */
export function prewarmLiquid() {
  prepare();
}

/**
 * Where a canvas of `shape` stands to hold a flight's region (page px), or null when it cannot.
 * Centred on the region, kept inside the window where it can be.
 */
export function placeFor(region: { left: number; top: number; width: number; height: number }, shape: { w: number; h: number }, win: { w: number; h: number }): { x: number; y: number } | null {
  if (region.width > shape.w || region.height > shape.h) return null;
  const fit = (lo: number, size: number, room: number, max: number) => {
    const ideal = lo - (room - size) / 2;
    // Inside the window if that still holds the region; the region wins otherwise.
    return Math.min(lo, Math.max(lo + size - room, Math.min(Math.max(0, ideal), Math.max(0, max - room))));
  };
  return { x: Math.round(fit(region.left, region.width, shape.w, win.w)), y: Math.round(fit(region.top, region.height, shape.h, win.h)) };
}

/** The region a flight draws in, with its room. */
function regionOf(plan: LiquidPlan) {
  const b = liquidBounds(plan, 0);
  const top = b.top - ROOM_ABOVE;
  // Round a key the liquid's collar reaches a little below its top (liquid-shape.ts `frameBounds`).
  const bottom = Math.max(plan.spec.from.y + (plan.spec.from.r ?? 0) * 0.6, b.top + b.height) + ROOM_BELOW;
  return { left: b.left, top, width: b.width, height: bottom - top };
}

export interface Pour {
  /** The plan as the worker has it (the words' keyframes are taken from it). */
  plan: LiquidPlan;
  /** Starts drawing, `t0` (the page's clock) being time zero of the plan. */
  start(t0: number): void;
  /** A better landing before the drop has left (a new shape and place). */
  retarget(to: Box): void;
  /** The start was a little off (the compositor's own report came in): time zero moves, while nothing shows yet. */
  retime(t0: number): void;
  /** Before the start: the bar it leaves will glide away under it (liquid-shape.ts `spec.bar`). */
  leaving(by: { dx: number; dy: number }): void;
  /** A still of the field behind it, for the glass to bend (the bitmap is handed over). */
  backdrop(b: Backdrop): void;
  /** A late correction after it has left: everything still to come moves by it. */
  shift(s: Shift): void;
  /** Fades out what is drawn (a refused message, a send given up). */
  cancel(): void;
  /** Settles once nothing of it is drawn any more. */
  finished: Promise<void>;
}

/** Dev frame sheets: every pour drawn at a fixed time after its start (see `freezeLiquid`). */
let frozenAt: number | null = null;
const local = new Set<() => void>();

type Region = { left: number; top: number; width: number; height: number };

const inside = (r: Region, s: Slot) => r.left >= s.at.x && r.top >= s.at.y && r.left + r.width <= s.at.x + s.css.w && r.top + r.height <= s.at.y + s.css.h;

/** A free canvas that holds the region (the smaller first), placed for it. */
function claimSlot(region: Region): Slot | null {
  const z = uiZoom();
  const win = { w: window.innerWidth / z, h: window.innerHeight / z };
  for (const s of slots) {
    if (s.users) {
      // Already in use: it can take another message only if that one fits where it stands.
      if (inside(region, s)) return s;
      continue;
    }
    const at = placeFor(region, s.css, win);
    if (!at) continue;
    s.at = at;
    s.el.style.left = `${at.x}px`;
    s.el.style.top = `${at.y}px`;
    return s;
  }
  return null;
}

/**
 * Prepares `spec` to be drawn (`below`: px of room to keep under the edge it leaves, for a bar
 * that will leave with it). Nothing is drawn until `start`, so the caller can start it on the
 * frame its other layers start on.
 */
export function pour(spec: LiquidSpec, below = 0): Pour {
  const plan = planLiquid(spec);
  const id = ++nextId;
  let resolve!: () => void;
  const finished = new Promise<void>((r) => (resolve = r));
  let over = false;
  let started = false;
  const region = regionOf(plan);
  const slot = acquire() ? claimSlot({ ...region, height: region.height + below }) : null;
  const gone = () => {
    if (over) return;
    over = true;
    ends.delete(id);
    if (slot) {
      slot.users = Math.max(0, slot.users - 1);
      // Never drawn on (cancelled before its start): out of the page again.
      if (!slot.users && !started) slot.el.remove();
    }
    resolve();
  };
  // Whatever happens, a message does not stay in the air for long.
  const guard = window.setTimeout(gone, plan.end + 6000);
  void finished.then(() => window.clearTimeout(guard));

  if (slot) {
    slot.users++;
    // In the page from this frame on: its surface is already there, the worker's frames show at once.
    if (!slot.el.isConnected) document.body.appendChild(slot.el);
    ends.set(id, gone);
    return {
      plan,
      start(t0) {
        // Once, and never after a cancel: a message given up before its first frame draws nothing.
        if (started || over) return;
        started = true;
        post({ type: 'start', id, layer: slot.id, origin: slot.at, spec: this.plan.spec, shifts: this.plan.shifts, at: performance.timeOrigin + t0 });
        if (frozenAt != null) post({ type: 'freeze', t: frozenAt });
      },
      retarget(to) {
        this.plan = planLiquid({ ...this.plan.spec, to }, this.plan.shifts);
        if (started) post({ type: 'retarget', id, spec: this.plan.spec });
      },
      retime(t0) {
        if (started && !over) post({ type: 'retime', id, at: performance.timeOrigin + t0 });
      },
      leaving(by) {
        if (!started) this.plan = planLiquid({ ...this.plan.spec, bar: by }, this.plan.shifts);
      },
      backdrop(b) {
        if (over) return b.bitmap.close();
        post({ type: 'backdrop', id, layer: slot.id, back: b }, [b.bitmap]);
      },
      shift(s) {
        this.plan.shifts.push(s);
        if (started) post({ type: 'shift', id, shift: s });
      },
      cancel() {
        if (started) post({ type: 'cancel', id });
        else gone();
      },
      finished,
    };
  }
  // The worker's canvases are not ready yet (a send right after the app opened), or it does not fit.
  prepare();
  return drawHere(plan, finished, gone);
}

/** No worker canvas: one of the message's own, drawn on this thread. */
function drawHere(plan: LiquidPlan, finished: Promise<void>, gone: () => void): Pour {
  const b = regionOf(plan);
  const scale = scaleNow();
  const el = document.createElement('canvas');
  el.className = 'send-liquid';
  el.setAttribute('aria-hidden', 'true');
  el.width = Math.max(1, Math.round(b.width * scale));
  el.height = Math.max(1, Math.round(b.height * scale));
  el.style.cssText = `left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;`;
  let started = false;
  let t0 = 0;
  let fade = -1;
  let r: ReturnType<typeof makeRenderer> = null;
  let back = 0;
  const handle: Pour = {
    plan,
    start(at) {
      if (started) return;
      started = true;
      t0 = at;
      document.body.appendChild(el);
      void finished.then(() => {
        el.remove();
        r?.dispose();
      });
      r = makeRenderer(el, scale);
      if (!r) return gone();
      local.add(draw);
      void finished.then(() => local.delete(draw));
      requestAnimationFrame(draw);
    },
    retarget(to) {
      this.plan = planLiquid({ ...this.plan.spec, to }, this.plan.shifts);
    },
    retime(at) {
      if (started) t0 = at;
    },
    leaving(by) {
      if (!started) this.plan = planLiquid({ ...this.plan.spec, bar: by }, this.plan.shifts);
    },
    backdrop(b) {
      if (!r) return b.bitmap.close();
      back = r.backdrop(b);
    },
    shift(s) {
      this.plan.shifts.push(s);
    },
    cancel() {
      if (!started) return gone();
      if (fade < 0) fade = performance.now() - t0;
    },
    finished,
  };
  const draw = () => {
    if (!r) return;
    const t = frozenAt ?? performance.now() - t0;
    const f = liquidAt(handle.plan, t);
    if (fade >= 0) f.alpha *= Math.min(1, Math.max(0, 1 - (t - fade) / 120));
    if ((f.done || (fade >= 0 && t - fade > 120)) && frozenAt == null) {
      r.clear();
      return gone();
    }
    r.draw([{ f, back: back || undefined }], { x: b.left, y: b.top });
    if (frozenAt == null) requestAnimationFrame(draw);
  };
  return handle;
}

/** Dev: draws every pour at `t` ms after its start and holds it there (null runs on). */
export function freezeLiquid(t: number | null) {
  frozenAt = t;
  post({ type: 'freeze', t });
  for (const d of local) requestAnimationFrame(d);
}
