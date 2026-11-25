import { Component, type ReactNode } from 'react';
import { play, reducedMotion, spring, uiZoom } from '@/lib/motion';

/**
 * Children that keep their place visually when their order changes: rows moving up when a
 * session becomes active, folders reordering, the gap closing after a row leaves. A class only
 * for getSnapshotBeforeUpdate: positions are read right before React moves the DOM (when layout
 * is clean, so the read is free), and only when `order` changed. Each child that moved then
 * slides from where it was drawn to where it is laid out (transform only, Web Animations).
 *
 * Places are read in the list's own box, not the window's: a list inside a section that moves
 * (Pinned appearing above a folder) slides its rows by what they moved in the section, and the
 * section's own slide carries them the rest, on the same spring. Read in the window, a row that
 * moved up one place inside a section that moved down three was slid by the whole distance on top
 * of its section's slide, and came down onto the section's header.
 *
 * Children are found by `[data-flip]` (their key) directly inside the wrapper element.
 */
interface Props {
  order: string;
  className?: string;
  role?: string;
  /** Runs after the DOM took the new order, before the new places are measured (a drag drops its transforms here). */
  beforeMeasure?: () => void;
  /**
   * A child React takes out while it is still seen (a section whose last chat went elsewhere: Pinned
   * when its last chat is let go) fades where it stood, its own element as the dead copy, out of the
   * flow and after every other child (never between two sections, `.sgroup + .sgroup`).
   */
  exit?: boolean;
  children: ReactNode;
}

