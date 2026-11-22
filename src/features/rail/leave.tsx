import { Component, type ReactNode } from 'react';
import { EASE_OUT, play, reducedMotion, spring, uiZoom } from '@/lib/motion';

/**
 * A list whose rows make room for a newcomer and leave softly: a row that is gone fades where it stood (a copy of it, drawn
 * over its old place for 140 ms) and the rows under it close the gap on a spring, the way the
 * sidebar's rows do (`sidebar/flip.tsx`). Positions are read right before React changes the DOM
 * and only when `order` changed; transform and opacity only. A large batch (a commit that empties
 * the list) simply goes.
 *
 * Rows are the `[data-flip]` children (their key) directly inside the wrapper.
 */
interface Props {
  order: string;
  className?: string;
  children: ReactNode;
}

type Snap = { rows: Map<string, { el: HTMLElement; top: number; left: number; width: number }>; box: DOMRect } | null;

const MOVE = spring(440, 40);
const MOST = 6;
/** The glide each row is on (cancelled when the next change catches it moving). */
const gliding = new WeakMap<HTMLElement, Animation>();
/** Above this many rows the list changes without the motion (see getSnapshotBeforeUpdate). */
const LONG = 40;

export class LeaveList extends Component<Props> {
  private el: HTMLDivElement | null = null;
  private ref = (el: HTMLDivElement | null) => {
    this.el = el;
  };

  private items(): HTMLElement[] {
    return this.el ? [...this.el.querySelectorAll<HTMLElement>(':scope > [data-flip]')] : [];
  }

  getSnapshotBeforeUpdate(prev: Props): Snap {
    if (prev.order === this.props.order || !this.el || reducedMotion()) return null;
    // A pane that is not the one on screen has nothing to show.
    if (!this.el.closest('.rail-pane[data-active]')) return null;
    // A long list (137 sub-agents, one finishing every few hundred ms) simply changes: measuring
    // every row before and after each change forced two layouts of the window per change (perf1).
    const items = this.items();
    if (items.length > LONG) return null;
    const rows: NonNullable<Snap>['rows'] = new Map();
    for (const el of items) {
      const r = el.getBoundingClientRect();
      rows.set(el.dataset.flip!, { el, top: r.top, left: r.left, width: r.width });
    }
    return { rows, box: this.el.getBoundingClientRect() };
  }

  componentDidUpdate(_prev: Props, _state: unknown, snap: Snap) {
    const host = this.el;
    if (!snap?.rows.size || !host) return;
    const z = uiZoom();
    const now = this.items();
    const kept = new Set(now.map((el) => el.dataset.flip!));
    const gone = [...snap.rows].filter(([key]) => !kept.has(key));
    const came = now.filter((el) => !snap.rows.has(el.dataset.flip!)).length;
    // Rows joined or left, a few at a time: the others make room or close the gap. A batch simply changes.
    if ((!gone.length && !came) || gone.length > MOST || came > MOST) return;

    // All reads, then all writes: one layout for the whole list.
    const moves: [HTMLElement, number][] = [];
    for (const el of now) {
      const was = snap.rows.get(el.dataset.flip!);
      if (!was) continue;
      // Its own glide, kept here: `getAnimations()` flushed the window's style once per row.
      gliding.get(el)?.cancel();
      moves.push([el, was.top]);
    }
    const tops = moves.map(([el]) => el.getBoundingClientRect().top);

    for (const [, row] of gone) {
      const ghost = row.el.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('data-flip');
      ghost.removeAttribute('data-new');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.inert = true;
      Object.assign(ghost.style, {
        position: 'absolute',
        top: `${(row.top - snap.box.top) / z}px`,
        left: `${(row.left - snap.box.left) / z}px`,
        width: `${row.width / z}px`,
        margin: '0',
        pointerEvents: 'none',
      });
      host.appendChild(ghost);
      const a = play(ghost, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.985)' }], { duration: 140, easing: EASE_OUT, fill: 'forwards' });
      if (a) a.finished.then(() => ghost.remove(), () => ghost.remove());
      else ghost.remove();
    }

    moves.forEach(([el, was], i) => {
      const dy = (was - tops[i]) / z;
      if (Math.abs(dy) < 0.5) return;
      // The others wait a beat, so the dissolve is seen before the gap closes.
      const a = play(el, [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: MOVE.duration, easing: MOVE.easing, delay: gone.length ? 70 : 0, fill: 'backwards' });
      if (a) gliding.set(el, a);
    });
  }

  render() {
    return (
      <div ref={this.ref} className={this.props.className} role="list" style={{ position: 'relative' }}>
        {this.props.children}
      </div>
    );
  }
}
