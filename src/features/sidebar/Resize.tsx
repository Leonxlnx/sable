import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const WIDTH_KEY = 'sable.sidebar.w';
export const SIDE_DEFAULT_W = 268;
export const SIDE_MIN_W = 196;
export const SIDE_MAX_W = 460;
/** What the stage keeps beside the sidebar, whatever was chosen in a wider window (at a 900 px
    window the sidebar is 220 px, the conversation keeps its column). */
const STAGE_KEEPS = 680;

export const clampSideWidth = (w: number, max = SIDE_MAX_W) => Math.round(Math.max(SIDE_MIN_W, Math.min(Math.max(SIDE_MIN_W, max), w)));

export function sideRange(width: number, viewport: number) {
  const max = clampSideWidth(viewport - STAGE_KEEPS);
  return { now: clampSideWidth(width, max), max };
}

export function keyWidth(key: string, shift: boolean, range: ReturnType<typeof sideRange>) {
  const step = shift ? 48 : 16;
  if (key === 'ArrowLeft') return clampSideWidth(range.now - step, range.max);
  if (key === 'ArrowRight') return clampSideWidth(range.now + step, range.max);
  if (key === 'Home') return SIDE_MIN_W;
  if (key === 'End') return range.max;
  if (key === 'Enter') return null;
  return undefined;
}

function readWidth(): number | null {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) && v > 0 ? clampSideWidth(v) : null;
  } catch {
    return null;
  }
}

function saveWidth(w: number | null) {
  try {
    if (w === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    /* private mode */
  }
}

/**
 * The chosen width (or the default) goes on .app once (it is inherited: writing it per pointer move
 * would restyle the whole window). It yields in a narrow window so the stage keeps its room, without
 * a listener: the default too, so a 900 px window does not give the sidebar a third of itself.
 */
function applyWidth(w: number | null) {
  const app = document.querySelector<HTMLElement>('.app');
  if (!app) return;
  app.style.setProperty('--sidebar-w', `min(${w ?? SIDE_DEFAULT_W}px, max(${SIDE_MIN_W}px, calc(100 * var(--vw) - ${STAGE_KEEPS}px)))`);
}

const zoom = () => parseFloat(document.documentElement.style.zoom) || 1;

function renderedRange() {
  const z = zoom();
  const side = document.querySelector<HTMLElement>('.app-side');
  const width = side ? side.getBoundingClientRect().width / z : readWidth() ?? SIDE_DEFAULT_W;
  return sideRange(width, window.innerWidth / z);
}

/**
 * Drag the sidebar's right edge to resize it (196 to 460 px), double-click or Enter for the
 * default, arrows to step, Home and End for the ends. Lives in the gap between sidebar and stage.
 */
export function SideResize() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [range, setRange] = useState(renderedRange);

  useLayoutEffect(() => {
    applyWidth(readWidth());
    const app = document.querySelector<HTMLElement>('.app');
    const side = app?.querySelector('.app-side');
    setHost(app);
    const measure = () => {
      const next = renderedRange();
      setRange(prev => prev.now === next.now && prev.max === next.max ? prev : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (app) observer.observe(app);
    if (side) observer.observe(side);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  const commit = useCallback((w: number | null) => {
    applyWidth(w);
    saveWidth(w);
  }, []);

  // A drag that ends outside the window, or an unmount mid-drag, must not leave the cursor behind.
  useEffect(() => () => void delete document.documentElement.dataset.sideResizing, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = e.currentTarget;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* a pointer that is already gone: the drag still ends on its own events */
      }
      const side = document.querySelector<HTMLElement>('.app-side');
      const inner = side?.firstElementChild as HTMLElement | null;
      if (!side || !inner) return;
      // Pointer and box positions are screen pixels; widths are CSS pixels under the Interface size zoom.
      const z = zoom();
      const startW = side.getBoundingClientRect().width / z;
      const startX = e.clientX;
      const { max } = sideRange(startW, window.innerWidth / z);
      let w = startW;
      let moved = false;
      setDragging(true);
      document.documentElement.dataset.sideResizing = '';
      const move = (ev: PointerEvent) => {
        const next = clampSideWidth(startW + (ev.clientX - startX) / z, max);
        if (next === w && moved) return;
        moved = true;
        w = next;
        const px = `${w}px`;
        // Only the boxes that use the width, inline: the variable itself is written once, on release.
        side.style.width = px;
        inner.style.width = px;
        el.style.left = `calc(var(--gap) + ${px})`;
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        if (moved) commit(clampSideWidth(w));
        side.style.removeProperty('width');
        inner.style.removeProperty('width');
        el.style.removeProperty('left');
        // Settle at the final width before the width transition comes back (a release in the
        // same frame as the last move would otherwise ease the last few pixels).
        void side.offsetWidth;
        delete document.documentElement.dataset.sideResizing;
        setDragging(false);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    },
    [commit],
  );

  const onKey = (e: React.KeyboardEvent) => {
    const next = keyWidth(e.key, e.shiftKey, renderedRange());
    if (next === undefined) return;
    e.preventDefault();
    commit(next);
  };

  if (!host) return null;
  return createPortal(
    <div
      className="side-resize"
      data-dragging={dragging || undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDE_MIN_W}
      aria-valuemax={range.max}
      aria-valuenow={range.now}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => commit(null)}
      onKeyDown={onKey}
    />,
    host,
  );
}
