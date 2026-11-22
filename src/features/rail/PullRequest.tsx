import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { GitPullContext, PullRequestInfo } from '@shared/protocol';
import { Tiles } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { Icon } from '@/icons';
import { readPullFailures } from '@/state/actions';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Modal, Spinner, Switch, titleIfCut } from '@/ui';
import { createPull, pullContext, useRepo } from './git-state';
import { REVIEW_WORD, STATE_WORD, checksWords, createdPull, failedChecks, isLive, pullLabel, pulls, refreshPull, usePullRequest, usePullWatch, withFailures } from './pull-status';
import './pull-request.css';

/** How long the Create button waits for GitHub's answer about the branch before it is offered anyway. */
const OFFER_AFTER_MS = 4000;

/**
 * The clean working tree's next step: a pull request for the branch, opened from here. Offered for
 * a branch with none to work on (none at all, or one already merged or closed), and only once that
 * is known, so the button does not show just to make way for the pull request's row; an answer
 * that takes longer than a few seconds is not waited for.
 */
export function PullRequestAction({ cwd }: { cwd: string }) {
  const [open, setOpen] = useState(false);
  const status = useRepo(cwd)?.status;
  const branch = status?.isRepo ? status.branch : undefined;
  const { pull, known } = usePullRequest(cwd, branch);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    const t = window.setTimeout(() => setWaited(true), OFFER_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [cwd, branch]);
  const offer = (known || waited) && !(pull && isLive(pull));
  // It came after the tab did (GitHub was asked first): it fades in instead of popping.
  const late = useRef(!offer).current;
  if (!offer && !open) return null;
  return (
    <div className="pr-action" data-late={late || undefined}>
      {offer && (
        <button type="button" className="btn btn-sm pr-open" onClick={() => setOpen(true)}>
          <Icon name="pull-request" size={14} />
          Create pull request
        </button>
      )}
      {open && <PullRequestDialog cwd={cwd} onOpenChange={setOpen} />}
    </div>
  );
}

const Dot = () => (
  <span className="pr-dot" aria-hidden>
    ·
  </span>
);

/**
 * Pointer-enter on the row: the whole title as its tooltip, only when the row does not show it
 * whole (cut with an ellipsis, or left out where the rail is narrow). Nothing measures at rest.
 */
function wholeTitleIfCut(e: { currentTarget: HTMLElement }) {
  const row = e.currentTarget;
  const title = row.querySelector<HTMLElement>('.pr-title');
  const slot = title?.parentElement;
  // Left out: it wrapped under the line the row shows.
  const cut = !!title && !!slot && (title.scrollWidth > title.clientWidth + 1 || title.getBoundingClientRect().top >= slot.getBoundingClientRect().bottom - 1);
  if (cut && title.textContent) row.title = title.textContent;
  else row.removeAttribute('title');
}

/**
 * The branch's pull request as one row: its number and title, then its state, its review and its
 * checks in plain words; the whole row opens it on GitHub. Under it, only when checks failed, their
 * names (each opens its run) and the hand-over to the chat. Drawn from what it is given: the
 * gallery shows it from fixed data.
 */
