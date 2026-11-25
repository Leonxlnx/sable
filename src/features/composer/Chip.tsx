import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';
import { EASE_OUT, EASE_STD, play, uiZoom } from '@/lib/motion';
import { toDevicePixel } from './pixel-snap';
import { inPose, reel, reelFrom, ROLL_EASE, ROLL_MS } from './reel';
import { easeOf, standsAt, type Ease } from './glide-from';

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
 * - a word that changes by direction (`data-roll` on the chip: the effort's level went up or
 *   down, ultracode went on or off) rolls like a reel instead of fading in place: the old one
 *   leaves that way and the new one follows it in from the other side, both on one clock and one
 *   line apart (reel.ts), so the two are never on the same pixels and the place is never empty.
 *   The chip cuts them at its own top and bottom (composer.css `.ph`, `.ux`).
 * All of it is transforms and opacity on the compositor (Web Animations, started in the layout
 * effect of that same commit; no glide is additive, which Chromium keeps on the main thread:
 * glide-from.ts), about 140 ms: nothing is laid out per frame, so the popover that
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
  /** As wide as the part was: one that filled its room (the phrase's dot, centred in it) keeps what it showed where it showed it. */
  w: number;
}

interface Measure {
  width: number;
  /** Each part's distance from the chip's fixed end. */
  at: Map<string, number>;
  /** Each part's own width. */
  w: Map<string, number>;
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
  const w = new Map<string, number>();
  for (const c of el.children) {
    const k = (c as HTMLElement).dataset.k;
    if (k === undefined || (c as HTMLElement).dataset.ghost !== undefined) continue;
    const part = c as HTMLElement;
    at.set(k, anchor === 'left' ? part.offsetLeft : width - part.offsetLeft - part.offsetWidth);
    w.set(k, part.offsetWidth);
  }
  return { width, at, w };
}

/** How long a part that left takes to go. */
const OUT = 50;

/** The chips whose moving window reaches past them just now, each with the glide it does so for and how far. */
const rooms = new WeakMap<HTMLElement, { edge: Animation | null; px: number }>();

/** A step this soon after the last one finds a word still on its way in (it is home, within a pixel, after about 110 ms). */
const QUICK_MS = 110;
/** How long a rolled word waits in a chip that grows: by then the moving edge is past it. */
const GROW_WAIT = 34;
/** When each chip's last word began to roll in, and which way: a step that comes while it still rolls in sends it on from where it stands. */
const rolled = new WeakMap<HTMLElement, { t: number; way: 1 | -1 }>();

/**
 * Puts the line where the skin's two windows meet where both are cut the same, for the glide that
 * is about to start. While the moving window glides it is the compositor's own, and the compositor
 * cuts it on whole CSS pixels while the page cuts the window that stays on device pixels: wherever
 * their line lay off a pixel that is both (a chip seldom stands on one at 125%), the two
 * overlapped by one column, a lighter vertical line through the pill for as long as it moved
 * (filmed at 125%: there with the line on a whole device pixel alone, gone with `capOn`). The cap
 * moves 4 px at most and stays on the pill's straight part (composer.css `--chip-cap`); a chip too
 * short for that keeps the half-device-pixel seat.
 */
function seat(el: HTMLElement, anchor: 'left' | 'right') {
  const dpr = window.devicePixelRatio || 1;
  const z = uiZoom() || 1;
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  // How much wider (or narrower) the fixed window must be for a cap of `cap` CSS px.
  const fix = (cap: number) => {
    const line = anchor === 'right' ? r.right - cap * z : r.left + cap * z;
    const move = toDevicePixel(line, dpr) / z;
    return anchor === 'right' ? -move : move;
  };
  el.style.setProperty('--chip-cap-px', `${capOn(anchor === 'right' ? r.right / z : r.left / z, anchor === 'right' ? -1 : 1, z * dpr) ?? (20 + fix(20)).toFixed(3)}px`);
  // A chip too short for a straight part: its windows meet in its middle.
  el.style.setProperty('--chip-half-fix', `${fix(r.width / z / 2).toFixed(3)}px`);
}

