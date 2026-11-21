/**
 * The widget frames on screen, and the one thing the conversation asks of them while it scrolls:
 * to let the pointer through. A frame is another process; a wheel that lands on it is routed there
 * first, and a busy widget (a renderer still computing, a large picture) holds the scroll on the
 * spot. While the reader scrolls, every frame ignores the pointer, so the wheel stays with the
 * conversation; a moment after the scroll rests they take it again. Only the frames are touched
 * (a handful, the ones near the view), never the conversation's root: a style change there
 * restyles every row.
 */

const frames = new Set<HTMLIFrameElement>();
let scrolling = false;
let timer = 0;

/** How long after the last scroll the frames take the pointer again. */
export const SCROLL_REST_MS = 280;

/** A frame mounted (WidgetFrame); the returned function forgets it. */
export function trackFrame(el: HTMLIFrameElement): () => void {
  frames.add(el);
  if (scrolling) el.style.pointerEvents = 'none';
  return () => {
    frames.delete(el);
  };
}

/** The reader scrolls the conversation (Timeline: a wheel over it, a scroll it did not cause itself). */
export function readerScrolls() {
  if (!scrolling) {
    scrolling = true;
    for (const f of frames) f.style.pointerEvents = 'none';
  }
  clearTimeout(timer);
  timer = window.setTimeout(rest, SCROLL_REST_MS);
}

function rest() {
  scrolling = false;
  for (const f of frames) f.style.pointerEvents = '';
}

/** For tests: whether frames ignore the pointer now. */
export const framesPassThrough = () => scrolling;
