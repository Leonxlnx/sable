import { memo, useMemo, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ProviderId, RateLimit } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { Icon } from '@/icons';
import { useNow } from '@/lib/useNow';
import { accountName } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';
import { Segmented, Tip } from '@/ui';
import { duration, exactTime, isApiKey, isScopedWindow } from './format';
import { AccountLimits, type AccountRef } from './Limits';
import { planShort, poolTotals, poolWeeksText, poolWeeksUsed, units, type PoolInput, type PoolPart, type PoolTotal } from './plans';
import { livePercent, NEAR_AT, overview, type RoomInput, type RoomRow, type SortBy } from './room';
import { usedPercent, usedText } from './words';

const SORT_KEY = 'sable.usage.sort';
const SORTS: { value: SortBy; label: string }[] = [
  { value: 'room', label: 'Least used' },
  { value: 'reset', label: 'Reset' },
  { value: 'agent', label: 'Agent' },
];

function readSort(): SortBy {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return v === 'reset' || v === 'agent' ? v : 'room';
  } catch {
    return 'room';
  }
}

interface Entry extends RoomInput, PoolInput {
  ref: AccountRef;
  /** An API key or an account the agent reports no plan windows for. */
  unmetered: boolean;
}

/** Every account with its windows, one input per account, for ordering (here and in the switcher). */
export function useRoomInputs(refs: AccountRef[]): Entry[] {
  const reports = useStore((s) => s.limitReports);
  const live = useStore((s) => s.limits);
  return useMemo(
    () =>
      refs.map((ref) => {
        const key = accountKey(ref.provider, ref.account.id);
        const known = reports[key]?.limits;
        const multi = (ref.info?.accounts?.length ?? 0) > 1;
        return {
          key,
          ref,
          provider: ref.provider,
          name: multi ? accountName(ref.account) : PROVIDER_NAME[ref.provider],
          usable: !!ref.info?.installed && ref.account.auth.loggedIn,
          limits: known?.length ? known : live[key],
          auth: ref.account.auth,
          unmetered: reports[key]?.planLimits === false || isApiKey(ref.account.auth),
        };
      }),
    [refs, reports, live],
  );
}

