import { useEffect, useRef } from 'react';
import type { ProviderId } from '@shared/protocol';
import { onScreen, onScreenChange } from '@m/lib/screen';

/**
 * The dither field behind home and chats, as on the desktop: light that gathers at the lower edge,
 * soft diagonal streaks, a 4x4 ordered dither in the agent's palette. Battery first: one still
 * frame at rest, a slow drift (8 fps) only while a turn runs on screen, one-shot beats (a wave from
 * the send key, a ring that closes when a turn is done, a pulse), nothing at all while the app is
 * hidden or under reduced motion. Waiting on you, it stills in amber.
 *
 * Home is its stage (`stage`): a second gather hangs from the top edge behind the title (the
 * horizon; amber while something waits on you), a sparse floor of cells lies under the whole page,
 * and the light breathes: it drifts for a while after home comes forward or is touched (`fieldWake`),
 * quicker while a turn runs, then rests on a still frame with no timer and no frame.
 */

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export type Palette = 'ember' | 'iris' | 'mint' | 'mono' | 'amber';
const PALETTES: Record<Palette, [RGB, RGB, RGB]> = {
  ember: [hex('#7a2608'), hex('#f2702e'), hex('#ffe2bc')],
  iris: [hex('#262c84'), hex('#6c88ff'), hex('#e2ebff')],
  mint: [hex('#0b6444'), hex('#45dc98'), hex('#e4ffec')],
  mono: [hex('#2c2c30'), hex('#909096'), hex('#f2f2f0')],
  amber: [hex('#5c3c06'), hex('#e0a838'), hex('#fff0c8')],
};

export const paletteFor = (p: ProviderId | undefined): Palette => (p === 'codex' ? 'iris' : p === 'demo' || p === 'opencode' ? 'mint' : 'ember');

/** The palette's middle colour, for pieces of the field drawn elsewhere (CSS). */
export const paletteRgb = (p: Palette) => PALETTES[p];

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/**
 * The grain of the light (2.18): smooth value noise over a fixed lattice, the same on every start, so
 * the bands of light break into the desktop field's slow currents instead of a perfect blob. Worked
 * out once per size (shape), never per frame.
 */
const LATTICE = (() => {
  let seed = 0x5ab1e;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Float32Array.from({ length: 64 * 64 }, rnd);
})();
const smooth = (t: number) => t * t * (3 - 2 * t);
function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const at = (i: number, j: number) => LATTICE[((j & 63) << 6) | (i & 63)];
  const a = at(xi, yi);
  const b = at(xi + 1, yi);
  const c = at(xi, yi + 1);
  const d = at(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/**
 * Battery first: on a phone running low and not charging (a stand-in for the battery saver, which a
 * page cannot read) the field keeps its still frame: no drift, no breathing; beats still play once.
 */
let lowPower = false;
void (navigator as unknown as { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener: (k: string, f: () => void) => void }> })
  .getBattery?.()
  .then((b) => {
    const read = () => (lowPower = !b.charging && b.level <= 0.2);
    read();
    b.addEventListener('levelchange', read);
    b.addEventListener('chargingchange', read);
  })
  .catch(() => {});

export type BeatKind = 'send' | 'done' | 'pulse' | 'open' | 'fail';
type Beat = { at: number; kind: BeatKind; x?: number; y?: number };
const beats = new Set<(b: Beat) => void>();

/** A one-shot beat through every field on screen; `at` is a point on the screen (the send key) it starts from. */
export function fieldBeat(kind: BeatKind, at?: { x: number; y: number } | Element | null) {
  let x: number | undefined;
  let y: number | undefined;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
  } else if (at) ({ x, y } = at);
  const b = { at: performance.now(), kind, x, y };
  for (const f of beats) f(b);
}

const LIFE: Record<BeatKind, number> = { send: 1.15, done: 1.3, pulse: 1.0, open: 0.9, fail: 1.1 };

/** How long the stage drifts after it was woken, then it rests. */
const AWAKE_MS = 8_000;
const wakes = new Set<() => void>();
/** Input on home, or home coming forward: the stage drifts again for a while. */
export function fieldWake() {
  for (const w of wakes) w();
}

/**
 * The horizon: a band of light across the top of the stage, behind the title. `y` is its line (0..1 of
 * the height), `up` and `down` how far it reaches above and below it, `x` where it is strongest and
 * `spread` how far it reaches sideways from there.
 */
