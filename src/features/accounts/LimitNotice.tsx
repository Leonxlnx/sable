import { memo, useRef, useState } from 'react';
import { DEFAULT_ACCOUNT, type NoticeItem } from '@shared/protocol';
import { PROVIDER_NAME } from '@/art/Logo';
import { Icon } from '@/icons';
import { useNow } from '@/lib/useNow';
import { continueAtReset, spendLimitReset, switchSessionAccount } from '@/state/actions';
import { SpareClock } from '@/features/composer/SpareStrip';
import { offersText, useResetOffers, useResets } from '@/features/usage/LimitReset';
import { ResetInAgentAction, resetRunLine, useResetInAgent } from '@/features/usage/ResetInAgent';
import { accountName } from '@/state/hooks';
import { useStore } from '@/state/store';
import { Spinner } from '@/ui';
import { resetsLine } from '@/features/usage/words';
import { limitTitle } from '@/features/usage/scope';

/** "5-hour limit" stays as it is; a model's week reads "Fable weekly limit", the whole plan's "weekly limit". */
function windowName(window?: string) {
  const title = limitTitle(window);
  return /^weekly/i.test(title) || /^(5-hour|plan)/i.test(title) ? title.replace(/^(\S)/, (c) => c.toLowerCase()) : title;
}

/** When a window resets, as every limit says it (`usage/words.ts`): "Resets in 3h 20m", "Resets Tue 14:00". */
export function resetLine(resetsAt: number | undefined, now: number): string | undefined {
  return resetsLine(resetsAt, now);
}

/**
 * A turn the account's plan limit refused: which account, when the window resets, and, when
 * another signed-in account of the agent has room, one button to carry on with it (the same
 * conversation, the same message). Mounted by the timeline's Notice for notices with `limit`.
 */
