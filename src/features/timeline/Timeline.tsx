import { syntheticOf } from '@shared/synthetic';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Icon } from '@/icons';
import { EASE_OUT, play, reducedMotion } from '@/lib/motion';
import { interrupt } from '@/state/actions';
import { useStore } from '@/state/store';
import { EMPTY, TimelineCtx, type TimelineCtxValue } from './ctx';
import { navFeed } from './nav-bus';
import { Navigator } from './Navigator';
import { readerScrolls } from '@/features/genui/frames';
import { REVEAL_EVENT, type RevealDetail } from './reveal';
import { TurnList } from './TurnView';
import { DOCK_GLIDE_MS } from '@/features/session/dock-glide';
import { glideFrame } from './follow';
import { useStaged } from '@/features/session/staged';
import './timeline.css';

/** Within this distance of the end, new content keeps the view pinned to it. */
const STICK = 48;
/** Further than this from the end, the "jump to latest" button shows. */
const AWAY = 160;
/** The follower's natural frequency (rad/s): critically damped, so it never overshoots the end. */
const FOLLOW_W = 24;
/** Dev only: `?nonav` leaves the conversation's map out, to measure what it costs (scripts/perf-headless.mjs with SABLE_URL). */
const NO_NAV = import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('nonav');

/**
 * Where the reader left each conversation they had scrolled away from the end of, as the distance
 * from the end (the end is always built, older turns wait behind a spacer of estimated height), so
 * switching back lands where they were reading. For the window's life only.
 */
const keptAt = new Map<string, number>();

/**
 * The conversation. A scroller that stays with the newest content until the reader
 * scrolls away, a centred reading column, and one component per item that subscribes
 * to that item alone, so streaming touches nothing that has settled.
 */
