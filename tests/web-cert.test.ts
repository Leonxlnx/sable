import { restoreWebAcl } from './web-acl-fixture';
import * as childProcess from 'node:child_process';
import * as webRun from '../server/services/web-run';
import { createPrivateKey, generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { createServer, get } from 'node:https';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { issueWebLeaf, privateIPv4, webCertificates } from '../server/services/web-cert';

// Outside the ACL fixture every key read is a PowerShell run that compiles its C# reader (about
// 0.7 s each, 2 s per provisioning on an idle machine, far more beside a build): 5 s is too short.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const capture = vi.hoisted(() => ({ keys: undefined as KeyObject[] | undefined }));
vi.mock('node:crypto', async original => {
  const mod = await original<typeof import('node:crypto')>();
  return { ...mod, generateKeyPairSync: (...args: Parameters<typeof generateKeyPairSync>) => {
    const pair = mod.generateKeyPairSync(...args);
    capture.keys?.push(pair.privateKey as KeyObject);
    return pair;
  } };
});
const homes: string[] = [];
function fixture() { const home = mkdtempSync(path.join(process.env.TEMP!, 'web-cert-')); homes.push(home); return home; }
afterEach(() => {
  capture.keys = undefined;
  for (const dir of homes.splice(0)) { restoreWebAcl(dir); rmSync(dir, { recursive: true, force: true }); }
});

it('verifies root, constrained issuer and renewable server leaf with X509Certificate', async () => {
  const home = fixture(), day = 86_400_000, now = Date.now();
  const issue = (days: number, ips = ['10.0.0.2']) => webCertificates(home, ips, 'sable-test', now + days * day);
  const { ca, intermediate, cert, host } = await issue(0);
  expect(ca.ca && intermediate.ca && !cert.ca).toBe(true);
  expect(ca.verify(ca.publicKey)).toBe(true);
  expect(intermediate.checkIssued(ca) && intermediate.verify(ca.publicKey)).toBe(true);
  expect(cert.checkIssued(intermediate) && cert.verify(intermediate.publicKey)).toBe(true);
  expect(cert.verify(ca.publicKey)).toBe(false);
  expect(cert.checkHost(host)).toBe(host);
  expect(cert.checkIP('10.0.0.2')).toBe('10.0.0.2');
  expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
  expect(Date.parse(cert.validTo) - Date.parse(cert.validFrom)).toBe(397 * day);
  expect((await issue(366)).cert.raw).toEqual(cert.raw);
  expect((await issue(368)).cert.raw).not.toEqual(cert.raw);
  const moved = await issue(368, ['172.17.0.4']);
  expect(moved.cert.checkIP('172.17.0.4')).toBeDefined();
  expect(moved.intermediate.raw).toEqual(intermediate.raw);
  expect(moved.ca.raw).toEqual(ca.raw);
}, 30_000);

it('keeps the root private key out of every file and every returned field', async () => {
  const home = fixture();
  capture.keys = [];
  const issued = await webCertificates(home, ['192.168.1.5']);
  const rootKey = capture.keys.find(k => issued.ca.checkPrivateKey(k))!;
  expect(rootKey).toBeDefined();
  const encodings: Buffer[] = [];
  for (const type of ['pkcs8', 'sec1'] as const) {
    const der = rootKey.export({ format: 'der', type });
    const pem = rootKey.export({ format: 'pem', type }).toString();
    encodings.push(der, Buffer.from(der.toString('base64')), Buffer.from(pem), Buffer.from(JSON.stringify(pem)));
  }
  const dir = path.join(home, 'web');
  for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) if (file.isFile()) {
    const bytes = readFileSync(path.join(file.parentPath, file.name));
    for (const encoding of encodings) expect(bytes.includes(encoding), file.name).toBe(false);
  }
  const visited = new Set<object>();
  const visit = (value: unknown) => {
    expect(value === rootKey).toBe(false);
    if (!value || typeof value !== 'object' || visited.has(value) || ArrayBuffer.isView(value)) return;
    visited.add(value);
    for (const name of Reflect.ownKeys(value)) visit(Object.getOwnPropertyDescriptor(value, name)?.value);
  };
  visit(issued);
  expect(Object.keys(issued).sort()).toEqual(['ca','intermediate','cert','key','host','addresses','replacement'].sort());
  expect(issued.ca.checkPrivateKey(createPrivateKey(issued.key))).toBe(false);
  for (const c of [issued.ca, issued.intermediate, issued.cert]) expect(c.publicKey.type).toBe('public');
});

