import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { FileDiff, GitCommitResult, GitPullContext, GitPullRequestResult, GitStatus, TimelineItem } from '@shared/protocol';
import { bridge } from '@/lib/bridge';
import { changedSince, useStore } from '@/state/store';

/**
 * Working-tree state for the panel, keyed by folder. Shared by Changes (list + diffs)
 * and Files (status letters in the tree). Diffs load lazily and survive refreshes as
 * "stale" until their replacement arrives, so open diffs never flash empty.
 */

export type DiffEntry =
  | { state: 'loading'; prev?: FileDiff | null }
  | { state: 'ok'; diff: FileDiff | null; stale?: boolean }
  | { state: 'error'; error: string };

export interface RepoState {
  status?: GitStatus;
  loading: boolean;
  error?: string;
  rev: number;
  diffs: Record<string, DiffEntry>;
}

export const useGit = create<{ repos: Record<string, RepoState> }>(() => ({ repos: {} }));

export const gitKey = (cwd: string) => cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const EMPTY_REPO: RepoState = { loading: false, rev: 0, diffs: {} };

function patch(cwd: string, fn: (r: RepoState) => Partial<RepoState>) {
  const k = gitKey(cwd);
  useGit.setState((s) => {
    const cur = s.repos[k] ?? EMPTY_REPO;
    return { repos: { ...s.repos, [k]: { ...cur, ...fn(cur) } } };
  });
}

export const useRepo = (cwd: string): RepoState | undefined => useGit((s) => s.repos[gitKey(cwd)]);

const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();

/** Small trees load every diff in one call; big ones load per file on demand. */
export function isSmall(status: GitStatus | undefined): boolean {
  if (!status) return false;
  return status.files.length <= 12 && status.additions + status.deletions <= 2500;
}

export function refreshGit(cwd: string): Promise<void> {
  const k = gitKey(cwd);
  const running = inflight.get(k);
  if (running) {
    again.add(k);
    return running;
  }
  patch(cwd, () => ({ loading: true }));
  const p = bridge
    .call('git.status', { cwd }, 30_000)
    .then((status) => {
      patch(cwd, (r) => {
        const paths = new Set(status.files.map((f) => f.path));
        const diffs: Record<string, DiffEntry> = {};
        for (const [path, d] of Object.entries(r.diffs)) {
          if (!paths.has(path)) continue;
          if (d.state === 'ok') diffs[path] = { ...d, stale: true };
          else if (d.state === 'loading') diffs[path] = d;
        }
        return { status, loading: false, error: undefined, rev: r.rev + 1, diffs };
      });
    })
    .catch((err: Error) => patch(cwd, () => ({ loading: false, error: err.message || String(err) })))
    .finally(() => {
      inflight.delete(k);
      if (again.delete(k)) void refreshGit(cwd);
    });
  inflight.set(k, p);
  return p;
}

/** Stages every change and commits it, then refreshes the tree. Never throws: failures come back as `{ ok: false }`. */
export async function commitAll(cwd: string, message: string): Promise<GitCommitResult> {
  try {
    return await bridge.call('git.commit', { cwd, message }, 130_000);
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  } finally {
    void refreshGit(cwd);
  }
}

