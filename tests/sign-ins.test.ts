import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PHONE_METHODS, type BridgeEvent, type BrowserAnswer, type BrowserRequest, type SessionMeta, type ToolItem } from '@shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { App } from '../server/app';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import { BROWSER_DESCRIPTIONS, BROWSER_HELD, BROWSER_HINT, BROWSER_INPUT_SCHEMAS, BROWSER_OPS, BROWSER_TOOL_IDS, BROWSER_TOOLS, browserContextLine, cleanToolInput, runBrowserTool, SIGN_IN_KEYS, streamsInput } from '../server/providers/browser-tool';
import { draftItem } from '../server/providers/codex-map';
import { DemoProvider } from '../server/providers/demo';
import { MAX_SIGN_INS, SIGN_IN_SHIPS, setSignInHolds, setSignInShips, SignInStore, signInOrigin } from '../server/services/sign-ins';
import { DEFAULT_SETTINGS } from '@shared/protocol';
import { signInProbeScript, snapshotScript } from '../src/features/rail/browser-scripts';

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

  it('every signIn method answers off and reads or writes nothing; none of them carries a secret', async () => {
    const home = temp();
    const app = new App({ home, providers: [(c) => new DemoProvider(c, { speed: 0 })], quiet: true });
    // A read leaves no trace in the folder: the store's own reading is watched instead.
    const load = vi.spyOn(SignInStore.prototype as unknown as { load(): unknown }, 'load');
    try {
      const before = readdirSync(home).sort();
      const calls: [string, Record<string, unknown>][] = [
        ['signIn.list', {}],
        ['signIn.list', { origin: 'https://portal.example.test' }],
        ['signIn.remove', { id: '0123456789abcdef' }],
      ];
      for (const [m, p] of calls) await expect(app.call(m as never, p as never)).rejects.toThrow(/SIGN_IN_OFF/);
      expect(existsSync(path.join(home, 'sign-ins.json'))).toBe(false);
      expect(readdirSync(home).sort()).toEqual(before);
      // Finding 1: no method of the bridge reveals or takes a password, switched on or off.
      for (const m of ['signIn.reveal', 'signIn.save', 'signIn.state', 'signIn.used']) await expect(app.call(m as never, {} as never)).rejects.toThrow(/Unknown method/);
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
      await app.dispose();
    }
  });
});

