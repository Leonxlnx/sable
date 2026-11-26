import './web-acl-fixture';
import * as childProcess from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createServer, get } from 'node:https';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { issueWebLeaf, privateIPv4, webCertificates } from '../server/services/web-cert';

const homes: string[] = [];
function fixture() { const home = mkdtempSync(path.join(process.env.TEMP!, 'web-cert-')); homes.push(home); return home; }
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('parses and verifies the installation CA and server SANs, and renews only the leaf', () => {
  const home = fixture();
  const day = 86_400_000, now = Date.now();
  const issue = (days: number, ips = ['10.0.0.2']) => webCertificates(home, ips, 'sable-test', now + days * day);
  const first = issue(0), leaf = new X509Certificate(first.cert.raw);
  expect(first.ca.ca).toBe(true);
  expect(first.ca.verify(first.ca.publicKey)).toBe(true);
  expect(leaf.ca).toBe(false);
  expect(leaf.verify(first.ca.publicKey)).toBe(true);
  expect(leaf.checkHost(first.host)).toBe(first.host);
  expect(leaf.checkIP('10.0.0.2')).toBe('10.0.0.2');
  expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
  expect(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)).toBe(397 * day);
  expect(issue(366).cert.raw).toEqual(leaf.raw);
  const renewed = issue(368);
  expect(renewed.cert.raw).not.toEqual(leaf.raw);
  const moved = issue(368, ['172.17.0.4']);
  expect(moved.cert.checkIP('10.0.0.2')).toBeUndefined();
  expect(moved.cert.checkIP('172.17.0.4')).toBeDefined();
  expect(moved.ca.raw).toEqual(first.ca.raw);
}, 30_000);

it('TLS trusts the SAN, rejects a different hostname and rejects a matching public SAN signed by this CA', async () => {
  const home = fixture();
  const { ca, cert, key, host } = webCertificates(home, ['192.168.1.5'], 'sable-test');
  async function connect(leaf: X509Certificate, servername: string) {
    const server = createServer({ key, cert: leaf.toString() }, (_, res) => res.end());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      await new Promise<void>((resolve, reject) => {
        get({ host: '127.0.0.1', port: (server.address() as {port: number}).port, servername, ca: ca.toString(), agent: false },
          res => { res.resume(); res.on('end', resolve); }).on('error', reject);
      });
    } finally { await new Promise<void>(r => server.close(() => r())); }
  }
  await connect(cert, host);
  await expect(connect(cert, 'other.local')).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  const caKey = createPrivateKey(readFileSync(path.join(home, 'web/ca-key.pem')));
  const outside = issueWebLeaf(caKey, 'Sable on sable-test', createPrivateKey(key), 'outside.example', [], Date.now());
  expect(outside.checkHost('outside.example')).toBeDefined();
  expect(outside.verify(ca.publicKey)).toBe(true);
  await expect(connect(outside, 'outside.example')).rejects.toThrow(/permitted subtree|name constraint/i);
});

it.runIf(process.platform === 'win32')('writes no private key if Windows refuses to protect the key directory', () => {
  const home = fixture();
  const denied = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => { throw Error('Access denied'); });
  try {
    expect(() => webCertificates(home, ['10.0.0.2'])).toThrow(/restrict the web key directory/);
    expect(existsSync(path.join(home, 'web/ca-key.pem'))).toBe(false);
    expect(existsSync(path.join(home, 'web/ca.cer'))).toBe(false);
  } finally { denied.mockRestore(); }
});

it('only LAN and link-local IPv4 addresses can be bound', () => {
  for (const ip of ['10.0.0.0', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.2']) expect(privateIPv4(ip)).toBe(true);
  for (const ip of ['127.0.0.1', '172.15.1.1', '172.32.1.1', '8.8.8.8', '0.0.0.0', '::', '10.0.0.256']) expect(privateIPv4(ip)).toBe(false);
});

