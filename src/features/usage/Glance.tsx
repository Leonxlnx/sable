import { useEffect, useState } from 'react';
import { DEFAULT_ACCOUNT, type AccountInfo, type ProviderId } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { Icon } from '@/icons';
import { useNow } from '@/lib/useNow';
import { openUsage, refreshLimits } from '@/state/actions';
import { accountName, useLimitLevel } from '@/state/hooks';
import { useStore } from '@/state/store';
import { cx } from '@/ui';
import { isApiKey, STALE_MS } from './format';
import { AsOf, LimitsBody, useAccountWindows } from './Limits';
import { planShort } from './plans';
import { planBeside } from '@/features/connect/plan';
import { modelLimits } from './scope';
import { useLimitsTicker } from './ticker';

/**
 * One account's plan limits in compact form, in the Usage page's language: a head with the agent,
 * the account and its plan ("Resets in" over the times), then every window the account has as a
 * line (name, thin meter, percent, time to the reset, the pace under it), "as of" under them when
 * the figures are old. For the account switcher's popover and the side panel.
 *
 * `read` keeps the figures current while it is shown (a cheap read when it mounts and on the
 * limits ticker); leave it off where the host reads them already. `onOpenUsage` adds a last row
 * that opens Settings › Usage: a menu's last row (hairline, icon, word), not a control of its own.
 */
export function LimitsGlance({ provider, accountId = DEFAULT_ACCOUNT, read = true, onOpenUsage }: { provider: ProviderId; accountId?: string; read?: boolean; onOpenUsage?: () => void }) {
  const info = useStore((s) => s.providers[provider]);
  const found = info?.accounts?.find((a) => a.id === accountId);
  // Older bridges list no accounts: the agent's own sign-in is its one account.
  const account: AccountInfo | undefined = found ?? (accountId === DEFAULT_ACCOUNT && info ? { id: DEFAULT_ACCOUNT, provider, label: 'Main', isDefault: true, auth: info.auth } : undefined);
  // An agent's only account goes by the agent's name (as in the switcher); several go by their own.
  const several = (info?.accounts?.length ?? 0) > 1;
  const signedIn = !!account?.auth.loggedIn;
  const { report, limits } = useAccountWindows(provider, accountId);
  const now = useNow();

  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!read || !signedIn) return;
    let live = true;
    setPending(true);
    void refreshLimits(provider, accountId).finally(() => live && setPending(false));
    return () => {
      live = false;
    };
  }, [provider, accountId, signedIn, read]);
  useLimitsTicker(read && signedIn, () => void refreshLimits(provider, accountId));

  const plan = signedIn ? planShort(account?.auth) : undefined;
  const name = account && several ? accountName(account) : PROVIDER_NAME[provider];
  const shows = signedIn && report?.planLimits !== false && limits.length > 0 && !isApiKey(account?.auth);
  const stale = !!report?.readAt && now - report.readAt > STALE_MS;

  return (
    <div className="ul-glance">
      <div className="ul-glance-head">
        <ProviderMark provider={provider} size={14} className="ul-glance-mark" />
        <span className="ul-glance-name truncate">{name}</span>
        {planBeside(name, plan) && <span className="ul-glance-plan">{plan}</span>}
        {shows && <span className="ul-glance-col">Resets in</span>}
      </div>
      {account ? (
        <LimitsBody provider={provider} account={account} installed={!!info?.installed} report={report} limits={limits} now={now} pending={pending} compact />
      ) : (
        <p className="ulw-msg">Removed account</p>
      )}
      {/* Old figures say so under them (the head keeps the name whole), as an opened account does on the Usage page. */}
      {stale && (
        <div className="ul-glance-asof">
          <AsOf report={report} now={now} pending={pending} />
        </div>
      )}
      {/* The pane's last row, as a menu ends ("Manage accounts" beside it): a hairline, an icon, a word. */}
      {onOpenUsage && (
        <div className="ul-glance-foot">
          <button
            type="button"
            className="ul-glance-open"
            onClick={() => {
              onOpenUsage();
              openUsage();
            }}
          >
            <Icon name="gauge" size={15} />
            <span>Usage</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A tiny amber dot when an account is at 80% or more of a plan window, red when one is used up;
 * nothing otherwise. For the sidebar footer, the account switcher and the composer.
 */
export function LimitDot({ provider, accountId, className }: { provider: ProviderId; accountId?: string; className?: string }) {
  const level = useLimitLevel(provider, accountId);
  const { limits } = useAccountWindows(provider, accountId ?? DEFAULT_ACCOUNT);
  if (!level) return null;
  // A window of one model (Fable's week) at its cap leaves the other models free: a quiet ring, not red.
  const all = level === 'cap' ? modelLimits(limits, {}) : undefined;
  const tone = level !== 'cap' ? 'amber' : all?.level === 'cap' ? 'red' : all?.level === 'near' ? 'amber' : 'other';
  const label = tone === 'red' ? 'A plan limit is used up' : tone === 'other' ? 'One model is at its limit' : 'Near a plan limit';
  return <span className={cx('limit-dot', className)} data-level={tone} role="img" aria-label={label} />;
}
