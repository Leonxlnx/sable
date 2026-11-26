import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { AccountInfo, ProviderId, RateLimit, SessionMeta } from '@shared/protocol';
import { planLabel } from '@desk/features/connect/plan';
import { conn } from '@m/lib/conn';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { getState, refreshLimits, setState, useStore } from '@m/lib/store';
import { useNow } from '@m/lib/useNow';
import { resetsText, tightestUse, usedPercent, usedWords, windowLevel } from '@m/lib/usage-words';
import { Icon } from '@m/ui/icons';
import { PROVIDER_NAME, ProviderMark, StatusMark, Tiles } from '@m/ui/marks';
import { Pull } from '@m/ui/Pull';
import { Sheet } from '@m/ui/Sheet';
import { readAll } from './Limits';

const AGENTS: ProviderId[] = ['claude', 'codex', 'opencode', 'demo'];
/** How many of an account's chats are listed under it before "and N more". */
const SHOWN = 4;
const toast = (text: string, level: 'info' | 'success' | 'error' = 'info') => setState({ toast: { text, level, at: Date.now() } });

/** The account a chat runs under: its own, else the agent's built-in one. */
export const accountOf = (s: Pick<SessionMeta, 'accountId'>) => s.accountId ?? 'default';

/** "Max", "Pro": the plan word, when it says more than the agent's or the account's own name. */
function planOf(provider: ProviderId, a: AccountInfo): string | undefined {
  const named = planLabel(a.auth) ?? (a.auth.method === 'local' ? a.auth.plan : undefined);
  return named && named !== PROVIDER_NAME[provider] && named !== a.label ? named : undefined;
}

/** The window an account is nearest its limit in: the one its meter shows. */
function topWindow(list: RateLimit[], now: number): RateLimit | undefined {
  let top: RateLimit | undefined;
  for (const l of list) if (l.percent >= 0 && (!top || usedPercent(l, now) > usedPercent(top, now))) top = l;
  return top;
}

/**
 * Where new chats start: the bridge's `phone.setDefaultAccount` (not on the phone's list in 0.2.38).
 * Until a desktop answers it, the check only says where they start, and a tap says it is set there.
 */
let defaultMissing = false;
async function setDefault(provider: ProviderId, accountId: string): Promise<boolean> {
  if (defaultMissing) return false;
  try {
    await (conn.call as (m: string, p: unknown) => Promise<unknown>)('phone.setDefaultAccount', { provider, accountId });
    return true;
  } catch (err) {
    if (/not available from the phone/i.test((err as Error).message)) {
      defaultMissing = true;
      return false;
    }
    throw err;
  }
}

/**
 * Accounts (2.21): every agent's accounts as the desktop lists them, each with its plan, the meter of
 * the window it is nearest its limit in ("62% used", resets in…), where new chats start (the check),
 * and the chats that run on it now, the working ones first; a chat moves to another account of its
 * agent from here (`session.switchAccount`, the same move the desktop makes: refused while it works).
 * Pull to read every account's limits again. One gutter, flat rows on the ink, the six type sizes.
 */
