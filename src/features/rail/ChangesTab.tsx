import { emptyIndex } from '@/state/revision';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileDiff, GitFileStatus, SeenFile, ToolItem } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { DiffView } from '@/components/DiffView';
import { Icon } from '@/icons';
import { plural, relPath } from '@/lib/format';
import { requestWhileCut } from '../timeline/whole-request';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Segmented, Spinner, Tip } from '@/ui';
import { STATUS_TONE, commitAll, draftCommitMessage, gitKey, isSmall, loadAllDiffs, loadDiff, refreshGit, useRepo, type DiffEntry } from './git-state';
import { LeaveList } from './leave';
import { LaneSection } from './LaneSection';
import { PullRequestAction } from './PullRequest';
import { PullRequestRow } from './PullRequest';
import { useSessionLane } from '@/features/session/lane';
import { useJumpOpen } from '@/features/review/jump';
import { splitPath, useArrivals, useToolIds } from './util';
import { READ_MS, UNDO_MS, loadSince, markSeen, undoSeen, unmarkSeen, useSeenRefresh, useSeenView, useTurnPaths, type SinceEntry } from './changes-seen';

/** How many files the Changes tab lists (working tree, or this session's edits outside a repo). */
export function useChangeCount(sessionId: string, cwd: string): number {
  const repo = useRepo(cwd);
  const plain = !!repo?.status && !repo.status.isRepo;
  const edited = useEditedCount(sessionId, cwd, plain);
  if (repo?.status?.isRepo) return repo.status.files.length;
  return plain ? edited : 0;
}

const isDoneEdit = (it: ToolItem) => (it.kind === 'edit' || it.kind === 'write') && it.status === 'done' && !!it.result?.diff?.length;
/** Each edit's files as the tab names them, per item object (items are immutable) and folder. */
const editPaths = new WeakMap<ToolItem, { cwd: string; paths: string[] }>();

/**
 * How many files this session edited (the tab's figure outside a repository), counted without
 * building the diffs, and not at all in a repository. Building them for the figure on every new
 * edit read every edit again: with thousands of steps (the Demo's fleet) that was a third of a
 * second per second of the burst (perf1).
 */
function useEditedCount(sessionId: string, cwd: string, on: boolean): number {
  const ids = useToolIds(sessionId, isDoneEdit, true);
  return useMemo(() => {
    if (!on) return 0;
    const items = useStore.getState().data[sessionId]?.items ?? emptyIndex;
    const seen = new Set<string>();
    for (const id of ids) {
      const it = items[id] as ToolItem | undefined;
      if (!it) continue;
      let known = editPaths.get(it);
      if (!known || known.cwd !== cwd) editPaths.set(it, (known = { cwd, paths: (it.result?.diff ?? []).map((d) => relPath(d.path, cwd)) }));
      for (const p of known.paths) seen.add(p);
    }
    return seen.size;
  }, [ids, sessionId, cwd, on]);
}

