import { memo } from 'react';
import { DEFAULT_ACCOUNT, type NoticeItem } from '@shared/protocol';
import { PROVIDER_NAME } from '@/art/Logo';
import { Icon } from '@/icons';
import { login, openSettings } from '@/state/actions';
import { accountKey, useStore } from '@/state/store';

/**
 * A chat's requests were refused for the sign-in and the agent's CLI says the account is signed out
 * (server/core/auth-gate.ts decides; one per chat, however many requests failed). One line and one
 * button: "Sign in" starts the account's own sign-in, as Settings › Accounts does, and opens that
 * page where the sign-in shows its progress. Once signed in, the chat carries on by itself. While
 * Sable still asks the CLI (`checking`) and after the chat carried on (`resumed`) it shows nothing.
 */
export const AuthNotice = memo(function AuthNotice({ item }: { item: NoticeItem }) {
  const auth = item.auth!;
  const provider = auth.provider;
  const accountId = auth.accountId ?? DEFAULT_ACCOUNT;
  const flow = useStore((s) => (provider ? s.auth[accountKey(provider, accountId)]?.state : undefined));
  if (auth.state !== 'signedOut' || !provider) return null;
  const who = auth.label ?? PROVIDER_NAME[provider];
  const busy = flow === 'started' || flow === 'url';
  const signIn = () => {
    openSettings('accounts');
    if (!busy) void login(provider, accountId === DEFAULT_ACCOUNT ? undefined : accountId);
  };
  return (
    <div className="notice-error auth-notice" data-level="error" role="alert">
      <Icon name="error" size={16} />
      <div className="notice-error-body">
        <div className="notice-error-head">
          <div className="notice-error-text">Signed out of {who}</div>
          <button type="button" className="btn btn-sm" onClick={signIn}>
            {busy ? 'Signing in' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
});