/** A commit message written from the folder's changes (Claude Code's Haiku). Stages nothing. Never throws. */
export async function draftCommitMessage(cwd: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    return await bridge.call('git.draft', { cwd }, 90_000);
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

/** The branch, its base and a draft title and description for a pull request. Never throws. */
export async function pullContext(cwd: string): Promise<GitPullContext | { error: string }> {
  try {
    return await bridge.call('pulls.context', { cwd }, 30_000);
  } catch (err) {
    return { error: (err as Error).message || String(err) };
  }
}

/** Pushes the branch and opens its pull request. Never throws. */
export async function createPull(cwd: string, opts: { title: string; body: string; base: string; draft: boolean }): Promise<GitPullRequestResult> {
  try {
    return await bridge.call('pulls.create', { cwd, ...opts }, 180_000);
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

const diffInflight = new Set<string>();

function prevDiff(d: DiffEntry | undefined): FileDiff | null | undefined {
  if (!d) return undefined;
  if (d.state === 'ok') return d.diff;
  if (d.state === 'loading') return d.prev;
  return undefined;
}

export function loadDiff(cwd: string, path: string) {
  const id = `${gitKey(cwd)}\u0000${path}`;
  if (diffInflight.has(id)) return;
  diffInflight.add(id);
  patch(cwd, (r) => ({ diffs: { ...r.diffs, [path]: { state: 'loading', prev: prevDiff(r.diffs[path]) } } }));
  bridge
    .call('git.diff', { cwd, path }, 30_000)
    .then((list) => {
      const norm = path.replace(/\\/g, '/');
      const diff = list.find((d) => d.path.replace(/\\/g, '/') === norm) ?? list[0] ?? null;
      patch(cwd, (r) => ({ diffs: { ...r.diffs, [path]: { state: 'ok', diff } } }));
    })
    .catch((err: Error) => patch(cwd, (r) => ({ diffs: { ...r.diffs, [path]: { state: 'error', error: err.message || String(err) } } })))
    .finally(() => diffInflight.delete(id));
}

const allInflight = new Set<string>();

/** One `git.diff` for the whole tree; files missing from the result get an empty entry. */
export function loadAllDiffs(cwd: string) {
  const k = gitKey(cwd);
  if (allInflight.has(k)) return;
  const status = useGit.getState().repos[k]?.status;
  if (!status) return;
  allInflight.add(k);
  patch(cwd, (r) => {
    const diffs = { ...r.diffs };
    for (const f of status.files) {
      const d = diffs[f.path];
      if (!d || d.state === 'error' || (d.state === 'ok' && d.stale)) diffs[f.path] = { state: 'loading', prev: prevDiff(d) };
    }
    return { diffs };
  });
  bridge
    .call('git.diff', { cwd }, 60_000)
    .then((list) => {
      const byPath = new Map(list.map((d) => [d.path.replace(/\\/g, '/'), d]));
      patch(cwd, (r) => {
        const diffs = { ...r.diffs };
        for (const f of r.status?.files ?? []) {
          const d = diffs[f.path];
          if (d && d.state === 'ok' && !d.stale) continue;
          diffs[f.path] = { state: 'ok', diff: byPath.get(f.path.replace(/\\/g, '/')) ?? null };
        }
        return { diffs };
      });
    })
    .catch((err: Error) =>
      patch(cwd, (r) => {
        const diffs = { ...r.diffs };
        for (const [p, d] of Object.entries(diffs)) if (d.state === 'loading') diffs[p] = { state: 'error', error: err.message || String(err) };
        return { diffs };
      }),
    )
    .finally(() => allInflight.delete(k));
}

const settledFileTool = (it: TimelineItem | undefined) =>
  it?.type === 'tool' && (it.kind === 'edit' || it.kind === 'write' || it.kind === 'bash') && (it.status === 'done' || it.status === 'error' || it.status === 'cancelled');

/**
 * A cheap signature of the session's settled file-touching tools: changes when one finishes.
 * A write looks only at the items it changed (`changedSince`). Exported for tests.
 */
export function settledSignature(sessionId: string) {
  let lastItems: unknown = null;
  let lastRev = -1;
  let settled = new Set<string>();
  return (s: ReturnType<typeof useStore.getState>): string => {
    const d = s.data[sessionId];
    const status = s.sessions[sessionId]?.status ?? '';
    if (!d) return status;
    if (d.items !== lastItems || d.rev !== lastRev) {
      const changed = d.items === lastItems ? changedSince(d, lastRev) : null;
      lastItems = d.items;
      lastRev = d.rev;
      if (changed) {
        for (const id of changed) {
          if (settledFileTool(d.items[id])) settled.add(id);
          else settled.delete(id);
        }
      } else {
        settled = new Set();
        for (const id in d.items) if (settledFileTool(d.items[id])) settled.add(id);
      }
    }
    return `${status}|${settled.size}`;
  };
}

/**
 * Keeps the folder's git state fresh while the panel is open: on mount, when a turn
 * ends or an edit/write/bash tool settles (debounced), and when the window regains focus.
 */
export function useGitAutoRefresh(sessionId: string, cwd: string) {
  const sigRef = useRef<ReturnType<typeof settledSignature> | null>(null);
  const sigFor = useRef('');
  if (!sigRef.current || sigFor.current !== sessionId) {
    sigRef.current = settledSignature(sessionId);
    sigFor.current = sessionId;
  }
  const sig = useStore(sigRef.current);

  useEffect(() => {
    if (cwd) void refreshGit(cwd);
  }, [cwd]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!cwd) return;
    const t = window.setTimeout(() => void refreshGit(cwd), 700);
    return () => window.clearTimeout(t);
  }, [sig, cwd]);

  useEffect(() => {
    if (!cwd) return;
    let t = 0;
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(t);
      t = window.setTimeout(() => void refreshGit(cwd), 250);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [cwd]);
}

export const STATUS_TONE: Record<string, { tone: string; label: string }> = {
  M: { tone: 'amber', label: 'Modified' },
  A: { tone: 'green', label: 'Added' },
  D: { tone: 'red', label: 'Deleted' },
  R: { tone: 'blue', label: 'Renamed' },
  U: { tone: 'red', label: 'Conflict' },
  '?': { tone: 'grey', label: 'Untracked' },
};
