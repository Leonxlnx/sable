/**
 * Review wave 8, the last review's fixes on the account side: a changed sign-in never inherits the
 * previous person's limits (#26), and the model a chat runs on is read the same way for ranking,
 * caps and moves (#27). Demo accounts in temporary folders; nothing touches a real profile.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, type Capabilities, type NoticeItem, type RateLimit } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import type { ProviderContext } from '../server/providers/types';
import { registerUsage } from '../server/services/usage';

const H = 3_600_000;
const temps: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  temps.push(dir);
  return dir;
};

/** The Demo with fixed limits per account (when set) and a model menu whose "Default" stands for Fable 5. */
class FixedDemo extends DemoProvider {
  static fixed = new Map<string, RateLimit[]>();
  constructor(private c: ProviderContext) {
    super(c, { speed: 0 });
  }
  async limits(): Promise<RateLimit[]> {
    const own = FixedDemo.fixed.get(this.c.account?.id ?? DEFAULT_ACCOUNT);
    if (!own) return super.limits();
    this.c.emit({ type: 'limits.updated', provider: 'demo', limits: own, meta: { planLimits: true } });
    return own;
  }
  async caps(): Promise<Capabilities> {
    const caps = await super.caps();
    return { ...caps, models: [{ id: 'default', name: 'Default', description: 'Fable 5 · the best for most work', isDefault: true }, { id: 'demo-opus', name: 'Opus 5' }] };
  }
}

function start() {
  FixedDemo.fixed.clear();
  const home = temp('sable-acc8-');
  const app = new App({ home, providers: [(ctx) => new FixedDemo(ctx)], quiet: true, userHome: temp('sable-user-') });
  apps.push(app);
  return { app, home };
}

async function demoAccount(app: App, label: string, auth: Record<string, unknown>) {
  const { account } = await app.call('account.add', { provider: 'demo', label });
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ plan: 'Max', limits: 'light', ...auth }));
  await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
  await app.call('provider.limits', { provider: 'demo', accountId: account.id });
  return account;
}

type Inner = {
  providerInfo: (p: string, force?: string) => Promise<{ accounts?: { id: string; limits?: RateLimit[] }[] }>;
  spareAccounts: (p: string) => Promise<{ id: string; planLimits?: boolean }[]>;
};
const inner = (app: App) => app as unknown as Inner;

describe('a changed sign-in never inherits the previous person’s limits (review wave 8, #26)', () => {
  it('the snapshot built when the change is seen has no limits of the old person', async () => {
    const { app } = start();
    const studio = await demoAccount(app, 'Studio', { email: 'ana@example.dev' });
    expect((await inner(app).providerInfo('demo', studio.id)).accounts?.find((a) => a.id === studio.id)?.limits?.length).toBeGreaterThan(0);
    // Another person signs in to the same folder.
    writeFileSync(path.join(studio.dir!, 'demo-auth.json'), JSON.stringify({ email: 'bo@example.dev', plan: 'Max', limits: 'cap' }));
    const info = await inner(app).providerInfo('demo', studio.id);
    expect(info.accounts?.find((a) => a.id === studio.id)?.limits).toBeUndefined();
    expect(app.limitsForgottenAt('demo', studio.id)).toBeGreaterThan(0);
  });

  it('Spare never counts an account now on an API key as one with plan limits, whatever a report said', async () => {
    const { app } = start();
    registerUsage(app, { sources: () => [] });
    const studio = await demoAccount(app, 'Studio', { email: 'ana@example.dev' });
    expect((await inner(app).spareAccounts('demo')).find((a) => a.id === studio.id)?.planLimits).toBe(true);
    // The same folder now signed in with an API key; a read afterwards still reports plan limits.
    writeFileSync(path.join(studio.dir!, 'demo-auth.json'), JSON.stringify({ email: 'ana@example.dev', plan: 'API key', method: 'apiKey', limits: 'light' }));
    await app.call('auth.refresh', { provider: 'demo', accountId: studio.id });
    await app.call('provider.limits', { provider: 'demo', accountId: studio.id });
    expect((await inner(app).spareAccounts('demo')).find((a) => a.id === studio.id)?.planLimits).toBe(false);
  });
});

describe('the model a chat runs on, read once for caps and moves (review wave 8, #27)', () => {
  it('a cap check of a chat on the "default" alias counts the full week of the model it stands for', async () => {
    const { app, home } = start();
    const studio = await demoAccount(app, 'Studio', { email: 'ana@example.dev' });
    const work = await demoAccount(app, 'Work', { email: 'bo@example.dev' });
    FixedDemo.fixed.set(studio.id, [
      { id: 'seven_day', label: 'Weekly · all models', percent: 40, resetsAt: Date.now() + 50 * H, windowMins: 10_080 },
      { id: 'model_Fable', label: 'Weekly · Fable', percent: 100, resetsAt: Date.now() + 20 * H, windowMins: 10_080 },
    ]);
    await app.call('provider.limits', { provider: 'demo', accountId: studio.id });
    await app.call('provider.caps', { provider: 'demo', accountId: studio.id });
    await app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 95 } } } });
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: studio.id, model: 'default' });
    expect(snap.session.accountId).toBe(work.id);
    const line = app.runtime(snap.session.id).items.find((i): i is NoticeItem => i.type === 'notice');
    expect(line?.text).toBe('Started with Work: Studio used up Weekly · Fable');
  });
});
