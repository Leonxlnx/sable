import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountFolder, ProviderId } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME, Ring } from '@/art/Logo';
import { CopyButton } from '@/components/CopyButton';
import { AutoHeight, DrawnCheck, Roll } from '@/features/connect/Connect';
import { LoginCode } from '@/features/connect/LoginCode';
import { Icon, type IconName } from '@/icons';
import { desktop, hasNativeFolderPicker } from '@/lib/desktop';
import { tildePath } from '@/lib/format';
import { accountFolders, addAccount, addExistingAccount, cancelLogin, login, removeAccount, renameAccount } from '@/state/actions';
import { accountKey, useStore } from '@/state/store';
import { Modal, PathLabel, Segmented, Spinner, cx } from '@/ui';
import { accountAgents, closeAddAccount, planWord, useAddAccount } from './model';

type Step = { kind: 'choose' } | { kind: 'existing' } | { kind: 'signin'; accountId: string; made: boolean } | { kind: 'ready'; accountId: string };

/**
 * Adding an account in a few clicks, without a terminal: the agent's own browser sign-in for a
 * fresh profile, or a config folder the user already keeps. Every state of the sign-in is shown as
 * it is; a sign-in that never finished leaves nothing behind.
 */
export function AddAccountDialog() {
  const open = useAddAccount((s) => s.open);
  const wanted = useAddAccount((s) => s.provider);
  const startExisting = useAddAccount((s) => s.existing);
  const agents = useStore((s) => accountAgents(s.providers).join(','));
  const list = agents ? (agents.split(',') as ProviderId[]) : [];
  const [provider, setProvider] = useState<ProviderId>('claude');
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const stepRef = useRef(step);
  stepRef.current = step;

  // A fresh start every time it opens.
  useEffect(() => {
    if (!open) return;
    setProvider(wanted ?? list[0] ?? 'claude');
    setStep(startExisting ? { kind: 'existing' } : { kind: 'choose' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    const s = stepRef.current;
    // A sign-in that did not finish: stop it, and an account made for it goes again.
    if (s.kind === 'signin') {
      const st = useStore.getState();
      const signedIn = st.providers[provider]?.accounts?.find((a) => a.id === s.accountId)?.auth.loggedIn;
      const flow = st.auth[accountKey(provider, s.accountId)];
      if (!signedIn) {
        if (flow?.state === 'started' || flow?.state === 'url') void cancelLogin(provider, s.accountId);
        if (s.made) void removeAccount(provider, s.accountId);
      }
    }
    closeAddAccount();
  };

  const name = PROVIDER_NAME[provider];
  const choosing = step.kind === 'choose' && !wanted && list.length > 1;

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title={`Add a ${name} account`} bare className="aa" width={440}>
      <div className="aa-head">
        <ProviderMark provider={provider} size={20} />
        <h2 className="aa-title">{choosing ? 'Add an account' : `Add a ${name} account`}</h2>
        <button type="button" className="icon-btn aa-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={15} />
        </button>
      </div>
      <AutoHeight>
        <div className="aa-body">
          {step.kind === 'choose' && (
            <>
              {choosing && (
                <Segmented id="aa-agent" value={provider} onChange={setProvider} options={list.map((id) => ({ value: id, label: PROVIDER_NAME[id] }))} className="aa-seg" />
              )}
              <div className="aa-options">
                <Option
                  icon="sign-in"
                  autoFocus
                  onClick={async () => {
                    const account = await addAccount(provider);
                    if (!account) return;
                    setStep({ kind: 'signin', accountId: account.id, made: true });
                    void login(provider, account.id);
                  }}
                >
                  Sign in with the browser
                </Option>
                <Option icon="folder-open" onClick={() => setStep({ kind: 'existing' })}>
                  Use an existing folder
                </Option>
              </div>
            </>
          )}
          {step.kind === 'existing' && <ExistingFolder provider={provider} onBack={() => setStep({ kind: 'choose' })} onAdded={(id) => setStep({ kind: 'ready', accountId: id })} />}
          {step.kind === 'signin' && (
            <SignIn
              provider={provider}
              accountId={step.accountId}
              onRetry={() => void login(provider, step.accountId)}
              onCancel={close}
              onDone={() => setStep({ kind: 'ready', accountId: step.accountId })}
            />
          )}
          {step.kind === 'ready' && <Ready provider={provider} accountId={step.accountId} onSignIn={() => (setStep({ kind: 'signin', accountId: step.accountId, made: false }), void login(provider, step.accountId))} onDone={closeAddAccount} />}
        </div>
      </AutoHeight>
    </Modal>
  );
}

function Option({ icon, children, onClick, autoFocus }: { icon: IconName; children: ReactNode; onClick: () => void | Promise<void>; autoFocus?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="aa-option"
      autoFocus={autoFocus}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name={icon} size={17} className="aa-option-icon" />
      <span className="grow">{children}</span>
      {busy ? <Spinner size={13} /> : <Icon name="caret-right" size={12} className="aa-option-caret" />}
    </button>
  );
}

type Phase = 'opening' | 'waiting' | 'done' | 'error' | 'cancelled' | 'timeout';

/** The agent's sign-in, in the user's browser, with every state it can be in. */
function SignIn({ provider, accountId, onRetry, onCancel, onDone }: { provider: ProviderId; accountId: string; onRetry: () => void; onCancel: () => void; onDone: () => void }) {
  const flow = useStore((s) => s.auth[accountKey(provider, accountId)]);
  const signedIn = useStore((s) => !!s.providers[provider]?.accounts?.find((a) => a.id === accountId)?.auth.loggedIn);
  const phase: Phase = signedIn || flow?.state === 'done' ? 'done' : flow?.state === 'url' ? 'waiting' : flow?.state === 'error' ? 'error' : flow?.state === 'cancelled' ? 'cancelled' : flow?.state === 'timeout' ? 'timeout' : 'opening';

  // A moment on the check, then the account to name.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (phase !== 'done') return;
    const t = window.setTimeout(() => done.current(), 900);
    return () => window.clearTimeout(t);
  }, [phase]);

  const status: Record<Phase, ReactNode> = {
    opening: (
      <>
        <Ring size={12} label={null} />
        Opening the sign-in page
      </>
    ),
    waiting: (
      <>
        <Ring size={12} label={null} />
        Waiting for the browser
      </>
    ),
    done: (
      <>
        <DrawnCheck />
        Signed in
      </>
    ),
    error: 'Sign-in failed',
    cancelled: 'Sign-in cancelled',
    timeout: 'Sign-in timed out',
  };
  const ended = phase === 'error' || phase === 'cancelled' || phase === 'timeout';

  return (
    <div className="aa-flow" data-phase={phase} role="status" aria-live="polite">
      <Roll k={phase} className="aa-status">
        {status[phase]}
      </Roll>
      <p className="aa-note">
        {phase === 'error'
          ? flow?.message || 'The agent did not say why.'
          : phase === 'timeout'
            ? 'Nothing came back from the browser for ten minutes.'
            : phase === 'cancelled'
              ? 'Nothing was changed.'
              : phase === 'done'
                ? ' '
                : 'Finish signing in on the page that opened.'}
      </p>
      <div className="aa-actions">
        {phase === 'waiting' && flow?.url && (
          <>
            <CopyButton text={flow.codeUrl ?? flow.url} label="Copy sign-in link" />
            <button type="button" className="btn btn-sm" autoFocus onClick={() => window.open(flow.url, '_blank', 'noopener')}>
              <Icon name="external" size={14} />
              Open sign-in page
            </button>
          </>
        )}
        <span className="grow" />
        {phase !== 'done' && (
          <button type="button" className="btn btn-sm btn-ghost" autoFocus={phase === 'opening'} onClick={onCancel}>
            Cancel
          </button>
        )}
        {ended && (
          <button type="button" className="btn btn-sm btn-primary" autoFocus onClick={onRetry}>
            <Icon name="refresh" size={14} />
            Try again
          </button>
        )}
      </div>
      {/* The browser may show a code to paste instead of returning to Sable. */}
      <AutoHeight>{phase === 'waiting' && flow?.codeUrl && <LoginCode provider={provider} accountId={accountId} codeUrl={flow.codeUrl} />}</AutoHeight>
    </div>
  );
}

