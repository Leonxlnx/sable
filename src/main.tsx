import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import './styles/ui.css';
import { App } from './app/App';
import { openCustomize } from './features/customize/custom-store';
import { startCustomLive } from './features/customize/live';
import { bootMark } from './lib/boot';
import { bridge } from './lib/bridge';
import * as actions from './state/actions';
import { startBridge, useStore } from './state/store';
import { startSpot } from './ui/spot';

bootMark('main');

// The desktop shell's preload exposes this; app.css uses the attribute for the title bar.
const desktop = (window as { sableDesktop?: { platform: string; debug?: boolean } }).sableDesktop;
if (desktop) document.documentElement.dataset.desktop = desktop.platform;

startBridge();
startSpot();
// The person's own stylesheet swapped live, and `custom.ready` (Customize Sable).
startCustomLive();

// A hidden document (minimised or fully covered) holds its looping CSS animations still
// (base.css, :root[data-hidden]). Only hidden, never merely unfocused: a visible window that
// is not focused keeps its spinners moving, or a working session would look hung.
{
  const root = document.documentElement;
  const mark = () => {
    if (document.hidden) root.dataset.hidden = '';
    else delete root.dataset.hidden;
  };
  document.addEventListener('visibilitychange', mark);
  mark();
}

if (import.meta.env.DEV || desktop?.debug) {
  // Console helpers for development and desktop verification runs (--eval, SABLE_PERF=1):
  // sable.demo('refactor the session module')
  (window as unknown as Record<string, unknown>).sable = {
    store: useStore,
    actions,
    bridge,
    async demo(prompt = 'refactor the session module', opts: { mode?: string; cwd?: string } = {}) {
      const s = useStore.getState();
      const cwd = opts.cwd ?? s.ui.homeCwd ?? s.projects[0]?.path ?? s.home;
      const session = await actions.createSession({ provider: 'demo', cwd, mode: opts.mode });
      if (session && prompt) await actions.sendMessage(session.id, prompt);
      return session?.id;
    },
    /** Opens the Customize chat and sends `text` (`provider: 'demo'` for checks without quota). */
    customize: (text?: string, provider?: 'demo' | 'claude' | 'codex') => openCustomize(text, provider),
  };
}

// Dev only: `?gallery` shows every control in every state (src/dev). Dropped from production builds.
const Gallery = import.meta.env.DEV && new URLSearchParams(location.search).has('gallery') ? lazy(() => import('./dev/Gallery')) : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {Gallery ? (
      <Suspense>
        <Gallery />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
