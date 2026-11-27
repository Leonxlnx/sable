import type { AccountCap, AccountInfo, AppSettings, LimitsReport, ProviderId } from '@shared/protocol';
import { useFirst, type UseFirstRank } from '@shared/use-first';
import { planLabel } from '@desk/features/connect/plan';
import { planSize } from '@desk/features/usage/plans';

/**
 * An agent's accounts in the desktop's order (src/features/accounts/order.ts `useAccountOrder`, the
 * same pure rule, `shared/use-first.ts`): the one whose unused week ends soonest first, so the least
 * expires unused; then those held by a full window, the spent ones, the unread and the off. The
 * person's own order instead when they keep one (`AppSettings.accountsBy: 'manual'`). Each account's
 * rank comes with it.
 */
export function accountOrder(
  provider: ProviderId,
  accounts: AccountInfo[],
  limits: Readonly<Record<string, LimitsReport | undefined>>,
  settings?: Pick<AppSettings, 'accountsBy' | 'accountCaps'>,
  now = Date.now(),
): { list: AccountInfo[]; rank: Map<string, UseFirstRank> } {
  const caps: Partial<Record<string, AccountCap>> | undefined = settings?.accountCaps;
  const ranks = useFirst(
    accounts.map((account) => {
      const report = limits[`${provider}:${account.id}`];
      return {
        id: account.id,
        signedIn: account.auth.loggedIn,
        planLimits: report?.planLimits === false || planLabel(account.auth) === 'API key' ? false : undefined,
        limits: report?.limits?.length ? report.limits : account.limits,
        cap: caps?.[`${provider}:${account.id}`],
        weight: planSize(provider, account.auth)?.weight,
      };
    }),
    now,
  );
  const rank = new Map(ranks.map((r) => [r.id, r]));
  if (settings?.accountsBy === 'manual') return { list: accounts, rank };
  const place = new Map(ranks.map((r, i) => [r.id, i]));
  return { list: [...accounts].sort((a, b) => (place.get(a.id) ?? 0) - (place.get(b.id) ?? 0)), rank };
}

/** "2 of 3 with room": the accounts that take work now, of those with a plan to read (none for one account). */
export function roomWords(ranks: readonly UseFirstRank[]): string {
  const metered = ranks.filter((r) => r.state !== 'off');
  if (metered.length < 2) return '';
  const now = metered.filter((r) => r.state === 'now').length;
  return now ? `${now} of ${metered.length} with room` : 'None with room';
}
