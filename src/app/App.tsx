import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, cancelFrame, frame, motion, MotionConfig, type Variants } from 'motion/react';
import { Launch, launchPlays } from '@/art/LaunchLayer';
import { LogoMark, ProviderMark } from '@/art/Logo';
import { veil, VEIL_SWAP, VEIL_SWAP_AT } from '@/art/veil';
import { reducedMotion, uiZoom } from '@/lib/motion';
import { Home } from '@/features/home/Home';
import { handoffActive, handoffPhase, subscribeHandoff } from '@/features/home/handoff';
import { afterSend } from '@/features/composer/settle';
import { useOnboarding } from '@/features/onboarding/useOnboarding';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { Icon } from '@/icons';
import { windowShell } from '@/lib/desktop';
import { baseName, formatTokens } from '@/lib/format';
import { goHome, openSettings, renameSession, toggleTriage } from '@/state/actions';
import { useActiveProvider, useHotkey } from '@/state/hooks';
import { SessionAccount } from '@/features/accounts';
import { WaitingCount } from '@/features/triage/WaitingCount';
import { watchLimitWarnings } from '@/features/usage/near-limit';
import { LaneMark } from '@/features/session/LaneMark';
import { RaceMark, RaceTitle } from '@/features/race/RaceMark';
import { raceKey } from '@/features/race/race';
import { ChatMenu } from '@/features/export/ChatMenu';
import { shallow } from 'zustand/shallow';
import { useLaggedStore } from '@/lib/lagged';
import { railTabAt } from '@/features/rail/tabs';
import { useStore } from '@/state/store';
import { IconButton, Tip, TipProvider, Toasts } from '@/ui';
import { CapabilitiesButton } from './Capabilities';
import { loadSessionView, sessionViewNow } from './views';
import { WindowControls } from './WindowControls';
import './app.css';

// Surfaces that are not part of the first paint load on demand (and are prefetched once idle).
/**
 * A surface that loads on demand. Once its chunk has loaded (it is warmed in idle time) the surface
 * mounts in the same render: through React.lazy its first render would suspend even then, and a
 * suspended boundary is revealed about 300 ms later, so the first Ctrl+K, Settings, History or side
 * panel of a run opened a third of a second after the key. Decided once per mount, so a surface
 * never switches between the two.
 */
function onDemand<M, P extends object>(load: () => Promise<M>, pick: (m: M) => ComponentType<P>) {
  let mod: M | null = null;
  let pending: Promise<M> | null = null;
  const get = () =>
    (pending ??= load().then(
      (m) => (mod = m),
      (err) => {
        pending = null;
        throw err;
      },
    ));
  const Later = lazy(() => get().then((m) => ({ default: pick(m) as ComponentType<object> }))) as unknown as ComponentType<P>;
  function Part(props: P) {
    const [now] = useState(() => mod);
    if (now) {
      const Now = pick(now);
      return <Now {...props} />;
    }
    return <Later {...props} />;
  }
  return { load: get, Part };
}
const palette = onDemand(() => import('@/features/palette/Palette'), (m) => m.Palette);
const history = onDemand(() => import('@/features/history/History'), (m) => m.History);
const settings = onDemand(() => import('@/features/settings/Settings'), (m) => m.Settings);
const picker = onDemand(() => import('@/features/projects/ProjectPicker'), (m) => m.ProjectPicker);
const rail = onDemand(() => import('@/features/rail/Rail'), (m) => m.Rail);
const triage = onDemand(() => import('@/features/triage/Triage'), (m) => m.Triage);
const loadPalette = palette.load;
const loadHistory = history.load;
const loadSettings = settings.load;
const loadPicker = picker.load;
const loadRail = rail.load;
const loadTriage = triage.load;
const Palette = palette.Part;
const History = history.Part;
const Settings = settings.Part;
const ProjectPicker = picker.Part;
const Rail = rail.Part;
const Triage = triage.Part;
const loadRace = () => import('@/features/race/RaceView');
const RaceView = lazy(() => loadRace().then((m) => ({ default: m.RaceView })));
const LAZY_PART = {
  SessionView: lazy(() => loadSessionView().then((m) => ({ default: m.SessionView }))),
  SessionDock: lazy(() => loadSessionView().then((m) => ({ default: m.SessionDock }))),
  SessionLight: lazy(() => loadSessionView().then((m) => ({ default: m.SessionLight }))),
};

/**
 * A part of the session view. Its chunk is warmed on home, and once it has loaded the part mounts
 * in the same render: through React.lazy its first render would suspend even then, and a suspended
 * boundary is revealed up to 300 ms later (the first message from home would wait for it). Decided
 * once per mount, so a part never switches between the two.
 */
function SessionPart({ part, sessionId }: { part: keyof typeof LAZY_PART; sessionId: string }) {
  const [mod] = useState(sessionViewNow);
  if (mod) {
    const Now = mod[part];
    return <Now sessionId={sessionId} />;
  }
  const Later = LAZY_PART[part];
  return (
    <Suspense fallback={null}>
      <Later sessionId={sessionId} />
    </Suspense>
  );
}
const Onboarding = lazy(() => import('@/features/onboarding/Onboarding').then((m) => ({ default: m.Onboarding })));

