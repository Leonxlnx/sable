import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import type { AccountInfo, LimitsReport, ProviderId, ProviderInfo, RateLimit } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { isApiKey, planText, windowLevel } from '@/features/usage/format';
import { poolTotals, poolUsedPercent, poolWeeksText, type PoolInput, type PoolTotal } from '@/features/usage/plans';
import { roomRow, type RoomInput, type RoomRow } from '@/features/usage/room';
import { accountUsed, usedPercent, usedText } from '@/features/usage/words';
import { Icon } from '@/icons';
import { useNow } from '@/lib/useNow';
import { signedOut } from '@/lib/sign-in';
import { accountName } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';
import { Tip } from '@/ui';
import { accountMark, accountsOf, markWords, planWord, type AccountMark } from './model';
import { planBeside } from '@/features/connect/plan';
import { rankWords, shortUntil, useFirstRanks } from './order';
import type { UseFirstRank } from '@shared/use-first';
import { appliesTo } from '@/features/usage/scope';

/** From this many accounts on, the switcher filters, groups and orders its accounts. */
export const MANY_ACCOUNTS = 8;

const COLLAPSED_KEY = 'sable.accounts.collapsed';

function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

interface Entry extends RoomInput, PoolInput {
  account: AccountInfo;
}

/** One agent's accounts as inputs for room and for the weighted total: the bridge's record first, the last event otherwise. */
function entriesOf(provider: ProviderId, info: ProviderInfo | undefined, reports: Partial<Record<string, LimitsReport>>, live: Partial<Record<string, RateLimit[]>>): Entry[] {
  return accountsOf(info).map((account) => {
    const key = accountKey(provider, account.id);
    const known = reports[key]?.limits;
    return {
      key,
      account,
      provider,
      name: accountName(account),
      usable: account.auth.loggedIn,
      limits: known?.length ? known : live[key],
      auth: account.auth,
      unmetered: reports[key]?.planLimits === false || isApiKey(account.auth),
    };
  });
}

/** How much is used across an agent's accounts, weighted by plan (as on the Usage page); undefined below two accounts with figures. */
function poolOf(entries: Entry[], now: number): PoolTotal | undefined {
  return poolTotals(entries, now)[0];
}

