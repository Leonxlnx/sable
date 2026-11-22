import { memo, useEffect } from 'react';
import { DEFAULT_ACCOUNT } from '@shared/protocol';
import { ProviderMark } from '@/art/Logo';
import { AccountSwitcher, AddAccountDialog } from '@/features/accounts';
import { connectableAgents, isSignedIn } from '@/features/connect/plan';
import { Icon } from '@/icons';
import { anyChecking } from '@/lib/sign-in';
import { cancelUpdate, installUpdate, openSettings, refreshLimits } from '@/state/actions';
import { useFocusAccount } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import { useLimitsTicker } from '@/features/usage/ticker';
import './footer.css';

/**
 * One quiet row: who is signed in (it opens the accounts, each with its limits) and Settings.
 * The limits themselves live in that menu; the row only marks an account near or at a cap.
 */
export const SidebarFooter = memo(function SidebarFooter() {
  useLimitRefresh();
  return (
    <div className="side-foot">
      <UpdateRow />
      <Account />
      <AddAccountDialog />
    </div>
  );
});

/** Keeps the account in focus's limits fresh while the window is visible, so the row's limit mark is current. */
function useLimitRefresh() {
  const { provider, accountId } = useFocusAccount();
  const ready = useStore((s) => s.ready);
  const connected = useStore((s) => {
    const p = s.providers[provider];
    const a = p?.accounts?.find((x) => x.id === accountId);
    return !!(a ? a.auth.loggedIn : accountId === DEFAULT_ACCOUNT && p?.auth.loggedIn);
  });

  const on = ready && connected;
  useEffect(() => {
    if (on) void refreshLimits(provider, accountId);
  }, [provider, accountId, on]);
  useLimitsTicker(on, () => void refreshLimits(provider, accountId));
}

/**
 * A downloaded update: one quiet row above the account that restarts into it. Asked while agents
 * work, it says it waits for them, with a way back.
 */
function UpdateRow() {
  const u = useStore((s) => s.update);
  if (!u || u.status !== 'ready' || !u.latest) return null;
  if (u.pending) {
    return (
      <div className="update-row" data-pending="">
        <Icon name="reload" size={15} className="update-icon" />
        <span className="update-label grow truncate">Waits for agents</span>
        <button type="button" className="update-cancel" aria-label="Cancel the restart" onClick={() => void cancelUpdate()}>
          {/* A narrow sidebar keeps the label whole: Cancel becomes its icon (footer.css). */}
          <span className="update-long">Cancel</span>
          <Icon name="x" size={13} className="update-short" />
        </button>
      </div>
    );
  }
  return (
    <button type="button" className="update-row" onClick={() => void installUpdate()}>
      <Icon name="reload" size={15} className="update-icon" />
      <span className="update-label grow truncate">Restart to update</span>
      <span className="update-ver num">{u.latest}</span>
    </button>
  );
}

function Account() {
  const providers = useStore((s) => s.providers);
  const { provider: active } = useFocusAccount();
  const ready = useStore((s) => s.ready);

  const connected = connectableAgents(providers).filter((id) => isSignedIn(providers[id]));

  if (!ready) return <div className="account" aria-hidden />;
  // An agent without an account to connect still shows while it is the one in focus.
  if (!connected.includes(active) && isSignedIn(providers[active])) connected.push(active);
  if (!connected.length) {
    // Not known yet: the row waits; it does not ask to connect an agent that may be connected.
    if (anyChecking(providers, connectableAgents(providers))) return <div className="account" aria-hidden />;
    return (
      <div className="account">
        <button type="button" className="connect" onClick={() => openSettings('accounts')}>
          <span className="connect-marks" aria-hidden>
            <ProviderMark provider="claude" size={13} />
            <ProviderMark provider="codex" size={13} />
          </span>
          <span className="connect-title grow truncate">Connect an agent</span>
          <Icon name="arrow-right" size={14} className="connect-arrow" />
        </button>
        <IconButton icon="settings" label="Settings" keys="mod+," tipSide="top" onClick={() => openSettings()} />
      </div>
    );
  }

  return (
    <div className="account">
      <AccountSwitcher />
      <IconButton icon="settings" label="Settings" keys="mod+," tipSide="top" onClick={() => openSettings()} />
    </div>
  );
}
