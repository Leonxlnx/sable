/**
 * The launch piece's light: one low-resolution bitmap (a pixel per cell, scaled up hard like the
 * backdrop's field) over the whole window, drawn in the field worker so it keeps its pace while the
 * app mounts underneath. Ink, ivory and nothing else; every edge is an ordered-dither threshold.
 *
 * One clock, four movements (times in ms, see `LAUNCH`):
 * - ignition: the window is ink; one cell lights and stands alone for a beat.
 * - the wake: a front of thresholds leaves that cell and runs out past the corners, cells answering
 *   as it passes and going dark again in dither order behind it. Where the mark belongs they stay:
 *   its sixteen places fill in the mark's own Bayer order, each one itself an 8 x 8 dither ramp from
 *   a scatter to solid, so the logo is built from the same cells as the light around it.
 * - the hold (for as long as the bridge takes): the mark stands in a thin halo of cells, and a
 *   sparse ring leaves it now and then.
 * - the release: the light gathers onto the mark, then a crest leaves it and crosses the window;
 *   behind the crest the ink itself opens in dither order (those pixels become transparent), so
 *   the app is what the wave leaves behind. The page moves the mark to its place meanwhile.
 *
 * `finish` opens everything at once (a key or a click: the piece yields). The piece is a pure
 * function of its clock: a slow frame costs smoothness, never correctness.
 */

/** The mark's side in cells: four places of 8 x 8, each exactly one Bayer tile. */
export const LAUNCH_MARK_CELLS = 32;
/** Cells kept dark around the standing mark, so its edges stay clean. */
const MOAT = 3;

export const LAUNCH = {
  /** The first cell stands alone this long. */
  ignite: 60,
  /** The wake's front reaches the far corner after this. */
  wake: 620,
  /** Gap between the mark's places starting to fill, and how long one takes. */
  placeStep: 12,
  placeFill: 140,
  /** The light gathers on the mark before the crest leaves. */
  inhale: 80,
  /** The crest and the opening behind it: from the mark to past the far corner. */
  burst: 520,
  /** A yielded piece opens in this. */
  finish: 150,
  /** One ring per this while held. */
  breath: 1900,
  /**
   * The app was ready before the mark stood whole: the build runs this many times faster until it
   * does, so the piece gives way as soon as it can (the same build, only quicker).
   */
  hurry: 2.5,
} as const;

/** When the mark stands whole. */
export const LAUNCH_FORMED = LAUNCH.ignite + 40 + 13 * LAUNCH.placeStep + LAUNCH.placeFill;

/** The mark's places as [column, row] in the order they fill (the 4 x 4 Bayer order, as MARK_CELLS in Logo.tsx). */
const PLACES: readonly (readonly [number, number])[] = [
  [0, 0], [2, 2], [2, 0], [0, 2], [1, 1], [3, 3], [3, 1], [1, 3],
  [1, 0], [3, 0], [1, 2], [0, 1], [2, 1], [0, 3],
];

/** 8 x 8 ordered-dither thresholds, centred (never exactly 0 or 1). */
const BAYER8 = (() => {
  const m = new Float32Array(64);
  const b2 = [0, 2, 3, 1];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let v = 0;
      for (let bit = 0; bit < 3; bit++) v += b2[((y >> bit) & 1) * 2 + ((x >> bit) & 1)] / 4 ** (bit + 1);
      m[y * 8 + x] = v + 1 / 128;
    }
  return m;
})();

export interface LaunchGeometry {
  cols: number;
  rows: number;
  /** The mark's top-left cell. */
  mx: number;
  my: number;
}

export interface LaunchColours {
  /** 0xAABBGGRR, as a Uint32 view of ImageData reads on little-endian machines. */
  ink: number;
  ivory: number;
  dim: number;
}

/** Where the mark sits for a window of `width` x `height` layout pixels drawn with `cell`-pixel cells. */
export function launchGeometry(width: number, height: number, cell: number): LaunchGeometry {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  return {
    cols,
    rows,
    mx: Math.round(width / cell / 2) - LAUNCH_MARK_CELLS / 2,
    // A little above the middle, where the eye lands.
    my: Math.round((height / cell) * 0.46) - LAUNCH_MARK_CELLS / 2,
  };
}

/** Cells of about 6 px (larger on a large window), in whole device pixels, and where the mark sits. */
export function launchMeasure(width: number, height: number, dpr: number): { cell: number; geometry: LaunchGeometry } {
  const base = Math.min(8, Math.max(5, Math.round(Math.min(width, height) / 130)));
  const cell = Math.max(1, Math.round(base * dpr)) / dpr;
  return { cell, geometry: launchGeometry(width, height, cell) };
}

/** #rrggbb to the Uint32 an ImageData view reads (little-endian: 0xAABBGGRR). */
function abgr(hex: string, fallback: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return (0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | (v >> 16)) >>> 0;
}

