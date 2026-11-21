import { useEffect, useRef, useState } from 'react';
import { DEFAULT_ACCOUNT, type LimitsMeta, type ProviderId, type RateLimit, type ResetOffer, type ResetOutcome } from '@shared/protocol';
import { useNow } from '@/lib/useNow';
import { readLimitsNow, spendLimitReset } from '@/state/actions';
import { accountName, useLimitsReport } from '@/state/hooks';
import { useStore } from '@/state/store';
import { cx, Tip } from '@/ui';
import { DATE_LOCALE, exactTime } from './format';
import { ResetInAgentLine, useResetInAgent } from './ResetInAgent';

/** "2 resets", "1 reset". */
export const resetsText = (n: number) => `${n} ${n === 1 ? 'reset' : 'resets'}`;

/** The window a reset is offered on: the weekly one when it restores several (it restores them all). */
export function resetTarget(limits: RateLimit[] | undefined, windows: string[] | undefined): RateLimit | undefined {
  const own = (limits ?? []).filter((l) => !windows?.length || windows.includes(l.id));
  return own.find((l) => (l.windowMins ?? 0) >= 10_080) ?? own[own.length - 1];
}

/** The window a reset in the agent's own dialog is offered on: the weekly one when it is full, else the first full one (or the last known, while one runs). */
export function fullTarget(limits: RateLimit[] | undefined, now = Date.now()): RateLimit | undefined {
  const full = (limits ?? []).filter((l) => l.percent >= 100 && !(l.resetsAt && l.resetsAt <= now));
  return full.find((l) => (l.windowMins ?? 0) >= 10_080) ?? full[0] ?? resetTarget(limits, undefined);
}

