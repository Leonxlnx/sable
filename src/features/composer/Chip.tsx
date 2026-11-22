import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';
import { EASE_OUT, EASE_STD, play } from '@/lib/motion';

/**
 * A chip whose label changes as one calm motion (the model's name, the effort's word, ultracode's
 * mark, the mode): no word is ever outside its chip, no neighbour jumps, and the first frame after
 * the click already moves.
 *
 * What the chip says is a row of parts, each with a key. When the keys or the widths change:
 * - the layout takes the new size at once (one layout, in the commit that follows the click);
 * - the chip's skin glides from the old width to the new one, and whatever stands on its moving
 *   side (the model's name beside the effort's word) glides with it;
 * - a part that stays where its key stays keeps showing and, if it was pushed, glides too;
 * - a part that left fades out where it stood, a part that arrived fades in where it stands, timed
 *   so that neither is ever beyond the skin's moving end: a chip that grows moves first and its new
 *   word comes in behind the edge; one that shrinks lets its old word go before the edge follows.
 * All of it is transforms and opacity on the compositor (Web Animations, started in the layout
 * effect of that same commit), about 140 ms: nothing is laid out per frame, so the popover that
 * hangs off the chip is not measured again on every frame (that, with a width animated by layout
 * and a word laid out at its new width inside it, was the lag and the word outside the pill).
 *
 * The skin is two doors (composer.css `.chip-skin`): the same long pill drawn twice, one behind a
 * window at the chip's fixed end, one behind a window over the rest; the second slides. Their
 * windows meet on the pill's straight part, so the shape is exact in every frame, hairline
 * included, and nothing is scaled.
 */

export interface ChipPart {
  /** What the part shows. A part with another key is another part: the old one leaves, the new one arrives. */
  k: string;
  node: ReactNode;
  className?: string;
}

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  parts: ChipPart[];
  /** The end that holds still: the other one moves when the label's width changes. */
  anchor: 'left' | 'right';
  /** Rendered as a span (a chip that only shows a value). */
  still?: boolean;
}

interface Ghost {
  k: string;
  node: ReactNode;
  className?: string;
  at: number;
}

interface Measure {
  width: number;
  /** Each part's distance from the chip's fixed end. */
  at: Map<string, number>;
}

const SKIN = (
  <span className="chip-skin" aria-hidden>
    <i className="cs-fix">
      <i />
    </i>
    <i className="cs-move">
      <i />
    </i>
  </span>
);

const sigOf = (parts: ChipPart[]) => parts.map((p) => p.k).join('\u0001');

function measure(el: HTMLElement, anchor: 'left' | 'right'): Measure {
  const width = el.offsetWidth;
  const at = new Map<string, number>();
  for (const c of el.children) {
    const k = (c as HTMLElement).dataset.k;
    if (k === undefined || (c as HTMLElement).dataset.ghost !== undefined) continue;
    const part = c as HTMLElement;
    at.set(k, anchor === 'left' ? part.offsetLeft : width - part.offsetLeft - part.offsetWidth);
  }
  return { width, at };
}

/** How long a part that left takes to go. */
const OUT = 50;

/** The chips whose moving window reaches past them just now, each with the glide it does so for. */
const rooms = new WeakMap<HTMLElement, Animation | null>();

