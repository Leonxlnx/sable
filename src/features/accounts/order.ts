import { useMemo } from 'react';
import type { AccountCap, AccountInfo, ProviderId, RateLimit } from '@shared/protocol';
import { useFirst, type UseFirstRank } from '@shared/use-first';
import { isApiKey } from '@/features/usage/format';
import { planSize } from '@/features/usage/plans';
import { useNow } from '@/lib/useNow';
import { accountKey, useStore } from '@/state/store';

/**
 * An agent's accounts in the order to use them (`shared/use-first.ts`): the one whose unused week
 * ends soonest first, so the least expires unused. The same order the bridge moves a chat by at a
 * limit (`AppSettings.accountsBy`, 'useFirst' unless the person keeps their own order).
 */
export interface OrderInput {
  account: AccountInfo;
  limits?: RateLimit[];
  /** Billed per token (an API key): no week to use up. */
  unmetered?: boolean;
}

export function useFirstRanks(provider: ProviderId, inputs: OrderInput[], caps: Partial<Record<string, AccountCap>> | undefined, now: number): UseFirstRank[] {
  return useFirst(
    inputs.map((i) => ({
      id: i.account.id,
      signedIn: i.account.auth.loggedIn,
      planLimits: i.unmetered ? false : undefined,
      limits: i.limits,
      cap: caps?.[`${provider}:${i.account.id}`],
      weight: planSize(provider, i.account.auth)?.weight,
    })),
    now,
  );
}

/** How long until a time, in the fewest characters a row has room for: "45m", "27h", "3d". */
export function shortUntil(at: number | undefined, now: number): string {
  if (!at || at <= now) return '';
  const mins = (at - now) / 60_000;
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/** What a row's end-of-week figure means, for its tooltip and for screen readers. */
export function rankWords(r: UseFirstRank | undefined, now: number): string {
  if (!r) return '';
  const ends = shortUntil(r.expiresAt, now);
  if (r.state === 'now') return ends ? `Week ends in ${ends}; what is unused then is gone` : '';
  if (r.state === 'held') return r.until ? `Held for ${shortUntil(r.until, now)}` : 'Held by a full window';
  if (r.state === 'spent') return ends ? `Used up; back in ${ends}` : 'Used up';
  return '';
}

/**
 * An agent's accounts as every list shows them: by what to use first (`AppSettings.accountsBy`,
 * unless the person keeps their own order: then as given), with each account's rank for the
 * end-of-week figure. One rule for the short list and the long one.
 */
export function useAccountOrder(provider: ProviderId, accounts: AccountInfo[]): { list: AccountInfo[]; rank: Map<string, UseFirstRank> } {
  const reports = useStore((s) => s.limitReports);
  const live = useStore((s) => s.limits);
  const byUseFirst = useStore((s) => s.settings.accountsBy !== 'manual');
  const caps = useStore((s) => s.settings.accountCaps);
  const now = useNow();
  return useMemo(() => {
    const inputs = accounts.map((account) => {
      const key = accountKey(provider, account.id);
      const known = reports[key]?.limits;
      return { account, limits: known?.length ? known : live[key], unmetered: reports[key]?.planLimits === false || isApiKey(account.auth) };
    });
    const ranks = useFirstRanks(provider, inputs, caps, now);
    const rank = new Map(ranks.map((r) => [r.id, r]));
    if (!byUseFirst) return { list: accounts, rank };
    const place = new Map(ranks.map((r, i) => [r.id, i]));
    return { list: [...accounts].sort((a, b) => (place.get(a.id) ?? 0) - (place.get(b.id) ?? 0)), rank };
  }, [provider, accounts, reports, live, byUseFirst, caps, now]);
}
