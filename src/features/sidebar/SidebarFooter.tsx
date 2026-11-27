import { memo, useEffect } from 'react';
import { DEFAULT_ACCOUNT } from '@shared/protocol';
import { ProviderMark } from '@/art/Logo';
import { AccountSwitcher, AddAccountDialog } from '@/features/accounts';
import { connectableAgents, isSignedIn } from '@/features/connect/plan';
import { Icon } from '@/icons';
import { anyChecking } from '@/lib/sign-in';
import { cancelUpdate, installUpdate, openSession, openSettings, refreshLimits, restartNow } from '@/state/actions';
import { useFocusAccount } from '@/state/hooks';
import { useStore } from '@/state/store';
import { IconButton, Menu, MenuContent, MenuItem, MenuSep, MenuTrigger } from '@/ui';
import { useLimitsTicker } from '@/features/usage/ticker';
import { waitChats, waitLabel, waitWord } from './update-wait';
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
 * work, it names the chat it waits for; its menu lists every chat with what it holds, and offers the
 * restart now and the way back.
 */
function UpdateRow() {
  const u = useStore((s) => s.update);
  // The names only (one string): the row never renders for another change of a chat.
  const names = useStore((s) => (u?.pending ? waitChats(u.waits).map((w) => s.sessions[w.sessionId!]?.title ?? '').join('\n') : ''));
  if (!u || u.status !== 'ready' || !u.latest) return null;
  if (u.pending) {
    const chats = waitChats(u.waits);
    const titles = names.split('\n');
    const title = (id: string) => titles[chats.findIndex((w) => w.sessionId === id)] || undefined;
    const now = Date.now();
    const own = (u.waits ?? []).find((w) => !w.sessionId);
    return (
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="update-row" data-pending="">
            <Icon name="reload" size={15} className="update-icon" />
            <span className="update-label grow truncate">{waitLabel(u.waits, title)}</span>
            <Icon name="caret-up" size={11} className="update-caret" />
          </button>
        </MenuTrigger>
        <MenuContent side="top" align="start" className="update-menu">
          {chats.map((w) => (
            <MenuItem key={w.sessionId} hint={waitWord(w, now)} onSelect={() => openSession(w.sessionId!)}>
              {title(w.sessionId!) ?? 'Chat'}
            </MenuItem>
          ))}
          {own && (
            <MenuItem disabled hint={waitWord(own, now)}>
              Sable
            </MenuItem>
          )}
          {(chats.length > 0 || own) && <MenuSep />}
          <MenuItem icon="reload" onSelect={() => void restartNow()}>
            Restart now
          </MenuItem>
          <MenuItem icon="x" onSelect={() => void cancelUpdate()}>
            Cancel
          </MenuItem>
        </MenuContent>
      </Menu>
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
