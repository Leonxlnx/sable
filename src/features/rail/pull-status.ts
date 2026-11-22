import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { GitStatus, PullCheck, PullRequestInfo, PullStatus } from '@shared/protocol';
import { readPullStatus } from '@/state/actions';
import { useStore } from '@/state/store';
import { gitKey, useGit } from './git-state';

/**
 * The pull request of each folder's checked-out branch as the bridge last read it (`pulls.status`),
 * kept outside React so the Changes tab shows it at once when it comes back and then reads again.
 *
 * When it is read: the tab shows a folder, the window comes back, a pull request was created in the
 * dialog, a push is seen (the branch has fewer commits ahead of its upstream), and every 30 s while
 * checks run or are about to (the 90 s after a pull request was created or a push was seen). Only
 * while the tab shows and the window can be seen, one request per folder at a time, and never more
 * than once in 20 s for a folder: what could not be asked yet is asked when those 20 s are over.
 * Only the row's own refresh asks at once.
 *
 * The answer names the branch it is for. It is kept as the folder's last answer, and shown only
 * while the tab shows that same branch: a late answer for another branch never stands in the row.
 */

/** Never more than one request per folder in this time (the row's own refresh is exempt). */
export const FLOOR_MS = 20_000;
/** While checks run and the tab shows: how often the pull request is read again. */
export const POLL_MS = 30_000;
/**
 * A branch that has no pull request is asked about again only after this long when nothing says it
 * changed (the tab shown again, the window back): on `main` every focus would otherwise start gh
 * for an answer that is "none". A push, a creation, another branch and the row's refresh ask at once.
 */
export const QUIET_MS = 5 * 60_000;
/** After a pull request was created or a push was seen: how long checks are expected though none runs yet. */
export const EXPECT_MS = 90_000;

export interface PullView {
  /** The folder's last answer; `status.branch` says which branch it is for. */
  status?: PullStatus;
  /** A request is under way. */
  loading: boolean;
  /** Something is still to be asked: a request is under way, or one waits for the 20 s to be over. */
  pending: boolean;
  /** A request came back at least once (with an answer or without). */
  settled: boolean;
  /** The branch the last answer stands for: its own, or the one the tab showed when it has none (a detached HEAD). */
  branch?: string;
}

export interface PullWatchDeps {
  /** Asks the bridge; null when it could not be asked. */
  read: (cwd: string) => Promise<PullStatus | null>;
  /** The branch the tab shows for the folder now. */
  branchOf: (cwd: string) => string | undefined;
  /** Whether the window can be seen. */
  seen: () => boolean;
  now?: () => number;
}

interface Entry {
  cwd: string;
  view: PullView;
  /** When the last request began. */
  askedAt: number;
  /** A request that waits: for the branch the tab moved to, or because the pull request itself changed. */
  want: false | 'branch' | 'changed';
  /** Until when checks are expected to begin. */
  expectUntil: number;
  /** The row shows the dialog's own pull request, not yet GitHub's answer; and when it was put in. */
  seeded: boolean;
  seededAt: number;
  /** How many views show this folder's Changes tab now. */
  watchers: number;
  timer?: ReturnType<typeof setTimeout>;
  inflight?: Promise<void>;
}

const EMPTY: PullView = { loading: false, pending: false, settled: false };

/** Whether a pull request still has checks to wait for. */
export const checksRunning = (pull: PullRequestInfo | undefined): boolean => !!pull && (pull.state === 'open' || pull.state === 'draft') && pull.counts.running > 0;

