import { create } from 'zustand';
import { DEFAULT_ACCOUNT, type AccountInfo, type ProviderId, type ProviderInfo } from '@shared/protocol';
import { connectableAgents, planLabel } from '@/features/connect/plan';

/** The plan as a short word for rows ("Max", "Pro", "API key"); undefined when signed out or unknown. */
export function planWord(a: Pick<AccountInfo, 'auth'> | undefined): string | undefined {
  const p = planLabel(a?.auth);
  return p?.replace(/\s+plan$/i, '');
}

/** An agent's accounts as the UI lists them (older bridges send none: the CLI's own sign-in is its one account). */
export function accountsOf(info: ProviderInfo | undefined): AccountInfo[] {
  if (!info) return [];
  if (info.accounts?.length) return info.accounts;
  return [{ id: DEFAULT_ACCOUNT, provider: info.id, label: 'Main', isDefault: true, auth: info.auth }];
}

/**
 * Agents with accounts to show, in the usual order: installed ones that sign in. OpenCode signs in
 * to model providers, not as accounts, so it is listed only while it has plan limits to show (OpenCode Go).
 */
export function accountAgents(providers: Partial<Record<ProviderId, ProviderInfo>>, limited: (id: ProviderId) => boolean = () => false): ProviderId[] {
  return connectableAgents(providers).filter((id) => providers[id]?.installed && (id !== 'opencode' || limited(id)));
}

// ── what the switcher says about an account ──

/**
 * The account in use, which the footer names: the open chat's own account while a chat of this
 * agent is open (on home, the account chosen for the next chat), else the agent's default.
 */
export function accountInUse<A extends Pick<AccountInfo, 'id' | 'isDefault'>>(list: A[], focused: string | undefined): A | undefined {
  return (focused !== undefined ? list.find((a) => a.id === focused) : undefined) ?? list.find((a) => a.isDefault) ?? list[0];
}

/**
 * What a row of the switcher's menu says about its account. `here`: the account in use (the open
 * chat runs on it; with no chat open, the next chat starts on it), which gets the check: the menu
 * has one check, on the account the footer names. `next`: where new chats with this agent start,
 * when that is another account: a quiet dot, never a second check. (The check used to mark the
 * default for new chats: inside a chat it read as "this chat runs on it", on an account the chat
 * was not on.) `inUse` is the id of the account in use when the row's agent is the one in focus.
 */
export type AccountMark = 'here' | 'next' | undefined;

export function accountMark(account: Pick<AccountInfo, 'id' | 'isDefault'>, inUse: string | undefined): AccountMark {
  if (inUse !== undefined && account.id === inUse) return 'here';
  return account.isDefault ? 'next' : undefined;
}

/** The mark in words, for the row's accessible name. */
export const markWords = (mark: AccountMark) => (mark === 'here' ? ', in use' : mark === 'next' ? ', new chats start here' : '');

// ── the Add account dialog, opened from anywhere ──

interface AddState {
  open: boolean;
  /** The agent to add for; undefined lets the dialog offer a choice. */
  provider?: ProviderId;
  /** Start on "Use an existing folder". */
  existing?: boolean;
}

export const useAddAccount = create<AddState>(() => ({ open: false }));

export function openAddAccount(provider?: ProviderId, opts: { existing?: boolean } = {}) {
  useAddAccount.setState({ open: true, provider, existing: !!opts.existing });
}

export const closeAddAccount = () => useAddAccount.setState({ open: false });
