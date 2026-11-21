import { animate } from 'motion';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { pushBack } from '@m/lib/back';
import { haptic } from '@m/lib/native';
import { Icon } from './icons';
import { reduced } from './motion';

/**
 * A picture full screen (a step's screenshot): it grows out of its thumbnail, pinch to zoom (about
 * the fingers), drag to look around, double tap to zoom in or out, at rest drag it down to close
 * (or Back). Several pictures: swipe sideways. Transform only; the pictures come as data URLs.
 */

interface Open {
  /** The pictures, by index (null: still loading). */
  srcs: (string | null)[];
  index: number;
  /** The thumbnail it came from (it grows out of it and goes back into it). */
  from?: DOMRect;
}

let open: Open | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((l) => l());

export function openViewer(v: Open) {
  open = v;
  emit();
}

/** A picture that arrived after the viewer opened. */
export function viewerLoaded(index: number, src: string) {
  if (!open || open.srcs[index] === src) return;
  const srcs = [...open.srcs];
  srcs[index] = src;
  open = { ...open, srcs };
  emit();
}

const close = () => {
  open = null;
  emit();
};

export function Viewer() {
  const v = useSyncExternalStore(
    (l) => (subs.add(l), () => void subs.delete(l)),
    () => open,
  );
  if (!v) return null;
  return createPortal(<Stage v={v} />, document.body);
}

const MAX = 5;

