import { animate } from 'motion';
import { AnimatePresence, motion } from 'motion/react';
import { createContext, lazy, memo, Suspense, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project, RateLimit, SessionMeta } from '@shared/protocol';
import { baseName, timeAgo } from '@desk/lib/format';
import { pushBack } from '@m/lib/back';
import { conn } from '@m/lib/conn';
import { haptic } from '@m/lib/native';
import { onScreen } from '@m/lib/screen';
import { clockOf, liveWords, useSecond } from '@m/lib/live-words';
import { nav } from '@m/lib/nav';
import { openFrom } from '@m/lib/open';
import { homeFolder, openRace } from '@m/lib/race';
import { hasWork, workLabel } from '@shared/work-label';
import { worksNow } from '@m/lib/chat-rules';
import { getState, refresh, setState, useStore, type State } from '@m/lib/store';
import { useNow } from '@m/lib/useNow';
import { Field, fieldBeat, fieldWake, paletteFor, type Horizon } from '@m/ui/Field';
import { Icon } from '@m/ui/icons';
import { LogoMark, ProviderMark, RaceGlyph, Ring, StatusMark, Tiles, type Tone } from '@m/ui/marks';
import { nowOf, REVEAL, SNAP, SPRING } from '@m/ui/motion';
import { Pull } from '@m/ui/Pull';
import { usePending } from '@m/lib/pending';
import { onForget } from '@m/lib/forget';
import { HomeDock } from './HomeDock';
import { levelOf, scoped } from './Limits';
import { SearchResults } from './Search';
import { mayCall } from '../web/allow';

// The deck (the prompt sheets and the markdown they render): its own chunk, fetched once something waits.
const loadDeck = () => import('./Deck');
const Deck = lazy(() => loadDeck().then((m) => ({ default: m.Deck })));

/** Rows shown before "Show more", and how many more each time. */
const FIRST_ROWS = 30;

export const toneOf = (s: SessionMeta): Tone =>
  s.status === 'running' || s.status === 'starting'
    ? 'working'
    : s.status === 'awaiting'
      ? 'awaiting'
      : // Its own turn ended (also with an error), but sub-agents or background commands it started still work: the chat is not at rest.
        hasWork(s)
        ? 'working'
        : s.status === 'error'
          ? 'error'
          : s.unread
            ? 'unread'
            : 'idle';

/** At work (its turn, or sub-agents it left working: lib/chat-rules.ts `worksNow`) or waiting on you. */
const isLive = (s: SessionMeta) => !s.archived && (worksNow(s) || s.status === 'awaiting');

/** One predicate for the row, the count of chats at work and the moment a chat is done. */
const isWorking = worksNow;

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** A chat that finished while you look stays at the top this long, then joins the list. */
const LINGER_MS = 2600;

/** The chats at work, as a string of ids (the oldest turn first: a row keeps its place while it works). */
function workingKey(s: State): string {
  const out: SessionMeta[] = [];
  for (const m of Object.values(s.sessions)) if (!m.archived && isWorking(m)) out.push(m);
  return out
    .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1))
    .map((m) => m.id)
    .join(',');
}

/**
 * The horizon of home's stage: the field's light as a band behind the title, placed by where the title
 * block is (`at`: its middle, `h`: the screen's height, both in px). With no chats yet it comes further
 * down: the stage is the screen.
 */
const horizon = (at: number, h: number, empty: boolean): Horizon =>
  // 2.18: a quiet wash in the upper right, off the title (never light at full strength under words).
  empty ? { x: 0.96, y: (at - 30) / h, up: 60 / h, down: 120 / h, spread: 0.62, amount: 0.34 } : { x: 0.98, y: (at - 40) / h, up: 46 / h, down: 58 / h, spread: 0.55, amount: 0.3 };

/** The folder a chat belongs to on home: its own (a lane's chat: the folder it came from), or "Chats" for chats without one. */
export const folderKey = (s: SessionMeta) => (s.chat ? '::chats' : norm(homeFolder(s)));
export const folderName = (s: SessionMeta, projects: Project[]) => (s.chat ? 'Chats' : (projects.find((p) => norm(p.path) === norm(homeFolder(s)))?.name ?? baseName(homeFolder(s))));

const FILTER = 'sable.homeFilter';
onForget(() => {
  try {
    localStorage.removeItem(FILTER);
  } catch {
    /* private mode */
  }
});
const readFilter = () => {
  try {
    return localStorage.getItem(FILTER) ?? '';
  } catch {
    return '';
  }
};

/**
 * The chats home lists, as a string (pinned, then the rest by their latest activity), so the list
 * renders only when its order changes: a chat at work changes its line many times a second, and
 * only that row follows it.
 */
