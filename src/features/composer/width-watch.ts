/**
 * Calls `onResize` whenever `el` takes a new width, from the width the observer reports (no layout
 * read of its own). The first report is the element as it mounted, which its owner has measured
 * already: it only sets the baseline. One observer for the element's life; the owner passes a
 * callback that reads its current state (a ref), so typing never makes a new observer.
 */
export function watchWidth(el: Element, onResize: () => void): () => void {
  let width = -1;
  const ro = new ResizeObserver((entries) => {
    const e = entries[entries.length - 1];
    if (!e) return;
    const w = e.contentBoxSize?.[0]?.inlineSize ?? e.contentRect.width;
    if (width < 0) {
      width = w;
      return;
    }
    if (w === width) return;
    width = w;
    onResize();
  });
  ro.observe(el);
  return () => ro.disconnect();
}
