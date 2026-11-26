import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { expect, it, vi } from 'vitest';
import { WEB_SHIPS } from '../shared/protocol';
import { readWebFragment } from '../mobile/src/lib/web-link';
import { Preferences } from '../mobile/src/web/plugins';

it('keeps web access behind release clearance', () => expect(WEB_SHIPS).toBe(false));

it('consumes and erases the HTTPS pairing fragment before connecting', () => {
  const p = 'a'.repeat(22), f = 'b'.repeat(43);
  const history = { state: {}, replaceState: vi.fn() };
  const url = new URL('https://sable.local:47830/#p=' + p + '&f=' + f);
  expect(readWebFragment(url as unknown as Location, history as unknown as History)).toBe(
    'sable://pair/2?h=sable.local&p=47830&s=' + p + '&f=' + f);
  expect(history.replaceState).toHaveBeenCalledWith(history.state, '', '/');
  url.hash = '#invalid';
  expect(readWebFragment(url as unknown as Location, history as unknown as History)).toBeUndefined();
});

it('persists only the pairing, including when the phone stages an outgoing message', async () => {
  const persistent = { setItem: vi.fn(), removeItem: vi.fn(), getItem: vi.fn() };
  vi.stubGlobal('window', { localStorage: persistent });
  try {
    for (const key of ['sable.outgoing', 'sable.taken', 'sable.tail.1', 'sable.home']) {
      await Preferences.set({ key, value: 'chat content' });
      expect(await Preferences.get({ key })).toEqual({ value: 'chat content' });
    }
    await Preferences.set({ key: 'pairing', value: 'device credential' });
    expect(persistent.setItem.mock.calls).toEqual([['pairing', 'device credential']]);
    await Preferences.remove({ key: 'pairing' });
    expect(persistent.removeItem).toHaveBeenCalledWith('pairing');
  } finally { vi.unstubAllGlobals(); }
});

it('builds an external-script, external-style index and confines persistent storage to the credential shim', async () => {
  const outDir = mkdtempSync(path.join(process.env.TEMP!, 'web-build-'));
  try {
    await build({ root: path.resolve('mobile'), configFile: path.resolve('mobile/vite.web.config.ts'), configLoader: 'runner',
      build: { outDir, emptyOutDir: false, reportCompressedSize: false }, logLevel: 'silent' });
    const html = readFileSync(path.join(outDir, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<style\b|\sstyle\s*=|\son\w+\s*=/i);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc="\.\/assets\/[\w-]+\.js"/);
      expect(body.trim()).toBe('');
    }
    for (const [, src] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      expect(src).toMatch(/^\.\/assets\/[\w.-]+$/);
      expect(existsSync(path.join(outDir, src))).toBe(true);
    }
    const js = readdirSync(path.join(outDir, 'assets')).filter(n => n.endsWith('.js')).map(n => readFileSync(path.join(outDir, 'assets', n), 'utf8')).join('\n');
    expect(js.match(/\blocalStorage\b/g)).toHaveLength(1);
    expect(js).toMatch(/window\.localStorage/);
    expect(js).toContain('/sable-web');
    expect(js).not.toContain('getUserMedia');
  } finally { rmSync(outDir, { recursive: true, force: true }); }
}, 30_000);

