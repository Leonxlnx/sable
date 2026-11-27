/**
 * The visible part of the page in a browser (`window.visualViewport`): its height and how far the browser
 * panned it, as `--vvh` and `--vvt` on the root. The tablet layout (web/split.css) stands exactly in it, so
 * an on-screen keyboard (iPad Safari lays it over the page and pans the page to the focused field) shortens
 * the stage and the composer stays on its foot, right above the keys, with nothing lifted twice. Without a
 * visual viewport the layout takes the dynamic viewport's height (100dvh), never vh.
 */
const vv = typeof window !== 'undefined' ? window.visualViewport : null;
if (vv) {
  const root = document.documentElement;
  let frame = 0;
  const apply = () => {
    frame = 0;
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    root.style.setProperty('--vvt', `${Math.round(Math.max(0, vv.offsetTop))}px`);
  };
  const soon = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', soon);
  vv.addEventListener('scroll', soon);
  apply();
}
