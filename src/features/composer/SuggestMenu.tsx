import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/icons';
import { highlightRuns } from '@/lib/fuzzy';
import { play, spring } from '@/lib/motion';
import { byKeys, useSlidePill } from '@/ui';
import type { SuggestRow } from './commands';

function Lit({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices?.length) return <>{text}</>;
  return (
    <>
      {highlightRuns(text, indices).map((r, i) =>
        r.hit ? (
          <mark key={i} className="sg-hit">
            {r.text}
          </mark>
        ) : (
          <Fragment key={i}>{r.text}</Fragment>
        ),
      )}
    </>
  );
}

/** Opening: about 175 ms to the peak, 3 % overshoot, settled by about 320 ms (rec 1). */
const OPEN = spring(700, 40);
/** Filtering: the height springs with a little life (about 12 %), rows glide to their new places. */
const RESIZE = spring(550, 30);
const SLIDE = spring(520, 38);

/**
 * The typeahead list for "/", "@" and "$". Purely presentational: the composer keeps
 * focus in its textarea and drives the active row (aria-activedescendant).
 */
export function SuggestMenu({
  id,
  anchor,
  rows,
  active,
  placement,
  originX,
  empty,
  loading,
  onHover,
  onPick,
}: {
  id: string;
  /** The composer card: the menu matches its left edge and width, and opens from its edge. */
  anchor: RefObject<HTMLElement | null>;
  rows: SuggestRow[];
  active: number;
  placement: 'up' | 'down';
  /** Where the trigger character sits, from the card's left edge (CSS px): the menu grows out of it. */
  originX: number;
  empty: string;
  loading?: boolean;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const opened = useRef(false);
  const tops = useRef(new Map<string, number>());
  const height = useRef(0);

  // Portalled (so its glass blurs what is really behind it) and pinned to the card.
  useLayoutEffect(() => {
    const el = anchor.current;
    if (!el) return;
    const place = () => {
      // Measured in screen pixels; the menu lives under the zoomed root (Interface size), so convert back.
      const z = parseFloat(document.documentElement.style.zoom) || 1;
      const b = el.getBoundingClientRect();
      const r = { left: b.left / z, top: b.top / z, bottom: b.bottom / z, width: b.width / z };
      const vh = window.innerHeight / z;
      const width = Math.min(r.width, 560);
      // Upward it overlaps the card's top edge by 11px, so it reads as part of the composer.
      if (placement === 'up') setStyle({ left: r.left, width, bottom: vh - r.top - 11, maxHeight: Math.max(160, r.top + 11 - 16) });
      // Downward it ends inside the stage (which sits 10px in from the window), never on its edge.
      else setStyle({ left: r.left, width, top: r.bottom + 6, maxHeight: Math.max(160, vh - r.bottom - 26) });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor, placement]);

  // Opening grows out of the caret's corner as a clip: from about 55 % of the width and 15 % of the
  // height, with the opacity in over 70 ms. The rows keep their size throughout.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || style.visibility === 'hidden' || opened.current) return;
    opened.current = true;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const startW = Math.min(w, Math.max(150, w * 0.42));
    const l = Math.max(0, Math.min(w - startW, originX - 10));
    const r = Math.max(0, w - l - startW);
    const strip = Math.max(0, h - Math.max(28, h * 0.15));
    const from = placement === 'up' ? `inset(${strip}px ${r}px 0px ${l}px round 12px)` : `inset(0px ${r}px ${strip}px ${l}px round 12px)`;
    play(el, [{ clipPath: from }, { clipPath: 'inset(0px 0px 0px 0px round 16px)' }], { duration: OPEN.duration, easing: OPEN.easing });
    play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 70, easing: 'linear' });
  }, [style, originX, placement]);

  // Filtering: rows that stay glide to their new places, new rows fade in, the height springs.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const next = new Map<string, number>();
    const prev = tops.current;
    const els = el.querySelectorAll<HTMLElement>('[data-rid]');
    for (const r of els) next.set(r.dataset.rid!, r.offsetTop);
    const h = el.offsetHeight;
    if (opened.current && prev.size) {
      for (const r of els) {
        const was = prev.get(r.dataset.rid!);
        const now = next.get(r.dataset.rid!)!;
        if (was === undefined) play(r, [{ opacity: 0, transform: 'scaleY(0.6)' }, { opacity: 1, transform: 'none' }], { duration: 120, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
        else if (Math.abs(was - now) > 0.5 && Math.abs(was - now) < 400) play(r, [{ transform: `translateY(${was - now}px)` }, { transform: 'none' }], { duration: SLIDE.duration, easing: SLIDE.easing });
      }
      if (height.current && Math.abs(height.current - h) > 1) play(el, [{ height: `${height.current}px` }, { height: `${h}px` }], { duration: RESIZE.duration, easing: RESIZE.easing });
    }
    tops.current = next;
    height.current = h;
  }, [rows]);

  // The row under the pointer: hovering a row that is half out of view must not scroll the list
  // under the pointer (only the keyboard brings the active row into view).
  const hovered = useRef(-1);
  useEffect(() => {
    if (active === hovered.current) return;
    hovered.current = -1;
    const box = list.current;
    // The first row brings its group's heading back into view too.
    if (active === 0 && box) box.scrollTop = 0;
    else box?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, rows]);

  // One selection pill that travels between rows for arrow keys and lands under the pointer at once.
  const pill = useSlidePill(rows[active]?.id ?? null, 12, byKeys);

  return createPortal(
    <div ref={box} className="sg pop" data-spot data-placement={placement} style={style} onMouseDown={(e) => e.preventDefault()}>
      <div className="sg-list scroll" ref={list} role="listbox" id={id} aria-label="Suggestions" style={{ maxHeight: `min(306px, ${typeof style.maxHeight === 'number' ? style.maxHeight - 10 : 306}px)` }}>
        {rows.length === 0 && <div className="sg-empty">{loading ? 'Searching…' : empty}</div>}
        {rows.map((r, i) => {
          const head = r.group && r.group !== rows[i - 1]?.group;
          return (
            <Fragment key={r.id}>
              {head && (
                <div className="sg-group" role="presentation" data-rid={`g:${r.group}`}>
                  {r.group}
                </div>
              )}
              <div
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                data-rid={r.id}
                data-active={i === active || undefined}
                data-kind={r.kind}
                className="sg-row"
                onMouseMove={() => {
                  if (i === active) return;
                  hovered.current = i;
                  onHover(i);
                }}
                onClick={() => onPick(i)}
              >
                {i === active && <span ref={pill} className="sg-pill dither-sel" aria-hidden />}
                {r.icon && (
                  <span className="sg-icon" aria-hidden>
                    <Icon name={r.icon} size={16} />
                  </span>
                )}
                <span className="sg-main">
                  <span className="sg-label">
                    <Lit text={r.label} indices={r.indices} />
                    {r.kind === 'dir' && <span className="sg-slash">/</span>}
                  </span>
                  {r.hint && <span className="sg-hint">{r.hint}</span>}
                  {/* Where a file is: its folder, dim, right after the name (elided from its start). */}
                  {r.detail && (r.kind === 'file' || r.kind === 'dir') && <span className="sg-dir">{r.detail}</span>}
                </span>
                {/* A command's or skill's description shows on the active row only. */}
                {r.detail && r.kind !== 'file' && r.kind !== 'dir' && (
                  <span className="sg-detail" data-desc>
                    {r.detail}
                  </span>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