interface Box {
  el: HTMLElement;
  key: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

type Snap = { tops: Map<string, number>; order: string[]; boxes: Box[] | null; shrunk: boolean; base: number } | null;

/** Ids in an order string (any run of spaces, colons or line breaks separates them). */
const count = (order: string) => order.split(/[\s:]+/).filter(Boolean).length;

const MOVE = spring(440, 40);
/** How long a child that leaves takes to fade where it stood (ms). */
const EXIT_MS = 120;

/**
 * Which children keep their order among themselves: `old[i]` is the place the i-th child (in the new
 * order) had before. The longest run whose old places still rise is the list that merely shifted;
 * a child outside it changed its place against the others (a folder to the top, a row to the top of
 * its folder), so a slide would carry its words across theirs.
 */
export function steady(old: readonly number[]): boolean[] {
  const n = old.length;
  // Patience sorting: tails[k] is the index ending the best run of length k + 1.
  const tails: number[] = [];
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (old[tails[mid]] < old[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Array<boolean>(n).fill(false);
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out[i] = true;
  return out;
}

export class Flip extends Component<Props> {
  private el: HTMLDivElement | null = null;
  private ref = (el: HTMLDivElement | null) => {
    this.el = el;
  };

  private items(): HTMLElement[] {
    return this.el ? [...this.el.querySelectorAll<HTMLElement>(':scope > [data-flip]')] : [];
  }

  getSnapshotBeforeUpdate(prev: Props): Snap {
    if (prev.order === this.props.order || !this.el || reducedMotion()) return null;
    const base = this.el.getBoundingClientRect();
    const tops = new Map<string, number>();
    const order: string[] = [];
    const boxes: Box[] | null = this.props.exit ? [] : null;
    for (const item of this.items()) {
      const r = item.getBoundingClientRect();
      const key = item.dataset.flip!;
      tops.set(key, r.top - base.top);
      order.push(key);
      if (boxes && r.height > 0) boxes.push({ el: item, key, top: r.top - base.top, left: r.left - base.left, width: r.width, height: r.height });
    }
    return { tops, order, boxes, shrunk: count(this.props.order) < count(prev.order), base: base.top };
  }

  componentDidUpdate(_prev: Props, _state: unknown, snap: Snap) {
    this.props.beforeMeasure?.();
    const list = this.el;
    if (!snap?.tops.size || !list) return;
    const z = uiZoom();
    const moves: [HTMLElement, number, number][] = [];
    for (const item of this.items()) {
      const key = item.dataset.flip!;
      const was = snap.tops.get(key);
      if (was === undefined) continue;
      // Measured without a move still running, so the slide starts from where it is drawn now.
      for (const a of item.getAnimations()) if ((a as Animation & { id: string }).id === 'flip') a.cancel();
      moves.push([item, was, snap.order.indexOf(key)]);
    }
    // All reads, then all writes: one layout for the whole list.
    const base = list.getBoundingClientRect();
    const rects = moves.map(([item]) => item.getBoundingClientRect());
    const keeps = steady(moves.map(([, , at]) => at));
    // What React took out while it was seen, and where its copy goes (the list's positioned box).
    // A child whose key stands elsewhere in the list now (a folder moved into a project) moved: it comes
    // from where it stood by its own rule (move.ts), and a copy fading there would trail it.
    const scope = list.closest('.side-list') ?? list;
    const gone = snap.boxes?.filter((b) => !b.el.isConnected && b.el.style.display !== 'none' && b.el.style.visibility !== 'hidden' && !scope.querySelector(`[data-flip="${CSS.escape(b.key)}"]`)) ?? [];
    const host = gone.length ? (getComputedStyle(list).position !== 'static' ? list : (list.offsetParent as HTMLElement | null)) : null;
    const hostBox = host?.getBoundingClientRect();
    const from = host && hostBox ? { left: (base.left - hostBox.left) / z - host.clientLeft + host.scrollLeft, top: (base.top - hostBox.top) / z - host.clientTop + host.scrollTop } : null;

    // ── writes ──
    if (from) for (const b of gone) this.leave(b, from, z);
    // Something left: the others wait a beat, so its dissolve is seen before the gap closes. Not in a
    // list that moved itself (Pinned appearing above its folder): its section slides at once, and rows
    // that waited rode down with it past their places and came back (8 px) when their beat was over.
    const delay = snap.shrunk && Math.abs(base.top - snap.base) < 0.5 ? 90 : 0;
    moves.forEach(([item, was], i) => {
      const dy = (was - (rects[i].top - base.top)) / z;
      if (Math.abs(dy) < 0.5) return;
      // A long jump (a row to the top of its folder, a folder to the top of the list) would slide
      // its text across its neighbours': it arrives in place instead, a short drop and a fade. Only
      // a child that changed its place against the others jumps: a whole list shifted by what came
      // or went above it (Pinned appearing, a folder emptied) slides, however far, since nothing
      // crosses anything (faded in place, the folder under a new Pinned section was gone for a
      // frame and its header came back under its own rows). A folder just dropped by hand always
      // slides home from where it was let go.
      const far = !item.hasAttribute('data-dropped') && !keeps[i] && Math.abs(dy) > Math.min((rects[i].height / z) * 1.6, 60);
      const a = far
        ? play(item, [{ opacity: 0, transform: `translateY(${Math.sign(dy) * 6}px)` }, { opacity: 1, transform: 'translateY(0)' }], { duration: MOVE.duration, easing: MOVE.easing, delay: 40, fill: 'backwards' })
        : play(item, [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: MOVE.duration, easing: MOVE.easing, delay, fill: 'backwards' });
      if (a) a.id = 'flip';
    });
  }

  /** `b`'s element, which React has let go of, fades where it stood (`at`: the list's place in its positioned box). */
  private leave(b: Box, at: { left: number; top: number }, z: number) {
    const el = b.el;
    const list = this.el;
    if (!list) return;
    for (const a of el.getAnimations()) if ((a as Animation & { id: string }).id === 'flip') a.cancel();
    // Nothing in it is found, counted or focused as the list's own any more, and nothing in it comes in
    // again (put back into the page, an element starts its CSS animations over: `[data-enter]`).
    for (const n of [el, ...el.querySelectorAll<HTMLElement>('[data-flip], [data-folder], [data-row], [data-nav], [tabindex], [data-enter]')]) {
      for (const k of ['data-flip', 'data-folder', 'data-row', 'data-nav', 'data-enter', 'tabindex']) n.removeAttribute(k);
    }
    el.setAttribute('data-gone', '');
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
    el.style.cssText = `position:absolute;top:${at.top + b.top / z}px;left:${at.left + b.left / z}px;width:${b.width / z}px;height:${b.height / z}px;margin:0;pointer-events:none;`;
    list.appendChild(el);
    const out = play(el, [{ opacity: 1 }, { opacity: 0 }], { duration: EXIT_MS, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
    const off = () => el.remove();
    if (out) out.finished.then(off, off);
    else off();
  }

  render() {
    return (
      <div ref={this.ref} className={this.props.className} role={this.props.role}>
        {this.props.children}
      </div>
    );
  }
}