function listKey(s: State, filter: string, skip = ''): string {
  const hidden = new Set(s.projects.filter((p) => p.hidden).map((p) => norm(p.path)));
  const pinned: SessionMeta[] = [];
  const rest: SessionMeta[] = [];
  const out = skip ? new Set(skip.split(',')) : null;
  for (const m of Object.values(s.sessions)) {
    // What works now is at the top of home (and stays there a moment once it is done), not in the list too.
    if (m.archived || isWorking(m) || out?.has(m.id)) continue;
    const k = folderKey(m);
    if (hidden.has(k) || (filter && k !== filter)) continue;
    (m.pinned ? pinned : rest).push(m);
  }
  const by = (a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt;
  return `${pinned.sort(by).map((m) => m.id).join(',')}|${rest.sort(by).map((m) => m.id).join(',')}`;
}

/** The folders that have chats, the most recently active first: `key\u0001name` per folder, joined by `\u0002`. */
function foldersKey(s: State): string {
  const last = new Map<string, { name: string; at: number }>();
  const hidden = new Set(s.projects.filter((p) => p.hidden).map((p) => norm(p.path)));
  for (const m of Object.values(s.sessions)) {
    if (m.archived) continue;
    const k = folderKey(m);
    if (hidden.has(k)) continue;
    const cur = last.get(k);
    if (!cur) last.set(k, { name: folderName(m, s.projects), at: m.updatedAt });
    else if (m.updatedAt > cur.at) cur.at = m.updatedAt;
  }
  return [...last.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .map(([k, v]) => `${k}\u0001${v.name}`)
    .join('\u0002');
}

/** Covered by a chat, home keeps what it showed (it catches up as it comes forward). */
const Under = createContext(false);
function useHome<T>(sel: (s: State) => T): T {
  const under = useContext(Under);
  const last = useRef<{ v: T } | null>(null);
  return useStore((s) => (under && last.current ? last.current.v : (last.current = { v: sel(s) }).v));
}

export function Home({ under }: { under: boolean }) {
  const defaultProvider = useStore((s) => s.settings?.defaultProvider);
  const desktop = useStore((s) => s.desktop);
  const connState = useStore((s) => s.conn);
  const loaded = useStore((s) => s.loaded);
  // Reached the desktop in this run: a lost connection is then "Reconnecting".
  const fresh = useStore((s) => !!s.fresh);
  // What runs and waits, as two numbers (the title's line and the field's pace).
  const counts = useStore((s) => {
    let w = 0;
    let a = 0;
    for (const m of Object.values(s.sessions)) if (isLive(m)) m.status === 'awaiting' ? a++ : w++;
    return `${w}|${a}`;
  });
  const [working] = counts.split('|').map(Number);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const q = useDeferredValue(searching ? query : '');
  const [deck, setDeck] = useState(false);
  const [filter, setFilterState] = useState(readFilter);
  const [peek, setPeek] = useState<{ id: string; rect: DOMRect } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pending = usePending();
  const name = desktop ?? 'Sable';
  const hasChats = useStore((s) => {
    for (const m of Object.values(s.sessions)) if (!m.archived) return true;
    return false;
  });

  // What works now, at the top; a chat that finishes while you look stays a moment, done, then joins the list.
  // Covered by a chat, home keeps what it showed (as its list does).
  const lastWork = useRef<string | null>(null);
  const workKey = useStore((s) => (under && lastWork.current !== null ? lastWork.current : (lastWork.current = workingKey(s))));
  const [now, setNow] = useState({ key: workKey, under, order: workKey ? workKey.split(',') : [], done: [] as string[] });
  if (now.key !== workKey || now.under !== under) {
    const run = workKey ? workKey.split(',') : [];
    // Covered meanwhile: what ended then is not news.
    const watched = !under && !now.under;
    const sessions = getState().sessions;
    const ended = watched ? now.order.filter((id) => !run.includes(id) && !now.done.includes(id) && sessions[id] && !sessions[id].archived && (sessions[id].status === 'idle' || sessions[id].status === 'error')) : [];
    const done = [...now.done.filter((id) => !run.includes(id) && sessions[id] && !sessions[id].archived), ...ended];
    const keep = now.order.filter((id) => run.includes(id) || done.includes(id));
    setNow({ key: workKey, under, order: [...keep, ...run.filter((id) => !keep.includes(id))], done: under ? [] : done });
  }
  const doneKey = now.done.join(',');
  const lingers = useRef(new Map<string, number>());
  useEffect(() => {
    const m = lingers.current;
    for (const id of doneKey ? doneKey.split(',') : [])
      if (!m.has(id))
        m.set(
          id,
          window.setTimeout(() => {
            m.delete(id);
            setNow((n) => ({ ...n, order: n.done.includes(id) ? n.order.filter((x) => x !== id) : n.order, done: n.done.filter((x) => x !== id) }));
          }, LINGER_MS),
        );
  }, [doneKey]);
  useEffect(() => () => lingers.current.forEach((t) => clearTimeout(t)), []);

  // Where the title block is: the horizon lies behind it (measured at rest; the status bar's height differs by phone).
  const [heroAt, setHeroAt] = useState(() => ({ at: 112, h: typeof innerHeight === 'number' ? innerHeight : 800 }));
  useLayoutEffect(() => {
    const measure = () => {
      const hero = root.current?.querySelector<HTMLElement>('.home-hero');
      const h = root.current?.offsetHeight ?? 0;
      if (!hero || !h) return;
      const at = Math.round(hero.offsetTop + hero.offsetHeight / 2);
      setHeroAt((p) => (p.at === at && p.h === h ? p : { at, h }));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const empty = loaded && !hasChats;
  const stage = useMemo(() => horizon(heroAt.at, heroAt.h, empty), [heroAt, empty]);

  // Home comes in once: the light swells up and what is under the title rises into place (home.css).
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    fieldBeat('open');
    const t = window.setTimeout(() => setEntering(false), 900);
    return () => clearTimeout(t);
  }, []);

  // The stage drifts for a while after home comes forward or is touched, then rests (ui/Field.tsx).
  useEffect(() => {
    if (!under) fieldWake();
  }, [under]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    el.addEventListener('pointerdown', fieldWake, { passive: true });
    return () => el.removeEventListener('pointerdown', fieldWake);
  }, []);
  // Something starts waiting on you while home is in view: a soft wave down from the horizon as it turns amber.
  const waitingNow = pending.length > 0;
  const wasWaiting = useRef(waitingNow);
  useEffect(() => {
    if (waitingNow && !wasWaiting.current && !under) fieldBeat('pulse', { x: innerWidth * 0.78, y: 0 });
    wasWaiting.current = waitingNow;
  }, [waitingNow, under]);
  // Mounted from the first opening on (it closes on its own spring); fetched as soon as something waits.
  const [deckUsed, setDeckUsed] = useState(false);
  useEffect(() => {
    if (deck) setDeckUsed(true);
  }, [deck]);
  useEffect(() => {
    if (pending.length) void loadDeck();
  }, [pending.length > 0]);

  const setFilter = (k: string) => {
    haptic('select');
    setFilterState(k);
    try {
      if (k) localStorage.setItem(FILTER, k);
      else localStorage.removeItem(FILTER);
    } catch {
      /* private mode */
    }
    root.current?.querySelector('.home-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Under a chat or settings, home steps back (smaller, dimmer) on the same spring as the screen over it.
  // Once a screen covers it whole, home is not drawn at all (it was drawn under every frame of the chat's scrolling).
  const wasUnder = useRef(under);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || wasUnder.current === under) return;
    wasUnder.current = under;
    el.style.visibility = '';
    const n = nowOf(el);
    const a = animate(el, { transform: [`scale(${n.scale})`, `scale(${under ? 0.94 : 1})`], opacity: [n.opacity, under ? 0.45 : 1] }, SPRING);
    if (under) void a.finished.then(() => wasUnder.current && (el.style.visibility = 'hidden'));
  }, [under]);

  useEffect(() => (searching ? pushBack(() => (closeSearch(), true)) : undefined), [searching]);
  // "New chat" from the app icon: home as it is at rest (no search), its bar focused (HomeDock).
  useEffect(() => {
    const rest = () => {
      setSearching(false);
      setQuery('');
    };
    window.addEventListener('sable:newchat', rest);
    return () => window.removeEventListener('sable:newchat', rest);
  }, []);

  // While the list moves, the new-chat bar drops its blur (it would be drawn again every frame) and
  // stands on denser ink; at rest it is glass again.
  useEffect(() => {
    const el = root.current;
    const sc = el?.querySelector('.home-scroll');
    if (!el || !sc) return;
    let t = 0;
    const on = () => {
      if (!t) el.setAttribute('data-moving', '');
      clearTimeout(t);
      t = window.setTimeout(() => {
        t = 0;
        el.removeAttribute('data-moving');
      }, 180);
    };
    sc.addEventListener('scroll', on, { passive: true });
    return () => {
      sc.removeEventListener('scroll', on);
      clearTimeout(t);
    };
  }, []);
  const closeSearch = () => {
    setSearching(false);
    setQuery('');
    (document.activeElement as HTMLElement | null)?.blur?.();
  };

  // The waiting strip scrolled out of sight: one line above the bar brings the deck back.
  const stripRef = useRef<HTMLElement>(null);
  const [stripSeen, setStripSeen] = useState(true);
  const hasStrip = pending.length > 0 && !q;
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return setStripSeen(true);
    const io = new IntersectionObserver(([e]) => setStripSeen(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [hasStrip]);

  return (
    <Under.Provider value={under}>
      <div className="screen home" ref={root} data-under={under || undefined} data-enter={entering || undefined} data-offline={connState === 'offline' || undefined}>
        <Field
          palette={paletteFor(defaultProvider)}
          amount={0.5}
          focusX={0.72}
          focusY={1.08}
          spread={1.12}
          stage={stage}
          floor={0}
          under=".home-dock"
          alert={waitingNow}
          active={working > 0 && !under}
          hidden={under}
        />
        {/* Scrolled, the horizon steps back behind the cards (ink over it, faded in by the scroll; home.css). */}
        <i className="home-shade" aria-hidden />
        <header className="home-bar">
          <LogoMark size={20} cells className="home-mark" />
          <span className="home-bar-title">{name}</span>
          <div className="home-tools">
            {/* Something at work or waiting: Now, everything running on one screen (2.21) */}
            {(working > 0 || pending.length > 0) && (
              <button type="button" className="icon-btn now-key" aria-label="Now" onClick={() => (haptic('tap'), nav.push({ name: 'now' }))}>
                <Tiles size={17} />
              </button>
            )}
            <button type="button" className="icon-btn" aria-label="Search" aria-pressed={searching} onClick={() => (haptic('tap'), searching ? closeSearch() : setSearching(true))}>
              <Icon name="search" size={22} />
            </button>
            {mayCall('provider.limits') && (
              <button type="button" className="icon-btn" aria-label="Limits" onClick={() => (haptic('tap'), nav.push({ name: 'limits' }))}>
                <Icon name="gauge" size={22} />
              </button>
            )}
            <button type="button" className="icon-btn" aria-label="Settings" onClick={() => (haptic('tap'), nav.push({ name: 'settings' }))}>
              <Icon name="gear" size={22} />
            </button>
          </div>
        </header>

        <Pull
          className="home-scroll"
          onRefresh={async () => {
            fieldBeat('pulse', { x: innerWidth / 2, y: 0 });
            if (getState().conn !== 'open') return conn.wake();
            await refresh([]);
          }}
        >
          <AnimatePresence mode={import.meta.env.SABLE_WEB ? "sync" : "popLayout"} initial={false}>
            {searching ? (
              <motion.div key="search" className="home-hero home-search" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={SNAP}>
                <label className="search">
                  <Icon name="search" size={18} />
                  <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats and messages" aria-label="Search chats and messages" enterKeyHint="search" />
                  {query && (
                    <button type="button" className="search-clear" aria-label="Clear" onClick={() => setQuery('')}>
                      <Icon name="x" size={14} weight="bold" />
                    </button>
                  )}
                </label>
                <button type="button" className="link-btn" onClick={closeSearch}>
                  Cancel
                </button>
              </motion.div>
            ) : (
              <motion.div key="hero" className="home-hero" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={SNAP}>
                <h1 className="home-title">{name}</h1>
                {/* The connection when it is not there, else the account's limits at a glance. What works and what waits have their own cards below. */}
                <HomeStatus conn={!loaded && connState === 'offline' ? 'away' : connState} fresh={fresh} onLimits={() => (haptic('tap'), nav.push({ name: 'limits' }))} />
              </motion.div>
            )}
          </AnimatePresence>

          {!loaded && connState === 'offline' ? (
            <div className="unreachable">
              <Icon name="offline" size={22} />
              <p>Can't reach {desktop ?? 'the computer'}</p>
              <p className="unreachable-hint">Sable must be running there with Phone on.</p>
              <button type="button" className="btn" onClick={() => (haptic('tap'), conn.wake())}>
                Try again
              </button>
            </div>
          ) : !loaded ? (
            <div className="home-skel" aria-hidden>
              <div className="home-skel-card">
                {Array.from({ length: 7 }, (_, i) => (
                  <span key={i} className="home-skel-row">
                    <span className="skel skel-dot" />
                    <span className="home-skel-lines">
                      <span className="skel" style={{ width: `${78 - ((i * 17) % 34)}%` }} />
                      <span className="skel skel-sub" style={{ width: `${30 + ((i * 13) % 22)}%` }} />
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ) : q ? (
            <SearchResults query={q} onMenu={(id, rect) => setPeek({ id, rect })} />
          ) : (
            <>
              <AnimatePresence initial={false}>
                {hasStrip && <WaitingStrip key="strip" ref={stripRef} onOpen={() => setDeck(true)} />}
              </AnimatePresence>
              <LiveNow ids={now.order} done={now.done} />
              <Filters value={filter} onChange={setFilter} />
              <HomeList filter={filter} skip={doneKey} quiet={now.order.length > 0} onMenu={(id, rect) => setPeek({ id, rect })} onClearFilter={() => setFilter('')} />
            </>
          )}
          <div className="home-pad" />
        </Pull>

        {/* Waiting on you and scrolled past the strip: one line above the bar opens the deck. */}
        <AnimatePresence>
          {hasStrip && fresh && !stripSeen && !searching && (
            <motion.button
              key="attn"
              type="button"
              className="attn glass-liquid"
              initial={{ opacity: 0, y: 18, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 18, scale: 0.97 }}
              transition={SNAP}
              whileTap={{ scale: 0.98 }}
              onClick={() => (haptic('tap'), setDeck(true))}
            >
              <StatusMark tone="awaiting" size={12} />
              <span className="attn-text">
                <span className="attn-title">{pending[0].title}</span>
                <span className="attn-sub">{pending.length > 1 ? `Waiting for you · ${pending.length - 1} more` : 'Waiting for you'}</span>
              </span>
              <span className="attn-go">Review</span>
            </motion.button>
          )}
        </AnimatePresence>

        {/* A new chat is the desktop's to start (a browser may not create one: web/allow.ts). */}
        {mayCall('session.create') && <HomeDock covered={under} />}

        {(deckUsed || deck) && (
          <Suspense fallback={null}>
            <Deck open={deck} onClose={() => setDeck(false)} />
          </Suspense>
        )}
        <Peek peek={peek} onClose={() => setPeek(null)} />
      </div>
    </Under.Provider>
  );
}

/** The default agent's account, its two plan windows at a glance: `label\u0001percent\u0001level` each, joined by `\u0002`. */
function glanceKey(s: State): string {
  const provider = s.settings?.defaultProvider;
  const account = provider ? (s.providers[provider]?.accounts ?? []).find((x) => x.isDefault && x.auth.loggedIn) : undefined;
  if (!provider || !account) return '';
  const report = s.limits[`${provider}:${account.id}`];
  if (report?.planLimits === false) return '';
  const windows = (report?.limits ?? account.limits ?? []).filter((w) => w.percent >= 0 && !scoped(w));
  const short = windows.find((w) => (w.windowMins ?? 0) > 0 && (w.windowMins ?? 0) < 1440);
  const long = windows.find((w) => (w.windowMins ?? 0) >= 1440);
  const now = Date.now();
  const name = (w: RateLimit) => (w.windowMins === 300 ? '5 hours' : w.windowMins === 10080 ? 'Week' : w.label);
  return [short, long]
    .filter((w): w is RateLimit => !!w)
    .map((w) => `${name(w)}\u0001${w.resetsAt && w.resetsAt <= now ? 0 : Math.round(w.percent)}\u0001${levelOf(w, now) ?? ''}`)
    .join('\u0002');
}

/** Under the title: the connection when it is not there, else the account's limits at a glance (a tap opens them all). */
function HomeStatus({ conn: state, fresh, onLimits }: { conn: string; fresh: boolean; onLimits: () => void }) {
  const glance = useStore(glanceKey);
  let body: React.ReactNode = null;
  let key = 'none';
  if (state === 'denied') (key = 'denied'), (body = <span className="home-status-warn">Not paired</span>);
  else if (state === 'away') key = 'none';
  else if (state !== 'open')
    (key = 'conn'),
      (body = (
        <>
          <Ring size={12} /> {fresh ? 'Reconnecting' : 'Connecting'}
        </>
      ));
  else if (glance)
    (key = 'limits'),
      (body = (
        <button type="button" className="glance" aria-label="Limits" onClick={onLimits}>
          {glance.split('\u0002').map((part) => {
            const [label, pct, level] = part.split('\u0001');
            return (
              <span key={label} className="glance-win" data-level={level || undefined}>
                <span className="glance-meter" style={{ '--p': Math.min(1, Number(pct) / 100) } as React.CSSProperties} aria-hidden>
                  <i />
                </span>
                <span className="glance-label">{label}</span>
                <span className="glance-pct num">{pct}%</span>
              </span>
            );
          })}
        </button>
      ));
  return (
    <AnimatePresence mode={import.meta.env.SABLE_WEB ? "sync" : "popLayout"} initial={false}>
      {body && (
        <motion.div key={key} className="home-status" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={SNAP}>
          {body}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * What works now: the chats with a turn running, each with what it does this moment and its time so
 * far, a tap away. A chat that finishes while you look stays a moment ("Done", the ring closing on
 * it in the field), then leaves for the list.
 */
const LiveNow = memo(function LiveNow({ ids, done }: { ids: string[]; done: string[] }) {
  const under = useContext(Under);
  const t = useSecond(ids.length > 0 && !under);
  return (
    <AnimatePresence initial={false}>
      {ids.length > 0 && (
        <motion.section key="now" className="group live" aria-label="Working now" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={REVEAL}>
          <ul className="rows live-rows">
            <AnimatePresence initial={false}>
              {ids.map((id) => (
                <LiveRow key={id} id={id} done={done.includes(id)} now={t} />
              ))}
            </AnimatePresence>
          </ul>
        </motion.section>
      )}
    </AnimatePresence>
  );
});

const LiveRow = memo(function LiveRow({ id, done, now }: { id: string; done: boolean; now: number }) {
  const s = useHome((st) => st.sessions[id]);
  // The time stops where the turn ended.
  const end = useRef(0);
  if (!done) end.current = 0;
  else if (!end.current) end.current = s?.updatedAt ?? now;
  // When the phone first saw it at work: the turn's own start when the desktop says it (`live`).
  const began = useRef(now);
  if (!s) return null;
  const failed = done && s.status === 'error';
  const w = liveWords(s);
  const since = w.since ?? began.current;
  const line = done ? (failed ? (s.lastError ?? 'Stopped with an error') : 'Done') : w.line;
  return (
    <motion.li layout="position" className="rrow" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0, transition: { duration: 0.22 } }} transition={SNAP}>
      <button
        type="button"
        className="row live-row"
        data-chat={id}
        data-live={id}
        data-radius="17"
        data-done={done ? (failed ? 'error' : 'ok') : undefined}
        aria-label={`${s.title}. ${line}${!done && w.steps ? `, ${w.steps} steps` : ''}`}
        onClick={(e) => {
          haptic('tap');
          openFrom(id, e.currentTarget, 17);
          nav.chat(id);
        }}
      >
        {/* 2.21: the working mark itself leads the row (the mark's cells building and letting go), the agent's mark beside the title */}
        <span className="row-mark live-mark">{done ? failed ? <StatusMark tone="error" size={12} /> : <Icon name="check" size={15} weight="bold" className="live-check" /> : <Tiles size={16} />}</span>
        <span className="row-main">
          <span className="row-title live-title">
            <ProviderMark provider={s.provider} size={13} />
            <span>{s.title}</span>
          </span>
          <span className="row-sub live-line">
            {/* The words change in place: the new line rises in (CSS, once per line). */}
            <span key={line} className="live-text">
              {line}
            </span>
            {!done && w.steps > 0 && <span className="live-steps num">{w.steps} {w.steps === 1 ? 'step' : 'steps'}</span>}
          </span>
        </span>
        <span className="row-end live-end">
          <span className="live-time num">{clockOf((done ? end.current : now) - since)}</span>
          {!done && w.steps > 0 && <Checkpoints done={w.done} open={w.open} />}
        </span>
      </button>
    </motion.li>
  );
});

/**
 * How far a turn has come, as the conversation reads it: a short bar per checkpoint closed and the
 * open one dithered, its length by its steps (at most eight bars: older ones merge into the first).
 * Static paint; it changes only when a checkpoint closes or a step is added.
 */
function Checkpoints({ done, open }: { done: number; open: number }) {
  const n = Math.min(done, 7);
  return (
    <span className="cps" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} />
      ))}
      <i className="cp-open" style={{ width: `${Math.min(18, 6 + open * 2)}px` }} />
    </span>
  );
}

/**
 * What waits on you across chats: one calm card at the top of home. The oldest prompt names itself
 * and its chat; Review opens them one after another (the deck), answerable right here.
 */
const WaitingStrip = memo(function WaitingStrip({ onOpen, ref }: { onOpen: () => void; ref: React.Ref<HTMLElement> }) {
  const pending = usePending();
  const first = pending[0];
  const s = useStore((st) => (first ? st.sessions[first.sessionId] : undefined));
  if (!first) return null;
  return (
    <motion.section
      ref={ref as React.Ref<HTMLElement>}
      className="wait-strip-wrap"
      aria-label="Waiting for you"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={REVEAL}
    >
      <button type="button" className="wait-strip" onClick={() => (haptic('tap'), onOpen())}>
        <span className="wait-head">
          <StatusMark tone="awaiting" size={12} />
          <span className="wait-count">{pending.length === 1 ? 'Waiting for you' : `${pending.length} waiting for you`}</span>
          <span className="wait-go">Review</span>
        </span>
        <span className="wait-line">
          {s && <ProviderMark provider={s.provider} size={15} />}
          <span className="wait-ask">{first.title}</span>
        </span>
        <span className="wait-chat">{s?.title ?? ''}</span>
      </button>
    </motion.section>
  );
});

/** The folders as a row of chips: all chats, or one folder's. */
function Filters({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  const key = useHome(foldersKey);
  const folders = useMemo(() => (key ? key.split('\u0002').map((x) => x.split('\u0001') as [string, string]) : []), [key]);
  const row = useRef<HTMLDivElement>(null);
  // The chosen folder stays in view when the row is longer than the screen.
  useEffect(() => {
    const el = row.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [value]);
  // A folder that no longer has chats: back to all.
  useEffect(() => {
    if (value && key && !folders.some(([k]) => k === value)) onChange('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (folders.length < 2) return null;
  return (
    <div className="filters no-drag" ref={row} role="toolbar" aria-label="Folders">
      <button type="button" className="filter" aria-pressed={!value} onClick={() => value && onChange('')}>
        All
      </button>
      {folders.map(([k, name]) => (
        <button key={k} type="button" className="filter" aria-pressed={value === k} onClick={() => onChange(value === k ? '' : k)}>
          <span>{name}</span>
        </button>
      ))}
    </div>
  );
}

/** Pinned chats, then the rest by their latest activity: one card each, rows of two lines. */
function HomeList({ filter, skip, quiet, onMenu, onClearFilter }: { filter: string; skip: string; quiet: boolean; onMenu: (id: string, rect: DOMRect) => void; onClearFilter: () => void }) {
  const key = useHome((s) => listKey(s, filter, skip));
  const [limit, setLimit] = useState(FIRST_ROWS);
  useEffect(() => setLimit(FIRST_ROWS), [filter]);
  const [pinnedKey, restKey] = key.split('|');
  const pinned = useMemo(() => (pinnedKey ? pinnedKey.split(',') : []), [pinnedKey]);
  const rest = useMemo(() => (restKey ? restKey.split(',') : []), [restKey]);
  const shown = rest.slice(0, Math.max(0, limit - pinned.length));
  // For start-up timing (DevTools: performance.getEntriesByName('sable:list')).
  useEffect(() => {
    if ((pinned.length || rest.length) && !performance.getEntriesByName('sable:list').length) performance.mark('sable:list');
  }, [pinned.length, rest.length]);
  if (!pinned.length && !rest.length)
    return filter ? (
      <p className="empty">
        No chats in this folder.{' '}
        <button type="button" className="link-btn" onClick={onClearFilter}>
          Show all
        </button>
      </p>
    ) : quiet ? null : (
      <p className="empty home-empty">No chats yet.</p>
    );
  return (
    <>
      <AnimatePresence initial={false}>
        {pinned.length > 0 && (
          <motion.section key="pinned" className="group" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={SNAP}>
            <h2 className="group-name">Pinned</h2>
            <Rows ids={pinned} onMenu={onMenu} />
          </motion.section>
        )}
      </AnimatePresence>
      {rest.length > 0 && (
        <section className="group">
          {pinned.length > 0 && <h2 className="group-name">Recent</h2>}
          <Rows ids={shown} onMenu={onMenu} />
          {rest.length > shown.length && (
            <button type="button" className="more-row" onClick={() => (haptic('tap'), setLimit((n) => n + FIRST_ROWS))}>
              Show more
            </button>
          )}
        </section>
      )}
    </>
  );
}

export function Rows({ ids, onMenu, swipe = true }: { ids: string[]; onMenu: (id: string, rect: DOMRect) => void; swipe?: boolean }) {
  return (
    <ul className="rows">
      <AnimatePresence initial={false}>
        {ids.map((id) => (
          <Row key={id} id={id} onMenu={onMenu} swipe={swipe} search={!swipe} />
        ))}
      </AnimatePresence>
    </ul>
  );
}

/** A long press: the chat's actions. */
function useLongPress(onLong: (el: HTMLElement) => void) {
  const press = useRef<{ timer: number; fired: boolean; x: number; y: number } | null>(null);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
  };
  return {
    fired: () => !!press.current?.fired,
    cancel,
    handlers: {
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        cancel();
        const el = e.currentTarget;
        const p = { fired: false, timer: 0, x: e.clientX, y: e.clientY };
        p.timer = window.setTimeout(() => {
          p.fired = true;
          haptic('select');
          onLong(el);
        }, 440);
        press.current = p;
      },
      onPointerMove: (e: React.PointerEvent) => {
        const p = press.current;
        if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancel();
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  };
}

/** A chat racing another (the desktop's `/race`): the race glyph, quiet, beside the time. */
function RaceMark() {
  return (
    <span className="race-mark" role="img" aria-label="Racing another chat">
      <RaceGlyph size={13} />
    </span>
  );
}

/** Where a swipe commits: a share of the row's width, at most this many pixels. */
const SWIPE_AT = 0.36;
const SWIPE_MAX = 132;

/**
 * A chat: its agent's mark, the title, the folder dim under it; the time, and its state at the
 * right (the working tiles, amber while it waits on you, a dot when unread). Swiped left it archives,
 * swiped right it pins (or unpins); held, its actions.
 */
export const Row = memo(function Row({ id, onMenu, swipe: swipeAsked = true, search }: { id: string; onMenu: (id: string, rect: DOMRect) => void; swipe?: boolean; search?: boolean }) {
  // Pin, archive and rename are the desktop's own in a browser (web/allow.ts): no swipe, no menu there.
  const actions = mayCall('session.update');
  const swipe = swipeAsked && actions;
  const s = useHome((st) => st.sessions[id]);
  const projects = useHome((st) => st.projects);
  const now = useNow();
  const li = useRef<HTMLLIElement>(null);
  const face = useRef<HTMLButtonElement>(null);
  const swiped = useRef(false);
  const lp = useLongPress((el) => actions && onMenu(id, el.getBoundingClientRect()));
  const lpCancel = useRef(lp.cancel);
  lpCancel.current = lp.cancel;
  const [gone, setGone] = useState(false);

  // The finger: a sideways pull moves the row over its two actions; up and down stays a scroll (touch-action: pan-y).
  useEffect(() => {
    const el = li.current;
    const f = face.current;
    if (!el || !f || !swipe) return;
    let pid: number | null = null;
    let x0 = 0;
    let y0 = 0;
    let x = 0;
    let mode: 'idle' | 'maybe' | 'swipe' = 'idle';
    let armed: 'pin' | 'archive' | null = null;
    let spring: { stop: () => void } | null = null;
    const pin = el.querySelector<HTMLElement>('.swipe-pin');
    const arc = el.querySelector<HTMLElement>('.swipe-archive');
    const at = () => Math.min(el.offsetWidth * SWIPE_AT, SWIPE_MAX);
    const set = (v: number) => {
      x = v;
      f.style.transform = v ? `translate3d(${v.toFixed(1)}px, 0, 0)` : '';
      const t = at();
      if (pin) pin.style.opacity = String(Math.min(1, Math.max(0, v) / (t * 0.6)));
      if (arc) arc.style.opacity = String(Math.min(1, Math.max(0, -v) / (t * 0.6)));
    };
    const arm = (next: typeof armed) => {
      if (next === armed) return;
      armed = next;
      el.dataset.armed = next ?? '';
      if (next) haptic('select');
    };
    const settle = (to: number, done?: () => void) => {
      spring?.stop();
      spring = animate(x, to, { type: 'spring', stiffness: 520, damping: 42, restDelta: 0.5, onUpdate: set, onComplete: done });
    };
    const down = (e: PointerEvent) => {
      if (pid !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      spring?.stop();
      pid = e.pointerId;
      x0 = e.clientX - x;
      y0 = e.clientY;
      mode = 'maybe';
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pid || mode === 'idle') return;
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      if (mode === 'maybe') {
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.3) {
          if (Math.abs(dy) > 10) mode = 'idle';
          return;
        }
        mode = 'swipe';
        lpCancel.current();
        el.dataset.swiping = '';
        try {
          f.setPointerCapture(e.pointerId);
        } catch {
          /* gone */
        }
      }
      const t = at();
      // Past the line it gets heavier (a rubber band), so the finger feels where it commits.
      const v = Math.abs(dx) <= t ? dx : Math.sign(dx) * (t + (Math.abs(dx) - t) * 0.35);
      set(v);
      arm(v >= t ? 'pin' : v <= -t ? 'archive' : null);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      pid = null;
      if (mode !== 'swipe') return void (mode = 'idle');
      mode = 'idle';
      swiped.current = true;
      window.setTimeout(() => (swiped.current = false), 50);
      const go = armed;
      arm(null);
      if (go === 'archive') {
        haptic('tap');
        settle(-el.offsetWidth - 24, () => setGone(true));
      } else {
        settle(0, () => delete el.dataset.swiping);
        if (go === 'pin') {
          const cur = getState().sessions[id];
          if (cur) void conn.call('session.update', { sessionId: id, patch: { pinned: !cur.pinned } }).catch(() => setState({ toast: { text: 'Could not pin it', level: 'error', at: Date.now() } }));
        }
      }
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      pid = null;
      if (mode === 'swipe') settle(0, () => delete el.dataset.swiping);
      mode = 'idle';
      arm(null);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    return () => {
      spring?.stop();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
    };
  }, [id, swipe]);

  // Swiped away: the gap closes, then the desktop is told (back in place if it refuses).
  useEffect(() => {
    const el = li.current;
    if (!gone || !el) return;
    let live = true;
    void animate(el, { height: [el.offsetHeight, 0], opacity: [1, 0] }, { ...REVEAL, restDelta: 0.5 })
      .finished.then(() => conn.call('session.update', { sessionId: id, patch: { archived: true } }))
      .then(
        () => {},
        () => {
          if (!live) return;
          el.style.height = '';
          el.style.opacity = '';
          if (face.current) face.current.style.transform = '';
          delete el.dataset.swiping;
          setGone(false);
          setState({ toast: { text: 'Could not archive it', level: 'error', at: Date.now() } });
        },
      );
    return () => {
      live = false;
    };
  }, [gone, id]);

  if (!s) return null;
  const tone = toneOf(s);
  const folder = folderName(s, projects);
  return (
    <motion.li
      ref={li}
      layout="position"
      className="rrow"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0, transition: { duration: 0.2 } }}
      transition={SNAP}
    >
      {swipe && (
        <>
          <span className="swipe-act swipe-pin" aria-hidden>
            <span className="swipe-disc">
              <Icon name={s.pinned ? 'unpin' : 'pin'} size={18} />
            </span>
            <span className="swipe-word">{s.pinned ? 'Unpin' : 'Pin'}</span>
          </span>
          <span className="swipe-act swipe-archive" aria-hidden>
            <span className="swipe-word">Archive</span>
            <span className="swipe-disc">
              <Icon name="archive" size={18} />
            </span>
          </span>
        </>
      )}
      <button
        ref={face}
        type="button"
        className="row"
        data-tone={tone}
        data-chat={search ? undefined : id}
        data-radius="17"
        {...lp.handlers}
        onClick={(e) => {
          if (lp.fired() || swiped.current || gone) return;
          haptic('tap');
          openFrom(id, e.currentTarget, 17);
          nav.chat(id);
        }}
      >
        <span className="row-mark">
          <ProviderMark provider={s.provider} size={15} />
        </span>
        <span className="row-main">
          <span className="row-title">{s.title}</span>
          <span className="row-sub">
            {tone === 'awaiting' ? <span className="row-wait">Waiting for you</span> : hasWork(s) && tone === 'working' ? <span className="row-folder">{workLabel(s)}</span> : <span className="row-folder">{folder}</span>}
          </span>
        </span>
        <span className="row-end">
          <span className="row-time num">{tone === 'working' ? '' : timeAgo(s.updatedAt, now)}</span>
          <span className="row-state">
            {openRace(s) && <RaceMark />}
            {s.pinned && !swipe && <Icon name="pin" size={12} className="row-pin" />}
            {tone === 'working' ? <Tiles size={11} /> : tone === 'awaiting' ? <StatusMark tone="awaiting" size={11} /> : tone === 'error' ? <StatusMark tone="error" size={10} /> : tone === 'unread' ? <StatusMark tone="unread" size={10} /> : null}
          </span>
        </span>
      </button>
    </motion.li>
  );
});

/**
 * A long press lifts the chat out of the list: the row (as it was) over a dimmed screen, its
 * actions under it. Rename turns the menu into a field in place.
 */
function Peek({ peek, onClose }: { peek: { id: string; rect: DOMRect } | null; onClose: () => void }) {
  const s = useStore((st) => (peek ? st.sessions[peek.id] : undefined));
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const show = !!peek && !!s;
  useEffect(() => {
    setRenaming(false);
    setTitle(s?.title ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek?.id]);
  useEffect(() => (show ? pushBack(() => (renaming ? setRenaming(false) : onClose(), true)) : undefined), [show, renaming, onClose]);
  if (!peek) return null;
  const r = peek.rect;
  // The menu goes under the row, or over it when the row is low on the screen.
  const below = r.bottom + 200 < innerHeight - 40;
  const pin = () => {
    if (!s) return;
    haptic('select');
    void conn.call('session.update', { sessionId: s.id, patch: { pinned: !s.pinned } }).catch(() => {});
    onClose();
  };
  const archive = () => {
    if (!s) return;
    haptic('select');
    onClose();
    void conn.call('session.update', { sessionId: s.id, patch: { archived: true } }).catch(() => setState({ toast: { text: 'Could not archive it', level: 'error', at: Date.now() } }));
  };
  return createPortal(
    <AnimatePresence>
      {show && (
        <div className="peek-layer" key={peek.id}>
          <motion.div className="peek-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onClick={onClose} />
          <motion.div
            className="peek-row"
            style={{ top: r.top, left: 16, right: 16, height: r.height }}
            initial={{ scale: 1 }}
            animate={{ scale: 1.035 }}
            exit={{ scale: 1, opacity: 0, transition: { duration: 0.14 } }}
            transition={SNAP}
          >
            <ProviderMark provider={s!.provider} size={15} />
            <span className="row-title">{s!.title}</span>
          </motion.div>
          <motion.div
            className="peek-menu"
            style={below ? { top: r.bottom + 12, left: 16, right: 16 } : { bottom: innerHeight - r.top + 12, left: 16, right: 16 }}
            initial={{ opacity: 0, scale: 0.92, y: below ? -12 : 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
            transition={SNAP}
          >
            {renaming ? (
              <form
                className="rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  const t = title.trim();
                  if (t && t !== s!.title) void conn.call('session.rename', { sessionId: s!.id, title: t }).catch(() => {});
                  haptic('success');
                  onClose();
                }}
              >
                <input className="field-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Chat name" enterKeyHint="done" />
                <button type="submit" className="btn btn-primary">
                  Save
                </button>
              </form>
            ) : (
              <>
                <button type="button" className="peek-item" onClick={pin}>
                  <span>{s!.pinned ? 'Unpin' : 'Pin to top'}</span>
                  <Icon name={s!.pinned ? 'unpin' : 'pin'} size={20} />
                </button>
                <button type="button" className="peek-item" onClick={() => (haptic('tap'), setRenaming(true))}>
                  <span>Rename</span>
                  <Icon name="edit" size={20} />
                </button>
                <button type="button" className="peek-item" onClick={archive}>
                  <span>Archive</span>
                  <Icon name="archive" size={20} />
                </button>
              </>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