/** Whether an account answers a filter: every word must be in its name, email, plan or agent. */
export function matchesAccount(query: string, hay: (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = hay.filter(Boolean).join('\n').toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * The switcher's list for many accounts: a filter on top (typing anywhere in the list goes to it),
 * one group per agent that folds, and within a group the accounts in the order to use them
 * (or the person's own order: `useAccountOrder` has the same rule for the short list).
 */
export function ManyAccounts({
  agents,
  providers,
  inUse,
  onPeek,
  onPick,
}: {
  agents: ProviderId[];
  providers: Partial<Record<ProviderId, ProviderInfo>>;
  inUse: { provider: ProviderId; accountId: string | undefined };
  onPeek: (p: { provider: ProviderId; accountId: string } | null) => void;
  onPick: (provider: ProviderId, account: AccountInfo) => void;
}) {
  const reports = useStore((s) => s.limitReports);
  const live = useStore((s) => s.limits);
  const byUseFirst = useStore((s) => s.settings.accountsBy !== 'manual');
  const caps = useStore((s) => s.settings.accountCaps);
  const now = useNow();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () =>
      agents.map((id) => {
        const entries = entriesOf(id, providers[id], reports, live);
        const rows = entries.map((e) => roomRow(e, now));
        // The order to use them in: the week that ends soonest first (shared/use-first.ts).
        const ranks = useFirstRanks(id, entries, caps, now);
        const rank = new Map(ranks.map((r, i) => [r.id, { ...r, place: i }]));
        const place = (r: (typeof rows)[number]) => rank.get(r.input.account.id)?.place ?? ranks.length;
        // Or the person's own order, as saved (the same order a move at a limit follows then).
        const sorted = byUseFirst ? [...rows].sort((a, b) => place(a) - place(b)) : rows;
        return { id, rows: sorted, total: sorted.length, pool: poolOf(entries, now), rank };
      }),
    [agents, providers, reports, live, now, byUseFirst, caps],
  );

  const q = query.trim();
  const shown = groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter((r) => matchesAccount(q, [r.input.name, r.input.account.auth.loggedIn ? r.input.account.auth.email : undefined, planOf(r.input.account), PROVIDER_NAME[g.id]])),
    }))
    .filter((g) => g.rows.length);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* private mode */
      }
      return next;
    });

  const rowEls = () => [...(list.current?.querySelectorAll<HTMLElement>('.acs-row') ?? [])];

  /** Typing on a row goes to the filter (the menu's own type-ahead would only jump by first letters). */
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target === input.current || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      e.stopPropagation();
      setQuery((v) => v + e.key);
      input.current?.focus();
    } else if (e.key === 'Backspace' && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery((v) => v.slice(0, -1));
      input.current?.focus();
    }
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (!query) return;
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
      return;
    }
    if (e.key === 'Tab') return;
    // The menu must not treat what is typed here as type-ahead or as its own keys.
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const els = rowEls();
      (e.key === 'ArrowDown' ? els[0] : els[els.length - 1])?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      rowEls()[0]?.click();
    }
  };

  return (
    <div className="acs-many" onKeyDown={onListKey}>
      {/* The menu's first row: it arrives with the rows, and the menu's own hairline closes it. */}
      <label className="acs-filter" data-arrive-row>
        <Icon name="search" size={14} />
        <input
          ref={input}
          className="acs-filter-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          onFocus={() => onPeek(null)}
          placeholder="Filter accounts"
          aria-label="Filter accounts"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <RM.Separator className="menu-sep" />
      <div className="acs-list scroll" ref={list}>
        {shown.length === 0 && <p className="acs-empty">No account matches “{q}”.</p>}
        {shown.map((g) => {
          const folded = !q && collapsed.has(g.id);
          const free = g.rows.filter((r) => r.state === 'room' || r.state === 'unknown').length;
          // An agent's only account is one row under the agent's name: nothing to fold.
          if (g.total === 1)
            return (
              <RM.Group key={g.id} className="acs-group">
                <ManyRow row={g.rows[0]} now={now} single rank={g.rank.get(g.rows[0].input.account.id)} inUse={inUse.provider === g.id} onPeek={() => onPeek({ provider: g.id, accountId: g.rows[0].input.account.id })} onSelect={() => onPick(g.id, g.rows[0].input.account)} />
              </RM.Group>
            );
          return (
            <RM.Group key={g.id} className="acs-group">
              <RM.Item
                className="menu-item acs-group-head"
                aria-expanded={!folded}
                aria-label={`${PROVIDER_NAME[g.id]}, ${g.pool ? poolWeeksText(g.pool) : `${free} of ${g.rows.length} with room`}`}
                onFocus={() => onPeek(null)}
                onSelect={(e) => {
                  e.preventDefault();
                  if (!q) toggle(g.id);
                }}
              >
                <ProviderMark provider={g.id} size={14} className="acs-mark" />
                <span className="acs-name truncate">{PROVIDER_NAME[g.id]}</span>
                {g.pool ? <PoolUsed total={g.pool} /> : <span className="acs-left num">{free} of {g.rows.length} with room</span>}
                <span className="acs-end">
                  <Icon name="caret-down" size={11} className="acs-fold" />
                </span>
              </RM.Item>
              {!folded && g.rows.map((r) => <ManyRow key={r.input.key} row={r} now={now} rank={g.rank.get(r.input.account.id)} inUse={inUse.provider === g.id && inUse.accountId === r.input.account.id} onPeek={() => onPeek({ provider: g.id, accountId: r.input.account.id })} onSelect={() => onPick(g.id, r.input.account)} />)}
            </RM.Group>
          );
        })}
      </div>
    </div>
  );
}

/** The plan as one word, the Demo's made-up plans included. */
export const planOf = (a: AccountInfo) => (a.auth.loggedIn ? (planWord(a) ?? planText(a.auth)?.replace(/\s+plan$/i, '')) : undefined);

function ManyRow({ row, now, rank, inUse, single, onPeek, onSelect }: { row: RoomRow<Entry>; now: number; rank?: UseFirstRank; inUse: boolean; single?: boolean; onPeek: () => void; onSelect: () => void }) {
  const { account, provider } = row.input;
  const plan = planBeside(single ? PROVIDER_NAME[provider] : row.input.name, planOf(account));
  const used = row.tight ? usedPercent(row.tight, now) : undefined;
  const words = rankWords(rank, now);
  const mark = accountMark(account, inUse ? account.id : undefined);
  return (
    <RM.Item
      className="menu-item acs-row acs-row-in"
      data-current={mark === 'here' || undefined}
      data-in-use={inUse || undefined}
      data-out={signedOut(account.auth) || undefined}
      onFocus={onPeek}
      onSelect={onSelect}
      aria-label={`${PROVIDER_NAME[provider]}, ${row.input.name}${plan ? `, ${plan}` : ''}${used !== undefined ? `, ${usedText(used)}` : ''}${words ? `, ${words.toLowerCase()}` : ''}${signedOut(account.auth) ? ', not signed in' : ''}${markWords(mark)}`}
    >
      {single ? (
        <ProviderMark provider={provider} size={14} className="acs-mark" />
      ) : (
        <span className="acs-check-col" aria-hidden>
          <MarkCell mark={mark} />
        </span>
      )}
      <span className="acs-name truncate">{single ? PROVIDER_NAME[provider] : row.input.name}</span>
      {account.auth.loggedIn ? (
        <>
          <span className="acs-plan">{plan}</span>
          <UsedCell limit={row.tight} now={now} />
          <EndsCell rank={rank} now={now} />
        </>
      ) : (
        <AccountStatus checking={account.auth.checking} />
      )}
    </RM.Item>
  );
}