function mix(a: number, b: number, k: number) {
  const ch = (s: number) => Math.round(((a >> s) & 0xff) * (1 - k) + ((b >> s) & 0xff) * k) << s;
  return (0xff000000 | ch(16) | ch(8) | ch(0)) >>> 0;
}

/** The piece's colours from the page's tokens (`--bg`, `--text`). */
export function launchColours(css: CSSStyleDeclaration): LaunchColours {
  const ink = abgr(css.getPropertyValue('--bg'), 0xff080707);
  const ivory = abgr(css.getPropertyValue('--text'), 0xffeef1f2);
  return { ink, ivory, dim: mix(ink, ivory, 0.4) };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => {
  const c = clamp01(v);
  return c * c * (3 - 2 * c);
};

export class LaunchPiece {
  private g: LaunchGeometry = { cols: 0, rows: 0, mx: 0, my: 0 };
  private dist = new Float32Array(0);
  private far = 1;
  private readonly place = new Int8Array(16).fill(-1);
  private readonly fill = new Float32Array(PLACES.length);
  /** Clock times of the release and of a yield; -1 until they happen. */
  private releasedAt = -1;
  private finishedAt = -1;
  done = false;

  constructor(private readonly colours: LaunchColours) {
    PLACES.forEach(([c, r], i) => (this.place[r * 4 + c] = i));
  }

  get released() {
    return this.releasedAt >= 0;
  }

  resize(g: LaunchGeometry) {
    this.g = g;
    const { cols, rows } = g;
    const cx = g.mx + LAUNCH_MARK_CELLS / 2 - 0.5;
    const cy = g.my + LAUNCH_MARK_CELLS / 2 - 0.5;
    this.dist = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) this.dist[y * cols + x] = Math.hypot(x - cx, y - cy);
    const fx = Math.max(cx, cols - cx);
    const fy = Math.max(cy, rows - cy);
    this.far = Math.hypot(fx, fy);
  }

  release(t: number) {
    if (this.releasedAt < 0) this.releasedAt = t;
  }

  finish(t: number) {
    if (this.finishedAt < 0) this.finishedAt = t;
  }

  /** Draws the frame for clock time `t` into `px` (cols x rows, one Uint32 per cell). */
  draw(t: number, px: Uint32Array) {
    const { cols, rows, mx, my } = this.g;
    const { ink, ivory, dim } = this.colours;
    const dist = this.dist;
    const far = this.far;
    const L = LAUNCH;
    /** The mark's half diagonal, where the light around it starts. */
    const edge = LAUNCH_MARK_CELLS * 0.62;

    const tr = this.releasedAt < 0 ? -1 : t - this.releasedAt;
    const tf = this.finishedAt < 0 ? -1 : t - this.finishedAt;
    const released = tr >= 0;

    // The first cell.
    const spark = t < L.ignite + 90;
    const sx = mx + LAUNCH_MARK_CELLS / 2;
    const sy = my + LAUNCH_MARK_CELLS / 2;

    // The wake: fast off the cell, gliding out; its tail lengthens and its light thins as it goes.
    const uw = clamp01((t - L.ignite) / L.wake);
    const ew = 1 - (1 - uw) ** 2.6;
    const rw = ew * (far + 6);
    const leadW = 2.5;
    const tailW = 12 + 46 * ew;
    let ampW = t < L.ignite ? 0 : 0.92 * (1 - uw) ** 1.3;

    // The mark's places.
    const fill = this.fill;
    let whole = true;
    for (let i = 0; i < fill.length; i++) {
      fill[i] = released ? 0 : 1.25 * smooth((t - L.ignite - 40 - i * L.placeStep) / L.placeFill);
      if (fill[i] < 1.2) whole = false;
    }

    // The hold: a thin halo, and a sparse ring leaving the mark now and then.
    let halo = 0.17 * smooth((t - LAUNCH_FORMED + 260) / 520);
    const tb = t - LAUNCH_FORMED - 240;
    const ub = tb < 0 ? 2 : (tb % L.breath) / (L.breath * 0.8);
    const rb = edge + 2 + 46 * (1 - (1 - Math.min(1, ub)) ** 1.9);
    let ampB = ub >= 1 ? 0 : 0.34 * (ub < 0.14 ? ub / 0.14 : (1 - ub) ** 1.5);

    // The release: everything that was there lets go, the light gathers, the crest leaves.
    let rIn = 0;
    let ampIn = 0;
    let R = -1;
    let ampC = 0;
    let gap = 0;
    let invW = 0;
    let tailC = 1;
    let over = false;
    if (released) {
      const let_go = 1 - clamp01(tr / 140);
      ampW *= let_go;
      halo *= let_go;
      ampB *= let_go;
      const ui = tr / L.inhale;
      if (ui < 1) {
        // Draws in to the mark's corners and no further (its notch stays dark).
        rIn = edge + 1 + 16 * (1 - ui) ** 1.6;
        ampIn = 0.85 * ui;
      }
      const u = clamp01((tr - L.inhale) / L.burst);
      if (tr >= L.inhale) {
        const e = 1 - (1 - u) ** 2.3;
        gap = 3 + 9 * e;
        const W = 8 + 30 * e;
        invW = 1 / W;
        R = e * (far + 12 + 38 + 6);
        tailC = 10 + 12 * e;
        ampC = 0.3 + 0.7 * (1 - u) ** 1.1;
      }
      over = u >= 1;
    }
    const G = tf < 0 ? 0 : (tf / L.finish) * 1.08;
    const lights = tf < 0 ? 1 : 1 - clamp01(tf / L.finish);
    if (over || (tf >= 0 && tf >= L.finish)) {
      px.fill(0);
      this.done = true;
      return;
    }

    for (let y = 0; y < rows; y++) {
      const by = ((y - my) & 7) << 3;
      const ry = y - my;
      const inRows = ry >= 0 && ry < LAUNCH_MARK_CELLS;
      const inMoat = ry >= -MOAT && ry < LAUNCH_MARK_CELLS + MOAT;
      for (let x = 0, i = y * cols; x < cols; x++, i++) {
        const d = dist[i];
        const b = BAYER8[by | ((x - mx) & 7)];
        // Opened: the app shows through.
        if (G > b || (R >= 0 && (R - gap - d) * invW * 1.08 > b)) {
          px[i] = 0;
          continue;
        }
        let v = 0;
        if (ampW > 0) {
          const sd = d - rw;
          if (sd < leadW && sd > -tailW) {
            // A crisp crest, and a long thin tail of cells going dark behind it in threshold order.
            if (sd >= 0) {
              const q = 1 - sd / leadW;
              v = ampW * q * q;
            } else {
              const q = 1 + sd / tailW;
              const q2 = q * q;
              v = ampW * (0.62 * q2 * q2 * q2 * q2 + 0.38 * q2);
            }
          }
        }
        // The hold's light is the quiet kind (never brighter than dim), and keeps clear of the mark's edges.
        let soft = 0;
        const rx = x - mx;
        if ((halo > 0 || ampB > 0) && !(inMoat && rx >= -MOAT && rx < LAUNCH_MARK_CELLS + MOAT)) {
          if (halo > 0 && d < edge + 30) {
            const q = d <= edge ? 1 : 1 - (d - edge) / 30;
            soft = halo * q * q;
          }
          if (ampB > 0) {
            const sd = d - rb;
            if (sd < 2 && sd > -9) {
              const q = sd >= 0 ? 1 - sd / 2 : 1 + sd / 9;
              const h = ampB * q * q;
              if (h > soft) soft = h;
            }
          }
        }
        if (ampIn > 0) {
          const sd = d - rIn;
          if (sd < 6 && sd > -3) {
            const q = sd >= 0 ? 1 - sd / 6 : 1 + sd / 3;
            const h = ampIn * q * q;
            if (h > v) v = h;
          }
        }
        if (R >= 0) {
          const sd = d - R;
          if (sd < 2.5 && sd > -tailC) {
            let h: number;
            if (sd >= 0) {
              const q = 1 - sd / 2.5;
              h = ampC * q * q;
            } else {
              // The crest's bright core, and a scatter of cells still lit on the ink it leaves.
              const q = 1 + sd / tailC;
              const q3 = q * q * q;
              h = ampC * (0.7 * q3 * q3 + 0.3 * q * q);
            }
            if (h > v) v = h;
          }
        }
        if (inRows && !released) {
          if (rx >= 0 && rx < LAUNCH_MARK_CELLS) {
            const p = this.place[(ry >> 3) * 4 + (rx >> 3)];
            if (p >= 0 && fill[p] > v) v = fill[p];
          }
        }
        v = v * lights - b;
        // A cell just past its threshold shows dim first: fronts arrive soft, nothing flashes.
        px[i] = v > 0.1 ? ivory : v > 0 || soft * lights > b ? dim : ink;
      }
    }
    if (spark && tf < 0 && sx >= 0 && sx < cols && sy >= 0 && sy < rows) px[sy * cols + sx] = ivory;
    this.whole = whole;
  }

  /** True once every place of the mark is solid (set by `draw`). */
  whole = false;
}

