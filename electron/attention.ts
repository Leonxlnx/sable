/**
 * The taskbar's part of "this chat needs you" (the rule is the page's, `src/lib/attention.ts`; it
 * tells the shell through the preload's `attention.set`): on Windows an overlay on the taskbar
 * button with the number of chats waiting and one flash of the button when a chat starts waiting
 * while the window is not focused; on a Mac the Dock's badge and one informational bounce. The
 * flash stops when the window is focused or nothing waits any more; it is never repeated by a timer.
 *
 * The overlay is drawn here, in code: a disc of ink with an amber rim (amber: waiting on you) and
 * the figure in ivory, rasterised with 4x4 samples per pixel at the size the taskbar shows it.
 */

/** Ink, the amber rim and the ivory figure (the page's --bg, --amber, --text). */
const INK = [7, 7, 8] as const;
const AMBER = [246, 193, 89] as const;
const IVORY = [242, 241, 238] as const;

type Pt = readonly [number, number];
type Stroke = Pt[];

/** Points on an ellipse from angle a0 to a1 (radians, y down: -PI/2 is the top). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 18): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

const PI = Math.PI;

/** The figures as strokes in a box 6 wide and 10 tall. */
const GLYPHS: Record<string, Stroke[]> = {
  '0': [arc(3, 5, 2.9, 4.9, 0, 2 * PI, 28)],
  '1': [[[1.1, 2.2], [3.6, 0], [3.6, 10]]],
  '2': [[...arc(3, 3, 2.9, 2.9, PI, 2 * PI + 0.55, 16), [0.1, 10], [6, 10]]],
  '3': [arc(3, 2.6, 2.6, 2.6, PI + 0.45, 2.5 * PI, 14), arc(3, 7.35, 2.85, 2.65, -0.5 * PI, PI - 0.45, 14)],
  '4': [[[4.4, 10], [4.4, 0], [0, 6.9], [6, 6.9]]],
  '5': [[[5.6, 0], [0.9, 0], [0.5, 4.5], ...arc(3, 6.85, 2.95, 3.05, -2.4, 2.55, 16)]],
  '6': [[[4.7, 0], [0.55, 5.9]], arc(3, 7.1, 2.9, 2.85, 0, 2 * PI, 22)],
  '7': [[[0, 0], [6, 0], [2.2, 10]]],
  '8': [arc(3, 2.5, 2.4, 2.45, 0, 2 * PI, 20), arc(3, 7.35, 2.85, 2.6, 0, 2 * PI, 22)],
  '9': [arc(3, 2.9, 2.9, 2.85, 0, 2 * PI, 22), [[5.45, 4.1], [1.3, 10]]],
  '+': [[[3, 2.2], [3, 7.8]], [[0.2, 5], [5.8, 5]]],
};

/** What the overlay shows: the figure up to 9, then "9+". */
export const badgeText = (count: number) => (count > 9 ? '9+' : String(Math.max(0, Math.floor(count))));

function segDist(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len)) : 0;
  const x = a[0] + t * dx - px;
  const y = a[1] + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

/**
 * The overlay as premultiplied BGRA pixels, `size` pixels square (16 at 100% display scale, 20 at
 * 125%). Pure, so a test can read it.
 */