/**
 * A cap between 16 and 24 CSS px whose line lies on a whole CSS pixel that is also a whole device
 * pixel (every 4 CSS px at 125%): the compositor cuts the gliding window on whole CSS pixels, the
 * page cuts the one that stays on device pixels, so only such a line is cut the same by both.
 * `end` is the chip's fixed end in layout px, `dir` the way into the chip from it, `k` device px
 * per layout px. Null where no such line lies within reach (the half-pixel seat stands then).
 */
export function capOn(end: number, dir: 1 | -1, k: number): string | null {
  let best: number | null = null;
  // Every whole CSS pixel the line may lie on, from 16 to 24 px into the chip.
  const a = end + dir * 16;
  const b = end + dir * 24;
  for (let line = Math.ceil(Math.min(a, b)); line <= Math.floor(Math.max(a, b)); line++) {
    const dev = line * k;
    if (Math.abs(dev - Math.round(dev)) > 1e-3) continue;
    const cap = (line - end) * dir;
    if (best === null || Math.abs(cap - 20) < Math.abs(best - 20)) best = cap;
  }
  return best === null ? null : best.toFixed(6);
}

interface Glide {
  anim: Animation;
  from: number;
  delay: number;
  duration: number;
  ease: Ease;
}
/** The glide each element does now, to start the next one from where it stands. */
const glides = new WeakMap<Element, Glide>();

/**
 * Glides `el` from `px` (plus where a glide still running on it stands, worked out from that
 * glide's own clock) to its place. One animation per element that replaces the last, so it runs
 * on the compositor beside the rolled words and the fades (glide-from.ts).
 */
function glideBy(el: Element | null, px: number, opts: { duration: number; delay?: number; easing: string }): Animation | null {
  if (!el) return null;
  let start = px;
  const g = glides.get(el);
  if (g && (g.anim.playState === 'running' || g.anim.pending)) {
    start += standsAt(g.from, (Number(g.anim.currentTime) || 0) - g.delay, g.duration, g.ease);
    g.anim.cancel();
  }
  const anim = play(el, [{ transform: `translateX(${start.toFixed(2)}px)` }, { transform: 'translateX(0px)' }], { ...opts, fill: 'backwards' });
  if (anim) glides.set(el, { anim, from: start, delay: opts.delay ?? 0, duration: opts.duration, ease: easeOf(opts.easing) });
  return anim;
}