/** How a window is named inside a sentence: "the weekly limit", "the 5-hour limit". */
export function windowPhrase(l: RateLimit | undefined): string {
  if (!l) return 'the limits';
  if ((l.windowMins ?? 0) >= 10_080) return 'the weekly limit';
  const label = l.label.replace(/\s*·.*$/, '');
  return `the ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** What came back, in one line, when it was not a reset. */
const OUTCOME: Record<Exclude<ResetOutcome, 'reset'>, string> = {
  nothingToReset: 'Nothing to reset right now',
  noCredit: 'No resets left',
  alreadyRedeemed: 'That reset was already used',
};

type Resets = NonNullable<LimitsMeta['resets']>;

/** The account's resets while the agent reports some; undefined otherwise. */
export function useResetOffers(provider: ProviderId, accountId = DEFAULT_ACCOUNT): Resets | undefined {
  const report = useLimitsReport(provider, accountId);
  return report?.resets?.available ? report.resets : undefined;
}

/** The account's resets that Sable can use (Codex's, the Demo's); undefined otherwise. */
export function useResets(provider: ProviderId, accountId = DEFAULT_ACCOUNT): Resets | undefined {
  const resets = useResetOffers(provider, accountId);
  return resets && resets.spendable !== false ? resets : undefined;
}

/** Where an agent's resets are used when Sable cannot use them itself. */
const USE_AT: Partial<Record<ProviderId, { url: string; name: string }>> = {
  claude: { url: 'https://claude.ai/settings/usage', name: 'claude.ai' },
};

const KIND: Record<NonNullable<ResetOffer['kind']>, string> = { full: 'full reset', weekly: 'weekly reset', session: '5-hour reset' };

/** "1 full reset", "2 weekly resets", "1 reset". */
const offerName = (o: ResetOffer) => {
  const word = o.kind ? KIND[o.kind] : 'reset';
  return `${o.left} ${o.left === 1 ? word : `${word}s`}`;
};

/** "until 10 Dec" ("until 10 Dec 2027" in another year). */
export const untilText = (at: number, now = Date.now()) =>
  `until ${new Date(at).toLocaleDateString(DATE_LOCALE, { day: 'numeric', month: 'short', ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) })}`;

/**
 * What an account's resets are, in one line: each kind with its uses left and when it ends ("1 full
 * reset, until 10 Dec"), at most two kinds named; a plain count when the agent says no more.
 */
export function offersText(resets: Resets, now = Date.now()): string {
  const live = (resets.offers ?? []).filter((o) => o.left > 0 && !o.paused && (!o.expiresAt || o.expiresAt > now)).sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  if (!live.length) return resetsText(resets.available);
  const named = live.slice(0, 2).map((o) => (o.expiresAt ? `${offerName(o)}, ${untilText(o.expiresAt, now)}` : offerName(o)));
  const rest = live.slice(2).reduce((n, o) => n + o.left, 0);
  return [...named, ...(rest ? [`${rest} more`] : [])].join(' · ');
}

/** The soonest end among the offers, for the line's tooltip. */
const firstEnd = (resets: Resets, now: number) =>
  (resets.offers ?? []).map((o) => o.expiresAt).filter((t): t is number => !!t && t > now).sort((a, b) => a - b)[0];

/** One reset attempt's key: kept while the same confirmation retries, new for the next one. */
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * The reset an account was granted, under the window it applies to: how many there are and a
 * Reset button. A click asks first, naming the account, the window and what it spends; only the
 * confirmation calls the agent. Rendered only where the agent reports resets.
 */
export function LimitReset({ provider, accountId = DEFAULT_ACCOUNT, limit, compact, className }: { provider: ProviderId; accountId?: string; limit: RateLimit; compact?: boolean; className?: string }) {
  const offered = useResetOffers(provider, accountId);
  const inAgent = useResetInAgent(provider, accountId);
  const now = useNow();
  const account = useStore((s) => s.providers[provider]?.accounts?.find((a) => a.id === accountId));
  const [step, setStep] = useState<'idle' | 'ask' | 'busy'>('idle');
  const [note, setNote] = useState<string>();
  const key = useRef<string>('');
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (step === 'ask') confirmRef.current?.focus();
  }, [step]);

  // At a limit (or while one runs), a reset in the agent's own dialog: primary when the agent
  // reported offers (what they are leads the line), a quiet action otherwise.
  const viaAgent = inAgent && (inAgent.atLimit || inAgent.run) && (!offered || offered.spendable === false);
  if (!offered && !viaAgent && step === 'idle' && !note) return null;
  if (viaAgent && !offered) return <ResetInAgentLine provider={provider} accountId={accountId} state={inAgent} compact={compact} className={className} />;
  // Granted, but only the agent's own app can use them: what they are, and where to use one.
  if (offered && offered.spendable === false) {
    const where = USE_AT[provider];
    const end = firstEnd(offered, now);
    const text = (
      <span className="ul-resets-count num" tabIndex={end ? 0 : undefined}>
        {offersText(offered, now)}
      </span>
    );
    if (viaAgent) return <ResetInAgentLine provider={provider} accountId={accountId} state={inAgent} lead={end ? <Tip label={`Ends ${exactTime(end)}`} side="bottom">{text}</Tip> : text} primary compact={compact} className={className} />;
    return (
      <div className={cx('ul-resets', className)} data-compact={compact || undefined} role="group" aria-label="Resets">
        {end ? (
          <Tip label={`Ends ${exactTime(end)}`} side="bottom">
            {text}
          </Tip>
        ) : (
          text
        )}
        {where && (
          <a className="btn btn-sm ul-resets-btn" href={where.url} target="_blank" rel="noreferrer">
            Use on {where.name}
          </a>
        )}
      </div>
    );
  }
  const resets = offered;
  const n = resets?.available ?? 0;
  const name = account?.label || (account ? accountName(account) : 'Main');
  const question = `Use 1 of ${n} ${n === 1 ? 'reset' : 'resets'} on ${windowPhrase(limit)} of ${name}?`;

  const run = async () => {
    setStep('busy');
    try {
      const { outcome } = await spendLimitReset(provider, accountId === DEFAULT_ACCOUNT ? undefined : accountId, key.current);
      setNote(outcome === 'reset' ? undefined : OUTCOME[outcome]);
      void readLimitsNow(provider, accountId === DEFAULT_ACCOUNT ? undefined : accountId);
      key.current = '';
      setStep('idle');
    } catch (err) {
      // The same key on a retry never spends a second reset.
      setNote(err instanceof Error && err.message ? err.message : 'The reset did not go through');
      setStep('ask');
    }
  };

  return (
    <div className={cx('ul-resets', className)} data-compact={compact || undefined} data-step={step} role="group" aria-label="Resets">
      {step === 'idle' ? (
        <>
          <span className="ul-resets-count num">{note ?? (resets ? offersText(resets, now) : resetsText(n))}</span>
          {n > 0 && (
            <button
              type="button"
              className="btn btn-sm ul-resets-btn"
              onClick={() => {
                key.current ||= newKey();
                setNote(undefined);
                setStep('ask');
              }}
            >
              Reset
            </button>
          )}
        </>
      ) : (
        <>
          <span className="ul-resets-ask">{note && step === 'ask' ? note : question}</span>
          <span className="ul-resets-actions">
            <button type="button" className="btn btn-sm" disabled={step === 'busy'} onClick={() => (setStep('idle'), setNote(undefined))}>
              Cancel
            </button>
            <button ref={confirmRef} type="button" className="btn btn-sm btn-primary" disabled={step === 'busy'} aria-label={question} onClick={() => void run()}>
              {step === 'busy' ? 'Resetting' : 'Use reset'}
            </button>
          </span>
        </>
      )}
    </div>
  );
}