export function ChangesTab({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const repo = useRepo(cwd);
  const status = repo?.status;
  const lane = useSessionLane(sessionId);

  if (!status) {
    return (
      <div className="rail-scroll scroll">
        {repo?.error ? (
          <p className="rail-empty">
            Could not read the working tree. <button type="button" className="rail-link" onClick={() => void refreshGit(cwd)}>Try again</button>
          </p>
        ) : (
          <div className="rail-loading">
            <Spinner />
            Reading the working tree
          </div>
        )}
      </div>
    );
  }
  // A lane whose folder is gone can still be discarded from here.
  if (!status.isRepo && lane) {
    return (
      <div className="rail-col">
        <div className="rail-scroll scroll">
          <p className="rail-empty">The lane folder is gone.</p>
        </div>
        <LaneSection sessionId={sessionId} lane={lane} cwd={cwd} />
      </div>
    );
  }
  if (!status.isRepo) return <SessionEdits sessionId={sessionId} cwd={cwd} />;
  return <RepoChanges sessionId={sessionId} cwd={cwd} foot={lane ? <LaneSection key={lane.path} sessionId={sessionId} lane={lane} cwd={cwd} /> : undefined} />;
}

/** Adds a file to the open set (a review comment asked to be shown). */
const withPath = (path: string) => (o: ReadonlySet<string>) => (o.has(path) ? o : new Set(o).add(path));

// ───────────────────────────── repository ─────────────────────────────

/** What the list shows: what is new since the person last looked, what the last turn edited, or everything. */
type Scope = 'new' | 'turn' | 'all';

/** The scope picked per chat while the window is open (a chat opened again opens on what is new when anything is). */
const picked = new Map<string, Scope>();

const posix = (p: string) => p.replace(/\\/g, '/');

/** `foot`: what takes the commit box's place (a lane's section, which lands instead). */
function RepoChanges({ sessionId, cwd, foot }: { sessionId: string; cwd: string; foot?: ReactNode }) {
  const repo = useRepo(cwd)!;
  const status = repo.status!;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // The review bar's list jumps to a comment on one of these files: its row opens (in the list that holds it).
  const [scope, setScope] = useState<Scope | null>(() => picked.get(sessionId) ?? null);
  useJumpOpen(
    (r) => r.sessionId === sessionId && r.scope.startsWith('git:'),
    (r) => {
      setOpen(withPath(r.scope.slice(4)));
      setScope('all');
    },
  );
  useSeenRefresh(sessionId, cwd);
  const seen = useSeenView(sessionId);
  const turn = useTurnPaths(sessionId, cwd);
  const small = isSmall(status);
  const arrived = useArrivals(status.files.map((f) => f.path));

  // Seen states known for this tree: every row can say whether it was looked at.
  const known = !!seen?.repo;
  const stateOf = (p: string): SeenFile | undefined => (known ? seen!.files[p] : undefined);
  const incomplete = seen?.partial && status.files.some(f => !stateOf(f.path));
  const unseen = known ? status.files.filter(f => stateOf(f.path) && stateOf(f.path)!.state !== 'seen') : [];
  const seenFiles = known ? status.files.filter((f) => stateOf(f.path)?.state === 'seen') : [];
  const inTurn = status.files.filter((f) => turn.has(posix(f.path)));
  // Opens on what is new when anything is; a scope with nothing in it falls back to the whole list.
  let shown: Scope = scope ?? (unseen.length ? 'new' : 'all');
  if (!known || (shown === 'turn' && !inTurn.length)) shown = 'all';
  const pick = (v: Scope) => {
    picked.set(sessionId, v);
    setScope(v);
  };
  // The scope it opened on stays while the tab is open: marking the last new file seen leaves the
  // list on "Nothing new since you last looked", not on another list.
  useEffect(() => {
    if (known && scope === null) setScope(shown);
  }, [known, scope, shown]);
  const [seenOpen, setSeenOpen] = useState(false);
  const rows = shown === 'new' ? unseen : shown === 'turn' ? inTurn : status.files;
  const folded = shown === 'new' ? seenFiles : [];
  const visible = seenOpen ? [...rows, ...folded] : rows;
  const toMark = rows.filter(f => stateOf(f.path) && stateOf(f.path)!.state !== 'seen');
  const allOpen = visible.length > 0 && visible.every((f) => open.has(f.path));

  // Mark all seen offers its undo in its own place for a few seconds.
  const [undo, setUndo] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(t);
  }, [undo]);
  const markAll = async () => {
    const list = toMark.map((f) => stateOf(f.path)).filter((f): f is SeenFile => !!f);
    const id = await markSeen(sessionId, cwd, list);
    if (id) setUndo({ id, n: list.length });
  };

  // Drop open entries for files that left the tree.
  useEffect(() => {
    setOpen((o) => {
      const paths = new Set(status.files.map((f) => f.path));
      const next = new Set([...o].filter((p) => paths.has(p)));
      return next.size === o.size ? o : next;
    });
  }, [status]);

  // Small trees: one call for every diff. Otherwise load what is open and missing or stale.
  useEffect(() => {
    if (small) {
      const need = status.files.some((f) => {
        const d = repo.diffs[f.path];
        return !d || (d.state === 'ok' && d.stale);
      });
      if (need) loadAllDiffs(cwd);
      return;
    }
    if (open.size > 8 && [...open].filter((p) => needs(repo.diffs[p])).length > 8) {
      loadAllDiffs(cwd);
      return;
    }
    for (const p of open) if (needs(repo.diffs[p])) loadDiff(cwd, p);
  }, [small, open, repo.diffs, repo.rev, status, cwd]);

  // Open rows whose file changed since it was seen get the diff of what is new since.
  useEffect(() => {
    if (!seen) return;
    for (const p of open) if (seen.repo && (!seen.files[p] || seen.files[p].since)) loadSince(sessionId, cwd, p);
  }, [open, seen, sessionId, cwd]);

  // When each row was opened: a diff closed after it stood open long enough to be read counts as looked at.
  const openedAt = useRef(new Map<string, number>());
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const openRef = useRef(open);
  openRef.current = open;
  // Stable, so a refresh re-renders only the rows whose file changed (FileRow is memoised).
  const toggle = useCallback(
    (p: string) => {
      const n = new Set(openRef.current);
      if (n.has(p)) {
        n.delete(p);
        const at = openedAt.current.get(p);
        openedAt.current.delete(p);
        const f = seenRef.current?.files[p];
        if (at !== undefined && performance.now() - at >= READ_MS && f && f.state !== 'seen') void markSeen(sessionId, cwd, [f]);
      } else {
        n.add(p);
        if (document.visibilityState === 'visible') openedAt.current.set(p, performance.now());
      }
      openRef.current = n;
      setOpen(n);
    },
    [sessionId, cwd],
  );
  const flip = useCallback(
    (p: string) => {
      const f = seenRef.current?.files[p];
      if (!f) return;
      if (f.state === 'seen') void unmarkSeen(sessionId, cwd, p);
      else void markSeen(sessionId, cwd, [f]);
    },
    [sessionId, cwd],
  );
  const limit = useRowLimit(visible.length);
  const row = (f: GitFileStatus) => (
    <FileRow
      key={f.path}
      sessionId={sessionId}
      cwd={cwd}
      file={f}
      fresh={arrived.has(f.path)}
      open={open.has(f.path)}
      entry={repo.diffs[f.path]}
      seen={stateOf(f.path)}
      since={seen?.since[f.path]}
      onToggle={toggle}
      onSeen={flip}
    />
  );

  return (
    <div className="rail-col">
      <div className="rail-bar">
        <span className="rail-bar-title ch-branch truncate">
          <Icon name="branch" size={14} />
          <span className="truncate">{status.branch ?? 'No branch'}</span>
          {!!status.ahead && (
            <Tip label={`${plural(status.ahead, 'commit')} ahead of upstream`}>
              <span className="ch-ab num">
                <Icon name="arrow-up" size={10} />
                {status.ahead}
              </span>
            </Tip>
          )}
          {!!status.behind && (
            <Tip label={`${plural(status.behind, 'commit')} behind upstream`}>
              <span className="ch-ab num">
                <Icon name="arrow-down" size={10} />
                {status.behind}
              </span>
            </Tip>
          )}
        </span>
        <span className="rail-bar-meta ch-totals num">
          {status.files.length > 0 && (
            <>
              {status.additions > 0 && <span className="dv-add">+{status.additions.toLocaleString('en-US')}</span>}
              {status.deletions > 0 && <span className="dv-del">−{status.deletions.toLocaleString('en-US')}</span>}
              <span>in {plural(status.files.length, 'file')}</span>
            </>
          )}
        </span>
        <span className="rail-bar-actions">
          {visible.length > 0 && (
            <IconButton
              icon={allOpen ? 'collapse' : 'expand'}
              label={allOpen ? 'Collapse all' : 'Expand all'}
              size={14}
              onClick={() => setOpen(allOpen ? new Set() : new Set(visible.map((f) => f.path)))}
            />
          )}
          <IconButton icon="refresh" label="Refresh" size={14} className={repo.loading ? 'is-spinning' : undefined} onClick={() => void refreshGit(cwd)} />
        </span>
      </div>
      {known && status.files.length > 0 && (
        <div className="ch-scope">
          <Segmented
            id={`ch-scope-${sessionId}`}
            className="ch-seg"
            value={shown}
            onChange={pick}
            options={[
              { value: 'new' as const, label: <ScopeLabel name="New" n={incomplete ? 'many' : unseen.length} /> },
              ...(inTurn.length ? [{ value: 'turn' as const, label: <ScopeLabel name="This turn" n={inTurn.length} /> }] : []),
              { value: 'all' as const, label: <ScopeLabel name="All" n={status.files.length} /> },
            ]}
          />
          {undo ? (
            <button type="button" className="btn btn-sm btn-ghost ch-mark-all" onClick={() => {
              void undoSeen(sessionId, cwd, undo.id);
              setUndo(null);
            }}>
              <Icon name="rewind" size={13} />
              Undo
            </button>
          ) : toMark.length > 0 ? (
            <Tip label={toMark.length === 1 ? 'Mark this file seen' : `Mark these ${toMark.length} files seen`}>
              <button type="button" className="btn btn-sm btn-ghost ch-mark-all" onClick={() => void markAll()}>
                <Icon name="checks" size={14} />
                Mark all seen
              </button>
            </Tip>
          ) : null}
        </div>
      )}
      <div className="rail-scroll scroll">
        {/* The branch's pull request and its checks, once it has one (read only while this tab shows). */}
        <PullRequestRow sessionId={sessionId} cwd={cwd} />
        {status.files.length === 0 ? (
          <>
            <p className="rail-empty">The working tree is clean.</p>
            <PullRequestAction cwd={cwd} />
          </>
        ) : !seen ? null : (
          <>
            {rows.length === 0 && shown === 'new' && <p className="rail-empty ch-none">{incomplete ? 'Open a file in All to check its changes.' : 'Nothing new since you last looked.'}</p>}
            {rows.length > 0 && (
              <LeaveList className="ch-list" order={`${shown}|${rows.map((f) => f.path).join('|')}`}>
                {(limit < rows.length ? rows.slice(0, limit) : rows).map(row)}
              </LeaveList>
            )}
            {folded.length > 0 && (
              <div className="ch-fold" data-open={seenOpen || undefined}>
                <button type="button" className="ch-fold-head" aria-expanded={seenOpen} onClick={() => setSeenOpen((v) => !v)}>
                  <Icon name="caret-right" size={10} className="ch-caret" />
                  <span>Seen</span>
                  <span className="ch-fold-n num">{folded.length}</span>
                </button>
                <Collapse open={seenOpen}>
                  <LeaveList className="ch-list ch-list-seen" order={folded.map((f) => f.path).join('|')}>
                    {folded.map(row)}
                  </LeaveList>
                </Collapse>
              </div>
            )}
          </>
        )}
      </div>
      {foot ?? (status.files.length > 0 && <CommitBox sessionId={sessionId} cwd={cwd} />)}
    </div>
  );
}

