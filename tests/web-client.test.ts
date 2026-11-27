import { inflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { WEB_METHODS } from '../shared/protocol';
import { crc32, faviconSvg, iconPng, manifest, MARK } from '../mobile/web-icons';
import { cleanDeviceName, deviceLabel } from '../mobile/src/web/device';
import { mayCall } from '../mobile/src/web/allow';
import { knownMode } from '../mobile/src/web/modes';

// The web client's small things (web2 job 3): its name, its icons, and the one rule for what it offers.

const UA = {
  ipadSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  ipadChrome: 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  androidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  androidPhone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
};

it('names a browser by what it is, an iPad included (its Safari says Macintosh)', () => {
  expect(deviceLabel(UA.ipadSafari, 5)).toBe('iPad · Safari');
  expect(deviceLabel(UA.ipadSafari, 0)).toBe('Mac · Safari');
  expect(deviceLabel(UA.ipadChrome, 5)).toBe('iPad · Chrome');
  expect(deviceLabel(UA.macChrome, 0)).toBe('Mac · Chrome');
  expect(deviceLabel(UA.windowsEdge, 0)).toBe('Windows PC · Edge');
  expect(deviceLabel(UA.androidTablet, 5)).toBe('Android tablet · Chrome');
  expect(deviceLabel(UA.androidPhone, 5)).toBe('Android phone · Chrome');
  expect(deviceLabel(UA.firefoxLinux, 0)).toBe('Linux PC · Firefox');
  expect(deviceLabel('', 0)).toBe('Web browser');
});

it('keeps a typed name to one plain line of 40 characters', () => {
  expect(cleanDeviceName('  Kitchen\n iPad  ')).toBe('Kitchen iPad');
  expect(cleanDeviceName('iPad‮<script>')).toBe('iPadscript');
  expect(cleanDeviceName('x'.repeat(60))).toHaveLength(40);
  expect(cleanDeviceName('​ \u0007')).toBe('');
});

it('offers in a browser only what the web allowlist admits, everything in the phone app', () => {
  for (const m of WEB_METHODS) expect(mayCall(m, true)).toBe(true);
  for (const m of ['session.create', 'session.setMode', 'session.setModel', 'session.update', 'session.rename', 'provider.limits', 'usage.limits',
    'queue.take', 'queue.sendNow', 'queue.remove', 'session.setOptions', 'session.switchAgent', 'session.switchAccount', 'turn.check', 'turn.checkStop'])
    expect([m, mayCall(m, true)]).toEqual([m, false]);
  expect(mayCall('session.create', false)).toBe(true);
});

it('shows a chat’s mode by its id in a browser, which is told no capabilities', () => {
  expect(knownMode('claude', 'default')).toMatchObject({ name: 'Ask first', tone: 'ask' });
  expect(knownMode('codex', 'full-access')).toMatchObject({ name: 'Full access', tone: 'danger' });
  expect(knownMode('opencode', 'allow-all')).toMatchObject({ tone: 'danger' });
  expect(knownMode('claude', 'nonsense')).toBeUndefined();
});

/** A PNG's chunks, each checked against its CRC; the pixels of an 8-bit RGB one without filters. */
function readPng(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const chunks: Record<string, Buffer> = {};
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8);
    const body = png.subarray(at + 4, at + 8 + len);
    expect(png.readUInt32BE(at + 8 + len), type).toBe(crc32(body));
    chunks[type] = png.subarray(at + 8, at + 8 + len);
    at += 12 + len;
  }
  const w = chunks.IHDR.readUInt32BE(0), h = chunks.IHDR.readUInt32BE(4);
  const raw = inflateSync(chunks.IDAT);
  const px = (x: number, y: number) => [...raw.subarray(y * (1 + w * 3) + 1 + x * 3, y * (1 + w * 3) + 4 + x * 3)];
  return { w, h, depth: chunks.IHDR[8], colour: chunks.IHDR[9], end: 'IEND' in chunks, px };
}

it('draws the Home Screen icons from the mark: crisp cells, ivory on ink, two cells left out', () => {
  for (const size of [180, 192, 512]) {
    const p = readPng(iconPng(size));
    expect([p.w, p.h, p.depth, p.colour, p.end]).toEqual([size, size, 8, 2, true]);
    const cell = Math.round((size * 0.44) / 4), at = Math.round((size - cell * 4) / 2);
    const centre = (c: number, r: number) => p.px(at + c * cell + (cell >> 1), at + r * cell + (cell >> 1));
    expect(p.px(0, 0)).toEqual([7, 7, 8]);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
      expect(centre(c, r), `${size} ${c},${r}`).toEqual(MARK.some(([x, y]) => x === c && y === r) ? [242, 241, 238] : [7, 7, 8]);
  }
  expect(MARK).toHaveLength(14);
});

it('gives the favicon as SVG and a standalone manifest', () => {
  const svg = faviconSvg();
  expect(svg.match(/<rect /g)).toHaveLength(15);
  expect(svg).not.toMatch(/<script|href=|on\w+=/i);
  const m = JSON.parse(manifest());
  expect(m).toMatchObject({ name: 'Sable', display: 'standalone', start_url: '/', scope: '/' });
  expect(m.icons.map((i: { src: string }) => i.src)).toEqual(['icon-192.png', 'icon-512.png']);
});
