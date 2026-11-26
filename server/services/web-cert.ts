import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import path from 'node:path';

const DAY = 86_400_000;
// The only DER types and OIDs these two v3 certificates use.
function der(tag: number, ...parts: Buffer[]) {
  const body = Buffer.concat(parts);
  const length = [];
  for (let n = body.length; n; n = Math.floor(n / 256)) length.unshift(n % 256);
  return Buffer.concat([Buffer.from([tag, ...(body.length < 128 ? [body.length] : [128 + length.length, ...length])]), body]);
}
const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (hex: string) => der(6, Buffer.from(hex, 'hex'));
const yes = der(1, Buffer.from([255]));
const integer = (n: number) => der(2, Buffer.from([n]));
const algorithm = seq(oid('2a8648ce3d040302')); // ecdsa-with-SHA256, absent parameters
const name = (cn: string) => seq(der(0x31, seq(oid('550403'), der(12, Buffer.from(cn)))));
function time(date: Date) {
  const digits = date.toISOString().slice(0, 19).replace(/[-:T]/g, '') + 'Z';
  return date.getUTCFullYear() < 2050 ? der(23, Buffer.from(digits.slice(2))) : der(24, Buffer.from(digits));
}
const ext = (id: string, value: Buffer, critical = false) => seq(oid('551d' + id), ...(critical ? [yes] : []), der(4, value));
const dns = (host: string) => der(0x82, Buffer.from(host, 'ascii'));
// RFC 5280 iPAddress subtrees encode the network immediately followed by its mask.
const networks = ['0a000000ff000000', 'ac100000fff00000', 'c0a80000ffff0000', 'a9fe0000ffff0000',
  'fc' + '00'.repeat(15) + 'fe' + '00'.repeat(15), 'fe80' + '00'.repeat(14) + 'ffc0' + '00'.repeat(14)];
const constraints = seq(der(0xa0, seq(dns('.local')), ...networks.map(hex => seq(der(0x87, Buffer.from(hex, 'hex'))))));

function certificate(key: KeyObject, issuer: string, subject: string, pub: KeyObject, from: Date, to: Date, extensions: Buffer[]) {
  const serial = randomBytes(19);
  serial[0] = (serial[0] & 0x7f) || 1;
  const tbs = seq(der(0xa0, integer(2)), der(2, serial), algorithm, name(issuer), seq(time(from), time(to)), name(subject),
    createPublicKey(pub).export({ type: 'spki', format: 'der' }), der(0xa3, seq(...extensions)));
  return new X509Certificate(seq(tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, key))));
}

// An opaque key identifier shared by the CA's SKI and the leaf's AKI.
const keyId = (key: KeyObject) => createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest().subarray(0, 20);

export function issueWebLeaf(caKey: KeyObject, issuer: string, key: KeyObject, host: string, addresses: string[], now: number) {
  return certificate(caKey, issuer, host, key, new Date(now - 60_000), new Date(now - 60_000 + 397 * DAY), [
    ext('0f', der(3, Buffer.from([7, 0x80])), true), ext('25', seq(oid('2b06010505070301'))),
    ext('23', seq(der(0x80, keyId(caKey)))), ext('11', seq(dns(host), ...addresses.map(ip => der(0x87, Buffer.from(ip.split('.').map(Number)))))),
  ]);
}

export function privateIPv4(ip: string) {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254;
}
export const webAddresses = () => [...new Set(Object.values(networkInterfaces()).flatMap(rows =>
  (rows ?? []).filter(i => !i.internal && privateIPv4(i.address)).map(i => i.address)))].sort();

function privateDirectory(dir: string) {
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) throw new Error('The web key directory must be a private folder.');
  if (process.platform !== 'win32') {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return chmodSync(dir, 0o700);
  }
  // chmod on Windows cannot restrict read access. Replace the DACL before creating any secrets.
  const shell = path.join((process.env.SystemRoot ?? process.env.SYSTEMROOT)!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    $dir = [IO.Directory]::CreateDirectory($env:SABLE_WEB_KEY_DIR,$acl)
    if ($dir.GetAccessControl().GetSecurityDescriptorSddlForm('Access') -ne $acl.GetSecurityDescriptorSddlForm('Access')) {
      $dir.SetAccessControl($acl)
    }`],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, SABLE_WEB_KEY_DIR: dir } });
  } catch (cause) { throw new Error('Could not restrict the web key directory to this Windows user.', { cause }); }
}

// Publish a complete file. Independent bridge processes racing on first use must adopt the same CA.
function publish(file: string, bytes: Buffer | string, replace = false) {
  const tmp = file + '.' + randomBytes(8).toString('hex');
  writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
  try {
    if (replace) return renameSync(tmp, file);
    try { linkSync(tmp, file); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
function installationKey(file: string) {
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    publish(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  }
  const st = lstatSync(file);
  if (!st.isFile() || st.nlink !== 1) throw new Error('Invalid web key file.');
  return createPrivateKey(readFileSync(file));
}

export const webHostname = (computer = hostname()) => computer.toLowerCase().replace(/\.local$/i, '') + '.local';

export function webCertificates(home: string, addresses: string[], computer = hostname(), now = Date.now()) {
  const dir = path.join(home, 'web');
  const host = webHostname(computer);
  if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      host.length > 253 || !addresses.every(privateIPv4)) throw new Error('Invalid local certificate name or address.');
  privateDirectory(dir);
  const caFile = path.join(dir, 'ca.cer');
  const caKey = installationKey(path.join(dir, 'ca-key.pem'));
  if (!existsSync(caFile)) {
    const cn = 'Sable on ' + computer;
    const end = new Date(now - 60_000);
    end.setUTCFullYear(end.getUTCFullYear() + 10);
    publish(caFile, certificate(caKey, cn, cn, caKey, new Date(now - 60_000), end, [
      ext('13', seq(yes, integer(0)), true), ext('0f', der(3, Buffer.from([2, 4])), true), ext('1e', constraints, true), ext('0e', der(4, keyId(caKey))),
    ]).raw);
  }
  const ca = new X509Certificate(readFileSync(caFile));
  if (!ca.ca || !ca.checkPrivateKey(caKey) || Date.parse(ca.validTo) <= now) throw new Error('The installed Sable CA needs attention.');
  const key = installationKey(path.join(dir, 'server-key.pem'));
  const file = path.join(dir, 'server.cer');
  let leaf = existsSync(file) ? new X509Certificate(readFileSync(file)) : undefined;
  const ips = [...new Set(addresses)].sort();
  const sans = ['DNS:' + host, ...ips.map(ip => 'IP Address:' + ip)].join(', ');
  if (!leaf || !leaf.checkPrivateKey(key) || !leaf.verify(ca.publicKey) || leaf.subjectAltName !== sans || Date.parse(leaf.validTo) - now < 30 * DAY) {
    leaf = issueWebLeaf(caKey, String(ca.toLegacyObject().subject.CN), key, host, ips, now);
    publish(file, leaf.raw, true);
  }
  return { ca, cert: leaf, key: key.export({ type: 'pkcs8', format: 'pem' }), host, addresses: ips };
}

