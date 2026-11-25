import { HistoryStatus } from '@/features/session/HistoryStatus';
import { syntheticOf, userItemText } from '@shared/synthetic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { setFindMarks, stepMessage } from '@/features/timeline/nav-bus';
import { revealItem } from '@/features/timeline/reveal';
import { Icon } from '@/icons';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import { findHits, jumpTarget, ordinal, startAt, step, totalOf, type Cursor, type FindSource } from './find';
import './find.css';

const ALL = 'sable-find';
const AT = 'sable-find-at';
/** More marks than this on screen help nobody and cost a paint. */
const MAX_MARKS = 600;

type Registry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): Registry | undefined => (typeof CSS !== 'undefined' ? (CSS as unknown as { highlights?: Registry }).highlights : undefined);
const makeHighlight = (ranges: Range[]) => new (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight(...ranges);

function clearMarks() {
  registry()?.delete(ALL);
  registry()?.delete(AT);
}

const builtRow = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)].find((el) => el.closest('.tl-scroll'));

/** Every occurrence of the query in an element's text, as ranges (matches inside one text node). */
function rangesIn(el: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase();
  const out: Range[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? '').toLowerCase();
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + q.length);
      out.push(r);
    }
  }
  return out;
}

/** Your messages and the agent's text of one session, in order. Read on demand, not subscribed. */
function sourcesOf(sessionId: string): { sources: FindSource[]; users: string[] } {
  const data = useStore.getState().data[sessionId];
  const sources: FindSource[] = [];
  const users: string[] = [];
  for (const id of data?.roots ?? []) {
    const item = data?.items[id];
    if (!item) continue;
    if (item.type === 'user') {
      // Messages Claude Code wrote (notifications, command output) are searched by their plain words
      // and are not stops for Alt+Up/Down, as on the conversation's map; a command the person ran is.
      const s = syntheticOf(item);
      if (item.state !== 'queued' && (!s || s.role === 'command')) users.push(id);
      const words = userItemText(item);
      if (words) sources.push({ id, text: words });
    } else if (item.type === 'text' && item.text) sources.push({ id, text: item.text });
  }
  return { sources, users };
}

/** Null while the source is partial, including when none of the loaded rows match. */
export function conversationHits(sessionId: string, query: string) {
  if (useStore.getState().data[sessionId]?.incomplete) return null;
  return findHits(sourcesOf(sessionId).sources, query);
}

const inOtherSurface = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('.app-rail, [role="dialog"], [role="menu"], [role="listbox"]');

/**
 * Find in conversation (Ctrl+F) and jumping between your messages (Alt+Up, Alt+Down). The search
 * runs over the conversation's data (your messages and the agent's text), so it also finds what is
 * far up a long transcript or folded into a turn's steps: the timeline builds and opens what the
 * current match needs. Tool output and thinking are not searched.
 */
