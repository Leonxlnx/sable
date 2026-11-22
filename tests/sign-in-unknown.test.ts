/** A first start: hello answers before the CLIs did, and the window reads "not known yet" as that, never as signed out. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AccountInfo, ProviderInfo } from '@shared/protocol';
import { correctsGuess, helloProviders, homeAgent, signedOut } from '@/lib/sign-in';

const info = (auth: AccountInfo['auth']): ProviderInfo => ({ id: 'claude', name: 'Claude Code', installed: true, auth, accounts: [{ id: 'default', provider: 'claude', label: 'Main', isDefault: true, auth }] });
const checking = { loggedIn: false, checking: true };
const out = { loggedIn: false };
const signedIn = { loggedIn: true, plan: 'Max' };
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

describe('a sign-in not read yet', () => {
  it('is neither signed in nor signed out', () => {
    expect(signedOut(checking)).toBe(false);
    expect(signedOut(out)).toBe(true);
    expect(signedOut(signedIn)).toBe(false);
    expect(signedOut(undefined)).toBe(false);
  });

  it('is read so by the home composer\'s Sign in chip, the sidebar footer\'s name and the sign-in cards', () => {
    expect(src('features/composer/Controls.tsx')).toMatch(/return signedOut\(acct \? acct\.auth : p\.auth\);/);
    expect(src('features/accounts/Switcher.tsx')).toMatch(/if \(signedOut\(account\.auth\)\) return 'Sign in';/);
    expect(src('features/connect/Connect.tsx')).toMatch(/info\.auth\.checking \? 'loading'/);
  });

  it('keeps the answer an event brought before hello was applied', () => {
    const answered = info(signedIn);
    expect(helloProviders({ claude: answered }, [info(checking)]).claude).toBe(answered);
    // Hello's own answer wins otherwise, a sign-out included.
    expect(helloProviders({ claude: answered }, [info(out)]).claude?.auth.loggedIn).toBe(false);
    expect(helloProviders({}, [info(checking)]).claude?.auth.checking).toBe(true);
  });
});

describe('the agent home starts on', () => {
  const agent = (id: ProviderInfo['id'], installed: boolean, auth: AccountInfo['auth'] = signedIn): ProviderInfo => ({ id, name: id, installed, auth });
  const fresh = { current: 'claude' as const, chosen: false, preferred: 'claude' as const };

  it('is the one set in settings on a fresh profile, and the person\'s own choice after', () => {
    const all = [agent('claude', true), agent('codex', true), agent('demo', true)];
    expect(homeAgent(all, { current: 'codex', chosen: false, preferred: 'claude' })).toBe('claude');
    expect(homeAgent(all, { current: 'codex', chosen: true, preferred: 'claude' })).toBe('codex');
    // Neither is there: the first real agent that is, and the Demo only when it is alone.
    expect(homeAgent([agent('claude', false), agent('codex', true), agent('demo', true)], fresh)).toBe('codex');
    expect(homeAgent([agent('claude', false), agent('codex', false), agent('demo', true)], fresh)).toBe('demo');
    expect(homeAgent([], fresh)).toBe('claude');
  });

  it('follows the agent\'s own answer when hello\'s first guess was wrong', () => {
    // Hello's guess at a first start: a file named claude is on PATH, the sign-in not known.
    const guess = agent('claude', true, checking);
    const others = [agent('codex', true), agent('demo', true)];
    expect(homeAgent([guess, ...others], fresh)).toBe('claude');
    // Its own answer: it does not run. Home was left on an agent that is not there.
    const answer = agent('claude', false, out);
    expect(correctsGuess(guess, answer)).toBe(true);
    expect(homeAgent([answer, ...others], fresh)).toBe('codex');
    // The other way: not on PATH, found by the agent itself. A fresh profile goes to the one set in settings.
    const missing = agent('claude', false, out);
    const found = agent('claude', true);
    expect(correctsGuess(missing, found)).toBe(true);
    expect(homeAgent([found, ...others], { current: 'codex', chosen: false, preferred: 'claude' })).toBe('claude');
    // The person's own choice stays while it is installed.
    expect(homeAgent([found, ...others], { current: 'codex', chosen: true, preferred: 'claude' })).toBe('codex');
    // An answer that changes neither (a plan, a version) moves nothing, nor does a first word about an agent.
    expect(correctsGuess(found, agent('claude', true))).toBe(false);
    expect(correctsGuess(undefined, found)).toBe(false);
  });

  it('is asked at hello and on the correcting answer, from what the window knows by then', () => {
    const store = src('state/store.ts').replace(/\r\n/g, '\n');
    // Hello: an answer an event already brought counts, not hello's older guess.
    expect(store).toMatch(/const providers = helloProviders\(s\.providers, app\.providers\);\s*\/\/[^\n]*\n\s*const homeProvider = homeAgent\(Object\.values\(providers\),/);
    const updated = store.slice(store.indexOf("case 'provider.updated':"), store.indexOf("case 'auth.progress':"));
    expect(updated).toContain('correctsGuess(s.providers[e.provider.id], e.provider) ? homeAgent(Object.values(providers),');
    expect(updated).toContain('chosen: homeChosen');
  });
});