describe('the saved sign-ins (server/services/sign-ins.ts)', () => {
  it('keeps ciphertext and names only, and hands the ciphertext over for the exact origin only', () => {
    const dir = temp();
    const s = new SignInStore(dir);
    s.put('https://portal.example.test', 'student.one', 'CIPHER-made-up');
    const raw = readFileSync(path.join(dir, 'sign-ins.json'), 'utf8');
    expect(raw).toContain('student.one');
    const [one] = s.all('https://portal.example.test');
    expect(one).toMatchObject({ origin: 'https://portal.example.test', username: 'student.one' });
    expect(Object.keys(one)).not.toContain('secret');
    expect(s.entryOf(one.id, 'https://portal.example.test')?.cipher).toBe('CIPHER-made-up');
    // Never a look-alike, a subdomain, another port or the plain-http twin.
    for (const o of ['https://portal.example.test.evil.test', 'https://login.portal.example.test', 'https://portal.example.test:8443', 'http://portal.example.test', 'https://portal-example.test']) expect(s.entryOf(one.id, o)?.cipher).toBeUndefined();
    // Written atomically: no temporary file is left beside it.
    expect(readdirSync(dir)).toEqual(['sign-ins.json']);
    // Read on every use: a second store on the same folder (Electron main's) sees the same list.
    expect(new SignInStore(dir).all()).toEqual(s.all());
  });

  it('only https origins (and http on this machine), written exactly as the browser has them', () => {
    expect(signInOrigin('https://portal.example.test')).toBe('https://portal.example.test');
    expect(signInOrigin('http://127.0.0.1:4100')).toBe('http://127.0.0.1:4100');
    expect(signInOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    for (const bad of ['http://portal.example.test', 'https://portal.example.test/login', 'https://user@portal.example.test', 'HTTPS://PORTAL.EXAMPLE.TEST', 'file:///c:/x', 'javascript:alert(1)', 'https://portal.example.test/', '']) expect(signInOrigin(bad)).toBeUndefined();
  });

  it('is bounded, one entry per origin and user name, and removable', () => {
    const dir = temp();
    const s = new SignInStore(dir);
    s.put('https://a.example.test', 'one', 'c1');
    s.put('https://a.example.test', 'one', 'c2');
    expect(s.all()).toHaveLength(1);
    expect(s.entryOf(s.all()[0].id, 'https://a.example.test')?.cipher).toBe('c2');
    for (let i = 0; i < MAX_SIGN_INS + 5; i++) s.put(`https://s${i}.example.test`, 'u', 'c');
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

describe('the outline script of a sign-in (browser-scripts.ts)', () => {
  it('parses, refuses frames and never fills anything (the fill is Electron main\'s)', () => {
    const probe = signInProbeScript({ userRef: 'e1', passRef: 'e2' });
    for (const x of [probe, snapshotScript(100, false)]) expect(() => new Function(`return ${x}`)).not.toThrow();
    expect(probe).toContain('window.top !== window');
    expect(probe).toContain('ownerDocument !== document');
    expect(probe).not.toMatch(/\.value\s*=|requestSubmit|\.click\(/);
  });
});

describe('finding 4 (second review): nothing of a held page reaches the agent, checked at delivery', () => {
  afterEach(() => setSignInHolds(undefined));
  const answerOf = (guestId: number | undefined) => (r: BrowserRequest): BrowserAnswer => {
    const base = { url: 'http://localhost:3000/home', title: 'Welcome, student.one', ...(guestId ? { guestId } : {}) };
    if (r.op === 'state') return { ok: true, ...base };
    if (r.op === 'read') return { ok: true, ...base, text: 'secret page text', console: [{ level: 'warning', text: 'filled made-up-pass-7351' }] };
    return { ok: true, ...base, text: 'x' };
  };

  it('page text, title, address and console of a held guest are held back, for every tool', async () => {
    setSignInHolds({ held: (id) => id === 5, anyHeld: () => true });
    for (const [op, input] of [['read', {}], ['snapshot', {}], ['eval', { script: 'return 1' }], ['logs', { kind: 'console' }], ['open', { url: 'http://localhost:3000/' }]] as const) {
      const t = makeRt();
      t.serve(answerOf(5));
      const r = await runBrowserTool(t.rt, op, input);
      expect(r, op).toEqual({ ok: false, text: BROWSER_HELD });
      expect(r.text).not.toMatch(/Welcome|secret|made-up/);
    }
  });

  it('an answer that does not say its page is held back while any page is held; another, unheld page passes', async () => {
    setSignInHolds({ held: (id) => id === 5, anyHeld: () => true });
    const unknown = makeRt();
    unknown.serve(answerOf(undefined));
    expect((await runBrowserTool(unknown.rt, 'read', {})).text).toBe(BROWSER_HELD);
    const other = makeRt();
    other.serve(answerOf(6));
    expect((await runBrowserTool(other.rt, 'read', {})).ok).toBe(true);
  });

  it('an answer already on its way when the hold began is held back too (the check is at delivery)', async () => {
    let held = false;
    setSignInHolds({ held: (id) => held && id === 5, anyHeld: () => held });
    const t = makeRt();
    t.serve((r) => {
      // The window answers, and the hold begins before the answer is delivered.
      held = r.op === 'read';
      return answerOf(5)(r);
    });
    expect((await runBrowserTool(t.rt, 'read', {})).text).toBe(BROWSER_HELD);
  });

  it('the line about the Browser tab (address and title) waits while a page is held', () => {
    const t = makeRt();
    t.rt.browserPage = { url: 'https://portal.example.test/home', title: 'Welcome, student.one' };
    setSignInHolds({ held: () => true, anyHeld: () => true });
    expect(browserContextLine(t.rt)).toBeUndefined();
    setSignInHolds(undefined);
    expect(browserContextLine(t.rt)).toMatch(/portal\.example\.test/);
  });
});

describe('finding 9: a sign-in step is clean in the first event that publishes it', () => {
  it('Codex: the step as it is first added carries only valid references', () => {
    const events: BridgeEvent[] = [];
    const m: SessionMeta = { id: 's9', provider: 'codex', cwd: '/x', title: 't', titleSource: 'auto', model: '', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
    const rt = new SessionRuntime(m, (e) => events.push(e), () => {});
    const d = draftItem({ type: 'dynamicToolCall', id: 'c1', namespace: null, tool: 'browser_sign_in', arguments: { username_ref: 'e1', password_ref: PASSWORD, submit_ref: 'e3', password: PASSWORD }, status: 'inProgress', contentItems: null, success: null } as never) as ToolItem;
    rt.add(d);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).toContain('"input":{"username_ref":"e1","submit_ref":"e3"}');
  });

  it('Claude: the input never streams; once complete it is cleaned before it is set', () => {
    expect(streamsInput('mcp__sable__browser_sign_in')).toBe(false);
    expect(streamsInput('mcp__sable__browser_click')).toBe(true);
    expect(cleanToolInput('mcp__sable__browser_sign_in', { username_ref: 'e1', password_ref: 'e2', password: PASSWORD })).toEqual({ username_ref: 'e1', password_ref: 'e2' });
    expect(cleanToolInput('mcp__sable__browser_sign_in', { username_ref: PASSWORD, password_ref: 'e2' })).toEqual({ password_ref: 'e2' });
    const other = { ref: 'e1', text: 'hello' };
    expect(cleanToolInput('mcp__sable__browser_type', other)).toBe(other);
  });
});