// ── in the worker ──

export type LaunchMessage =
  | { type: 'launch'; id: number; op: 'init'; canvas: OffscreenCanvas; geometry: LaunchGeometry; colours: LaunchColours; frozen: boolean }
  | { type: 'launch'; id: number; op: 'size'; geometry: LaunchGeometry }
  | { type: 'launch'; id: number; op: 'release' | 'finish' | 'dispose' }
  /** The app is ready: the mark, not whole yet, builds faster until it is (`LAUNCH.hurry`). */
  | { type: 'launch'; id: number; op: 'hurry' }
  /** Development only (frame sheets): the clock stands at `t` and a frame is drawn for it. */
  | { type: 'launch'; id: number; op: 'clock'; t: number };

export interface LaunchReply {
  id: number;
  launch: 'ignite' | 'formed' | 'done';
  /** Frames drawn and the slowest one, with `done` (for the counts). */
  frames?: number;
  worst?: number;
}

interface Host {
  piece: LaunchPiece;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  image: ImageData;
  px: Uint32Array;
  t0: number;
  frozen: number | null;
  /** From real time `r0` (ms since t0) the clock ran `LAUNCH.hurry` times faster until the mark stood. */
  hurried: { r0: number } | null;
  formed: boolean;
  frames: number;
  worst: number;
  stopped: boolean;
}

