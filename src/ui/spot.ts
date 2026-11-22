/**
 * Reactive hairlines. Surfaces marked `data-spot` brighten their border near the pointer
 * (the CSS lives in styles/ui.css under "material: reactive hairlines").
 *
 * One passive pointermove listener on the document, throttled to one rAF. Each frame it finds
 * the closest [data-spot] ancestor of the element under the pointer and moves the light on that
 * surface's ring: a <span class="spot-ring"><i></i></span> added the first time the surface is
 * hovered (and again if a re-render drops it). Only the disc's transform changes, so a move
 * restyles one childless element and repaints nothing (the disc is its own layer while lit; the
 * ring's mask never changes). Nothing runs while the pointer
 * is still, and nothing at all for touch or when the user prefers reduced motion. Features only
 * add the attribute; they never listen themselves.
 *
 * A surface whose outline is not a rounded box (the composer and its cove) draws its own ring: a
 * `.spot-ring` it renders itself, made of `.spot-part` children that share the surface's origin,
 * each cut to its stretch of the outline. Every part gets a disc, and all of them move together.
 */

let started = false;

/** The disc inside a ring (or inside one part of a ring), created the first time it is needed. */
function discIn(host: HTMLElement): HTMLElement {
  let light = host.firstElementChild as HTMLElement | null;
  if (!light) {
    light = document.createElement('i');
    host.append(light);
  }
  return light;
}

/** A ring's discs, found once per ring (a re-render that drops the ring makes a new one). */
const discs = new WeakMap<HTMLElement, HTMLElement[]>();

/** The surface's lights: the disc inside its ring, or one per part of a ring the surface draws itself. */
function lightsOf(el: HTMLElement): HTMLElement[] {
  const last = el.lastElementChild;
  let ring = last instanceof HTMLElement && last.classList.contains('spot-ring') ? last : el.querySelector<HTMLElement>(':scope > .spot-ring');
  if (!ring) {
    ring = document.createElement('span');
    ring.className = 'spot-ring';
    ring.setAttribute('aria-hidden', 'true');
    el.append(ring);
  }
  let lights = discs.get(ring);
  if (!lights || !lights.every((l) => l.isConnected)) {
    const parts = ring.querySelectorAll<HTMLElement>(':scope > .spot-part');
    lights = parts.length ? Array.from(parts, discIn) : [discIn(ring)];
    discs.set(ring, lights);
  }
  return lights;
}

export function startSpot() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const fine = matchMedia('(hover: hover)');

  let raf = 0;
  let x = 0;
  let y = 0;
  let target: Element | null = null;
  let current: HTMLElement | null = null;
  let lastX = NaN;
  let lastY = NaN;

  const set = (el: HTMLElement | null) => {
    if (el === current) return;
    current?.removeAttribute('data-spot-on');
    current = el;
    lastX = lastY = NaN;
    el?.setAttribute('data-spot-on', '');
  };

  const frame = () => {
    raf = 0;
    const el = target?.closest<HTMLElement>('[data-spot]') ?? null;
    if (!el) return set(null);
    // Read before any write, so the frame never forces a second layout.
    const r = el.getBoundingClientRect();
    // Client pixels to the element's own CSS pixels (Interface size zooms the root; dialogs scale in).
    const k = r.width ? el.offsetWidth / r.width : 1;
    const mx = Math.round((x - r.left) * k);
    const my = Math.round((y - r.top) * k);
    const lights = lightsOf(el);
    set(el);
    if (mx === lastX && my === lastY) return;
    lastX = mx;
    lastY = my;
    const at = `translate(${mx}px, ${my}px)`;
    for (const light of lights) light.style.transform = at;
  };

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || reduce.matches || !fine.matches) return;
    x = e.clientX;
    y = e.clientY;
    target = e.target instanceof Element ? e.target : null;
    schedule();
  };

  // The surface moved under a still pointer (a scroll): place the light again.
  const onScroll = () => {
    if (current) schedule();
  };

  const clear = () => {
    target = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    set(null);
  };

  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  document.documentElement.addEventListener('pointerleave', clear);
  window.addEventListener('blur', clear);
  reduce.addEventListener('change', clear);
}
