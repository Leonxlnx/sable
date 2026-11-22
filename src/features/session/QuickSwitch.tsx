import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import type { SessionMeta } from '@shared/protocol';
import { ProviderMark, StatusGlyph } from '@/art/Logo';
import { baseName, timeAgo } from '@/lib/format';
import { openSession, prefetchSession } from '@/state/actions';
import { useStore } from '@/state/store';
import { byKeys, useSlidePill } from '@/ui';
import { cycle, firstIndex, recentOrder, visit } from './quick';
import './quick.css';

/** Sessions opened in this run of the app, most recent first. */
let visits: string[] = [];
let watching = false;
function watchVisits() {
  if (watching) return;
  watching = true;
  const first = useStore.getState().ui.activeSessionId;
  if (first) visits = [first];
  useStore.subscribe((s, p) => {
    const id = s.ui.activeSessionId;
    if (id && id !== p.ui.activeSessionId) visits = visit(visits, id);
  });
}

/** A tap switches without showing anything; the list appears when the key is held this long. */
const SHOW_AFTER = 140;

/**
 * Ctrl+Tab goes back to the session you were in before; pressing Tab again while Ctrl is held
 * walks further back (Shift reverses), and the session opens when Ctrl is released. Holding shows
 * the list. Escape leaves things as they were.
 */
export function QuickSwitch() {
  const [list, setList] = useState<SessionMeta[] | null>(null);
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(false);
  const live = useRef<{ list: SessionMeta[]; index: number } | null>(null);
  // The selection pill travels with Tab (and lands under the pointer at once), as in the palette.
  const pill = useSlidePill(list && shown ? index : null, 12, byKeys);

  useEffect(() => {
    watchVisits();
    let timer = 0;
    const end = (commit: boolean) => {
      const cur = live.current;
      live.current = null;
      window.clearTimeout(timer);
      setList(null);
      setShown(false);
      const target = cur?.list[cur.index];
      if (commit && target && target.id !== useStore.getState().ui.activeSessionId) openSession(target.id);
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.shiftKey ? -1 : 1;
        const cur = live.current;
        if (cur) {
          cur.index = cycle(cur.index, cur.list.length, dir);
          setIndex(cur.index);
          // The chat picked so far is fetched ahead: releasing Ctrl finds it here.
          prefetchSession(cur.list[cur.index].id);
          return;
        }
        // Not from under a dialog (Settings, a confirmation): the session behind it stays.
        if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
        const st = useStore.getState();
        const next = recentOrder(Object.values(st.sessions) as SessionMeta[], visits);
        const at = firstIndex(next.map((s) => s.id), st.ui.activeSessionId, dir);
        if (at < 0) return;
        live.current = { list: next, index: at };
        prefetchSession(next[at].id);
        setList(next);
        setIndex(at);
        timer = window.setTimeout(() => setShown(true), SHOW_AFTER);
      } else if (live.current && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        end(false);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (live.current && e.key === 'Control') end(true);
    };
    const onBlur = () => live.current && end(false);
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return createPortal(
    <AnimatePresence>
      {list && shown && (
        <motion.div
          className="qs glass"
          role="listbox"
          aria-label="Recent sessions"
          initial={{ opacity: 0, y: 6, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.08 } }}
          transition={{ type: 'spring', stiffness: 520, damping: 38 }}
        >
          {list.map((s, i) => (
            <div
              key={s.id}
              className="qs-row"
              role="option"
              aria-selected={i === index}
              data-on={i === index || undefined}
              onPointerDown={(e) => {
                e.preventDefault();
                if (live.current) live.current.index = i;
                setIndex(i);
              }}
            >
              {i === index && <span ref={pill} className="qs-pill dither-sel" aria-hidden />}
              <ProviderMark provider={s.provider} size={14} className="qs-mark" />
              <span className="qs-title truncate">{s.title || 'New session'}</span>
              {/* Only a session that is working or waiting on you carries a mark. */}
              {(s.status === 'running' || s.status === 'starting' || (s.background ?? 0) > 0) && <StatusGlyph tone="working" />}
              {s.status === 'awaiting' && <StatusGlyph tone="awaiting" />}
              <span className="qs-where truncate">{baseName(s.cwd)}</span>
              <span className="qs-when num">{timeAgo(s.updatedAt)}</span>
            </div>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