/**
 * A window too narrow for three columns (about 1060 CSS px) keeps two: while the side panel is open there,
 * the sidebar steps aside without forgetting that it was open, and comes back when the panel closes.
 * Showing it again from the top bar closes the panel instead.
 */
const NARROW_PX = 1060;
/** Narrower than three columns need, in CSS pixels (the Interface size zooms the page). */
const isNarrow = () => window.innerWidth / (useStore.getState().settings.fontScale || 1) < NARROW_PX;
function useNarrow(): boolean {
  const zoom = useStore((s) => s.settings.fontScale);
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    const on = () => setNarrow(isNarrow());
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [zoom]);
  return narrow;
}

/** Whether the sidebar is shown: open, and not stepped aside for the panel in a narrow window. */
export function useSidebarShown(): boolean {
  const open = useStore((s) => s.ui.sidebarOpen);
  const squeezed = useStore((s) => s.ui.railOpen && !!s.ui.activeSessionId && !!s.sessions[s.ui.activeSessionId]);
  const narrow = useNarrow();
  return open && !(narrow && squeezed);
}

/** Mounts a lazy surface the first time it is asked for, then keeps it (so its exit animations run). */
function Deferred({ when, children }: { when: boolean; children: ReactNode }) {
  const [seen, setSeen] = useState(when);
  if (when && !seen) setSeen(true);
  return seen ? <Suspense fallback={null}>{children}</Suspense> : null;
}

/**
 * How the stage changes views:
 * - `swap` (session to session, session to home, home to a session from the list): the old view
 *   dissolves into the ground through the dither veil, the new one resolves out of it and rises a
 *   few pixels. The views only change opacity and transform: nothing is laid out again meanwhile.
 * - `handoff` (the first message sent from home): the composer flies to the dock (handoff.ts), the
 *   conversation fades in around it, and the home field lingers just long enough for the send's
 *   wave to cross it.
 * - `enter` (the first view, under the launch): no fade here; the launch and Home compose the arrival.
 * - `fade` (reduced motion, in place of a swap): a short crossfade, nothing moves.
 */
type ViewMode = 'swap' | 'handoff' | 'enter' | 'fade';
const EASE = [0.16, 1, 0.3, 1] as const;
/** When the veil is solid: the old view goes and the new one appears under it, in one frame. */
const SWAP_AT = (VEIL_SWAP / 1000) * VEIL_SWAP_AT;
const VIEW: Variants = {
  initial: (m: ViewMode) => (m === 'swap' ? { opacity: 0, y: 8 } : m === 'handoff' || m === 'fade' ? { opacity: 0 } : { opacity: 1 }),
  animate: (m: ViewMode) =>
    m === 'fade'
      ? { opacity: 1, y: 0, transition: { duration: 0.14 } }
      : m === 'swap'
      ? { opacity: 1, y: 0, transition: { opacity: { duration: 0.001, delay: SWAP_AT }, y: { duration: 0.36, delay: SWAP_AT, ease: EASE } } }
      : m === 'handoff'
        ? { opacity: 1, y: 0, transition: { duration: 0.32, delay: 0.08, ease: EASE } }
        : { opacity: 1, y: 0, transition: { duration: 0 } },
  exit: (m: ViewMode) =>
    m === 'fade'
      ? { opacity: 0, transition: { duration: 0.14 } }
      : m === 'swap'
      ? { opacity: 0, transition: { duration: 0.001, delay: SWAP_AT } }
      : m === 'handoff'
        ? // Holds while the wave from the send key crosses the field, then lets go: long enough
          // that its last light is still going down as the session's horizon starts to come up
          // (the stage is never plain black between the two).
          { opacity: 0, transition: { duration: 0.9, ease: [0.45, 0, 0.6, 0.6] } }
        : { opacity: 0, transition: { duration: 0.16 } },
};

/**
 * The window's first frame is the launch over an empty frame; the sidebar and the stage's view
 * mount right after it. On a large profile their first render and layout hold the page for a moment,
 * and the launch's light (drawn in a worker) is on screen meanwhile instead of after it. Without the
 * launch (automated development pages) everything mounts at once, as before.
 */
