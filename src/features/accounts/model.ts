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