export function Timeline({ sessionId }: { sessionId: string }) {
  const loaded = useStore((s) => s.data[sessionId]?.loaded ?? false);
  const roots = useStore((s) => s.data[sessionId]?.roots) ?? EMPTY;
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd ?? '');
  const home = useStore((s) => s.home);
  const busy = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'running' || st === 'starting';
  });

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const lastTop = useRef(0);
  /** How far the view is from the end, as last measured (by a scroll or a resize): read by input handlers instead of the layout. */
  const room = useRef(0);
  /** When the reader last scrolled (ms): older turns wait to be built ahead until the view is still. */
  const scrolled = useRef(0);
  const live = useRef(false);
  const [away, setAway] = useState(false);
  // The conversation's map is not part of a first message's frames: it mounts after the landing.
  const mapped = useStaged('landed');

  // The turn list hands its layout to the conversation's map through this.
  const feed = useMemo(() => navFeed(), [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx = useMemo<TimelineCtxValue>(() => ({ sessionId, cwd, home, live, stuck, scrolled, nav: feed }), [sessionId, cwd, home, feed]);

  /** The follower's state; `wrote` is the scroll position it set last, to notice a move made by anyone else. */
  const glide = useRef({ raf: 0, pos: 0, v: 0, last: 0, wrote: 0 });

  const pin = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    glide.current.pos = el.scrollTop;
    glide.current.wrote = el.scrollTop;
    glide.current.v = 0;
  }, []);

  /**
   * Travels to the end with a critically damped motion: a sent message is scrolled to smoothly
   * instead of in one step. The target is read every frame, so it tracks whatever arrives
   * meanwhile; it stops the moment the reader lets go.
   */
  const follow = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const g = glide.current;
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
    // History being laid out, reduced motion, or a jump too large to travel: go straight there.
    if (!live.current || reducedMotion() || gap > el.clientHeight * 1.5) {
      pin();
      return;
    }
    if (g.raf || gap < 0.5) return;
    g.pos = el.scrollTop;
    g.wrote = el.scrollTop;
    g.last = performance.now();
    const tick = (now: number) => {
      g.raf = 0;
      if (!stuck.current) {
        g.v = 0;
        return;
      }
      const dt = Math.min(0.034, Math.max(0.001, (now - g.last) / 1000));
      g.last = now;
      // Exact for a long frame, and it goes on from a move anyone else made meanwhile (follow.ts).
      const step = glideFrame(g, el.scrollTop, el.scrollHeight - el.clientHeight, FOLLOW_W, dt);
      el.scrollTop = step.top;
      lastTop.current = g.wrote = el.scrollTop;
      if (!step.done) g.raf = requestAnimationFrame(tick);
    };
    g.raf = requestAnimationFrame(tick);
  }, [pin]);

  /**
   * The content grew or shrank while the view is at the end: the end is kept in the same frame (a
   * ResizeObserver runs after layout and before paint), so the newest line stays on its baseline
   * and the live line where it stands. Gliding after it instead drew every new line, note or
   * closed checkpoint one frame lower first and then slid it back up: the newest words and the
   * live line bobbed up and down by a line (23px) to a checkpoint (65px) all through a turn, and
   * every time a chat with a running turn was opened. Only a travel already under way (a sent
   * message) keeps gliding; it reads the end every frame.
   */
  const keepEnd = useCallback(() => {
    if (glide.current.raf) return;
    pin();
  }, [pin]);

  useEffect(() => () => cancelAnimationFrame(glide.current.raf), []);

  // The working line glides to its new place when content appears above it, instead of jumping.
  const tailAt = useRef<{ top: number; anim: Animation | null } | null>(null);
  const glideTail = useCallback(() => {
    const tail = content.current?.querySelector<HTMLElement>(':scope > .tail');
    if (!tail) {
      tailAt.current = null;
      return;
    }
    const top = tail.offsetTop;
    const prev = tailAt.current;
    tailAt.current = { top, anim: prev?.anim ?? null };
    if (!prev || !live.current || tail.hasAttribute('data-quiet')) return;
    // Where it is drawn right now (it may still be travelling from the last change).
    let drawn = prev.top;
    if (prev.anim && prev.anim.playState === 'running') {
      drawn = prev.top + new DOMMatrixReadOnly(getComputedStyle(tail).transform).m42;
      prev.anim.cancel();
    }
    const d = drawn - top;
    if (Math.abs(d) < 2 || Math.abs(d) > 480) {
      tailAt.current.anim = null;
      return;
    }
    tailAt.current.anim = play(tail, [{ transform: `translateY(${d}px)` }, { transform: 'translateY(0px)' }], { duration: 240, easing: EASE_OUT });
  }, []);

  // Where the reader left this conversation, until the content is tall enough to go back there
  // (the last turns build a moment after the view mounts).
  const restoreTo = useRef<number | null>(null);
  const restore = useCallback(() => {
    const el = scroller.current;
    const dist = restoreTo.current;
    if (!el || dist === null) return false;
    const max = el.scrollHeight - el.clientHeight;
    if (max < dist + STICK) return false;
    restoreTo.current = null;
    el.scrollTop = max - dist;
    lastTop.current = el.scrollTop;
    glide.current.pos = el.scrollTop;
    setAway(dist > AWAY);
    return true;
  }, []);

  // Land at the end of an existing transcript before the first paint, or where the reader left it.
  useLayoutEffect(() => {
    if (!loaded) return;
    const dist = keptAt.get(sessionId);
    // A conversation with nothing in it yet (a chat being started) has no end to go to: asking for
    // one laid the whole new view out inside the task that mounts it.
    if (dist === undefined) return count ? pin() : undefined;
    stuck.current = false;
    restoreTo.current = dist;
    if (restore()) return;
    // The content never grew that tall (it changed meanwhile): the end, as usual.
    const t = window.setTimeout(() => {
      if (restoreTo.current === null) return;
      restoreTo.current = null;
      stuck.current = true;
      pin();
    }, 1500);
    return () => window.clearTimeout(t);
  }, [loaded, pin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the conversation: remember the place when the reader was away from the end.
  useLayoutEffect(() => {
    const el = scroller.current;
    return () => {
      if (!el) return;
      const dist = restoreTo.current ?? el.scrollHeight - el.clientHeight - el.scrollTop;
      if (!stuck.current && dist > STICK) keptAt.set(sessionId, dist);
      else keptAt.delete(sessionId);
    };
  }, [sessionId]);

  // History is laid out without entrance animations; anything arriving after that rises in.
  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => (live.current = true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  // Whenever the content or the viewport changes size: stay pinned, or re-evaluate the jump button.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    let pad = -1;
    let wide = el.clientWidth;
    const ro = new ResizeObserver(() => {
      // The view itself got another width (the window resized, the side panel moving): every line
      // wraps again and the end moves by hundreds of pixels per frame. Gliding after it left the
      // reader looking at some earlier part of the conversation until the resize stopped: the end
      // is kept exactly instead.
      const w = el.clientWidth;
      const rewrapped = w !== wide;
      wide = w;
      // The dock got lower (a permission or question card left): the end padding shrinks with it
      // and the browser clamps the scroll position, so the whole conversation used to drop by the
      // card's height in one frame. It glides down instead: the drop is undone by a transform that
      // runs out on the compositor. The live line, held at the top of the view while the card was
      // there, stays put until its own place reaches it.
      const padNow = parseFloat(getComputedStyle(inner).paddingBottom) || 0;
      const less = pad - padNow;
      const taller = pad >= 0 && less < -0.5;
      const fell = lastTop.current - el.scrollTop;
      if (pad >= 0 && less > 24 && fell > 8 && stuck.current && live.current) {
        const d = Math.min(less, fell);
        const head = inner.querySelector<HTMLElement>('.tl-work[data-live]');
        const headTop = head?.getBoundingClientRect().top ?? 0;
        const held = head ? el.getBoundingClientRect().top + (parseFloat(getComputedStyle(head).top) || 0) : 0;
        const timing = { duration: DOCK_GLIDE_MS, easing: EASE_OUT };
        if (play(inner, [{ translate: `0 ${-d}px` }, { translate: '0 0' }], timing) && head && headTop - d < held - 0.5) {
          const reach = Math.min(1, Math.max(0, 1 - (headTop - held) / d));
          const hold = play(head, [{ translate: `0 ${held - headTop + d}px`, offset: 0 }, { translate: '0 0', offset: reach }, { translate: '0 0', offset: 1 }], timing);
          // Held by a transform, not by the layout: it keeps the ground it has while stuck, so the
          // lines coming down pass under it.
          if (hold) {
            head.setAttribute('data-held', '');
            const free = () => head.removeAttribute('data-held');
            hold.finished.then(free, free);
          }
        }
      }
      pad = padNow;
      room.current = el.scrollHeight - el.clientHeight - el.scrollTop;
      glideTail();
      if (restoreTo.current !== null && restore()) return;
      if (stuck.current) {
        if (rewrapped) pin();
        // The dock got taller (a permission card, a question, the queue tray came): the conversation
        // travels up with it instead of stepping by the card's height.
        else if (taller) follow();
        else keepEnd();
      } else setAway(el.scrollHeight - el.scrollTop - el.clientHeight > AWAY);
    });
    // Border box: the end padding follows the dock's height and must re-pin too.
    ro.observe(inner, { box: 'border-box' });
    ro.observe(el);
    return () => ro.disconnect();
  }, [follow, keepEnd, glideTail, pin, restore]);

  // Only the reader lets go of the end. Layout moving the scroll position (rows above built
  // or settling to their real height, scroll anchoring, the dock resizing) never does.
  const intent = useRef(0);
  const dragging = useRef(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const mark = () => (intent.current = performance.now());
    // Scrolling up with the wheel lets go at once, before the scroll event arrives. Nothing here
    // reads the layout or writes to the page: a wheel arrives every few ms during a flick, and a
    // style change on the conversation's root here (it once switched hover off while scrolling)
    // restyled every row twice per gesture, forced at once by the next read. The browser itself
    // leaves hover alone while a scroll runs.
    const onWheel = (e: WheelEvent) => {
      mark();
      // Widget frames let the wheel through while it scrolls (genui/frames.ts).
      readerScrolls();
      restoreTo.current = null;
      if (e.deltaY < 0 && room.current > 1) stuck.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (/^(Arrow(Up|Down)|Page(Up|Down)|Home|End| )$/.test(e.key)) mark();
    };
    const down = () => {
      dragging.current = true;
      mark();
    };
    const up = () => (dragging.current = false);
    // Opening something (a turn's steps, a step's details) grows the content under the pointer:
    // the reader is reading there, so the view stays where it is instead of following the end.
    const onClick = (e: MouseEvent) => {
      const t = (e.target as HTMLElement | null)?.closest('[aria-expanded="false"]');
      if (t && el.contains(t) && el.scrollHeight - el.clientHeight - el.scrollTop <= STICK) stuck.current = false;
    };
    el.addEventListener('click', onClick, true);
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', mark, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointercancel', up);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', mark);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  /** The map moves the view (a jump, a scrub, the wheel over it): as the reader would, it lets go of the end. */
  const hold = useCallback(() => {
    intent.current = performance.now();
    restoreTo.current = null;
    stuck.current = false;
    cancelAnimationFrame(glide.current.raf);
    glide.current.raf = 0;
    glide.current.v = 0;
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el || restoreTo.current !== null) return;
    const top = el.scrollTop;
    const dist = el.scrollHeight - top - el.clientHeight;
    room.current = dist;
    scrolled.current = performance.now();
    const byReader = dragging.current || performance.now() - intent.current < 600;
    // A scroll the reader made (also one a wheel over a widget handed on to the conversation), not
    // the view following the end: widget frames let the pointer through until it rests.
    if (byReader || !stuck.current) readerScrolls();
    if (top < lastTop.current - 1 && dist > 1) {
      if (byReader) stuck.current = false;
      else if (stuck.current) {
        // Pulled up by layout while following the end: go straight back.
        pin();
        return;
      }
    } else if (dist <= STICK && top >= lastTop.current) stuck.current = true;
    lastTop.current = top;
    setAway(!stuck.current && dist > AWAY);
  }, [pin]);

  // A plain passive listener: a scroll event arrives every frame of a scroll, and React's synthetic
  // dispatch for it cost more than the handler itself.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onScroll]);

  const jump = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = true;
    setAway(false);
    lastTop.current = el.scrollTop;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  // Sending a message always returns to the end.
  const count = roots.length;
  const lastId = roots[count - 1];
  useEffect(() => {
    if (!lastId) return;
    const item = useStore.getState().data[sessionId]?.items[lastId];
    // A notification Claude Code writes into the chat is not a send: a reader scrolled up stays put.
    if (item?.type === 'user' && !syntheticOf(item) && live.current) {
      // The view travels to the message: it rises from behind the composer as the scroll catches up.
      stuck.current = true;
      setAway(false);
      follow();
    }
  }, [lastId, sessionId, follow]);

  // Revealing an older item (TurnList builds and scrolls to it) lets go of the end first,
  // or the growth above would pin the view straight back down.
  useEffect(() => {
    const onReveal = (e: Event) => {
      if ((e as CustomEvent<RevealDetail>).detail?.sessionId !== sessionId) return;
      stuck.current = false;
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, [sessionId]);

  // Esc stops the turn, unless something else (a menu, a dialog, a field with its own Esc) wants the key.
  // Not in a view on its way out: while the veil closes over a change of chat both conversations
  // stand in the page, and one Escape would stop the turn of the chat just left too.
  const present = useIsPresent();
  useEffect(() => {
    if (!busy || !present) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.repeat) return;
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      void interrupt(sessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, present, sessionId]);

  // A chat whose first message waits for spare quota (or a reset) is not empty: the strip above the composer says when it starts.
  const waiting = useStore((s) => !!s.sessions[sessionId]?.spare);
  const empty = loaded && count === 0 && !waiting;

  return (
    <TimelineCtx.Provider value={ctx}>
      <div className="tl">
        <div className="tl-scroll scroll" ref={scroller} tabIndex={-1}>
          <div className="tl-content" ref={content} data-empty={empty || undefined}>
            {empty ? <p className="tl-empty">Send a message to start.</p> : loaded && <TurnList ids={roots} />}
          </div>
        </div>
        {!NO_NAV && mapped && <Navigator key={sessionId} sessionId={sessionId} feed={feed} scroller={scroller} content={content} hold={hold} />}
        <AnimatePresence>
          {away && (
            <motion.button
              type="button"
              className="tl-jump glass"
              onClick={jump}
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 460, damping: 34 }}
            >
              <Icon name="arrow-down" size={13} />
              Jump to latest
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </TimelineCtx.Provider>
  );
}
