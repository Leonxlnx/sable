import { useEffect, useState, type ReactNode } from 'react';
import type { GitPullContext } from '@shared/protocol';
import { Icon } from '@/icons';
import { useStore } from '@/state/store';
import { Modal, Spinner, Switch } from '@/ui';
import { createPull, pullContext } from './git-state';
import './pull-request.css';

/** The clean working tree's next step: a pull request for the branch, opened from here. */
export function PullRequestAction({ cwd }: { cwd: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pr-action">
      <button type="button" className="btn btn-sm pr-open" onClick={() => setOpen(true)}>
        <Icon name="pull-request" size={14} />
        Create pull request
      </button>
      {open && <PullRequestDialog cwd={cwd} onOpenChange={setOpen} />}
    </div>
  );
}

/** Why a pull request cannot be made from this branch yet, in a sentence; null when it can. */
function blockedBy(ctx: GitPullContext): string | null {
  if (!ctx.isRepo) return 'This folder is not a git repository.';
  if (!ctx.branch) return 'This folder is on a detached HEAD. Check out a branch first.';
  if (ctx.branch === ctx.base) return `This is ${ctx.base}. Make a branch for the pull request first.`;
  if (!ctx.remote) return 'This repository has no remote named origin.';
  if (ctx.commits.length === 0) return `${ctx.branch} has no commits that ${ctx.base} does not have yet. Commit first.`;
  return null;
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

  useEffect(() => {
    let live = true;
    void pullContext(cwd).then((res) => {
      if (!live) return;
      if ('error' in res) {
        setLoadError(res.error);
        return;
      }
      setCtx(res);
      setTitle(res.title);
      setBody(res.body);
    });
    return () => {
      live = false;
    };
  }, [cwd]);

  const close = () => {
    if (!busy) onOpenChange(false);
  };

  const submit = async () => {
    if (!ctx?.base || busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    setExisting(null);
    const res = await createPull(cwd, { title, body, base: ctx.base, draft });
    setBusy(false);
    if (res.ok) {
      setMade({ url: res.url, number: res.number });
      toast(res.number ? `Opened pull request #${res.number}` : 'Opened the pull request', 'success');
    } else {
      setError(res.error ?? 'The pull request could not be created.');
      setExisting(res.url ?? null);
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
          <p className="pr-route">
            {ctx.branch} into {ctx.base}
          </p>
          <Switch checked={draft} onChange={setDraft} label="Draft" disabled={busy} />
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
