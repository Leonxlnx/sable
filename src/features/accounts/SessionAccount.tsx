import { useState } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { DEFAULT_ACCOUNT, type AccountInfo, type RateLimit } from '@shared/protocol';
import { resetsText, windowState } from '@/features/usage/words';
import { limitTitle, useSessionLimits } from '@/features/usage/scope';
import { Icon } from '@/icons';
import { openSettings, switchSessionAccount } from '@/state/actions';
import { accountName } from '@/state/hooks';
import { useStore } from '@/state/store';
import { Spinner, Tip } from '@/ui';
import { AccountUsed, planOf } from './ManyAccounts';

/** "used up", "82% used": the share used, as everywhere (`usage/words.ts`). */
const stateOf = (l: RateLimit) => windowState(l, Date.now());

/**
 * The account a session runs under, quietly in the session's header, only when its agent has more
 * than one. It opens the other accounts: picking one continues this conversation there.
 *
 * Its mark follows the windows that hold back this chat's model (every model's windows and its
 * own): another model's window at its cap (a sub-agent on Fable hit Fable's week) is a quiet ring,
 * named in the menu with its reset, never red for the whole account.
 */
export function SessionAccount({ sessionId }: { sessionId: string }) {
  const provider = useStore((s) => s.sessions[sessionId]?.provider);
  const accountId = useStore((s) => s.sessions[sessionId]?.accountId ?? DEFAULT_ACCOUNT);
  const accounts = useStore((s) => (provider ? s.providers[provider]?.accounts : undefined));
  const [picked, setMoving] = useState<string | null>(null);
  // The bridge says the chat moves for as long as it does (a compaction first can take minutes, long
  // after the pick was answered); the pick itself shows until that word comes.
  const movingNow = useStore((s) => !!s.sessions[sessionId]?.moving);
  const moving = picked ?? (movingNow ? accountId : null);
  const lim = useSessionLimits(sessionId);
  if (!provider || !accounts || accounts.length < 2) return null;
  const current = accounts.find((a) => a.id === accountId);
  const name = accountName(current);

  const level = lim?.level === 'cap' ? 'red' : lim?.level === 'near' ? 'amber' : lim?.otherCap ? 'other' : undefined;
  const rows = lim ? [...lim.own, ...lim.other] : [];
  const goesOn = !!lim?.model && lim.level !== 'cap' && lim.other.some((l) => l.percent >= 100);
  const said = rows.map((l) => `${limitTitle(l.label)} ${stateOf(l)}`).join(', ');
  const tip = said ? `${name}: ${said}${goesOn ? `. ${lim!.model} is not limited` : ''}` : name;
  const menu = { sessionId, provider, accountId, accounts, lim, rows, goesOn, name, moving, setMoving };

  return (
    <RM.Root modal={false}>
      <Tip label={tip}>
        <RM.Trigger asChild>
          <button type="button" className="sa-trigger" aria-label={`Account: ${tip}. Continue with another account`}>
            <Icon name="user" size={13} />
            <span className="truncate">{name}</span>
            {level && <span className="limit-dot" data-level={level} aria-hidden />}
            {moving && <Spinner size={11} />}
          </button>
        </RM.Trigger>
      </Tip>
      <RM.Portal>
        <RM.Content className="pop sa-pop" data-spot side="bottom" align="start" sideOffset={6} collisionPadding={10} style={{ width: 300 }} loop>
          <SessionAccountMenu {...menu} />
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

type MenuProps = {
  sessionId: string;
  provider: NonNullable<ReturnType<typeof useSessionLimits>>['provider'] & string;
  accountId: string;
  accounts: AccountInfo[];
  lim: ReturnType<typeof useSessionLimits>;
  rows: RateLimit[];
  goesOn: boolean;
  name: string;
  moving: string | null;
  setMoving: (id: string | null) => void;
};

/**
 * The menu's rows, built only while it is open: the trigger re-renders with the session (a turn
 * starting or ending), and its closed menu should cost nothing then. Whether a turn runs is read
 * here for the same reason.
 */
function SessionAccountMenu({ sessionId, provider, accountId, accounts, lim, rows, goesOn, name, moving, setMoving }: MenuProps) {
  // A move is refused while the agent works, also by sub-agents in the background: nothing offers it then.
  const busy = useStore((s) => {
    const m = s.sessions[sessionId];
    const st = m?.status;
    return st === 'running' || st === 'awaiting' || st === 'starting' || (m?.background ?? 0) > 0;
  });
  return (
    <>
          {rows.length > 0 && (
            <>
              <div className="sa-limits" role="group" aria-label={`Limits of ${name}`}>
                {rows.map((l) => {
                  const mine = lim!.own.includes(l);
                  const tone = mine ? (l.percent >= 100 ? 'red' : 'amber') : 'other';
                  return (
                    <div key={l.id} className="sa-limit">
                      <span className="limit-dot" data-level={tone} aria-hidden />
                      <span className="sa-limit-text">
                        {limitTitle(l.label)} {stateOf(l)}
                      </span>
                      {resetsText(l.resetsAt, Date.now()) && <span className="sa-limit-reset num">{resetsText(l.resetsAt, Date.now())}</span>}
                    </div>
                  );
                })}
                {goesOn && (
                  <div className="sa-limit-note">
                    {lim!.model} is not limited. This chat goes on under {name}.
                  </div>
                )}
              </div>
              <RM.Separator className="menu-sep" />
            </>
          )}
          <RM.Label className="menu-label">Continue with</RM.Label>
          {accounts.map((a) => {
            const here = a.id === accountId;
            // (A sign-in not known yet says nothing: it is not signed out.)
            const plan = a.auth.loggedIn ? planOf(a) : a.auth.checking ? '' : 'Signed out';
            return (
              <RM.Item
                key={a.id}
                className="menu-item acs-row"
                disabled={here || busy || !a.auth.loggedIn || !!moving}
                data-current={here || undefined}
                onSelect={() => {
                  setMoving(a.id);
                  void switchSessionAccount(sessionId, a.id).finally(() => setMoving(null));
                }}
              >
                <span className="acs-name truncate">{accountName(a)}</span>
                <span className="acs-plan">{plan}</span>
                {a.auth.loggedIn ? <AccountUsed provider={provider} accountId={a.id} model={lim ? { id: lim.modelId, name: lim.model } : undefined} /> : <span className="acs-used" aria-hidden />}
                <span className="acs-end">{here && <Icon name="check" size={14} className="acs-check" />}</span>
              </RM.Item>
            );
          })}
          <RM.Separator className="menu-sep" />
          <RM.Item className="menu-item" onSelect={() => openSettings('accounts')}>
            <Icon name="settings" size={16} />
            <span className="grow">Manage accounts</span>
          </RM.Item>
    </>
  );
}