export function AccountsScreen() {
  const now = useNow();
  const providers = useStore((s) => s.providers);
  const limits = useStore((s) => s.limits);
  const sessions = useStore((s) => s.sessions);
  const connState = useStore((s) => s.conn);
  const desktop = useStore((s) => s.desktop);
  const [moving, setMoving] = useState<string | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    if (getState().conn === 'open') void readAll(false).catch(() => {});
  }, [connState === 'open']);

  const agents = useMemo(() => {
    const byAccount = new Map<string, SessionMeta[]>();
    for (const s of Object.values(sessions)) {
      if (s.archived) continue;
      const k = `${s.provider}:${accountOf(s)}`;
      byAccount.set(k, [...(byAccount.get(k) ?? []), s]);
    }
    const busy = (s: SessionMeta) => (s.status === 'running' || s.status === 'starting' || s.status === 'awaiting' ? 1 : 0);
    for (const list of byAccount.values()) list.sort((a, b) => busy(b) - busy(a) || b.updatedAt - a.updatedAt);
    return AGENTS.map((id) => ({ id, accounts: providers[id]?.accounts ?? [], byAccount })).filter((g) => g.accounts.length > 0);
  }, [providers, sessions]);

  const chat = moving ? sessions[moving] : undefined;
  return (
    <div className="screen accounts">
      <header className="sub-head">
        <button type="button" className="icon-btn back-btn" aria-label="Back" onClick={() => (haptic('tap'), nav.pop())}>
          <Icon name="back" size={22} />
        </button>
        <span className="sub-head-title">Accounts</span>
        <button type="button" className="icon-btn" aria-label="Limits" onClick={() => (haptic('tap'), nav.push({ name: 'limits' }))}>
          <Icon name="gauge" size={21} />
        </button>
      </header>
      <Pull
        className="lm-scroll"
        onRefresh={async () => {
          if (getState().conn !== 'open') return conn.wake();
          await readAll(true).catch(() => {});
          await refreshLimits();
        }}
      >
        {agents.length === 0 ? (
          <p className="lm-empty">{connState === 'open' ? `No agent is set up on ${desktop ?? 'the computer'}.` : `Accounts show when ${desktop ?? 'the computer'} is back.`}</p>
        ) : (
          <div className="lm-body">
            {agents.map(({ id, accounts, byAccount }) => (
              <section key={id} className="lm-agent" aria-label={PROVIDER_NAME[id]}>
                <h2 className="lm-agent-head">
                  <ProviderMark provider={id} size={15} />
                  <span>{PROVIDER_NAME[id]}</span>
                </h2>
                {accounts.map((a) => {
                  const chats = byAccount.get(`${id}:${a.id}`) ?? [];
                  const windows = limits[`${id}:${a.id}`]?.limits ?? a.limits ?? [];
                  const top = topWindow(windows, now);
                  const pct = top ? usedPercent(top, now) : undefined;
                  const plan = planOf(id, a);
                  const several = accounts.length > 1;
                  return (
                    <article key={a.id} className="ac-acct" data-out={!a.auth.loggedIn || undefined}>
                      <div className="ac-head">
                        <div className="ac-names">
                          <span className="ac-name">{several ? a.label : (plan ?? a.label)}</span>
                          <span className="ac-plan">{!a.auth.loggedIn ? 'Signed out' : several ? plan : undefined}</span>
                        </div>
                        {several ? (
                          <button
                            type="button"
                            className="ac-start"
                            role="radio"
                            aria-checked={a.isDefault}
                            aria-label={a.isDefault ? 'New chats start here' : `Start new chats on ${a.label}`}
                            data-on={a.isDefault || undefined}
                            onClick={() => {
                              if (a.isDefault) return;
                              haptic('select');
                              void setDefault(id, a.id).then(
                                (ok) => {
                                  if (!ok) toast(`Choose where new chats start on ${getState().desktop ?? 'the computer'}`);
                                  bump((n) => n + 1);
                                },
                                (err) => (haptic('deny'), toast((err as Error).message, 'error')),
                              );
                            }}
                          >
                            <span className="ac-start-word">{a.isDefault ? 'New chats' : ''}</span>
                            <span className="ac-dot" aria-hidden>
                              {a.isDefault && <Icon name="check" size={13} weight="bold" />}
                            </span>
                          </button>
                        ) : null}
                      </div>
                      {top && pct !== undefined ? (
                        <div className="ac-use">
                          <div className="lm-line">
                            <span className="lm-label">{top.label}</span>
                            <span className="lm-used num">{usedWords(pct)}</span>
                          </div>
                          <span className="lm-meter" data-level={windowLevel(top, now)} role="progressbar" aria-label={top.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                            <span className="lm-fill" style={{ '--p': Math.max(pct, pct > 0 ? 1.5 : 0) / 100 } as CSSProperties} />
                          </span>
                          {resetsText(top.resetsAt, now) && <div className="lm-note num">{capital(resetsText(top.resetsAt, now)!)}{windows.length > 1 ? ` · ${windows.length - 1} more ${windows.length === 2 ? 'window' : 'windows'} in Limits` : ''}</div>}
                        </div>
                      ) : a.auth.loggedIn ? (
                        <p className="lm-none">{tightestUse(windows, now) < 0 && windows.length ? 'No plan limits' : 'Limits not read yet'}</p>
                      ) : null}
                      {chats.length > 0 && (
                        <ul className="ac-chats" aria-label={`Chats on ${a.label}`}>
                          {chats.slice(0, SHOWN).map((s) => (
                            <li key={s.id} className="ac-chat">
                              <button type="button" className="ac-chat-open" onClick={() => (haptic('tap'), nav.chat(s.id))}>
                                <span className="ac-chat-mark">{s.status === 'running' || s.status === 'starting' ? <Tiles size={12} /> : s.status === 'awaiting' ? <StatusMark tone="awaiting" size={10} /> : <i className="ac-chat-dot" />}</span>
                                <span className="ac-chat-title">{s.title}</span>
                              </button>
                              {several && s.status !== 'running' && s.status !== 'starting' && s.status !== 'awaiting' && !s.moving && (
                                <button type="button" className="ac-move" aria-label={`Move ${s.title} to another account`} onClick={() => (haptic('tap'), setMoving(s.id))}>
                                  Move
                                </button>
                              )}
                            </li>
                          ))}
                          {chats.length > SHOWN && <li className="ac-more num">{`and ${chats.length - SHOWN} more`}</li>}
                        </ul>
                      )}
                    </article>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </Pull>
      <MoveSheet chat={chat} onClose={() => setMoving(null)} />
    </div>
  );
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Move a chat to another account of its agent: each of the agent's signed-in accounts with its meter,
 * the one the chat is on checked. The desktop moves it as it does on the computer (the conversation
 * goes with it, or a summary of it) and refuses while the chat works; its words say why.
 */
function MoveSheet({ chat, onClose }: { chat?: SessionMeta; onClose: () => void }) {
  const now = useNow();
  const providers = useStore((s) => s.providers);
  const limits = useStore((s) => s.limits);
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<SessionMeta | undefined>(chat);
  if (chat && chat !== shown) setShown(chat);
  const s = chat ?? shown;
  const accounts = s ? (providers[s.provider]?.accounts ?? []).filter((a) => a.auth.loggedIn) : [];
  const on = s ? accountOf(s) : '';
  return (
    <Sheet open={!!chat} onClose={onClose} label="Move to another account" title={<span className="mp-title">Move to</span>}>
      <div className="mp">
        <div className="mp-models" role="radiogroup" aria-label="Accounts">
          {accounts.map((a) => {
            const top = topWindow(limits[`${s!.provider}:${a.id}`]?.limits ?? a.limits ?? [], now);
            const pct = top ? usedPercent(top, now) : undefined;
            const here = a.id === on;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={here}
                className="mp-row ac-pick"
                data-on={here || undefined}
                aria-busy={busy === a.id || undefined}
                onClick={() => {
                  if (here || busy || !s) return;
                  haptic('select');
                  setBusy(a.id);
                  void conn
                    .call('session.switchAccount', { sessionId: s.id, accountId: a.id })
                    .then(
                      (r) => {
                        const res = r as { ok?: boolean; message?: string; compacting?: boolean };
                        if (res.ok === false) {
                          haptic('deny');
                          toast(res.message ?? 'The chat stays where it is.', 'error');
                          return;
                        }
                        toast(res.compacting ? `Moving to ${a.label} once it has compacted` : `Moved to ${a.label}`, 'success');
                        onClose();
                      },
                      (err) => (haptic('deny'), toast((err as Error).message, 'error')),
                    )
                    .finally(() => setBusy(null));
                }}
              >
                <ProviderMark provider={s!.provider} size={18} />
                <span className="mp-name">{a.label}</span>
                {pct !== undefined && <span className="ac-pick-use num" data-level={top ? windowLevel(top, now) : undefined}>{usedWords(pct)}</span>}
                {here && <Icon name="check" size={17} weight="bold" className="mp-check" />}
              </button>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
