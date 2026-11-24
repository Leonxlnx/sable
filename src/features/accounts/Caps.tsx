import { useEffect, useRef, useState } from 'react';
import type { AccountInfo, ProviderId } from '@shared/protocol';
import { ProviderMark } from '@/art/Logo';
import { isApiKey } from '@/features/usage/format';
import { usedPercent, usedText } from '@/features/usage/words';
import { setAccountCap } from '@/state/actions';
import { accountName } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';

/**
 * "Use up to" per account (Settings › Accounts): how much of an account's weekly window (and,
 * optionally, its 5-hour window) Sable may use before a session moves, between turns, to the next
 * account of the same agent under its own cap. Only agents with more than one signed-in account on
 * a plan are listed: with one there is nowhere to move. An empty field is no cap.
 */
export function AccountCaps({ agents }: { agents: ProviderId[] }) {
  const providers = useStore((s) => s.providers);
  const reports = useStore((s) => s.limitReports);
  // Accounts on a plan: an API key has no windows to cap, and a cap never moves a session onto one.
  const metered = (id: ProviderId, a: AccountInfo) => a.auth.loggedIn && !isApiKey(a.auth) && reports[accountKey(id, a.id)]?.planLimits !== false;
  const groups = agents
    .map((id) => ({ id, accounts: (providers[id]?.accounts ?? []).filter((a) => metered(id, a)) }))
    .filter((g) => g.accounts.length > 1);
  if (!groups.length) return null;
  return (
    <section className="acct-caps card" data-spot aria-label="Use up to">
      <div className="acct-caps-head">
        <span className="acct-caps-title grow">Use up to</span>
        <span className="acct-caps-col">Weekly</span>
        <span className="acct-caps-col">5-hour</span>
      </div>
      {groups.flatMap((g) => g.accounts.map((a) => <CapRow key={`${g.id}/${a.id}`} provider={g.id} account={a} />))}
    </section>
  );
}

function CapRow({ provider, account }: { provider: ProviderId; account: AccountInfo }) {
  const name = accountName(account);
  // The account's week, read as every other figure is (the bridge's record first) and rounded once (usage/words.ts).
  const week = useStore((s) => {
    const key = accountKey(provider, account.id);
    const known = s.limitReports[key]?.limits;
    return (known?.length ? known : (s.limits[key] ?? account.limits))?.find((l) => l.id === 'seven_day' || (l.id.startsWith('codex:') && (l.windowMins ?? 0) >= 10_080));
  });
  const used = week ? usedPercent(week, Date.now()) : undefined;
  const cap = useStore((s) => s.settings.accountCaps?.[`${provider}:${account.id}`]?.weekly);
  // Past its weekly cap: the figure steps forward (sessions move off it between turns).
  const over = used !== undefined && !!cap && used >= cap;
  return (
    <div className="acct-cap-row">
      <ProviderMark provider={provider} size={14} className="acct-cap-mark" />
      <span className="acct-cap-name truncate">{name}</span>
      {used !== undefined && (
        <span className="acct-cap-used num" data-over={over || undefined}>
          {usedText(used)}
        </span>
      )}
      <CapField provider={provider} accountId={account.id} kind="weekly" label={`${name}: weekly cap`} />
      <CapField provider={provider} accountId={account.id} kind="session" label={`${name}: 5-hour cap`} />
    </div>
  );
}

/** A percent from 1 to 99; empty (or 100 and above) is no cap. Saved on Enter or leaving the field. */
function CapField({ provider, accountId, kind, label }: { provider: ProviderId; accountId: string; kind: 'weekly' | 'session'; label: string }) {
  const saved = useStore((s) => s.settings.accountCaps?.[`${provider}:${accountId}`]?.[kind]);
  const [value, setValue] = useState(saved ? String(saved) : '');
  const cancel = useRef(false);
  useEffect(() => setValue(saved ? String(saved) : ''), [saved]);
  const commit = () => {
    if (cancel.current) {
      cancel.current = false;
      setValue(saved ? String(saved) : '');
      return;
    }
    const n = Math.round(Number(value.replace(/[^\d.]/g, '')));
    const next = value.trim() && Number.isFinite(n) && n >= 1 && n < 100 ? n : undefined;
    setValue(next ? String(next) : '');
    if (next !== saved) void setAccountCap(provider, accountId, { [kind]: next });
  };
  return (
    <label className="acct-cap-field" data-set={saved ? '' : undefined}>
      <input
        className="num"
        inputMode="numeric"
        maxLength={3}
        value={value}
        placeholder="100"
        aria-label={label}
        onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            cancel.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      <span className="acct-cap-pct">%</span>
    </label>
  );
}
