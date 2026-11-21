import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Dialog as RD } from 'radix-ui';
import { DEFAULT_ACCOUNT, type MessageHit, type ProviderId, type SessionMeta } from '@shared/protocol';
import { ProviderMark } from '@/art/Logo';
import { accountName as nameOfAccount, focusComposer } from '@/state/hooks';
import { StatusMark, statusLabel, statusTone } from '@/features/sidebar/SessionRow';
import { refreshScripts, useScriptsVersion } from '@/features/rail/scripts-store';
import { savePrompt, useSavedPrompts } from '@/features/saved/prompts-store';
import { Icon } from '@/icons';
import { timeAgo } from '@/lib/format';
import { fuzzy, wordPrefix } from '@/lib/fuzzy';
import { useNow } from '@/lib/useNow';
import { useStore } from '@/state/store';
import { byKeys, Kbd, PathLabel, cx, useSlidePill } from '@/ui';
import { Highlight } from './Highlight';
import { buildItems, loadRecent, pushRecent, type PaletteGroup, type PaletteItem } from './items';
import { openMessage } from './jump';
import { leadIn, markIndices, MAX_HITS, MIN_QUERY, useMessageSearch, wordsOf } from './messages';
import './palette.css';

interface Row {
  item: PaletteItem;
  group: PaletteGroup;
  indices?: number[];
}

const LIMITS: Record<PaletteGroup, number> = { Recent: 5, Sessions: 8, Projects: 5, Prompts: 6, Actions: 14, Commands: 10, Skills: 10, Messages: MAX_HITS };
const EMPTY_LIMITS: Record<PaletteGroup, number> = { Recent: 5, Sessions: 6, Projects: 4, Prompts: 4, Actions: 40, Commands: 6, Skills: 6, Messages: 0 };

/** The command palette (mod+k): sessions, projects, saved prompts, actions, the open session's commands, and messages across chats. */
export function Palette() {
  const open = useStore((s) => s.ui.paletteOpen);
  const setUi = useStore((s) => s.setUi);
  const ran = useRef(false);
  // A fresh body (empty query, cursor at top) every time the palette opens.
  const [session, setSession] = useState(0);
  useEffect(() => {
    if (open) setSession((n) => n + 1);
  }, [open]);

  return (
    <RD.Root open={open} onOpenChange={(o) => setUi({ paletteOpen: o })}>
      <RD.Portal>
        <RD.Overlay className="palette-overlay" />
        <RD.Content
          className="palette glass-rim"
          data-spot=""
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            ran.current = false;
          }}
          onCloseAutoFocus={(e) => {
            // When an item ran, it decides where focus goes (composer, another dialog).
            if (ran.current) e.preventDefault();
          }}
        >
          <RD.Title className="sr-only">Search and commands</RD.Title>
          <PaletteBody
            key={session}
            onRun={(item) => {
              ran.current = true;
              // A message is found again by searching; it never crowds out what was run.
              if (item.group !== 'Messages') pushRecent(item.id);
              setUi({ paletteOpen: false });
              window.setTimeout(item.run, 16);
            }}
          />
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

