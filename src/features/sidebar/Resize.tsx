import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const WIDTH_KEY = 'sable.sidebar.w';
export const SIDE_DEFAULT_W = 268;
export const SIDE_MIN_W = 196;
export const SIDE_MAX_W = 460;
/** What the stage keeps beside the sidebar, whatever was chosen in a wider window. */
const STAGE_KEEPS = 620;

export const clampSideWidth = (w: number, max = SIDE_MAX_W) => Math.round(Math.max(SIDE_MIN_W, Math.min(Math.max(SIDE_MIN_W, max), w)));

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
 * The chosen width goes on .app once (it is inherited: writing it per pointer move would restyle
 * the whole window). It yields in a narrow window so the stage keeps its room, without a listener.
 */
function applyWidth(w: number | null) {
  const app = document.querySelector<HTMLElement>('.app');
  if (!app) return;
  if (w === null) app.style.removeProperty('--sidebar-w');
  else app.style.setProperty('--sidebar-w', `min(${w}px, max(${SIDE_MIN_W}px, calc(100 * var(--vw) - ${STAGE_KEEPS}px)))`);
}

const zoom = () => parseFloat(document.documentElement.style.zoom) || 1;

/**
 * Drag the sidebar's right edge to resize it (196 to 460 px), double-click or Enter for the
 * default, arrows to step, Home and End for the ends. Lives in the gap between sidebar and stage.
 */
export function SideResize() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState<number>(() => readWidth() ?? SIDE_DEFAULT_W);

  useLayoutEffect(() => {
    applyWidth(readWidth());
    setHost(document.querySelector<HTMLElement>('.app'));
  }, []);

  const commit = useCallback((w: number | null) => {
    applyWidth(w);
    saveWidth(w);
    setWidth(w ?? SIDE_DEFAULT_W);
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
      const max = Math.min(SIDE_MAX_W, window.innerWidth / z - STAGE_KEEPS);
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
    const step = e.shiftKey ? 48 : 16;
    let next: number | null;
    if (e.key === 'ArrowLeft') next = clampSideWidth(width - step);
    else if (e.key === 'ArrowRight') next = clampSideWidth(width + step);
    else if (e.key === 'Home') next = SIDE_MIN_W;
    else if (e.key === 'End') next = SIDE_MAX_W;
    else if (e.key === 'Enter') next = null;
    else return;
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
      aria-valuemax={SIDE_MAX_W}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => commit(null)}
      onKeyDown={onKey}
    />,
    host,
  );
}
