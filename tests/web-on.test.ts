import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerPhone } from '../server/services/phone';
import { webOn } from '../server/services/web-on';
import { WEB_SHIPS } from '../shared/protocol';
import { restoreWebAcl } from './web-acl-fixture';
import { matchSections } from '../src/features/settings/sections';
import { useStore } from '../src/state/store';

// The owner's switch: WEB_SHIPS stays false, and `Sable.exe --web` (or SABLE_WEB=1) turns web access on for
// that one run exactly as WEB_SHIPS true would; nothing else does.

const homes: string[] = [], apps: App[] = [];
const saved = process.env.SABLE_WEB;
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const home of homes.splice(0)) restoreWebAcl(home), rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  if (saved === undefined) delete process.env.SABLE_WEB;
  else process.env.SABLE_WEB = saved;
});

function app() {
  const home = mkdtempSync(path.join(process.env.TEMP!, 'web-test-on-'));
  homes.push(home);
  const a = new App({ home, userHome: home, quiet: true, providers: [ctx => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(a);
  const assets = path.join(home, 'bundle');
  mkdirSync(assets, { recursive: true });
  writeFileSync(path.join(assets, 'index.html'), 'Sable web fixture');
  registerPhone(a, { port: 0, host: '127.0.0.1', web: { assets, loopback: true, port: 0, networks: () => [{ id: 'home/a/10.0.0.7', name: 'Home', address: '10.0.0.7' }] } });
  return a;
}

it('is off unless WEB_SHIPS, --web or SABLE_WEB=1 says so', () => {
  expect(WEB_SHIPS).toBe(false);
  expect(webOn([], {})).toBe(false);
  expect(webOn(['Sable.exe'], { SABLE_WEB: '0' })).toBe(false);
  expect(webOn(['Sable.exe', '--webby', '--web=1', 'web'], { SABLE_WEB: 'true' })).toBe(false);
  expect(webOn(['Sable.exe', '--web'], {})).toBe(true);
  expect(webOn(['Sable.exe'], { SABLE_WEB: '1' })).toBe(true);
});

it('the window offers nothing of it unless the hello said so', () => {
  useStore.setState({ webAccess: false });
  expect(matchSections('ipad')).toEqual([]);
  expect(matchSections('certificate')).toEqual([]);
  useStore.setState({ webAccess: true });
  expect(matchSections('ipad').map(s => s.id)).toEqual(['phone']);
  useStore.setState({ webAccess: false });
});

it('without the flag every web method answers off and the hello says nothing of it', async () => {
  delete process.env.SABLE_WEB;
  const a = app();
  const hello = await a.call('app.hello', {});
  expect('webAccess' in hello).toBe(false);
  await a.call('app.setSettings', { patch: { webRemote: true, webNetwork: 'home/a/10.0.0.7' } });
  for (const [method, params] of [['web.state', {}], ['web.offer', {}], ['web.approve', { requestId: 'x', allow: true }], ['web.revoke', { deviceId: 'x' }], ['web.saveCa', {}]] as const)
    await expect(a.call(method, params as never), method).rejects.toThrow(/Web access is off/);
});

it('with SABLE_WEB=1 the hello says so, the methods answer, and the listener starts once the person switches it on', async () => {
  process.env.SABLE_WEB = '1';
  const a = app();
  expect((await a.call('app.hello', {})).webAccess).toBe(true);
  // Off until the person switches it on, as with WEB_SHIPS.
  expect(await a.call('web.state', {})).toMatchObject({ listening: false, assets: true });
  await a.call('app.setSettings', { patch: { webRemote: true, webNetwork: 'home/a/10.0.0.7' } });
  const s = await a.call('web.state', {});
  expect(s).toMatchObject({ listening: true, addresses: ['10.0.0.7'] });
  expect((await a.call('web.offer', {})).pairing?.link).toMatch(/^https:\/\/10\.0\.0\.7:\d+\/#p=/);
}, 60_000);
