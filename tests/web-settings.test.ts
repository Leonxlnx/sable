import { describe, expect, it } from 'vitest';
import type { WebState } from '../shared/protocol';
import { connectedWords, countdown, fingerprintLines, webSection } from '../src/features/web/web-model';

// Settings › Phone › Web access as a pure model (src/features/web/web-model.ts): what shows in each state.

const now = Date.parse('2026-11-27T10:00:00');
const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
const networks = [{ id: 'n1', name: 'Home', address: '192.168.1.20' }, { id: 'n2', name: 'Other', address: '10.0.0.5' }];
const off: WebState = { listening: false, addresses: [], clients: [], devices: [], networks: [], assets: true };
const ready: WebState = {
  ...off, networks, listening: true, addresses: ['192.168.1.20'], port: 47830, caFingerprint: fp, revocationDurable: true,
  addressQr: { link: 'https://192.168.1.20:47830/', qr: 'M0 0h1v1H0z', size: 21 },
};
const on = { webRemote: true, webNetwork: 'n1' };

describe('fingerprintLines', () => {
  it('shows the SHA-256 as four lines of eight pairs, as a tablet shows it', () => {
    expect(fingerprintLines(fp)).toEqual(['00 01 02 03 04 05 06 07', '08 09 0A 0B 0C 0D 0E 0F', '10 11 12 13 14 15 16 17', '18 19 1A 1B 1C 1D 1E 1F']);
    expect(fingerprintLines(fp.toLowerCase())[1]).toBe('08 09 0A 0B 0C 0D 0E 0F');
  });
  it('shows nothing for anything that is not 32 bytes of hex', () => {
    expect(fingerprintLines(undefined)).toEqual([]);
    expect(fingerprintLines(fp.slice(3))).toEqual([]);
    expect(fingerprintLines(fp.replace('1F', 'ZZ'))).toEqual([]);
  });
});

it('counts an offer down in minutes and seconds', () => {
  expect(countdown(9 * 60_000 + 41_000)).toBe('9:41');
  expect(countdown(5_200)).toBe('0:06');
  expect(countdown(-1)).toBe('0:00');
});

