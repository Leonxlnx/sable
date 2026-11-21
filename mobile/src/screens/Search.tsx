import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PhoneSearchHit } from '@shared/protocol';
import { timeAgo } from '@desk/lib/format';
import { conn } from '@m/lib/conn';
import { matchRanges } from '@m/lib/find';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { openFrom } from '@m/lib/open';
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

interface Found {
  q: string;
  hits: PhoneSearchHit[];
  busy: boolean;
  /** The desktop cannot search messages (an older build), or it failed. */
  off?: boolean;
}

/**
 * Search on home: chats by their title and folder at once (the phone has the list), then the
 * messages in them, asked of the desktop (`phone.search`: what you wrote and what the agents said).
 * A message opens its chat at that message.
 */
export function SearchResults({ query, onMenu }: { query: string; onMenu: (id: string, rect: DOMRect) => void }) {
  const key = useStore((s) => titleKey(s, query));
  const ids = useMemo(() => (key ? key.split(',') : []), [key]);
  const online = useStore((s) => s.conn === 'open');
  const [found, setFound] = useState<Found>();
  const q = query.trim();

  useEffect(() => {
    if (q.length < 2 || !online) return setFound(undefined);
    let live = true;
    setFound((f) => ({ q, hits: f?.q === q ? f.hits : (f?.hits ?? []), busy: true }));
    // Asked once typing pauses; a partial answer (chats not read yet) is asked again a few times.
    const t = window.setTimeout(async () => {
      try {
        for (let round = 0; round < 4 && live; round++) {
          const r = await conn.call('phone.search', { query: q }, 15_000);
          if (!live) return;
          setFound({ q, hits: r.hits, busy: !!r.partial && round < 3 });
          if (!r.partial) break;
        }
      } catch {
        if (live) setFound({ q, hits: [], busy: false, off: true });
      }
    }, 280);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, online]);

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
          ) : !busy ? (
            <p className="results-none">{ids.length ? 'No messages match.' : 'Nothing matches.'}</p>
          ) : (
            <div className="rows hits-wait" aria-hidden>
              {[64, 48, 56].map((n, i) => (
                <span key={i} className="hits-skel">
                  <span className="skel" style={{ width: '38%' }} />
                  <span className="skel" style={{ width: `${n + 30}%` }} />
                </span>
              ))}
            </div>
          )}
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
