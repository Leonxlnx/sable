import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PhoneSearchHit } from '@shared/protocol';
import { timeAgo } from '@desk/lib/format';
import { conn } from '@m/lib/conn';
import { matchRanges } from '@m/lib/find';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { openFrom } from '@m/lib/open';
import { nothingFound, searchMessages, skippedLine, type Found } from '@m/lib/search';
import { useStore, type State } from '@m/lib/store';
import { useNow } from '@m/lib/useNow';
import { ProviderMark, Ring } from '@m/ui/marks';
import { folderName, Rows } from './Home';

const words = (q: string) => [...new Set(q.trim().toLowerCase().split(/\s+/).filter(Boolean))];

/** Chats whose title or folder has every word, the most recent first (ids joined, so the list renders only when it changes). */
function titleKey(s: State, q: string): string {
  const w = words(q);
  if (!w.length) return '';
  return Object.values(s.sessions)
    .filter((m) => !m.archived)
    .filter((m) => {
      const hay = `${m.title} ${folderName(m, s.projects)}`.toLowerCase();
      return w.every((x) => hay.includes(x));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 24)
    .map((m) => m.id)
    .join(',');
}

/**
 * Search on home: chats by their title and folder at once (the phone has the list), then the
 * messages in them, asked of the desktop (`phone.search`: what you wrote and what the agents said),
 * on until it says the search is whole (lib/search.ts). A message opens its chat at that message.
 */
export function SearchResults({ query, onMenu }: { query: string; onMenu: (id: string, rect: DOMRect) => void }) {
  const key = useStore((s) => titleKey(s, query));
  const ids = useMemo(() => (key ? key.split(',') : []), [key]);
  const online = useStore((s) => s.conn === 'open');
  const [found, setFound] = useState<Found>();
  const q = query.trim();
  // The search being asked: an older one stops once a newer one starts, the query changes or the connection goes.
  const gen = useRef(0);
  const ask = useCallback((query: string, from?: Found) => {
    const my = ++gen.current;
    void searchMessages((p) => conn.call('phone.search', p, 15_000), query, () => gen.current === my, setFound, from);
  }, []);

  useEffect(() => {
    gen.current++;
    if (q.length < 2 || !online) return setFound(undefined);
    setFound((f) => ({ q, hits: f?.q === q ? f.hits : (f?.hits ?? []), busy: true }));
    // Asked once typing pauses; a partial answer (chats not read yet) is asked on until the desktop says it is whole.
    const t = window.setTimeout(() => ask(q), 280);
    return () => {
      gen.current++;
      clearTimeout(t);
    };
  }, [q, online, ask]);

  // The desktop has more to read and the phone stopped asking by itself: a tap goes on from there.
  const further = () => {
    if (!found?.more || found.busy) return;
    haptic('tap');
    setFound({ ...found, busy: true, more: undefined });
    ask(found.q, found);
  };

  const w = useMemo(() => words(q), [q]);
  const hits = found?.hits ?? [];
  const busy = !!found?.busy;
  return (
    <div className="results">
      {ids.length > 0 && (
        <section className="group">
          <h2 className="group-name">Chats</h2>
          <Rows ids={ids} onMenu={onMenu} swipe={false} />
        </section>
      )}
      {q.length >= 2 && online && !found?.off && (
        <section className="group">
          <h2 className="group-name">
            <span>Messages</span>
            {busy && <Ring size={11} />}
          </h2>
          {hits.length > 0 ? (
            <ul className="rows hits">
              {hits.map((h) => (
                <Hit key={`${h.sessionId}:${h.itemId}`} h={h} words={w} />
              ))}
            </ul>
          ) : busy ? (
            <div className="rows hits-wait" aria-hidden>
              {[64, 48, 56].map((n, i) => (
                <span key={i} className="hits-skel">
                  <span className="skel" style={{ width: '38%' }} />
                  <span className="skel" style={{ width: `${n + 30}%` }} />
                </span>
              ))}
            </div>
          ) : found && nothingFound(found) ? (
            <p className="results-none">{ids.length ? 'No messages match.' : 'Nothing matches.'}</p>
          ) : null}
          {found?.more && !busy && (
            <button type="button" className="more-row" onClick={further}>
              Search further
            </button>
          )}
          {!busy && !!found?.skipped && <p className="results-none">{skippedLine(found.skipped)}</p>}
        </section>
      )}
      {q.length > 0 && q.length < 2 && !ids.length && <p className="results-none">Nothing matches.</p>}
    </div>
  );
}

/** The words of the query in a snippet, a step brighter (found in the snippet's own offsets: lib/find.ts). */
function marked(text: string, w: string[]): ReactNode {
  if (!w.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of matchRanges(text, w)) {
    if (b <= at) continue;
    const s = Math.max(a, at);
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={s}>{text.slice(s, b)}</mark>);
    at = b;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** One message that matched: its chat and when, then the words around the match. A tap opens the chat there. */
const Hit = memo(function Hit({ h, words: w }: { h: PhoneSearchHit; words: string[] }) {
  const s = useStore((st) => st.sessions[h.sessionId]);
  const now = useNow();
  if (!s) return null;
  return (
    <li>
      <button
        type="button"
        className="hit"
        onClick={(e) => {
          haptic('tap');
          openFrom(h.sessionId, e.currentTarget, 17);
          nav.chat(h.sessionId, h.itemId, w.join(' '));
        }}
      >
        <span className="hit-head">
          <ProviderMark provider={s.provider} size={14} />
          <span className="hit-chat">{s.title}</span>
          <span className="hit-time num">{timeAgo(h.ts, now)}</span>
        </span>
        <span className="hit-text">
          {h.role === 'user' && <span className="hit-you">You: </span>}
          {marked(h.text, w)}
        </span>
      </button>
    </li>
  );
});
