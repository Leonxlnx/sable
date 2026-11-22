import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PHONE_METHODS, type BridgeEvent, type BrowserAnswer, type BrowserRequest, type SessionMeta, type ToolItem } from '@shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { App } from '../server/app';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import { BROWSER_DESCRIPTIONS, BROWSER_HINT, BROWSER_INPUT_SCHEMAS, BROWSER_OPS, BROWSER_TOOL_IDS, BROWSER_TOOLS, runBrowserTool, SIGN_IN_KEYS } from '../server/providers/browser-tool';
import { DemoProvider } from '../server/providers/demo';
import { MAX_SIGN_INS, SIGN_IN_SHIPS, setSignInShips, setSignInVault, SignInStore, signInOrigin, type SignInVault } from '../server/services/sign-ins';
import { DEFAULT_SETTINGS } from '@shared/protocol';
import { signInFillScript, signInProbeScript, snapshotScript } from '../src/features/rail/browser-scripts';

/** A stand-in for Electron's safeStorage: AES-GCM under a key that belongs to "this machine". */
function vaultWith(key = randomBytes(32)): SignInVault {
  return {
    available: () => true,
    encrypt: (plain) => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    decrypt: (cipher) => {
      const b = Buffer.from(cipher, 'base64');
      const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

const PASSWORD = 'made-up-pass-7351';
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'sable-signins-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('not in this version: the switch is off', () => {
  it('ships off, offers browser_sign_in to no agent and answers a call that it is not available', async () => {
    expect(SIGN_IN_SHIPS).toBe(false);
    expect(BROWSER_OPS).not.toContain('sign_in');
    expect(BROWSER_TOOL_IDS.some((t) => t.endsWith('browser_sign_in'))).toBe(false);
    const ctx = { emit: () => {}, log: () => {}, settings: () => ({ ...DEFAULT_SETTINGS, generativeUi: false }) };
    const claude = new ClaudeProvider(ctx).agentOptions({ cwd: process.cwd(), model: '', mode: 'default' }, {});
    expect(JSON.stringify(claude.allowedTools)).not.toContain('sign_in');
    const codex = new CodexProvider(ctx).dynamicTools({ options: {} });
    expect(JSON.stringify(codex)).not.toContain('sign_in');
    // No other tool's words, nor the hint, mention it.
    for (const op of BROWSER_OPS) expect(BROWSER_DESCRIPTIONS[op]).not.toMatch(/sign_in|sign-in|sign in/i);
    expect(BROWSER_HINT).not.toMatch(/sign/i);
    const t = makeRt();
    t.serve(page('https://portal.example.test/', { ok: true, signedIn: true }));
    const r = await runBrowserTool(t.rt, 'sign_in', { username_ref: 'e1', password_ref: 'e2' });
    expect(r).toEqual({ ok: false, text: 'browser_sign_in is not available in this version of Sable.' });
    expect(t.requests).toHaveLength(0);
  });

  it('every signIn method answers off, reads and writes nothing and never calls the vault', async () => {
    const home = temp();
    const calls: string[] = [];
    setSignInVault({ available: () => (calls.push('available'), true), encrypt: (p) => (calls.push('encrypt'), p), decrypt: (c) => (calls.push('decrypt'), c) });
    const app = new App({ home, providers: [(c) => new DemoProvider(c, { speed: 0 })], quiet: true });
    try {
      const before = readdirSync(home).sort();
      const calls2: [string, Record<string, unknown>][] = [
        ['signIn.state', {}],
        ['signIn.list', {}],
        ['signIn.list', { origin: 'https://portal.example.test' }],
        ['signIn.reveal', { id: '0123456789abcdef', origin: 'https://portal.example.test' }],
        ['signIn.save', { origin: 'https://portal.example.test', username: 'student.one', password: PASSWORD }],
        ['signIn.used', { id: '0123456789abcdef' }],
        ['signIn.remove', { id: '0123456789abcdef' }],
      ];
      for (const [m, p] of calls2) await expect(app.call(m as never, p as never)).rejects.toThrow(/SIGN_IN_OFF/);
      expect(existsSync(path.join(home, 'sign-ins.json'))).toBe(false);
      expect(readdirSync(home).sort()).toEqual(before);
      expect(calls).toEqual([]);
    } finally {
      setSignInVault(undefined);
      await app.dispose();
    }
  });
});

describe('the saved sign-ins (server/services/sign-ins.ts)', () => {
  it('keeps only ciphertext on disk and gives the password back for the exact origin only', () => {
    const dir = temp();
    const s = new SignInStore(dir, () => vaultWith(Buffer.alloc(32, 7)));
    expect(s.put('https://portal.example.test', 'student.one', PASSWORD)).toBe(true);
    const raw = readFileSync(path.join(dir, 'sign-ins.json'), 'utf8');
    expect(raw).not.toContain(PASSWORD);
    expect(raw).toContain('student.one');
    const [one] = s.all('https://portal.example.test');
    expect(one).toMatchObject({ origin: 'https://portal.example.test', username: 'student.one' });
    expect(Object.keys(one)).not.toContain('secret');
    expect(s.reveal(one.id, 'https://portal.example.test')).toBe(PASSWORD);
    // Never a look-alike, a subdomain, another port or the plain-http twin.
    for (const o of ['https://portal.example.test.evil.test', 'https://login.portal.example.test', 'https://portal.example.test:8443', 'http://portal.example.test', 'https://portal-example.test']) expect(s.reveal(one.id, o)).toBeUndefined();
    // Written atomically: no temporary file is left beside it.
    expect(readdirSync(dir)).toEqual(['sign-ins.json']);
  });

  it('a file copied to another machine cannot be read there', () => {
    const dir = temp();
    new SignInStore(dir, () => vaultWith(Buffer.alloc(32, 1))).put('https://portal.example.test', 'student.one', PASSWORD);
    const elsewhere = new SignInStore(dir, () => vaultWith(Buffer.alloc(32, 2)));
    const [one] = elsewhere.all();
    expect(one.username).toBe('student.one');
    expect(elsewhere.reveal(one.id, 'https://portal.example.test')).toBeUndefined();
  });

  it('saves nothing where nothing can encrypt (dev server, standalone bridge)', () => {
    const dir = temp();
    const s = new SignInStore(dir, () => undefined);
    expect(s.canSave()).toBe(false);
    expect(s.put('https://portal.example.test', 'student.one', PASSWORD)).toBe(false);
    expect(existsSync(path.join(dir, 'sign-ins.json'))).toBe(false);
  });

  it('only https origins (and http on this machine), written exactly as the browser has them', () => {
    expect(signInOrigin('https://portal.example.test')).toBe('https://portal.example.test');
    expect(signInOrigin('http://127.0.0.1:4100')).toBe('http://127.0.0.1:4100');
    expect(signInOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    for (const bad of ['http://portal.example.test', 'https://portal.example.test/login', 'https://user@portal.example.test', 'HTTPS://PORTAL.EXAMPLE.TEST', 'file:///c:/x', 'javascript:alert(1)', 'https://portal.example.test/', '']) expect(signInOrigin(bad)).toBeUndefined();
  });

  it('is bounded, one entry per origin and user name, and removable', () => {
    const dir = temp();
    const v = vaultWith();
    const s = new SignInStore(dir, () => v);
    s.put('https://a.example.test', 'one', 'p1');
    s.put('https://a.example.test', 'one', 'p2');
    expect(s.all()).toHaveLength(1);
    expect(s.reveal(s.all()[0].id, 'https://a.example.test')).toBe('p2');
    for (let i = 0; i < MAX_SIGN_INS + 5; i++) s.put(`https://s${i}.example.test`, 'u', 'p');
    expect(s.all()).toHaveLength(MAX_SIGN_INS);
    const id = s.all()[0].id;
    expect(s.remove(id)).toBe(true);
    expect(s.all().some((x) => x.id === id)).toBe(false);
  });

  it('none of it reaches a phone', () => {
    for (const m of PHONE_METHODS as readonly string[]) expect(m.startsWith('signIn.')).toBe(false);
  });
});

/* ── the tool ── */

function makeRt() {
  const requests: BrowserRequest[] = [];
  const m: SessionMeta = { id: 's1', provider: 'demo', cwd: '/x', title: 't', titleSource: 'auto', model: '', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  let window: (r: BrowserRequest) => BrowserAnswer = () => ({ ok: false, error: 'none' });
  const rt: SessionRuntime = new SessionRuntime(
    m,
    (e: BridgeEvent) => {
      if (e.type !== 'browser.request') return;
      requests.push(e.request);
      const a = window(e.request);
      queueMicrotask(() => rt.answerBrowser(e.request.id, a));
    },
    () => {},
  );
  return { rt, requests, serve: (fn: typeof window) => (window = fn) };
}

const page = (url: string, signIn: BrowserAnswer) => (r: BrowserRequest): BrowserAnswer => (r.op === 'state' ? { ok: true, url, title: 'Portal' } : r.op === 'signIn' ? signIn : { ok: true, url });

describe('browser_sign_in, with the switch on (server/providers/browser-tool.ts)', () => {
  beforeAll(() => setSignInShips(true));
  afterAll(() => setSignInShips(undefined));
  it('is offered once the switch is on, last in the list', () => {
    expect(BROWSER_OPS.at(-1)).toBe('sign_in');
    expect(BROWSER_TOOL_IDS.at(-1)).toMatch(/__browser_sign_in$/);
  });

  it('takes only the three references: a call that carries a password, a user name or an origin is refused before the page is asked', async () => {
    expect(BROWSER_TOOLS.sign_in).toBe('browser_sign_in');
    expect(BROWSER_INPUT_SCHEMAS.sign_in).toMatchObject({ required: ['username_ref', 'password_ref'], additionalProperties: false });
    expect([...SIGN_IN_KEYS]).toEqual(['username_ref', 'password_ref', 'submit_ref']);
    for (const extra of [{ password: PASSWORD }, { username: 'student.one' }, { origin: 'https://evil.example.test' }, { url: 'https://evil.example.test' }]) {
      const t = makeRt();
      t.serve(page('https://portal.example.test/login', { ok: true, signedIn: true, user: 'x' }));
      const r = await runBrowserTool(t.rt, 'sign_in', { username_ref: 'e1', password_ref: 'e2', ...extra });
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/only the references/);
      expect(r.text).not.toContain(PASSWORD);
      expect(t.requests.map((q) => q.op)).toEqual(['state']);
    }
  });

  it('a value hidden in a reference is refused', async () => {
    const t = makeRt();
    t.serve(page('https://portal.example.test/login', { ok: true, signedIn: true }));
    const r = await runBrowserTool(t.rt, 'sign_in', { username_ref: 'e1', password_ref: PASSWORD });
    expect(r.ok).toBe(false);
    expect(r.text).not.toContain(PASSWORD);
    expect(t.requests.map((q) => q.op)).toEqual(['state']);
  });

  it('only on https pages and this machine: the origin is the page view\'s own, never the agent\'s', async () => {
    const t = makeRt();
    t.serve(page('http://portal.example.test/login', { ok: true, signedIn: true }));
    expect((await runBrowserTool(t.rt, 'sign_in', { username_ref: 'e1', password_ref: 'e2' })).text).toMatch(/only on https/);
    const ok = makeRt();
    ok.serve(page('https://portal.example.test/login?next=%2F', { ok: true, signedIn: true, user: 'student.one' }));
    const r = await runBrowserTool(ok.rt, 'sign_in', { username_ref: 'e1', password_ref: 'e2', submit_ref: 'e3' });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Signed in on https:\/\/portal\.example\.test as student\.one\./);
    const req = ok.requests.find((q) => q.op === 'signIn')!;
    expect(req).toMatchObject({ userRef: 'e1', passRef: 'e2', submitRef: 'e3', expectOrigin: 'https://portal.example.test' });
    // The request carries references only.
    expect(Object.keys(req).sort()).toEqual(['expectOrigin', 'id', 'op', 'passRef', 'sessionId', 'submitRef', 'userRef']);
  });

  it('a refusal or a cancel is told plainly, and never with a value', async () => {
    const t = makeRt();
    t.serve(page('https://portal.example.test/', { ok: false, error: 'the user cancelled the sign-in.' }));
    const r = await runBrowserTool(t.rt, 'sign_in', { username_ref: 'e1', password_ref: 'e2' });
    expect(r).toEqual({ ok: false, text: 'Not signed in: the user cancelled the sign-in.' });
  });

  it('the step keeps only the references, even when the model put a password into its call', async () => {
    const t = makeRt();
    t.serve(page('https://portal.example.test/', { ok: true, signedIn: true }));
    const id = 'tool-1';
    t.rt.add({ id, type: 'tool', ts: 0, name: 'mcp__sable__browser_sign_in', kind: 'browser', title: 'Sign in', status: 'running', input: { username_ref: 'e1', password_ref: 'e2', password: PASSWORD } } as ToolItem);
    await runBrowserTool(t.rt, 'sign_in', { username_ref: 'e1', password_ref: 'e2', password: PASSWORD });
    expect(JSON.stringify(t.rt.get(id))).not.toContain(PASSWORD);
  });
});

describe('the page scripts of a sign-in (browser-scripts.ts)', () => {
  it('parse, carry values only as data, refuse frames and check the origin at the moment of filling', () => {
    const probe = signInProbeScript({ userRef: 'e1', passRef: 'e2' });
    const fill = signInFillScript({ userRef: 'e1', passRef: 'e2' }, 'https://portal.example.test', 'a"b', `x'); alert(1); ('`);
    for (const s of [probe, fill, snapshotScript(100, false)]) expect(() => new Function(`return ${s}`)).not.toThrow();
    expect(probe).toContain('window.top !== window');
    expect(probe).toContain('ownerDocument !== document');
    expect(fill).toContain(`location.origin !== "https://portal.example.test"`);
    expect(fill).toContain(JSON.stringify(`x'); alert(1); ('`));
  });
});
