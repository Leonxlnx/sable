import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { PhoneSearchHit, SessionMeta } from '@shared/protocol';
import { timeAgo } from '@desk/lib/format';
import { conn } from '@m/lib/conn';
import { matchRanges } from '@m/lib/find';
import { nav } from '@m/lib/nav';
import { nothingFound, searchMessages, type Found } from '@m/lib/search';
import { useStore, type State } from '@m/lib/store';
import { useNow } from '@m/lib/useNow';
import { Icon } from '@m/ui/icons';
import { LogoMark, ProviderMark, Ring, StatusMark, Tiles } from '@m/ui/marks';
import { toneOf } from '../screens/Home';
import { mayCall } from './allow';

/**
 * The tablet's list of chats (web/Split.tsx): the desktop sidebar's rows at hand (src/features/sidebar/,
 * sidebar.css). One inset, one icon column and one text column: the agent's mark, the title, the time at
 * rest or the chat's state in its place (the working mark, waiting on you, an error, unread); the chat on
 * screen is a flat pill. Pinned first, then every other chat by its latest activity (a browser is not told
 * the desktop's folders, so there are no projects here). Search: titles at once, then messages
 * (`phone.search`, when this browser may search). Nothing here calls what a browser may not (no new chat,
 * no pin, archive or rename: those are the desktop's).
 */

const words = (q: string) => [...new Set(q.trim().toLowerCase().split(/\s+/).filter(Boolean))];

/** The list as ids: pinned, then the rest, newest first (a string, so the list renders only when its order changes). */
function listKey(s: State, q: string): string {
  const w = words(q);
  const pinned: SessionMeta[] = [];
  const rest: SessionMeta[] = [];
  for (const m of Object.values(s.sessions)) {
    if (m.archived) continue;
    if (w.length && !w.every((x) => m.title.toLowerCase().includes(x))) continue;
    (m.pinned && !w.length ? pinned : rest).push(m);
  }
  const by = (a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1);
  return `${pinned.sort(by).map((m) => m.id).join(',')}|${rest.sort(by).map((m) => m.id).join(',')}`;
}

export function Side({ selected, searchRef }: { selected?: string; searchRef: React.RefObject<HTMLInputElement | null> }) {
  const desktop = useStore((s) => s.desktop);
  const connState = useStore((s) => s.conn);
  const loaded = useStore((s) => s.loaded);
  const fresh = useStore((s) => !!s.fresh);
  const [query, setQuery] = useState('');
  const key = useStore((s) => listKey(s, query));
  const [pinnedKey, restKey] = key.split('|');
  const pinned = useMemo(() => (pinnedKey ? pinnedKey.split(',') : []), [pinnedKey]);
  const rest = useMemo(() => (restKey ? restKey.split(',') : []), [restKey]);
  const list = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;
  const mayFind = mayCall('phone.search');

  // Up and Down move between the rows (and from the search field into the list), as the desktop's list.
  const onKeys = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('.wrow, .whit') ?? [])];
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (e.key === 'ArrowDown' ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    e.preventDefault();
    rows[next].focus();
    rows[next].scrollIntoView({ block: 'nearest' });
  };

  return (
    <aside className="wside" aria-label="Chats" onKeyDown={onKeys}>
      <div className="wside-top">
        <div className="wside-brand">
          <LogoMark size={18} className="wside-mark" />
          <span className="wside-name">{desktop ?? 'Sable'}</span>
        </div>
        <label className="wsearch">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              } else if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
              else if (e.key === 'Enter') list.current?.querySelector<HTMLElement>('.wrow, .whit')?.click();
            }}
            placeholder="Search"
            aria-label={mayFind ? 'Search chats and messages' : 'Search chats'}
            enterKeyHint="search"
            spellCheck={false}
            autoComplete="off"
          />
          {query ? (
            <button type="button" className="wsearch-clear" aria-label="Clear" onClick={() => (setQuery(''), searchRef.current?.focus())}>
              <Icon name="x" size={12} weight="bold" />
            </button>
          ) : (
            <kbd className="wkbd" aria-hidden>
              {/Mac|iPhone|iPad/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K'}
            </kbd>
          )}
        </label>
      </div>

      <div className="wside-list" ref={list}>
        {!loaded ? (
          <div className="wside-skel" aria-hidden>
            {[72, 58, 80, 46, 66, 52].map((w, i) => (
              <span key={i} className="wside-skel-row">
                <span className="skel" style={{ width: `${w}%` }} />
              </span>
            ))}
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <section className="wgroup" aria-label="Pinned">
                <h2 className="wgroup-name">Pinned</h2>
                <Rows ids={pinned} selected={selected} />
              </section>
            )}
            {rest.length > 0 && (
              <section className="wgroup" aria-label={searching ? 'Chats' : 'Chats'}>
                {(pinned.length > 0 || searching) && <h2 className="wgroup-name">Chats</h2>}
                <Rows ids={rest} selected={selected} />
              </section>
            )}
            {!searching && !pinned.length && !rest.length && <p className="wside-empty">No chats on {desktop ?? 'the computer'} yet.</p>}
            {searching && mayFind && <Messages query={query} hadChats={rest.length > 0} />}
            {searching && !mayFind && !rest.length && <p className="wside-empty">Nothing matches.</p>}
          </>
        )}
      </div>

      {/* The foot, as the desktop's: how the connection stands when it is not there, and Settings at its end. */}
      <div className="wside-foot">
        <span className="wside-conn" role="status">
          {connState === 'open' ? null : connState === 'denied' ? (
            'Not paired'
          ) : (
            <>
              <Ring size={11} /> {fresh ? 'Reconnecting' : 'Connecting'}
            </>
          )}
        </span>
        <button type="button" className="wicon" aria-label="Settings" title="Settings" onClick={() => nav.push({ name: 'settings' })}>
          <Icon name="gear" size={17} />
        </button>
      </div>
    </aside>
  );
}

