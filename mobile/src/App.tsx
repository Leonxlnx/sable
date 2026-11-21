import { animate } from 'motion';
import { AnimatePresence, motion, usePresence } from 'motion/react';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionMeta } from '@shared/protocol';
import { goBack, pushBack } from '@m/lib/back';
import { conn } from '@m/lib/conn';
import { clearNotification, forgetNotificationLines, haptic, inForeground, keepAlive, notify, onAppState, onBackButton, onNotificationTap, onPairLink, setShortcuts } from '@m/lib/native';
import { chatOf, nav, routeKey, useNav, type Route } from '@m/lib/nav';
import { rowOf, takeOrigin, type Origin } from '@m/lib/open';
import { pruneComments } from '@m/lib/comments';
import { takeSwap } from '@m/lib/race';
import { closeSessionData, getState, hasCachedHome, loadCachedHome, refresh, setState, subscribeStore, useStore } from '@m/lib/store';
import '@m/lib/keyboard';
import { fieldBeat } from '@m/ui/Field';
import { Launch } from '@m/ui/Launch';
import { ProviderMark, StatusMark } from '@m/ui/marks';
import { nowOf, reduced, SNAP, SPRING } from '@m/ui/motion';
import { Viewer } from '@m/ui/Viewer';
import { MessageMenu } from './screens/MessageMenu';
import { Home } from './screens/Home';
import { Pair } from './screens/Pair';
import { prefs, Settings } from './screens/Settings';

// The conversation (markdown, steps, composer) loads as its own chunk: home draws first, then it is fetched while idle.
const loadChat = () => import('./screens/Chat');
const Chat = lazy(() => loadChat().then((m) => ({ default: m.Chat })));
// A chat's changes and a file's diff: their own chunk, fetched after the chat's.
const loadChanges = () => import('./screens/Changes');
const ChangesScreen = lazy(() => loadChanges().then((m) => ({ default: m.ChangesScreen })));
const DiffScreen = lazy(() => loadChanges().then((m) => ({ default: m.DiffScreen })));

/** Notifies when a turn ends or starts waiting on you while the app is in the background. */
function watchTurns() {
  let last: Record<string, SessionMeta['status']> = {};
  let seeded = false;
  let prev = getState().sessions;
  let listAt = getState().listAt;
  return () => {
    const { sessions } = getState();
    if (sessions === prev) return;
    prev = sessions;
    // A whole new list on screen (a reconnect after time away): what changed meanwhile is not news (no
    // wave, no haptic); it seeds again. In the background it still is: the phone was following.
    if (getState().listAt !== listAt) {
      listAt = getState().listAt;
      if (inForeground()) seeded = false;
    }
    const next: typeof last = {};
    for (const s of Object.values(sessions)) {
      next[s.id] = s.status;
      const was = last[s.id];
      if (!seeded || !was || was === s.status) continue;
      const ended = (was === 'running' || was === 'awaiting') && (s.status === 'idle' || s.status === 'error');
      const waits = s.status === 'awaiting' && was !== 'awaiting';
      if (ended && s.status === 'idle') {
        // The ring closes on the composer of the chat on screen (or on home's field).
        fieldBeat('done', [...document.querySelectorAll('.layer')].pop()?.querySelector('.composer') ?? document.querySelector('.home-dock'));
        // Felt while the app is open: clearly for the chat on screen, a tick for one elsewhere.
        if (inForeground()) haptic(chatOf(nav.stack[nav.stack.length - 1]) === s.id ? 'success' : 'select');
      }
      if (!waits && !ended) continue;
      if (waits && inForeground()) {
        // Waiting on you somewhere else than on screen: felt once, and said at the top when home is covered.
        const top = nav.stack[nav.stack.length - 1];
        if (chatOf(top) !== s.id) {
          haptic('warning');
          if (top) setState({ attention: { id: s.id, at: Date.now() } });
        }
      }
      if (inForeground() || !prefs.notify) continue;
      if (waits) void notify(s.title, 'Waiting for you', s.id, 'waiting');
      else if (ended) void notify(s.title, s.status === 'error' ? (s.lastError ?? 'Stopped with an error') : 'Done', s.id, 'done');
    }
    last = next;
    seeded = true;
    // Something at work: the connection stays when the app leaves the screen (to say when it ends or waits).
    const busy = Object.values(sessions).filter((s) => !s.archived && (s.status === 'running' || s.status === 'starting' || s.status === 'awaiting'));
    keepAlive(prefs.notify && busy.length && getState().conn !== 'unpaired' ? (busy.length === 1 ? busy[0].title : `${busy.length} chats`) : null);
  };
}

