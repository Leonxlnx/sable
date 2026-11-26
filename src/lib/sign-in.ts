import type { AuthState, ProviderId, ProviderInfo } from '@shared/protocol';

/**
 * A sign-in not read yet. At a first start `app.hello` does not wait for the agents' CLIs: an agent
 * whose sign-in is not known comes `checking` (neither in nor out) and its answer follows as
 * `provider.updated`. Nothing may read that as signed out (no "Sign in" that vanishes a moment later).
 */
export const signedOut = (auth: AuthState | undefined): boolean => !!auth && !auth.loggedIn && !auth.checking;

/** Whether the sign-in of any of these agents is not known yet: until it is, nothing asks to sign in or to connect an agent. */
export const anyChecking = (providers: Partial<Record<ProviderId, ProviderInfo>>, ids: ProviderId[]): boolean => ids.some((id) => !!providers[id]?.auth.checking);

/** A definitive answer belongs to its own account, including when hello and an update cross. */
export function keepKnownAuth(was: ProviderInfo | undefined, next: ProviderInfo): ProviderInfo {
  if (!was) return next;
  const keep = (read: AuthState, known?: AuthState) => read.checking && known && !known.checking ? known : read;
  return { ...next, auth: keep(next.auth, was.auth), accounts: next.accounts?.map(a => ({
    ...a, auth: keep(a.auth, was.accounts?.find(old => old.id === a.id)?.auth),
  })) };
}

/**
 * The agent home starts on: the one the person chose (`current` when `chosen`), else the one set in
 * settings, each only while it is installed; else the first real agent that is, else the Demo.
 * Asked at hello and again when an agent's own answer corrects hello's first guess (a CLI that is
 * on PATH but does not run, or one found where PATH does not look): never left on an agent that is
 * not there.
 */
export function homeAgent(providers: (ProviderInfo | undefined)[], o: { current: ProviderId; chosen: boolean; preferred?: ProviderId }): ProviderId {
  const installed = providers.filter((p): p is ProviderInfo => !!p?.installed);
  const wanted = o.chosen || !o.preferred || !installed.some((p) => p.id === o.preferred) ? o.current : o.preferred;
  return installed.some((p) => p.id === wanted) ? wanted : (installed.find((p) => p.id !== 'demo')?.id ?? installed[0]?.id ?? 'claude');
}

/** Whether an agent's new answer changes what home may start on: its sign-in was not known, or it came or went. */
export const correctsGuess = (was: ProviderInfo | undefined, now: ProviderInfo): boolean => !!was && (!!was.auth.checking || was.installed !== now.installed);

/**
 * The agents as hello tells them. The `provider.updated` with an agent's answer can be applied before
 * hello's own answer (a frame applies its events first): the answer it brought is kept.
 */
export function helloProviders(current: Partial<Record<ProviderId, ProviderInfo>>, told: ProviderInfo[]): Partial<Record<ProviderId, ProviderInfo>> {
  return Object.fromEntries(told.map(p => {
    const was = current[p.id];
    if (was && !was.auth.checking && p.auth.checking && (!p.accounts || p.accounts.every(a => a.auth.checking))) return [p.id, was];
    return [p.id, keepKnownAuth(was, p)];
  }));
}