function Rows({ ids, selected }: { ids: string[]; selected?: string }) {
  return (
    <div className="wrows" role="list">
      {ids.map((id) => (
        <Row key={id} id={id} active={id === selected} />
      ))}
    </div>
  );
}

const Row = memo(function Row({ id, active }: { id: string; active: boolean }) {
  const s = useStore((st) => st.sessions[id]);
  const now = useNow();
  if (!s) return null;
  const tone = toneOf(s);
  const state = tone === 'working' ? 'Working' : tone === 'awaiting' ? 'Waiting for you' : tone === 'error' ? 'Stopped with an error' : tone === 'unread' ? 'Unread' : timeAgo(s.updatedAt, now);
  return (
    <button
      type="button"
      role="listitem"
      className="wrow"
      data-chat={id}
      data-active={active || undefined}
      data-tone={tone}
      aria-current={active ? 'page' : undefined}
      aria-label={`${s.title}, ${state}`}
      onClick={() => {
        if (!active) nav.chat(id);
      }}
    >
      <span className="wrow-mark">
        <ProviderMark provider={s.provider} size={12} className="wrow-agent" />
      </span>
      <span className="wrow-title">{s.title}</span>
      <span className="wrow-end">
        {tone === 'working' ? (
          <Tiles size={12} />
        ) : tone === 'idle' ? (
          <span className="wrow-time num">{timeAgo(s.updatedAt, now)}</span>
        ) : (
          <StatusMark tone={tone} size={tone === 'unread' ? 8 : 10} />
        )}
      </span>
    </button>
  );
});

/** Messages that match, asked of the desktop once typing pauses (lib/search.ts); a click opens the chat there. */
function Messages({ query, hadChats }: { query: string; hadChats: boolean }) {
  const online = useStore((s) => s.conn === 'open');
  const [found, setFound] = useState<Found>();
  const q = query.trim();
  const gen = useRef(0);
  const ask = useCallback((text: string, from?: Found) => {
    const my = ++gen.current;
    void searchMessages((p) => conn.call('phone.search', p, 15_000), text, () => gen.current === my, setFound, from);
  }, []);
  useEffect(() => {
    gen.current++;
    if (q.length < 2 || !online) return setFound(undefined);
    setFound((f) => ({ q, hits: f?.q === q ? f.hits : [], busy: true }));
    const t = window.setTimeout(() => ask(q), 280);
    return () => {
      gen.current++;
      clearTimeout(t);
    };
  }, [q, online, ask]);
  const w = useMemo(() => words(q), [q]);
  if (q.length < 2 || !online || found?.off) return !hadChats && q.length > 0 ? <p className="wside-empty">Nothing matches.</p> : null;
  const hits = found?.hits ?? [];
  return (
    <section className="wgroup" aria-label="Messages">
      <h2 className="wgroup-name">
        Messages
        {found?.busy && <Ring size={10} />}
      </h2>
      {hits.length > 0 && (
        <div className="wrows" role="list">
          {hits.map((h) => (
            <Hit key={`${h.sessionId}:${h.itemId}`} h={h} words={w} />
          ))}
        </div>
      )}
      {!found?.busy && found && nothingFound(found) && <p className="wside-empty">{hadChats ? 'No messages match.' : 'Nothing matches.'}</p>}
      {found?.more && !found.busy && (
        <button type="button" className="wmore" onClick={() => ask(found.q, found)}>
          Search further
        </button>
      )}
    </section>
  );
}

function marked(text: string, w: string[]): ReactNode {
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

const Hit = memo(function Hit({ h, words: w }: { h: PhoneSearchHit; words: string[] }) {
  const s = useStore((st) => st.sessions[h.sessionId]);
  if (!s) return null;
  return (
    <button type="button" role="listitem" className="whit" onClick={() => nav.chat(h.sessionId, h.itemId, w.join(' '))}>
      <span className="whit-head">
        <ProviderMark provider={s.provider} size={12} className="wrow-agent" />
        <span className="whit-chat">{s.title}</span>
      </span>
      <span className="whit-text">
        {h.role === 'user' && <span className="whit-you">You: </span>}
        {marked(h.text, w)}
      </span>
    </button>
  );
});