function useBuilt(): boolean {
  const [built, setBuilt] = useState(() => !launchPlays());
  useEffect(() => {
    if (built) return;
    const go = () => setBuilt(true);
    // After the frame that shows the launch; the timer in case no frame comes (a window not drawn).
    const raf = requestAnimationFrame(() => window.setTimeout(go, 0));
    const t = window.setTimeout(go, 150);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [built]);
  return built;
}

/** Which kind of change the stage is making (read while rendering the change, see ViewMode). */
function useViewMode(key: string | null, body: RefObject<HTMLElement | null>): ViewMode {
  const last = useRef(key);
  const mode = useRef<ViewMode>('enter');
  if (last.current !== key) mode.current = last.current == null ? 'enter' : handoffActive() ? 'handoff' : reducedMotion() ? 'fade' : 'swap';
  // Before paint: the veil's first frame lands in the same frame as the new view.
  useLayoutEffect(() => {
    if (last.current === key) return;
    const was = last.current;
    last.current = key;
    if (was != null && key != null && mode.current === 'swap') {
      // Session to session: the dock stays above the veil, so only the conversation dissolves.
      const el = body.current;
      if (el && was !== 'home' && key !== 'home') {
        el.setAttribute('data-session-swap', '');
        window.setTimeout(() => el.removeAttribute('data-session-swap'), VEIL_SWAP + 40);
      }
      void veil(el, 'swap');
    }
  }, [key, body]);
  return mode.current;
}

export function App() {
  const ready = useStore((s) => s.ready);
  const conn = useStore((s) => s.conn);
  const activeId = useStore((s) => s.ui.activeSessionId);
  const sidebarOpen = useSidebarShown();
  const railOpen = useStore((s) => s.ui.railOpen);
  const fontScale = useStore((s) => s.settings.fontScale);
  const setUi = useStore((s) => s.setUi);
  // The open session's id and title only: the shell must not re-render on every usage tick.
  const sessionId = useStore((s) => (activeId && s.sessions[activeId] ? activeId : null));
  const title = useStore((s) => (activeId ? s.sessions[activeId]?.title : undefined));
  const provider = useActiveProvider();
  // The launch (art/LaunchLayer.tsx) plays over the app from the window's first frame. The app itself
  // mounts the moment the bridge is ready, under it: nothing waits for the piece.
  const [launching, setLaunching] = useState(launchPlays);
  const endLaunch = useCallback(() => setLaunching(false), []);
  const launched = useRef(launching);
  const built = useBuilt();
  const booting = !ready;
  // First run: the welcome takes over the window; the app behind it waits, inert.
  const onboarding = useOnboarding(!booting);
  const stageBody = useRef<HTMLDivElement>(null);
  // The race view (features/race): both chats of a race side by side, while no session is open.
  const raceId = useOpenRace(sessionId);
  const viewKey = booting || onboarding || !built ? null : (sessionId ?? (raceId ? `race:${raceId}` : 'home'));
  const viewMode = useViewMode(viewKey, stageBody);
  // The panel waits while the first message's composer glides to the dock: the session mounts
  // first, the panel opens once the card has landed (only read while the panel is meant to be open).
  const handingOff = useSyncExternalStore(subscribeHandoff, () => railOpen && handoffPhase() === 'flying');
  const railShown = railOpen && !!sessionId && !handingOff;
  // Where the column cannot keep its width the panel slides over the conversation's edge and the
  // conversation takes its new width once, at the end (`railSteps`). Decided as the panel is
  // asked to open or close, from the page as it is then.
  const [railMode, setRailMode] = useState({ shown: railShown, step: false });
  if (railMode.shown !== railShown) setRailMode({ shown: railShown, step: railSteps(railShown) });
  const railStep = railMode.step;
  useRailMotion(railShown, railStep);
  // A closed panel keeps its contents while the session stays (inert, zero wide, its panes told
  // they are hidden): opening it again mounts nothing, and the Browser's pages are not loaded again.
  // Another session drops it; its own panel mounts when first opened.
  const [railKept, setRailKept] = useState<string | null>(null);
  if (railShown && sessionId && railKept !== sessionId) setRailKept(sessionId);
  const railMounted = !!sessionId && (railShown || railKept === sessionId);

  useEffect(() => {
    document.title = title ? `${title} · Sable` : 'Sable';
  }, [title]);

  // A toast as an account nears or reaches its plan limit (Claude Code and Codex alike).
  useEffect(() => watchLimitWarnings(), []);

  // Interface size scales everything (type, spacing, icons) the way browser zoom does.
  // Floating layers are positioned in unzoomed pixels and undo it (see `--ui-zoom` in ui.css).
  useEffect(() => {
    const root = document.documentElement.style;
    root.zoom = fontScale === 1 ? '' : String(fontScale);
    root.setProperty('--ui-zoom', String(fontScale));
  }, [fontScale]);

  const paletteOpen = useStore((s) => s.ui.paletteOpen);
  const historyOpen = useStore((s) => s.ui.historyOpen);
  const settingsOpen = useStore((s) => s.ui.settings !== null);
  const pickerOpen = useStore((s) => s.ui.projectPicker);
  const triageOpen = useStore((s) => !!s.ui.triageOpen);

  // Warm the on-demand chunks once the app is idle, so the first open is instant. The session view
  // first and soon (a send from home needs it), the rest when the window has nothing else to do.
  // Not while the launch plays: its release is the moment the window must not be busy.
  useEffect(() => {
    if (!ready || launching) return;
    // Right after the launch has gone (it ends on home at rest), else a moment after the bridge answered.
    const t = window.setTimeout(() => void loadSessionView().catch(() => {}), launched.current ? 150 : 600);
    const warm = () => void Promise.all([loadPalette(), loadRail(), loadSettings(), loadHistory(), loadPicker(), loadTriage(), loadRace()]).catch(() => {});
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(warm, { timeout: 4000 });
    else window.setTimeout(warm, 1500);
    return () => window.clearTimeout(t);
  }, [ready, launching]);

  useHotkey('mod+k', useCallback((e) => (e.preventDefault(), setUi({ paletteOpen: !useStore.getState().ui.paletteOpen })), [setUi]));
  useHotkey('mod+b', useCallback((e) => (e.preventDefault(), toggleSidebar(sidebarOpen)), [sidebarOpen]));
  useHotkey('mod+j', useCallback((e) => (e.preventDefault(), setUi({ railOpen: !useStore.getState().ui.railOpen })), [setUi]));
  useHotkey('mod+,', useCallback((e) => (e.preventDefault(), openSettings()), []));
  useHotkey('mod+shift+o', useCallback((e) => (e.preventDefault(), goHome()), []));
  useHotkey('mod+o', useCallback((e) => (e.preventDefault(), setUi({ projectPicker: true })), [setUi]));
  // Everything waiting on you across chats, as one stack of cards (features/triage).
  useHotkey('mod+i', useCallback((e) => (e.preventDefault(), toggleTriage()), []), { enabled: ready && !onboarding });
  // Alt+1 to Alt+8: the side panel's tabs in their order (features/rail/tabs.ts); opens the panel when it is closed.
  useEffect(() => {
    if (!sessionId) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const tab = /^Digit[1-8]$/.test(e.code) ? railTabAt(Number(e.code.slice(5))) : undefined;
      if (!tab) return;
      e.preventDefault();
      setUi({ railOpen: true, railTab: tab });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionId, setUi]);

  return (
    // Under reduced motion every motion/react element keeps its fades and drops its moves and springs.
    <MotionConfig reducedMotion="user">
      <TipProvider>
        <div className="app" data-provider={provider} data-sidebar={sidebarOpen}>
          <aside className="app-side" aria-hidden={!sidebarOpen || onboarding} inert={onboarding}>
            {built && <Sidebar />}
          </aside>

          <main className="stage" inert={onboarding}>
            <Topbar panelShown={railShown} />
            <div className="stage-body" ref={stageBody}>
              {/* Released once there is something under it: the bridge's answer and the view it opens onto. */}
              {launching && <Launch ready={ready && built} onDone={endLaunch} />}
              {/* The session's band of light, one field for every session (like the dock): a switch
                  changes its colour and pace, it is never built again. Under the conversation. */}
              <AnimatePresence initial={false} custom={viewMode}>
                {viewKey != null && sessionId && (
                  <motion.div key="light" className="stage-view stage-light" custom={viewMode} variants={VIEW} initial="initial" animate="animate" exit="exit">
                    <SessionPart part="SessionLight" sessionId={sessionId} />
                  </motion.div>
                )}
              </AnimatePresence>
              {/* After a send from home the conversation fades in around the docked composer, which must not move. */}
              <AnimatePresence mode="popLayout" initial={false} custom={viewMode}>
                {viewKey == null ? null : (
                  <motion.div key={viewKey} className="stage-view" custom={viewMode} variants={VIEW} initial="initial" animate="animate" exit="exit">
                    {sessionId ? (
                      <SessionPart part="SessionView" sessionId={sessionId} />
                    ) : raceId ? (
                      <Suspense fallback={null}>
                        <RaceView raceId={raceId} />
                      </Suspense>
                    ) : (
                      <Home />
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
              {/* The dock outlives a change of session (one key for all of them): only its contents follow.
                  Coming from or going to home it arrives and leaves with the view. */}
              <AnimatePresence initial={false} custom={viewMode}>
                {viewKey != null && sessionId && (
                  <motion.div key="dock" className="stage-dock" custom={viewMode} variants={VIEW} initial="initial" animate="animate" exit="exit">
                    <SessionPart part="SessionDock" sessionId={sessionId} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {ready && conn !== 'open' && (
              <div className="offline glass-rim" role="status">
                <span className="spinner" />
                Reconnecting to the bridge
              </div>
            )}
          </main>

          <AnimatePresence initial={false} onExitComplete={railGone}>
            {railMounted && (
              <motion.aside
                key="rail"
                className="app-rail"
                data-open={railShown || undefined}
                inert={!railShown}
                // The panel's contents resolve through the dither veil (and dissolve into it on close),
                // so only reduced motion fades them.
                initial={{ width: 0, opacity: reducedMotion() ? 0 : 1 }}
                animate={railShown ? { width: 'var(--rail-fit)', opacity: 1 } : { width: 0, opacity: reducedMotion() ? 0 : 1 }}
                exit={{ width: 0, opacity: reducedMotion() ? 0 : 1, transition: RAIL_SPRING }}
                // Just past critical damping: the edge arrives without passing its place, so nothing
                // beside it ever moves back. Where the panel slides over the conversation instead
                // (`slideRail`), the width is set in one step when the slide ends: this only
                // confirms it a moment later.
                transition={railStep ? { duration: 0, delay: (railShown ? RAIL_SLIDE_IN : RAIL_SLIDE_OUT).duration / 1000 + 0.08 } : RAIL_SPRING}
                // Closed but kept: the same clean-up as when it leaves the page.
                onAnimationComplete={railShown ? releaseRail : railGone}
              >
                <div className="app-rail-inner">
                  <Suspense fallback={null}>
                    <Rail sessionId={sessionId} open={railShown} />
                  </Suspense>
                </div>
              </motion.aside>
            )}
          </AnimatePresence>

          <Deferred when={paletteOpen}>
            <Palette />
          </Deferred>
          <Deferred when={historyOpen}>
            <History />
          </Deferred>
          <Deferred when={settingsOpen}>
            <Settings />
          </Deferred>
          <Deferred when={pickerOpen}>
            <ProjectPicker />
          </Deferred>
          <Deferred when={triageOpen}>
            <Triage />
          </Deferred>
          {/* While its chunk loads, a plain sheet keeps the waiting app from showing through. */}
          <Suspense fallback={onboarding ? <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'var(--sheet)' }} /> : null}>
            <AnimatePresence>{onboarding && <Onboarding key="onboarding" />}</AnimatePresence>
          </Suspense>
          <Toasts />
        </div>
        {/* Outside .app (an isolated stacking context) so the controls stay above dialogs and the welcome. */}
        <WindowControls />
      </TipProvider>
    </MotionConfig>
  );
}

/**
 * Opening and closing the side panel. The panel's width springs and the stage beside it narrows
 * or widens with it. What the conversation does depends on whether its column keeps its width:
 * - Room for the whole column at both ends: the view keeps one width meanwhile (the narrower of
 *   the two, through the freeze rule in app.css) and is slid each frame so its column glides
 *   exactly where the resizing stage puts it. Nothing wraps, nothing is laid out again.
 * - The column has to narrow (or widen): the view follows the stage's edge live, so the column's
 *   left edge and width change as one continuous movement and lines wrap once, in one direction.
 *   Holding one width here would wrap the text in a single frame at the start or the end, with the
 *   column jumping by half the difference: the twitch.
 * The panel's contents resolve through the dither veil on open and dissolve into it on close.
 */
const railMotion = { body: null as HTMLElement | null, total: 0, wide: 0, timer: 0, until: 0 };

function releaseRail() {
  const m = railMotion;
  window.clearTimeout(m.timer);
  if (!m.body) return;
  delete m.body.dataset.freeze;
  m.body.style.removeProperty('--freeze-w');
  for (const v of m.body.querySelectorAll<HTMLElement>(':scope > .stage-view')) v.style.removeProperty('translate');
  m.body = null;
}

/** The panel has gone: the top bar keeps the whole room for the window controls again (the exit
    reports no frames, so --rail-live would otherwise stay at the open panel's value). */
function railGone() {
  cancelFrame(railTick);
  releaseRail();
  clearRailCover();
  document.querySelector<HTMLElement>('.stage > .topbar')?.style.removeProperty('--rail-live');
}

/**
 * A cover stays in its host once played (the host normally goes with it). A panel that is closed but
 * kept keeps its host: the cover is taken off once the panel has closed, and before it opens again.
 */
function clearRailCover() {
  for (const v of document.querySelectorAll<HTMLElement>('.app-rail-inner > .veil')) v.remove();
}

function freezeForRail(opening: boolean) {
  releaseRail();
  if (opening) clearRailCover();
  if (reducedMotion()) return;
  // A narrow window trades the sidebar for the panel at the same time: the stage moves at both edges.
  if (isNarrow() && useStore.getState().ui.sidebarOpen) return;
  const body = document.querySelector<HTMLElement>('.stage > .stage-body');
  const app = document.querySelector<HTMLElement>('.app');
  if (!body || !app || body.dataset.freeze != null) return;
  const z = uiZoom();
  const now = (document.querySelector('.app-rail')?.getBoundingClientRect().width ?? 0) / z;
  // The panel's width as it will be drawn (--rail-fit: the chosen width, narrowed to what the window allows).
  const target = opening ? (document.querySelector<HTMLElement>('.app-rail-inner')?.offsetWidth ?? 396) : 0;
  const b0 = body.clientWidth;
  const b1 = b0 + now - target;
  // Contents: resolve on open (after the panel has mounted), dissolve on close.
  const inner = document.querySelector<HTMLElement>('.app-rail-inner');
  if (inner) void veil(inner, opening ? 'reveal' : 'cover', { duration: opening ? 320 : 150 });
  if (!(b1 > 0)) return;
  // The column as drawn now (the dock's is the conversation's). Holding one width is only right
  // when the narrower stage still has room for it, gutters and scrollbar included.
  const column = body.querySelector<HTMLElement>('.dock-inner')?.offsetWidth ?? 0;
  if (!(column > 0) || Math.min(b0, b1) < column + COLUMN_ROOM) return;
  railMotion.body = body;
  railMotion.total = b0 + now;
  // The narrower of the two: the conversation takes its narrow layout once (at the start when the
  // panel opens, at the end when it closes) and is never clipped by the moving edge.
  railMotion.wide = Math.min(b0, b1);
  body.style.setProperty('--freeze-w', `${railMotion.wide}px`);
  body.dataset.freeze = 'rail';
  // Placed for the first frame already (the spring reports its first value a frame later).
  for (const v of body.querySelectorAll<HTMLElement>(':scope > .stage-view')) v.style.translate = `${((railMotion.wide - b0) / 2).toFixed(2)}px 0`;
  railMotion.timer = window.setTimeout(releaseRail, 1200);
}

/** What the column needs beside itself to keep its width: 24 px gutters and the scroller's two gutters. */
const COLUMN_ROOM = 2 * 24 + 36;

/** The frozen view slides to where the stage's centre is now, for a panel `w` wide. */
function followRail(w: number) {
  const m = railMotion;
  if (!m.body) return;
  const tx = (m.wide - (m.total - w)) / 2;
  for (const v of m.body.querySelectorAll<HTMLElement>(':scope > .stage-view')) v.style.translate = `${tx.toFixed(2)}px 0`;
}

/**
 * Every frame while the panel's width is in motion, right after motion has written it and before
 * the frame is painted: the panel's width is read as drawn, and what follows it is placed for that
 * same frame. (The spring's own reports cannot be used: its target is a CSS variable, whose frames
 * are not numbers, and an exit reports none at all. A view that waited for them stood still at the
 * stage's moving edge and jumped into place at the end.)
 */
function railTick() {
  const rail = document.querySelector<HTMLElement>('.app-rail');
  const w = rail ? rail.getBoundingClientRect().width / uiZoom() : 0;
  trackRailWidth?.(w);
  followRail(w);
  if (performance.now() > railMotion.until) cancelFrame(railTick);
}

function watchRail() {
  railMotion.until = performance.now() + 1400;
  frame.postRender(railTick, true);
}

function useRailMotion(shown: boolean, step: boolean) {
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (step) {
      releaseRail();
      if (shown) clearRailCover();
      slideRail(shown);
    } else {
      stopRailSlide();
      freezeForRail(shown);
    }
    watchRail();
    // `step` is decided in the render that changes `shown`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  useEffect(
    () => () => {
      cancelFrame(railTick);
      releaseRail();
      stopRailSlide();
    },
    [],
  );
}

const RAIL_SPRING = { type: 'spring', stiffness: 400, damping: 42 } as const;
/**
 * The slide (a compositor animation). In: it arrives decelerating, like the spring. Out: it leaves
 * without a tail, so the stage widens the moment the panel has gone (on the spring's long tail the
 * stage stood narrow beside an empty strip for a quarter of a second).
 */
const RAIL_SLIDE_IN = { duration: 300, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };
const RAIL_SLIDE_OUT = { duration: 220, easing: 'cubic-bezier(0.35, 0, 0.5, 1)' };
const railSlide = { anim: null as Animation | null, aside: null as HTMLElement | null };

/**
 * Whether the conversation's column has to change its width for the panel (the window has no room
 * to keep it). Following the stage's edge live there wrapped every line of the conversation again
 * on each frame of the spring. Instead the conversation keeps the width it has while the panel
 * slides over its edge (opening) or out (closing), a transform on the compositor, and takes its
 * new width in one step when the slide has ended: one wrap, with the line the reader is on kept
 * where it is. A window with room for the column at both ends is not touched by this.
 */
function railSteps(opening: boolean): boolean {
  if (reducedMotion()) return false;
  // A narrow window trades the sidebar for the panel at the same time: the stage moves at both edges.
  if (isNarrow() && useStore.getState().ui.sidebarOpen) return false;
  const body = document.querySelector<HTMLElement>('.stage > .stage-body');
  const app = document.querySelector<HTMLElement>('.app');
  const column = body?.querySelector<HTMLElement>('.dock-inner')?.offsetWidth ?? 0;
  if (!body || !app || !(column > 0)) return false;
  const now = (document.querySelector('.app-rail')?.getBoundingClientRect().width ?? 0) / uiZoom();
  let fit = document.querySelector<HTMLElement>('.app-rail-inner')?.offsetWidth ?? 0;
  if (!fit) {
    // The panel has not been made yet: its width as the stylesheet will give it.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;height:0;width:var(--rail-fit)';
    app.appendChild(probe);
    fit = probe.offsetWidth;
    probe.remove();
  }
  const b0 = body.clientWidth;
  const b1 = b0 + now - (opening ? fit : 0);
  return b1 > 0 && Math.min(b0, b1) < column + COLUMN_ROOM;
}

function stopRailSlide() {
  const { anim, aside } = railSlide;
  railSlide.anim = railSlide.aside = null;
  anim?.cancel();
  if (aside) delete aside.dataset.step;
}

/** The panel slides in over the stage's edge, or out; the stage takes its new width when it has. */
function slideRail(opening: boolean) {
  const aside = document.querySelector<HTMLElement>('.app-rail');
  const inner = aside?.querySelector<HTMLElement>(':scope > .app-rail-inner');
  if (!aside || !inner) return stopRailSlide();
  const fit = inner.offsetWidth;
  // From where the panel is drawn now: in place, away, or part of the way (a second press).
  let from = opening ? fit : 0;
  const was = railSlide.anim;
  if (was && railSlide.aside === aside && was.playState === 'running') from = new DOMMatrixReadOnly(getComputedStyle(inner).transform).m41;
  stopRailSlide();
  // Not laid out yet (opening): the panel is drawn over the stage, out of its column of no width.
  if (aside.getBoundingClientRect().width < 1) aside.dataset.step = '';
  const anim = inner.animate([{ transform: `translateX(${from.toFixed(2)}px)` }, { transform: `translateX(${opening ? 0 : fit}px)` }], { ...(opening ? RAIL_SLIDE_IN : RAIL_SLIDE_OUT), fill: 'both' });
  railSlide.anim = anim;
  railSlide.aside = aside;
  anim.finished.then(
    () => {
      if (railSlide.anim !== anim) return;
      stepRailWidth(aside, opening ? fit : 0);
      stopRailSlide();
    },
    () => {},
  );
}

/**
 * The stage's one step to its new width. The line under the reader's eyes stays where it is: what
 * stands near the top of the view is found before the step and put back there after it (a view
 * that follows the end keeps the end, Timeline.tsx).
 */
function stepRailWidth(aside: HTMLElement, width: number) {
  const scroller = document.querySelector<HTMLElement>('.stage .tl-scroll');
  let anchor: Element | null = null;
  let top = 0;
  if (scroller) {
    const r = scroller.getBoundingClientRect();
    for (const dy of [56, 96, 150, 220]) {
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + dy)?.closest('.md > *, .tl-item');
      if (hit && scroller.contains(hit)) {
        anchor = hit;
        top = hit.getBoundingClientRect().top;
        break;
      }
    }
  }
  aside.style.width = `${width}px`;
  if (!anchor || !scroller) return;
  const d = anchor.getBoundingClientRect().top - top;
  if (Math.abs(d) > 0.5) scroller.scrollTop += d;
}

/**
 * While the panel opens or closes, the stage's top bar hands the room kept for the window controls
 * over to the panel frame by frame (--rail-live, app.css), so its actions never pass under them.
 * Set on the top bar alone: a custom property on .app would restyle the whole tree every frame.
 */
const trackRailWidth = windowShell
  ? (w: number) => {
      const bar = document.querySelector<HTMLElement>('.stage > .topbar');
      if (bar) bar.style.setProperty('--rail-live', `${w.toFixed(1)}px`);
    }
  : undefined;

/** How full the context window is; its own subscription so usage ticks re-render only this. */
function ContextMeter({ sessionId }: { sessionId: string }) {
  // Only what the meter shows: a usage tick that changes neither the label nor the percentage renders nothing.
  const shown = useStore((s) => {
    const u = s.sessions[sessionId]?.usage;
    if (!u?.contextTokens || !u.contextWindow) return '';
    return `${Math.min(100, Math.round((u.contextTokens / u.contextWindow) * 1000) / 10)}|${formatTokens(u.contextTokens)}|${formatTokens(u.contextWindow)}`;
  });
  const setUi = useStore((s) => s.setUi);
  if (!shown) return null;
  const [p, used, max] = shown.split('|');
  const pct = Number(p);
  // A ring drawn on the icons' 16 px grid: a hairline track and a 1.5 px arc, so it weighs what the line icons beside it weigh.
  return (
    <Tip label={`${used} of ${max} context used`}>
      <button type="button" className="ctx-meter" onClick={() => setUi({ railOpen: true, railTab: 'context' })} data-warn={pct > 80 || undefined} aria-label={`Context ${Math.round(pct)}% used`}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1" />
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" pathLength={100} strokeDasharray={`${Math.max(1.5, pct)} 100`} transform="rotate(-90 8 8)" />
        </svg>
        <span className="num">{Math.round(pct)}%</span>
      </button>
    </Tip>
  );
}

/**
 * The session's title. A double-click (or Enter on it from the keyboard) renames it in place, the
 * same rename the sidebar row offers; Enter or leaving the field saves, Escape keeps the old title.
 */
function TitleName({ id, title }: { id: string; title: string }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <TitleField id={id} title={title} onDone={() => setEditing(false)} />;
  return (
    <button
      type="button"
      className="truncate topbar-name"
      aria-label={`${title}. Rename`}
      onDoubleClick={() => setEditing(true)}
      // A click from the keyboard (Enter or Space) has no pointer detail.
      onClick={(e) => e.detail === 0 && setEditing(true)}
    >
      {title}
    </button>
  );
}

function TitleField({ id, title, onDone }: { id: string; title: string; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(title);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    if (save && next && next !== title) void renameSession(id, next);
    const hadFocus = ref.current === document.activeElement;
    onDone();
    // Back to the title, so the keys carry on from where they were.
    if (hadFocus) requestAnimationFrame(() => document.querySelector<HTMLElement>('.topbar .topbar-name')?.focus());
  };
  return (
    <input
      ref={ref}
      className="topbar-rename"
      value={value}
      aria-label="Session title"
      spellCheck={false}
      // Grows with the title, inside what the bar has room for.
      style={{ width: `calc(${Math.max(8, value.length + 2)}ch + 14px)` }}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(true);
        else if (e.key === 'Escape') commit(false);
      }}
      onBlur={() => commit(true)}
    />
  );
}

/** The race the stage shows: `ui.race` while no session is open and both of its chats are there. */
function useOpenRace(sessionId: string | null): string | null {
  return useStore((s) => (!sessionId && s.ui.race && raceKey(s, s.ui.race) ? s.ui.race : null));
}

/** Shows or hides the sidebar as it is drawn now: one stepped aside for the panel comes back by closing the panel. */
function toggleSidebar(shown: boolean) {
  const { ui, setUi } = useStore.getState();
  if (shown) setUi({ sidebarOpen: false });
  else if (ui.sidebarOpen) setUi({ railOpen: false });
  else setUi({ sidebarOpen: true });
}

/** What the bar shows of the open session (usage ticks while streaming change the session, not these). */
function selectBarSession(s: ReturnType<typeof useStore.getState>) {
  const id = s.ui.activeSessionId;
  const m = id ? s.sessions[id] : undefined;
  return m ? { id: m.id, provider: m.provider, accountId: m.accountId, title: m.title, cwd: m.cwd, branch: m.branch, laneFolder: m.lane?.folder, chat: !!m.chat } : undefined;
}

/** The bar follows the stage a task behind, and after a sent message has landed (see useLaggedStore). */
const BAR_LAG = { gate: afterSend };

/** `panelShown`: the side panel is on screen and carries its own toggle, in the place this one leaves. */
function Topbar({ panelShown }: { panelShown: boolean }) {
  const sidebarOpen = useSidebarShown();
  const railOpen = useStore((s) => s.ui.railOpen);
  const setUi = useStore((s) => s.setUi);
  // A session mounting does not build the bar's crumbs, account and switches in the same task, and
  // the first message from home lands before they are drawn (the meter subscribes itself).
  const session = useLaggedStore(selectBarSession, shallow, BAR_LAG);
  const raceId = useOpenRace(session?.id ?? null);
  return (
    <header className="topbar">
      {/* The mark first, where the sidebar's own mark stands: closing, it stays (sidebar/brand-flight.ts
          glides it the few pixels between the two) and the toggle rides in on the stage's edge. Its slot
          is always here, closed while the sidebar shows: it opens and closes on the sidebar's own frames
          (app.css), so the toggle and the title never step by its width. */}
      <button type="button" className="topbar-home" onClick={() => goHome()} aria-label="New session" inert={sidebarOpen} aria-hidden={sidebarOpen || undefined} tabIndex={sidebarOpen ? -1 : undefined}>
        <LogoMark size={18} />
      </button>
      <IconButton icon="sidebar" label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} keys="mod+b" onClick={() => toggleSidebar(sidebarOpen)} />

      {session ? (
        <div className="topbar-title">
          <ProviderMark provider={session.provider} size={15} />
          <TitleName key={session.id} id={session.id} title={session.title} />
          <span className="topbar-crumb">
            {/* A chat without a folder: its own folder is named after its first message, so the title already says it. */}
            {!session.chat && (
              <span className="topbar-crumb-item">
                <Icon name="folder" size={13} />
                {/* A chat in a lane names its folder, and its lane in place of the branch. */}
                <span className="truncate">{baseName(session.laneFolder ?? session.cwd)}</span>
              </span>
            )}
            {!session.chat && !session.laneFolder && session.branch && (
              <span className="topbar-crumb-item">
                <Icon name="branch" size={13} />
                <span className="truncate">{session.branch}</span>
              </span>
            )}
            {/* A chat that races another: opens both side by side. */}
            <RaceMark sessionId={session.id} />
            {/* The account, when its agent has several: opens "Continue with another account". */}
            <LaneMark key={session.id} sessionId={session.id} />
            <SessionAccount sessionId={session.id} />
          </span>
        </div>
      ) : raceId ? (
        <RaceTitle raceId={raceId} />
      ) : (
        <div className="grow" />
      )}

      <div className="topbar-actions">
        <WaitingCount />
        {session && <ContextMeter sessionId={session.id} />}
        {session && <CapabilitiesButton sessionId={session.id} />}
        {session && <ChatMenu sessionId={session.id} />}
        {/* The sidebar's top row has the search; the bar shows it only while the sidebar is away. */}
        {!sidebarOpen && <IconButton icon="search" label="Search and commands" keys="mod+k" onClick={() => setUi({ paletteOpen: true })} />}
        {/* While the panel shows, its own header carries this toggle at this same spot (beside the
            window controls), so one place opens and closes it: this one folds away meanwhile. */}
        {session && (
          <span className="topbar-panel" data-away={panelShown || undefined} inert={panelShown}>
            <IconButton
              icon="sidebar"
              label={railOpen ? 'Hide panel' : 'Show panel'}
              keys="mod+j"
              active={railOpen}
              className="flip-x"
              onClick={() => setUi({ railOpen: !railOpen })}
            />
          </span>
        )}
      </div>
    </header>
  );
}
