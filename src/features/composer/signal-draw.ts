import { along, coolAt, ditherOn, headAt, LINE, outline, outlineAt, shiftAt, tailAt, TAIL, type Point, type SignalPlan } from './signal-shape';

/**
 * Draws sent messages as signal (signal-shape.ts) on a 2D canvas: in the worker
 * (signal.worker.ts) or, where there is none, on the page (signal.ts). Ivory on transparent, no
 * blur, no glow: a 1 px line on whole device pixels, its head a little wider, its tail and the
 * outline's far end stepped in dither. Under load (`lite`) the tail goes before frames do: only
 * the solid part near the head is drawn.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface SignalFrame {
  plan: SignalPlan;
  t: number;
  /** A cancelled message fades (1: whole). */
  alpha: number;
}

const IVORY = '242, 241, 238';

/** The outline per card box (a box changes only by a correction): points kept for the frames of one message. */
const outlines = new WeakMap<SignalPlan, { key: string; pts: Point[] }>();
function outlineOf(plan: SignalPlan, dx: number, dy: number): Point[] {
  const to = plan.spec.to;
  const x = plan.path[plan.path.length - 1].x;
  const key = `${(to.left + dx).toFixed(1)},${(to.top + dy).toFixed(1)},${to.width},${to.height},${x + dx}`;
  const had = outlines.get(plan);
  if (had?.key === key) return had.pts;
  const pts = outline({ ...to, left: to.left + dx, top: to.top + dy }, x + dx);
  outlines.set(plan, { key, pts });
  return pts;
}

/** Whether the message has anything left to draw at `t`. */
export const drawing = (plan: SignalPlan, t: number) => t >= plan.born && t <= plan.end;

export function drawSignal(g: Ctx, frames: SignalFrame[], origin: Point, scale: number, lite = false) {
  const lw = Math.max(1, Math.round(scale));
  const cell = Math.max(2, Math.round(2 * scale));
  const half = (lw % 2) / 2;
  const X = (x: number) => Math.round((x - origin.x) * scale);
  const Y = (y: number) => Math.round((y - origin.y) * scale);
  for (const { plan, t, alpha } of frames) {
    if (!drawing(plan, t) || alpha <= 0) continue;
    const s = headAt(plan, t);
    const shift = shiftAt(plan, t);
    // The trace's end moves with the card; its foot stays on the key.
    const path = plan.path.map((p, i) => (i === 0 ? p : { x: p.x + shift.x, y: p.y + shift.y }));
    const D = plan.reach;
    // ── the trace: from the head back along the path, its tail falling off in dither steps ──
    const tailEnd = s - (lite ? TAIL * 0.3 : TAIL);
    if (tailEnd < D) {
      const head = Math.min(s, D);
      const from = Math.max(0, tailEnd);
      const step = cell / scale;
      for (let d = head, i = 0; d > from; d -= step, i++) {
        const behind = s - d;
        const f = tailAt(behind);
        if (!ditherOn(i, f)) continue;
        const p = along(path, d);
        const len = Math.min(cell, Math.round((d - from) * scale));
        if (len <= 0) break;
        g.fillStyle = `rgba(${IVORY}, ${(LINE.body * alpha).toFixed(3)})`;
        // Laid along the way it runs: a vertical run of cells or a horizontal one.
        if (Math.abs(p.dy) >= Math.abs(p.dx)) g.fillRect(X(p.x), Y(p.y), lw, len);
        else g.fillRect(X(p.x) - len, Y(p.y), len, lw);
      }
      if (s < D) {
        // The head: brighter and a pixel wider, a few px long.
        const p = along(path, s);
        g.fillStyle = `rgba(${IVORY}, ${(LINE.head * alpha).toFixed(3)})`;
        if (Math.abs(p.dy) >= Math.abs(p.dx)) g.fillRect(X(p.x), Y(p.y), lw + 1, Math.round(3 * scale));
        else g.fillRect(X(p.x) - Math.round(3 * scale), Y(p.y), Math.round(3 * scale), lw + 1);
      }
    }
    // ── the outline: two heads from where the trace met the card, closing at the top ──
    if (s <= D) continue;
    const pts = outlineOf(plan, shift.x, shift.y);
    const n = pts.length;
    const k = Math.min(plan.half, s - D);
    const cool = coolAt(plan, t) * alpha;
    if (cool <= 0) continue;
    g.lineWidth = lw;
    const at = (i: number) => pts[((i % n) + n) % n];
    for (const dir of [1, -1]) {
      for (let i = 0; i < k; i += 2) {
        const a = outlineAt(k - i) * cool;
        const p = at(dir * i);
        const q = at(dir * Math.min(i + 2, Math.ceil(k)));
        g.strokeStyle = `rgba(${IVORY}, ${a.toFixed(3)})`;
        g.beginPath();
        g.moveTo(X(p.x) + half, Y(p.y) + half);
        g.lineTo(X(q.x) + half, Y(q.y) + half);
        g.stroke();
      }
      if (k < plan.half) {
        const p = at(dir * Math.floor(k));
        g.fillStyle = `rgba(${IVORY}, ${alpha.toFixed(3)})`;
        g.fillRect(X(p.x) - 1, Y(p.y) - 1, lw + 1, lw + 1);
      }
    }
  }
}