/** The app icon's shortcuts follow the two chats with the latest activity (besides "New chat"). */
function watchShortcuts() {
  let prev = getState().sessions;
  let timer = 0;
  const sync = () => {
    timer = 0;
    const recent = Object.values(getState().sessions)
      .filter((s) => !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 2)
      .map((s) => ({ id: s.id, title: s.title }));
    setShortcuts(recent);
  };
  return () => {
    const { sessions, fresh } = getState();
    if (sessions === prev || !fresh) return;
    prev = sessions;
    if (!timer) timer = window.setTimeout(sync, 4000);
  };
}

export function App() {
  const state = useStore((s) => s.conn);
  const error = useStore((s) => s.connError);
  const stack = useNav();
  const [link, setLink] = useState<string | null>(null);
  // The list from the last run draws in the first frame (read synchronously); without one, nothing is drawn
  // until the saved pairing is read (a few ms), so no pairing screen flashes at a cold start.
  const [ready, setReady] = useState(() => {
    if (!hasCachedHome()) return false;
    loadCachedHome();
    nav.restore();
    return true;
  });
  // The launch plays once per start, over home (from the cache, or right after pairing).
  const [launch, setLaunch] = useState<'pending' | 'on' | 'done'>(() => (hasCachedHome() ? 'on' : 'pending'));
  const wasPairing = useRef(false);

  useEffect(() => {
    const offs = [
      conn.onOpen(() => {
        const open = nav.stack.filter((r) => r.name === 'chat').map((r) => (r as { id: string }).id);
        void refresh(open)
          .then(() => {
            nav.prune((id) => !!getState().sessions[id]);
            pruneComments((id) => !!getState().sessions[id]);
          })
          .catch(() => {});
      }),
      onAppState((active) => {
        if (active) {
          forgetNotificationLines();
          const id = chatOf(nav.stack[nav.stack.length - 1]);
          if (id) clearNotification(id);
          conn.wake();
        } else conn.sleep();
      }),
      onBackButton(goBack),
      pushBack(() => nav.pop()),
      onPairLink((url) => {
        // The app icon's shortcuts: a new chat (home's bar, focused), or one of the last chats.
        const m = /^sable:\/\/(new|chat)(?:\/([^/?#]+))?/i.exec(url);
        if (!m) return setLink(url);
        if (m[1].toLowerCase() === 'new') {
          nav.reset();
          window.setTimeout(() => window.dispatchEvent(new Event('sable:newchat')), 350);
        } else if (m[2]) nav.chat(decodeURIComponent(m[2]));
      }),
      // A notification opens its chat where it matters: the prompt waiting (its sheet opens by itself), or the newest turn.
      onNotificationTap((id, kind) => (kind === 'home' ? nav.reset() : nav.chat(id, kind === 'done' ? 'turn' : undefined))),
    ];
    const stopWatch = subscribeStore(watchTurns());
    const stopShortcuts = subscribeStore(watchShortcuts());
    const idle = window.setTimeout(() => void loadChat().then(() => window.setTimeout(() => void loadChanges(), 800)), 400);
    // Back where it was: Android may have closed the app in the background.
    void conn.init().then(() => {
      // The list of chats as it was last time, at once; the desktop's answer replaces it.
      if (conn.pairing) loadCachedHome(), nav.restore();
      setReady(true);
    });
    return () => {
      offs.forEach((f) => f());
      stopWatch();
      stopShortcuts();
      clearTimeout(idle);
    };
  }, []);

  // A chat on screen: its notification has been read.
  const topChat = chatOf(stack[stack.length - 1]);
  useEffect(() => {
    if (topChat && inForeground()) clearNotification(topChat);
  }, [topChat]);

  // Data for chats that are no longer on screen is dropped (the snapshot reloads it), once the screen
  // that showed it has left: dropped at once, the chat on its way out showed its skeleton for its last frames.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const open = new Set(nav.stack.map(chatOf).filter(Boolean));
      for (const id of Object.keys(getState().data)) if (!open.has(id)) closeSessionData(id);
    }, 900);
    return () => clearTimeout(t);
  }, [stack]);

  const unpaired = state === 'unpaired' || (state === 'denied' && !getState().loaded);
  const pairing = unpaired || !!link;
  // Leaving the pairing screen for home: the launch plays from the pairing mark.
  useEffect(() => {
    if (pairing) wasPairing.current = true;
    else if (wasPairing.current && ready) {
      wasPairing.current = false;
      setLaunch('on');
    } else if (ready && launch === 'pending') setLaunch('done');
  }, [pairing, ready, launch]);

  if (!ready && !link) return <div className="app" />;
  const top = stack[stack.length - 1];

  if (pairing) {
    return (
      <>
        <Pair link={link} onLinkUsed={() => setLink(null)} denied={state === 'denied' ? error : undefined} />
        <Toast />
      </>
    );
  }

  return (
    <>
      <div className="app">
        <Home under={!!top} />
        <AnimatePresence>
          {stack.map((r, i) => (
            <Layer key={routeKey(r)} route={r} index={i} covered={i < stack.length - 1}>
              <Screen route={r} />
            </Layer>
          ))}
        </AnimatePresence>
        <Attention top={top} />
        {state === 'denied' && (
          <div className="banner glass" role="alert">
            <span>{error ?? 'This phone is no longer allowed'}</span>
            <button type="button" className="btn btn-sm" onClick={() => void conn.forget()}>
              Pair again
            </button>
          </div>
        )}
      </div>
      {launch === 'on' && <Launch onDone={() => setLaunch('done')} />}
      <MessageMenu />
      <Viewer />
      <Toast />
    </>
  );
}

