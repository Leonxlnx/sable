import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/icons';
import { quietMarks } from '@/features/palette/Highlight';
import { highlightRuns } from '@/lib/fuzzy';
import { play, spring } from '@/lib/motion';
import { byKeys, useSlidePill } from '@/ui';
import type { SuggestRow } from './commands';

function Lit({ text, indices: all }: { text: string; indices?: number[] }) {
  // Only an unbroken match is marked (the palette's rule): scattered lit letters read as noise.
  const indices = quietMarks(all);
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

/** The narrowest the list is (CSS px): a few short commands still read as a menu, not a tag. */
export const SUGGEST_MIN = 240;
/** The widest it gets, however wide the composer is. */
export const SUGGEST_MAX = 560;

/**
 * The list's width: as wide as its widest row needs (`content`, the menu's padding included),
 * within the card and `SUGGEST_MIN`..`SUGGEST_MAX`; never narrower than it already is while it is
 * open (`was`), so filtering never pulls its edge in under the person's eyes.
 */
export function suggestWidth(content: number, card: number, was = 0): number {
  const most = Math.min(card, SUGGEST_MAX);
  return Math.round(Math.min(most, Math.max(SUGGEST_MIN, content, Math.min(was, most))));
}

/** Its left edge: at the trigger's side (`originX` from the card's left), inside the card. */
export function suggestLeft(cardLeft: number, cardWidth: number, width: number, originX: number): number {
  return cardLeft + Math.max(0, Math.min(cardWidth - width, originX - 18));
}

/** The width a row's content needs (CSS px), read from its parts' own text widths. */
function rowNeed(row: HTMLElement): number {
  let w = 16; // the row's padding
  const icon = row.querySelector<HTMLElement>('.sg-icon');
  if (icon) w += 17 + 10;
  const main = row.querySelector<HTMLElement>('.sg-main');
  if (main) {
    const parts = [...main.children] as HTMLElement[];
    parts.forEach((p, i) => (w += p.scrollWidth + (i ? 8 : 0)));
  }
  return w;
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
  const wide = useRef(0);
  const placeNow = useRef<() => void>(() => {});

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
      // As wide as its rows need (read from the rows laid out now), at the trigger's side.
      const ls = list.current;
      let content = 0;
      if (ls) {
        for (const row of ls.querySelectorAll<HTMLElement>('.sg-row')) content = Math.max(content, rowNeed(row));
        // The menu's padding, and room for its bar when the rows scroll.
        content += 8 + (ls.scrollHeight > ls.clientHeight + 1 ? 10 : 0);
      }
      const width = suggestWidth(content, r.width, wide.current);
      wide.current = width;
      const left = suggestLeft(r.left, r.width, width, originX);
      const next: CSSProperties =
        // Upward it overlaps the card's top edge by 11px, so it reads as part of the composer.
        placement === 'up'
          ? { left, width, bottom: vh - r.top - 11, maxHeight: Math.max(160, r.top + 11 - 16) }
          : // Downward it ends inside the stage (which sits 10px in from the window), never on its edge.
            { left, width, top: r.bottom + 6, maxHeight: Math.max(160, vh - r.bottom - 26) };
      setStyle((was) => (was.left === next.left && was.width === next.width && was.bottom === next.bottom && was.top === next.top && was.maxHeight === next.maxHeight ? was : next));
    };
    placeNow.current = place;
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
    // The trigger's place is read once, when the menu opens: it does not wander while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, placement]);

  // A row wider than the list widens it (never narrower while open).
  useLayoutEffect(() => placeNow.current(), [rows]);

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
          // A heading only where the list holds more than one group: one group needs no name.
          const head = r.group && r.group !== rows[i - 1]?.group && rows.some((o) => o.group && o.group !== r.group);
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
                {/* No descriptions: a command is known by its name (the owner's rule for pickers). */}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