export function PullRow({
  pull,
  loading,
  sending,
  onRefresh,
  onSendFailures,
}: {
  pull: PullRequestInfo;
  /** It is being read again. */
  loading?: boolean;
  /** The failed logs are being read. */
  sending?: boolean;
  onRefresh?: () => void;
  onSendFailures?: () => void;
}) {
  const checks = checksWords(pull);
  const review = isLive(pull) ? pull.review : undefined;
  const { shown, more } = failedChecks(pull);
  return (
    <div className="pr-box">
      <div className="pr-row rail-row-host">
        <a className="pr-go" href={pull.url} target="_blank" rel="noreferrer" aria-label={pullLabel(pull)} onPointerEnter={wholeTitleIfCut}>
          <span className="pr-mark">
            <Icon name="pull-request" size={14} />
          </span>
          <span className="pr-text">
            <span className="pr-num num">#{pull.number}</span>
            <span className="pr-title-slot">
              <span className="pr-title">{pull.title}</span>
            </span>
            {/* Written last to first: where the rail is narrow the words shed whole, the state first,
                then the review; the checks stay (pull-request.css). Read as: state, review, checks. */}
            <span className="pr-words">
              {checks && (
                <span className="pr-word">
                  {checks.kind === 'failed' ? (
                    <>
                      <span className="pr-failed-n num">{checks.failed}</span> {checks.rest}
                    </>
                  ) : (
                    <>
                      {checks.kind === 'running' && <Tiles size={10} className="pr-tiles" />}
                      {checks.text}
                    </>
                  )}
                </span>
              )}
              {review && (
                <span className="pr-word">
                  {REVIEW_WORD[review]}
                  {checks && <Dot />}
                </span>
              )}
              {/* "Open" is not said beside a review decision, which says it: the title gets the room. */}
              {!(pull.state === 'open' && review) && (
                <span className="pr-word">
                  {STATE_WORD[pull.state]}
                  {(review || checks) && <Dot />}
                </span>
              )}
            </span>
          </span>
          <Icon name="external" size={11} className="pr-out rail-row-deco" />
        </a>
        {onRefresh && (
          <span className="rail-row-acts pr-row-acts">
            <IconButton icon="refresh" label="Refresh pull request" size={14} className={loading ? 'is-spinning' : undefined} onClick={onRefresh} />
          </span>
        )}
      </div>
      <Collapse open={shown.length > 0}>
        <div className="pr-fails">
          <ul className="pr-fail-list">
            {shown.map((c, i) => (
              <li key={`${i}:${c.name}`}>
                {c.url ? (
                  <a className="pr-fail" href={c.url} target="_blank" rel="noreferrer" onPointerEnter={titleIfCut}>
                    {c.name}
                  </a>
                ) : (
                  <span className="pr-fail" onPointerEnter={titleIfCut}>
                    {c.name}
                  </span>
                )}
              </li>
            ))}
            {more > 0 && <li className="pr-fail-more">and {more} more</li>}
          </ul>
          {onSendFailures && (
            <button type="button" className="btn btn-sm pr-send" disabled={sending} onClick={onSendFailures}>
              {sending ? <Spinner size={12} /> : <Icon name="reply" size={13} />}
              Send failures to chat
            </button>
          )}
        </div>
      </Collapse>
    </div>
  );
}

/**
 * The pull request of the folder's branch at the head of the Changes tab: read while the tab shows
 * (pull-status.ts says when), drawn once there is one, gone without a word when there is none.
 */
