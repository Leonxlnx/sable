import { Capacitor } from '@capacitor/core';
import type { SessionMeta } from '@shared/protocol';
import { worksNow } from './chat-rules';
import { System } from './system-plugin';

/** What the widget reads of the store (lib/store.ts `getState`, handed in). */
type Read = () => { conn: string; sessions: Readonly<Record<string, SessionMeta>>; desktop?: string; fresh?: boolean };

/**
 * The home-screen widget's figures (2.22, NowWidget.java): the chats at work (their turn, or what
 * they left working: `worksNow`, the shared rule) and those waiting on the person, from the chats'
 * list as the desktop last sent it. Written when the figures change and again every ten minutes while
 * the page lives (the widget does not believe figures older than a quarter hour: the app may have been
 * closed since). Nothing while the phone is not paired; zeros after Forget.
 */

export function widgetCounts(sessions: Readonly<Record<string, SessionMeta>>): { working: number; waiting: number } {
  let working = 0;
  let waiting = 0;
  for (const s of Object.values(sessions)) {
    if (s.archived) continue;
    if (s.status === 'awaiting') waiting++;
    else if (worksNow(s)) working++;
  }
  return { working, waiting };
}

const AGAIN_MS = 10 * 60_000;

/** A store listener: the widget follows the figures (a write at most twice a second). */
export function watchWidget(getState: Read): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  let last = '';
  let wrote = 0;
  let timer = 0;
  const write = () => {
    timer = 0;
    const st = getState();
    const c = st.conn === 'unpaired' ? { working: 0, waiting: 0 } : widgetCounts(st.sessions);
    const key = `${c.working}|${c.waiting}|${st.desktop ?? ''}`;
    if (key === last && Date.now() - wrote < AGAIN_MS) return;
    // Not heard from the desktop yet: the figures it last said stand on the widget until it answers.
    if (st.conn !== 'unpaired' && !st.fresh) return;
    last = key;
    wrote = Date.now();
    void System.widget({ ...c, ...(st.desktop ? { desktop: st.desktop } : {}) }).catch(() => {});
  };
  const again = window.setInterval(write, AGAIN_MS);
  return () => {
    if (!timer) timer = window.setTimeout(write, 500);
    // (the interval lives as long as the page: the store listener's own stop is never needed)
    void again;
  };
}
