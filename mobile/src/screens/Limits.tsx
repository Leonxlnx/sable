import { useEffect, useState, type CSSProperties } from 'react';
import type { AccountInfo, LimitsReport, ProviderId, RateLimit } from '@shared/protocol';
import { planLabel } from '@desk/features/connect/plan';
import { conn } from '@m/lib/conn';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { getState, refreshLimits, useStore } from '@m/lib/store';
import { useNow } from '@m/lib/useNow';
import { clock, evenPace, paceText, resetsText, tightestUse, usedPercent, usedWords, windowLevel } from '@m/lib/usage-words';
import { Icon } from '@m/ui/icons';
import { PROVIDER_NAME, ProviderMark } from '@m/ui/marks';
import { Pull } from '@m/ui/Pull';

const AGENTS: ProviderId[] = ['claude', 'codex', 'opencode', 'demo'];
/** Limits read longer ago than this say when ("As of 14:02"), and are read again as the screen opens. */
const STALE_MS = 15 * 60_000;

/** The 5-hour window first, then the plan's week, then a model's own windows; as given otherwise. */
export const scoped = (l: RateLimit) => /^model_|^(five_hour|seven_day)_/.test(l.id) || (l.id.includes(':') && !l.id.startsWith('codex:'));
const ordered = (list: RateLimit[]) =>
  list
    .map((l, i) => ({ l, i, r: ((l.windowMins ?? 0) >= 1440 ? 2 : 0) + (scoped(l) ? 1 : 0) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.l);

/** Amber near a cap, red at it: the only colours a limit uses. */
export const levelOf = (l: RateLimit, now: number) => windowLevel(l, now);

const money = (minor: number, currency = 'USD') => (minor / 100).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: minor >= 10_000 ? 0 : 2 });

interface Account {
  account: AccountInfo;
  report?: LimitsReport;
  windows: RateLimit[];
  top: number;
}

/** Every signed-in account that has limits to read: its own agent's, nearest its limit first. */
function useAgents(now: number): { provider: ProviderId; accounts: Account[] }[] {
  const providers = useStore((s) => s.providers);
  const limits = useStore((s) => s.limits);
  const out: { provider: ProviderId; accounts: Account[] }[] = [];
  for (const id of AGENTS) {
    const accounts = (providers[id]?.accounts ?? [])
      .filter((a) => a.auth.loggedIn)
      .map((account) => {
        const report = limits[`${id}:${account.id}`];
        const windows = ordered((report?.limits ?? account.limits ?? []).filter((w) => w.percent >= 0));
        return { account, report, windows, top: report?.planLimits === false ? -2 : tightestUse(windows, now) };
      })
      .sort((a, b) => b.top - a.top);
    if (accounts.length) out.push({ provider: id, accounts });
  }
  return out;
}

/** The desktop reads every signed-in account's limits again (all of them, or those read long ago); its answers arrive as reports. */
export async function readAll(force: boolean, onReading?: (keys: Set<string>) => void) {
  await refreshLimits();
  const st = getState();
  const due: { provider: ProviderId; accountId: string }[] = [];
  for (const id of AGENTS)
    for (const a of st.providers[id]?.accounts ?? []) {
      const r = st.limits[`${id}:${a.id}`];
      if (a.auth.loggedIn && r?.planLimits !== false && (force || !r?.readAt || Date.now() - r.readAt > STALE_MS)) due.push({ provider: id, accountId: a.id });
    }
  if (!due.length) return;
  onReading?.(new Set(due.map((x) => `${x.provider}:${x.accountId}`)));
  await Promise.allSettled(due.map((x) => conn.call('provider.limits', { ...x, ...(force ? { force: true } : {}) })));
  await refreshLimits();
}

/**
 * Limits, in the desktop's usage language (2.18; the sheet of cards it replaces read as cheap): per
 * agent its accounts, nearest their limit first, the one new chats start on with the check; per
 * account each window as one exact row: its name and the share used ("62% used"), one thin meter that
 * fills as it is used (the dithered head; amber near the cap, red at it, the only colours), an even
 * pace's place as a tick on the meter, and under it when it resets and where the pace leads. One
 * gutter, the six type sizes, no cards inside the page. Pull to read every account again.
 */
