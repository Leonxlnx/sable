import { AnimatePresence, motion } from 'motion/react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { PhoneChangedFile, PhoneChanges } from '@shared/protocol';
import { clampToHunk, linesOf, locate, newCommentId, rangeLabel, type ReviewComment } from '@desk/features/review/model';
import { plural } from '@desk/lib/format';
import { fit } from '@m/lib/fit';
import { pushBack } from '@m/lib/back';
import { reloadChanges, reloadDiff, useChanges, useDiff, type ChangesScope } from '@m/lib/changes';
import { dropComment, putComment, rewordComment, useComments } from '@m/lib/comments';
import { diffRows, hunkIndex, rowNumber, type DiffRow, type LineRow } from '@m/lib/diff-rows';
import { onKeyboard } from '@m/lib/keyboard';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { changesHeading } from '@m/lib/review';
import { useStore } from '@m/lib/store';
import { AutoHeight } from '@m/ui/AutoHeight';
import { Icon, type IconName } from '@m/ui/icons';
import { Ring } from '@m/ui/marks';
import { SNAP } from '@m/ui/motion';
import { commentCount, ReviewSheet, sendNow } from './Review';

/**
 * What a chat changed, on the phone: the files (its folder's working tree, its own edits outside a
 * repository, or one turn's edits) with their counts, each opening to its diff. In a diff a tap
 * picks a line and a second tap the lines up to it; the pane at the foot takes the comment, the
 * comment waits under its lines, and the chat's comments go as one review (Review.tsx).
 */

const splitPath = (p: string): [string, string] => {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
};
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const n0 = (n: number) => n.toLocaleString('en-US');

const STATUS_LABEL: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Conflict', '?': 'Untracked' };
const EMPTY_TEXT: Record<PhoneChanges['scope'], string> = {
  tree: 'The working tree is clean.',
  edits: 'Nothing has been edited in this chat yet.',
  turn: 'This turn changed no files.',
};

function connWord(state: string, listed: boolean) {
  return state === 'denied' ? 'Not paired' : listed ? 'Reconnecting' : 'Connecting';
}

function Back() {
  return (
    <button type="button" className="icon-btn back-btn" aria-label="Back" onClick={() => (haptic('tap'), nav.pop())}>
      <Icon name="back" size={22} />
    </button>
  );
}

function Stat({ add, del }: { add: number; del: number }) {
  if (!add && !del) return null;
  return (
    <span className="diffstat num">
      {add > 0 && <span className="add">+{n0(add)}</span>}
      {del > 0 && <span className="del">−{n0(del)}</span>}
    </span>
  );
}

// ───────────────────────────── the list ─────────────────────────────

export function ChangesScreen({ id, items, lead }: { id: string; items?: string[]; lead?: string }) {
  const scope = useMemo<ChangesScope>(() => ({ sid: id, items }), [id, items]);
  const entry = useChanges(scope);
  const connState = useStore((s) => s.conn);
  const listed = useStore((s) => !!s.fresh);
  const desktop = useStore((s) => s.desktop);
  const item = useStore(s => lead ? s.data[id]?.items[lead] : undefined);
  const leadText = useMemo(() => changesHeading(item), [item]);
  const comments = useComments(id);
  const d = entry.data;
  // Comments on each file's diff as it opens from here (a turn's diff and the working tree's are different diffs).
  const notes = useMemo(() => {
    const m = new Map<string, number>();
    if (!d) return m;
    for (const c of comments) if (c.scope === reviewScopeOf(items, d.scope, c.path)) m.set(c.path, (m.get(c.path) ?? 0) + 1);
    return m;
  }, [comments, d, items]);
  const online = connState === 'open';
  const open = useCallback(
    (f: PhoneChangedFile) => {
      haptic('tap');
      nav.push({ name: 'diff', id, path: f.path, ...(items ? { items } : {}) });
    },
    [id, items],
  );

  let body: ReactNode;
  if (d) {
    body = d.files.length ? (
      <>
        <div className="group-card chg-card">
          {d.files.map((f) => (
            <FileRow key={f.path} f={f} notes={notes.get(f.path) ?? 0} onOpen={open} />
          ))}
        </div>
        {!!d.more && <p className="chg-more num">{plural(d.more, 'more file')}</p>}
      </>
    ) : (
      <p className="empty chg-empty">{EMPTY_TEXT[d.scope]}</p>
    );
  } else if (entry.error) body = <Failed text={entry.error} onRetry={() => reloadChanges(scope)} />;
  else if (!online) body = <p className="empty chg-empty">Changes show when {desktop ?? 'the computer'} is back.</p>;
  else body = <ListSkeleton />;

  return (
    <div className="screen changes">
      <header className="sub-head">
        <Back />
        <span className="sub-head-title">Changes</span>
        <span className="icon-btn-spacer" />
      </header>
      <div className="changes-scroll">
        {(d || items || (online && !entry.error)) && <Meta items={!!items} data={d} leadText={leadText} status={!online && d ? connWord(connState, listed) : undefined} />}
        {body}
      </div>
      <ListFoot sid={id} />
    </div>
  );
}

