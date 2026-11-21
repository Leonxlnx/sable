import { useEffect, useRef } from 'react';
import type { ProviderId } from '@shared/protocol';

/**
 * The dither field behind home and chats, as on the desktop: light that gathers at the lower edge,
 * soft diagonal streaks, a 4x4 ordered dither in the agent's palette. Battery first: one still
 * frame at rest, a slow drift (8 fps) only while a turn runs on screen, one-shot beats (a wave from
 * the send key, a ring that closes when a turn is done, a pulse), nothing at all while the app is
 * hidden or under reduced motion. Waiting on you, it stills in amber.
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

export type BeatKind = 'send' | 'done' | 'pulse' | 'open';
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

const LIFE: Record<BeatKind, number> = { send: 1.15, done: 1.3, pulse: 1.0, open: 0.9 };

export function Field({
  palette,
  amount = 1,
  focusX = 0.58,
  focusY = 1.06,
  spread = 0.62,
  active = false,
  hidden = false,
  waiting = false,
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
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ palette, amount, active, focusX, focusY, spread, hidden, waiting });
  live.current = { palette, amount, active, focusX, focusY, spread, hidden, waiting };
  const api = useRef<{ kick: () => void; reshape: () => void } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const CELL = 3;
    let cols = 0;
    let rows = 0;
    let base = new Float32Array(0);
    let img: ImageData | null = null;
    let beat: (Beat & { nx: number; ny: number }) | null = null;
    let timer = 0;
    let raf = 0;
    let box = { left: 0, top: 0, width: 1, height: 1 };
    const t0 = performance.now();

    const shape = () => {
      const { focusX: fx, focusY: fy, spread: sp } = live.current;
      const aspect = rows / Math.max(1, cols);
      for (let y = 0; y < rows; y++) {
        const ny = y / rows;
        for (let x = 0; x < cols; x++) {
          const dx = (x / cols - fx) * 1.1;
          const dy = (ny - fy) * aspect;
          const d = Math.sqrt(dx * dx + dy * dy) / sp;
          base[y * cols + x] = Math.max(0, 1 - d) ** 1.6;
        }
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
      shape();
    };

    const draw = () => {
      // Hidden: skipped; showing again kicks a fresh frame (the effect on `hidden` below).
      if (!img || live.current.hidden) return;
      const { amount: amt, waiting } = live.current;
      const stops = PALETTES[waiting ? 'amber' : live.current.palette];
      const now = performance.now();
      // Waiting stills the drift where it is.
      const t = reduced || waiting ? 0 : (now - t0) / 1000;
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
        if (age > life) beat = null;
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
          }
        }
      }
      for (let y = 0; y < rows; y++) {
        const ny = y / rows;
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          let b = base[i];
          if (b <= 0.002 && !wave) {
            data[i * 4 + 3] = 0;
            continue;
          }
          const nx = x / cols;
          const u = nx * ca + ny * sa;
          const streak = 0.62 + 0.38 * Math.sin(u * 22 + t * 0.35) * Math.sin(u * 7.3 - t * 0.12 + ny * 2.1);
          b *= streak * amt * swell;
          if (wave) {
            const dx = nx - bx;
            const dy = (ny - by) * aspect;
            const d = Math.sqrt(dx * dx + dy * dy);
            const crest = Math.exp(-(((d - waveR) / 0.055) ** 2));
            // A trough just inside the crest: the pattern seems to bend as it passes.
            const trough = kind === 'send' ? Math.exp(-(((d - waveR + 0.09) / 0.05) ** 2)) * 0.45 : 0;
            // Low on the screen it is strong; it thins as it rises (never over what you read).
            const low = kind === 'pulse' ? 1 - ny * 0.6 : Math.max(0, (ny - 0.4) / 0.6);
            b += (crest - trough) * wave * (0.25 + base[i]) * low * low;
          }
          const level = b * 3 + BAYER[(y & 3) * 4 + (x & 3)] - 0.5;
          const k = Math.min(3, Math.floor(level + 0.5));
          if (k <= 0) {
            data[i * 4 + 3] = 0;
            continue;
          }
          const c = stops[k - 1];
          data[i * 4] = c[0];
          data[i * 4 + 1] = c[1];
          data[i * 4 + 2] = c[2];
          data[i * 4 + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    const loop = () => {
      raf = 0;
      if (document.hidden) return;
      draw();
      if (beat) {
        raf = requestAnimationFrame(loop);
        return;
      }
      if (live.current.active && !live.current.waiting && !reduced) timer = window.setTimeout(() => (raf = requestAnimationFrame(loop)), 125);
    };
    const kick = () => {
      clearTimeout(timer);
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
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(canvas);
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
    const onVis = () => !document.hidden && kick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      ro.disconnect();
      beats.delete(onBeat);
      document.removeEventListener('visibilitychange', onVis);
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      api.current = null;
    };
  }, []);

  useEffect(() => {
    api.current?.kick();
  }, [palette, amount, active, hidden, waiting]);
  useEffect(() => {
    api.current?.reshape();
  }, [focusX, focusY, spread]);

  return <canvas ref={ref} className={`field ${className ?? ''}`} aria-hidden />;
}