export function PullRequestRow({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const status = useRepo(cwd)?.status;
  usePullWatch(cwd, status);
  const { pull, loading } = usePullRequest(cwd, status?.isRepo ? status.branch : undefined);
  const toast = useStore((s) => s.toast);
  const [sending, setSending] = useState(false);
  // While the row folds away it still shows the pull request it had.
  const last = useRef(pull);
  if (pull) last.current = pull;
  const drawn = pull ?? last.current;

  const send = async () => {
    if (!pull || sending) return;
    setSending(true);
    const res = await readPullFailures(cwd, pull.number, pull.head);
    setSending(false);
    if (!res?.text) {
      // The pull request moved on meanwhile (another head, the checks ran again): the row reads it again.
      void refreshPull(cwd);
      toast(res?.stale ? 'The pull request changed. Its checks are read again.' : 'The failed checks could not be read.');
      return;
    }
    // Into the chat's draft, after what is already typed there; the person reads it and sends.
    const st = useStore.getState();
    st.setDraft(sessionId, { text: withFailures(st.drafts[sessionId]?.text ?? '', res.text) });
    focusComposer();
  };

  return <Collapse open={!!pull}>{drawn && <PullRow pull={drawn} loading={loading} sending={sending} onRefresh={() => void refreshPull(cwd)} onSendFailures={() => void send()} />}</Collapse>;
}

/** Why a pull request cannot be made from this branch yet, in a sentence; null when it can. */
function blockedBy(ctx: GitPullContext): string | null {
  if (!ctx.isRepo) return 'This folder is not a git repository.';
  if (!ctx.branch) return 'This folder is on a detached HEAD. Check out a branch first.';
  if (ctx.branch === ctx.base) return `This is ${ctx.base}. Make a branch for the pull request first.`;
  if (!ctx.remote) return 'This repository has no remote named origin.';
  if ((ctx.commitCount ?? ctx.commits.length) === 0) return `${ctx.branch} has no commits that ${ctx.base} does not have yet. Commit first.`;
  return null;
}

/** The push and the pull request in plain words, with the commits that go listed. */
function Route({ ctx }: { ctx: GitPullContext }) {
  const urls = ctx.pushUrls ?? [];
  const count = ctx.commitCount ?? ctx.commits.length;
  const more = count - ctx.commits.length;
  const what = `${count} ${count === 1 ? 'commit' : 'commits'} on ${ctx.branch}${ctx.head ? ` (${ctx.head.slice(0, 7)})` : ''}`;
  const into = `then opens a pull request into ${ctx.base}${ctx.repo ? ` on ${ctx.repo}` : ''}.`;
  return (
    <div className="pr-route">
      {urls.length > 1 ? (
        <>
          <p>Pushes {what} to {urls.length} addresses:</p>
          <ul className="pr-urls">
            {urls.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
          <p>{into.charAt(0).toUpperCase() + into.slice(1)}</p>
        </>
      ) : (
        <p>
          Pushes {what} to {urls[0] ?? 'origin'}, {into}
        </p>
      )}
      <ol className="pr-commits scroll">
        {ctx.commits.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
        {more > 0 && <li className="pr-more">and {more} more</li>}
      </ol>
    </div>
  );
}

function PullRequestDialog({ cwd, onOpenChange }: { cwd: string; onOpenChange: (open: boolean) => void }) {
  const toast = useStore((s) => s.toast);
  const [ctx, setCtx] = useState<GitPullContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The existing pull request's address, when gh says one already exists for the branch.
  const [existing, setExisting] = useState<string | null>(null);
  const [made, setMade] = useState<{ url?: string; number?: number } | null>(null);

  // Read again when the branch, its commit or the push addresses changed under the dialog; what the
  // person wrote stays.
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let live = true;
    void pullContext(cwd).then((res) => {
      if (!live) return;
      if ('error' in res) {
        setLoadError(res.error);
        return;
      }
      setCtx(res);
      if (reads === 0) {
        setTitle(res.title);
        setBody(res.body);
      }
    });
    return () => {
      live = false;
    };
  }, [cwd, reads]);

  const close = () => {
    if (!busy) onOpenChange(false);
  };

  const submit = async () => {
    if (!ctx?.base || busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    setExisting(null);
    // The approval: exactly the branch, commit, addresses and repository shown.
    const res = await createPull(cwd, { title, body, base: ctx.base, draft, branch: ctx.branch, head: ctx.head, destination: ctx.destination, repo: ctx.repo });
    setBusy(false);
    if (res.ok) {
      setMade({ url: res.url, number: res.number });
      toast(res.number ? `Opened pull request #${res.number}` : 'Opened the pull request', 'success');
      // The tab's row shows it at once from what the dialog knows, then reads GitHub for the rest.
      const seed = createdPull({ branch: ctx.branch, head: ctx.head, number: res.number, url: res.url, title, draft });
      if (seed) pulls.created(cwd, seed);
      else void pulls.ask(cwd, { changed: true });
    } else {
      setError(res.error ?? 'The pull request could not be created.');
      setExisting(res.url ?? null);
      if (res.stale) setReads((n) => n + 1);
      // gh named a pull request that already exists for the branch: the row reads it.
      if (res.url) void pulls.ask(cwd, { changed: true });
    }
  };

  const blocked = ctx ? blockedBy(ctx) : null;
  const ready = ctx && !blocked && !made;

  let footer: ReactNode;
  if (made) {
    footer = (
      <>
        {made.url && (
          <a className="btn btn-primary" href={made.url} target="_blank" rel="noreferrer">
            Open on GitHub
          </a>
        )}
      </>
    );
  } else if (ready) {
    footer = (
      <>
        <button type="button" className="btn" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || !title.trim()}>
          {busy && <Spinner size={12} />}
          Create pull request
        </button>
      </>
    );
  } else {
    footer = (
      <button type="button" className="btn" onClick={close}>
        Close
      </button>
    );
  }

  return (
    <Modal open onOpenChange={(o) => !o && close()} title={made ? 'Pull request opened' : 'Create a pull request'} width={480} footer={footer}>
      {loadError ? (
        <p className="pr-note">{loadError}</p>
      ) : !ctx ? (
        <div className="rail-loading">
          <Spinner />
          Reading the branch
        </div>
      ) : blocked ? (
        <p className="pr-note">{blocked}</p>
      ) : made ? (
        <p className="pr-note">
          Pull request{made.number ? ` #${made.number}` : ''} from {ctx.branch} into {ctx.base} is open.
        </p>
      ) : (
        <div className="pr-form">
          <label className="pr-label">
            Title
            <input className="field" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} disabled={busy} />
          </label>
          <label className="pr-label">
            Description
            <textarea className="field pr-body scroll" rows={6} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />
          </label>
          {/* What the click does, before it is done: the commits, every address they go to, and where the pull request opens. */}
          <Route ctx={ctx} />
          <label className="pr-draft">
            <span>Open as a draft</span>
            <Switch checked={draft} onChange={setDraft} label="Open as a draft" disabled={busy} />
          </label>
          {error && (
            <p className="ch-commit-error" role="alert">
              <Icon name="warning" size={13} />
              <span>
                {error}
                {existing && (
                  <>
                    {' '}
                    <a href={existing} target="_blank" rel="noreferrer" className="pr-link">
                      Open it
                    </a>
                  </>
                )}
              </span>
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