/**
 * A row's mark, in the check's column: the check on the account in use, a quiet dot where new
 * chats with the agent start when that is another account (`accountMark`).
 */
export function MarkCell({ mark }: { mark: AccountMark }) {
  if (mark === 'here') return <Icon name="check" size={14} className="acs-check" />;
  if (mark === 'next') return <span className="acs-next" title="New chats start here" />;
  return null;
}

/**
 * A signed-out account has no plan, no figures and no week: its row ends in what picking it does,
 * on the right edge the figures of the other rows end on.
 */
export function AccountStatus({ checking }: { checking?: boolean }) {
  return checking ? <span className="acs-plan">Checking sign-in</span> : <span className="acs-signin">Sign in</span>;
}

/**
 * When an account's week ends (what is unused then is gone): the figure the list is ordered by,
 * soonest first. Dim for an account that does not take work now (held, used up); empty when its
 * week is not known.
 */
export function EndsCell({ rank, now }: { rank: UseFirstRank | undefined; now: number }) {
  const at = rank?.state === 'held' ? (rank.until ?? rank.expiresAt) : rank?.expiresAt;
  const text = rank && rank.state !== 'off' && rank.state !== 'unknown' ? shortUntil(at, now) : '';
  return (
    <span className="acs-ends num" data-state={rank?.state} title={rankWords(rank, now) || undefined} aria-hidden>
      {text}
    </span>
  );
}

/**
 * How full an account is, in a menu row, drawn as the Usage page draws a window: a thin meter and
 * the percent used of the window that leaves it the least room; amber near a cap, red at it. An
 * empty cell of the same width when nothing is known, so the plans line up.
 */
export function UsedCell({ limit, now }: { limit: RateLimit | undefined; now: number }) {
  if (!limit) return <span className="acs-used" aria-hidden />;
  const used = usedPercent(limit, now);
  const level = windowLevel(limit, now);
  return (
    <span className="acs-used" aria-hidden>
      <span className="meter acs-meter" data-level={level}>
        <span className="meter-fill" style={{ '--p': Math.max(used, used > 0 ? 3 : 0) / 100 } as CSSProperties} />
      </span>
      <span className="acs-pct num" data-level={level}>
        {used}%
      </span>
    </span>
  );
}

/** UsedCell for one account, read from the store. */
export function AccountUsed({ provider, accountId, model }: { provider: ProviderId; accountId: string; model?: { id?: string; name?: string } }) {
  const limits = useStore((s) => {
    const key = accountKey(provider, accountId);
    const known = s.limitReports[key]?.limits;
    return known?.length ? known : s.limits[key];
  });
  const now = useNow();
  // For a session, only the windows that hold back its model: another model's full week is not this chat's.
  return <UsedCell limit={accountUsed(model ? limits?.filter((l) => appliesTo(l, model)) : limits, now)?.limit} now={now} />;
}

/** "49% used": an agent's weeks used across its accounts, weighted by plan; amber from 80% (as its meter on the Usage page), red when used up. */
function PoolUsed({ total }: { total: PoolTotal }) {
  const used = poolUsedPercent(total);
  return (
    <span className="acs-left num" data-level={used >= 100 ? 'red' : used >= 80 ? 'amber' : undefined}>
      {usedText(used)}
    </span>
  );
}

/**
 * How much of an agent's weeks is used across all its accounts, weighted by plan (one Ultra counts
 * as ten Pro), the same total the Usage page draws ("49% used"; the tooltip says it in weeks). Nothing while the agent has fewer
 * than two accounts with a known plan and figures: the account's own limit mark says it all then.
 */
export function usePool(provider: ProviderId, info: ProviderInfo | undefined): PoolTotal | undefined {
  const reports = useStore((s) => s.limitReports);
  const live = useStore((s) => s.limits);
  const now = useNow();
  return useMemo(() => poolOf(entriesOf(provider, info, reports, live), now), [provider, info, reports, live, now]);
}

export function PoolFigure({ provider, total }: { provider: ProviderId; total: PoolTotal | undefined }) {
  if (!total) return null;
  return (
    <Tip label={`${PROVIDER_NAME[provider]}: ${poolWeeksText(total)}`} side="top">
      <span className="acs-room">
        <PoolUsed total={total} />
      </span>
    </Tip>
  );
}
