/**
 * A path's directory cut by whole folders (`<PathLabel fit>`). The plain label elides its directory
 * from the start with a right-to-left box and `text-overflow`: Chromium then drops whole glyphs and
 * sets the ellipsis against what remains, so the text begins up to a glyph late and mid-name
 * ("…ata/Local/Temp/"). Here the full directory stays in the flow, unseen, and gives the box its
 * width exactly as before; what shows is written over it from the box's left edge: the whole
 * directory when it fits, else "…/" and as many of the folders nearest the name as fit. The label
 * starts on its column and never splits a folder's name.
 *
 * Cost: nothing is measured while the directory fits (the usual case). A cut directory's candidates
 * are measured once per text and font, in one layout, and remembered; a fit after that is one read
 * of the box's width. One observer for every label, on the element around it. For menus, settings and dialogs: the conversation's
 * step rows keep the plain label (hundreds of them can be mounted at once).
 */

/** `dir` (ends with a slash) whole, then with one more leading folder dropped each time, then the mark alone. */
export function dirCandidates(dir: string): string[] {
  const parts = dir.split('/').filter(Boolean);
  const out = [dir];
  for (let k = 1; k < parts.length; k++) out.push(`…/${parts.slice(k).join('/')}/`);
  out.push('…/');
  return out;
}

/** The first candidate that fits `room` (half a pixel of grace for rounding); the mark alone when none does. */
export function pickDir(candidates: string[], widths: number[], room: number): string {
  for (let i = 0; i < candidates.length; i++) if (widths[i] <= room + 0.5) return candidates[i];
  return candidates[candidates.length - 1];
}

const known = new Map<string, number>();

/** The widths of `texts` in `el`'s own type, measured inside it (so every inherited font setting counts), each once. */
function widthsOf(el: HTMLElement, texts: string[]): number[] {
  const cs = getComputedStyle(el);
  const key = `${cs.font}|${cs.letterSpacing}|${cs.fontFeatureSettings}|${cs.fontVariationSettings}|`;
  const missing = texts.filter((t) => !known.has(key + t));
  if (missing.length) {
    const box = document.createElement('span');
    box.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;pointer-events:none';
    const spans = missing.map((t) => {
      const s = document.createElement('span');
      s.style.cssText = 'display:inline-block';
      s.textContent = t;
      box.appendChild(s);
      return s;
    });
    el.appendChild(box);
    if (known.size > 4000) known.clear();
    spans.forEach((s, i) => known.set(key + missing[i], s.getBoundingClientRect().width));
    box.remove();
  }
  return texts.map((t) => known.get(key + t) ?? 0);
}

/**
 * Writes what fits into the label's shown part. `el` is the `.path-dir[data-fit]` box. A cut box is
 * then held to the width of what it shows (the name follows it directly: no hole where a folder
 * was dropped); to learn its room it is let go first, for this one read.
 */
export function fitDir(el: HTMLElement) {
  const shown = el.querySelector<HTMLElement>(':scope > .path-dir-shown');
  const full = el.querySelector<HTMLElement>(':scope > .path-dir-full');
  if (!shown || !full) return;
  const dir = el.dataset.dir ?? '';
  if (el.style.maxWidth) el.style.maxWidth = '';
  const room = el.clientWidth;
  // The whole directory fits: nothing to measure, nothing to hold.
  if (full.offsetWidth <= room + 1) {
    if (shown.textContent !== dir) shown.textContent = dir;
    return;
  }
  const candidates = dirCandidates(dir);
  const widths = widthsOf(el, candidates);
  const pick = pickDir(candidates, widths, room);
  if (shown.textContent !== pick) shown.textContent = pick;
  el.style.maxWidth = `${Math.ceil(widths[candidates.indexOf(pick)])}px`;
}

let observer: ResizeObserver | undefined;
/** The labels inside each watched box (a held label no longer grows by itself: its surroundings say when there is more room). */
const inside = new WeakMap<Element, Set<HTMLElement>>();

/** Keeps the label fitted while the room around it changes; returns the way to stop. */
export function watchDir(el: HTMLElement): () => void {
  if (typeof ResizeObserver !== 'function') return () => {};
  observer ??= new ResizeObserver((entries) => {
    for (const e of entries) for (const dir of inside.get(e.target) ?? []) if (dir.isConnected) fitDir(dir);
  });
  const around = el.closest('.path')?.parentElement ?? el;
  let set = inside.get(around);
  if (!set) inside.set(around, (set = new Set()));
  set.add(el);
  observer.observe(around);
  return () => {
    set.delete(el);
    if (!set.size) observer?.unobserve(around);
  };
}
