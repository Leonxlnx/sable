/**
 * The mark travels with the sidebar. Closing, the brand's mark leaves the sidebar's first row and
 * settles beside the top bar's toggle, where the bar shows it while the sidebar is away; opening,
 * it flies back. One copy of the mark, fixed over the window, moves on transform alone for the
 * sidebar's own duration and curve while the two real marks are hidden; they show again on the
 * frame it lands. Nothing it passes over is laid out again.
 */

let live: { ghost: HTMLElement; hidden: HTMLElement[]; anim: Animation } | null = null;

const zoom = () => parseFloat(document.documentElement.style.zoom) || 1;

function land() {
  if (!live) return;
  const { ghost, hidden, anim } = live;
  live = null;
  anim.cancel();
  ghost.remove();
  for (const el of hidden) el.style.removeProperty('visibility');
}

/** The mark the sidebar's first row shows, and the one the top bar shows while the sidebar is away. */
const brandMark = () => document.querySelector<HTMLElement>('.app-side .brand .logo-mark');
const barMark = () => document.querySelector<HTMLElement>('.topbar-home .logo-mark');

/**
 * Call synchronously when the sidebar's open state changes (before the view renders the change):
 * it reads where the mark is now, and on the next frame (rendered by then) where it will rest.
 */
export function flyBrand(opening: boolean, ms: number, easing: string) {
  land();
  const from = (opening ? barMark() : brandMark())?.getBoundingClientRect();
  if (!from || from.width < 1) return;
  requestAnimationFrame(() => {
    const side = document.querySelector<HTMLElement>('.app-side');
    const stage = document.querySelector<HTMLElement>('.stage');
    const target = opening ? brandMark() : barMark();
    if (!side || !stage || !target) return;
    const sideBox = side.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    let left: number;
    if (opening) {
      // The sidebar's contents glide in from a small offset to the column's left edge, which stays put.
      const inner = side.firstElementChild as HTMLElement | null;
      if (!inner) return;
      left = sideBox.left + (r.left - inner.getBoundingClientRect().left);
    } else {
      // The bar rides on the stage, whose left edge ends where the sidebar's column starts.
      left = r.left - (stage.getBoundingClientRect().left - sideBox.left);
    }
    const top = r.top;
    const z = zoom();
    const ghost = target.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('class');
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${left / z}px`,
      top: `${top / z}px`,
      width: `${r.width / z}px`,
      height: `${r.height / z}px`,
      display: 'block',
      zIndex: '30',
      pointerEvents: 'none',
      transformOrigin: '0 0',
      willChange: 'transform',
    });
    const svg = ghost.querySelector('svg');
    if (svg) svg.style.display = 'block';
    document.body.appendChild(ghost);
    const k = from.width / r.width;
    const dx = (from.left - left) / z;
    const dy = (from.top - top) / z;
    const hidden = [target, opening ? null : brandMark()].filter((el): el is HTMLElement => !!el);
    for (const el of hidden) el.style.visibility = 'hidden';
    const anim = ghost.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${k})` }, { transform: 'none' }], { duration: ms, easing, fill: 'forwards' });
    live = { ghost, hidden, anim };
    anim.onfinish = () => {
      if (live?.anim === anim) land();
    };
  });
}