/** The account is there: its plan, its name (editable in place) and Done. */
function Ready({ provider, accountId, onSignIn, onDone }: { provider: ProviderId; accountId: string; onSignIn: () => void; onDone: () => void }) {
  const account = useStore((s) => s.providers[provider]?.accounts?.find((a) => a.id === accountId));
  const home = useStore((s) => s.home);
  const [label, setLabel] = useState(account?.label ?? '');
  const touched = useRef(false);
  // The bridge names a new account after its sign-in a moment later: follow until the user types.
  useEffect(() => {
    if (!touched.current && account?.label) setLabel(account.label);
  }, [account?.label]);
  if (!account) return <p className="aa-note">This account was removed.</p>;
  const plan = planWord(account);
  const finish = () => {
    const next = label.trim();
    if (next && next !== account.label) void renameAccount(provider, accountId, next);
    onDone();
  };
  return (
    <form
      className="aa-ready"
      onSubmit={(e) => {
        e.preventDefault();
        if (account.auth.loggedIn) finish();
      }}
    >
      <div className="aa-ready-line">
        {account.auth.loggedIn ? <Icon name="check-circle" size={16} className="aa-ready-icon" /> : <Icon name="circle-dashed" size={16} className="aa-ready-icon" />}
        <span className="aa-ready-state">{account.auth.loggedIn ? 'Signed in' : 'Not signed in'}</span>
        {plan && account.auth.loggedIn && <span className="aa-ready-plan">{plan} plan</span>}
        {account.external && <PathLabel fit path={tildePath(account.dir ?? '', home)} className="aa-ready-dir" />}
      </div>
      <label className="aa-field">
        <span className="aa-field-label">Name</span>
        <input
          className="field"
          value={label}
          maxLength={60}
          autoFocus={account.auth.loggedIn}
          aria-label="Account name"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            touched.current = true;
            setLabel(e.target.value);
          }}
        />
      </label>
      <div className="aa-actions">
        <span className="grow" />
        {account.auth.loggedIn ? (
          <button type="submit" className="btn btn-sm btn-primary">
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-sm btn-ghost" onClick={finish}>
              Later
            </button>
            <button type="button" className="btn btn-sm btn-primary" autoFocus onClick={onSignIn}>
              <Icon name="sign-in" size={14} />
              Sign in
            </button>
          </>
        )}
      </div>
    </form>
  );
}