/** Under the title: where the changes are (the branch, this chat's edits, the turn's message) and what they add up to. */
function Meta({ items, data, leadText, status }: { items: boolean; data?: PhoneChanges; leadText?: string; status?: string }) {
  const kind = items ? 'turn' : data?.scope;
  if (!kind) {
    return (
      <div className="chg-meta" aria-hidden>
        <span className="skel chg-meta-skel" />
      </div>
    );
  }
  const icon: IconName = kind === 'turn' ? 'chat' : kind === 'edits' ? 'edit' : 'branch';
  const label = kind === 'turn' ? (leadText ?? 'This turn') : kind === 'edits' ? 'Edited in this chat' : (data?.branch ?? 'No branch');
  const files = data ? data.files.length + (data.more ?? 0) : 0;
  return (
    <div className="chg-meta">
      <span className="chg-where">
        <Icon name={icon} size={16} />
        <span className="chg-where-text">{label}</span>
        {!!data?.ahead && (
          <span className="chg-ab num" aria-label={`${plural(data.ahead, 'commit')} ahead`}>
            <Icon name="up" size={12} weight="bold" />
            {data.ahead}
          </span>
        )}
        {!!data?.behind && (
          <span className="chg-ab num" aria-label={`${plural(data.behind, 'commit')} behind`}>
            <Icon name="down" size={12} weight="bold" />
            {data.behind}
          </span>
        )}
      </span>
      {status ? (
        <span className="chg-status">
          <Ring size={11} /> {status}
        </span>
      ) : (
        files > 0 &&
        data && (
          <span className="chg-totals num">
            <Stat add={data.additions} del={data.deletions} />
            <span>{plural(files, 'file')}</span>
          </span>
        )
      )}
    </div>
  );
}

const FileRow = memo(function FileRow({ f, notes, onOpen }: { f: PhoneChangedFile; notes: number; onOpen: (f: PhoneChangedFile) => void }) {
  const [dir, base] = splitPath(f.path);
  const label = STATUS_LABEL[f.status] ?? 'Changed';
  return (
    <button type="button" className="chg-row" onClick={() => onOpen(f)} aria-label={`${f.path}, ${label}${f.additions ? `, ${f.additions} added` : ''}${f.deletions ? `, ${f.deletions} removed` : ''}${notes ? `, ${commentCount(notes)}` : ''}`}>
      <span className="chg-letter" data-status={f.status} aria-hidden>
        {f.status}
      </span>
      <span className="chg-path" aria-hidden>
        <span className="chg-name">{base}</span>
        {dir && <span className="chg-dir">{dir}</span>}
      </span>
      <span className="chg-side" aria-hidden>
        {!!f.edits && f.edits > 1 && <span className="chg-edits num">{f.edits} edits</span>}
        {notes > 0 && (
          <span className="chg-notes num">
            <Icon name="comment" size={14} />
            {notes}
          </span>
        )}
        <Stat add={f.additions} del={f.deletions} />
      </span>
      <Icon name="next" size={16} className="chg-chev" />
    </button>
  );
});

