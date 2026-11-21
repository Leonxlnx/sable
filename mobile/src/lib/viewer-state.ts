/**
 * What the full-screen picture viewer shows (ui/Viewer.tsx draws it): the pictures of one step, by
 * index, some still loading. Each opening has its own generation and names the step it shows (`key`:
 * chat and step), and a picture that arrives late lands only in the opening that asked for it, at an
 * index it has: closing a step's viewer while its second picture loads and opening another step's
 * never puts the first step's picture there. Pure, so it can be tested.
 */
export interface ViewerOpen {
  /** The pictures, by index (null: still loading). */
  srcs: (string | null)[];
  index: number;
  /** The thumbnail it came from (it grows out of it and goes back into it). */
  from?: DOMRect;
  /** The chat and step it shows. */
  key: string;
  /** Which opening this is. */
  gen: number;
}

let open: ViewerOpen | null = null;
let gen = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((l) => l());

export const viewerState = () => open;
export function subscribeViewer(l: () => void) {
  subs.add(l);
  return () => void subs.delete(l);
}

/** Opens the viewer on a step's pictures; returns this opening's generation (what a late picture must name). */
export function openViewer(v: { srcs: (string | null)[]; index: number; from?: DOMRect; key: string }): number {
  open = { ...v, gen: ++gen };
  emit();
  return open.gen;
}

/** A picture that arrived after the viewer opened: kept only by the same opening, of the same step, at an index it has. */
export function viewerLoaded(g: number, key: string, index: number, src: string): boolean {
  if (!open || open.gen !== g || open.key !== key || !Number.isInteger(index) || index < 0 || index >= open.srcs.length) return false;
  if (open.srcs[index] === src) return true;
  const srcs = [...open.srcs];
  srcs[index] = src;
  open = { ...open, srcs };
  emit();
  return true;
}

export function closeViewer() {
  open = null;
  emit();
}