function Stage({ v }: { v: Open }) {
  const [index, setIndex] = useState(v.index);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const src = v.srcs[index] ?? null;
  const n = v.srcs.length;

  useEffect(() => pushBack(() => (leave(), true)), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the picture sits at rest (contained in the screen), and the transform on top of it.
  const t = useRef({ s: 1, x: 0, y: 0 });
  const fit = () => {
    const W = innerWidth;
    const H = innerHeight;
    if (!size) return { left: 0, top: 0, w: W, h: H };
    const k = Math.min(W / size.w, H / size.h);
    const w = size.w * k;
    const h = size.h * k;
    return { left: (W - w) / 2, top: (H - h) / 2, w, h };
  };
  const paint = (fade?: number) => {
    const el = img.current;
    if (!el) return;
    const { s, x, y } = t.current;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${s.toFixed(4)})`;
    if (fade !== undefined && scrim.current) {
      scrim.current.style.opacity = String(fade);
      if (bar.current) bar.current.style.opacity = String(fade);
    }
  };
  const running = useRef<{ stop: () => void } | null>(null);
  const tween = (to: { s: number; x: number; y: number }, fadeTo?: number, done?: () => void) => {
    running.current?.stop();
    const from = { ...t.current };
    const f0 = scrim.current ? Number(scrim.current.style.opacity || 1) : 1;
    running.current = animate(0, 1, {
      type: 'spring',
      stiffness: 420,
      damping: 40,
      restDelta: 0.001,
      onUpdate: (p) => {
        t.current = { s: from.s + (to.s - from.s) * p, x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p };
        paint(fadeTo === undefined ? undefined : f0 + (fadeTo - f0) * p);
      },
      onComplete: done,
    });
  };

  // Into its thumbnail again (or a fade when that is gone), then closed.
  const leave = () => {
    const f = fit();
    const r = v.from;
    if (reduced() || !r || index !== v.index) {
      running.current?.stop();
      const el = img.current?.parentElement;
      if (!el) return close();
      void animate(el, { opacity: [1, 0] }, { duration: 0.16 }).finished.then(close);
      return;
    }
    const s = Math.max(r.width / f.w, r.height / f.h);
    tween({ s, x: r.left + r.width / 2 - (f.left + (f.w * s) / 2), y: r.top + r.height / 2 - (f.top + (f.h * s) / 2) }, 0, close);
  };

  // Out of the thumbnail when the picture is known.
  const grown = useRef(false);
  useLayoutEffect(() => {
    if (!size || grown.current) return;
    grown.current = true;
    const f = fit();
    const r = v.from;
    if (!r || reduced()) {
      t.current = { s: 1, x: 0, y: 0 };
      paint(1);
      return;
    }
    const s = Math.max(r.width / f.w, r.height / f.h);
    t.current = { s, x: r.left + r.width / 2 - (f.left + (f.w * s) / 2), y: r.top + r.height / 2 - (f.top + (f.h * s) / 2) };
    paint(0);
    tween({ s: 1, x: 0, y: 0 }, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  // Another picture: at rest again.
  useEffect(() => {
    if (!grown.current) return;
    t.current = { s: 1, x: 0, y: 0 };
    paint(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // The fingers.
  useEffect(() => {
    const host = scrim.current?.parentElement;
    if (!host) return;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; mx: number; my: number; s: number; x: number; y: number } | null = null;
    let pan: { x: number; y: number; tx: number; ty: number; mode: 'pan' | 'maybe' | 'down' | 'side' } | null = null;
    let lastTap = 0;
    let downAt = 0;
    let samples: { t: number; x: number; y: number }[] = [];
    const clampScale = (s: number) => (s < 1 ? 1 - (1 - s) * 0.5 : s > MAX ? MAX + (s - MAX) * 0.2 : s);
    /** The transform kept inside the screen for its scale. */
    const bounded = (s: number, x: number, y: number) => {
      const f = fit();
      const w = f.w * s;
      const h = f.h * s;
      // The picture's own left and top on screen are f.left + x (it scales from its own top left).
      const minX = w > innerWidth ? innerWidth - w - f.left : (innerWidth - w) / 2 - f.left;
      const maxX = w > innerWidth ? -f.left : (innerWidth - w) / 2 - f.left;
      const minY = h > innerHeight ? innerHeight - h - f.top : (innerHeight - h) / 2 - f.top;
      const maxY = h > innerHeight ? -f.top : (innerHeight - h) / 2 - f.top;
      return { s, x: Math.min(maxX, Math.max(minX, x)), y: Math.min(maxY, Math.max(minY, y)) };
    };
    /** Scale to `s` about a point on screen. */
    const about = (s: number, px: number, py: number, from = t.current) => {
      const f = fit();
      const qx = (px - f.left - from.x) / from.s;
      const qy = (py - f.top - from.y) / from.s;
      return { s, x: px - f.left - qx * s, y: py - f.top - qy * s };
    };
    const down = (e: PointerEvent) => {
      running.current?.stop();
      host.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ...t.current };
        pan = null;
      } else if (pts.size === 1) {
        downAt = performance.now();
        pan = { x: e.clientX, y: e.clientY, tx: t.current.x, ty: t.current.y, mode: t.current.s > 1.01 ? 'pan' : 'maybe' };
        samples = [{ t: downAt, x: e.clientX, y: e.clientY }];
      }
    };
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const s = clampScale(pinch.s * (d / Math.max(1, pinch.d)));
        const at = about(s, pinch.mx, pinch.my, pinch);
        t.current = { s, x: at.x + (mx - pinch.mx), y: at.y + (my - pinch.my) };
        paint();
        return;
      }
      if (!pan) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      const now = performance.now();
      samples.push({ t: now, x: e.clientX, y: e.clientY });
      while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
      if (pan.mode === 'maybe') {
        if (Math.hypot(dx, dy) < 8) return;
        pan.mode = Math.abs(dy) > Math.abs(dx) ? 'down' : n > 1 ? 'side' : 'down';
      }
      if (pan.mode === 'pan') {
        running.current?.stop();
        t.current = { ...t.current, x: pan.tx + dx, y: pan.ty + dy };
        paint();
      } else if (pan.mode === 'down') {
        t.current = { s: 1 - Math.min(0.25, Math.max(0, dy) / 1600), x: dx * 0.6, y: dy };
        paint(Math.max(0.2, 1 - Math.abs(dy) / 420));
      } else {
        t.current = { s: 1, x: dx, y: 0 };
        paint();
      }
    };
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pinch) {
        if (pts.size >= 2) return;
        pinch = null;
        const s = Math.min(MAX, Math.max(1, t.current.s));
        const at = s === t.current.s ? t.current : about(s, innerWidth / 2, innerHeight / 2);
        tween(s <= 1.01 ? { s: 1, x: 0, y: 0 } : bounded(s, at.x, at.y));
        // One finger left on the glass pans from here.
        const rest = [...pts.values()][0];
        pan = rest ? { x: rest.x, y: rest.y, tx: t.current.x, ty: t.current.y, mode: 'pan' } : null;
        return;
      }
      const p = pan;
      pan = null;
      if (!p) return;
      const a = samples[0];
      const b = samples[samples.length - 1];
      const vy = a && b && b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0;
      const vx = a && b && b.t > a.t ? ((b.x - a.x) / (b.t - a.t)) * 1000 : 0;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      const now = performance.now();
      if (Math.hypot(dx, dy) < 8 && now - downAt < 300) {
        // A tap (zoomed or not): twice quickly zooms in about the finger, or back out.
        if (now - lastTap < 320) {
          lastTap = 0;
          haptic('select');
          if (t.current.s > 1.05) tween({ s: 1, x: 0, y: 0 });
          else {
            const at = about(2.6, e.clientX, e.clientY);
            tween(bounded(2.6, at.x, at.y));
          }
        } else lastTap = now;
        return;
      }
      if (p.mode === 'pan') {
        const s = t.current.s;
        tween(bounded(s, t.current.x + vx * 0.12, t.current.y + vy * 0.12));
      } else if (p.mode === 'down') {
        if (dy > 120 || vy > 700) {
          haptic('tap');
          leave();
        } else tween({ s: 1, x: 0, y: 0 }, 1);
      } else {
        const go = dx < -80 || vx < -500 ? 1 : dx > 80 || vx > 500 ? -1 : 0;
        const next = index + go;
        if (go && next >= 0 && next < n) {
          haptic('select');
          tween({ s: 1, x: -go * innerWidth, y: 0 }, undefined, () => setIndex(next));
        } else tween({ s: 1, x: 0, y: 0 });
      }
    };
    host.addEventListener('pointerdown', down);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);
    return () => {
      host.removeEventListener('pointerdown', down);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
      host.removeEventListener('pointercancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, index, n]);

  const f = fit();
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label="Picture">
      <div ref={scrim} className="viewer-scrim" style={{ opacity: 0 }} />
      {src ? (
        <img
          ref={img}
          key={index}
          className="viewer-img"
          src={src}
          alt=""
          draggable={false}
          style={{ left: f.left, top: f.top, width: f.w, height: f.h, opacity: size ? 1 : 0 }}
          onLoad={(e) => {
            const el = e.currentTarget;
            if (!size || size.w !== el.naturalWidth || size.h !== el.naturalHeight) setSize({ w: el.naturalWidth || 1, h: el.naturalHeight || 1 });
          }}
        />
      ) : (
        <span className="viewer-wait">
          <span className="skel" />
        </span>
      )}
      <div ref={bar} className="viewer-bar">
        {n > 1 ? <span className="viewer-count num">{`${index + 1} of ${n}`}</span> : <span />}
        <button type="button" className="viewer-close" aria-label="Close" onClick={() => (haptic('tap'), leave())}>
          <Icon name="x" size={18} weight="bold" />
        </button>
      </div>
    </div>
  );
}