export function ConversationFind({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLElement | null>(null);
  // New items while the bar is open (a turn streaming) join the search.
  const size = useStore((s) => (open ? (s.data[sessionId]?.roots.length ?? 0) : 0));
  const settled = useStore((s) => (open ? s.sessions[sessionId]?.status : undefined));

  const reading = useStore(s => open && !!s.data[sessionId]?.incomplete);
  const q = query.trim();
  const hits = useMemo(() => (open && q ? conversationHits(sessionId, q) ?? [] : []), [open, q, sessionId, size, settled, reading]); // eslint-disable-line react-hooks/exhaustive-deps
  const hitsRef = useRef(hits);
  hitsRef.current = hits;

  // A new query starts from the latest match, or stays on the message it was on.
  const at = useRef<string | undefined>(undefined);
  useEffect(() => {
    setCursor(startAt(hitsRef.current, at.current));
  }, [q, sessionId, reading]);

  const current = cursor && hits[cursor.hit] ? hits[cursor.hit] : undefined;
  at.current = current?.itemId ?? at.current;

  // The matches as ticks on the conversation's map, the current one marked.
  const hitIds = useMemo(() => hits.map((h) => h.itemId), [hits]);
  useEffect(() => setFindMarks(sessionId, open && q ? { ids: hitIds, current: current?.itemId } : null), [sessionId, open, q, hitIds, current?.itemId]);
  useEffect(() => () => setFindMarks(sessionId, null), [sessionId]);

  // Show the current match: the timeline builds, opens and centres its message; then the marks.
  useEffect(() => {
    if (!open || !q || !current || !cursor) {
      clearMarks();
      return;
    }
    const reg = registry();
    let raf = 0;
    let tries = 0;
    let late = 0;
    if (!builtRow(current.itemId)) revealItem(sessionId, current.itemId);
    const paint = () => {
      const row = builtRow(current.itemId);
      const own = row ? rangesIn(row, q) : [];
      if (!row || !own.length) {
        // Not built yet, or folded away: ask once more through the timeline, then keep looking.
        if (tries === 2) revealItem(sessionId, current.itemId);
        if (++tries < 45) raf = requestAnimationFrame(paint);
        // Nothing to mark after all (the text is split by formatting): no stale mark stays behind.
        else reg?.delete(AT);
        return;
      }
      const target = own[Math.min(cursor.nth, own.length - 1)];
      if (reg) {
        const all: Range[] = [];
        for (const h of hitsRef.current) {
          if (all.length > MAX_MARKS) break;
          const el = h.itemId === current.itemId ? row : builtRow(h.itemId);
          if (el) all.push(...(el === row ? own : rangesIn(el, q)));
        }
        reg.set(ALL, makeHighlight(all));
        reg.set(AT, makeHighlight([target]));
      }
      // Bring the occurrence itself into view (a long answer's match may sit far from its start).
      const scroller = row.closest<HTMLElement>('.tl-scroll');
      const bring = (smooth: boolean) => {
        if (!scroller) return;
        const r = target.getBoundingClientRect();
        const s = scroller.getBoundingClientRect();
        if (r.top >= s.top + 72 && r.bottom <= s.bottom - 180) return;
        // The reader moves the view here: the timeline must not pull it back to the end.
        scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }));
        scroller.scrollBy({ top: r.top - s.top - s.height * 0.38, behavior: smooth ? 'smooth' : 'auto' });
      };
      bring(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      late = window.setTimeout(() => bring(false), 760);
    };
    raf = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(late);
    };
  }, [open, q, sessionId, current?.itemId, cursor?.nth, cursor?.hit, hits.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => clearMarks, [sessionId]);

  const close = useCallback(() => {
    setOpen(false);
    clearMarks();
    const el = back.current;
    back.current = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
  }, []);

  const move = useCallback((dir: 1 | -1) => setCursor((c) => step(hitsRef.current, c, dir)), []);

  /**
   * Alt+Up and Alt+Down: the previous or next message of yours, from where the view is. The
   * conversation's map takes them (it knows where every message stands, built or not, and lands
   * each near the top); this is for a view without one.
   */
  const jump = useCallback(
    (dir: 1 | -1) => {
      if (stepMessage(sessionId, dir)) return;
      const { users } = sourcesOf(sessionId);
      const scroller = document.querySelector<HTMLElement>('.stage .tl-scroll');
      if (!users.length || !scroller) return;
      const s = scroller.getBoundingClientRect();
      const line = s.top + s.height * 0.42;
      // The message the view is at: the last one that starts above the reading line. One whose
      // row is not built lies above everything that is.
      let from = -1;
      let fromTop = -Infinity;
      for (let i = users.length - 1; i >= 0; i--) {
        const el = builtRow(users[i]);
        const top = el ? el.getBoundingClientRect().top : -Infinity;
        if (top < line) {
          from = i;
          fromTop = top;
          break;
        }
      }
      // Up from the middle of a long turn goes to the message that started it first.
      const target = dir === -1 && from >= 0 && fromTop < s.top - 8 ? users[from] : jumpTarget(users, from, dir);
      if (target) revealItem(sessionId, target);
      else if (dir === 1) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    },
    [sessionId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.getModifierState?.('AltGraph')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        if (inOtherSurface(e.target)) return;
        e.preventDefault();
        if (!back.current && document.activeElement instanceof HTMLElement && document.activeElement !== input.current) back.current = document.activeElement;
        setOpen(true);
        requestAnimationFrame(() => {
          input.current?.focus();
          input.current?.select();
        });
      } else if (e.altKey && !mod && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (inOtherSurface(e.target)) return;
        e.preventDefault();
        jump(e.key === 'ArrowUp' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jump]);

  const total = totalOf(hits);
  const place = ordinal(hits, cursor);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cfind glass"
          role="search"
          aria-label="Find in conversation"
          // The entrance is a CSS animation (find.css): it runs on the compositor from the first
          // frame the bar is painted in. A spring stepped from here showed one faint frame, then
          // nothing for 76 ms while the bar's first search and focus held the main thread.
          initial={false}
          exit={{ opacity: 0, y: -4, transition: { duration: 0.09 } }}
        >
          <label className="cfind-field">
            <Icon name="search" size={14} />
            <input
              ref={input}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  close();
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  move(e.shiftKey ? -1 : 1);
                }
              }}
              placeholder="Find in conversation"
              aria-label="Find in conversation"
              spellCheck={false}
              autoComplete="off"
            />
            <span className="cfind-count num" aria-live="polite" data-none={(!!q && !total) || undefined}>
              {reading ? <HistoryStatus sessionId={sessionId} /> : q ? (total ? `${place} of ${total}` : 'No matches') : ''}
            </span>
          </label>
          <IconButton icon="arrow-up" label="Previous match" keys="shift+enter" size={14} disabled={!total} onClick={() => move(-1)} />
          <IconButton icon="arrow-down" label="Next match" keys="enter" size={14} disabled={!total} onClick={() => move(1)} />
          <IconButton icon="x" label="Close" keys="esc" size={14} onClick={close} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