/** The moving end's glide and what rides with it; the words' fades around it. */
function morph(el: HTMLElement, anchor: 'left' | 'right', was: Measure, now: Measure) {
  const d = now.width - was.width;
  const sign = anchor === 'right' ? 1 : -1;
  const grows = d > 0;
  const dur = Math.round(Math.min(150, 110 + Math.abs(d) * 0.4));
  // A chip that shrinks holds its edge until the old word has gone.
  const glide: KeyframeAnimationOptions = { duration: dur, delay: grows ? 0 : 36, easing: grows ? EASE_OUT : EASE_STD, fill: 'backwards' };
  const from = (px: number): Keyframe[] => [{ transform: `translateX(${px.toFixed(2)}px)` }, { transform: 'translateX(0px)' }];
  if (Math.abs(d) > 0.5) {
    const edge = play(el.querySelector('.cs-move > i'), from(sign * d), glide);
    rooms.set(el, edge);
    if (grows || !edge) el.style.removeProperty('--chip-room');
    else {
      // A chip that shrank was wider: its moving end starts beyond the chip now, and the window
      // over it reaches that far until this glide is over (a newer change keeps the room for its own).
      el.style.setProperty('--chip-room', `${Math.ceil(-d)}px`);
      const done = () => rooms.get(el) === edge && el.style.removeProperty('--chip-room');
      edge.finished.then(done, done);
    }
    // What stands on the moving side was pushed by the same amount.
    for (let s = anchor === 'right' ? el.previousElementSibling : el.nextElementSibling; s; s = anchor === 'right' ? s.previousElementSibling : s.nextElementSibling) play(s, from(sign * d), glide);
  }
  for (const c of el.children) {
    const part = c as HTMLElement;
    const k = part.dataset.k;
    if (k === undefined) continue;
    if (part.dataset.ghost !== undefined) {
      // Left: gone before anything arrives in its place (the two are never on screen together).
      play(part, [{ opacity: 1 }, { opacity: 0 }], { duration: OUT, easing: 'linear', fill: 'forwards' });
      continue;
    }
    const before = was.at.get(k);
    const here = now.at.get(k) ?? 0;
    if (before === undefined) {
      // Arrived: in once what stood there has gone, and behind the moving edge (a growing chip's
      // edge is nearly home by then).
      play(part, [{ opacity: 0 }, { opacity: 1 }], { duration: 80, delay: Math.max(OUT, grows ? Math.round(dur * 0.4) : 0), easing: 'linear', fill: 'backwards' });
    } else if (Math.abs(here - before) > 0.5) play(part, from(sign * (here - before)), glide);
  }
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip({ parts, anchor, still, className, ...rest }, ref) {
  const el = useRef<HTMLElement | null>(null);
  const sig = sigOf(parts);
  const [st, setSt] = useState<{ sig: string; ghosts: Ghost[]; n: number }>({ sig, ghosts: [], n: 0 });
  const shown = useRef<{ parts: ChipPart[]; m: Measure | null }>({ parts, m: null });

  if (st.sig !== sig) {
    // What left: kept for a moment where it stood, fading.
    const keep = new Set(parts.map((p) => p.k));
    const m = shown.current.m;
    const ghosts = m ? shown.current.parts.filter((p) => !keep.has(p.k) && m.at.has(p.k)).map((p) => ({ k: p.k, node: p.node, className: p.className, at: m.at.get(p.k)! })) : [];
    setSt({ sig, ghosts, n: st.n + 1 });
  }

  useLayoutEffect(() => {
    shown.current.parts = parts;
  });

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const was = shown.current.m;
    const now = measure(node, anchor);
    shown.current.m = now;
    if (!st.n || !was || !was.width || !now.width) return;
    morph(node, anchor, was, now);
    const t = window.setTimeout(() => setSt((s) => (s.n === st.n && s.ghosts.length ? { ...s, ghosts: [] } : s)), 110);
    return () => window.clearTimeout(t);
  }, [st.n, anchor]);

  // A width that changes for another reason (the pane narrows and a word folds away, the interface
  // size) is no motion, but the next label change must start from it: the measure is kept fresh.
  useEffect(() => {
    const node = el.current;
    if (!node || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => {
      if (!node.getAnimations({ subtree: true }).length) shown.current.m = measure(node, anchor);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [anchor]);

  const setEl = useCallback(
    (node: HTMLButtonElement | null) => {
      el.current = node;
      setRef(ref, node);
    },
    [ref],
  );

  const Tag = (still ? 'span' : 'button') as 'button';
  return (
    <Tag
      ref={setEl}
      type={still ? undefined : 'button'}
      className={className}
      data-chip=""
      data-anchor={anchor}
      {...rest}
    >
      {SKIN}
      {parts.map((p) => (
        <span key={p.k} className={p.className ? `chip-part ${p.className}` : 'chip-part'} data-k={p.k}>
          {p.node}
        </span>
      ))}
      {st.ghosts.map((g) => (
        <span key={`${st.n}:${g.k}`} className={g.className ? `chip-part chip-ghost ${g.className}` : 'chip-part chip-ghost'} data-k={g.k} data-ghost="" style={{ [anchor]: g.at }} aria-hidden>
          {g.node}
        </span>
      ))}
    </Tag>
  );
});
