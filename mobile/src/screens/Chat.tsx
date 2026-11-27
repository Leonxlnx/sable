import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionMeta, ToolItem } from '@shared/protocol';
import { baseName } from '@desk/lib/format';
import { useComments } from '@m/lib/comments';
import { conn } from '@m/lib/conn';
import { onKeyboard } from '@m/lib/keyboard';
import { haptic, openExternal } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { homeFolder, openRace, swapTo } from '@m/lib/race';
import { applyFull, applyOlder, closeGap, fetchItem, fetchNewer, fetchOlder, getState, openAt, openSession, sessionData, setState, showCached, useStore } from '@m/lib/store';
import { around, growDown, growUp, MOUNT_MAX, rangeOf, SpacerSums, trimTop, type Win } from '@m/lib/window';
import { matchRanges, searchWords } from '@m/lib/find';
import { canStop, followSent, newestSent, wholeForFind, worksNow } from '@m/lib/chat-rules';
import { takeSentHere } from '@m/lib/follow';
import { groupTurns, stabilize } from '@m/lib/turns';
import { useNow } from '@m/lib/useNow';
import { servingLabel, tailLabel, waited, workCounts } from '@shared/work-label';
import { backgroundSince, runningMonitors } from '@m/lib/work-now';
import { openWorkSheet, WorkSheet } from './WorkSheet';
import { veilFirst } from '@m/ui/screen-veil';
import { Field, paletteFor } from '@m/ui/Field';
import { Icon } from '@m/ui/icons';
import { PROVIDER_NAME, ProviderMark, RaceGlyph, Ring, StatusMark, Tiles } from '@m/ui/marks';
import { IME_EASE, SNAP } from '@m/ui/motion';
import { Sheet } from '@m/ui/Sheet';
import { footRoom } from '@m/lib/foot-room';
import { clockOf, liveWords, useSecond } from '@m/lib/live-words';
import { Composer } from './Composer';
import { Prompts } from './Prompts';
import { ReviewLine } from './Review';
import { ItemRow, TurnGuard, TurnView } from './Timeline';

const PAGE = 24;
const FIRST = 5;
/** Frames a search hit that was folded away is waited for once its folds were told to open. */
const REVEAL_FRAMES = 24;
/** Then the steps it is in finish unfolding before it is measured (ms). */
const REVEAL_SETTLE_MS = 260;

/**
 * A conversation: header, turns (the newest ones mounted, older ones as you scroll up), composer.
 * `at`: opened at a place (a search hit, or 'turn': the newest turn's start, from a notification).
 */