it('reports a replacement root after loss or expiry of the intermediate', async () => {
  const home = fixture(), now = Date.now();
  const issue = (at = now) => webCertificates(home, ['10.0.0.2'], 'sable-test', at);
  const first = await issue();
  unlinkSync(path.join(home, 'web/issuer.json'));
  const second = await issue();
  expect(second.ca.raw).not.toEqual(first.ca.raw);
  expect((await issue()).replacement).toMatch(/install the new root/i);
  const third = await issue(Date.parse(second.intermediate.validTo) + 1);
  expect(third.ca.raw).not.toEqual(second.ca.raw);
  expect(third.replacement).toMatch(/expired/i);
});

// Re-sign a test TBS with a same-length DNS substitution, independently of production's SAN validator.
function publicNameFixture(cert: X509Certificate, issuer: KeyObject) {
  const outer = cert.raw;
  const header = (at: number) => outer[at+1] < 128 ? 2 : 2 + (outer[at+1] & 127);
  const t = header(0), h = header(t), end = t + h + outer.readUIntBE(t+2, h-2);
  const tbs = Buffer.from(outer.subarray(t, end));
  const before = Buffer.from('sable-test.local'), after = Buffer.from('outsider.example');
  for (let at = tbs.indexOf(before); at >= 0; at = tbs.indexOf(before)) after.copy(tbs, at);
  const algorithm = outer.subarray(end, end + 2 + outer[end + 1]);
  const signature = sign('sha256', tbs, issuer);
  const body = Buffer.concat([tbs, algorithm, Buffer.from([3, signature.length+1, 0]), signature]);
  return new X509Certificate(Buffer.concat([Buffer.from([48, 130, body.length >> 8, body.length & 255]), body]));
}

it('TLS trusts only the root and rejects a matching public SAN signed by its intermediate', async () => {
  const home = fixture();
  const { ca, intermediate, cert, key, host } = await webCertificates(home, ['192.168.1.5'], 'sable-test');
  async function connect(leaf: X509Certificate, servername: string) {
    const server = createServer({ key, cert: leaf.toString() + intermediate.toString() }, (_, res) => res.end());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      await new Promise<void>((resolve, reject) => {
        get({ host: '127.0.0.1', port: (server.address() as { port: number }).port, servername, ca: ca.toString(), agent: false },
          res => { res.resume(); res.on('end', resolve); }).on('error', reject);
      });
    } finally { await new Promise<void>(r => server.close(() => r())); }
  }
  await connect(cert, host);
  await expect(connect(cert, 'other.local')).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  const issuer = createPrivateKey(JSON.parse(readFileSync(path.join(home, 'web/issuer.json'), 'utf8')).key);
  expect(() => issueWebLeaf(issuer, 'issuer', createPrivateKey(key), 'outsider.example', [], Date.now())).toThrow(/Invalid local/);
  const outside = publicNameFixture(cert, issuer);
  expect(outside.checkHost('outsider.example')).toBe('outsider.example');
  expect(outside.verify(intermediate.publicKey)).toBe(true);
  await expect(connect(outside, 'outsider.example')).rejects.toThrow(/permitted subtree|name constraint/i);
});

/** web-cert's PowerShell runs (web-run.ts), refused with `fail` for the runs it picks; the rest run for real. */
function failRuns(pick: (env: NodeJS.ProcessEnv | undefined) => Error | undefined) {
  const real = webRun.runOff;
  return vi.spyOn(webRun, 'runOff').mockImplementation((file, args, env, opts) => {
    const fail = pick(env);
    return fail ? Promise.reject(fail) : real(file, args, env, opts);
  });
}

it.runIf(process.platform === 'win32')('writes no private key if Windows refuses to protect the key directory', async () => {
  const home = fixture();
  const denied = failRuns(() => Error('Access denied'));
  try {
    await expect(webCertificates(home, ['10.0.0.2'])).rejects.toThrow(/restrict the web key directory/);
    expect(existsSync(path.join(home, 'web/issuer.json'))).toBe(false);
    expect(existsSync(path.join(home, 'web/ca.cer'))).toBe(false);
  } finally { denied.mockRestore(); }
});

