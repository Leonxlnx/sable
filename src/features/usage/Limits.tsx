import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { DEFAULT_ACCOUNT, type AccountInfo, type LimitPace, type LimitsReport, type ProviderId, type ProviderInfo, type RateLimit } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { useNow } from '@/lib/useNow';
import { openSettings, readLimitsNow, refreshLimits, setSettings } from '@/state/actions';
import { accountName, useLimitsReport } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';
import { cx, IconButton, Switch, Tip } from '@/ui';
import { clock, duration, exactTime, isApiKey, NUMBER_LOCALE, orderWindows, STALE_MS, windowLevel, windowNote } from './format';
import { LimitsOverview, LimitsTotals } from './Overview';
import { planShort } from './plans';
import { planBeside } from '@/features/connect/plan';
import { resetsText, usedPercent, usedText } from './words';
import { fullTarget, LimitReset, resetTarget } from './LimitReset';
import { useResetInAgent } from './ResetInAgent';
import { useLimitsTicker } from './ticker';
import './usage.css';

/** From this many accounts on, the Usage page lists them as an overview instead of one block each. */
const OVERVIEW_FROM = 3;

/** Figures older than this are read for real while the Usage view stays open. */
const AGED_MS = 10 * 60_000;

/**
 * One plan-limit window as a line: its name, a thin meter with the percent used, the time to its
 * reset, and where the pace leads on a quiet line under the meter. On the Usage page it sits in the
 * page's columns; in a compact list (`WindowList compact`: popovers, the side panel) the same line
 * puts its name above the meter and keeps the figures in their two columns.
 */
