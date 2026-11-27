import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, chmodSync, existsSync, lstatSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { runOff } from './web-run';
import { isIPv4 } from 'node:net';
import path from 'node:path';

const DAY = 86_400_000;
/** Lets the bridge's other work run between the pieces of an issue (keys, files, a process start). */
const breath = () => new Promise<void>(r => setImmediate(r));
// The only DER types and OIDs these v3 certificates use.
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
  checkNames(host, addresses);
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

async function privateDirectory(dir: string) {
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) throw new Error('The web key directory must be a private folder.');
  if (process.platform !== 'win32') {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return chmodSync(dir, 0o700);
  }
  // chmod on Windows cannot restrict read access. Replace the DACL before creating any secrets.
  try {
    await powershell(['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    $dir = [IO.Directory]::CreateDirectory($env:SABLE_WEB_KEY_DIR,$acl)
    if ($dir.GetAccessControl().GetSecurityDescriptorSddlForm('Access') -ne $acl.GetSecurityDescriptorSddlForm('Access')) {
      $dir.SetAccessControl($acl)
    }
    if (!$dir.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Equals($sid)) { throw 'Unexpected web key directory owner' }`],
    { ...process.env, SABLE_WEB_KEY_DIR: dir });
  } catch (cause) { throw new Error('Could not restrict the web key directory to this Windows user.', { cause }); }
}

/**
 * One Windows PowerShell run, off the bridge's thread (each takes 0.5 to 2 s, far more under load: run
 * synchronously, three of them held every chat for about 2 s while a certificate was issued; and even
 * the start of a process holds the thread it starts from, so it starts from a worker: web-run.ts). Its
 * standard output as bytes; a failure carries the exit code as `status`.
 */
function powershell(args: string[], env: NodeJS.ProcessEnv): Promise<Buffer> {
  return runOff(keyShell(), args, env, { timeout: 60_000, maxBuffer: 1 << 20 });
}

// Publish only a complete file. The provisioning lock covers the whole chain.
function publish(file: string, bytes: Buffer | string, replace = false) {
  const tmp = file + '.' + randomBytes(8).toString('hex');
  writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
  try {
    if (replace) return renameSync(tmp, file);
    try { linkSync(tmp, file); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
const keyShell = () => path.join((process.env.SystemRoot ?? process.env.SYSTEMROOT)!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
// Open the final component without following a reparse point. Query identity, link count,
// owner and DACL, then read from the very same handle with write/delete sharing denied.
const readWindowsKey = String.raw`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public class SablePrivateFile {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr template);
 [StructLayout(LayoutKind.Sequential)] struct Info { public uint attrs, c1,c2,a1,a2,w1,w2,vol,sizeHi,sizeLo,links,indexHi,indexLo; }
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
 public static byte[] Read(string path) {
  using(var h=CreateFile(path,0x80020000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
   Info i; if(h.IsInvalid || !GetFileInformationByHandle(h,out i) || (i.attrs & 0x410)!=0 || i.links!=1 || i.sizeHi!=0 || i.sizeLo>65536) throw new IOException("Invalid web key file");
   using(var f=new FileStream(h,FileAccess.Read)) {
    var acl=f.GetAccessControl(); var sid=WindowsIdentity.GetCurrent().User;
    var security=new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(),0);
    if(!sid.Equals(security.Owner) || security.DiscretionaryAcl==null) throw new UnauthorizedAccessException("Unexpected web key owner or DACL");
    foreach(GenericAce ace in security.DiscretionaryAcl) {
     var rule=ace as CommonAce;
     if(rule==null || rule.IsCallback || !sid.Equals(rule.SecurityIdentifier)) throw new UnauthorizedAccessException("Unexpected web key access rule");
    }
    using(var b=new MemoryStream()) { f.CopyTo(b); return b.ToArray(); }
   }
  }
 }
}
'@
try { $bytes=[SablePrivateFile]::Read($env:SABLE_WEB_PRIVATE_FILE) }
catch {
  if ($_.Exception.GetBaseException().Message.StartsWith('Unexpected web key')) { exit 65 }
  throw
}
[Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)`;

async function readPrivate(file: string) {
  const st = lstatSync(file);
  if (!st.isFile() || st.nlink !== 1) throw Error('Invalid web key file.');
  if (process.platform === 'win32') {
    try {
      return await powershell(['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(readWindowsKey, 'utf16le').toString('base64')],
        { ...process.env, SABLE_WEB_PRIVATE_FILE: file });
    } catch (cause) {
      if ((cause as { status?: number }).status === 65) throw Error('Unsafe Windows web key owner or permissions.');
      throw new Error('Windows could not verify the web private key.', { cause });
    }
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) || stat.size > 65536)
      throw Error('Unsafe web key permissions.');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
const newKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
const pem = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }).toString();

function newAuthority(computer: string, now: number, replacement?: string) {
  const root = newKey(), issuer = newKey();
  const cn = 'Sable on ' + computer, issuingName = cn + ' LAN issuer';
  const from = new Date(now - 60_000), end = new Date(from);
  end.setUTCFullYear(end.getUTCFullYear() + 10);
  const caExtensions = (len: number, key: KeyObject) => [ext('13', seq(yes, integer(len)), true),
    ext('0f', der(3, Buffer.from([2, 4])), true), ext('0e', der(4, keyId(key)))];
  const ca = certificate(root, cn, cn, root, from, end, caExtensions(1, root));
  const intermediate = certificate(root, cn, issuingName, issuer, from, end, [
    ...caExtensions(0, issuer), ext('23', seq(der(0x80, keyId(root)))), ext('1e', constraints, true),
  ]);
  // No export of the root key. Only these strings leave the issuance scope.
  return { root: ca.toString(), intermediate: intermediate.toString(), key: pem(issuer), replacement };
}

export const webHostname = (computer = hostname()) => computer.toLowerCase().replace(/\.local$/i, '') + '.local';

function checkNames(host: string, addresses: string[]) {
  if (!host.endsWith('.local') || host.length > 253 || !host.split('.').every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !addresses.every(privateIPv4))
    throw Error('Invalid local certificate name or address.');
}

/** A lock older than this was left by a process that ended while it issued (each step is bounded at 60 s). */
const STALE_LOCK_MS = 5 * 60_000;

/** Issues under way in this process, per key folder: the next waits for the last (the lock file serializes processes). */
const issuing = new Map<string, Promise<unknown>>();

/**
 * The chain for these addresses, issued or renewed as needed. Asynchronous: the three PowerShell runs on
 * Windows (the folder's DACL, the two key reads) go off the bridge's thread; what stays on it (keys,
 * signatures, small files) takes a few milliseconds. Two calls in one process take turns (a listener
 * restarted for another network while the first issue still ran found the lock file taken).
 */
export function webCertificates(home: string, addresses: string[], computer = hostname(), now = Date.now()) {
  const dir = path.join(home, 'web');
  const run = (issuing.get(dir) ?? Promise.resolve()).catch(() => {}).then(() => issue(home, addresses, computer, now));
  issuing.set(dir, run);
  const done = () => { if (issuing.get(dir) === run) issuing.delete(dir); };
  run.then(done, done);
  return run;
}

async function issue(home: string, addresses: string[], computer: string, now: number) {
  const dir = path.join(home, 'web'), host = webHostname(computer);
  checkNames(host, addresses);
  await privateDirectory(dir);
  // Serialize migration and rotation as well as leaf renewal across bridge processes. A lock a process
  // left when it ended mid-issue (older than any issue can take) no longer blocks issuing for good.
  const lock = path.join(dir, 'issuing.lock');
  try {
    if (Date.now() - lstatSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
  } catch { /* none */ }
  const fd = openSync(lock, 'wx', 0o600);
  try {
    const caFile = path.join(dir, 'ca.cer'), issuerFile = path.join(dir, 'issuer.json');
    const legacy = path.join(dir, 'ca-key.pem');
    let reason: string | undefined;
    if (existsSync(legacy)) {
      unlinkSync(legacy);
      reason = 'Replaced the legacy CA. Remove the old root and install the new root.';
    }
    let bundle: ReturnType<typeof newAuthority> | undefined;
    if (existsSync(issuerFile)) {
      const bytes = await readPrivate(issuerFile);
      try {
        bundle = JSON.parse(bytes.toString());
        const issuer = new X509Certificate(bundle!.intermediate), root = new X509Certificate(bundle!.root);
        if (!issuer.ca || !root.ca || !root.verify(root.publicKey) || !issuer.verify(root.publicKey) ||
            !issuer.checkPrivateKey(createPrivateKey(bundle!.key)) || Date.parse(issuer.validTo) <= now || Date.parse(root.validTo) <= now)
          throw Error();
      } catch { reason = 'The issuing key or certificate was lost or expired. Remove the old root and install the new root.'; }
    } else if (existsSync(caFile)) reason ??= 'The issuing key was lost. Remove the old root and install the new root.';
    if (!bundle || reason) {
      await breath();
      bundle = newAuthority(computer, now, reason);
      publish(issuerFile, JSON.stringify(bundle), true);
    }
    const ca = new X509Certificate(bundle.root), intermediate = new X509Certificate(bundle.intermediate);
    await breath();
    if (!existsSync(caFile) || !ca.raw.equals(readFileSync(caFile))) publish(caFile, ca.raw, true);
    const serverFile = path.join(dir, 'server-key.pem');
    await breath();
    if (!existsSync(serverFile)) publish(serverFile, pem(newKey()));
    const key = createPrivateKey(await readPrivate(serverFile));
    const file = path.join(dir, 'server.cer');
    let leaf = existsSync(file) ? new X509Certificate(readFileSync(file)) : undefined;
    const ips = [...new Set(addresses)].sort();
    const sans = ['DNS:' + host, ...ips.map(ip => 'IP Address:' + ip)].join(', ');
    if (!leaf || !leaf.checkPrivateKey(key) || !leaf.verify(intermediate.publicKey) || leaf.subjectAltName !== sans || Date.parse(leaf.validTo) - now < 30 * DAY) {
      await breath();
      leaf = issueWebLeaf(createPrivateKey(bundle.key), String(intermediate.toLegacyObject().subject.CN), key, host, ips, now);
      publish(file, leaf.raw, true);
    }
    return { ca, intermediate, cert: leaf, key: pem(key), host, addresses: ips, replacement: bundle.replacement };
  } finally { closeSync(fd); unlinkSync(lock); }
}