/** A scope's name and how many files it holds, the figure a step quieter. */
function ScopeLabel({ name, n }: { name: string; n: number | 'many' }) {
  return (
    <>
      {name}
      <span className="ch-seg-n num">{n}</span>
    </>
  );
}

/** Unsent commit messages by folder, so switching tabs or sessions keeps them. */
const commitDrafts = new Map<string, string>();
const MAX_COMMIT_LINES = 3;

function CommitBox({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const key = gitKey(cwd);
  const [message, setMessage] = useState(() => commitDrafts.get(key) ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);
  const area = useRef<HTMLTextAreaElement>(null);
  const ready = message.trim().length > 0 && !busy;

  // One line, growing to three, then scrolling.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const max = (parseFloat(cs.lineHeight) || 19) * MAX_COMMIT_LINES + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [message]);

  const update = (text: string) => {
    setMessage(text);
    if (text) commitDrafts.set(key, text);
    else commitDrafts.delete(key);
    if (error) setError(null);
  };

  const [drafting, setDrafting] = useState(false);
  const typed = useRef(message);
  typed.current = message;
  const draft = async () => {
    if (drafting || busy) return;
    setDrafting(true);
    setError(null);
    const before = typed.current;
    const res = await draftCommitMessage(sessionId, cwd);
    setDrafting(false);
    // What the person typed while the draft was written stays.
    if (typed.current !== before) return;
    if (res.ok && res.message) {
      update(res.message);
      area.current?.focus();
    } else {
      setError(res.error ?? 'The message could not be written.');
    }
  };

  const commit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const res = await commitAll(cwd, message);
    setBusy(false);
    if (res.ok) {
      update('');
      // Git joins a subject that runs over several lines; show the first line as typed.
      const subject = message.trim().split('\n')[0].trim() || res.summary || '';
      toast(res.hash ? `Committed ${res.hash}: ${subject}` : 'Committed', 'success');
    } else {
      setError(res.error ?? 'The commit failed.');
      area.current?.focus();
    }
  };

  return (
    <form
      className="ch-commit"
      onSubmit={(e) => {
        e.preventDefault();
        void commit();
      }}
    >
      <div className="ch-commit-row">
        <textarea
          ref={area}
          className="field ch-commit-field scroll"
          rows={1}
          value={message}
          placeholder="Commit message"
          aria-label="Commit message"
          aria-invalid={!!error || undefined}
          aria-describedby={error ? 'ch-commit-error' : undefined}
          spellCheck
          disabled={busy}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <Tip label="Draft the message: a small request on this chat's account" side="top">
          <button type="button" className="btn btn-sm ch-commit-draft" aria-label="Draft the message: a small request on this chat's account" disabled={busy || drafting} onClick={() => void draft()}>
            {drafting ? <Spinner size={12} /> : <Icon name="sparkle" size={14} />}
          </button>
        </Tip>
        <Tip label="Stage every change and commit" keys="mod+enter" side="top">
          <button type="submit" className="btn btn-sm ch-commit-btn" disabled={!ready}>
            {busy ? <Spinner size={12} /> : <Icon name="commit" size={14} />}
            Commit all
          </button>
        </Tip>
      </div>
      {error && (
        <p className="ch-commit-error" id="ch-commit-error" role="alert">
          <Icon name="warning" size={13} />
          <span>{error}</span>
        </p>
      )}
    </form>
  );
}

