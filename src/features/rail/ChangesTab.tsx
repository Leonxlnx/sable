import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileDiff, GitFileStatus, ToolItem } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { DiffView } from '@/components/DiffView';
import { Icon } from '@/icons';
import { plural, relPath } from '@/lib/format';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Spinner, Tip } from '@/ui';
import { STATUS_TONE, commitAll, draftCommitMessage, gitKey, isSmall, loadAllDiffs, loadDiff, refreshGit, useRepo, type DiffEntry } from './git-state';
import { LeaveList } from './leave';
import { LaneSection } from './LaneSection';
import { PullRequestAction } from './PullRequest';
import { useSessionLane } from '@/features/session/lane';
import { useJumpOpen } from '@/features/review/jump';
import { splitPath, useArrivals, useToolIds } from './util';

/** How many files the Changes tab lists (working tree, or this session's edits outside a repo). */
export function useChangeCount(sessionId: string, cwd: string): number {
  const repo = useRepo(cwd);
  const edits = useSessionEdits(sessionId, cwd);
  if (repo?.status?.isRepo) return repo.status.files.length;
  if (repo?.status && !repo.status.isRepo) return edits.length;
  return 0;
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

/** `foot`: what takes the commit box's place (a lane's section, which lands instead). */
function RepoChanges({ sessionId, cwd, foot }: { sessionId: string; cwd: string; foot?: ReactNode }) {
  const repo = useRepo(cwd)!;
  const status = repo.status!;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // The review bar's list jumps to a comment on one of these files: its row opens.
  useJumpOpen(
    (r) => r.sessionId === sessionId && r.scope.startsWith('git:'),
    (r) => setOpen(withPath(r.scope.slice(4))),
  );
  const small = isSmall(status);
  const allOpen = status.files.length > 0 && status.files.every((f) => open.has(f.path));
  const arrived = useArrivals(status.files.map((f) => f.path));

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

  // Stable, so a refresh re-renders only the rows whose file changed (FileRow is memoised).
  const toggle = useCallback(
    (p: string) =>
      setOpen((o) => {
        const n = new Set(o);
        if (n.has(p)) n.delete(p);
        else n.add(p);
        return n;
      }),
    [],
  );
  const shown = useRowLimit(status.files.length);

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
          {status.files.length > 0 && (
            <IconButton
              icon={allOpen ? 'collapse' : 'expand'}
              label={allOpen ? 'Collapse all' : 'Expand all'}
              size={14}
              onClick={() => setOpen(allOpen ? new Set() : new Set(status.files.map((f) => f.path)))}
            />
          )}
          <IconButton icon="refresh" label="Refresh" size={14} className={repo.loading ? 'is-spinning' : undefined} onClick={() => void refreshGit(cwd)} />
        </span>
      </div>
      <div className="rail-scroll scroll">
        {status.files.length === 0 ? (
          <>
            <p className="rail-empty">The working tree is clean.</p>
            <PullRequestAction cwd={cwd} />
          </>
        ) : (
          <LeaveList className="ch-list" order={status.files.map((f) => f.path).join('|')}>
            {(shown < status.files.length ? status.files.slice(0, shown) : status.files).map((f) => (
              <FileRow key={f.path} sessionId={sessionId} cwd={cwd} file={f} fresh={arrived.has(f.path)} open={open.has(f.path)} entry={repo.diffs[f.path]} onToggle={toggle} />
            ))}
          </LeaveList>
        )}
      </div>
      {foot ?? (status.files.length > 0 && <CommitBox cwd={cwd} />)}
    </div>
  );
}

/** Unsent commit messages by folder, so switching tabs or sessions keeps them. */
const commitDrafts = new Map<string, string>();
const MAX_COMMIT_LINES = 3;

