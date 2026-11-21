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

  // Only one bright button per view: the first agent waiting for a sign-in gets it.
  const firstOut = order.find((id) => providers[id]?.installed && !providers[id]?.auth.loggedIn && !providers[id]?.accounts?.some((a) => a.auth.loggedIn));

  return (
    <div className="set-stack">
      <div className="acct-list">
        {order.map((id) => (
          <ConnectCard key={id} provider={id} primary={id === firstOut} />
        ))}
      </div>
      <AccountCaps agents={order} />
      <label className="acct-auto" data-spot>
        <span className="acct-auto-label">Continue with the next account at a limit</span>
        <Switch checked={carryOn} onChange={(v) => void setSettings({ continueAtLimit: v })} label="Continue with the next account at a limit" />
      </label>
      <label className="acct-auto" data-spot>
        <span className="acct-auto-label">Continue when the usage resets</span>
        <Switch checked={resumeAtReset} onChange={(v) => void setSettings({ continueAtReset: v })} label="Continue when the usage resets" />
      </label>
      <label className="acct-auto" data-spot>
        <span className="acct-auto-label">Return to the preferred account when its limit resets</span>
        <Switch checked={backHome} onChange={(v) => void setSettings({ returnToPreferred: v })} label="Return to the preferred account when its limit resets" />
      </label>
      <label className="acct-auto" data-spot>
        <span className="acct-auto-label">Notify when a limit resets</span>
        <Switch checked={notifyReset} onChange={(v) => void setSettings({ notifyLimitReset: v })} label="Notify when a limit resets" />
      </label>
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