const hosts = new Map<number, Host>();

/** Handles a launch message in the field worker; false when the message is not one. */
export function launchMessage(m: { type: string }, post: (r: LaunchReply) => void): boolean {
  if (m.type !== 'launch') return false;
  const msg = m as LaunchMessage;
  if (msg.op === 'init') {
    const ctx = msg.canvas.getContext('2d');
    if (!ctx) return true;
    const piece = new LaunchPiece(msg.colours);
    const h: Host = { piece, canvas: msg.canvas, ctx, image: new ImageData(1, 1), px: new Uint32Array(1), t0: -1, frozen: msg.frozen ? 0 : null, hurried: null, formed: false, frames: 0, worst: 0, stopped: false };
    hosts.set(msg.id, h);
    fit(h, msg.geometry);
    frame(msg.id, h, post);
    return true;
  }
  const h = hosts.get(msg.id);
  if (!h) return true;
  const now = () => (h.frozen != null ? h.frozen : h.t0 < 0 ? 0 : clock(h, performance.now() - h.t0));
  switch (msg.op) {
    case 'size':
      fit(h, msg.geometry);
      break;
    case 'release':
      h.piece.release(now());
      break;
    case 'finish':
      h.piece.finish(now());
      break;
    case 'hurry':
      if (!h.formed && !h.hurried && h.frozen == null && h.t0 >= 0) h.hurried = { r0: performance.now() - h.t0 };
      break;
    case 'clock':
      h.frozen = msg.t;
      frame(msg.id, h, post);
      break;
    case 'dispose':
      h.stopped = true;
      hosts.delete(msg.id);
      break;
  }
  return true;
}

/**
 * The piece's clock for `real` ms since its first frame: real time, except after a hurry at `hurriedAt`
 * (real ms), from where it runs `LAUNCH.hurry` times faster until the mark stands whole, then at the
 * real pace again. Continuous, never going back.
 */
export function launchClock(real: number, hurriedAt: number | null): number {
  if (hurriedAt === null || real <= hurriedAt || hurriedAt >= LAUNCH_FORMED) return real;
  const fast = hurriedAt + (real - hurriedAt) * LAUNCH.hurry;
  if (fast <= LAUNCH_FORMED) return fast;
  const whole = hurriedAt + (LAUNCH_FORMED - hurriedAt) / LAUNCH.hurry;
  return LAUNCH_FORMED + (real - whole);
}

const clock = (h: Host, real: number) => launchClock(real, h.hurried ? h.hurried.r0 : null);

function fit(h: Host, g: LaunchGeometry) {
  h.canvas.width = g.cols;
  h.canvas.height = g.rows;
  h.image = new ImageData(g.cols, g.rows);
  h.px = new Uint32Array(h.image.data.buffer);
  h.piece.resize(g);
}

type Raf = (cb: (now: number) => void) => number;
const raf: Raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;

function frame(id: number, h: Host, post: (r: LaunchReply) => void) {
  if (h.stopped || h.piece.done) return;
  const start = performance.now();
  const first = h.t0 < 0;
  if (first) h.t0 = start;
  const t = h.frozen != null ? h.frozen : clock(h, start - h.t0);
  h.piece.draw(t, h.px);
  h.ctx.putImageData(h.image, 0, 0);
  const cost = performance.now() - start;
  h.frames++;
  if (cost > h.worst) h.worst = cost;
  if (first) post({ id, launch: 'ignite' });
  if (!h.formed && h.piece.whole) {
    h.formed = true;
    post({ id, launch: 'formed' });
  }
  if (h.piece.done) {
    post({ id, launch: 'done', frames: h.frames, worst: Math.round(h.worst * 100) / 100 });
    return;
  }
  // Frozen: one frame per clock message. Otherwise every frame, until the piece is over.
  if (h.frozen == null) raf(() => frame(id, h, post));
}
