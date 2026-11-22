/**
 * The mark travels with the sidebar. Closing, the brand's mark leaves the sidebar's first row and
 * settles beside the top bar's toggle, where the bar shows it while the sidebar is away; opening,
 * it flies back. One copy of the mark, fixed over the window, moves on transform alone for the
 * sidebar's own duration and curve while the two real marks are hidden; they show again on the
 * frame it lands. Nothing it passes over is laid out again.
 *
 * The bar's slot for the mark is always in the bar, closed while the sidebar shows; it opens and
 * closes with the sidebar's column (app.css), so the mark's rest is worked out from where the slot
 * starts and how wide it will be, not from where the mark stands on the first frame. Until the mark
 * has landed the slot takes no pointer: it opens under the pointer that pressed the toggle, and its
 * hover fill travelled with it as a dark square.
 */

let live: { ghost: HTMLElement; hidden: HTMLElement[]; anim: Animation; slot: HTMLElement | null } | null = null;
/** The frame a glide waits for (it measures where the mark will rest once the view has rendered). */
let pending = 0;

const zoom = () => parseFloat(document.documentElement.style.zoom) || 1;

function land() {
  if (!live) return;
  const { ghost, hidden, anim, slot } = live;
  live = null;
  anim.cancel();
  ghost.remove();
  for (const el of hidden) el.style.removeProperty('visibility');
  slot?.style.removeProperty('pointer-events');
}

/** The mark the sidebar's first row shows, and the one the top bar shows while the sidebar is away. */
const brandMark = () => document.querySelector<HTMLElement>('.app-side .brand .logo-mark');
const barMark = () => document.querySelector<HTMLElement>('.topbar-home .logo-mark');
const barSlot = () => document.querySelector<HTMLElement>('.topbar > .topbar-home');

/**
 * Call synchronously when the sidebar's open state changes (before the view renders the change):
 * it reads where the mark is now, and on the next frame (rendered by then) where it will rest.
 */
export function flyBrand(opening: boolean, ms: number, easing: string) {
  land();
  // A toggle before the last one's frame came: that frame must not start a second glide.
  cancelAnimationFrame(pending);
  const from = (opening ? barMark() : brandMark())?.getBoundingClientRect();
  if (!from || from.width < 1) return;
  pending = requestAnimationFrame(() => {
    const side = document.querySelector<HTMLElement>('.app-side');
    const stage = document.querySelector<HTMLElement>('.stage');
    const target = opening ? brandMark() : barMark();
    if (!side || !stage || !target) return;
    const sideBox = side.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const z = zoom();
    let left: number;
    if (opening) {
      // The sidebar's contents glide in from a small offset to the column's left edge, which stays put.
      const inner = side.firstElementChild as HTMLElement | null;
      if (!inner) return;
      left = sideBox.left + (r.left - inner.getBoundingClientRect().left);
    } else {
      // The bar rides on the stage, whose left edge ends where the sidebar's column starts; the
      // slot is only beginning to open, and the mark rests in the middle of it once it has.
      const slot = barSlot();
      if (!slot) return;
      const wide = (parseFloat(getComputedStyle(slot).getPropertyValue('--tb-slot')) || 28) * z;
      left = slot.getBoundingClientRect().left + (wide - r.width) / 2 - (stage.getBoundingClientRect().left - sideBox.left);
    }
    const top = r.top;
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
    // Both real marks stay out of sight while the one copy flies (the bar's is still there while its slot closes).
    const hidden = [brandMark(), barMark()].filter((el): el is HTMLElement => !!el);
    for (const el of hidden) el.style.visibility = 'hidden';
    const slot = opening ? null : barSlot();
    if (slot) slot.style.pointerEvents = 'none';
    const anim = ghost.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${k})` }, { transform: 'none' }], { duration: ms, easing, fill: 'forwards' });
    live = { ghost, hidden, anim, slot };
    anim.onfinish = () => {
      if (live?.anim === anim) land();
    };
  });
}