function CommitBox({ cwd }: { cwd: string }) {
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
  const draft = async () => {
    if (drafting || busy) return;
    setDrafting(true);
    setError(null);
    const res = await draftCommitMessage(cwd);
    setDrafting(false);
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
        <Tip label="Write the message from the changes" side="top">
          <button type="button" className="btn btn-sm ch-commit-draft" aria-label="Write the message from the changes" disabled={busy || drafting} onClick={() => void draft()}>
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

function useRowLimit(total: number): number {
  const [limit, setLimit] = useState(FIRST_ROWS);
  const more = total > limit;
  useEffect(() => {
    if (!more) return;
    const w = window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setLimit(Infinity), { timeout: 700 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(() => setLimit(Infinity), 300);
    return () => window.clearTimeout(t);
  }, [more]);
  return limit;
}

/** A refresh brings new objects for unchanged files: a row draws again only when what it shows changed. */
const sameFile = (a: GitFileStatus, b: GitFileStatus) => a === b || (a.path === b.path && a.status === b.status && a.additions === b.additions && a.deletions === b.deletions);

const FileRow = memo(
  function FileRow({
    sessionId,
    cwd,
    file,
    fresh,
    open,
    entry,
    onToggle,
  }: {
    sessionId: string;
    cwd: string;
    file: GitFileStatus;
    /** It joined the list while the list was on screen. */
    fresh?: boolean;
    open: boolean;
    entry: DiffEntry | undefined;
    onToggle: (p: string) => void;
  }) {
    const [dir, base] = splitPath(file.path);
    const diff = entry?.state === 'ok' ? entry.diff : entry?.state === 'loading' ? entry.prev : undefined;
    // The row's actions are built the first time it is hovered or focused, not with the list.
    const [hot, setHot] = useState(false);
    const wake = hot ? undefined : () => setHot(true);
    const review = useMemo(() => ({ sessionId, scope: `git:${file.path}`, path: file.path }), [sessionId, file.path]);
    return (
      <div role="listitem" data-flip={file.path} className="ch-item rail-row-host" data-open={open || undefined} data-new={fresh || undefined} onPointerEnter={wake} onFocus={wake}>
        <button type="button" className="ch-row" aria-expanded={open} onClick={() => onToggle(file.path)}>
          <StatusLetter status={file.status} />
          <span className="ch-path">
            {dir && <span className="ch-dir">{dir}</span>}
            <span className="ch-base">{base}</span>
          </span>
          <span className="ch-stat num rail-row-deco">
            {!!file.additions && <span className="dv-add">+{file.additions}</span>}
            {!!file.deletions && <span className="dv-del">−{file.deletions}</span>}
          </span>
          <Icon name="caret-right" size={10} className="ch-caret" />
        </button>
        {hot && <RowActions path={file.path} deleted={file.status === 'D'} />}
        <Collapse open={open}>
          <div className="ch-diff">
            {diff ? (
              <DiffView diff={diff} showHeader={false} maxLines={240} review={review} />
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
  (a, b) => a.sessionId === b.sessionId && a.cwd === b.cwd && a.fresh === b.fresh && a.open === b.open && a.entry === b.entry && a.onToggle === b.onToggle && sameFile(a.file, b.file),
);

/**
 * A changed file's secondary actions: they take the place of its line counts while the row is
 * hovered or focused (the panel's one pattern for secondary actions, see .rail-row-acts).
 */
function RowActions({ path, deleted }: { path: string; deleted?: boolean }) {
  const setUi = useStore((s) => s.setUi);
  return (
    <span className="rail-row-acts ch-acts">
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
}

/** The diffs carried by this session's edit/write tools, merged per file in order. */
function useSessionEdits(sessionId: string, cwd: string): EditedFile[] {
  const ids = useToolIds(sessionId, (it) => (it.kind === 'edit' || it.kind === 'write') && it.status === 'done' && !!it.result?.diff?.length);
  return useMemo(() => {
    const items = useStore.getState().data[sessionId]?.items ?? {};
    const byPath = new Map<string, EditedFile>();
    for (const id of ids) {
      const it = items[id] as ToolItem | undefined;
      for (const d of it?.result?.diff ?? []) {
        const path = relPath(d.path, cwd);
        const cur = byPath.get(path);
        if (!cur) {
          byPath.set(path, { ...d, path, hunks: [...d.hunks], edits: 1 });
          continue;
        }
        cur.additions += d.additions;
        cur.deletions += d.deletions;
        cur.hunks = [...cur.hunks, ...d.hunks];
        cur.edits++;
        if (d.status === 'deleted') cur.status = 'deleted';
        else if (cur.status === 'deleted') cur.status = 'modified';
      }
    }
    return [...byPath.values()];
  }, [ids, sessionId, cwd]);
}

function SessionEdits({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const files = useSessionEdits(sessionId, cwd);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  useJumpOpen(
    (r) => r.sessionId === sessionId && r.scope.startsWith('edits:'),
    (r) => setOpen(withPath(r.scope.slice(6))),
  );
  // One target per file, kept while the file stays, so its diff only draws again when it changes.
  const reviews = useMemo(() => new Map(files.map((f) => [f.path, { sessionId, scope: `edits:${f.path}`, path: f.path }])), [files, sessionId]);
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const allOpen = files.length > 0 && files.every((f) => open.has(f.path));
  const arrived = useArrivals(files.map((f) => f.path));
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
              {files.map((f) => {
                const [dir, base] = splitPath(f.path);
                const isOpen = open.has(f.path);
                return (
                  <li key={f.path} className="ch-item rail-row-host" data-open={isOpen || undefined} data-new={arrived.has(f.path) || undefined}>
                    <button type="button" className="ch-row" aria-expanded={isOpen} onClick={() => toggle(f.path)}>
                      <StatusLetter status={f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : f.status === 'renamed' ? 'R' : 'M'} />
                      <span className="ch-path">
                        {dir && <span className="ch-dir">{dir}</span>}
                        <span className="ch-base">{base}</span>
                      </span>
                      <span className="ch-stat num rail-row-deco">
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
