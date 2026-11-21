import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { DEFAULT_ACCOUNT, type AccountInfo, type ProviderId, type RateLimit } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME, Ring } from '@/art/Logo';
import { CopyButton } from '@/components/CopyButton';
import { Icon } from '@/icons';
import { resetIn } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { tildePath } from '@/lib/format';
import { openAddAccount } from '@/features/accounts/model';
import { LoginCode } from './LoginCode';
import { cancelLogin, login, logout, moveAccount, openSettings, refreshLimits, refreshProvider, removeAccount, renameAccount, setDefaultAccount } from '@/state/actions';
import { useAccounts } from '@/state/hooks';
import { accountKey, useStore, type AuthFlow } from '@/state/store';
import { cx, IconButton, Menu, MenuContent, MenuItem, MenuSep, MenuTrigger, Spinner } from '@/ui';
import { INSTALL, connectableAgents, isSignedIn, planLabel } from './plan';
import './connect.css';

export { planLabel } from './plan';

const ease = [0.16, 1, 0.3, 1] as const;
const ROLL = { type: 'spring', stiffness: 560, damping: 42, mass: 0.8 } as const;

type RowPhase = 'loading' | 'missing' | 'started' | 'url' | 'error' | 'success' | 'leaving' | 'in' | 'out';
type Confirm = 'out' | 'remove' | null;

/**
 * One agent and the subscription it is connected with. A single account reads as one row
 * (mark, agent and plan, the email quietly under it, actions at the end); several accounts get a
 * header and one row each. `compact` (the welcome) leaves out limits, the account menu and adding.
 */