export function createPullWatch(deps: PullWatchDeps) {
  const now = deps.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();

  const entry = (cwd: string): Entry => {
    const k = gitKey(cwd);
    let e = entries.get(k);
    if (!e) {
      e = { cwd, view: EMPTY, askedAt: -Infinity, want: false, expectUntil: 0, seeded: false, seededAt: -Infinity, watchers: 0 };
      entries.set(k, e);
    }
    return e;
  };

  const show = (e: Entry, patch: Partial<PullView> = {}) => {
    const next = { ...e.view, ...patch, pending: (patch.loading ?? e.view.loading) || e.want !== false };
    const was = e.view;
    if (was.status === next.status && was.loading === next.loading && was.pending === next.pending && was.settled === next.settled && was.branch === next.branch) return;
    e.view = next;
    for (const l of listeners) l();
  };

  /** Whether the last answer is for the branch the tab shows. */
  const current = (e: Entry) => e.view.settled && e.view.branch === deps.branchOf(e.cwd);

  /** When the folder is asked next without anyone asking: a waiting request once the 20 s are over, else the poll. */
  const plan = (e: Entry) => {
    clearTimeout(e.timer);
    e.timer = undefined;
    if (e.inflight || e.watchers === 0 || !deps.seen()) return;
    const t = now();
    const polls = current(e) && (checksRunning(e.view.status?.pull) || e.expectUntil > t);
    const due = e.want ? e.askedAt + FLOOR_MS : polls ? e.askedAt + POLL_MS : null;
    if (due === null) return;
    e.timer = setTimeout(() => {
      e.timer = undefined;
      if (e.watchers > 0 && deps.seen() && !e.inflight) start(e);
    }, Math.max(0, due - t));
  };

  const start = (e: Entry): Promise<void> => {
    clearTimeout(e.timer);
    e.timer = undefined;
    e.want = false;
    const began = now();
    e.askedAt = began;
    const run = deps
      .read(e.cwd)
      .catch(() => null)
      .then((answer) => {
        e.inflight = undefined;
        const shown = deps.branchOf(e.cwd);
        // What was asked meanwhile for the branch the tab moved to is answered by this very answer.
        if (answer && e.want === 'branch' && (answer.branch ?? shown) === shown) e.want = false;
        // The dialog's own pull request stands until GitHub shows it too: an answer that was already
        // on its way, or one from the first moments in which GitHub does not list it yet, is not news.
        const older = e.seeded && (began < e.seededAt || (!answer?.pull && now() < e.expectUntil));
        if (answer?.pull) e.seeded = false;
        if (answer && !older) show(e, { status: answer, branch: answer.branch ?? shown, loading: false, settled: true });
        // Not asked (the bridge is away): the tab keeps what it had, and this branch counts as asked.
        else show(e, { loading: false, settled: true, ...(older ? {} : { branch: shown }) });
        plan(e);
      });
    e.inflight = run;
    show(e, { loading: true });
    return run;
  };

  /**
   * Asks for the folder's pull request, within the rules. `force`: the row's own refresh, at once.
   * `changed`: the pull request itself is known to have changed (created, pushed to), so the answer
   * in hand is old whatever its age.
   */
  const ask = (cwd: string, o: { force?: boolean; changed?: boolean } = {}): Promise<void> => {
    if (!cwd) return Promise.resolve();
    const e = entry(cwd);
    const wants = o.changed ? 'changed' : current(e) ? false : 'branch';
    if (e.inflight) {
      // The answer on its way may be for the branch before, or from before the change.
      if (wants && e.want !== 'changed') e.want = wants;
      show(e);
      return e.inflight;
    }
    // Nothing new is known and the last answer was "none": the longer quiet applies.
    const floor = !wants && !e.view.status?.pull ? QUIET_MS : FLOOR_MS;
    if (o.force || now() - e.askedAt >= floor) return start(e);
    if (wants && e.want !== 'changed') e.want = wants;
    show(e);
    plan(e);
    return Promise.resolve();
  };

  return {
    get: (cwd: string): PullView => (cwd ? (entries.get(gitKey(cwd))?.view ?? EMPTY) : EMPTY),
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    ask,
    /** The Changes tab shows this folder: it is asked (within the 20 s) and read on while checks run. The returned function ends it. */
    watch(cwd: string): () => void {
      const e = entry(cwd);
      e.watchers++;
      void ask(cwd);
      let over = false;
      return () => {
        if (over) return;
        over = true;
        e.watchers--;
        if (e.watchers === 0) {
          clearTimeout(e.timer);
          e.timer = undefined;
        }
      };
    },
    /** The dialog opened a pull request: it stands in the row at once, and GitHub is asked for the rest. */
    created(cwd: string, status: PullStatus) {
      const e = entry(cwd);
      e.seeded = true;
      e.seededAt = now();
      e.expectUntil = e.seededAt + EXPECT_MS;
      show(e, { status, branch: status.branch, settled: true });
      void ask(cwd, { changed: true });
    },
    /** The branch's commits went to its upstream: its pull request has a new head, and its checks begin again in a moment. */
    pushed(cwd: string) {
      const e = entry(cwd);
      e.expectUntil = now() + EXPECT_MS;
      void ask(cwd, { changed: true });
    },
  };
}

