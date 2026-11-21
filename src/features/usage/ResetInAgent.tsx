import { useState, type ReactNode } from 'react';
import { DEFAULT_ACCOUNT, type ProviderId, type ResetRun } from '@shared/protocol';
import { Icon } from '@/icons';
import { cancelResetInAgent, resetInAgent } from '@/state/actions';
import { useLimitLevel } from '@/state/hooks';
import { accountKey, useStore } from '@/state/store';
import { cx, Spinner } from '@/ui';

/**
 * A reset used in the agent's own dialog (Claude Code's `/limit-reset`): Sable opens the account's
 * agent in a console window, the person confirms there, and Sable reads the limits again when it
 * closes. Offered only while a window of the account is full and the agent has such a dialog.
 */
export interface ResetInAgentState {
  /** How it is offered: a window Sable opens, or a command for a terminal. */
  via: 'console' | 'terminal';
  command: string;
  /** The agent's name ("Claude Code"). */
  agent: string;
  /** The attempt under way or its result, when there is one. */
  run?: ResetRun;
  /** The account reads full now. */
  atLimit: boolean;
  /** Its limits are known (else whether it is full cannot be told here; the bridge checks). */
  known: boolean;
}

/** A result is shown this long after its attempt began; a cleared one no longer once the account is full again. */
const RESULT_MS = 30 * 60_000;

export function useResetInAgent(provider: ProviderId | undefined, accountId = DEFAULT_ACCOUNT): ResetInAgentState | undefined {
  const offer = useStore((s) => (provider ? s.providers[provider]?.limitReset : undefined));
  const agent = useStore((s) => (provider ? s.providers[provider]?.name : undefined));
  const run = useStore((s) => (provider ? s.resetRuns[accountKey(provider, accountId)] : undefined));
  const atLimit = useLimitLevel(provider, accountId) === 'cap';
  const known = useStore((s) => {
    if (!provider) return false;
    const key = accountKey(provider, accountId);
    return !!(s.limitReports[key]?.limits?.length || s.limits[key]?.length);
  });
  if (!provider || !offer) return undefined;
  const settled = run && run.state !== 'open' && run.state !== 'reading';
  const stale = settled && (Date.now() - run.startedAt > RESULT_MS || (run.state === 'cleared' && atLimit));
  return { via: offer.via, command: offer.command, agent: agent ?? 'the agent', run: stale ? undefined : run, atLimit, known };
}

/** What the attempt is doing or showed, in one line; undefined when there is nothing to say. */
export function resetRunLine(r: ResetInAgentState): string | undefined {
  switch (r.run?.state) {
    case 'open':
      return `Waiting for ${r.agent}`;
    case 'reading':
      return 'Reading limits';
    case 'cleared':
      return 'Limits cleared';
    case 'unchanged':
      return r.run.message ?? 'No limit was cleared';
    case 'failed':
      return r.run.message ?? `${r.agent} could not be opened`;
    default:
      return undefined;
  }
}

/** The account's id as the bridge takes it (the built-in one goes unnamed). */
const wire = (accountId: string) => (accountId === DEFAULT_ACCOUNT ? undefined : accountId);

/**
 * The action and its progress: "Use a reset in Claude Code"; while the window is open "Waiting for
 * Claude Code" with Cancel; after, what the limits showed. `buttonClass` styles the action (primary
 * where the agent reported offers); `onError` gets what the bridge refused with.
 */
export function ResetInAgentAction({ provider, accountId = DEFAULT_ACCOUNT, state, buttonClass, onError, disabled }: { provider: ProviderId; accountId?: string; state: ResetInAgentState; buttonClass?: string; onError?: (text: string) => void; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  const label = `Use a reset in ${state.agent}`;
  const step = state.run?.state;
  if (step === 'open')
    return (
      <button type="button" className="btn btn-sm" onClick={() => void cancelResetInAgent(provider, wire(accountId)).catch(() => {})}>
        Cancel
      </button>
    );
  if (step === 'reading') return <Spinner size={12} />;
  if (step === 'cleared')
    return (
      <span className="ul-resets-done">
        <Icon name="check" size={13} />
        Limits cleared
      </span>
    );
  if (state.via === 'terminal') return null;
  return (
    <button
      type="button"
      className={cx('btn btn-sm', buttonClass)}
      disabled={asking || disabled}
      onClick={() => {
        setAsking(true);
        onError?.('');
        void resetInAgent(provider, wire(accountId))
          .then((r) => {
            if (!r.ok && r.error) onError?.(r.error);
          })
          .catch((err: Error) => onError?.(err.message || `${state.agent} could not be opened`))
          .finally(() => setAsking(false));
      }}
    >
      {asking && <Spinner size={12} />}
      {label}
    </button>
  );
}

/**
 * The reset in the agent's own dialog as a line under a full window (Settings › Usage, the account
 * glance): `lead` first (the offers the agent reported, when it did), then what the attempt shows,
 * then the action. Primary when the agent reported offers, a quiet secondary action otherwise.
 */
export function ResetInAgentLine({ provider, accountId = DEFAULT_ACCOUNT, state, lead, primary, compact, className }: { provider: ProviderId; accountId?: string; state: ResetInAgentState; lead?: ReactNode; primary?: boolean; compact?: boolean; className?: string }) {
  const [error, setError] = useState<string>();
  const line = state.via === 'terminal' && !state.run ? `Run ${state.command} in a terminal to use a reset` : (error || resetRunLine(state));
  const busy = state.run?.state === 'open' || state.run?.state === 'reading';
  return (
    <div className={cx('ul-resets', className)} data-compact={compact || undefined} role="group" aria-label="Resets">
      {lead}
      {line && state.run?.state !== 'cleared' && (
        <span className="ul-resets-ask" role="status">
          {line}
        </span>
      )}
      <span className="ul-resets-actions">
        <ResetInAgentAction
          provider={provider}
          accountId={accountId}
          state={state}
          buttonClass={primary && !busy ? 'btn-primary' : undefined}
          onError={setError}
        />
      </span>
    </div>
  );
}
