import { useEffect, useState, type CSSProperties } from 'react';
import type { AccountInfo, LimitPace, LimitsReport, ProviderId, RateLimit } from '@shared/protocol';
import { planLabel } from '@desk/features/connect/plan';
import { resetIn } from '@desk/lib/format';
import { conn } from '@m/lib/conn';
import { getState, refreshLimits, useStore } from '@m/lib/store';
import { useNow } from '@m/lib/useNow';
import { AutoHeight } from '@m/ui/AutoHeight';
import { PROVIDER_NAME, ProviderMark } from '@m/ui/marks';
import { Sheet } from '@m/ui/Sheet';

const AGENTS: ProviderId[] = ['claude', 'codex', 'demo'];
/** Limits read longer ago than this say when ("As of 14:02"). */
const STALE_MS = 15 * 60_000;

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
/** "14:02" today, "Tue 14:02" this week, "17 Nov" later. */
function clock(ts: number, now: number): string {
  if (new Date(ts).toDateString() === new Date(now).toDateString()) return timeOf(ts);
  if (Math.abs(ts - now) < 6 * 86_400_000) return `${new Date(ts).toLocaleDateString('en-GB', { weekday: 'short' })} ${timeOf(ts)}`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The 5-hour window first, then the plan's week, then a model's own windows; as given otherwise. */
export const scoped = (l: RateLimit) => /^model_|^(five_hour|seven_day)_/.test(l.id) || (l.id.includes(':') && !l.id.startsWith('codex:'));
const ordered = (list: RateLimit[]) =>
  list
    .map((l, i) => ({ l, i, r: ((l.windowMins ?? 0) >= 1440 ? 2 : 0) + (scoped(l) ? 1 : 0) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.l);

/** Amber near a cap, red at it: the only colours a limit uses. */
export const levelOf = (l: RateLimit, now: number) => (l.resetsAt && l.resetsAt <= now ? undefined : l.percent >= 100 ? 'red' : l.percent >= 80 ? 'amber' : undefined);

/** Where the window would stand now at an even pace (0..1), when its length and reset are known. */
function elapsed(l: RateLimit, now: number): number | undefined {
  if (!l.windowMins || !l.resetsAt || l.resetsAt <= now) return undefined;
  const len = l.windowMins * 60_000;
  const u = 1 - (l.resetsAt - now) / len;
  return u > 0.02 && u < 0.98 ? u : undefined;
}

/** The quiet line under a window: when it resets, and where the pace leads (amber when it runs out first). */
function notes(l: RateLimit, p: LimitPace | undefined, now: number): { reset?: string; pace?: string; warn?: boolean } {
  const passed = !!l.resetsAt && l.resetsAt <= now;
  const reset = passed ? `Reset at ${clock(l.resetsAt!, now)}` : l.resetsAt ? `Resets in ${resetIn(l.resetsAt, now)}` : Math.round(l.percent) === 0 ? 'Starts with your next message' : undefined;
  if (!p || passed || l.percent >= 100) return { reset };
  if (p.fullAt) return { reset, pace: `Runs out at ${clock(p.fullAt, now)}`, warn: true };
  if (p.atReset !== undefined && p.perHour > 0.01) return { reset, pace: `On pace for ${Math.round(p.atReset)}%` };
  return { reset };
}

const money = (minor: number, currency = 'USD') => (minor / 100).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: minor >= 10_000 ? 0 : 2 });

interface Row {
  provider: ProviderId;
  account: AccountInfo;
  report?: LimitsReport;
  windows: RateLimit[];
  several: boolean;
}

/**
 * Every signed-in account's plan windows, as the desktop last read them: how full, an even-pace
 * tick on each meter, when it resets and where the pace leads. Asked for again as the sheet opens;
 * a skeleton holds the place until the first answer, and what arrives grows the sheet smoothly.
 */
export function LimitsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const providers = useStore((s) => s.providers);
  const limits = useStore((s) => s.limits);
  const limitsAt = useStore((s) => s.limitsAt);
  const connState = useStore((s) => s.conn);
  const desktop = useStore((s) => s.desktop);
  const now = useNow();

  // Accounts whose limits are being read for this opening (their cards hold the windows' place).
  const [reading, setReading] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!open || getState().conn !== 'open') return;
    let live = true;
    void refreshLimits().then(() => {
      if (!live) return;
      // What was never read, or long ago: the desktop reads it now (its answer arrives as `limits.report`).
      const st = getState();
      const stale: { provider: ProviderId; accountId: string }[] = [];
      for (const id of AGENTS)
        for (const a of st.providers[id]?.accounts ?? []) {
          const r = st.limits[`${id}:${a.id}`];
          if (a.auth.loggedIn && r?.planLimits !== false && (!r?.readAt || Date.now() - r.readAt > STALE_MS)) stale.push({ provider: id, accountId: a.id });
        }
      if (!stale.length) return;
      const keys = stale.map((x) => `${x.provider}:${x.accountId}`);
      setReading(new Set(keys));
      void Promise.allSettled(stale.map((x) => conn.call('provider.limits', x))).then(() => {
        if (!live) return;
        void refreshLimits().finally(() => live && setReading(new Set()));
      });
    });
    return () => {
      live = false;
    };
  }, [open]);

  const rows: Row[] = [];
  for (const id of AGENTS) {
    const accounts = (providers[id]?.accounts ?? []).filter((a) => a.auth.loggedIn);
    for (const a of accounts) {
      const report = limits[`${id}:${a.id}`];
      const windows = ordered((report?.limits ?? a.limits ?? []).filter((w) => w.percent >= 0));
      rows.push({ provider: id, account: a, report, windows, several: accounts.length > 1 });
    }
  }

  const waiting = !limitsAt && connState === 'open' && !rows.some((r) => r.windows.length);
  let n = 0;
  return (
    <Sheet open={open} onClose={onClose} title="Limits">
      <AutoHeight className="lim-wrap">
        {waiting ? (
          <div className="lim" aria-busy>
            <LimitSkeleton />
          </div>
        ) : rows.length === 0 ? (
          <p className="lim-empty">{connState === 'open' ? `No agent is signed in on ${desktop ?? 'the computer'}.` : `Limits show when ${desktop ?? 'the computer'} is back.`}</p>
        ) : (
          <div className="lim">
            {rows.map(({ provider, account, report, windows, several }) => {
              const readAt = report?.readAt;
              const stale = readAt && now - readAt > STALE_MS ? `As of ${clock(readAt, now)}` : undefined;
              const named = planLabel(account.auth) ?? (account.auth.method === 'local' ? account.auth.plan : undefined);
              const plan = named && named !== PROVIDER_NAME[provider] ? named : undefined;
              const extra = report?.extra?.enabled && report.extra.limit ? report.extra : undefined;
              return (
                <section key={`${provider}:${account.id}`} className="lim-card">
                  <header className="lim-head">
                    <ProviderMark provider={provider} size={16} />
                    <span className="lim-name">{several ? account.label : PROVIDER_NAME[provider]}</span>
                    {plan && <span className="lim-plan">{plan}</span>}
                    <span className="lim-aside">{stale ?? (several && account.isDefault ? 'Default' : '')}</span>
                  </header>
                  {report?.planLimits === false ? (
                    <p className="lim-none">No plan limits</p>
                  ) : windows.length === 0 && reading.has(`${provider}:${account.id}`) ? (
                    <WindowsSkeleton />
                  ) : windows.length === 0 ? (
                    <p className="lim-none">Not read yet</p>
                  ) : (
                    windows.map((w) => {
                      const p = Math.min(1, Math.max(0, w.percent / 100));
                      const note = notes(w, report?.pace?.[w.id], now);
                      const tick = elapsed(w, now);
                      return (
                        <div key={w.id} className="lim-win" data-level={levelOf(w, now)}>
                          <div className="lim-line">
                            <span className="lim-label">{w.label}</span>
                            <span className="lim-pct num">
                              {Math.round(w.percent)}
                              <small>%</small>
                            </span>
                          </div>
                          <div className="lim-meter" style={{ '--p': p, '--d': `${n++ * 40}ms` } as CSSProperties}>
                            <span className="lim-fill" />
                            {tick !== undefined && <i className="lim-tick" style={{ left: `${(tick * 100).toFixed(1)}%` }} aria-hidden />}
                          </div>
                          {(note.reset || note.pace) && (
                            <div className="lim-note num">
                              <span>{note.reset}</span>
                              {note.pace && <span data-warn={note.warn || undefined}>{note.pace}</span>}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                  {extra && (
                    <div className="lim-win lim-extra">
                      <div className="lim-line">
                        <span className="lim-label">Extra usage</span>
                        <span className="lim-money num">
                          {money(extra.used ?? 0, extra.currency)} <small>of {money(extra.limit!, extra.currency)}</small>
                        </span>
                      </div>
                      <div className="lim-meter" style={{ '--p': Math.min(1, (extra.used ?? 0) / extra.limit!), '--d': `${n++ * 40}ms` } as CSSProperties}>
                        <span className="lim-fill" />
                      </div>
                    </div>
                  )}
                  {report?.credits?.balance && !report.credits.unlimited && (
                    <div className="lim-credits">
                      <span className="lim-label">Credits</span>
                      <span className="num">{report.credits.balance}</span>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </AutoHeight>
    </Sheet>
  );
}

/** The shape of one account with two windows, until the desktop answers. */
function LimitSkeleton() {
  return (
    <section className="lim-card lim-skel" aria-hidden>
      <header className="lim-head">
        <span className="skel lim-skel-mark" />
        <span className="skel" style={{ width: 112 }} />
      </header>
      <WindowsSkeleton />
    </section>
  );
}

/** Two windows' place while an account's limits are read. */
function WindowsSkeleton() {
  return (
    <>
      {[0, 1].map((i) => (
        <div key={i} className="lim-win lim-skel" aria-hidden>
          <div className="lim-line">
            <span className="skel" style={{ width: i ? 64 : 52 }} />
            <span className="skel" style={{ width: 34 }} />
          </div>
          <div className="lim-meter" />
          <div className="lim-note">
            <span className="skel" style={{ width: 96, height: 9 }} />
          </div>
        </div>
      ))}
    </>
  );
}