function needs(d: DiffEntry | undefined) {
  return !d || (d.state === 'ok' && d.stale);
}

/**
 * Rows drawn at first: what fills a tall panel. A long list draws the rest once the window is idle,
 * so opening the panel or the tab never waits on rows below the fold.
 */
const FIRST_ROWS = 36;
/**
 * The rows added per idle moment after the first. All of them at once was one task of two to four
 * seconds for a long chat's edits outside a repository (about 2,000 files): on every switch to that
 * chat with the tab open the window took no click until it was over (desk2, `railcost.mjs`).
 */
const MORE_ROWS = 120;

function useRowLimit(total: number): number {
  const [limit, setLimit] = useState(FIRST_ROWS);
  const more = total > limit;
  useEffect(() => {
    if (!more) return;
    const grow = () => setLimit((l) => l + MORE_ROWS);
    const w = window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(grow, { timeout: 700 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(grow, 300);
    return () => window.clearTimeout(t);
  }, [more, limit]);
  return limit;
}

/** A refresh brings new objects for unchanged files: a row draws again only when what it shows changed. */
const sameFile = (a: GitFileStatus, b: GitFileStatus) => a === b || (a.path === b.path && a.status === b.status && a.link === b.link && a.additions === b.additions && a.deletions === b.deletions);
const sameSeen = (a: SeenFile | undefined, b: SeenFile | undefined) => a === b || (!!a && !!b && a.state === b.state && a.hash === b.hash && a.since === b.since);

/**
 * What kind of change a file has, as a word, where it is not plain editing: an "M" before every
 * row said nothing a list of changes does not already say (audit §3).
 */
const KIND: Record<string, string> = { A: 'Added', '?': 'Added', D: 'Deleted', R: 'Renamed', U: 'Conflict' };

const FileRow = memo(
  function FileRow({
    sessionId,
    cwd,
    file,
    fresh,
    open,
    entry,
    seen,
    since,
    onToggle,
    onSeen,
  }: {
    sessionId: string;
    cwd: string;
    file: GitFileStatus;
    /** It joined the list while the list was on screen. */
    fresh?: boolean;
    open: boolean;
    entry: DiffEntry | undefined;
    /** What the person has seen of it (absent until the seen states are known). */
    seen?: SeenFile;
    /** The diff of what is new since it was seen, when it has one. */
    since?: SinceEntry;
    onToggle: (p: string) => void;
    /** Marks it seen, or new again when it is seen. */
    onSeen: (p: string) => void;
  }) {
    const [dir, base] = splitPath(file.path);
    const full = entry?.state === 'ok' ? entry.diff : entry?.state === 'loading' ? entry.prev : undefined;
    // Changed again since it was seen: what is new since, unless the person asked for the whole diff.
    const [whole, setWhole] = useState(false);
    const again = seen?.state === 'again';
    const deltaReady = again && !!seen.since && !whole && since?.state === 'ok' && since.hash === seen.hash;
    const waitDelta = again && !!seen.since && !whole && !deltaReady && since?.state !== 'error';
    // The row's actions are built the first time it is hovered or focused, not with the list.
    const [hot, setHot] = useState(false);
    const wake = hot ? undefined : () => setHot(true);
    // The same target in both views: a comment written on what is new since stays on its lines in the whole diff.
    const review = useMemo(() => ({ sessionId, scope: `git:${file.path}`, path: file.path }), [sessionId, file.path]);
    const link = file.link || seen?.hash === 'link' || full?.withheld === 'link';
    const kind = link ? 'Link, not read' : KIND[file.status];
    const isSeen = seen?.state === 'seen';
    return (
      <div
        role="listitem"
        data-flip={file.path}
        className="ch-item rail-row-host"
        data-open={open || undefined}
        data-new={fresh || undefined}
        data-seen={isSeen || undefined}
        onPointerEnter={wake}
        onFocus={wake}
      >
        <button
          type="button"
          className="ch-row"
          aria-expanded={open}
          aria-keyshortcuts={seen ? 'M' : undefined}
          onClick={() => onToggle(file.path)}
          onKeyDown={(e) => {
            if (seen && (e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) {
              e.preventDefault();
              onSeen(file.path);
            }
          }}
        >
          <span className="ch-mark" aria-hidden>
            {seen && !isSeen && <span className="ch-dot" />}
          </span>
          <span className="ch-path">
            {dir && <span className="ch-dir">{dir}</span>}
            <span className="ch-base">{base}</span>
          </span>
          {seen && <span className="sr-only">{isSeen ? ', seen' : again ? ', changed since you looked' : ', not seen yet'}</span>}
          <span className="ch-stat num rail-row-deco">
            {kind && <span className="ch-kind" data-kind={file.status}>{kind}</span>}
            {!link && !!file.additions && <span className="dv-add">+{file.additions}</span>}
            {!link && !!file.deletions && <span className="dv-del">−{file.deletions}</span>}
          </span>
          <Icon name="caret-right" size={10} className="ch-caret" />
        </button>
        {hot && <RowActions path={file.path} deleted={file.status === 'D'} seen={seen} onSeen={onSeen} />}
        <Collapse open={open}>
          <div className="ch-diff">
            {!link && again && (
              <p className="ch-since">
                {seen.since ? (
                  <>
                    <span>{whole ? 'The whole diff' : 'What changed since you looked'}</span>
                    <button type="button" className="rail-link" onClick={() => setWhole((v) => !v)}>
                      {whole ? 'Show only what is new' : 'Show the whole diff'}
                    </button>
                  </>
                ) : (
                  <span>Changed since you looked. The version you saw was too large to keep, so this is the whole diff.</span>
                )}
              </p>
            )}
            {link ? <p className="ch-note">Link, not read</p> : deltaReady ? (
              since.diff ? (
                <DiffView diff={since.diff} showHeader={false} maxLines={240} review={review} />
              ) : (
                <p className="ch-note">No textual changes since you looked</p>
              )
            ) : waitDelta ? (
              <div className="ch-note">
                <Spinner size={12} />
                Loading diff
              </div>
            ) : full ? (
              <DiffView diff={full} showHeader={false} maxLines={240} review={review} />
            ) : entry?.state === 'error' ? (
              <p className="ch-note">
                Could not load this diff. <button type="button" className="rail-link" onClick={() => loadDiff(cwd, file.path)}>Try again</button>
              </p>
            ) : entry?.state === 'ok' ? (
              <p className="ch-note">{file.status === 'D' ? 'File deleted' : 'No textual changes'}</p>
            ) : (
              <div className="ch-note">
                <Spinner size={12} />
                Loading diff
              </div>
            )}
          </div>
        </Collapse>
      </div>
    );
  },
  (a, b) =>
    a.sessionId === b.sessionId &&
    a.cwd === b.cwd &&
    a.fresh === b.fresh &&
    a.open === b.open &&
    a.entry === b.entry &&
    a.since === b.since &&
    a.onToggle === b.onToggle &&
    a.onSeen === b.onSeen &&
    sameSeen(a.seen, b.seen) &&
    sameFile(a.file, b.file),
);

/**
 * A changed file's secondary actions: they take the place of its line counts while the row is
 * hovered or focused (the panel's one pattern for secondary actions, see .rail-row-acts).
 */
function RowActions({ path, deleted, seen, onSeen }: { path: string; deleted?: boolean; seen?: SeenFile; onSeen?: (p: string) => void }) {
  const setUi = useStore((s) => s.setUi);
  return (
    <span className="rail-row-acts ch-acts">
      {seen && onSeen && (
        <IconButton
          icon={seen.state === 'seen' ? 'circle' : 'check'}
          label={seen.state === 'seen' ? 'Mark as not seen' : 'Mark seen'}
          keys="m"
          size={14}
          onClick={() => onSeen(path)}
        />
      )}
      <IconButton icon="at" label="Mention in chat" size={14} onClick={() => focusComposer('@' + path + ' ', { append: true })} />
      {!deleted && <IconButton icon="file-text" label="Open file" size={14} onClick={() => setUi({ railFile: path })} />}
    </span>
  );
}

export function StatusLetter({ status, small }: { status: string; small?: boolean }) {
  const s = STATUS_TONE[status] ?? STATUS_TONE.M;
  // Monochrome: the letter says it; only a deletion keeps a hint of red.
  return (
    <span className="st-letter" data-small={small || undefined} data-status={status} title={s.label} aria-label={s.label}>

      {status}
    </span>
  );
}

// ───────────────────────────── outside a repository ─────────────────────────────

interface EditedFile extends FileDiff {
  edits: number;
  /** The steps whose edits make up this file's diff, in order. */
  from: string[];
}

/** The diffs carried by this session's edit/write tools, merged per file in order. */
function useSessionEdits(sessionId: string, cwd: string): EditedFile[] {
  const ids = useToolIds(sessionId, isDoneEdit, true);
  return useMemo(() => {
    const items = useStore.getState().data[sessionId]?.items ?? emptyIndex;
    const byPath = new Map<string, EditedFile>();
    for (const id of ids) {
      const it = items[id] as ToolItem | undefined;
      for (const d of it?.result?.diff ?? []) {
        const path = relPath(d.path, cwd);
        const cur = byPath.get(path);
        if (!cur) {
          byPath.set(path, { ...d, path, hunks: [...d.hunks], edits: 1, from: [id] });
          continue;
        }
        cur.additions += d.additions;
        cur.deletions += d.deletions;
        cur.hunks = [...cur.hunks, ...d.hunks];
        cur.edits++;
        cur.from.push(id);
        if (d.status === 'deleted') cur.status = 'deleted';
        else if (cur.status === 'deleted') cur.status = 'modified';
      }
    }
    return [...byPath.values()];
  }, [ids, sessionId, cwd]);
}

function SessionEdits({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const files = useSessionEdits(sessionId, cwd);
  const visible = useStore(s => s.ui.railOpen && s.ui.railTab === 'changes');
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  useJumpOpen(
    (r) => r.sessionId === sessionId && r.scope.startsWith('edits:'),
    (r) => setOpen(withPath(r.scope.slice(6))),
  );
  // An open file's diff needs its edits whole: the ones that came as rows are asked for (once each).
  useEffect(() => {
    if (!visible || !open.size) return;
    const items = useStore.getState().data[sessionId]?.items ?? emptyIndex;
    const needed = new Set<string>();
    for (const f of files) {
      if (!open.has(f.path)) continue;
      for (const id of f.from) if ((items[id] as ToolItem | undefined)?.more) needed.add(id);
    }
    const stops = [...needed].map(id => requestWhileCut(sessionId, id));
    return () => stops.forEach(stop => stop());
  }, [open, files, sessionId, visible]);
  // One target per file, kept while the file stays, so its diff only draws again when it changes.
  const reviews = useMemo(() => new Map(files.map((f) => [f.path, { sessionId, scope: `edits:${f.path}`, path: f.path }])), [files, sessionId]);
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const allOpen = files.length > 0 && files.every((f) => open.has(f.path));
  const arrived = useArrivals(files.map((f) => f.path));
  // A long chat edits thousands of files: the first rows at once, the rest a share at a time when idle.
  const limit = useRowLimit(files.length);
  const toggle = (p: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  return (
    <div className="rail-col">
      <div className="rail-bar">
        <Tip label="This folder is not a git repository">
          <span className="rail-bar-title ch-branch truncate">
            <Icon name="pencil" size={14} />
            <span className="truncate">Edited in this session</span>
          </span>
        </Tip>
        <span className="rail-bar-meta ch-totals num">
          {files.length > 0 && (
            <>
              {adds > 0 && <span className="dv-add">+{adds.toLocaleString('en-US')}</span>}
              {dels > 0 && <span className="dv-del">−{dels.toLocaleString('en-US')}</span>}
              <span>in {plural(files.length, 'file')}</span>
            </>
          )}
        </span>
        <span className="rail-bar-actions">
          {files.length > 0 && (
            <IconButton icon={allOpen ? 'collapse' : 'expand'} label={allOpen ? 'Collapse all' : 'Expand all'} size={14} onClick={() => setOpen(allOpen ? new Set() : new Set(files.map((f) => f.path)))} />
          )}
        </span>
      </div>
      <div className="rail-scroll scroll">
        {files.length === 0 ? (
          <p className="rail-empty">Nothing has been edited in this session yet.</p>
        ) : (
          <>
            <ul className="ch-list">
              {files.slice(0, limit).map((f) => {
                const [dir, base] = splitPath(f.path);
                const isOpen = open.has(f.path);
                return (
                  <li key={f.path} className="ch-item rail-row-host" data-open={isOpen || undefined} data-new={arrived.has(f.path) || undefined}>
                    <button type="button" className="ch-row" aria-expanded={isOpen} onClick={() => toggle(f.path)}>
                      <span className="ch-path">
                        {dir && <span className="ch-dir">{dir}</span>}
                        <span className="ch-base">{base}</span>
                      </span>
                      <span className="ch-stat num rail-row-deco">
                        {f.status !== 'modified' && <span className="ch-kind" data-kind={f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'R'}>{f.status === 'added' ? 'Added' : f.status === 'deleted' ? 'Deleted' : 'Renamed'}</span>}
                        {f.edits > 1 && <span className="ch-edits">{f.edits} edits</span>}
                        {!!f.additions && <span className="dv-add">+{f.additions}</span>}
                        {!!f.deletions && <span className="dv-del">−{f.deletions}</span>}
                      </span>
                      <Icon name="caret-right" size={10} className="ch-caret" />
                    </button>
                    <RowActions path={f.path} deleted={f.status === 'deleted'} />
                    <Collapse open={isOpen}>
                      <div className="ch-diff">
                        <DiffView diff={f} showHeader={false} maxLines={240} lineNumbers={f.edits === 1} review={reviews.get(f.path)} />
                      </div>
                    </Collapse>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
