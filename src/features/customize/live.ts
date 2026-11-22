import { bridge } from '@/lib/bridge';
import { useStore } from '@/state/store';

/**
 * The person's stylesheet, live: `src/boot.ts` links `/custom/styles.css` at the end of the body; on
 * every `custom.updated` with a new `styles.rev` the next version is loaded beside it and the old one
 * leaves only once the new one has loaded, so the change shows in one step and never as a frame of
 * the plain app in between.
 *
 * Also tells the bridge that this interface started (`custom.ready`): a custom build that never says so
 * is set aside after `CUSTOM_READY_MS` and the window reloads into the app's own interface. And says
 * once, after such a fallback, why the window looks like Sable again.
 */

const SELECTOR = 'link[data-sable-custom]';
const HREF = '/custom/styles.css';

let rev: number | undefined;
let loading: HTMLLinkElement | undefined;

export function swapStyles(next: number) {
  if (next === rev) return;
  const first = rev === undefined;
  rev = next;
  // The sheet the page loaded at start is the one that rev stands for.
  if (first && document.querySelector(SELECTOR)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${HREF}?rev=${next}`;
  link.dataset.sableCustom = '';
  loading?.remove();
  loading = link;
  const settle = () => {
    if (loading !== link) return;
    loading = undefined;
    for (const old of document.querySelectorAll(SELECTOR)) if (old !== link) old.remove();
  };
  link.onload = settle;
  link.onerror = settle;
  document.body.append(link);
}

const SEEN_KEY = 'sable.custom.fallbackSeen';

function fallbackNotice(at: number | undefined, reason: string | undefined) {
  if (!at) return;
  let seen = 0;
  try {
    seen = Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    /* no storage */
  }
  if (at <= seen) return;
  try {
    localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    /* no storage */
  }
  // Only right after it happened: an old failure is shown in Settings › Customize, not as news.
  if (Date.now() - at > 5 * 60_000) return;
  useStore.getState().toast(`Your build did not start, so Sable's own interface is back. ${reason ?? ''}`.trim(), 'error');
}

export function startCustomLive() {
  bridge.on((e) => {
    if (e.type !== 'custom.updated') return;
    swapStyles(e.state.styles.rev);
    fallbackNotice(e.state.build.failed?.at, e.state.build.failed?.reason);
  });
  const ask = () =>
    void bridge.call('custom.state', {}).then(
      (s) => {
        swapStyles(s.styles.rev);
        fallbackNotice(s.build.failed?.at, s.build.failed?.reason);
      },
      () => {},
    );
  bridge.onStatus((s) => s === 'open' && ask());
  if (bridge.status === 'open') ask();
  // Started: the interface rendered something (a build whose app throws at once renders nothing).
  const ready = () => {
    if (!document.getElementById('root')?.childElementCount) return void setTimeout(ready, 500);
    void bridge.call('custom.ready', {}).catch(() => {});
  };
  requestAnimationFrame(() => setTimeout(ready, 0));
}