export const pulls = createPullWatch({
  read: readPullStatus,
  branchOf: (cwd) => {
    const status = useGit.getState().repos[gitKey(cwd)]?.status;
    return status?.isRepo ? status.branch : undefined;
  },
  seen: () => typeof document === 'undefined' || document.visibilityState === 'visible',
});

/** Reads the folder's pull request again now (the row's refresh). */
export const refreshPull = (cwd: string) => pulls.ask(cwd, { force: true });

/** What the tab may show of a folder's last answer while it shows `branch`. Pure. */
export function pullFor(view: PullView, branch: string | undefined): { pull?: PullRequestInfo; loading: boolean; known: boolean } {
  // The answer in hand is for this branch (it may be read again meanwhile: it stands until then).
  const mine = view.settled && view.branch === branch;
  const status = mine ? view.status : undefined;
  return { pull: status && status.branch === branch ? status.pull : undefined, loading: view.loading, known: mine || (view.settled && !view.pending) };
}

/**
 * The pull request of the branch the tab shows, as last read. `known`: this branch was asked about,
 * so "there is none" can be trusted (the Create button waits for it and never shows only to go).
 */
export function usePullRequest(cwd: string, branch: string | undefined): { pull?: PullRequestInfo; loading: boolean; known: boolean } {
  const view = useSyncExternalStore(pulls.subscribe, () => pulls.get(cwd));
  return pullFor(view, branch);
}

/**
 * Keeps the folder's pull request read while the Changes tab shows it: when the tab shows the
 * folder or its branch changes, when the window comes back, when a push is seen. Nothing is asked
 * while the tab is hidden or for a folder that is not a repository.
 */
