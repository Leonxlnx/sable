import { drawing, drawSignal, type SignalFrame } from './signal-draw';
import { planSignal, type Shift, type SignalPlan, type SignalSpec } from './signal-shape';

/**
 * Draws sent messages as signal (signal-shape.ts, signal-draw.ts) off the main thread, on
 * canvases the page hands over once, while it is idle (signal.ts). A canvas is never resized for
 * a message: one that is new or resized only shows once the page's main thread has caught up with
 * it, and right after a send that thread is busy (a session mounting, a turn starting). So the
 * line moves at the display's rate whatever the page is doing.
 *
 * Each message is timed from its start (the page's clock, carried over as an absolute time), the
 * clock its words step on, so the two agree without talking. Idle between messages: no frame is
 * asked for when nothing is in the air, and the last frame drawn is a clear one.
 */

export type SignalMessage =
  /** A canvas, once, with its size in device px and the device px per page px; drawn clear at once. */
  | { type: 'layer'; id: number; canvas: OffscreenCanvas; size: { w: number; h: number }; scale: number }
  | { type: 'drop'; layer: number }
  /** A message starts on canvas `layer`, which stands at `origin` (page px); `at` is the page's absolute time of its start. */
  | { type: 'start'; id: number; layer: number; origin: { x: number; y: number }; spec: SignalSpec; shifts: Shift[]; at: number }
  | { type: 'retarget'; id: number; spec: SignalSpec }
  /** The message's start, corrected (the page's absolute time). */
  | { type: 'retime'; id: number; at: number }
  | { type: 'shift'; id: number; shift: Shift }
  | { type: 'cancel'; id: number }
  /** Dev: draws every message at a fixed time after its start (null: runs on). */
  | { type: 'freeze'; t: number | null };

/** Done drawing a message (`frames`: when it drew, ms after its start, for the dev console); `free`: a canvas has nothing left on it. */
export type SignalReply = { type: 'done'; id: number; frames?: number[] } | { type: 'free'; layer: number };

interface Host {
  layer: number;
  origin: { x: number; y: number };
  plan: SignalPlan;
  /** The start, on this worker's clock. */
  t0: number;
  /** Cancelled: fades from this time on. */
  fade: number;
  drawn: number[];
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<SignalMessage>) => void) | null;
  postMessage: (msg: SignalReply) => void;
  requestAnimationFrame: (cb: (now: number) => void) => number;
};

interface Layer {
  g: OffscreenCanvasRenderingContext2D;
  w: number;
  h: number;
  scale: number;
  /** Something is on it (a clear frame is owed once nothing is in the air). */
  dirty: boolean;
}

const hosts = new Map<number, Host>();
const layers = new Map<number, Layer>();
let frozen: number | null = null;
let looping = false;

const FADE_OUT = 120;

/**
 * The governor: when this worker's own frames come late (a loaded machine), detail is shed before
 * frames are: the opening shape's dithered edge goes (`lite`), the line and the shape stay. Two late frames in a row shed
 * it for the rest of what is in the air; it comes back with the next message.
 */
const LATE_MS = 26;
let lastFrame = 0;
let late = 0;
let lite = false;

scope.onmessage = (e: MessageEvent<SignalMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'layer': {
      const g = m.canvas.getContext('2d');
      if (!g) return;
      g.clearRect(0, 0, m.size.w, m.size.h);
      layers.set(m.id, { g, w: m.size.w, h: m.size.h, scale: m.scale, dirty: false });
      break;
    }
    case 'drop':
      layers.delete(m.layer);
      break;
    case 'start':
      if (!layers.has(m.layer)) return scope.postMessage({ type: 'done', id: m.id });
      hosts.set(m.id, { layer: m.layer, origin: m.origin, plan: planSignal(m.spec, m.shifts), t0: m.at - performance.timeOrigin, fade: -1, drawn: [] });
      loop();
      break;
    case 'retarget': {
      const h = hosts.get(m.id);
      if (h) h.plan = planSignal(m.spec, h.plan.shifts);
      break;
    }
    case 'retime': {
      const h = hosts.get(m.id);
      if (h) h.t0 = m.at - performance.timeOrigin;
      break;
    }
    case 'shift':
      hosts.get(m.id)?.plan.shifts.push(m.shift);
      break;
    case 'cancel': {
      const h = hosts.get(m.id);
      if (h && h.fade < 0) h.fade = performance.now() - h.t0;
      break;
    }
    case 'freeze':
      frozen = m.t;
      loop();
      break;
  }
};

function loop() {
  if (looping) return;
  looping = true;
  scope.requestAnimationFrame(frame);
}

function frame(now: number) {
  looping = false;
  if (lastFrame && frozen == null) {
    late = now - lastFrame > LATE_MS ? late + 1 : 0;
    if (late >= 2) lite = true;
  }
  lastFrame = now;
  const drawn = new Map<number, { frames: SignalFrame[]; origin: { x: number; y: number } }>();
  for (const [id, h] of hosts) {
    const t = frozen ?? now - h.t0;
    const alpha = h.fade >= 0 ? Math.min(1, Math.max(0, 1 - (t - h.fade) / FADE_OUT)) : 1;
    const over = t > h.plan.end || (h.fade >= 0 && t - h.fade >= FADE_OUT);
    if (over && frozen == null) {
      hosts.delete(id);
      scope.postMessage({ type: 'done', id, frames: import.meta.env.DEV ? h.drawn : undefined });
      continue;
    }
    if (import.meta.env.DEV && h.drawn.length < 80 && drawing(h.plan, t)) h.drawn.push(Math.round(t));
    const d = drawn.get(h.layer) ?? { frames: [], origin: h.origin };
    d.frames.push({ plan: h.plan, t, alpha });
    drawn.set(h.layer, d);
  }
  for (const [id, l] of layers) {
    const d = drawn.get(id);
    if (d) {
      l.g.clearRect(0, 0, l.w, l.h);
      drawSignal(l.g, d.frames, d.origin, l.scale, lite);
      l.dirty = true;
    } else if (l.dirty) {
      // One clear frame, then the canvas is free.
      l.g.clearRect(0, 0, l.w, l.h);
      l.dirty = false;
      scope.postMessage({ type: 'free', layer: id });
    }
  }
  // A canvas with nothing left on it was cleared in this frame: the next is only for messages still in the air.
  if (hosts.size && frozen == null) loop();
  else {
    lastFrame = 0;
    late = 0;
    lite = false;
  }
}