function PaletteBody({ onRun }: { onRun: (item: PaletteItem) => void }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recent = useMemo(loadRecent, []);
  /** The composer's text while it is being named (Save prompt); null for the list. */
  const [saving, setSaving] = useState<string | null>(null);

  const sessionsMap = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.ui.activeSessionId);
  const homeProvider = useStore((s) => s.ui.homeProvider);
  const providers = useStore((s) => s.providers);
  const caps = useStore((s) => (activeId ? s.data[activeId]?.caps : undefined));
  const prompts = useSavedPrompts();
  // The visible composer's text (home's when no chat is open): what "Save prompt" names.
  const draft = useStore((s) => s.drafts[activeId ?? 'home']?.text ?? '');
  const canSave = !!draft.trim();
  // The open folder's scripts ("Run dev"): read again as the palette opens, listed once they arrive.
  const activeCwd = activeId ? sessionsMap[activeId]?.cwd : undefined;
  const scriptsV = useScriptsVersion();
  useEffect(() => {
    if (activeCwd) void refreshScripts(activeCwd);
  }, [activeCwd]);

  const items = useMemo(() => {
    const sessions = Object.values(sessionsMap).sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.updatedAt - a.updatedAt);
    const installed = (Object.values(providers).filter((p) => p?.installed).map((p) => p!.id) as ProviderId[]).sort(
      (a, b) => ['claude', 'codex', 'demo'].indexOf(a) - ['claude', 'codex', 'demo'].indexOf(b),
    );
    const projs = [...projects].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastOpened - a.lastOpened);
    const accountName = (s: SessionMeta) => {
      const accounts = providers[s.provider]?.accounts;
      return accounts && accounts.length > 1 ? nameOfAccount(accounts.find((a) => a.id === (s.accountId ?? DEFAULT_ACCOUNT))) : undefined;
    };
    return buildItems({ sessions, projects: projs, activeId, active: activeId ? sessionsMap[activeId] : undefined, installed, homeProvider, caps, accountName, prompts, canSavePrompt: canSave });
    // scriptsV: the folder's scripts arrived or changed (they live outside the store).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsMap, projects, activeId, homeProvider, providers, caps, scriptsV, prompts, canSave]);

  // Scope prefixes: ">" actions only, "@" sessions only.
  const scope = query.startsWith('>') ? 'actions' : query.startsWith('@') ? 'sessions' : null;
  const q = scope ? query.slice(1).trim() : query.trim();

  const rows = useMemo<Row[]>(() => {
    const pool = items.filter((it) => (scope === 'actions' ? it.group === 'Actions' || it.group === 'Commands' || it.group === 'Skills' : scope === 'sessions' ? it.group === 'Sessions' : true));

    if (!q) {
      const out: Row[] = [];
      const used = new Set<string>();
      if (!scope) {
        const byId = new Map(pool.map((it) => [it.id, it]));
        for (const id of recent) {
          const it = byId.get(id);
          if (!it || it.group === 'Sessions' || it.group === 'Projects') continue;
          if (out.length >= EMPTY_LIMITS.Recent) break;
          out.push({ item: it, group: 'Recent' });
          used.add(id);
        }
      }
      const counts: Partial<Record<PaletteGroup, number>> = {};
      for (const it of pool) {
        if (used.has(it.id)) continue;
        if (it.group === 'Sessions' && it.session?.archived && !scope) continue;
        const n = counts[it.group] ?? 0;
        const max = scope ? 60 : EMPTY_LIMITS[it.group];
        if (n >= max) continue;
        counts[it.group] = n + 1;
        out.push({ item: it, group: it.group });
      }
      return order(out, scope ? undefined : ['Recent', 'Sessions', 'Projects', 'Prompts', 'Actions', 'Commands', 'Skills']);
    }

    const scored: (Row & { score: number })[] = [];
    for (const it of pool) {
      const onTitle = fuzzy(q, it.title);
      let score: number;
      let indices: number[] | undefined;
      if (onTitle) {
        score = onTitle.score;
        indices = onTitle.indices;
      } else {
        const wide = wordPrefix(q, [it.title, it.sub, it.keywords].filter(Boolean).join(' '));
        if (wide === null) continue;
        score = wide * 0.6;
      }
      if (recent.includes(it.id)) score += 6 - recent.indexOf(it.id) * 0.4;
      if (it.session?.archived) score -= 8;
      scored.push({ item: it, group: it.group, indices, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const counts: Partial<Record<PaletteGroup, number>> = {};
    const best: Partial<Record<PaletteGroup, number>> = {};
    const kept = scored.filter((r) => {
      const n = counts[r.group] ?? 0;
      if (n >= LIMITS[r.group]) return false;
      counts[r.group] = n + 1;
      best[r.group] ??= r.score;
      return true;
    });
    // Groups ordered by their best match, so Enter always takes the strongest result.
    const groupOrder = (Object.keys(best) as PaletteGroup[]).sort((a, b) => best[b]! - best[a]!);
    return order(kept, groupOrder);
  }, [items, q, scope, recent]);

  // Messages across chats, asked of the bridge as typing pauses. They come last: they arrive later,
  // and the rows above (where Enter lands) never move under the person's hands.
  const found = useMessageSearch(q, !scope && saving === null);
  const searching = found.busy && q.length >= MIN_QUERY;
  const messageRows = useMemo<Row[]>(() => {
    const words = wordsOf(found.q);
    return found.hits
      .filter((h) => sessionsMap[h.sessionId])
      .slice(0, LIMITS.Messages)
      .map((h) => {
        const title = leadIn(h.text, words);
        return {
          group: 'Messages' as const,
          indices: markIndices(title, words),
          item: { id: `msg:${h.sessionId}:${h.itemId}`, group: 'Messages' as const, title, hit: h, run: () => openMessage(h.sessionId, h.itemId, words) },
        };
      });
  }, [found.hits, found.q, sessionsMap]);
  const all = useMemo(() => (q && messageRows.length ? [...rows, ...messageRows] : rows), [rows, messageRows, q]);

  useEffect(() => setCursor(0), [q, scope]);
  const safe = Math.min(cursor, Math.max(0, all.length - 1));
  // One selection pill that travels between rows for arrow keys and lands under the pointer at once.
  const pill = useSlidePill(all[safe] ? `${all[safe].group}:${all[safe].item.id}` : null, 8, byKeys);

  // Keep the cursor row in view, smoothly.
  useLayoutEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-index="${safe}"]`);
    if (!list || !el) return;
    const pad = 8;
    const head = safe === 0 || all[safe - 1]?.group !== all[safe]?.group ? 30 : 0;
    const top = el.offsetTop - pad - head;
    const bottom = el.offsetTop + el.offsetHeight + pad;
    if (top < list.scrollTop) list.scrollTo({ top: safe === 0 ? 0 : top, behavior: 'smooth' });
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTo({ top: bottom - list.clientHeight, behavior: 'smooth' });
  }, [safe, all]);

  const choose = (item: PaletteItem) => {
    if (item.mode === 'save-prompt') {
      setSaving(draft);
      return;
    }
    onRun(item);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = all.length;
    const move = (d: number) => {
      e.preventDefault();
      if (n) setCursor((c) => (Math.min(c, n - 1) + d + n) % n);
    };
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) move(1);
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) move(-1);
    else if (e.key === 'PageDown') move(Math.min(8, n - 1 - safe) || 0);
    else if (e.key === 'PageUp') move(-Math.min(8, safe) || 0);
    else if (e.key === 'Enter') {
      e.preventDefault();
      const row = all[safe];
      if (row) choose(row.item);
    } else if (e.key === 'Backspace' && scope && query.length === 1) {
      e.preventDefault();
      setQuery('');
    }
  };

  if (saving !== null)
    return (
      <SavePrompt
        text={saving}
        onBack={() => setSaving(null)}
        onSave={(name) =>
          onRun({
            id: 'action:save-prompt',
            group: 'Actions',
            title: 'Save prompt',
            run: () => {
              void savePrompt(name, saving).then((p) => p && useStore.getState().toast(`Saved “${p.name}”`, 'success'));
              focusComposer();
            },
          })
        }
      />
    );

  const placeholder = scope === 'actions' ? 'Run an action or command' : scope === 'sessions' ? 'Find a session' : 'Search sessions, messages and actions';

  return (
    <>
      <div className="palette-head">
        <Icon name="search" size={18} className="palette-search" />
        {scope && (
          <span className="palette-scope" aria-hidden>
            {scope === 'actions' ? 'Actions' : 'Sessions'}
          </span>
        )}
        <input
          ref={inputRef}
          className="palette-input"
          autoFocus
          value={scope ? query.slice(1).replace(/^\s/, '') : query}
          onChange={(e) => setQuery(scope ? (scope === 'actions' ? '>' : '@') + e.target.value : e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={all[safe] ? `palette-opt-${safe}` : undefined}
        />
      </div>

      <div ref={listRef} id="palette-list" className="palette-list scroll" role="listbox" aria-label="Results" aria-busy={searching || undefined}>
        {all.length === 0 && !searching ? (
          <div className="palette-empty">{q ? `Nothing matches “${q}”.` : 'Nothing here yet.'}</div>
        ) : (
          all.map((row, i) => (
            <PaletteRowView key={`${row.group}:${row.item.id}`} row={row} index={i} active={i === safe} pill={i === safe ? pill : undefined} showHead={i === 0 || all[i - 1].group !== row.group} onHover={setCursor} onRun={choose} />
          ))
        )}
        {searching ? (
          <div className="palette-searching" role="status">
            {!messageRows.length && <div className="palette-group">Messages</div>}
            <span className="palette-searching-text shimmer">Searching…</span>
          </div>
        ) : (
          !!found.skipped &&
          found.q === q && (
            <div className="palette-searching" role="status">
              <span className="palette-searching-text">{found.skipped === 1 ? 'One chat could not be read in full.' : `${found.skipped} chats could not be read in full.`}</span>
            </div>
          )
        )}
      </div>
    </>
  );
}

function order(rows: Row[], groups?: PaletteGroup[]): Row[] {
  if (!groups) return rows;
  const out: Row[] = [];
  for (const g of groups) for (const r of rows) if (r.group === g) out.push(r);
  return out;
}

function PaletteRowView({
  row,
  index,
  active,
  pill,
  showHead,
  onHover,
  onRun,
}: {
  row: Row;
  index: number;
  active: boolean;
  pill?: RefObject<HTMLSpanElement>;
  showHead: boolean;
  onHover: (i: number) => void;
  onRun: (item: PaletteItem) => void;
}) {
  const { item } = row;
  return (
    <>
      {showHead && (
        <div className="palette-group" role="presentation">
          {row.group}
        </div>
      )}
      <div
        id={`palette-opt-${index}`}
        role="option"
        aria-selected={active}
        data-index={index}
        data-active={active || undefined}
        data-group={row.group}
        className={cx('palette-row', item.session?.archived && 'is-archived')}
        onMouseMove={() => !active && onHover(index)}
        onClick={() => onRun(item)}
      >
        {active && <span ref={pill} className="palette-pill dither-sel" aria-hidden />}
        <span className="palette-lead">
          {item.hit ? (
            <HitMark hit={item.hit} />
          ) : item.session ? (
            <span className="palette-smark">
              {statusTone(item.session) === 'idle' ? <Icon name="chat" size={14} className="palette-idle" /> : <StatusMark session={item.session} />}
            </span>
          ) : (
            <Icon name={item.icon ?? 'command'} size={16} className="palette-icon" />
          )}
        </span>
        <span className="palette-text">
          <span className="palette-title truncate">
            {item.hit?.role === 'user' && <span className="palette-you">You: </span>}
            <Highlight text={item.title} indices={row.indices} />
          </span>
          {item.sub && (item.group === 'Projects' ? <PathLabel path={item.sub} className="palette-sub" /> : <span className="palette-sub truncate">{item.sub}</span>)}
        </span>
        <span className="palette-end">{item.hit ? <HitEnd hit={item.hit} /> : item.session ? <SessionEnd session={item.session} /> : item.keys ? <Kbd combo={item.keys} /> : null}</span>
      </div>
    </>
  );
}

/** Whose chat the message is in: that chat's agent mark. */
function HitMark({ hit }: { hit: MessageHit }) {
  const provider = useStore((s) => s.sessions[hit.sessionId]?.provider);
  return <span className="palette-smark">{provider ? <ProviderMark provider={provider} size={14} /> : <Icon name="chat" size={14} className="palette-idle" />}</span>;
}

/** The chat a message is in, and when it was said. */
function HitEnd({ hit }: { hit: MessageHit }) {
  const title = useStore((s) => s.sessions[hit.sessionId]?.title ?? '');
  const now = useNow();
  return (
    <span className="palette-hit-end">
      <span className="palette-hit-chat truncate">{title}</span>
      <span className="palette-time num">{timeAgo(hit.ts, now)}</span>
    </span>
  );
}

function SessionEnd({ session }: { session: SessionMeta }) {
  const now = useNow();
  const label = statusLabel(session);
  if (session.status === 'running' || session.status === 'starting')
    return (
      <span className="palette-status">
        <span className="truncate shimmer">{label}</span>
      </span>
    );
  if (session.status === 'awaiting') return <span className="palette-status is-amber">Needs approval</span>;
  if (session.status === 'error') return <span className="palette-status is-red">Error</span>;
  return (
    <span className="palette-time num">
      {session.archived && <span className="palette-arch">Archived</span>}
      {timeAgo(session.updatedAt, now)}
    </span>
  );
}

/** A name for the text to start from: its first words, on one line. */
function suggestName(text: string): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').replace(/^[#>*\-\s]+/, '').trim();
  // Its first sentence, when that is short enough to be a name.
  const end = first.search(/[.!?](\s|$)/);
  const line = end > 0 && end <= 48 ? first.slice(0, end) : first;
  let out = '';
  for (const w of line.split(/\s+/).filter(Boolean)) {
    if (out && `${out} ${w}`.length > 48) break;
    out = out ? `${out} ${w}` : w;
    if (out.split(' ').length >= 6) break;
  }
  return out.replace(/[.,:;]+$/, '');
}

/**
 * "Save prompt": the palette names the composer's text. The name starts as the text's first words
 * (selected, so typing replaces it); Enter saves; Backspace in an empty field goes back to the list.
 */
function SavePrompt({ text, onBack, onSave }: { text: string; onBack: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(() => suggestName(text));
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const save = () => onSave(name.trim());
  return (
    <>
      <div className="palette-head">
        <Icon name="text" size={18} className="palette-search" />
        <span className="palette-scope" aria-hidden>
          Save prompt
        </span>
        <input
          ref={input}
          className="palette-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Backspace' && !name) {
              e.preventDefault();
              onBack();
            }
          }}
          placeholder="Name"
          aria-label="Prompt name"
          maxLength={80}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="button" className="btn btn-primary palette-save-btn" onClick={save}>
          Save
        </button>
      </div>
      <div className="palette-save scroll" aria-label="Prompt text">
        {text.trim()}
      </div>
    </>
  );
}