/** The moving end's glide and what rides with it; the words' fades around it. */
function morph(el: HTMLElement, anchor: 'left' | 'right', was: Measure, now: Measure) {
  const d = now.width - was.width;
  // A word that changes by direction (the effort's level up or down, ultracode on or off) rolls:
  // the old one leaves the way it went and the new one follows it in, one line behind.
  const way = el.dataset.roll === 'up' ? -1 : el.dataset.roll === 'down' ? 1 : 0;
  const roll = way ? reel(way) : null;
  // Steps held or pressed in quick succession: the word still rolling in leaves from where it stands
  // (worked out from its own start, reel.ts `inPose`), never from rest, which was a jump.
  const t = performance.now();
  const last = rolled.get(el);
  const quick = roll && last && t - last.t < QUICK_MS ? reelFrom(way as 1 | -1, inPose(last.way, t - last.t)) : null;
  const sign = anchor === 'right' ? 1 : -1;
  const grows = d > 0.5;
  if (roll) rolled.set(el, { t: t + (grows ? GROW_WAIT : 0), way: way as 1 | -1 });
  const dur = Math.round(Math.min(150, 110 + Math.abs(d) * 0.4));
  // A chip whose rolled word stands at its fixed end (`data-glide="reel"`: the phrase, the level by
  // the key) glides on the reel's own clock and starts in the frame of the step: growing, what
  // stands left of the word leaves first (quick off the mark) and the word rolls in behind it;
  // shrinking, it sets off slowly while the old word rolls away, then follows. The lengths make
  // both land within half a pixel in the same frame or two as the word. Else a chip that
  // shrinks holds its edge until the old word has gone.
  const onReel = !!roll && el.dataset.glide === 'reel';
  // A step while the last glide still runs starts from where that one stands (glideBy), so quick
  // steps never jump (each glide's offset is from the layout it was measured against).
  const glide = onReel
    ? { duration: grows ? ROLL_MS + GROW_WAIT : ROLL_MS - 30, easing: grows ? EASE_OUT : EASE_STD }
    : { duration: dur, delay: grows ? 0 : 36, easing: grows ? EASE_OUT : EASE_STD };
  if (Math.abs(d) > 0.5) {
    seat(el, anchor);
    const before = rooms.get(el);
    // The room a glide still under way needs goes on being needed: its offset is added to this one.
    const still = before?.edge && (before.edge.playState === 'running' || before.edge.pending) ? before.px : 0;
    const edge = glideBy(el.querySelector('.cs-move > i'), sign * d, glide);
    const px = edge ? Math.ceil(Math.max(0, -d) + still) : 0;
    rooms.set(el, { edge, px });
    if (!px || !edge) el.style.removeProperty('--chip-room');
    else {
      // A chip that shrank was wider: its moving end starts beyond the chip now, and the window
      // over it reaches that far until this glide is over (a newer change keeps the room for its own).
      el.style.setProperty('--chip-room', `${px}px`);
      const done = () => rooms.get(el)?.edge === edge && el.style.removeProperty('--chip-room');
      edge.finished.then(done, done);
    }
    // What stands on the moving side was pushed by the same amount. A chip that stands in a slot
    // of its own (`data-chip-slot`: the phrase and the copy that sizes it) has its neighbours
    // beside the slot.
    const holder = el.closest<HTMLElement>('[data-chip-slot]') ?? el;
    for (let s = anchor === 'right' ? holder.previousElementSibling : holder.nextElementSibling; s; s = anchor === 'right' ? s.previousElementSibling : s.nextElementSibling) glideBy(s, sign * d, glide);
  }
  for (const c of el.children) {
    const part = c as HTMLElement;
    const k = part.dataset.k;
    if (k === undefined) continue;
    if (part.dataset.ghost !== undefined) {
      // Left. Rolled: out the way it went, the new word a line behind it. Else gone before
      // anything arrives in its place (the two are never on screen together).
      // At the fixed end of a chip that grows the old word waits with the new one, so the two stay
      // on one clock, one line apart (what moves away from it first is no danger to it).
      const wait = onReel && grows ? GROW_WAIT : 0;
      if (quick) play(part, quick, { duration: ROLL_MS, delay: wait, easing: ROLL_EASE, fill: 'both' });
      else if (roll) play(part, roll.out, { duration: ROLL_MS, delay: wait, easing: ROLL_EASE, fill: 'both' });
      else play(part, [{ opacity: 1 }, { opacity: 0 }], { duration: OUT, easing: 'linear', fill: 'forwards' });
      continue;
    }
    const before = was.at.get(k);
    const here = now.at.get(k) ?? 0;
    if (before === undefined && roll) {
      // On the old word's clock. In a chip that grows the word waits two frames, until the
      // moving edge (or, at the fixed end, what stands left of it) has passed where it stands.
      play(part, roll.in, { duration: ROLL_MS, delay: grows ? GROW_WAIT : 0, easing: ROLL_EASE, fill: 'backwards' });
    } else if (before === undefined) {
      // Arrived: in once what stood there has gone, and behind the moving edge (a growing chip's
      // edge is nearly home by then).
      play(part, [{ opacity: 0 }, { opacity: 1 }], { duration: 80, delay: Math.max(OUT, grows ? Math.round(dur * 0.4) : 0), easing: 'linear', fill: 'backwards' });
    } else if (Math.abs(here - before) > 0.5) glideBy(part, sign * (here - before), glide);
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
    const ghosts = m ? shown.current.parts.filter((p) => !keep.has(p.k) && m.at.has(p.k)).map((p) => ({ k: p.k, node: p.node, className: p.className, at: m.at.get(p.k)!, w: m.w.get(p.k) ?? 0 })) : [];
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
        <span key={`${st.n}:${g.k}`} className={g.className ? `chip-part chip-ghost ${g.className}` : 'chip-part chip-ghost'} data-k={g.k} data-ghost="" style={{ [anchor]: g.at, ...(g.w ? { width: g.w } : null) }} aria-hidden>
          {g.node}
        </span>
      ))}
    </Tag>
  );
});