export function LimitsScreen() {
  const now = useNow();
  const connState = useStore((s) => s.conn);
  const desktop = useStore((s) => s.desktop);
  const limitsAt = useStore((s) => s.limitsAt);
  const agents = useAgents(now);
  const [reading, setReading] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (getState().conn !== 'open') return;
    let live = true;
    void readAll(false, (keys) => live && setReading(keys)).finally(() => live && setReading(new Set()));
    return () => {
      live = false;
    };
  }, [connState === 'open']);

  const known = agents.some((g) => g.accounts.some((a) => a.windows.length || a.report?.planLimits === false));
  const waiting = !limitsAt && connState === 'open' && !known;
  let n = 0;

  return (
    <div className="screen limits">
      <header className="sub-head">
        <button type="button" className="icon-btn back-btn" aria-label="Back" onClick={() => (haptic('tap'), nav.pop())}>
          <Icon name="back" size={22} />
        </button>
        <span className="sub-head-title">Limits</span>
        <button type="button" className="icon-btn" aria-label="Accounts" onClick={() => (haptic('tap'), nav.push({ name: 'accounts' }))}>
          <Icon name="user" size={21} />
        </button>
      </header>
      <Pull
        className="lm-scroll"
        onRefresh={async () => {
          if (getState().conn !== 'open') return conn.wake();
          await readAll(true, setReading).finally(() => setReading(new Set()));
        }}
      >
        {waiting ? (
          <div className="lm-body" aria-busy>
            <AccountSkeleton />
          </div>
        ) : agents.length === 0 ? (
          <p className="lm-empty">{connState === 'open' ? `No agent is signed in on ${desktop ?? 'the computer'}.` : `Limits show when ${desktop ?? 'the computer'} is back.`}</p>
        ) : (
          <div className="lm-body">
            {connState !== 'open' && <p className="lm-away">{`${desktop ?? 'The computer'} is away. These are the limits it last read.`}</p>}
            {agents.map(({ provider, accounts }) => (
              <section key={provider} className="lm-agent" aria-label={PROVIDER_NAME[provider]}>
                <h2 className="lm-agent-head">
                  <ProviderMark provider={provider} size={15} />
                  <span>{PROVIDER_NAME[provider]}</span>
                </h2>
                {accounts.map(({ account, report, windows }) => {
                  const readAt = report?.readAt;
                  const stale = readAt && now - readAt > STALE_MS ? `As of ${clock(readAt, now)}` : undefined;
                  const named = planLabel(account.auth) ?? (account.auth.method === 'local' ? account.auth.plan : undefined);
                  const plan = named && named !== PROVIDER_NAME[provider] && named !== account.label ? named : undefined;
                  const extra = report?.extra?.enabled && report.extra.limit ? report.extra : undefined;
                  const inUse = account.isDefault && accounts.length > 1;
                  return (
                    <article key={account.id} className="lm-acct">
                      <div className="lm-acct-head">
                        <span className="lm-acct-name">{accounts.length > 1 ? account.label : (plan ?? account.label)}</span>
                        {accounts.length > 1 && plan && <span className="lm-acct-plan">{plan}</span>}
                        <span className="lm-acct-aside num">{stale}</span>
                        {inUse && (
                          <span className="lm-in-use" role="img" aria-label="New chats start here">
                            <Icon name="check" size={16} weight="bold" />
                          </span>
                        )}
                      </div>
                      {report?.planLimits === false ? (
                        <p className="lm-none">No plan limits</p>
                      ) : windows.length === 0 && reading.has(`${provider}:${account.id}`) ? (
                        <WindowsSkeleton />
                      ) : windows.length === 0 ? (
                        <p className="lm-none">Not read yet</p>
                      ) : (
                        windows.map((w) => {
                          const pct = usedPercent(w, now);
                          const level = windowLevel(w, now);
                          const pace = paceText(w, report?.pace?.[w.id], now);
                          const reset = resetsText(w.resetsAt, now) ?? (w.resetsAt && w.resetsAt <= now ? `reset at ${clock(w.resetsAt, now)}` : pct === 0 ? 'starts with your next message' : undefined);
                          const tick = evenPace(w, now);
                          return (
                            <div key={w.id} className="lm-win">
                              <div className="lm-line">
                                <span className="lm-label">{w.label}</span>
                                <span className="lm-used num">{usedWords(pct)}</span>
                              </div>
                              <span className="lm-meter" data-level={level} role="progressbar" aria-label={w.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={usedWords(pct)} style={{ '--d': `${n++ * 30}ms` } as CSSProperties}>
                                <span className="lm-fill" style={{ '--p': Math.max(pct, pct > 0 ? 1.5 : 0) / 100 } as CSSProperties} />
                                {tick !== undefined && <i className="lm-tick" style={{ left: `${(tick * 100).toFixed(1)}%` }} aria-hidden />}
                              </span>
                              {(reset || pace) && (
                                <div className="lm-note num">
                                  <span>{reset && reset.charAt(0).toUpperCase() + reset.slice(1)}</span>
                                  {pace && (
                                    <span className="lm-pace" data-warn={pace.warn || undefined}>
                                      {pace.warn && <i className="lm-pace-mark" aria-hidden />}
                                      {pace.text}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                      {extra && (
                        <div className="lm-win">
                          <div className="lm-line">
                            <span className="lm-label">Extra usage</span>
                            <span className="lm-used num">
                              {money(extra.used ?? 0, extra.currency)} <span className="lm-of">of {money(extra.limit!, extra.currency)}</span>
                            </span>
                          </div>
                          <span className="lm-meter" style={{ '--d': `${n++ * 30}ms` } as CSSProperties}>
                            <span className="lm-fill" style={{ '--p': Math.min(1, (extra.used ?? 0) / extra.limit!) } as CSSProperties} />
                          </span>
                        </div>
                      )}
                      {report?.credits?.balance && !report.credits.unlimited && (
                        <div className="lm-line lm-credits">
                          <span className="lm-label">Credits</span>
                          <span className="lm-used num">{report.credits.balance}</span>
                        </div>
                      )}
                    </article>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </Pull>
    </div>
  );
}

/** The shape of one account with two windows, until the desktop answers. */
function AccountSkeleton() {
  return (
    <section className="lm-agent" aria-hidden>
      <h2 className="lm-agent-head">
        <span className="skel" style={{ width: 15, height: 15, borderRadius: 4 }} />
        <span className="skel" style={{ width: 64 }} />
      </h2>
      <article className="lm-acct">
        <div className="lm-acct-head">
          <span className="skel" style={{ width: 96, height: 14 }} />
        </div>
        <WindowsSkeleton />
      </article>
    </section>
  );
}

/** Two windows' place while an account's limits are read. */
function WindowsSkeleton() {
  return (
    <>
      {[0, 1].map((i) => (
        <div key={i} className="lm-win lm-skel" aria-hidden>
          <div className="lm-line">
            <span className="skel" style={{ width: i ? 128 : 84 }} />
            <span className="skel" style={{ width: 64 }} />
          </div>
          <span className="lm-meter" />
          <div className="lm-note">
            <span className="skel" style={{ width: 104, height: 9 }} />
          </div>
        </div>
      ))}
    </>
  );
}