export const WindowLine = memo(function WindowLine({ limit, pace, now }: { limit: RateLimit; pace?: LimitPace; now: number }) {
  const past = !!limit.resetsAt && limit.resetsAt <= now;
  const pct = usedPercent(limit, now);
  const level = windowLevel(limit, now);
  const note = windowNote(limit, pace, now);
  return (
    <div className="ulw" data-level={level} data-past={past || undefined}>
      <span className="ulw-label truncate">{limit.label}</span>
      <span className="ulw-bar">
        <span className="meter ulw-meter" data-level={level} role="progressbar" aria-label={limit.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={usedText(pct)}>
          <span className="meter-fill" style={{ '--p': Math.max(pct, pct > 0 ? 1.5 : 0) / 100 } as CSSProperties} />
        </span>
        <span className="ulw-pct num">{pct}%</span>
      </span>
      <ResetCell at={limit.resetsAt} now={now} />
      {note && (
        <span className="ulw-note" data-warn={note.warn || undefined}>
          {note.warn && <span className="ul-pace-mark" aria-hidden />}
          {note.text}
        </span>
      )}
    </div>
  );
});

/**
 * Every window of one account as lines, in the usual order, with a reset under the window it
 * applies to and extra usage or credits last. `compact` for narrow places (popovers, the side
 * panel); `head` goes first, in the same columns ("Resets in" over the times).
 */
export function WindowList({ provider, accountId, report, limits, now, compact, head, children }: { provider: ProviderId; accountId: string; report: LimitsReport | undefined; limits: RateLimit[]; now: number; compact?: boolean; head?: ReactNode; children?: ReactNode }) {
  const ordered = useMemo(() => orderWindows(limits), [limits]);
  // A reset in the agent's own dialog, where it has one, goes under the window that is full.
  const inAgent = useResetInAgent(provider, accountId);
  const resetOn = report?.resets?.available ? resetTarget(limits, report.resets.windows) : inAgent?.atLimit || inAgent?.run ? fullTarget(limits, now) : undefined;
  return (
    <div className="ulw-list" data-compact={compact || undefined}>
      {head}
      {ordered.map((l) => (
        <Fragment key={l.id}>
          <WindowLine limit={l} pace={report?.pace[l.id]} now={now} />
          {l.id === resetOn?.id && (
            <div className="ulw-sub">
              <LimitReset provider={provider} accountId={accountId} limit={l} compact={compact} />
            </div>
          )}
        </Fragment>
      ))}
      <Extra report={report} now={now} />
      {children}
    </div>
  );
}

/** Lines while the first read is on its way, in the columns of the window lines. */
export function LineSkeleton({ rows = 2, compact }: { rows?: number; compact?: boolean }) {
  return (
    <div className="ulw-list" data-compact={compact || undefined} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ulw">
          <span className="skel ulw-skel-label" style={{ width: compact ? (i ? '46%' : '34%') : i ? '72%' : '54%' }} />
          <span className="ulw-bar">
            <span className="skel ulw-skel-meter" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** "as of 14:02" when an account's figures are older than a quarter of an hour; nothing otherwise. */
export function AsOf({ report, now, pending }: { report: LimitsReport | undefined; now: number; pending?: boolean }) {
  const stale = report?.readAt && now - report.readAt > STALE_MS ? report.readAt : undefined;
  if (!stale) return null;
  return (
    <Tip label={`Read ${exactTime(stale)}`}>
      <span className={cx('ul-asof num', pending && 'is-pending')} tabIndex={0}>
        as of {clock(stale, now)}
      </span>
    </Tip>
  );
}

export interface AccountRef {
  provider: ProviderId;
  info: ProviderInfo | undefined;
  account: AccountInfo;
}

/** Every account the Usage view lists: Claude Code and Codex always, other agents when present; the default account first. */
export function useAccountRefs(): AccountRef[] {
  const providers = useStore((s) => s.providers);
  return useMemo(() => {
    const ids: ProviderId[] = ['claude', 'codex', ...(Object.keys(providers) as ProviderId[]).filter((id) => id !== 'claude' && id !== 'codex' && providers[id]?.installed)];
    return ids.flatMap((provider) => {
      const info = providers[provider];
      const accounts = info?.accounts?.length ? info.accounts : [{ id: DEFAULT_ACCOUNT, provider, label: 'Main', isDefault: true, auth: info?.auth ?? { loggedIn: false } }];
      // A missing agent is one line, not one per account.
      return (info?.installed ? accounts : accounts.slice(0, 1)).map((account) => ({ provider, info, account }));
    });
  }, [providers]);
}

/**
 * Keeps limits current while a view shows them: a cheap read for every signed-in account when it
 * opens, and a forced one (which may start a short agent process) for an account never read.
 */
export function useLimitsRefresh(refs: AccountRef[], ready: boolean) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  /** Accounts a forced read just came back empty for: asking again now will not help. */
  const [dry, setDry] = useState<ReadonlySet<string>>(() => new Set());
  const signedIn = refs.filter((r) => r.info?.installed && r.account.auth.loggedIn);
  const sig = signedIn.map((r) => accountKey(r.provider, r.account.id)).join(',');

  const run = (force: boolean, only?: AccountRef[]) => {
    for (const r of only ?? signedIn) {
      const key = accountKey(r.provider, r.account.id);
      const known = useStore.getState().limitReports[key];
      setPending((s) => new Set(s).add(key));
      const forced = force || !known?.readAt;
      void (forced ? readLimitsNow : refreshLimits)(r.provider, r.account.id)
        .then((rows) => {
          if (!forced) return;
          const empty = !rows.length && !useStore.getState().limitReports[key]?.limits.length;
          setDry((s) => {
            const next = new Set(s);
            if (empty) next.add(key);
            else next.delete(key);
            return next;
          });
        })
        .finally(() =>
        setPending((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        }),
      );
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (ready && sig) runRef.current(false);
  }, [ready, sig]);
  // And again while the view stays open. A cheap read keeps an account with a live agent current;
  // one whose figures have aged (no agent of it running) is read for real, at most this often.
  useLimitsTicker(ready && !!sig, () => {
    const now = Date.now();
    for (const r of signedIn) {
      const readAt = useStore.getState().limitReports[accountKey(r.provider, r.account.id)]?.readAt;
      runRef.current(!!readAt && now - readAt > AGED_MS, [r]);
    }
  });

  return { pending, dry, refresh: () => run(true, signedIn.filter((r) => !dry.has(accountKey(r.provider, r.account.id)))) };
}

/** What an account without limits waits for, in one line. */
export const NO_DATA = 'Limits appear after the next turn';

const NONE: RateLimit[] = [];

/** One account's windows as known: the bridge's record first (it has the history and the pace), the last event otherwise. */
export function useAccountWindows(provider: ProviderId, accountId: string): { report: LimitsReport | undefined; limits: RateLimit[] } {
  const report = useLimitsReport(provider, accountId);
  const live = useStore((s) => s.limits[accountKey(provider, accountId)]);
  return { report, limits: report?.limits.length ? report.limits : (live ?? NONE) };
}

/**
 * What one account's limits show, wherever they are shown: its windows, one line saying why there
 * are none (not installed, signed out, no plan limits, nothing reported yet), or lines while the
 * first read is on its way.
 */
export function LimitsBody({
  provider,
  account,
  installed,
  report,
  limits,
  now,
  pending,
  compact,
  children,
}: {
  provider: ProviderId;
  account: AccountInfo;
  installed: boolean;
  report: LimitsReport | undefined;
  limits: RateLimit[];
  now: number;
  pending: boolean;
  compact?: boolean;
  children?: ReactNode;
}) {
  if (!installed) return <p className="ulw-msg">Not installed</p>;
  if (!account.auth.loggedIn)
    return (
      <p className="ulw-msg">
        <span>Not signed in</span>
        {!compact && (
          <button type="button" className="btn btn-sm ul-note-btn" onClick={() => openSettings('accounts')}>
            Accounts
          </button>
        )}
      </p>
    );
  if (report?.planLimits === false || (!limits.length && isApiKey(account.auth))) return <p className="ulw-msg">No plan limits on this account</p>;
  if (limits.length)
    return (
      <WindowList provider={provider} accountId={account.id} report={report} limits={limits} now={now} compact={compact}>
        {children}
      </WindowList>
    );
  if (pending) return <LineSkeleton compact={compact} />;
  // Nothing to read on demand: the agent reports its limits while it works.
  return <p className="ulw-msg">{NO_DATA}</p>;
}

/**
 * One account's windows on the Usage page: every window it has as one line each (the 5-hour one,
 * the week, the week of each model), extra usage or credits, a reset where one is granted. As a
 * card with the agent, name and plan (few accounts), or `inline` under its line in the overview.
 */
export function AccountLimits({ refs, pending, inline }: { refs: AccountRef; pending: boolean; inline?: boolean }) {
  const { provider, info, account } = refs;
  const { report, limits } = useAccountWindows(provider, account.id);
  const now = useNow();
  const plan = planShort(account.auth);
  const multi = (info?.accounts?.length ?? 0) > 1;
  // One account: the agent's name says it all. Several: each by its email (or label).
  const name = multi && info?.installed ? accountName(account) : PROVIDER_NAME[provider];
  const shows = !!info?.installed && account.auth.loggedIn && report?.planLimits !== false && limits.length > 0;

  const body = (
    <LimitsBody provider={provider} account={account} installed={!!info?.installed} report={report} limits={limits} now={now} pending={pending}>
      {!inline && offersCredits(report) && (
        <div className="ulw-sub ulw-sub-wide">
          <CreditsSetting provider={provider} accountId={account.id} />
        </div>
      )}
    </LimitsBody>
  );

  if (inline) {
    const asOf = <AsOf report={report} now={now} pending={pending} />;
    return (
      <div className="ul-account" data-inline>
        {body}
        {!!report?.readAt && now - report.readAt > STALE_MS && <div className="ulw-asof">{asOf}</div>}
      </div>
    );
  }
  return (
    <section className="ul-account card" data-spot aria-label={`${PROVIDER_NAME[provider]}: ${name}`}>
      <header className="ul-account-head">
        <ProviderMark provider={provider} size={15} className="ul-account-mark" />
        <span className="ul-account-who">
          <span className="ul-account-name truncate">{name}</span>
          {planBeside(name, plan) && <span className="ul-account-plan truncate">{plan}</span>}
          <span className="ul-account-asof">
            <AsOf report={report} now={now} pending={pending} />
          </span>
        </span>
        {shows && <span className="ul-account-col">Resets in</span>}
      </header>
      {body}
    </section>
  );
}

/** The agent reports credits or extra usage for this account (the credits setting applies to it). */
export const offersCredits = (r: LimitsReport | undefined) => !!(r?.extra?.enabled || r?.credits?.has || r?.credits?.balance || r?.credits?.unlimited);

/** Where each agent's own billing page is (opened in the user's browser). */
const BILLING: Partial<Record<ProviderId, string>> = {
  claude: 'https://claude.ai/settings/usage',
  codex: 'https://chatgpt.com/codex/settings/usage',
};

/**
 * "Use credits at a limit" for one account, shown only where its agent reports credits or extra
 * usage. Neither agent lets Sable switch them per session: the account's own setting decides
 * whether they are spent, so the line says that and links to the provider's billing page.
 */
export function CreditsSetting({ provider, accountId, name, className }: { provider: ProviderId; accountId: string; name?: string; className?: string }) {
  const report = useLimitsReport(provider, accountId);
  const key = `${provider}:${accountId}`;
  const on = useStore((s) => !!s.settings.creditsAtLimit?.[key]);
  if (!offersCredits(report)) return null;
  const label = name ? `Use credits at a limit: ${name}` : 'Use credits at a limit';
  const url = BILLING[provider];
  return (
    <div className={cx('ul-credits', className)} data-spot={className ? true : undefined}>
      <label className="ul-credits-row">
        <span className="ul-label truncate">{label}</span>
        <Switch checked={on} onChange={(v) => void setSettings({ creditsAtLimit: { ...useStore.getState().settings.creditsAtLimit, [key]: v } })} label={label} />
      </label>
      <p className="ul-credits-note">
        Whether credits are spent is set on your {PROVIDER_NAME[provider]} account.
        {url && (
          <>
            {' '}
            <a href={url} target="_blank" rel="noreferrer">
              Billing
            </a>
          </>
        )}
      </p>
    </div>
  );
}

/**
 * "Use credits at a limit" for many accounts at once: one card, a switch per account whose agent
 * reports credits or extra usage, and the one line on who decides (with each agent's billing page).
 */
function CreditsList({ refs }: { refs: AccountRef[] }) {
  const reports = useStore((s) => s.limitReports);
  const chosen = useStore((s) => s.settings.creditsAtLimit);
  const rows = refs.filter((r) => r.info?.installed && r.account.auth.loggedIn && offersCredits(reports[accountKey(r.provider, r.account.id)]));
  if (!rows.length) return null;
  const agents = [...new Set(rows.map((r) => r.provider))];
  const links = agents.filter((p) => BILLING[p]);
  return (
    <section className="ul-credit-card card" data-spot aria-label="Use credits at a limit">
      <div className="ul-credit-head">Use credits at a limit</div>
      <div className="ul-credit-rows">
        {rows.map((r) => {
          const key = `${r.provider}:${r.account.id}`;
          const multi = (r.info?.accounts?.length ?? 0) > 1;
          const name = multi ? accountName(r.account) : PROVIDER_NAME[r.provider];
          const plan = planShort(r.account.auth);
          return (
            <label key={key} className="ul-credit-row">
              <ProviderMark provider={r.provider} size={14} className="ulo-mark" />
              <span className="ulo-who">
                <span className="ulo-name truncate">{name}</span>
                {planBeside(name, plan) && <span className="ulo-plan truncate">{plan}</span>}
              </span>
              <Switch checked={!!chosen?.[key]} onChange={(v) => void setSettings({ creditsAtLimit: { ...useStore.getState().settings.creditsAtLimit, [key]: v } })} label={`Use credits at a limit: ${PROVIDER_NAME[r.provider]}, ${name}`} />
            </label>
          );
        })}
      </div>
      <p className="ul-credits-note">
        Whether credits are spent is set on each account with its agent.
        {links.map((p) => (
          <Fragment key={p}>
            {' '}
            <a href={BILLING[p]} target="_blank" rel="noreferrer">
              {links.length > 1 || agents.length > 1 ? `${PROVIDER_NAME[p]} billing` : 'Billing'}
            </a>
          </Fragment>
        ))}
      </p>
    </section>
  );
}

/**
 * Usage credits beyond the plan (Claude; it called them extra usage before) or a credits balance
 * (Codex), as a window line, when the agent reports one: spent of the cap with its meter, and the
 * balance left when the agent tells it.
 */
function Extra({ report, now }: { report: LimitsReport | undefined; now: number }) {
  const ex = report?.extra;
  const hasBalance = ex?.balance !== undefined && ex.balance > 0;
  if (ex && ((ex.enabled && (ex.limit || ex.used)) || hasBalance)) {
    const money = (v?: number) => (v === undefined ? '' : new Intl.NumberFormat(NUMBER_LOCALE, { style: 'currency', currency: ex.currency || 'USD' }).format(v / 100));
    const metered = ex.enabled && !!(ex.limit || ex.used);
    const pct = metered ? (ex.percent ?? (ex.limit && ex.used !== undefined ? Math.round((ex.used / ex.limit) * 100) : undefined)) : undefined;
    const spent = ex.limit ? `${money(ex.used ?? 0)} of ${money(ex.limit)}` : money(ex.used);
    const left = hasBalance ? `${money(ex.balance)} left` : '';
    const note = [pct !== undefined ? spent : '', pct !== undefined ? left : '', !ex.enabled ? 'Off' : '', ex.inUse ? 'Running on usage credits' : ''].filter(Boolean).join(' · ');
    return (
      <div className="ulw">
        <span className="ulw-label truncate">Usage credits</span>
        <span className="ulw-bar">
          {pct !== undefined ? (
            <>
              <span className="meter ulw-meter" role="progressbar" aria-label="Usage credits" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <span className="meter-fill" style={{ '--p': Math.min(100, pct) / 100 } as CSSProperties} />
              </span>
              <span className="ulw-pct num">{Math.min(100, pct)}%</span>
            </>
          ) : (
            <span className="ulw-value num">{metered ? spent : left}</span>
          )}
        </span>
        <ResetCell at={ex.resetsAt} now={now} />
        {note && <span className="ulw-note num">{note}</span>}
      </div>
    );
  }
  const cr = report?.credits;
  if (cr && (cr.balance || cr.unlimited))
    return (
      <div className="ulw">
        <span className="ulw-label truncate">Credits</span>
        <span className="ulw-bar">
          <span className="ulw-value num">{cr.unlimited ? 'Unlimited' : balance(cr.balance)}</span>
        </span>
        <ResetCell at={cr.resetsAt} now={now} />
        {cr.inUse && <span className="ulw-note">Running on credits</span>}
      </div>
    );
  return null;
}

/** The time to a reset in the reset column, the exact time in its tooltip; empty when none is ahead. */
function ResetCell({ at, now }: { at?: number; now: number }) {
  if (!at || at <= now) return <span className="ulw-reset" />;
  return (
    <Tip label={exactTime(at)} side="bottom">
      <span className="ulw-reset num" tabIndex={0} aria-label={resetsText(at, now)}>
        {duration(at - now)}
      </span>
    </Tip>
  );
}

/** A credits balance as the agent sends it ("43106.95142") reads as a number with at most two decimals. */
function balance(raw?: string) {
  const n = Number(raw);
  return raw && Number.isFinite(n) ? n.toLocaleString(NUMBER_LOCALE, { maximumFractionDigits: 2 }) : raw;
}

/** The Limits part of the Usage page: one block per account, one refresh for all. */
export function LimitsSection() {
  const ready = useStore((s) => s.ready);
  const refs = useAccountRefs();
  const { pending, dry, refresh } = useLimitsRefresh(refs, ready);
  const [turning, setTurning] = useState(false);
  // The refresh shows only when it can bring something: an account whose last forced read was empty is left alone.
  const anySignedIn = refs.some((r) => r.info?.installed && r.account.auth.loggedIn && !dry.has(accountKey(r.provider, r.account.id)));
  return (
    <section className="set-group" aria-labelledby="ul-limits-title">
      <header className="set-group-head">
        <h3 className="set-group-title" id="ul-limits-title">
          Limits
        </h3>
        <div className="set-group-aside">
          {anySignedIn && (
            <IconButton
              icon="refresh"
              label="Read limits now"
              size={14}
              className="ul-refresh"
              // The icon turns once per click.
              data-turning={turning || undefined}
              onAnimationEnd={() => setTurning(false)}
              onClick={() => {
                setTurning(true);
                refresh();
              }}
            />
          )}
        </div>
      </header>
      <LimitsTotals refs={refs} />
      {refs.length >= OVERVIEW_FROM ? (
        // Many accounts: one line each, the windows in full on demand.
        <>
          <LimitsOverview refs={refs} pending={pending} />
          <CreditsList refs={refs} />
        </>
      ) : (
        <div className="ul-accounts">
          {refs.map((r) => (
            <AccountLimits key={`${r.provider}:${r.account.id}`} refs={r} pending={pending.has(accountKey(r.provider, r.account.id))} />
          ))}
        </div>
      )}
    </section>
  );
}