export interface Horizon {
  x: number;
  y: number;
  up: number;
  down: number;
  spread: number;
  amount: number;
}

export function Field({
  palette,
  amount = 1,
  focusX = 0.58,
  focusY = 1.06,
  spread = 0.62,
  active = false,
  hidden = false,
  waiting = false,
  stage,
  floor = 0,
  alert = false,
  under,
  className,
}: {
  palette: Palette;
  amount?: number;
  focusX?: number;
  focusY?: number;
  spread?: number;
  active?: boolean;
  /** Covered by another screen: draws nothing (not even on a resize) until it shows again. */
  hidden?: boolean;
  /** Waiting on you: amber, still. */
  waiting?: boolean;
  /** Home's stage: a second gather at the top edge, and the light breathes while awake. */
  stage?: Horizon;
  /** A sparse floor of cells under the whole page (0: none). */
  floor?: number;
  /** Something waits on you: the horizon is amber. */
  alert?: boolean;
  /**
   * The prompt bar (a selector in the field's screen): the foot's light lives only under the bar's
   * top edge (2.21), so the bar lies over the list with nothing between them; the glass shows it frosted.
   */
  under?: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ palette, amount, active, focusX, focusY, spread, hidden, waiting, stage, floor, alert, under });
  live.current = { palette, amount, active, focusX, focusY, spread, hidden, waiting, stage, floor, alert, under };
  const stageKey = stage ? `${stage.x}|${stage.y}|${stage.up}|${stage.down}|${stage.spread}|${stage.amount}` : '';
  const api = useRef<{ kick: () => void; reshape: () => void } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The stage is seen whole, so its cells are finer; it draws only the rows its light reaches (`lit`).
    const CELL = live.current.stage ? 2 : 3;
    // Rows that can show light, as [from, to) ranges: the rest of the canvas is never touched.
    let lit: [number, number][] = [];
    // The whole image goes to the canvas once after the shape changed (rows that went dark are cleared).
    let whole = true;
    let frame = 0;
    let touching = false;
    let cols = 0;
    let rows = 0;
    let base = new Float32Array(0);
    // The grain under each cell (0..1), and the light it may take at the most (the reading column is spared).
    let flow = new Float32Array(0);
    // The horizon's share of each cell (stage only).
    let high = new Float32Array(0);
    let img: ImageData | null = null;
    // The drift's own clock: it runs only while frames are drawn, quicker while a turn runs.
    let phase = 0;
    let lastDraw = 0;
    let awakeUntil = 0;
    let beat: (Beat & { nx: number; ny: number }) | null = null;
    let timer = 0;
    let raf = 0;
    let box = { left: 0, top: 0, width: 1, height: 1 };
    const t0 = performance.now();
    // The first row of the foot's light (the bar's top edge and a little): nothing of it above (2.21).
    let cutRow = 0;
    const barOf = () => (live.current.under ? (canvas.parentElement?.querySelector<HTMLElement>(live.current.under) ?? null) : null);
    const cutOf = () => {
      const bar = barOf();
      const host = canvas.parentElement;
      if (!bar || !host) return 0;
      // Its place in the layout (a lift by the keyboard is a transform and does not count).
      let top = 0;
      for (let el: HTMLElement | null = bar; el && el !== host; el = el.offsetParent as HTMLElement | null) top += el.offsetTop;
      return Math.max(0, Math.floor((top + 20) / CELL));
    };

    const shape = () => {
      const { focusX: fx, focusY: fy, spread: sp } = live.current;
      cutRow = cutOf();
      const aspect = rows / Math.max(1, cols);
      // A phone on its side: the light stays a pool at the foot, as tall as in portrait, never a wash
      // over the whole conversation (its distances were measured against the short height).
      const wide = cols > rows ? (cols / rows) ** 1.5 : 1;
      for (let y = 0; y < rows; y++) {
        const ny = y / rows;
        for (let x = 0; x < cols; x++) {
          const dx = (x / cols - fx) * 1.1;
          const dy = (ny - fy) * aspect;
          const d = (Math.sqrt(dx * dx + dy * dy) / sp) * wide;
          const i = y * cols + x;
          base[i] = y < cutRow ? 0 : Math.max(0, 1 - d) ** 1.6;
          // two octaves of the grain, in square units (the bands keep their shape on any screen)
          const u = x / cols;
          const v = ny * aspect;
          flow[i] = 0.68 * noise2(u * 2.6 + 3.1, v * 2.6 + 7.7) + 0.32 * noise2(u * 6.3 + 11.4, v * 6.3 + 1.9);
        }
      }
      const st = live.current.stage;
      whole = true;
      if (!st) {
        // A chat's light gathers at its foot: its drift draws only the rows any light reaches (a beat,
        // which can reach every row, draws them all; the image is cleared once it has passed).
        lit = [];
        if (live.current.floor > 0) lit.push([0, rows]);
        else
          for (let y = 0; y < rows; y++) {
            let on = false;
            for (let x = 0, i = y * cols; x < cols && !on; x++, i++) on = base[i] > 0;
            if (!on) continue;
            const last = lit[lit.length - 1];
            if (last && y - last[1] < 6) last[1] = y + 1;
            else lit.push([y, y + 1]);
          }
        img?.data.fill(0);
        return;
      }
      img?.data.fill(0);
      // The far tail of the lower light would be a few lonely cells over half the page: cut.
      for (let i = 0; i < base.length; i++) base[i] = Math.max(0, base[i] - 0.04);
      // The horizon: a band that falls off quickly above its line (the status bar and the tools stay
      // clear) and slowly below it, strongest on its own side.
      for (let y = 0; y < rows; y++) {
        const ny = y / rows;
        const v = (ny - st.y) / (ny < st.y ? st.up : st.down);
        const band = Math.exp(-v * v);
        for (let x = 0; x < cols; x++) {
          const side = Math.max(0, 1 - Math.abs(x / cols - st.x) / st.spread);
          high[y * cols + x] = band < 0.03 ? 0 : (band - 0.03) * side ** 1.3 * st.amount;
        }
      }
      // The rows a cell of which can light up at the light's strongest (a swell, a breath).
      const amt = live.current.amount;
      lit = [];
      for (let y = 0; y < rows; y++) {
        let on = false;
        for (let x = 0, i = y * cols; x < cols && !on; x++, i++) on = base[i] * amt + high[i] > 0.005;
        if (!on) continue;
        const last = lit[lit.length - 1];
        if (last && y - last[1] < 6) last[1] = y + 1;
        else lit.push([y, y + 1]);
      }
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      box = { left: r.left, top: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
      cols = Math.max(1, Math.ceil(r.width / CELL));
      rows = Math.max(1, Math.ceil(r.height / CELL));
      canvas.width = cols;
      canvas.height = rows;
      img = ctx.createImageData(cols, rows);
      base = new Float32Array(cols * rows);
      flow = new Float32Array(cols * rows);
      high = new Float32Array(live.current.stage ? cols * rows : 0);
      shape();
    };

    const draw = () => {
      // Hidden: skipped; showing again kicks a fresh frame (the effect on `hidden` below).
      if (!img || live.current.hidden) return;
      const { amount: amt, waiting, stage, floor, alert, active } = live.current;
      const stops = PALETTES[waiting ? 'amber' : live.current.palette];
      const topStops = alert ? PALETTES.amber : stops;
      const now = performance.now();
      // The stage's drift has its own clock (it does not jump after a rest); a turn at work quickens it.
      if (stage && !reduced) phase += Math.min(0.25, (now - (lastDraw || now)) / 1000) * (active ? 2.1 : 1);
      lastDraw = now;
      // Waiting stills the drift where it is.
      const t = reduced || waiting ? 0 : stage ? phase : (now - t0) / 1000;
      // The stage breathes: the whole light swells and eases, slowly.
      const breath = stage && !reduced ? 1 + 0.07 * Math.sin(phase * 0.8) : 1;
      const hasHigh = !!stage && high.length === cols * rows;
      const data = img.data;
      const ca = Math.cos(0.61);
      const sa = Math.sin(0.61);
      const aspect = rows / Math.max(1, cols);
      let wave = 0;
      let waveR = 0;
      let swell = 1;
      let kind: BeatKind | null = null;
      let bx = 0.5;
      let by = 1;
      if (beat) {
        const life = LIFE[beat.kind];
        const age = (now - beat.at) / 1000;
        if (age > life) {
          beat = null;
          // A chat's beat lit rows its drift does not draw: cleared, then the whole image goes once.
          if (!stage) {
            data.fill(0);
            whole = true;
          }
        }
        else {
          kind = beat.kind;
          bx = beat.nx;
          by = beat.ny;
          const k = age / life;
          if (kind === 'send') {
            waveR = age * 1.45;
            wave = (1 - k) * 0.7;
          } else if (kind === 'pulse') {
            waveR = age * 1.2;
            wave = (1 - k) * 0.45;
          } else if (kind === 'done') {
            // A ring closes in on the point, then the light exhales.
            waveR = Math.max(0, 0.9 - age * 1.25);
            wave = k < 0.6 ? 0.5 * Math.sin((k / 0.6) * Math.PI * 0.5 + 0.2) : 0;
            swell = 1 + (k > 0.55 ? 0.35 * Math.sin(((k - 0.55) / 0.45) * Math.PI) : 0);
          } else if (kind === 'open') {
            swell = 0.35 + 0.65 * (1 - (1 - k) ** 3);
          } else if (kind === 'fail') {
            // The light dips at once and comes back slowly (the desktop's `fail`): no wave, no colour.
            swell = k < 0.18 ? 1 - 0.75 * (k / 0.18) : 0.25 + 0.75 * (1 - (1 - (k - 0.18) / 0.82) ** 2);
          }
        }
      }
      // A chat's beat may reach any row; otherwise only the rows the light reaches.
      const all = !!wave && !stage;
      for (const [y0, y1] of all ? [[0, rows] as [number, number]] : lit)
      for (let y = y0; y < y1; y++) {
        const ny = y / rows;
        // Above the bar a chat draws nothing, not even a beat (the bar lies over the conversation).
        if (!stage && y < cutRow) {
          for (let x = 0, i = y * cols; x < cols; x++, i++) data[i * 4 + 3] = 0;
          continue;
        }
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          let b = base[i];
          const h = hasHigh ? high[i] : 0;
          const bay = BAYER[(y & 3) * 4 + (x & 3)];
          // Too dark to light this cell whatever the streaks do: nothing to work out (most of the page).
          // (On the stage a wave only moves the light that is there, so this holds during a beat too.)
          if ((!wave || stage) && (b * amt + h + floor) * (wave ? 7.5 : 4.8) + bay < 1) {
            data[i * 4 + 3] = 0;
            continue;
          }
          const nx = x / cols;
          const u = nx * ca + ny * sa;
          // (the stage's streaks are softer: it is looked at, not only glimpsed under a list)
          // Slow currents, as the desktop's field: diagonal bands bent by the grain, thin where the grain is
          // low (2.18; the old two crossed sines read as stripes on a blob).
          const g = flow[i];
          const band = 0.5 + 0.5 * Math.sin(u * (stage ? 9 : 12) + g * 5.4 - t * 0.3);
          const streak = (0.1 + 0.9 * band * band * Math.sqrt(band)) * (0.4 + 1.15 * g);
          // The horizon leads here: its palette (amber while something waits on you).
          const top = h > b * amt;
          b = (b * amt + h) * streak * swell * breath + floor * (0.35 + streak);
          if (wave) {
            const dx = nx - bx;
            const dy = (ny - by) * aspect;
            const d = Math.sqrt(dx * dx + dy * dy);
            const crest = Math.exp(-(((d - waveR) / 0.055) ** 2));
            // A trough just inside the crest: the pattern seems to bend as it passes.
            const trough = kind === 'send' ? Math.exp(-(((d - waveR + 0.09) / 0.05) ** 2)) * 0.45 : 0;
            // Low on the screen it is strong; it thins as it rises (never over what you read).
            // On the stage a beat is seen wherever it happens (the page is cards over the field), a little softer.
            const low = stage ? 0.78 : kind === 'pulse' ? 1 - ny * 0.6 : Math.max(0, (ny - 0.4) / 0.6);
            b += (crest - trough) * wave * (stage ? (base[i] * amt + h) * 1.7 : 0.25 + base[i]) * low * low;
          }
          const level = b * 3 + bay - 0.5;
          const k = Math.min(3, Math.floor(level + 0.5));
          if (k <= 0) {
            data[i * 4 + 3] = 0;
            continue;
          }
          const c = (top ? topStops : stops)[k - 1];
          data[i * 4] = c[0];
          data[i * 4 + 1] = c[1];
          data[i * 4 + 2] = c[2];
          data[i * 4 + 3] = 255;
        }
      }
      if (whole || all) ctx.putImageData(img, 0, 0);
      else for (const [y0, y1] of lit) ctx.putImageData(img, 0, 0, 0, y0, cols, y1 - y0);
      whole = false;
    };

    const loop = () => {
      raf = 0;
      // Off screen nothing is drawn (lib/screen.ts: the page may be held visible there while a chat works).
      if (!onScreen()) return;
      const onStage = !!live.current.stage;
      const host = canvas.parentElement;
      // The stage holds its frame while the page under it scrolls, a finger is down or the keyboard is
      // up (those have the frames), and draws a beat on every other frame.
      const held = onStage && (beat ? ++frame % 2 === 1 : touching || !!host?.hasAttribute('data-moving') || !!host?.querySelector('.home-dock[data-focus]'));
      if (!held || whole) draw();
      if (beat) {
        raf = requestAnimationFrame(loop);
        return;
      }
      const awake = onStage && performance.now() < awakeUntil;
      if ((live.current.active || awake) && !live.current.waiting && !live.current.hidden && !reduced && !lowPower)
        timer = window.setTimeout(
          () => {
            timer = 0;
            raf = requestAnimationFrame(loop);
          },
          onStage ? 160 : 125,
        );
    };
    const kick = () => {
      clearTimeout(timer);
      timer = 0;
      if (!raf) raf = requestAnimationFrame(loop);
    };
    api.current = {
      kick,
      reshape: () => {
        shape();
        kick();
      },
    };

    resize();
    draw();
    // Its first report is the size just drawn (a second shaping and drawing in the chat's opening task): only a new size draws again.
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      if (Math.ceil(r.width / CELL) === cols && Math.ceil(r.height / CELL) === rows) {
        box = { left: r.left, top: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
        return;
      }
      resize();
      draw();
    });
    ro.observe(canvas);
    // The bar grows (a second line, its chips) or shrinks: the light's top edge follows it.
    const bar = barOf();
    const barRo = bar
      ? new ResizeObserver(() => {
          if (cutOf() !== cutRow) {
            shape();
            kick();
          }
        })
      : null;
    if (bar) barRo!.observe(bar);
    const onBeat = (b: Beat) => {
      if (reduced || live.current.hidden) return;
      const r = canvas.getBoundingClientRect();
      box = { left: r.left, top: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
      const nx = b.x === undefined ? 0.5 : (b.x - box.left) / box.width;
      const ny = b.y === undefined ? (b.kind === 'pulse' ? 0 : 1) : (b.y - box.top) / box.height;
      beat = { ...b, nx, ny };
      kick();
    };
    beats.add(onBeat);
    const onWake = () => {
      if (!live.current.stage || live.current.hidden || reduced) return;
      const resting = !timer && !raf;
      awakeUntil = performance.now() + AWAKE_MS;
      if (resting) kick();
    };
    wakes.add(onWake);
    // A finger on the stage's screen: the drift waits until it lifts.
    const host = live.current.stage ? canvas.parentElement : null;
    const onDown = () => (touching = true);
    const onUp = () => (touching = false);
    host?.addEventListener('pointerdown', onDown, { passive: true });
    host?.addEventListener('pointerup', onUp, { passive: true });
    host?.addEventListener('pointercancel', onUp, { passive: true });
    if (live.current.stage) awakeUntil = performance.now() + AWAKE_MS;
    const offScreen = onScreenChange((on) => on && kick());
    return () => {
      ro.disconnect();
      barRo?.disconnect();
      beats.delete(onBeat);
      wakes.delete(onWake);
      host?.removeEventListener('pointerdown', onDown);
      host?.removeEventListener('pointerup', onUp);
      host?.removeEventListener('pointercancel', onUp);
      offScreen();
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      api.current = null;
    };
  }, []);

  useEffect(() => {
    api.current?.kick();
  }, [palette, amount, active, hidden, waiting, floor, alert]);
  useEffect(() => {
    api.current?.reshape();
  }, [focusX, focusY, spread, stageKey]);

  return <canvas ref={ref} className={`field ${className ?? ''}`} aria-hidden />;
}