describe('webSection', () => {
  it('off: the switch with its line, and nothing else', () => {
    const v = webSection(off, {}, now);
    expect(v).toMatchObject({ on: false, switchable: true, status: 'Paired browsers connect over your home network or Tailscale', devices: [], unsaved: false });
    expect(v.networks ?? v.address ?? v.setup ?? v.request ?? v.steer).toBeUndefined();
  });

  it('a build without the web client cannot be switched on, but can be switched off', () => {
    expect(webSection({ ...off, assets: false }, {}, now)).toMatchObject({ switchable: false, status: 'Not included in this version' });
    expect(webSection({ ...off, assets: false }, { webRemote: true }, now)).toMatchObject({ switchable: true, networks: undefined, steer: undefined });
  });

  it('on with no network chosen: the networks to choose from, no address, and not the bridge\'s own words about it', () => {
    const v = webSection({ ...off, networks, error: 'Select an available home network and address on the desktop.' }, { webRemote: true }, now);
    // Tailscale is always the first choice (web-tailscale.ts), then the home networks.
    expect(v.networks?.map((n) => [n.id, n.chosen])).toEqual([['tailscale', false], ['n1', false], ['n2', false]]);
    expect(v.address ?? v.setup ?? v.error ?? v.status).toBeUndefined();
    expect(v.steer).toBe(false);
  });

  it('on with a chosen network that is gone, or none connected', () => {
    expect(webSection({ ...off, networks: [networks[1]], error: 'The selected home network changed. Select an available network on the desktop.' }, on, now))
      .toMatchObject({ networkHelp: 'The chosen network is not connected', error: undefined });
    expect(webSection({ ...off, networks: [] }, on, now).networkHelp).toBe('No home network is connected');
    // A home Wi-Fi Windows calls public is never served on: it is named, with what to change.
    expect(webSection({ ...off, networks: [], publicNetworks: ['Home'] }, on, now).networkHelp).toBe('Home is a public network in Windows. Make it private to use it here.');
    expect(webSection({ ...off, networks, publicNetworks: ['Home', 'Cafe'] }, { webRemote: true }, now).networkHelp).toBe('Home and Cafe are public networks in Windows. Make one private to use it here.');
    expect(webSection({ ...off, networks }, on, now).status).toBe('Starting');
  });

  it('ready: the address with its code, the certificate step and pairing', () => {
    const v = webSection(ready, on, now);
    expect(v.address).toEqual({ link: 'https://192.168.1.20:47830/', shown: 'https://192.168.1.20:47830', qr: ready.addressQr });
    expect(v.setup).toEqual({ caUrl: 'https://192.168.1.20:47830/ca.cer', fingerprint: fingerprintLines(fp), pairing: undefined });
    expect(v.networks?.find((n) => n.chosen)?.id).toBe('n1');
  });

  it('a running offer is the only code on the page, with its time left; an expired one is gone', () => {
    const pairing = { link: 'https://192.168.1.20:47830/#p=k&f=f', expiresAt: now + 125_000, qr: 'M1 1h1v1H1z', size: 25 };
    const v = webSection({ ...ready, pairing }, on, now);
    expect(v.setup?.pairing).toEqual({ link: pairing.link, qr: pairing.qr, size: 25, left: '2:05' });
    expect(v.address?.qr).toBeUndefined();
    expect(webSection({ ...ready, pairing: { ...pairing, expiresAt: now - 1 } }, on, now).setup?.pairing).toBeUndefined();
  });

  it('a device asking shows only while it listens', () => {
    const request = { id: 'r1', name: 'Test iPad', address: '192.168.1.31', at: now };
    expect(webSection({ ...ready, request }, on, now).request).toEqual({ id: 'r1', name: 'Test iPad', address: '192.168.1.31' });
    expect(webSection({ ...ready, listening: false, request }, on, now).request).toBeUndefined();
  });

  it('paired devices: connected since, last seen, paired; listed while off too (a lost tablet can be revoked)', () => {
    const devices = [
      { kind: 'web' as const, id: 'a', name: 'iPad', pairedAt: now - 86_400_000, online: true },
      { kind: 'web' as const, id: 'b', name: 'Kitchen', pairedAt: now - 86_400_000, lastSeen: now - 3 * 3_600_000 },
      { kind: 'web' as const, id: 'c', name: 'Old', pairedAt: now - 2 * 3_600_000 },
    ];
    const since = now - 25 * 60_000;
    const v = webSection({ ...ready, devices, clients: [{ id: 'a', label: 'iPad', since }] }, on, now);
    const time = new Date(since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    expect(v.devices.map((d) => d.line)).toEqual([`Connected since ${time}`, 'Last seen 3h ago', 'Paired 2h ago']);
    expect(webSection({ ...off, devices }, {}, now).devices).toHaveLength(3);
  });

  it('notices: a replaced root, and a removal that is in effect but not saved (the bridge\'s error is not said twice)', () => {
    const v = webSection({ ...ready, caReplacement: 'Install the new root.', revocationDurable: false, error: 'Could not save.' }, on, now);
    expect(v).toMatchObject({ replacement: 'Install the new root.', unsaved: true, error: undefined });
    expect(webSection({ ...ready, error: 'Port in use.' }, on, now).error).toBe('Port in use.');
  });

  it('the steer switch reads the setting', () => {
    expect(webSection(ready, { ...on, webSteerDanger: true }, now).steer).toBe(true);
  });
});

it('the top bar mark says who is connected', () => {
  expect(connectedWords(['iPad'])).toBe('iPad is connected');
  expect(connectedWords(['iPad', 'Kitchen iPad'])).toBe('iPad and Kitchen iPad are connected');
  expect(connectedWords(['a', 'b', 'c'])).toBe('3 web devices are connected');
});