export function usePullWatch(cwd: string, status: GitStatus | undefined) {
  const shown = useStore((s) => s.ui.railOpen && s.ui.railTab === 'changes');
  const on = shown && !!cwd && !!status?.isRepo;
  const branch = status?.isRepo ? status.branch : undefined;
  const ahead = status?.isRepo ? status.ahead : undefined;

  useEffect(() => {
    if (!on) return;
    const stop = pulls.watch(cwd);
    // The window comes back: git may have moved, and so may the pull request.
    const back = () => {
      if (document.visibilityState === 'visible') void pulls.ask(cwd);
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      stop();
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [on, cwd]);

  const was = useRef<{ key: string; branch?: string; ahead?: number } | null>(null);
  useEffect(() => {
    const before = was.current;
    was.current = on ? { key: gitKey(cwd), branch, ahead } : null;
    if (!on || !before || before.key !== gitKey(cwd)) return;
    if (before.branch !== branch) void pulls.ask(cwd);
    // Fewer commits ahead of the upstream, or an upstream the branch did not have: a push.
    else if (ahead !== undefined && (before.ahead === undefined || ahead < before.ahead)) pulls.pushed(cwd);
  }, [on, cwd, branch, ahead]);
}

// ───────────────────────────── what the row says ─────────────────────────────

export const STATE_WORD: Record<PullRequestInfo['state'], string> = { draft: 'Draft', open: 'Open', merged: 'Merged', closed: 'Closed' };
export const REVIEW_WORD: Record<NonNullable<PullRequestInfo['review']>, string> = { approved: 'Approved', changes: 'Changes requested' };

/** A pull request that still takes work: its review and checks are said. Merged and closed ones say only that. */
export const isLive = (pull: PullRequestInfo): boolean => pull.state === 'open' || pull.state === 'draft';

export type ChecksWords = { kind: 'failed'; failed: number; rest: string } | { kind: 'running' | 'passed'; text: string };

/**
 * The checks in a few words: "2 of 5 checks failed" (the failed count apart, it alone is red),
 * "Checks running", "5 checks passed". Null without checks, and for a merged or closed pull
 * request. Skipped checks count nowhere.
 */
export function checksWords(pull: PullRequestInfo): ChecksWords | null {
  if (!isLive(pull)) return null;
  const { passed, failed, running } = pull.counts;
  const total = passed + failed + running;
  if (total === 0) return null;
  if (failed > 0) return { kind: 'failed', failed, rest: failed === total ? (failed === 1 ? 'check failed' : 'checks failed') : `of ${total} checks failed` };
  if (running > 0) return { kind: 'running', text: 'Checks running' };
  return { kind: 'passed', text: `${passed} ${passed === 1 ? 'check' : 'checks'} passed` };
}

/** How many failed checks the tab names before "and 3 more". */
export const MAX_FAILED_SHOWN = 5;

/** The failed checks the tab names, and how many more there are. */
export function failedChecks(pull: PullRequestInfo): { shown: PullCheck[]; more: number } {
  if (!isLive(pull) || pull.counts.failed === 0) return { shown: [], more: 0 };
  const shown = pull.checks.filter((c) => c.state === 'failed').slice(0, MAX_FAILED_SHOWN);
  return { shown, more: Math.max(0, pull.counts.failed - shown.length) };
}

/** The row in one sentence, for a screen reader. */
export function pullLabel(pull: PullRequestInfo): string {
  const checks = checksWords(pull);
  const parts = [STATE_WORD[pull.state], isLive(pull) && pull.review ? REVIEW_WORD[pull.review] : '', checks ? (checks.kind === 'failed' ? `${checks.failed} ${checks.rest}` : checks.text) : ''].filter(Boolean);
  return `Pull request ${pull.number}${pull.title ? `, ${pull.title}` : ''}. ${parts.join(', ')}. Opens on GitHub`;
}

/**
 * The composer's text with the failures added: what the person typed stays first, the failures
 * after a blank line. The same failures are never added twice. A draft that begins as a shell line
 * (`!`) or a command (`/`) is read by its first character, and text from GitHub must never ride
 * behind that into a shell or a command: there the failures go first and the typed words after
 * them, so the whole draft is a plain message.
 */
export function withFailures(typed: string, failures: string): string {
  if (!failures.trim() || typed.includes(failures)) return typed;
  if (!typed.trim()) return failures;
  if (/^\s*[!/]/.test(typed)) return `${failures}\n\n${typed.trim()}`;
  return `${typed.replace(/\s+$/, '')}\n\n${failures}`;
}

/** The pull request the dialog just opened, as the row shows it until GitHub is read: no checks yet. Null for an address that is not on github.com. */
export function createdPull(o: { branch?: string; head?: string; number?: number; url?: string; title: string; draft: boolean }): PullStatus | null {
  if (!o.branch || !o.head || !o.number || !o.url?.startsWith('https://github.com/')) return null;
  return {
    branch: o.branch,
    pull: { number: o.number, title: o.title.trim().slice(0, 200), state: o.draft ? 'draft' : 'open', url: o.url, head: o.head, checks: [], counts: { passed: 0, failed: 0, running: 0, skipped: 0 } },
  };
}