function ListSkeleton() {
  return (
    <div className="group-card chg-card" aria-label="Loading">
      {[46, 62, 38].map((w, i) => (
        <div key={i} className="chg-row chg-row-skel" aria-hidden>
          <span className="skel chg-skel-letter" />
          <span className="chg-path">
            <span className="skel" style={{ width: `${w}%` }} />
            <span className="skel chg-skel-dir" style={{ width: `${w - 14}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function Failed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="empty chg-empty chg-failed">
      <p>{text}</p>
      <button type="button" className="btn btn-sm" onClick={() => (haptic('tap'), onRetry())}>
        Try again
      </button>
    </div>
  );
}

/** The list's foot: the review pane, once comments wait. */
function ListFoot({ sid }: { sid: string }) {
  const n = useComments(sid).length;
  const [sheet, setSheet] = useState(false);
  return (
    <>
      <AnimatePresence initial={false}>
        {n > 0 && (
          <motion.div key="foot" className="rfoot" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }} transition={SNAP}>
            <div className="rpane">
              <ReviewBar sid={sid} onOpen={() => setSheet(true)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <ReviewSheet sid={sid} open={sheet} onClose={() => setSheet(false)} back />
    </>
  );
}

/** The comments waiting (a chip that opens the review) and the ivory key that sends them. */
function ReviewBar({ sid, onOpen }: { sid: string; onOpen: () => void }) {
  const n = useComments(sid).length;
  const online = useStore((s) => s.conn === 'open');
  const [busy, setBusy] = useState(false);
  return (
    <div className="composer-bar rp-bar">
      <button type="button" className="setup-chip rp-count" aria-haspopup="dialog" onPointerDown={(e) => e.preventDefault()} onClick={() => (haptic('tap'), onOpen())}>
        <Icon name="comment" size={16} className="setup-chip-mode" />
        <span className="setup-chip-model num">{commentCount(n)}</span>
        <Icon name="updown" size={12} weight="bold" className="setup-chip-caret" />
      </button>
      <span className="bar-gap" />
      <button
        type="button"
        className="send"
        data-busy={busy || undefined}
        aria-label="Send review"
        disabled={!online || busy || !n}
        onPointerDown={(e) => e.preventDefault()}
        onClick={async () => {
          setBusy(true);
          await sendNow(sid, true);
          setBusy(false);
        }}
      >
        {busy ? <span className="send-wait" /> : <Icon name="up" size={18} weight="bold" />}
      </button>
    </div>
  );
}

// ───────────────────────────── one file's diff ─────────────────────────────

const NO_ROWS: DiffRow[] = [];
/** Rows drawn at first (the screen slides in with them); the rest come right after. */
const FIRST_ROWS = 260;
const MORE_ROWS = 480;
/** Rows per block: a block off screen is not laid out or painted (wrapped lines only). */
const CHUNK = 120;
const WRAP_KEY = 'sable.diffwrap';
const HINT_KEY = 'sable.reviewhint';
const readFlag = (k: string, dflt: boolean) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? dflt : v === '1';
  } catch {
    return dflt;
  }
};
const writeFlag = (k: string, v: boolean) => {
  try {
    localStorage.setItem(k, v ? '1' : '0');
  } catch {
    /* private mode */
  }
};

/** Which diff a comment was written on (`ReviewComment.scope`): the working tree's (`git:`), the chat's own edits (`edits:`), or a turn's. */
const reviewScopeOf = (items: string[] | undefined, scope: PhoneChanges['scope'] | undefined, path: string) =>
  items ? `turn:${items[0] ?? ''}:${path}` : `${scope === 'edits' ? 'edits' : 'git'}:${path}`;

/** A comment field left open on a diff (back to the list and in again): its lines and words, this run only. */
const openFields = new Map<string, { lines: ReviewComment['lines']; text: string; edit?: string }>();

type Placed = { c: ReviewComment; a: number; b: number };

export function DiffScreen({ id, path, items }: { id: string; path: string; items?: string[] }) {
  const scope = useMemo<ChangesScope>(() => ({ sid: id, items }), [id, items]);
  // The list the diff was opened from keeps itself fresh; here it is only asked for when it is not there (a restart).
  const list = useChanges(scope, true);
  const file = list.data?.files.find((f) => f.path === path);
  const entry = useDiff(scope, path, file);
  const connState = useStore((s) => s.conn);
  const listed = useStore((s) => !!s.fresh);
  const desktop = useStore((s) => s.desktop);
  const sendWithEnter = useStore((s) => s.settings?.sendWithEnter !== false);
  const online = connState === 'open';
  const res = entry.data;
  const diff = res?.diff ?? null;
  const numbered = res?.numbered ?? true;
  const model = useMemo(() => (diff && !diff.binary ? diffRows(diff) : null), [diff]);
  const rows = model?.rows ?? NO_ROWS;
  const hunks = useMemo(() => hunkIndex(rows, numbered), [rows, numbered]);
  const [dir, base] = splitPath(path);

  // The comments on this diff (a turn's diff and the working tree's are different diffs, as on the desktop).
  const reviewScope = reviewScopeOf(items, list.data?.scope, path);
  const fieldKey = `${id}\u0000${reviewScope}`;
  const all = useComments(id);
  const placed = useMemo(() => {
    const out = new Map<number, Placed[]>();
    for (const c of all) {
      if (c.scope !== reviewScope) continue;
      const at = locate(rows, c.lines);
      if (!at) continue;
      const slot = out.get(at[1]) ?? [];
      slot.push({ c, a: at[0], b: at[1] });
      out.set(at[1], slot);
    }
    for (const slot of out.values()) slot.sort((x, y) => x.c.at - y.c.at);
    return out;
  }, [all, rows, reviewScope]);

  const [wrap, setWrap] = useState(() => readFlag(WRAP_KEY, true));
  const [hinted, setHinted] = useState(() => readFlag(HINT_KEY, false));
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [limit, setLimit] = useState(FIRST_ROWS);
  const born = useRef(Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const live = useRef({ sel, editing, text });
  live.current = { sel, editing, text };

  // The rest of a long diff comes once the screen has slid in, a few hundred rows at a time (no long frame).
  useEffect(() => {
    if (rows.length <= limit) return;
    const t = window.setTimeout(() => setLimit((l) => l + MORE_ROWS), limit === FIRST_ROWS ? 380 : 90);
    return () => clearTimeout(t);
  }, [rows.length, limit]);

  // A field left open here comes back with its lines and words.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !rows.length) return;
    restored.current = true;
    const kept = openFields.get(fieldKey);
    const at = kept ? locate(rows, kept.lines) : null;
    if (!kept || !at) return;
    setSel({ a: at[0], b: at[1] });
    setText(kept.text);
    if (kept.edit && all.some((c) => c.id === kept.edit)) setEditing(kept.edit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  useEffect(
    () => () => {
      const { sel: s, editing: e, text: t } = live.current;
      if (s && (t.trim() || e)) openFields.set(fieldKey, { lines: linesOf(rows, s.a, s.b, numbered), text: t, ...(e ? { edit: e } : {}) });
      else openFields.delete(fieldKey);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fieldKey, rows, numbered],
  );

  const cancel = useCallback(() => {
    setSel(null);
    setEditing(null);
    setText('');
    field.current?.blur();
  }, []);

  // Back lets go of picked lines (or the comment being edited) before it leaves the diff.
  const picking = !!sel || !!editing;
  useEffect(() => (picking ? pushBack(() => (cancel(), true)) : undefined), [picking, cancel]);

  /** Keeps a row in view above the pane; `lift`: where the pane ends up over the keyboard (it may still be sliding). */
  const reveal = useCallback((i: number, lift?: number) => {
    const sc = scroller.current;
    const row = host.current?.querySelector(`[data-i="${i}"]`);
    const f = foot.current;
    if (!sc || !row || !f) return;
    const rb = row.getBoundingClientRect();
    let top = f.getBoundingClientRect().top;
    if (lift !== undefined) top += -lift - (parseFloat(getComputedStyle(f).translate.split(' ')[1] ?? '0') || 0);
    // Clear of the pane and of the short fade above it.
    const limitY = top - 40;
    if (rb.bottom > limitY) sc.scrollBy({ top: rb.bottom - limitY, behavior: 'smooth' });
  }, []);

  // The keyboard: room under the last line, and the picked lines stay in view above the pane.
  useEffect(
    () =>
      onKeyboard((lift, _prev, ms) => {
        const lines = host.current;
        if (lines) lines.style.paddingBottom = lift ? `${lift}px` : '';
        const s = live.current.sel;
        if (lift > 0 && s) window.setTimeout(() => reveal(Math.max(s.a, s.b), lift), Math.min(ms, 120));
      }),
    [reveal],
  );

  const pick = (i: number) => {
    const r = rows[i];
    if (!r || r.t === 'sep') return;
    haptic('select');
    if (editing) {
      setEditing(null);
      setText('');
      setSel({ a: i, b: i });
      return;
    }
    setSel((cur) => {
      if (!cur) return { a: i, b: i };
      if (cur.a === cur.b) {
        if (i === cur.a) return null;
        if (hunks[i] === hunks[cur.a]) return { a: cur.a, b: clampToHunk(hunks, cur.a, i) };
      }
      return { a: i, b: i };
    });
  };

  const edit = (cid: string) => {
    const p = [...placed.values()].flat().find((x) => x.c.id === cid);
    if (!p) return;
    haptic('select');
    setEditing(cid);
    setText(p.c.text);
    setSel({ a: p.a, b: p.b });
  };

  const onTap = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const note = t.closest<HTMLElement>('.dl-note');
    if (note?.dataset.id) return edit(note.dataset.id);
    const row = t.closest<HTMLElement>('.dl-row');
    if (row) pick(Number(row.dataset.i));
  };

  const submit = () => {
    const words = text.trim();
    if (!words) return;
    if (editing) rewordComment(id, editing, words);
    else if (sel) {
      const lines = linesOf(rows, sel.a, sel.b, numbered);
      if (!lines.length) return;
      putComment(id, { id: newCommentId(), scope: reviewScope, path, lines, text: words, at: Date.now() });
      if (!hinted) {
        setHinted(true);
        writeFlag(HINT_KEY, true);
      }
    }
    haptic('success');
    openFields.delete(fieldKey);
    cancel();
  };

  const remove = () => {
    if (!editing) return;
    haptic('warning');
    dropComment(id, editing);
    openFields.delete(fieldKey);
    cancel();
  };

  // Rows the comments cover, and how far the lines are drawn (a comment or a pick below the first rows draws them that far).
  const noted = useMemo(() => {
    const s = new Set<number>();
    for (const slot of placed.values()) for (const p of slot) for (let i = p.a; i <= p.b; i++) s.add(i);
    return s;
  }, [placed]);
  let reach = sel ? Math.max(sel.a, sel.b) : -1;
  for (const k of placed.keys()) reach = Math.max(reach, k);
  const shown = Math.min(rows.length, Math.max(limit, reach + 1));

  // Built once per change of the lines or the comments, so a pick or a word typed never draws the rows again.
  const lineEls = useMemo(() => {
    const out: ReactNode[] = [];
    let chunk: ReactNode[] = [];
    let count = 0;
    const flush = () => {
      if (!chunk.length) return;
      out.push(
        <div className="dl-chunk" key={out.length} style={{ '--n': count } as CSSProperties}>
          {chunk}
        </div>,
      );
      chunk = [];
      count = 0;
    };
    for (let i = 0; i < shown; i++) {
      const r = rows[i];
      if (r.t === 'sep') {
        if (numbered) chunk.push(<div className="dl-sep" key={`s${i}`}>{r.text}</div>);
      } else chunk.push(<Line key={i} r={r} i={i} numbered={numbered} noted={noted.has(i)} />);
      count++;
      for (const p of placed.get(i) ?? []) chunk.push(<Note key={p.c.id} p={p} fresh={p.c.at > born.current} />);
      if (count >= CHUNK) flush();
    }
    flush();
    return out;
  }, [rows, shown, numbered, noted, placed]);

  // The picked lines and the comment being edited are painted on the rows (no render of the rows).
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    for (const r of el.querySelectorAll('[data-sel], [data-editing]')) {
      r.removeAttribute('data-sel');
      r.removeAttribute('data-editing');
    }
    if (sel) for (let i = Math.min(sel.a, sel.b); i <= Math.max(sel.a, sel.b); i++) el.querySelector(`[data-i="${i}"]`)?.setAttribute('data-sel', '');
    if (editing) el.querySelector(`.dl-note[data-id="${CSS.escape(editing)}"]`)?.setAttribute('data-editing', '');
  }, [sel, editing, lineEls]);

  // A field opened under lines low on the screen: the lines stay in view above the pane.
  useEffect(() => {
    if (!sel) return;
    const t = window.setTimeout(() => reveal(Math.max(sel.a, sel.b)), 240);
    return () => clearTimeout(t);
  }, [sel, reveal]);

  const lineCount = model?.lines ?? 0;
  const shownLines = diff ? diff.hunks.reduce((n, h) => n + h.lines.filter((l) => l[0] !== '\\').length, 0) : 0;
  const status = diff?.status ?? (file?.status === 'A' || file?.status === '?' ? 'added' : file?.status === 'D' ? 'deleted' : file?.status === 'R' ? 'renamed' : undefined);
  const word = status === 'added' ? 'New file' : status === 'deleted' ? 'Deleted' : status === 'renamed' ? 'Renamed' : undefined;
  const add = diff?.additions ?? file?.additions ?? 0;
  const del = diff?.deletions ?? file?.deletions ?? 0;
  const rangeText = sel ? rangeLabel(linesOf(rows, sel.a, sel.b, numbered)) : undefined;

  let body: ReactNode;
  if (res) {
    if (diff && model && lineCount > 0) {
      body = (
        <>
          <div
            ref={host}
            className="dl"
            data-wrap={wrap || undefined}
            data-status={diff.status}
            data-numbered={numbered || undefined}
            style={{ '--dig': Math.max(2, model.digits) } as CSSProperties}
            onClick={onTap}
            role="group"
            aria-label={`${base}. Tap a line to comment on it, then another to take the lines between.`}
          >
            <div className="dl-x">
              <div className="dl-lines">{lineEls}</div>
            </div>
          </div>
          {res.cut && <p className="dl-cut num">Showing the first {n0(shownLines)} lines</p>}
        </>
      );
    } else {
      body = (
        <p className="empty dl-empty">
          {diff?.binary
            ? 'Binary file, no preview.'
            : !diff
              ? status === 'deleted'
                ? 'File deleted.'
                : 'No textual changes.'
              : diff.status === 'renamed'
                ? 'Renamed without changes.'
                : diff.status === 'added'
                  ? 'Empty file.'
                  : 'No changes.'}
        </p>
      );
    }
  } else if (entry.error) body = <Failed text={entry.error} onRetry={() => reloadDiff(scope, path)} />;
  else if (!online) body = <p className="empty dl-empty">This diff opens when {desktop ?? 'the computer'} is back.</p>;
  else body = <DiffSkeleton />;

  const commentsHere = all.length;
  const mode: 'form' | 'review' | 'hint' | null = sel || editing ? 'form' : commentsHere ? 'review' : lineCount > 0 && !hinted ? 'hint' : null;

  return (
    <div className="screen diff" data-picking={picking || undefined}>
      <header className="sub-head dhead">
        <Back />
        <div className="dhead-titles">
          <div className="dhead-name">{base}</div>
          <div className="dhead-sub">
            {!online && res ? (
              <span className="chg-status">
                <Ring size={11} /> {connWord(connState, listed)}
              </span>
            ) : (
              <>
                {dir && <span className="dhead-dir">{dir}</span>}
                {word && <span className="dhead-word">{word}</span>}
                <Stat add={add} del={del} />
              </>
            )}
          </div>
        </div>
        {lineCount > 0 ? (
          <button
            type="button"
            className="icon-btn dhead-wrap"
            aria-label="Wrap long lines"
            aria-pressed={wrap}
            onClick={() => {
              haptic('select');
              setWrap((w) => (writeFlag(WRAP_KEY, !w), !w));
            }}
          >
            <Icon name="wrap" size={20} />
          </button>
        ) : (
          <span className="icon-btn-spacer" />
        )}
      </header>
      <div className="diff-scroll" ref={scroller}>
        {body}
      </div>
      <AnimatePresence initial={false}>
        {mode && (
          <motion.div key="foot" ref={foot} className="rfoot" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }} transition={SNAP}>
            <div className="rpane" data-focus={(mode === 'form' && focused) || undefined}>
              <AutoHeight>
                <motion.div key={mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={SNAP}>
                  {mode === 'form' ? (
                    <div className="rp-form">
                      <CommentField
                        inputRef={field}
                        text={text}
                        placeholder={editing ? 'Comment' : rangeText ? `Comment on ${rangeText}` : sel && sel.a !== sel.b ? 'Comment on these lines' : 'Comment on this line'}
                        sendWithEnter={sendWithEnter}
                        onText={setText}
                        onSubmit={submit}
                        onFocus={setFocused}
                      />
                      <div className="composer-bar">
                        <button type="button" className="tool-key" aria-label="Cancel" onPointerDown={(e) => e.preventDefault()} onClick={() => (haptic('tap'), cancel())}>
                          <Icon name="x" size={18} />
                        </button>
                        {editing && (
                          <button type="button" className="tool-key" aria-label="Delete comment" onPointerDown={(e) => e.preventDefault()} onClick={remove}>
                            <Icon name="trash" size={18} />
                          </button>
                        )}
                        <span className="bar-gap" />
                        <button type="button" className="send" aria-label={editing ? 'Save comment' : 'Add comment'} disabled={!text.trim()} onPointerDown={(e) => e.preventDefault()} onClick={submit}>
                          <Icon name="check" size={18} weight="bold" />
                        </button>
                      </div>
                    </div>
                  ) : mode === 'review' ? (
                    <ReviewBar sid={id} onOpen={() => setSheet(true)} />
                  ) : (
                    <div className="rp-hint">
                      <Icon name="comment" size={16} />
                      <span>Tap a line to comment</span>
                    </div>
                  )}
                </motion.div>
              </AutoHeight>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <ReviewSheet sid={id} open={sheet} onClose={() => setSheet(false)} back />
    </div>
  );
}

/** One line: its number (after the change; before it for a removed line), its sign, its code with the changed words marked. */
const Line = memo(function Line({ r, i, numbered, noted }: { r: LineRow; i: number; numbered: boolean; noted: boolean }) {
  return (
    <div className="dl-row" data-t={r.t === ' ' ? undefined : r.t} data-i={i} data-noted={noted || undefined}>
      <span className="dl-n">{numbered ? rowNumber(r) : ''}</span>
      <span className="dl-s">{r.t === ' ' ? '' : r.t === '+' ? '+' : '−'}</span>
      <span className="dl-c">{marked(r)}</span>
    </div>
  );
});

function marked(r: LineRow): ReactNode {
  if (!r.text) return '​';
  if (!r.marks?.length) return r.text;
  const out: ReactNode[] = [];
  let at = 0;
  r.marks.forEach(([a, b], k) => {
    if (a > at) out.push(r.text.slice(at, a));
    out.push(
      <mark key={k} className="dl-mark">
        {r.text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < r.text.length) out.push(r.text.slice(at));
  return out;
}

/** A comment under its lines: its words (and its lines when it covers several); a tap edits it. */
function Note({ p, fresh }: { p: Placed; fresh: boolean }) {
  const range = p.b > p.a ? rangeLabel(p.c.lines) : undefined;
  return (
    <div className="dl-note" data-id={p.c.id} data-fresh={fresh || undefined}>
      <div className="dl-note-in">
        <div className="dl-note-card" role="button" tabIndex={0} aria-label={`Comment${range ? ` on ${range}` : ''}: ${p.c.text}. Edit`}>
          {range && <span className="dl-note-range num">{upper(range)}</span>}
          <span className="dl-note-text">{p.c.text}</span>
        </div>
      </div>
    </div>
  );
}

const MAX_FIELD = 140;

/** The comment's words: grows to about five lines, then scrolls; the keyboard's key adds it (as the desktop's Enter). */
const CommentField = memo(function CommentField({
  inputRef,
  text,
  placeholder,
  sendWithEnter,
  onText,
  onSubmit,
  onFocus,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  placeholder: string;
  sendWithEnter: boolean;
  onText: (t: string) => void;
  onSubmit: () => void;
  onFocus: (f: boolean) => void;
}) {
  useLayoutEffect(() => {
    fit(inputRef.current, MAX_FIELD);
  }, [text]);
  return (
    <textarea
      ref={inputRef}
      className="composer-input rp-input"
      rows={1}
      value={text}
      placeholder={placeholder}
      aria-label="Comment"
      enterKeyHint={sendWithEnter ? 'done' : 'enter'}
      onChange={(e) => onText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && sendWithEnter && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmit();
        }
      }}
      onFocus={() => onFocus(true)}
      onBlur={() => onFocus(false)}
    />
  );
});

function DiffSkeleton() {
  return (
    <div className="dl-skel" aria-label="Loading">
      {[72, 54, 88, 40, 66, 80, 34, 58, 70, 46].map((w, i) => (
        <span key={i} className="skel" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}