export function ConnectCard({ provider, primary = false, compact = false }: { provider: ProviderId; primary?: boolean; compact?: boolean }) {
  const info = useStore((s) => s.providers[provider]);
  const listed = useAccounts(provider);
  const name = PROVIDER_NAME[provider];

  // Older bridges send no account list: the provider's own sign-in is its one account.
  const accounts: AccountInfo[] = listed.length || !info ? listed : [{ id: DEFAULT_ACCOUNT, provider, label: 'Main', isDefault: true, auth: info.auth }];
  const multi = accounts.length > 1;
  const firstOut = primary ? accounts.find((a) => !a.auth.loggedIn)?.id : undefined;

  const mark = <ProviderMark provider={provider} size={compact ? 22 : 24} className="cc-mark" />;

  return (
    <article className="cc" data-provider={provider} data-compact={compact || undefined} data-multi={multi || undefined} data-spot={compact ? undefined : ''} aria-label={name}>

      {!info || !info.installed ? (
        <AgentState provider={provider} mark={mark} phase={!info ? 'loading' : 'missing'} />
      ) : multi ? (
        <>
          <header className="cc-head">
            {mark}
            <span className="cc-name">{name}</span>
          </header>
          <ul className="acc-list" aria-label={`${name} accounts`}>
            <AnimatePresence initial={false}>
              {accounts.map((a, i) => (
                <motion.li key={a.id} layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }} transition={{ duration: 0.24, ease }}>
                  <AccountRow provider={provider} account={a} multi primary={a.id === firstOut} compact={compact} canUp={i > 0} canDown={i < accounts.length - 1} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </>
      ) : (
        accounts[0] && <AccountRow provider={provider} account={accounts[0]} multi={false} primary={accounts[0].id === firstOut} compact={compact} mark={mark} heading={name} />
      )}

      {!compact && info?.installed && provider !== 'opencode' && (
        <button type="button" className="acc-add" onClick={() => openAddAccount(provider)}>
          <Icon name="plus" size={14} />
          Add account
        </button>
      )}
    </article>
  );
}

/** The agent itself is not ready: still looking for its CLI, or it is not installed. */
function AgentState({ provider, mark, phase }: { provider: ProviderId; mark: ReactNode; phase: 'loading' | 'missing' }) {
  const [checking, setChecking] = useState(false);
  const name = PROVIDER_NAME[provider];
  const cmd = INSTALL[provider];
  return (
    <div className="acc" data-phase={phase}>
      <div className="acc-line">
        {mark}
        <span className="acc-id">
          <span className="acc-top">
            <span className="acc-agent">{name}</span>
          </span>
          <Roll k={phase} className="acc-sub">
            {phase === 'loading' ? 'Looking for it on this computer' : 'Not installed on this computer'}
          </Roll>
        </span>
        <Roll k={phase} className="acc-actions" right>
          {phase === 'loading' ? (
            <Spinner size={14} />
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              disabled={checking}
              onClick={() => {
                setChecking(true);
                void refreshProvider(provider).finally(() => setChecking(false));
              }}
            >
              {checking ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}
              Check again
            </button>
          )}
        </Roll>
      </div>
      <AutoHeight>
        {phase === 'missing' && cmd && (
          <div className="acc-install">
            <span className="acc-install-label">Install it, then check again</span>
            <div className="acc-cmd well">
              <code className="truncate">{cmd}</code>
              <CopyButton text={cmd} label="Copy install command" />
            </div>
          </div>
        )}
      </AutoHeight>
    </div>
  );
}

/** One account: the plan it is on, its sign-in flow, and its actions right on the row. */
function AccountRow({
  provider,
  account,
  multi,
  primary,
  compact,
  mark,
  heading,
  canUp = false,
  canDown = false,
}: {
  provider: ProviderId;
  account: AccountInfo;
  multi: boolean;
  primary: boolean;
  compact: boolean;
  mark?: ReactNode;
  heading?: string;
  /** Its place in the agent's list can move up or down (the order every account list uses). */
  canUp?: boolean;
  canDown?: boolean;
}) {
  const key = accountKey(provider, account.id);
  const flow = useStore((s) => s.auth[key]);
  const limits = useStore((s) => s.limits[key]) ?? account.limits;
  const accountId = account.id === DEFAULT_ACCOUNT ? undefined : account.id;
  const own = account.id === DEFAULT_ACCOUNT;
  const home = useStore((s) => s.home);
  const row = useRef<HTMLDivElement>(null);

  const [confirm, setConfirm] = useState<Confirm>(null);
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState<'out' | 'remove' | 'refresh' | 'in' | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const [dismissed, setDismissed] = useState<AuthFlow | undefined>(undefined);
  const cancelledAt = useRef(0);
  const seenFlow = useRef(flow);

  // React to flow transitions while the row is on screen; a flow that ended before it mounted is history.
  useEffect(() => {
    if (flow === seenFlow.current) return;
    seenFlow.current = flow;
    if (flow?.state !== 'started') setBusy((b) => (b === 'in' ? null : b));
    if (flow?.state === 'done') {
      setCelebrate(true);
      // A soft swell of light from the row, where the backdrop has one.
      const r = row.current?.getBoundingClientRect();
      if (r) window.dispatchEvent(new CustomEvent('sable:pulse', { detail: { x: r.left + 24, y: r.top + r.height / 2, strength: 0.6 } }));
      const t = window.setTimeout(() => setCelebrate(false), 1800);
      return () => window.clearTimeout(t);
    }
    // Cancelling kills the CLI, which the bridge may also report as a failure: not an error to the user.
    if (flow?.state === 'error' && Date.now() - cancelledAt.current < 8000) setDismissed(flow);
  }, [flow]);

  const signedIn = account.auth.loggedIn;
  const live = flow && flow !== dismissed && (flow.state === 'started' || flow.state === 'url' || flow.state === 'error' || flow.state === 'timeout') ? flow : undefined;
  let phase: RowPhase;
  if (live) phase = live.state === 'timeout' ? 'error' : (live.state as RowPhase);
  else if (celebrate) phase = 'success';
  else if (busy === 'in') phase = 'started';
  else phase = signedIn ? 'in' : 'out';

  useEffect(() => {
    if (phase !== 'in' && phase !== 'out') setConfirm(null);
  }, [phase]);

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await fn();
    } finally {
      setBusy((b) => (b === kind ? null : b));
    }
  };

  const signIn = () => {
    setDismissed(flow);
    setConfirm(null);
    setBusy('in');
    void login(provider, accountId).finally(() => setBusy((b) => (b === 'in' ? null : b)));
  };
  const cancel = () => {
    cancelledAt.current = Date.now();
    setBusy(null);
    void cancelLogin(provider, accountId);
  };

  const plan = planLabel(account.auth);
  const email = signedIn ? account.auth.email : undefined;
  const showLimits = !compact && signedIn && !!limits?.length && phase === 'in' && !confirm;
  const folder = account.dir ? tildePath(account.dir, home) : '';

  const sub: { key: string; text: ReactNode; tone?: 'error' | 'quiet' } = confirm
    ? {
        key: `confirm-${confirm}`,
        // Say exactly what goes: Sable's own folder for the account, or nothing at all for a folder the user brought.
        text: confirm === 'remove' ? (account.external ? `Forget this account? ${folder} stays as it is.` : `Delete ${folder || 'its folder'}? Its sessions stay readable.`) : 'Sign out of this account?',
      }
    : phase === 'started'
      ? { key: 'started', text: <><Ring size={11} label={null} />Opening the sign-in page</> }
      : phase === 'url'
        ? { key: 'url', text: <><Ring size={11} label={null} />Finish in your browser</> }
        : phase === 'leaving'
          ? { key: 'leaving', text: <><Spinner size={11} />Signing out</> }
          : phase === 'error'
            ? { key: `error-${live?.state}-${live?.message ?? ''}`, text: live?.state === 'timeout' ? 'Sign-in timed out' : live?.message || 'Sign-in did not finish', tone: 'error' }
            : phase === 'success'
              ? { key: 'success', text: <><DrawnCheck />Signed in</> }
              : phase === 'in'
                ? { key: `in-${email ?? ''}`, text: email ?? account.auth.org ?? 'Signed in', tone: 'quiet' }
                : { key: 'out', text: account.problem ?? 'Not signed in' };

  const actionsKey = confirm ? `c-${confirm}` : phase === 'url' && live?.url ? 'url-link' : phase;

  return (
    <div
      ref={row}
      className="acc"
      data-phase={phase}
      data-confirm={confirm || undefined}
      data-escape-scope={confirm ? '' : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && confirm) {
          e.stopPropagation();
          setConfirm(null);
        }
      }}
    >
      <div className="acc-line">
        {mark}
        <span className="acc-id">
          {renaming ? (
            <RenameField
              initial={account.label}
              onDone={(next) => {
                setRenaming(false);
                if (next && next !== account.label) void renameAccount(provider, account.id, next);
              }}
            />
          ) : (
            <span className="acc-top">
              {heading && <span className="acc-agent">{heading}</span>}
              {multi && (
                <button type="button" className="acc-label truncate" aria-label={`${account.label}. Rename`} onClick={() => setRenaming(true)} disabled={compact}>
                  {account.label}
                </button>
              )}
              <Roll k={plan ?? '-'} className={cx('acc-plan', !plan && 'acc-plan-none')}>
                {plan ?? ''}
              </Roll>
              {multi && account.isDefault && <span className="acc-default">Default</span>}
            </span>
          )}
          {!renaming && (
            <Roll k={sub.key} className={cx('acc-sub', sub.tone === 'error' && 'acc-error')} title={typeof sub.text === 'string' ? sub.text : undefined}>
              {sub.text}
            </Roll>
          )}
        </span>

        {!renaming && (
          <Roll k={actionsKey} className="acc-actions" right>
            {confirm ? (
              <>
                <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={() => setConfirm(null)}>
                  Cancel
                </button>
                {confirm === 'remove' ? (
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy === 'remove'} onClick={() => void run('remove', async () => (await removeAccount(provider, account.id)) || setConfirm(null))}>
                    {busy === 'remove' ? <Spinner size={12} /> : <Icon name="trash" size={14} />}
                    {account.external ? 'Forget' : 'Remove'}
                  </button>
                ) : (
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy === 'out'} onClick={() => void run('out', () => logout(provider, accountId)).then(() => setConfirm(null))}>
                    {busy === 'out' ? <Spinner size={12} /> : <Icon name="sign-out" size={14} />}
                    Sign out
                  </button>
                )}
              </>
            ) : phase === 'in' ? (
              <>
                {/* OpenCode signs in to as many model providers as the person adds. */}
                {provider === 'opencode' && (
                  <button type="button" className="btn btn-sm btn-ghost acc-quiet" onClick={signIn}>
                    Sign in
                  </button>
                )}
                <button type="button" className="btn btn-sm btn-ghost acc-quiet" onClick={() => setConfirm('out')}>
                  Sign out
                </button>
              </>
            ) : phase === 'out' ? (
              <button type="button" className={cx('btn btn-sm', primary && 'btn-primary')} onClick={signIn}>
                <Icon name="sign-in" size={14} />
                Sign in
              </button>
            ) : phase === 'started' || phase === 'url' ? (
              <>
                <button type="button" className="btn btn-sm btn-ghost" onClick={cancel}>
                  Cancel
                </button>
                {phase === 'url' && live?.url && (
                  <>
                    <CopyButton text={live.codeUrl ?? live.url} label="Copy sign-in link" />
                    <button type="button" className="btn btn-sm" onClick={() => window.open(live.url, '_blank', 'noopener')}>
                      <Icon name="external" size={14} />
                      Open sign-in page
                    </button>
                  </>
                )}
              </>
            ) : phase === 'error' ? (
              <>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDismissed(flow)}>
                  Dismiss
                </button>
                <button type="button" className="btn btn-sm" onClick={signIn}>
                  <Icon name="refresh" size={14} />
                  Try again
                </button>
              </>
            ) : null}
          </Roll>
        )}

        {!compact && !renaming && !confirm && (phase === 'in' || phase === 'out') && (
          <Menu>
            <MenuTrigger asChild>
              <IconButton icon="dots" label={`More for ${heading ?? account.label}`} size={16} className={cx('acc-more', busy === 'refresh' && 'cc-spin')} />
            </MenuTrigger>
            <MenuContent align="end" width={200}>
              {signedIn && (
                <MenuItem icon="refresh" onSelect={() => void run('refresh', () => Promise.all([refreshProvider(provider, accountId), refreshLimits(provider, accountId)]))}>
                  Refresh
                </MenuItem>
              )}
              {provider !== 'opencode' && (
                <MenuItem icon="pencil" onSelect={() => setRenaming(true)}>
                  Rename
                </MenuItem>
              )}
              {multi && !account.isDefault && (
                <MenuItem icon="star" onSelect={() => void setDefaultAccount(provider, account.id)}>
                  Make default
                </MenuItem>
              )}
              {canUp && (
                <MenuItem icon="arrow-up" onSelect={() => void moveAccount(provider, account.id, -1)}>
                  Move up
                </MenuItem>
              )}
              {canDown && (
                <MenuItem icon="arrow-down" onSelect={() => void moveAccount(provider, account.id, 1)}>
                  Move down
                </MenuItem>
              )}
              {!own && (
                <>
                  <MenuSep />
                  <MenuItem icon="trash" tone="danger" onSelect={() => setConfirm('remove')}>
                    {account.external ? 'Forget' : 'Remove'}
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        )}
      </div>

      <AutoHeight>{showLimits && <MiniLimits limits={limits!} />}</AutoHeight>
      {/* The browser may show a code to paste instead of returning to Sable. */}
      <AutoHeight>{phase === 'url' && live?.codeUrl && <LoginCode provider={provider} accountId={accountId} codeUrl={live.codeUrl} />}</AutoHeight>
    </div>
  );
}