export function badgePixels(count: number, size: number): Buffer {
  const text = badgeText(count);
  const r = size / 2;
  const rim = Math.max(1, size * 0.075);
  // The figure: 10 units tall is 52% of the disc; two characters are narrower so they fit.
  const unit = (size * (text.length > 1 ? 0.044 : 0.052));
  const stroke = Math.max(1.05, size * (text.length > 1 ? 0.085 : 0.1));
  const gap = 1.6;
  const width = text.length * 6 + (text.length - 1) * gap;
  const ox = r - (width * unit) / 2;
  const oy = r - 5 * unit;
  const segs: [Pt, Pt][] = [];
  [...text].forEach((ch, i) => {
    for (const s of GLYPHS[ch] ?? []) {
      const pts = s.map(([x, y]) => [ox + (x + i * (6 + gap)) * unit, oy + y * unit] as Pt);
      for (let k = 1; k < pts.length; k++) segs.push([pts[k - 1], pts[k]]);
    }
  });
  const buf = Buffer.alloc(size * size * 4);
  const N = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cr = 0;
      let cg = 0;
      let cb = 0;
      let ca = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const px = x + (sx + 0.5) / N;
          const py = y + (sy + 0.5) / N;
          const d = Math.hypot(px - r, py - r);
          if (d > r) continue;
          let c: readonly number[] = d > r - rim ? AMBER : INK;
          if (c === INK) {
            for (const [a, b] of segs) {
              if (segDist(px, py, a, b) <= stroke / 2) {
                c = IVORY;
                break;
              }
            }
          }
          cr += c[0];
          cg += c[1];
          cb += c[2];
          ca += 255;
        }
      }
      const n = N * N;
      const i = (y * size + x) * 4;
      // Premultiplied: each colour sample already counts with full alpha.
      buf[i] = Math.round(cb / n);
      buf[i + 1] = Math.round(cg / n);
      buf[i + 2] = Math.round(cr / n);
      buf[i + 3] = Math.round(ca / n);
    }
  }
  return buf;
}

// ── the shell's calls ──

export interface AttentionWindow {
  setOverlayIcon(image: unknown, description: string): void;
  flashFrame(flag: boolean): void;
  isFocused(): boolean;
  isDestroyed(): boolean;
}

export interface Dock {
  setBadge(text: string): void;
  bounce(type?: 'critical' | 'informational'): number;
  cancelBounce(id: number): void;
}

export interface AttentionDeps {
  platform: NodeJS.Platform;
  /** The overlay for a count (Windows); called only when the count changes. */
  image: (count: number) => unknown;
  dock?: Dock;
}

/** What the page asked for: the number of chats waiting, and whether this change should flash once. */
export interface AttentionState {
  count: number;
  flash: boolean;
}

/** Reads the page's message: a bounded whole number and a flag, anything else ignored. */
export function readAttention(msg: unknown): AttentionState | null {
  const o = msg as { count?: unknown; flash?: unknown } | null;
  if (!o || typeof o !== 'object' || typeof o.count !== 'number' || !Number.isFinite(o.count)) return null;
  return { count: Math.max(0, Math.min(999, Math.floor(o.count))), flash: o.flash === true };
}

export class TaskbarAttention {
  private count = 0;
  private flashing = false;
  private bounceId?: number;

  constructor(private deps: AttentionDeps) {}

  set(w: AttentionWindow | undefined, next: AttentionState) {
    if (!w || w.isDestroyed()) return;
    const { platform, dock } = this.deps;
    if (next.count !== this.count) {
      this.count = next.count;
      const label = next.count === 1 ? '1 chat waiting on you' : `${next.count} chats waiting on you`;
      if (platform === 'win32') w.setOverlayIcon(next.count ? this.deps.image(next.count) : null, next.count ? label : '');
      else if (platform === 'darwin') dock?.setBadge(next.count ? badgeText(next.count) : '');
    }
    if (!next.count) this.stop(w);
    else if (next.flash && !w.isFocused() && !this.flashing) {
      this.flashing = true;
      if (platform === 'win32') w.flashFrame(true);
      else if (platform === 'darwin' && dock) this.bounceId = dock.bounce('informational');
    }
  }

  /** The window was focused (or nothing waits): the flash ends. */
  stop(w: AttentionWindow | undefined) {
    if (!this.flashing) return;
    this.flashing = false;
    if (this.deps.platform === 'win32' && w && !w.isDestroyed()) w.flashFrame(false);
    if (this.bounceId !== undefined) this.deps.dock?.cancelBounce(this.bounceId);
    this.bounceId = undefined;
  }
}