/** What a layer shows. */
function Screen({ route: r }: { route: Route }) {
  if (r.name === 'settings') return <Settings />;
  if (r.name === 'chat')
    return (
      <Suspense fallback={<div className="screen chat" />}>
        <Chat id={r.id} at={r.at} seq={r.seq} find={r.find} />
      </Suspense>
    );
  return (
    <Suspense fallback={<div className="screen changes" />}>
      {r.name === 'changes' ? <ChangesScreen id={r.id} items={r.items} lead={r.lead} /> : <DiffScreen id={r.id} path={r.path} items={r.items} />}
    </Suspense>
  );
}

const H = () => window.innerHeight;

/**
 * A screen over home. A chat grows out of the row (or card, or field) it was opened from: it scales
 * up from that row's place while it fades in, and home steps back. Going back it shrinks into its row
 * again when that row is on screen; otherwise screens slide. Transform and opacity only, as WAAPI
 * animations: the compositor runs them while the page mounts the conversation (the window that
 * opened as a clip-path was drawn by the main thread, which was busy mounting it: the opening and the
 * way back lost most of their frames on a phone).
 */
function Layer({ route, index, covered, children }: { route: Route; index: number; covered: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [present, safeToRemove] = usePresence();
  // Taken once (a development double run of the effect must not lose it).
  const origin = useRef<Origin | null | undefined>(undefined);
  if (origin.current === undefined) origin.current = route.name === 'chat' ? takeOrigin(route.id) : null;
  // A race's rival taking this chat's place: the two slide together, as columns side by side.
  const swapIn = useRef<1 | -1 | null | undefined>(undefined);
  if (swapIn.current === undefined) swapIn.current = route.name === 'chat' ? takeSwap(route.id, 'in') : null;

  useLayoutEffect(() => {
    const el = ref.current;
    const b = body.current;
    if (!el || !b) return;
    const o = origin.current;
    if (reduced()) {
      animate(el, { opacity: [0, 1] }, { duration: 0.14 });
      return;
    }
    if (o) {
      // Out of what was tapped: the screen grows from that row's place as it comes in.
      b.style.transformOrigin = `50% ${(o.rect.top + o.rect.height / 2).toFixed(0)}px`;
      animate(b, { transform: ['scale(0.9)', 'scale(1)'] }, SPRING);
      animate(b, { opacity: [0, 1] }, { duration: 0.2, ease: 'easeOut' });
      return;
    }
    const dir = swapIn.current ?? 1;
    animate(el, { transform: [`translateX(${dir * 100}%)`, 'translateX(0%)'] }, SPRING);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Covered by a newer screen: it steps back, as home does.
  const wasCovered = useRef(covered);
  useEffect(() => {
    const b = body.current;
    if (!b || !present || wasCovered.current === covered) return;
    wasCovered.current = covered;
    const n = nowOf(b);
    b.style.transformOrigin = '';
    animate(b, { transform: [`scale(${n.scale})`, `scale(${covered ? 0.94 : 1})`], opacity: [n.opacity, covered ? 0.4 : 1] }, SPRING);
  }, [covered, present]);

  // The animations of a layer on its way out: the same screen opened again at once brings it back from where it is.
  const leaving = useRef<{ stop: () => void }[] | null>(null);
  useEffect(() => {
    const el = ref.current;
    const b = body.current;
    if (present) {
      const going = leaving.current;
      if (!going || !el || !b) return;
      leaving.current = null;
      going.forEach((a) => a.stop());
      el.style.pointerEvents = '';
      animate(el, { transform: 'translateX(0%)', opacity: 1 }, SPRING);
      animate(b, { transform: 'scale(1)', opacity: 1 }, SPRING);
      return;
    }
    if (!el || !b) return void safeToRemove();
    el.style.pointerEvents = 'none';
    const list: { stop: () => void }[] = [];
    leaving.current = list;
    const done = () => leaving.current === list && safeToRemove();
    const go = <T extends { stop: () => void }>(a: T) => (list.push(a), a);
    if (reduced()) {
      void go(animate(el, { opacity: 0 }, { duration: 0.12 })).finished.then(done);
      return;
    }
    // Replaced by its race rival: it leaves toward its own side while the rival comes in from the other.
    const swapOut = route.name === 'chat' ? takeSwap(route.id, 'out') : null;
    if (swapOut) {
      void go(animate(el, { transform: ['translateX(0%)', `translateX(${-swapOut * 100}%)`] }, SPRING)).finished.then(done);
      return;
    }
    const row = route.name === 'chat' ? rowOf(route.id) : null;
    if (row) {
      // Back into its row: the screen shrinks toward the row's place and fades as home comes forward.
      b.style.transformOrigin = `50% ${Math.min(H(), Math.max(0, row.rect.top + row.rect.height / 2)).toFixed(0)}px`;
      const n = nowOf(b);
      go(animate(b, { transform: [`scale(${n.scale})`, 'scale(0.9)'] }, { ...SPRING, stiffness: 470 }));
      void go(animate(b, { opacity: [n.opacity, 0] }, { duration: 0.2, ease: 'easeIn' })).finished.then(done);
      return;
    }
    void go(animate(el, { transform: ['translateX(0%)', 'translateX(100%)'] }, { type: 'spring', stiffness: 520, damping: 50, restDelta: 1 })).finished.then(done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  return (
    <div ref={ref} className="layer" style={{ zIndex: 10 + index }} data-route={route.name}>
      <div ref={body} className="layer-body">
        {children}
      </div>
    </div>
  );
}

/** Another chat waits on you while a chat or settings covers home: one line at the top, a tap goes there. */
function Attention({ top }: { top?: Route }) {
  const attention = useStore((s) => s.attention);
  const s = useStore((st) => (attention ? st.sessions[attention.id] : undefined));
  const show = !!attention && !!s && s.status === 'awaiting' && !!top && chatOf(top) !== attention.id;
  useEffect(() => {
    if (!attention) return;
    const t = setTimeout(() => setState({ attention: undefined }), 7000);
    return () => clearTimeout(t);
  }, [attention]);
  return (
    <AnimatePresence>
      {show && (
        <motion.button
          key={attention!.at}
          type="button"
          className="attn-top glass-liquid"
          initial={{ opacity: 0, y: -24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -24, scale: 0.96 }}
          transition={SNAP}
          onClick={() => {
            haptic('tap');
            setState({ attention: undefined });
            nav.chat(s!.id);
          }}
        >
          <ProviderMark provider={s!.provider} size={16} />
          <span className="attn-text">
            <span className="attn-title">{s!.title}</span>
            <span className="attn-sub">
              <StatusMark tone="awaiting" size={10} /> Waiting for you
            </span>
          </span>
          <span className="attn-go">Open</span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}

function Toast() {
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setState({ toast: undefined }), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          key={toast.at}
          className="toast"
          data-level={toast.level}
          initial={{ opacity: 0, y: -20, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -14, scale: 0.98 }}
          transition={SNAP}
          role="status"
        >
          {toast.level === 'success' ? <span className="toast-check" aria-hidden /> : toast.level === 'error' ? <span className="toast-dot" aria-hidden /> : null}
          <span>{toast.text}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