export const LimitNotice = memo(function LimitNotice({ item, sessionId }: { item: NoticeItem; sessionId?: string }) {
  const fallbackSession = useStore((s) => s.ui.activeSessionId);
  const sid = sessionId ?? fallbackSession;
  // Until the bridge has said which account refused it (it does as it decides), it is the chat's own.
  const ownProvider = useStore((s) => (sid && !item.limit?.provider ? s.sessions[sid]?.provider : undefined));
  const ownAccount = useStore((s) => (sid && !item.limit?.provider ? s.sessions[sid]?.accountId : undefined));
  const limit = ownProvider ? { ...item.limit!, provider: ownProvider, accountId: ownAccount } : item.limit!;
  const now = useNow();
  const provider = limit.provider;
  const accounts = useStore((s) => (provider ? s.providers[provider]?.accounts : undefined));
  const busy = useStore((s) => (sid ? s.sessions[sid]?.status === 'running' || s.sessions[sid]?.status === 'starting' : false));
  const [moving, setMoving] = useState(false);

  const self = accounts?.find((a) => a.id === (limit.accountId ?? DEFAULT_ACCOUNT));
  const next = accounts?.find((a) => a.id === limit.next);
  // Moving there by itself (continue at a limit): no button for what happens anyway.
  const offer = !limit.moving ? next : undefined;
  const auto = limit.moving && !limit.continuedWith && next ? next : undefined;
  const went = limit.continuedWith ? accounts?.find((a) => a.id === limit.continuedWith) : undefined;

  const who = accounts && accounts.length > 1 && self ? accountName(self) : provider ? PROVIDER_NAME[provider] : 'This account';
  const reset = resetLine(limit.resetsAt, now);

  // Spare: with no other account to go on with, the chat can wait for this window's reset and carry on then.
  const waiting = useStore((s) => (sid ? !!s.sessions[sid]?.spare : false));
  const [pinning, setPinning] = useState(false);
  const canWait = !offer && !auto && !limit.continuedWith && !!sid && !waiting && !!limit.resetsAt;
  const waitButton = canWait && (
    <button
      type="button"
      className="btn btn-sm lim-go"
      disabled={pinning || busy}
      onClick={() => {
        setPinning(true);
        void continueAtReset(sid!, item.id).finally(() => setPinning(false));
      }}
    >
      {pinning ? <Spinner size={12} /> : <SpareClock size={14} />}
      {limit.resetsAt! > now ? 'Continue at reset' : 'Continue now'}
    </button>
  );

  // A reset the agent granted this account: one action, asked first, never spent without the click.
  const resets = useResets(provider ?? 'demo', limit.accountId ?? DEFAULT_ACCOUNT);
  const [ask, setAsk] = useState<'idle' | 'ask' | 'busy' | 'done'>('idle');
  const [resetNote, setResetNote] = useState<string>();
  const attempt = useRef('');
  const canReset = !!provider && !limit.continuedWith && (!!resets || ask !== 'idle');
  const n = resets?.available ?? 0;
  const question = `Use 1 of ${n} ${n === 1 ? 'reset' : 'resets'} on the ${windowName(limit.window)} of ${self?.label || (self ? accountName(self) : 'Main')}?`;
  const spend = async () => {
    if (!provider) return;
    setAsk('busy');
    attempt.current ||= globalThis.crypto?.randomUUID?.() ?? String(Date.now());
    try {
      const { outcome } = await spendLimitReset(provider, limit.accountId && limit.accountId !== DEFAULT_ACCOUNT ? limit.accountId : undefined, attempt.current);
      attempt.current = '';
      setResetNote(outcome === 'reset' ? undefined : outcome === 'noCredit' ? 'No resets left' : outcome === 'nothingToReset' ? 'Nothing to reset right now' : 'That reset was already used');
      setAsk(outcome === 'reset' ? 'done' : 'idle');
    } catch (err) {
      setResetNote(err instanceof Error && err.message ? err.message : 'The reset did not go through');
      setAsk('ask');
    }
  };

  // A reset in the agent's own dialog (Claude Code): the person confirms in its window; Sable reads the
  // limits again when it closes. Primary when the agent reported offers; a quiet action otherwise,
  // since the account may have one Sable cannot see. Not offered once the account reads clear.
  const accountId = limit.accountId ?? DEFAULT_ACCOUNT;
  const inAgent = useResetInAgent(provider, accountId);
  const agentOffers = useResetOffers(provider ?? 'demo', accountId);
  const [agentError, setAgentError] = useState<string>();
  const viaAgent = !!inAgent && !!provider && !limit.continuedWith && !resets && (inAgent.atLimit || !inAgent.known || !!inAgent.run);
  const agentRun = viaAgent ? inAgent.run?.state : undefined;
  const agentLine = viaAgent ? agentError || (agentRun === 'cleared' ? undefined : resetRunLine(inAgent)) : undefined;
  const agentBusy = agentRun === 'open' || agentRun === 'reading';
  // What the account's resets are, when the agent said ("1 full reset, until 10 Dec").
  const offersLine = viaAgent && agentOffers ? offersText(agentOffers, now) : undefined;
  const moveButton = offer && sid && (
    <button
      type="button"
      className="btn btn-sm lim-go"
      disabled={moving || busy}
      onClick={() => {
        setMoving(true);
        void switchSessionAccount(sid, offer.id, true, item.id).finally(() => setMoving(false));
      }}
    >
      {moving ? <Spinner size={12} /> : <Icon name="arrow-right" size={14} />}
      Continue with {accountName(offer)}
    </button>
  );
  const agentAction = viaAgent && inAgent.via === 'console' && (
    <ResetInAgentAction provider={provider} accountId={accountId} state={inAgent} buttonClass={agentOffers && !agentBusy ? 'btn-primary' : 'lim-reset'} onError={setAgentError} disabled={busy} />
  );

  if (canReset && ask !== 'idle' && ask !== 'done')
    return (
      <div className="lim" role="status">
        <Icon name="hourglass" size={16} className="lim-icon" />
        <div className="lim-body">
          <div className="lim-text">{question}</div>
          {resetNote && <div className="lim-detail">{resetNote}</div>}
        </div>
        <span className="lim-ask">
          <button type="button" className="btn btn-sm" disabled={ask === 'busy'} onClick={() => (setAsk('idle'), setResetNote(undefined))}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={ask === 'busy'} autoFocus onClick={() => void spend()}>
            {ask === 'busy' ? <Spinner size={12} /> : null}
            Use reset
          </button>
        </span>
      </div>
    );

  return (
    <div className="lim" role="status" data-done={limit.continuedWith || ask === 'done' || agentRun === 'cleared' ? '' : undefined}>
      <Icon name="hourglass" size={16} className="lim-icon" />
      <div className="lim-body">
        <div className="lim-text">
          {limitTitle(limit.window)} reached on {who}
        </div>
        {(resetNote || agentLine || reset || item.detail) && <div className="lim-detail">{resetNote ?? agentLine ?? (reset && offersLine ? `${reset} · ${offersLine}` : reset) ?? item.detail}</div>}
        {item.limit?.provider && !limit.next && !limit.continuedWith && !limit.moving && <div className="lim-detail">No other account has room</div>}
        {viaAgent && inAgent.via === 'terminal' && !agentRun && <div className="lim-detail">Run {inAgent.command} in a terminal to use a reset</div>}
      </div>
      {ask === 'done' ? (
        <span className="lim-went">
          <Icon name="check" size={13} />
          Limit reset
        </span>
      ) : auto ? (
        <span className="lim-went">
          <Spinner size={12} />
          Continuing with {accountName(auto)}
        </span>
      ) : canReset && n > 0 ? (
        <span className="lim-ask">
          <button type="button" className="btn btn-sm lim-reset" disabled={busy} onClick={() => (setResetNote(undefined), setAsk('ask'))}>
            Use a reset
          </button>
          {moveButton}
          {waitButton}
        </span>
      ) : agentRun === 'cleared' ? (
        <span className="lim-went">
          <Icon name="check" size={13} />
          Limits cleared
        </span>
      ) : agentAction ? (
        <span className="lim-ask">
          {agentOffers && agentAction}
          {!agentBusy && moveButton}
          {!agentBusy && waitButton}
          {!agentOffers && agentAction}
        </span>
      ) : limit.continuedWith ? (
        <span className="lim-went">
          <Icon name="check" size={13} />
          {limit.atReset ? 'Continued at reset' : `Continued with ${went ? accountName(went) : 'another account'}`}
        </span>
      ) : waitButton ? (
        waitButton
      ) : (
        moveButton
      )}
    </div>
  );
});
