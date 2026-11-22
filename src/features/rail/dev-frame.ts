import type { PageController } from './browser-agent';
import { getPage, setPage, stepHistory } from './browser-store';

/**
 * The dev build only: the Browser tab's page is a cross-origin <iframe> there, which the app cannot
 * script. A local page that opts in (it answers `{ sable: 'hello' }` from its parent with
 * `{ sableDevPage: 1 }`, as the Demo's test page does) runs Sable's page scripts on request, so the
 * agent's tools, the pointer and the sign-in card work against it and can be filmed headless. Never
 * in the desktop app (its <webview> is scripted by the shell) and never for a page that is not on
 * this machine or does not answer. It never signs in: only the desktop's main process fills a
 * password (electron/sign-in.ts), so no password goes through this script runner.
 */

interface Reply {
  sableDevPage?: number;
  hello?: number;
  id?: number;
  ok?: number;
  value?: unknown;
  error?: string;
  href?: string;
  title?: string;
}

const RUN_MS = 60_000;

/** The exact origin of an address (scheme, host, port), or '' when it has none. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

export function connectDevFrame(
  frame: HTMLIFrameElement,
  tabId: string,
  sessionId: string,
  register: (c: PageController) => () => void,
  pointer: Pick<PageController, 'point' | 'press'>,
): () => void {
  let src: URL;
  try {
    src = new URL(frame.src);
  } catch {
    return () => {};
  }
  const h = src.hostname;
  if (!(h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost'))) return () => {};
  const target = src.origin;
  let href = frame.src;
  let seq = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let unregister: (() => void) | undefined;

  const post = (m: Record<string, unknown>) => frame.contentWindow?.postMessage(m, target);

  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || e.origin !== target) return;
    const d = e.data as Reply;
    if (!d || typeof d !== 'object' || d.sableDevPage !== 1) return;
    // The page's own word for where it is counts only at exactly the frame's origin (never a prefix: 127.0.0.1:41 is not 127.0.0.1:4100).
    if (typeof d.href === 'string' && originOf(d.href) === target) href = d.href;
    if (typeof d.title === 'string' && d.title !== getPage(tabId).title) setPage(tabId, { title: d.title.slice(0, 300) });
    if (d.hello) {
      if (!unregister) unregister = register(controller);
      return;
    }
    const w = typeof d.id === 'number' ? waiting.get(d.id) : undefined;
    if (!w) return;
    waiting.delete(d.id!);
    clearTimeout(w.timer);
    if (d.ok) w.resolve(d.value);
    else w.reject(new Error(String(d.error ?? 'The page did not run the script.').slice(0, 300)));
  };

  const controller: PageController = {
    sessionId,
    tabId,
    url: () => href,
    read: async (selector, max) => {
      const { readScript } = await import('./browser-agent');
      const r = (await controller.run(readScript(selector, max))) as { title?: string; text?: string; length?: number; missing?: boolean; badSelector?: boolean } | null;
      return { title: String(r?.title ?? ''), text: String(r?.text ?? ''), length: Number(r?.length) || 0, missing: r?.missing === true, badSelector: r?.badSelector === true };
    },
    capture: () => Promise.reject(new Error('Screenshots need the desktop app.')),
    run: (script) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error('The page did not answer in time.'));
        }, RUN_MS);
        waiting.set(id, { resolve, reject, timer });
        post({ sable: 'run', id, script });
      }),
    key: async () => false,
    history: (action) => {
      const p = getPage(tabId);
      if (action === 'reload') {
        setPage(tabId, { nonce: p.nonce + 1, loading: true, phase: 1 });
        return true;
      }
      const d = action === 'back' ? -1 : 1;
      if (p.index + d < 0 || p.index + d >= p.history.length) return false;
      stepHistory(tabId, d);
      return true;
    },
    ...pointer,
  };

  // Each load of the frame is a new document: ask again whether it takes part.
  const onLoad = () => {
    unregister?.();
    unregister = undefined;
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('The page went to another document.'));
    }
    waiting.clear();
    href = frame.src;
    post({ sable: 'hello' });
  };
  window.addEventListener('message', onMessage);
  frame.addEventListener('load', onLoad);
  if (frame.dataset.loaded !== undefined) onLoad();
  return () => {
    window.removeEventListener('message', onMessage);
    frame.removeEventListener('load', onLoad);
    unregister?.();
    for (const w of waiting.values()) clearTimeout(w.timer);
    waiting.clear();
  };
}