it('only LAN and link-local IPv4 addresses can be bound', () => {
  for (const ip of ['10.0.0.0', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.2']) expect(privateIPv4(ip)).toBe(true);
  for (const ip of ['127.0.0.1', '172.15.1.1', '172.32.1.1', '8.8.8.8', '0.0.0.0', '::', '10.0.0.256']) expect(privateIPv4(ip)).toBe(false);
});


it.runIf(process.platform === 'win32')('fails closed when reuse cannot verify a restored private file ACL', async () => {
  const home = fixture();
  const first = await webCertificates(home, ['10.0.0.2']);
  const spy = failRuns(env => env?.SABLE_WEB_PRIVATE_FILE?.endsWith('issuer.json') ? Error('Unexpected web key access rule') : undefined);
  try {
    await expect(webCertificates(home, ['10.0.0.2'])).rejects.toThrow(/could not verify/);
    expect(readFileSync(path.join(home, 'web/ca.cer'))).toEqual(first.ca.raw);
  } finally { spy.mockRestore(); }
});

it.runIf(process.platform === 'win32' && process.env.SABLE_TEST_WEB_ACL_FIXTURE !== '1')('rejects an existing key with a protected permissive Windows DACL', async () => {
  const home = fixture();
  await webCertificates(home, ['10.0.0.2']);
  const file = path.join(home, 'web/server-key.pem');
  childProcess.execFileSync('icacls.exe', [file, '/inheritance:d', '/grant', '*S-1-5-32-545:R'], { windowsHide: true });
  await expect(webCertificates(home, ['10.0.0.2'])).rejects.toThrow(/Unsafe Windows web key owner or permissions/);
});

// Found by the first end-to-end run: three synchronous PowerShell runs held the bridge (every chat, every
// socket) for about 2 s while a certificate was issued. Now no piece of an issue holds it for 50 ms. A hold
// of the code's own is there in every attempt; one that a busy machine adds (the suite's other workers
// building beside it) is not: the best of three attempts is what is judged.
it('never holds the bridge’s thread for 50 ms while it issues a chain (first issue and a reuse)', async () => {
  const best = { first: Infinity, reuse: Infinity };
  for (let attempt = 0; attempt < 3 && (best.first >= 50 || best.reuse >= 50); attempt++) {
    const home = fixture();
    for (const round of ['first', 'reuse'] as const) {
      let last = performance.now(), worst = 0;
      const beat = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; }, 2);
      try {
        const started = performance.now();
        await webCertificates(home, ['10.0.0.2'], 'sable-test');
        const t = performance.now();
        worst = Math.max(worst, t - last);
        console.log(`[web-cert] ${round}: ${Math.round(t - started)} ms in all, the longest hold ${worst.toFixed(1)} ms`);
      } finally { clearInterval(beat); }
      best[round] = Math.min(best[round], worst);
    }
  }
  expect(best.first, 'first').toBeLessThan(50);
  expect(best.reuse, 'reuse').toBeLessThan(50);
});

it('two issues in one process take turns instead of finding the lock taken', async () => {
  const home = fixture();
  const [a, b] = await Promise.all([webCertificates(home, ['10.0.0.2'], 'sable-test'), webCertificates(home, ['10.0.0.3'], 'sable-test')]);
  expect(a.ca.raw).toEqual(b.ca.raw);
  expect(a.cert.checkIP('10.0.0.2')).toBe('10.0.0.2');
  expect(b.cert.checkIP('10.0.0.3')).toBe('10.0.0.3');
  expect(existsSync(path.join(home, 'web', 'issuing.lock'))).toBe(false);
});

it('takes over an issuing lock a process left when it ended mid-issue', async () => {
  const home = fixture();
  await webCertificates(home, ['10.0.0.2'], 'sable-test');
  const lock = path.join(home, 'web', 'issuing.lock');
  writeFileSync(lock, '');
  // A lock of now still serializes: a second issue meanwhile is refused.
  await expect(webCertificates(home, ['10.0.0.2'], 'sable-test')).rejects.toMatchObject({ code: 'EEXIST' });
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lock, old, old);
  expect((await webCertificates(home, ['10.0.0.2'], 'sable-test')).cert.checkIP('10.0.0.2')).toBe('10.0.0.2');
  expect(existsSync(lock)).toBe(false);
});