/** "5h", "7d": the window's length, short enough for a cell. */
export function windowShort(l: RateLimit): string {
  const m = l.windowMins;
  if (!m) return l.label.split(/[\s·-]/)[0] ?? '';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

/**
 * The two cells of a row: the session window (under a day) and the week. Of several weekly
 * windows (the whole plan, Opus, Fable) the one used most, which is the one that stops the account.
 */
function cells(limits: RateLimit[] | undefined, now: number): [RateLimit | undefined, RateLimit | undefined] {
  const list = limits ?? [];
  const isWeek = (l: RateLimit) => (l.windowMins ?? 0) >= 1440;
  const short = list.find((l) => !isWeek(l) && !isScopedWindow(l)) ?? list.find((l) => !isWeek(l));
  let week: RateLimit | undefined;
  for (const l of list.filter(isWeek)) if (!week || livePercent(l, now) > livePercent(week, now)) week = l;
  return [short, week];
}

/**
 * Settings > Usage with many accounts: every account as one line (agent, name, each window as a
 * thin meter with the share used, time to the reset), ordered by the least used, by reset or by agent. The
 * accounts at or near a cap sit apart; the one with the most room carries one small mark. A line
 * opens that account's windows in full, in the same columns.
 */
export function LimitsOverview({ refs, pending }: { refs: AccountRef[]; pending: ReadonlySet<string> }) {
  const inputs = useRoomInputs(refs);
  const now = useNow();
  const [sort, setSort] = useState<SortBy>(readSort);
  const [open, setOpen] = useState<string | null>(null);
  const agentOrder = useMemo(() => [...new Set(refs.map((r) => r.provider))], [refs]);
  const view = useMemo(() => overview(inputs, now, sort, agentOrder), [inputs, now, sort, agentOrder]);

  const pick = (v: SortBy) => {
    setSort(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      /* private mode */
    }
  };

  const row = (r: RoomRow<Entry>) => (
    <OverviewRow key={r.input.key} row={r} now={now} best={view.best === r.input.key} open={open === r.input.key} pending={pending.has(r.input.key)} onToggle={() => setOpen((k) => (k === r.input.key ? null : r.input.key))} />
  );

  return (
    <div className="ulo card" data-spot>
      <div className="ulo-head">
        <span className="ulo-count num">
          {view.open.length} of {view.open.length + view.tight.length} with room
        </span>
        <Segmented id="ulo-sort" className="ulo-sort" value={sort} onChange={pick} options={SORTS} />
      </div>
      {/* Only the one column that needs a word: the 5h and 7d tags name the meters, the rows name themselves. */}
      <div className="ulo-cols" aria-hidden>
        <span>Resets in</span>
      </div>
      <div className="ulo-list" role="list">
        {view.open.map(row)}
        {view.tight.length > 0 && (
          <div className="ulo-sep" role="presentation">
            <span>At or near a cap</span>
            <span className="num">{view.tight.length}</span>
          </div>
        )}
        {view.tight.map(row)}
        {view.off.length > 0 && (
          <div className="ulo-sep" role="presentation">
            <span>Not signed in</span>
            <span className="num">{view.off.length}</span>
          </div>
        )}
        {view.off.map(row)}
      </div>
    </div>
  );
}

const OverviewRow = memo(function OverviewRow({ row, now, best, open, pending, onToggle }: { row: RoomRow<Entry>; now: number; best: boolean; open: boolean; pending: boolean; onToggle: () => void }) {
  const { input, state, resetsAt } = row;
  const { ref } = input;
  const plan = planShort(ref.account.auth);
  const [short, week] = cells(input.limits, now);
  const label = `${PROVIDER_NAME[input.provider as ProviderId]}, ${input.name}${row.tight ? `, ${usedText(usedPercent(row.tight, now))}` : ''}${best ? ', least used right now' : ''}`;
  return (
    <div className="ulo-item" role="listitem" data-state={state} data-open={open || undefined}>
      <button type="button" className="ulo-row" aria-expanded={open} aria-label={label} onClick={onToggle}>
        <ProviderMark provider={input.provider} size={14} className="ulo-mark" />
        <span className="ulo-who">
          <span className="ulo-name truncate">{input.name}</span>
          {plan && <span className="ulo-plan truncate">{plan}</span>}
        </span>
        {state === 'off' ? (
          <span className="ulo-none">{ref.info?.installed ? 'Not signed in' : 'Not installed'}</span>
        ) : short || week ? (
          <>
            {short ? <Cell limit={short} now={now} /> : <span />}
            {week ? <Cell limit={week} now={now} /> : <span />}
          </>
        ) : (
          <span className="ulo-none">{input.unmetered ? 'No plan limits' : pending ? 'Reading' : 'No figures yet'}</span>
        )}
        <span className="ulo-reset num" title={resetsAt ? exactTime(resetsAt) : undefined}>
          {resetsAt ? duration(resetsAt - now) : ''}
        </span>
        <Icon name="caret-down" size={12} className="ulo-caret" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="ulo-detail" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 460, damping: 40 }}>
            <AccountLimits refs={ref} pending={pending} inline />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

const level = (pct: number) => (pct >= 100 ? 'red' : pct >= NEAR_AT ? 'amber' : undefined);

/** One window in a row: its length, a thin meter and the percent used. */
function Meter({ tag, pct, label }: { tag: string; pct: number; label: string }) {
  const lv = level(pct);
  return (
    <span className="ulo-cell">
      <span className="ulo-win">{tag}</span>
      <span className="meter ulo-meter" data-level={lv} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={usedText(pct)}>
        <span className="meter-fill" style={{ '--p': Math.max(pct, pct > 0 ? 3 : 0) / 100 } as CSSProperties} />
      </span>
      <span className="ulo-pct num" data-level={lv}>
        {pct}%
      </span>
    </span>
  );
}

function Cell({ limit, now }: { limit: RateLimit; now: number }) {
  const pct = usedPercent(limit, now);
  // A week that is one model's (Fable, Opus) says so on hover.
  return isScopedWindow(limit) ? (
    <Tip label={limit.label}>
      <span className="ulo-cell-tip">
        <Meter tag={windowShort(limit)} pct={pct} label={limit.label} />
      </span>
    </Tip>
  ) : (
    <Meter tag={windowShort(limit)} pct={pct} label={limit.label} />
  );
}

/**
 * How much is used across each agent's accounts, weighted by plan, above the accounts and in their
 * columns: the agent, how many weeks of its largest plan are used of how many, and the 5-hour and
 * weekly windows of all its accounts together as used. Agents with one account have none.
 */
export function LimitsTotals({ refs }: { refs: AccountRef[] }) {
  const inputs = useRoomInputs(refs);
  const now = useNow();
  const totals = useMemo(() => poolTotals(inputs, now), [inputs, now]);
  if (!totals.length) return null;
  return (
    <div className="ult card" data-spot role="list" aria-label="Used across accounts">
      {totals.map((t) => (
        <TotalRow key={t.provider} total={t} />
      ))}
    </div>
  );
}

function TotalRow({ total: t }: { total: PoolTotal }) {
  const said = poolWeeksText(t);
  const mix = t.plans.map((p) => `${p.count} ${p.name}`).join(', ');
  const used = (p: PoolPart) => Math.min(100, Math.round(p.used));
  return (
    <div className="ult-row" role="listitem" aria-label={`${PROVIDER_NAME[t.provider]}: ${said}`}>
      <ProviderMark provider={t.provider} size={14} className="ulo-mark" />
      <span className="ult-who">
        <span className="ulo-name truncate">{PROVIDER_NAME[t.provider]}</span>
        {/* Its plans in words ("1 Max, 2 Pro"); how much of them is used is the meters' to say. */}
        <span className="ult-left num truncate">{mix}</span>
      </span>
      {t.short ? <Meter tag="5h" pct={used(t.short)} label={`5-hour limits of ${t.accounts} accounts`} /> : <span />}
      <Meter tag="7d" pct={used(t.week)} label={`Weekly limits of ${t.accounts} accounts`} />
    </div>
  );
}