/** Folders the user already keeps for this agent, or one picked by hand. Nothing is copied. */
function ExistingFolder({ provider, onBack, onAdded }: { provider: ProviderId; onBack: () => void; onAdded: (accountId: string) => void }) {
  const home = useStore((s) => s.home);
  const [folders, setFolders] = useState<AccountFolder[] | null>(null);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void accountFolders(provider).then((f) => live && setFolders(f));
    return () => {
      live = false;
    };
  }, [provider]);

  const add = async (dir: string) => {
    setBusy(dir);
    try {
      const account = await addExistingAccount(provider, dir);
      if (account) onAdded(account.id);
    } finally {
      setBusy(null);
    }
  };

  const choose = async () => {
    if (!hasNativeFolderPicker) return setTyping(true);
    const dir = await desktop!.pickFolder!(home).catch(() => null);
    if (dir) await add(dir);
  };

  return (
    <div className="aa-existing">
      <div className="aa-options">
        {folders === null ? (
          <div className="aa-option aa-skel" aria-hidden>
            <span className="skel" style={{ width: 160, height: 10 }} />
          </div>
        ) : (
          folders.map((f) => (
            <button key={f.dir} type="button" className="aa-option" disabled={!!busy} onClick={() => void add(f.dir)}>
              <Icon name="folder" size={17} className="aa-option-icon" />
              <span className="aa-folder grow">
                <span className="aa-folder-name">{f.name}</span>
                <PathLabel fit path={tildePath(f.dir, home)} className="aa-folder-path" />
              </span>
              {busy === f.dir ? <Spinner size={13} /> : <Icon name="plus" size={13} className="aa-option-caret" />}
            </button>
          ))
        )}
        {typing ? (
          <form
            className="aa-path"
            onSubmit={(e) => {
              e.preventDefault();
              if (path.trim()) void add(path.trim());
            }}
          >
            <input className="field" autoFocus placeholder={provider === 'codex' ? '~/.codex-work' : '~/.claude-work'} value={path} onChange={(e) => setPath(e.target.value)} aria-label="Folder path" />
            <button type="submit" className="btn btn-sm" disabled={!path.trim() || !!busy}>
              {busy ? <Spinner size={12} /> : 'Add'}
            </button>
          </form>
        ) : (
          <button type="button" className={cx('aa-option')} autoFocus={folders !== null && !folders.length} onClick={() => void choose()}>
            <Icon name="folder-open" size={17} className="aa-option-icon" />
            <span className="grow">Choose a folder…</span>
          </button>
        )}
      </div>
      <div className="aa-actions">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onBack}>
          <Icon name="caret-left" size={12} />
          Back
        </button>
      </div>
    </div>
  );
}