export function Chat({ id, at, seq, find }: { id: string; at?: string; seq?: number; find?: string }) {
  const s = useStore((st) => st.sessions[id]);
  const loaded = useStore((st) => !!st.data[id]);
  const listed = useStore((st) => !!st.fresh);
  const connState = useStore((st) => st.conn);
  const desktop = useStore((st) => st.desktop);
  // Racing another chat that is still there: its header carries the race key.
  const racing = useStore((st) => {
    const r = openRace(st.sessions[id]);
    const rival = r ? st.sessions[r.rival] : undefined;
    return !!rival && !rival.archived;
  });
  const [error, setError] = useState<string>();
  const [remote, setRemote] = useState(false);
  // The account it runs on, named under the title when its agent has more than one (2.21).
  const accountWord = useStore((st) => {
    const ss = st.sessions[id];
    const list = ss ? st.providers[ss.provider]?.accounts : undefined;
    return list && list.length > 1 ? list.find((a) => a.id === (ss!.accountId ?? 'default'))?.label : undefined;
  });
  // The conversation mounts a frame after the screen: the tap answers at once and the screen's opening
  // (on the compositor) is under way while the turns are built (they took the tap's own task, 140 ms
  // on the emulator, before anything moved). The screen is still transparent then, so nothing flashes.
  const [later, setLater] = useState(true);
  useEffect(() => {
    const r = requestAnimationFrame(() => setLater(false));
    return () => cancelAnimationFrame(r);
  }, []);

  // The newest page as the phone last had it shows at once; the desktop's follows.
  useLayoutEffect(() => {
    setError(undefined);
    showCached(id);
    // A connection replaced meanwhile loads it again by itself (the skeleton stays).
    // A search hit opens on a bounded page around it (the thread mounts a window there and says so when it is gone).
    const to = at && at !== 'turn' ? at : undefined;
    const lost = (err: unknown) => !/connection to the desktop was lost/i.test((err as Error).message) && setError((err as Error).message);
    if (getState().conn === 'open') void (to ? openAt(id, to).then((r) => (r === 'gone' && !getState().data[id] ? openSession(id) : undefined)) : openSession(id)).catch(lost);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!s) {
    return (
      <div className="screen chat">
        <ChatHead title="" onBack={() => veilFirst(() => nav.pop())} />
        {listed ? <p className="empty">This chat is no longer on the desktop.</p> : <div className="thread-skel"><ThreadSkeleton /></div>}
      </div>
    );
  }
  const live = s.status === 'running' || s.status === 'starting';
  const waiting = s.status === 'awaiting';
  const remoteOn = !!s.options?.remoteControl || !!s.remote;

  return (
    <div className="screen chat" data-live={live || undefined} data-waiting={waiting || undefined}>
      <Field palette={paletteFor(s.provider)} amount={0.7} focusX={0.62} focusY={0.985} spread={0.6} active={live} waiting={waiting} under=".composer, .ro-foot" />
      <ChatHead
        title={s.title}
        sub={connState === 'open' ? [s.chat ? undefined : baseName(homeFolder(s)), accountWord].filter(Boolean).join(' · ') || undefined : undefined}
        status={connState === 'open' ? undefined : connState === 'denied' ? 'Not paired' : listed ? 'Reconnecting' : 'Connecting'}
        work={connState === 'open' && worksNow(s) ? <WorkWords id={id} /> : undefined}
        onWork={() => (haptic('tap'), openWorkSheet(id))}
        mark={<ProviderMark provider={s.provider} size={16} />}
        onBack={() => veilFirst(() => nav.pop())}
        race={racing ? <RaceKey s={s} /> : undefined}
        right={
          <>
            <ChangesKey id={id} />
            {(s.provider === 'claude' || s.provider === 'demo' || remoteOn) && (
              <button type="button" className="icon-btn remote-btn" data-tone={s.remote?.tone ?? (remoteOn ? 'waiting' : 'off')} aria-label="Remote control" onClick={() => (haptic('tap'), setRemote(true))}>
                <Icon name="link" size={20} />
                {remoteOn && <i className="remote-dot" />}
              </button>
            )}
          </>
        }
      />
      {later ? (
        <div className="thread-skel" />
      ) : loaded ? (
        <Thread id={id} at={at} seq={seq} find={find} />
      ) : (
        <div className="thread-skel">
          {error ? <p className="empty">{error}</p> : connState === 'offline' ? <p className="empty">This chat opens when {desktop ?? 'the computer'} is back.</p> : <ThreadSkeleton />}
        </div>
      )}
      {s.custom ? (
        // The Customize chat can change the desktop's look: it is read here and answered on the computer (a running turn can still be stopped).
        <div className="chat-foot" ref={footRef}>
          <ReadOnlyFoot id={id} status={s.status} desktop={desktop} />
        </div>
      ) : (
        <div className="chat-foot" ref={footRef}>
          <Prompts sid={id} />
          <ReviewLine sid={id} />
          <Composer sid={id} />
        </div>
      )}
      <RemoteSheet id={id} open={remote} onClose={() => setRemote(false)} />
      <WorkSheet id={id} />
    </div>
  );
}

/** The foot of a chat answered on the computer: says so, with the stop key while its turn can be stopped. */
/** The foot (what waits, the queue, the prompt bar) lies over the conversation: its height is the room the thread keeps after its last line. */
const footRef = footRoom('--foot-h');

function ReadOnlyFoot({ id, status, desktop }: { id: string; status: SessionMeta['status']; desktop?: string }) {
  const online = useStore((st) => st.conn === 'open');
  const stoppable = canStop(status);
  const stop = () => {
    haptic('warning');
    void conn.call('session.interrupt', { sessionId: id }).catch((err: Error) => setState({ toast: { text: err.message, level: 'error', at: Date.now() } }));
  };
  return (
    <div className="ro-foot" data-stop={stoppable || undefined}>
      <p className="ro-foot-text">Answered on {desktop ?? 'the computer'}</p>
      {stoppable && (
        <button type="button" className="send" data-stop aria-label="Stop" disabled={!online} onClick={stop}>
          <span className="stop-square" />
        </button>
      )}
    </div>
  );
}

/**
 * Under the title while the chat works (2.21): what it does now by kind ("Editing 3 files"), its steps
 * and its clock, from the bridge's reading of the turn (lib/live-words.ts); its own clock, so the chat
 * under it never renders for a tick.
 */
function WorkWords({ id }: { id: string }) {
  const s = useStore((st) => st.sessions[id]);
  // With its own turn over, the oldest of what still works (the last line's own reading), not when the phone first saw it.
  const bgSince = useStore((st) => (st.sessions[id] && st.sessions[id].status !== 'running' && st.sessions[id].status !== 'starting' ? backgroundSince(st.sessions[id], sessionData(st, id).items) : undefined));
  const now = useSecond(true);
  const first = useRef(now);
  if (!s) return null;
  const w = liveWords(s);
  if (!w.since && bgSince) w.since = bgSince;
  return (
    <>
      <span key={w.line} className="chat-work-text">
        {w.line}
      </span>
      {w.steps > 0 && <span className="chat-work-meta num">{w.steps} {w.steps === 1 ? 'step' : 'steps'}</span>}
      <span className="chat-work-meta num">{clockOf(now - (w.since ?? first.current))}</span>
    </>
  );
}

function ChatHead({ title, sub, status, work, onWork, mark, onBack, race, right }: { title: string; sub?: string; status?: string; work?: React.ReactNode; onWork?: () => void; mark?: React.ReactNode; onBack: () => void; race?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="chat-head">
      <button type="button" className="icon-btn back-btn" aria-label="Back" onClick={() => (haptic('tap'), onBack())}>
        <Icon name="back" size={22} />
      </button>
      <div className="chat-titles">
        <div className="chat-title">
          {mark}
          <span>{title}</span>
        </div>
        <AnimatePresence mode="popLayout" initial={false}>
          {status ? (
            <motion.div key="status" className="chat-sub chat-status" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={SNAP}>
              <Ring size={11} /> {status}
            </motion.div>
          ) : work ? (
            // At work (its turn, or sub-agents and commands it left working): a living mark under the title, wherever the reader is;
            // a tap raises "Working now" (WorkSheet.tsx), everything of the chat at work with what each does.
            <motion.button key="work" type="button" className="chat-sub chat-work" aria-label="Working now" onClick={onWork} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={SNAP}>
              <Tiles size={12} />
              <span className="chat-work-words" role="status">
                {work}
              </span>
            </motion.button>
          ) : sub ? (
            <motion.div key="sub" className="chat-sub" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={SNAP}>
              {sub}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      {race}
      {right ?? (race ? null : <span className="icon-btn-spacer" />)}
    </header>
  );
}

/** The chat's changes (its folder's working tree, or its own edits): a dot while review comments wait to be sent. */
function ChangesKey({ id }: { id: string }) {
  const waiting = useComments(id).length > 0;
  return (
    <button type="button" className="icon-btn changes-key" aria-label={waiting ? 'Changes, review comments waiting' : 'Changes'} onClick={() => (haptic('tap'), nav.push({ name: 'changes', id }))}>
      <Icon name="diff" size={20} />
      {waiting && <i className="remote-dot changes-dot" />}
    </button>
  );
}

/**
 * A chat racing another (the desktop's `/race`): a quiet "Race" key in its header with the rival's
 * mark (amber dot when the rival waits on you). A tap puts the rival in its place, the two sliding
 * as the race's columns do. Gone once the race is decided.
 */
function RaceKey({ s }: { s: SessionMeta }) {
  const race = openRace(s);
  const rival = useStore((st) => (race ? st.sessions[race.rival] : undefined));
  if (!race || !rival || rival.archived) return null;
  const waits = rival.status === 'awaiting';
  return (
    <button
      type="button"
      className="race-key"
      aria-label={`Race. Go to the other chat, ${PROVIDER_NAME[rival.provider]}${waits ? ', waiting for you' : ''}`}
      onClick={() => {
        haptic('select');
        swapTo(s.id, rival.id, rival.race?.side ?? (race.side === 0 ? 1 : 0));
        nav.chat(rival.id);
      }}
    >
      <span className="race-key-in">
        <RaceGlyph size={14} />
        <span>Race</span>
        <span className="race-key-rival">
          <ProviderMark provider={rival.provider} size={13} />
          {waits && <StatusMark tone="awaiting" size={8} />}
        </span>
      </span>
    </button>
  );
}

function Thread({ id, at, seq, find }: { id: string; at?: string; seq?: number; find?: string }) {
  const roots = useStore((st) => sessionData(st, id).roots);
  // One character per root (lib/turns.ts), kept by the store per changed id: the grouping is read again
  // only when that string changes, and a streamed word never walks the loaded history.
  const shape = useStore((st) => sessionData(st, id).shape);
  const status = useStore((st) => st.sessions[id]?.status);
  const cursor = useStore((st) => sessionData(st, id).cursor);
  // Opened around a message far back: the pages stop before the newest, the rest comes as you read on.
  const gapped = useStore((st) => !!sessionData(st, id).next);
  const epoch = useStore((st) => sessionData(st, id).epoch ?? 0);
  const busy = status === 'running' || status === 'starting' || status === 'awaiting';
  // Turns and segments that did not change keep their object, so their views do not render again.
  const kept = useRef(new Map<string, unknown>());
  const layout = useMemo(() => {
    // The turn a check belongs to never changes, so reading it once per shape is enough.
    const items = sessionData(getState(), id).items;
    const checkOf = (x: string) => (items[x] as ToolItem | undefined)?.check?.turn;
    return stabilize(groupTurns(roots, shape, busy, checkOf), kept.current);
  }, [roots, shape, busy, id]);
  const turns = layout.groups;
  const keys = useMemo(() => turns.map((g) => g.key), [turns]);
  const [older, setOlder] = useState(false);
  const olderBusy = useRef(false);
  const newerBusy = useRef(false);
  // The newest few turns first (the chat opens at once), the rest of the page right after it has opened.
  const [count, setCount] = useState(FIRST);
  // Or a window of them (lib/window.ts): opened at a message far back, or scrolled past what may be
  // mounted at once; above and below it stand spacers of the height the groups had.
  const [win, setWin] = useState<Win | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setCount((c) => Math.max(c, PAGE)), 520);
    return () => clearTimeout(t);
  }, []);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const anchor = useRef<{ h: number; top: number } | null>(null);
  const range = rangeOf(keys, win, count);
  const start = range.lo;
  const shown = turns.slice(range.lo, range.hi);
  // The groups' heights with the spacers' sums kept over them (summed again only when the groups or a height change, never per scroll frame).
  const [heights] = useState(() => new SpacerSums());
  const space = win ? heights.of(keys, range) : { top: 0, bottom: 0 };
  const groupsRef = useRef(turns);
  groupsRef.current = turns;
  const countRef = useRef(count);
  countRef.current = count;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const winRef = useRef(win);
  winRef.current = win;
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const gappedRef = useRef(gapped);
  gappedRef.current = gapped;

  /** The mounted groups' heights, read before the window moves: one that leaves becomes a spacer that tall (nothing on screen moves). */
  const record = () => {
    const c = content.current;
    if (!c) return;
    for (const el of c.querySelectorAll<HTMLElement>(':scope > [data-turn]')) if (el.dataset.turn) heights.set(el.dataset.turn, el.offsetHeight);
  };

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Stays at the newest line while it grows, unless you scrolled up to read.
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    toBottom();
    const ro = new ResizeObserver(() => {
      if (anchor.current && scroller.current) {
        const sc = scroller.current;
        sc.scrollTop = anchor.current.top + (sc.scrollHeight - anchor.current.h);
        anchor.current = null;
        return;
      }
      if (atBottom.current) toBottom();
      // A short page that does not fill the screen: the one before it (or after it, opened far back) comes at once.
      const sc = scroller.current;
      if (sc && sc.scrollHeight < sc.clientHeight + 400) {
        olderRef.current();
        if (gappedRef.current) newerRef.current();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  // The keyboard: the room it takes is added under the newest line, and (when reading the newest)
  // the conversation glides up with it on its curve instead of jumping.
  useEffect(
    () =>
      onKeyboard((lift, prev, ms) => {
        const sc = scroller.current;
        const c = content.current;
        if (!sc || !c) return;
        c.style.paddingBottom = lift ? `${lift + 28}px` : '';
        if (!atBottom.current) return;
        const before = sc.scrollTop;
        sc.scrollTop = sc.scrollHeight;
        const d = sc.scrollTop - before;
        if (d && ms > 0) c.animate([{ transform: `translate3d(0, ${d}px, 0)` }, { transform: 'none' }], { duration: ms, easing: `cubic-bezier(${IME_EASE.join(',')})` });
        void prev;
      }),
    [],
  );

  // Something opened by a tap (a turn's line, a checkpoint's steps) stays where it is: the
  // conversation stops following the newest line until you scroll back to it.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onHold = () => (atBottom.current = false);
    el.addEventListener('sable:hold', onHold);
    return () => el.removeEventListener('sable:hold', onHold);
  }, []);

  // Only your own scrolling lets go of the newest line (a smooth jump or a growing answer never does).
  const touch = useRef({ down: false, at: 0 });
  const frame = useRef(0);
  // While the conversation moves, the prompt bar drops its blur (drawn again every frame otherwise); at rest it is glass again.
  const moving = useRef(0);
  const onScroll = () => {
    if (!frame.current) frame.current = requestAnimationFrame(measure);
    const chat = scroller.current?.parentElement;
    if (!chat) return;
    if (!moving.current) chat.setAttribute('data-moving', '');
    clearTimeout(moving.current);
    moving.current = window.setTimeout(() => {
      moving.current = 0;
      chat.removeAttribute('data-moving');
    }, 200);
  };
  // Read once per frame, not once per scroll event.
  const measure = () => {
    frame.current = 0;
    const el = scroller.current;
    if (!el) return;
    const r = rangeRef.current;
    const w = winRef.current;
    const ks = keysRef.current;
    const sp = w ? heights.of(ks, r) : { top: 0, bottom: 0 };
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const byHand = touch.current.down || performance.now() - touch.current.at < 1200;
    // At the newest only where the newest is: the window reaches it and nothing waits after it.
    const newest = r.hi >= ks.length && !gappedRef.current;
    if (gap < 48 && newest) atBottom.current = true;
    else if (byHand) atBottom.current = false;
    setShowJump(gap > 600 || !newest);
    if (el.scrollTop - sp.top < 600 && !anchor.current) {
      if (r.lo > 0) {
        anchor.current = { h: el.scrollHeight, top: el.scrollTop };
        if (!w && countRef.current + PAGE <= MOUNT_MAX) setCount((c) => c + PAGE);
        else {
          record();
          setWin(growUp(ks, r));
        }
      } else olderRef.current();
    } else if (gap - sp.bottom < 600) {
      if (w && r.hi < ks.length) {
        record();
        setWin(growDown(ks, r));
      } else {
        // At the end of what is here: the next page comes (opened far back), and the oldest turns give way past the cap.
        if (gappedRef.current) newerRef.current();
        const t = w ? trimTop(ks, r) : null;
        if (t) {
          record();
          setWin(t);
        }
      }
    }
  };

  // Scrolling up past what the phone holds asks the desktop for the page before (kept in place: no jump).
  const loadOlder = () => {
    if (olderBusy.current || !cursor || start > 0) return;
    olderBusy.current = true;
    setOlder(true);
    void fetchOlder(id)
      .then((pages) => {
        const sc = scroller.current;
        if (!pages.length || !sc) return;
        const a = (anchor.current = { h: sc.scrollHeight, top: sc.scrollTop });
        let added = 0;
        for (const r of pages) {
          applyOlder(id, r);
          added += r.page.items.length;
        }
        if (!winRef.current) setCount((c) => Math.min(MOUNT_MAX, c + added));
        // Steps that went into a folded line add no height: then nothing moves and the next scroll may ask again.
        requestAnimationFrame(() => requestAnimationFrame(() => anchor.current === a && (anchor.current = null)));
      })
      .catch(() => {})
      .finally(() => {
        olderBusy.current = false;
        setOlder(false);
      });
  };
  const olderRef = useRef(loadOlder);
  olderRef.current = loadOlder;

  // Read on toward the newest from a message far back: the page after the last one here (below: nothing on screen moves).
  const loadNewer = () => {
    if (newerBusy.current || !gappedRef.current) return;
    // What is mounted stays where it is while pages land after it (without a window it would follow the newest of them).
    if (!winRef.current) {
      const r = rangeRef.current;
      const ks = keysRef.current;
      if (ks.length) setWin({ lo: ks[r.lo], hi: r.hi >= ks.length ? null : ks[r.hi] });
    }
    newerBusy.current = true;
    void fetchNewer(id)
      .catch(() => {})
      .finally(() => (newerBusy.current = false));
  };
  const newerRef = useRef(loadNewer);
  newerRef.current = loadNewer;

  // Sending scrolls to the newest (not while a window far back is being read: sending closes it first).
  const newestTurn = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].kind === 'turn') return turns[i];
    return undefined;
  }, [turns]);
  // Only a message the person sent, newer than the one followed last: a turn a notification or a
  // background tool began, or a rewind that leaves an older message last, leaves a reader scrolled up where they are.
  const sent = useMemo(() => newestSent(roots, sessionData(getState(), id).items), [roots, id]);
  const followed = useRef(sent);
  useEffect(() => {
    const prev = followed.current;
    followed.current = sent;
    if (!followSent(prev, sent)) return;
    // Only a message this phone sent or steered just now (lib/follow.ts): a queued one the desktop
    // starts, or one from another client, leaves the reader where they are.
    if (!takeSentHere(id)) return;
    if (goal.current || gappedRef.current || (winRef.current && winRef.current.hi !== null)) return;
    atBottom.current = true;
    toBottom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent?.id, toBottom]);

  // Opened at a place: the turns that hold it are mounted, and it comes to the top of the screen, lit
  // for a moment. Waits for the desktop's page (not the cached one); a message far back comes as a
  // page around it (never every page between) and a window of turns around it is mounted. One the chat
  // no longer has, or that cannot be reached, is said so.
  const goal = useRef<{ at: string; seq?: number; find?: string } | null>(at ? { at, seq, find } : null);
  const [aim, setAim] = useState(0);
  // The item looked for, while the folds around it open (the turn that holds it is told).
  const [reveal, setReveal] = useState<string>();
  useEffect(() => {
    if (!at) return;
    goal.current = { at, seq, find };
    setAim((n) => n + 1);
  }, [at, seq]);
  const fresh = useStore((st) => !!st.data[id] && !st.data[id].cached);
  // The whole chat replaced (the newest page again, or a page around a message): what is mounted starts over.
  const lastEpoch = useRef(epoch);
  useEffect(() => {
    if (lastEpoch.current === epoch) return;
    lastEpoch.current = epoch;
    heights.clear();
    if (goal.current) return;
    setWin(null);
    setCount(PAGE);
  }, [epoch]);
  useEffect(() => {
    const g = goal.current;
    if (!g || !fresh) return;
    let live = true;
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const missed = () => setState({ toast: { text: 'That message is no longer in this chat.', level: 'info', at: Date.now() } });
    void (async () => {
      const target = g.at;
      if (target !== 'turn' && (await openAt(id, target).catch(() => 'gone' as const)) === 'gone') {
        if (!live) return;
        goal.current = null;
        return missed();
      }
      // Two frames: the pages just added are grouped and drawn.
      await frames();
      if (!live) return;
      const all = groupsRef.current;
      const idx = target === 'turn' ? all.findLastIndex((x) => x.kind === 'turn') : all.findIndex((x) => (x.kind === 'turn' ? x.ids.includes(target) : x.id === target));
      if (idx < 0) {
        goal.current = null;
        if (target !== 'turn') missed();
        return;
      }
      const r = rangeRef.current;
      if (target !== 'turn') {
        // Only the turns around it: a few before, more after (read on toward the newest); pages that land later never move them.
        setWin(around(keysRef.current, idx));
        await frames();
        if (!live) return;
      } else if (idx < r.lo || idx >= r.hi) {
        if (!winRef.current && all.length - idx <= MOUNT_MAX) setCount(all.length - idx + 2);
        else setWin(around(keysRef.current, idx));
        await frames();
        if (!live) return;
      }
      const sc = scroller.current;
      const group = all[idx];
      const exact = () => (sc && target !== 'turn' ? sc.querySelector<HTMLElement>(`[data-id="${CSS.escape(target)}"]`) : null);
      let hitEl = exact();
      // Folded away (a note of a finished turn, a step in a checkpoint): the folds around it open, and
      // it is waited for (bounded) before anything scrolls; the turn stands in only when it never comes.
      if (target !== 'turn' && !hitEl) {
        setReveal(target);
        for (let n = 0; n < REVEAL_FRAMES && !hitEl; n++) {
          await new Promise((r) => requestAnimationFrame(r));
          if (!live) return;
          hitEl = exact();
        }
        // The steps it is in may still be unfolding: their height settles before it is measured.
        if (hitEl) await new Promise((r) => window.setTimeout(r, REVEAL_SETTLE_MS));
        if (!live) return;
      }
      const turnEl = sc?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(group.key)}"]`);
      const el = hitEl || turnEl;
      goal.current = null;
      setReveal(undefined);
      if (!sc || !el) return;
      const topOf = () => el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      // The newest turn, short enough to read whole: the newest line stays in view as always.
      if (target === 'turn' && el.offsetHeight < sc.clientHeight - 140) {
        atBottom.current = true;
        return toBottom();
      }
      atBottom.current = false;
      // Turns off screen are not laid out (content-visibility): there first, then measured where it is drawn.
      sc.scrollTo({ top: Math.max(0, topOf() - 84), behavior: 'auto' });
      await frames();
      if (!live) return;
      const top = topOf();
      // The words searched for, in a long message: they come into view (a third down) and are lit.
      let hit = target !== 'turn' && g.find ? findWords(el, g.find) : null;
      let place: HTMLElement = el;
      // Not in what the phone got of it (a long text comes cut): the item is fetched whole, shown
      // whole, and the words looked for again; still not there, its top is shown as before.
      if (target !== 'turn' && g.find && wholeForFind(sessionData(getState(), id).items[target], !!hit)) {
        const whole = await fetchItem(id, target).catch(() => null);
        if (!live) return;
        if (whole) {
          applyFull(id, whole.item);
          await frames();
          if (!live) return;
          place = exact() ?? el;
          hit = findWords(place, g.find);
        }
      }
      const rect = hit?.getBoundingClientRect();
      const y = rect && rect.height ? rect.top - sc.getBoundingClientRect().top + sc.scrollTop - sc.clientHeight * 0.32 : top - 84;
      sc.scrollTo({ top: Math.max(0, Math.min(y, top - 84 + Math.max(0, place.offsetHeight - 120))), behavior: 'auto' });
      if (target !== 'turn') {
        place.setAttribute('data-flash', '');
        window.setTimeout(() => place.removeAttribute('data-flash'), 1600);
        if (hit) lightWords(hit);
      }
    })();
    return () => {
      live = false;
      setReveal(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aim, fresh, id]);

  return (
    <div
      className="thread"
      ref={scroller}
      onScroll={onScroll}
      onTouchStart={() => (touch.current.down = true)}
      onTouchEnd={() => (touch.current = { down: false, at: performance.now() })}
      onTouchCancel={() => (touch.current = { down: false, at: performance.now() })}
    >
      <div className="thread-content" ref={content}>
        {(start > 0 || cursor) && (
          <div className="thread-more" aria-busy={older || undefined}>
            {older ? <Ring size={13} /> : <span className="thread-more-line" />}
          </div>
        )}
        {space.top > 0 && <div className="thread-space" style={{ height: space.top }} aria-hidden />}
        {turns.length === 0 && <p className="empty thread-empty">Send a message to start.</p>}
        {shown.map((g) =>
          g.kind === 'turn' ? (
            <TurnGuard key={g.key} id={g.key} turn={g}>
              <TurnView sid={id} turn={g} newest={g === newestTurn} reveal={reveal && g.ids.includes(reveal) ? reveal : undefined} />
            </TurnGuard>
          ) : (
            <TurnGuard key={g.key} id={g.key} turn={g}>
              <div data-turn={g.key}>
                <ItemRow sid={id} id={g.id} />
              </div>
            </TurnGuard>
          ),
        )}
        {space.bottom > 0 && <div className="thread-space" style={{ height: space.bottom }} aria-hidden />}
        {gapped && (
          <div className="thread-more" aria-hidden>
            <span className="thread-more-line" />
          </div>
        )}
        {!gapped &&
          range.hi >= keys.length &&
          layout.queued.map((q) => (
            <TurnGuard key={q} id={q} turn={q}>
              <ItemRow sid={id} id={q} queued />
            </TurnGuard>
          ))}
        {!gapped && range.hi >= keys.length && !busy && <BackgroundLine id={id} />}
        {/* The prompt bar lies over the conversation (2.21): this much room after the last line, so it can scroll out from under the glass. */}
        <div className="thread-foot" aria-hidden />
      </div>
      <AnimatePresence>
        {showJump && (
          <motion.button
            type="button"
            className="jump glass-liquid"
            aria-label="Jump to the newest"
            initial={{ opacity: 0, y: 10, scale: 0.85 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.85 }}
            transition={SNAP}
            whileTap={{ scale: 0.9 }}
            onClick={() => {
              haptic('tap');
              atBottom.current = true;
              // From a window far back: the newest again (the pages after it fetched as one newest page).
              if (gappedRef.current) void closeGap(id).catch(() => {});
              else if (winRef.current) {
                setWin(null);
                setCount(PAGE);
              }
              toBottom(true);
            }}
          >
            <Icon name="down" size={18} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Under the conversation once the chat's own turn has ended while sub-agents or background commands it started still work. */
function BackgroundLine({ id }: { id: string }) {
  // The desktop's last line (timeline/Tail.tsx), in the shared words (`tailLabel`): "2 sub-agents
  // working", "Waiting for 1 background command", a single tracked job by its own title, with how long
  // the oldest of it has run where that is known (a job's start is the bridge's; the phone has the
  // commands' and sub-agents' own steps only when they are loaded).
  const s = useStore((st) => st.sessions[id]);
  const monitors = useStore((st) => (st.sessions[id]?.commands ? runningMonitors(sessionData(st, id).items) : 0));
  const since = useStore((st) => backgroundSince(st.sessions[id], sessionData(st, id).items));
  const now = useNow();
  const serving = servingLabel(s ?? {});
  if (!s) return null;
  const c = workCounts(s);
  const label = s.until?.phase === 'checking' ? 'Running the check' : tailLabel({ agents: c.agents, commands: c.commands, monitors, jobs: c.jobs, jobTitle: s.trackedTitle });
  if (!label) return serving ? <ServingLine label={serving} since={s.servingSince} /> : null;
  const ran = since && now - since >= 1000 ? waited(now - since) : '';
  return (
    <button type="button" className="bg-line" aria-label={`${label}${ran ? `, ${ran}` : ''}. What works now`} onClick={() => (haptic('tap'), openWorkSheet(id))}>
      <span className="work-ind">
        <Tiles size={13} />
      </span>
      <span className="bg-line-text">{label}</span>
      {ran && <span className="bg-line-time num">{ran}</span>}
    </button>
  );
}

function ServingLine({ label, since }: { label: string; since?: number }) {
  const now = useNow();
  return <div className="bg-line" role="status">{label}{since && now - since >= 1000 ? ` · ${waited(now - since)}` : ''}</div>;
}

/** The first place in a message where a searched word stands (a range over it, in the text's own offsets: lib/find.ts), or null. */
function findWords(el: HTMLElement, find: string): Range | null {
  const words = searchWords(find);
  if (!words.length) return null;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const [hit] = matchRanges(n.nodeValue ?? '', words);
    if (!hit) continue;
    const r = document.createRange();
    r.setStart(n, hit[0]);
    r.setEnd(n, hit[1]);
    return r;
  }
  return null;
}

/** The words lit for a moment (the CSS highlight API: nothing in the page changes). */
function lightWords(r: Range) {
  const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !H) return;
  reg.set('sable-hit', new H(r));
  window.setTimeout(() => reg.delete('sable-hit'), 2600);
}

function ThreadSkeleton() {
  return (
    <div className="thread-skel-body" aria-hidden>
      <span className="skel skel-bubble" />
      <span className="skel skel-line" style={{ width: '42%' }} />
      <span className="skel" style={{ width: '88%' }} />
      <span className="skel" style={{ width: '76%' }} />
      <span className="skel" style={{ width: '82%' }} />
      <span className="skel" style={{ width: '54%' }} />
    </div>
  );
}

/** A link as a person reads it: the host bright, the rest quiet (and cut, never wrapped). */
function linkParts(url: string) {
  try {
    const u = new URL(url);
    return { host: u.host.replace(/^www\./, ''), rest: `${u.pathname === '/' ? '' : u.pathname}${u.search}` };
  } catch {
    return { host: url, rest: '' };
  }
}

/**
 * Claude's Remote Control for this chat: the agent's mark in its well, the switch, where it stands
 * (a dot in the state's tone), and once there is a link: the link as one row (a tap copies it) and the
 * ivory key that opens it in Claude.
 */
function RemoteSheet({ id, open, onClose }: { id: string; open: boolean; onClose: () => void }) {
  const s = useStore((st) => st.sessions[id]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  if (!s) return null;
  const on = !!s.options?.remoteControl;
  const r = s.remote;
  const toggle = async () => {
    setBusy(true);
    haptic('select');
    try {
      await conn.call('session.setOptions', { sessionId: id, options: { remoteControl: !on } });
    } catch (err) {
      haptic('deny');
      setState({ toast: { text: (err as Error).message, level: 'error', at: Date.now() } });
    } finally {
      setBusy(false);
    }
  };
  const tone = !on ? 'off' : (r?.tone ?? 'waiting');
  const status = !on ? 'Off' : (r?.status ?? 'Starting');
  const link = r?.url ? linkParts(r.url) : null;
  return (
    <Sheet open={open} onClose={onClose} label="Remote control">
      <div className="rc">
        <div className="rc-head">
          <span className="rc-mark" data-on={on || undefined}>
            <ProviderMark provider={s.provider} size={24} />
          </span>
          <div className="rc-titles">
            <h2 className="rc-title">Remote control</h2>
            <p className="rc-status" data-tone={tone}>
              {on && !r ? <Ring size={11} /> : <i className="rc-dot" />}
              <span>{status}</span>
            </p>
          </div>
          <button type="button" className="rc-switch switch-row" onClick={() => void toggle()} disabled={busy} role="switch" aria-checked={on} aria-label="Remote control">
            <span className="switch" data-on={on || undefined}>
              <i />
            </span>
          </button>
        </div>
        <AnimatePresence initial={false}>
          {on && link && (
            <motion.div key="link" className="rc-body" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={SNAP}>
              <button
                type="button"
                className="rc-link"
                aria-label={copied ? 'Link copied' : 'Copy the link'}
                onClick={() =>
                  void navigator.clipboard?.writeText(r!.url!).then(() => {
                    haptic('success');
                    setCopied(true);
                  })
                }
              >
                <Icon name="link" size={18} className="rc-link-glyph" />
                <span className="rc-url">
                  <span className="rc-host">{link.host}</span>
                  <span className="rc-rest">{link.rest}</span>
                </span>
                <span className="rc-copy" data-done={copied || undefined}>
                  {copied ? <Icon name="check" size={16} weight="bold" /> : <Icon name="copy" size={18} />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </span>
              </button>
              {r?.code && <div className="rc-code num">{r.code}</div>}
              <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => (haptic('tap'), openExternal(r!.url!))}>
                <Icon name="external" size={18} /> {s.provider === 'claude' ? 'Open in Claude' : 'Open link'}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Sheet>
  );
}