/**
 * A value that rolls like an odometer when it changes: the old one slides up and out of a clipped
 * line, the new one rises in from below. `right` keeps a leaving value anchored to the right edge.
 */
export function Roll({ k, children, className, right, title }: { k: string; children: ReactNode; className?: string; right?: boolean; title?: string }) {
  const reduce = useReducedMotion();
  return (
    <span className={cx('roll', className)} title={title}>
      <AnimatePresence initial={false} mode="popLayout" anchorX={right ? 'right' : 'left'}>
        <motion.span
          key={k}
          className="roll-item"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: '70%' }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0.08 } } : { opacity: 0, y: '-70%', transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
          transition={reduce ? { duration: 0.12 } : ROLL}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** A check that draws itself once. */
export function DrawnCheck() {
  return (
    <svg className="drawn-check" viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <circle cx="8" cy="8" r="7" />
      <path d="M4.8 8.3l2.2 2.1 4.3-4.6" />
    </svg>
  );
}

function RenameField({ initial, onDone }: { initial: string; onDone: (label: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (label: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(label);
  };
  return (
    <input
      className="field acc-rename"
      value={value}
      autoFocus
      maxLength={60}
      aria-label="Account name"
      data-escape-scope
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value.trim() || null);
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

/** An account's plan limits as thin tracks on one quiet line. */
function MiniLimits({ limits }: { limits: RateLimit[] }) {
  const now = useNow();
  return (
    <div className="acc-limits" aria-label="Plan limits">
      {limits.map((l) => {
        const pct = Math.max(0, Math.min(100, l.percent));
        const level = pct > 95 ? 'red' : pct > 80 ? 'amber' : undefined;
        const reset = resetIn(l.resetsAt, now);
        return (
          <span key={l.id} className="acc-limit" data-level={level} title={reset ? `${l.label}: resets in ${reset}` : l.label}>
            <span className="acc-limit-label truncate">{l.label}</span>
            <span className="cc-limit-track meter" data-level={level}>
              <span className="meter-fill" style={{ '--p': pct / 100 } as CSSProperties} />
            </span>
            <span className="cc-limit-pct num">{Math.round(pct)}%</span>
          </span>
        );
      })}
    </div>
  );
}

/** Animates its height to fit its content, so state changes inside a card glide instead of jumping. */
export function AutoHeight({ children, className }: { children: ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div className={className} style={{ overflow: 'hidden' }} initial={false} animate={{ height }} transition={{ type: 'spring', stiffness: 420, damping: 40 }}>
      {/* flow-root keeps children's margins inside, so the measured height is the real one. */}
      <div ref={inner} style={{ display: 'flow-root' }}>
        {children}
      </div>
    </motion.div>
  );
}

/** A slim call to action for the home screen while no agent is signed in. */
export function ConnectBanner() {
  const ready = useStore((s) => s.ready);
  const signedIn = useStore((s) => connectableAgents(s.providers).some((id) => isSignedIn(s.providers[id])));
  if (!ready || signedIn) return null;
  return (
    <motion.div className="connect-banner" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.18, ease }}>
      <span className="cb-marks" aria-hidden>
        <ProviderMark provider="claude" size={16} />
        <ProviderMark provider="codex" size={16} />
      </span>
      <p className="cb-text">Sign in to Claude Code or Codex to start working.</p>
      <button type="button" className="btn btn-sm" onClick={() => openSettings('accounts')}>
        Connect
        <Icon name="arrow-right" size={13} />
      </button>
    </motion.div>
  );
}
