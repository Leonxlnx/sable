import { useEffect } from 'react';
import type { ProviderId } from '@shared/protocol';
import { ConnectCard } from '@/features/connect/Connect';
import { connectableAgents } from '@/features/connect/plan';
import { Icon } from '@/icons';
import { refreshLimits, setSettings } from '@/state/actions';
import { useStore } from '@/state/store';
import { Switch } from '@/ui';
import { CreditsSetting } from '@/features/usage/Limits';
import { accountName } from '@/state/hooks';
import { AccountCaps } from '@/features/accounts/Caps';
import '@/features/accounts/accounts.css';

export function Accounts() {
  const providers = useStore((s) => s.providers);
  const ready = useStore((s) => s.ready);
  const carryOn = useStore((s) => !!s.settings.continueAtLimit);
  const resumeAtReset = useStore((s) => !!s.settings.continueAtReset);
  const notifyReset = useStore((s) => !!s.settings.notifyLimitReset);
  const backHome = useStore((s) => !!s.settings.returnToPreferred);
  const useFirst = useStore((s) => s.settings.accountsBy !== 'manual');
  const order = connectableAgents(providers);

  // Fresh limits for every signed-in account, once per visit (and when one signs in).
  const signedIn = order.flatMap((id) => (providers[id]?.accounts ?? []).filter((a) => a.auth.loggedIn).map((a) => `${id}/${a.id}`)).join(',');
  useEffect(() => {
    if (!ready) return;
    for (const key of signedIn.split(',').filter(Boolean)) {
      const [provider, accountId] = key.split('/') as [ProviderId, string];
      void refreshLimits(provider, accountId);
    }
  }, [ready, signedIn]);

  // A page of equals: every agent's "Sign in" has one look (no bright button for whichever comes first).
  return (
    <div className="set-stack">
      <div className="acct-list">
        {order.map((id) => (
          <ConnectCard key={id} provider={id} />
        ))}
      </div>
      <AccountCaps agents={order} />
      {/* One card, a row each, in the measures of a row on every other page (settings.css `.set-row`). */}
      <div className="card set-card" data-spot>
        <label className="set-row">
          <span className="set-row-text">
            <span className="set-row-label">Continue with the next account at a limit</span>
          </span>
          <span className="set-row-control">
            <Switch checked={carryOn} onChange={(v) => void setSettings({ continueAtLimit: v })} label="Continue with the next account at a limit" />
          </span>
        </label>
        <label className="set-row">
          <span className="set-row-text">
            <span className="set-row-label">Continue when the usage resets</span>
          </span>
          <span className="set-row-control">
            <Switch checked={resumeAtReset} onChange={(v) => void setSettings({ continueAtReset: v })} label="Continue when the usage resets" />
          </span>
        </label>
        <label className="set-row">
          <span className="set-row-text">
            <span className="set-row-label">Use the account whose week ends soonest first</span>
          </span>
          <span className="set-row-control">
            <Switch checked={useFirst} onChange={(v) => void setSettings({ accountsBy: v ? 'useFirst' : 'manual' })} label="Use the account whose week ends soonest first" />
          </span>
        </label>
        <label className="set-row">
          <span className="set-row-text">
            <span className="set-row-label">Return to the preferred account when its limit resets</span>
          </span>
          <span className="set-row-control">
            <Switch checked={backHome} onChange={(v) => void setSettings({ returnToPreferred: v })} label="Return to the preferred account when its limit resets" />
          </span>
        </label>
        <label className="set-row">
          <span className="set-row-text">
            <span className="set-row-label">Notify when a limit resets</span>
          </span>
          <span className="set-row-control">
            <Switch checked={notifyReset} onChange={(v) => void setSettings({ notifyLimitReset: v })} label="Notify when a limit resets" />
          </span>
        </label>
      </div>
      {order.flatMap((id) =>
        (providers[id]?.accounts ?? [])
          .filter((a) => a.auth.loggedIn)
          .map((a) => (
            <CreditsSetting key={`${id}/${a.id}`} className="acct-auto" provider={id} accountId={a.id} name={(providers[id]?.accounts?.length ?? 0) > 1 ? accountName(a) : providers[id]?.name} />
          )),
      )}
      <p className="set-foot-note">
        <Icon name="lock" size={14} />
        <span>You sign in through each agent's own CLI in your browser: Sable never sees passwords or tokens. Each account keeps its own settings and history.</span>
      </p>
    </div>
  );
}
