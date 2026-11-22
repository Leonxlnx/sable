/**
 * The phone endpoint after review wave 5 (scratch/reviews/out-wave5.md), the desktop's side:
 * - 6: a pairing that names the plain one it replaces needs a live ticket of it (a retried
 *   `phone.migrate` keeps the earlier ticket, a wrong one uses nothing up), and the new entry and the
 *   removal are written together or not at all; a separate pairing says so.
 * - 8: what an approval reaches (grant roots, network destinations, both ends of a move) is data, in
 *   its words, and a request the phone cannot show whole is desktop-only, also before its change came.
 * - 9: a send that waits (for the agent to start, for a model change) does not go out once its phone
 *   is removed meanwhile.
 * - 20: a queued message taken back with a receipt leaves the queue only on the phone's word.
 * - 21: a message without words changes nothing; an empty list of pictures removes them.
 * - 23: `app.hello` and what waits come in pages bounded by bytes, by cursor.
 * Demo agent, a fake Codex app-server and local sockets only.
 */
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState, PermissionRequest, PhoneHelloState, PhonePromptsPage, PhoneTail, QueuedMessage, SessionMeta, ToolItem, UserItem } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import type { ProviderSession } from '../server/providers/types';
import { registerFs } from '../server/services/fs';
import { PHONE_BYTES, phoneAllowed, phonePermission, phoneResult, registerPhone, sessionsPage, type PhoneService } from '../server/services/phone';
import { pskOfKey } from '../mobile/src/lib/secure';
import { beside, fingerprintIn, handshake, helloPlain, keyOf, legacyPairing, pairSecure, wireClient, type WireClient } from './phone-wire';

// Pages of many megabytes, sealed and compressed, take seconds when the whole suite runs at once.
vi.setConfig({ testTimeout: 60_000 });

const homes: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
};
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((r) => (open = r));
  return { wait: () => shut, open };
}

/**
 * The Demo agent, with its start (`open`) and its model change held at gates when a test sets them,
 * and every message it is handed recorded.
 */
async function setup(opts: { legacy?: { id?: string; name?: string }[]; home?: string } = {}) {
  const home = opts.home ?? mkdtempSync(path.join(tmpdir(), 'sable-phone-w5-'));
  homes.push(home);
  const old = opts.legacy ? legacyPairing(home, opts.legacy) : [];
  const gates: { open?: ReturnType<typeof gate>; model?: ReturnType<typeof gate> } = {};
  const sent: string[] = [];
  const app = new App({
    home,
    quiet: true,
    providers: [
      (ctx) => {
        const p = new DemoProvider(ctx, { speed: 0 });
        const open = p.open.bind(p);
        p.open = async (rt, o) => {
          await gates.open?.wait();
          const h = (await open(rt, o)) as ProviderSession;
          const send = h.send.bind(h);
          h.send = async (m) => {
            sent.push(m.text);
            return send(m);
          };
          const setModel = h.setModel.bind(h);
          h.setModel = async (m) => {
            await gates.model?.wait();
            return setModel(m);
          };
          return h;
        };
        return p;
      },
    ],
  });
  cleanups.push(() => app.dispose());
  registerFs(app);
  const phone = registerPhone(app, { port: 0, host: '127.0.0.1' });
  const status = await app.call('phone.setEnabled', { on: true });
  expect(status.listening).toBe(true);
  return { app, phone, home, port: status.port, old, gates, sent };
}

async function chatOf(app: App, c: WireClient, home: string) {
  const created = (await c.call('session.create', { provider: 'demo', cwd: beside(home) })) as { result: PhoneTail };
  return app.sessions.get(created.result.session.id)!;
}

// ── 6 ──

describe('a pairing that replaces a plain one (6)', () => {
  /** Pairs securely naming `replaces`: the desktop's first answer (`waiting` or a refusal), and once allowed, the outcome. */
  async function pairNaming(app: App, port: number, replaces: unknown, name = 'Old phone') {
    const offer = await app.call('phone.pair', {});
    const c = wireClient(port);
    cleanups.push(() => c.ws.close());
    expect(await handshake(c, 'pair', fingerprintIn(offer), pskOfKey(keyOf(offer)))).toEqual({});
    c.send({ pair: { key: keyOf(offer), name, ...(replaces ? { replaces } : {}) } });
    const first = await c.next((f) => 'waiting' in f || 'denied' in f);
    return {
      c,
      first,
      allow: async () => {
        const asking = await app.call('phone.status', {});
        await app.call('phone.approve', { requestId: asking.request!.id, allow: true });
        return (await c.next((f) => 'paired' in f || 'denied' in f)) as { paired?: { token: string; deviceId: string; replaced?: string }; denied?: string };
      },
    };
  }
  const ids = async (app: App) => (await app.call('phone.status', {})).devices.map((d) => d.id);
  const ticketOf = async (port: number, token: string) => {
    const plain = await helloPlain(port, token);
    cleanups.push(() => plain.ws.close());
    return ((await plain.call('phone.migrate')) as { result: { ticket: string } }).result.ticket;
  };

  it('asking for a ticket again keeps the first: pairing with it replaces the old entry, and says so', async () => {
    const { app, port, old } = await setup({ legacy: [{ id: 'old-a', name: 'Pixel' }] });
    const first = await ticketOf(port, old[0].token);
    await ticketOf(port, old[0].token);
    const p = await pairNaming(app, port, { id: 'old-a', ticket: first });
    expect('waiting' in p.first).toBe(true);
    // The desktop's request names the pairing it replaces.
    expect((await app.call('phone.status', {})).request?.replaces).toBe('Pixel');
    const done = await p.allow();
    expect(done.paired?.replaced).toBe('old-a');
    expect(await ids(app)).toEqual([done.paired!.deviceId]);
    // The old token no longer connects.
    const plain = wireClient(port);
    await plain.open;
    plain.send({ hello: { token: old[0].token } });
    expect((await plain.next((f) => 'denied' in f)).denied).toBe('This phone is not paired with this computer');
  });

  it('a wrong ticket is refused before anyone is asked, and uses up neither the code nor the real ticket', async () => {
    const { app, port, old } = await setup({ legacy: [{ id: 'old-a' }] });
    const ticket = await ticketOf(port, old[0].token);
    const wrong = await pairNaming(app, port, { id: 'old-a', ticket: 'not-the-ticket-0123456789' });
    expect(wrong.first.denied).toBe('This pairing could not replace the earlier one on this computer. Pair again from the phone.');
    const st = await app.call('phone.status', {});
    expect(st.request).toBeUndefined();
    expect(st.devices.map((d) => d.id)).toEqual(['old-a']);
    // The real ticket still replaces it.
    const p = await pairNaming(app, port, { id: 'old-a', ticket });
    expect((await p.allow()).paired?.replaced).toBe('old-a');
    expect(await ids(app)).not.toContain('old-a');
  });

  it('a ticket that ran out while the desktop asked: refused, never a separate pairing in its place', async () => {
    const { app, phone, port, old } = await setup({ legacy: [{ id: 'old-a' }] });
    const ticket = await ticketOf(port, old[0].token);
    const p = await pairNaming(app, port, { id: 'old-a', ticket });
    expect('waiting' in p.first).toBe(true);
    for (const t of (phone as unknown as { tickets: Map<string, { expires: number }[]> }).tickets.get('old-a')!) t.expires = Date.now() - 1;
    const done = await p.allow();
    expect(done.denied).toBe('This pairing could not replace the earlier one on this computer. Pair again from the phone.');
    expect(await ids(app)).toEqual(['old-a']);
  });

  it('the new entry and the removal are written together: when they cannot be written, neither is in effect', async () => {
    const { app, port, old, home } = await setup({ legacy: [{ id: 'old-a' }] });
    const file = path.join(home, 'phone.json');
    const ticket = await ticketOf(port, old[0].token);
    // The write cannot happen (its temporary file is taken by a folder).
    mkdirSync(`${file}.tmp`);
    const p = await pairNaming(app, port, { id: 'old-a', ticket });
    const done = await p.allow();
    expect(done.denied).toBe('This computer could not save the pairing. Try again.');
    expect(await ids(app)).toEqual(['old-a']);
    expect(JSON.parse(readFileSync(file, 'utf8')).devices.map((d: { id: string }) => d.id)).toEqual(['old-a']);
    // The old pairing still works, and its ticket is still good.
    const plain = await helloPlain(port, old[0].token);
    plain.ws.close();
    rmSync(`${file}.tmp`, { recursive: true });
    const again = await pairNaming(app, port, { id: 'old-a', ticket });
    const ok = await again.allow();
    expect(ok.paired?.replaced).toBe('old-a');
    const onDisk = JSON.parse(readFileSync(file, 'utf8')).devices as { id: string; secure?: boolean }[];
    expect(onDisk.map((d) => d.id)).toEqual([ok.paired!.deviceId]);
    expect(onDisk[0].secure).toBe(true);
  });

  it('a pairing that names nothing to replace is a separate one, and says so', async () => {
    const { app, port } = await setup({ legacy: [{ id: 'old-a' }] });
    const p = await pairNaming(app, port, undefined, 'New phone');
    expect((await app.call('phone.status', {})).request?.replaces).toBeUndefined();
    const done = await p.allow();
    expect(done.paired?.deviceId).toBeTruthy();
    expect(done.paired?.replaced).toBeUndefined();
    expect((await ids(app)).sort()).toEqual([done.paired!.deviceId, 'old-a'].sort());
  });
});

// ── 8 ──

/** The Codex adapter on a fake app-server (no process), one session, its requests answered in the test. */
async function codexFake() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-codex-w5-'));
  homes.push(home);
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/start') return { thread: { id: 'th1', model: 'm' }, model: 'm' };
      if (method === 'thread/resume') return { thread: { id: String(params.threadId), model: 'm' }, model: 'm' };
      if (method === 'turn/start') return { turn: { id: 'turn1' } };
      if (method === 'account/read') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
      return {};
    },
  };
  let provider!: CodexProvider;
  const app = new App({
    home,
    quiet: true,
    providers: [
      (ctx) => {
        const p = new CodexProvider(ctx);
        const anyP = p as unknown as Record<string, unknown>;
        anyP.client = async () => rpc;
        anyP.version = async () => ({ installed: true, version: '1' });
        anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '$', features: { steer: true } });
        provider ??= p;
        return p;
      },
    ],
  });
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.create', { provider: 'codex', cwd, mode: 'default', model: 'm' });
  const rt = app.runtime(snap.session.id);
  const session = () => [...provider.sessions.values()][0] as unknown as { onRequest(method: string, p: unknown, id: number): Promise<unknown>; onNotification?: unknown };
  const notify = (method: string, p: Record<string, unknown>) => (provider as unknown as { onNotification(m: string, p: unknown): void }).onNotification(method, { threadId: 'th1', ...p });
  /** Asks, and returns the request as the desktop holds it. */
  const ask = async (method: string, p: Record<string, unknown>, id: number): Promise<PermissionRequest> => {
    void session().onRequest(method, p, id);
    await until(() => rt.prompts().permissions.length > 0);
    const req = rt.prompts().permissions[0];
    rt.cancelPrompts();
    await until(() => rt.prompts().permissions.length === 0);
    return req;
  };
  return { app, rt, cwd, notify, ask };
}

describe('what an approval reaches, as data (8)', () => {
  it('a file change with its own reason and a session grant root: both in view, the root a scope field', async () => {
    const h = await codexFake();
    const file = path.join(h.cwd, 'a.ts');
    h.notify('item/started', { turnId: 'turn1', item: { type: 'fileChange', id: 'fc1', status: 'inProgress', changes: [{ path: file, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] } });
    await until(() => !!h.rt.get('turn1:fc1'));
    const req = await h.ask('item/fileChange/requestApproval', { threadId: 'th1', turnId: 'turn1', itemId: 'fc1', reason: 'It needs to write the build output', grantRoot: '/opt/everything' }, 11);
    expect(req.scope?.roots).toEqual(['/opt/everything']);
    expect(req.reason?.split('\n')).toEqual(['It needs to write the build output', 'Allow writes under /opt/everything for this session']);
    expect(phonePermission(req).incomplete).toBeUndefined();
    // The same request with the root hidden behind its reason (as before) is desktop-only.
    const hidden = { ...req, reason: 'It needs to write the build output' };
    expect(phonePermission(hidden).incomplete).toBe(true);
    expect(() => phoneAllowed(hidden, 'accept')).toThrow(/Answer it on the desktop/);
  });

  it('an approval that came before its change knows no files yet: desktop only', async () => {
    const h = await codexFake();
    const req = await h.ask('item/fileChange/requestApproval', { threadId: 'th1', turnId: 'turn1', itemId: 'fc9', reason: null, grantRoot: null }, 12);
    expect(req.title).toBe('Edit files?');
    expect(req.scope?.unknown).toBe(true);
    expect(phonePermission(req).incomplete).toBe(true);
    expect(() => phoneAllowed(req, 'accept')).toThrow(/Answer it on the desktop/);
    expect(() => phoneAllowed(req, 'decline')).not.toThrow();
  });

  it('a command with its reason and a network destination: the destination shows and is a scope field', async () => {
    const h = await codexFake();
    const req = await h.ask('item/commandExecution/requestApproval', { threadId: 'th1', turnId: 'turn1', itemId: 'cmd1', command: 'curl x', cwd: h.cwd, reason: 'Fetch the schema', networkApprovalContext: { host: 'evil.example', protocol: 'https' } }, 13);
    expect(req.scope?.hosts).toEqual(['evil.example']);
    expect(req.reason?.split('\n')).toContain('Network access to evil.example');
    expect(phonePermission(req).incomplete).toBeUndefined();
    expect(phonePermission({ ...req, reason: 'Fetch the schema' }).incomplete).toBe(true);
  });

  it('a legacy patch that moves a file: both ends listed, its grant root too; one end missing is desktop-only', async () => {
    const h = await codexFake();
    const req = await h.ask('applyPatchApproval', { conversationId: 'th1', callId: 'p1', fileChanges: { '/w/a.ts': { update: { unified_diff: '', move_path: '/etc/cron.d/a' } }, '/w/b.ts': { add: { content: 'x' } } }, reason: null, grantRoot: '/w' }, 14);
    expect(req.scope?.files).toEqual([{ path: '/etc/cron.d/a', from: '/w/a.ts' }, { path: '/w/b.ts' }]);
    expect(req.description?.split('\n')).toEqual(['/w/a.ts → /etc/cron.d/a', '/w/b.ts']);
    expect(req.reason).toBe('Allow writes under /w for this session');
    expect(phonePermission(req).incomplete).toBeUndefined();
    expect(phonePermission({ ...req, description: '/w/a.ts\n/w/b.ts' }).incomplete).toBe(true);
  });

  it('a sandbox grant of a kind Sable cannot name is desktop-only; paths are one per line', async () => {
    const h = await codexFake();
    const plain = await h.ask('item/permissions/requestApproval', { threadId: 'th1', turnId: 'turn1', itemId: 'p1', cwd: h.cwd, reason: null, permissions: { network: { enabled: true }, fileSystem: { read: ['/a, /b'], write: ['/c'] } } }, 15);
    expect(plain.description?.split('\n')).toEqual(['Network access', 'Write: /c', 'Read: /a, /b']);
    expect(phonePermission(plain).incomplete).toBeUndefined();
    const odd = await h.ask('item/permissions/requestApproval', { threadId: 'th1', turnId: 'turn1', itemId: 'p2', cwd: h.cwd, reason: null, permissions: { fileSystem: { read: ['/a'], write: null, execute: ['/bin'] } } }, 16);
    expect(odd.description).toBe('Read: /a');
    expect(odd.scope?.unknown).toBe(true);
    expect(phonePermission(odd).incomplete).toBe(true);
    // Nothing it could name at all: desktop only as well.
    const none = await h.ask('item/permissions/requestApproval', { threadId: 'th1', turnId: 'turn1', itemId: 'p3', cwd: h.cwd, reason: null, permissions: {} }, 17);
    expect(none.scope?.unknown).toBe(true);
    expect(phonePermission(none).incomplete).toBe(true);
  });
});

describe("what Claude Code's 'always' saves, as data (8)", () => {
  async function claudeSession() {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-claude-w5-'));
    homes.push(home);
    const cwd = path.join(home, 'proj');
    mkdirSync(cwd);
    let session!: { canUseTool(name: string, input: Record<string, unknown>, o: Record<string, unknown>): Promise<unknown> };
    const app = new App({
      home,
      quiet: true,
      userHome: path.join(home, 'user'),
      providers: [
        (ctx) => {
          const p = new ClaudeProvider(ctx);
          const any = p as unknown as Record<string, unknown>;
          any.info = async () => ({ id: 'claude', name: 'Claude Code', installed: true, auth: { loggedIn: true } });
          any.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: {} });
          any.limits = async () => [];
          any.readLimits = async () => [];
          const open = p.open.bind(p);
          p.open = async (rt, o) => {
            const s = (await open(rt, o)) as unknown as Record<string, unknown>;
            // Never a real process: the SDK query and its input are fakes.
            s.ensure = function (this: Record<string, unknown>) {
              this.q ??= { interrupt: async () => {}, close: () => {} };
              this.input ??= { push: () => {}, end: () => {} };
              return this.q;
            };
            session = s as unknown as typeof session;
            return s as unknown as ProviderSession;
          };
          return p;
        },
      ],
    });
    cleanups.push(() => app.dispose());
    const snap = await app.call('session.create', { provider: 'claude', cwd, mode: 'default', model: 'm', options: { remoteControl: false } });
    const rt = app.runtime(snap.session.id);
    await until(() => !!session);
    const ask = async (suggestions: unknown[]) => {
      void session.canUseTool('Bash', { command: 'npm run build' }, { suggestions, signal: new AbortController().signal });
      await until(() => rt.prompts().permissions.length > 0);
      const req = rt.prompts().permissions[0];
      rt.cancelPrompts();
      await until(() => rt.prompts().permissions.length === 0);
      return req;
    };
    return { ask };
  }

  it('every folder and rule it saves shows whole; a change Sable cannot name is desktop-only', async () => {
    const h = await claudeSession();
    const dir = 'C:\\Users\\someone\\very\\long\\path\\to\\a\\folder\\named\\src';
    const rule = `npm run build -- --filter ${'x'.repeat(60)}:*`;
    const req = await h.ask([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: rule }], behavior: 'allow', destination: 'localSettings' },
      { type: 'addDirectories', directories: [dir], destination: 'session' },
    ]);
    expect(req.options.find((o) => o.id === 'always')?.label.length).toBeLessThan(60);
    // Each suggestion with what it does and where it is kept (review wave 6, #5: tests/boundary-wave6.test.ts).
    expect(req.scope).toEqual({ saves: [{ rules: [`Bash(${rule})`], behavior: 'allow', where: 'localSettings' }, { dirs: [dir], where: 'session' }] });
    expect(req.reason?.split('\n')).toEqual([`Always: allow Bash(${rule}) in this project's local settings`, `Always: access to ${dir} for this session`]);
    expect(phonePermission(req).incomplete).toBeUndefined();
    expect(phonePermission(req).options.map((o) => o.id)).toContain('always');
    // Without those lines (as before) the phone could allow what it never showed: "always" is the desktop's then.
    expect(phonePermission({ ...req, reason: undefined }).options.map((o) => o.id)).toEqual(['allow', 'deny']);
    const odd = await h.ask([{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }, { type: 'removeDirectories', directories: ['C:\\x'], destination: 'session' }]);
    expect(odd.scope?.savesUnknown).toBe(true);
    expect(phonePermission(odd).options.map((o) => o.id)).toEqual(['allow', 'deny']);
    expect(() => phoneAllowed(odd, 'always')).toThrow(/only on the desktop/);
  });
});

// ── 9 ──

describe('a send that waits, from a phone removed meanwhile (9)', () => {
  it('waiting for the agent to start: it never goes out, and the message shown meanwhile leaves the chat', async () => {
    const { app, phone, port, home, gates, sent } = await setup();
    const { c, deviceId } = await pairSecure(app, port);
    gates.open = gate();
    const created = (await c.call('session.create', { provider: 'demo', cwd: beside(home) }, 6000)) as { ok: boolean; result: PhoneTail };
    expect(created.ok).toBe(true);
    const rt = app.sessions.get(created.result.session.id)!;
    void c.call('session.send', { sessionId: rt.id, text: 'rm -rf the project' }).catch(() => {});
    await until(() => rt.items.some((i) => i.type === 'user'));
    phone.revoke(deviceId);
    gates.open.open();
    await until(() => !!rt.handle);
    await wait(200);
    expect(sent).toEqual([]);
    expect(rt.items.some((i) => i.type === 'user')).toBe(false);
    expect(rt.turnActive).toBe(false);
    expect(rt.meta.status).not.toBe('starting');
  });

  it('waiting for a model change to apply: it never goes out', async () => {
    const { app, phone, port, home, gates, sent } = await setup();
    const { c, deviceId } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    await until(() => !!rt.handle);
    gates.model = gate();
    expect((await c.call('session.setModel', { sessionId: rt.id, model: 'demo-other' })).ok).toBe(true);
    void c.call('session.send', { sessionId: rt.id, text: 'go ahead' }).catch(() => {});
    await wait(100);
    phone.revoke(deviceId);
    gates.model.open();
    await wait(200);
    expect(sent).toEqual([]);
    expect(rt.items.some((i) => i.type === 'user')).toBe(false);
  });

  it('the same send from a phone still paired goes out', async () => {
    const { app, port, home, gates, sent } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    await until(() => !!rt.handle);
    gates.model = gate();
    await c.call('session.setModel', { sessionId: rt.id, model: 'demo-other' });
    const going = c.call('session.send', { sessionId: rt.id, text: 'go ahead' }, 6000);
    await wait(50);
    gates.model.open();
    expect((await going).ok).toBe(true);
    expect(sent).toEqual(['go ahead']);
  });
});

// ── 20 ──

describe('a queued message taken back with a receipt (20)', () => {
  it('the reply reached a phone that went away before it kept the words: the message stays queued as it was', async () => {
    const { app, phone, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    phone.takeHoldMs = 150;
    const q = rt.enqueue('the only copy');
    const r = (await c.call('queue.take', { sessionId: rt.id, id: q.id, ack: true })) as { result: { message: QueuedMessage; take: string } };
    expect(r.result.message.text).toBe('the only copy');
    expect(typeof r.result.take).toBe('string');
    await wait(60);
    // The reply went out; without the phone's word the message is reserved, not removed.
    expect(rt.queue.map((m) => m.text)).toEqual(['the only copy']);
    expect(rt.isReserved(q.id)).toBe(true);
    c.ws.close();
    await until(() => !rt.isReserved(q.id));
    expect(rt.queue.map((m) => m.text)).toEqual(['the only copy']);
  });

  it("the phone's word takes it; the same receipt again answers the same and takes nothing else", async () => {
    const { app, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    const q = rt.enqueue('first');
    rt.enqueue('second');
    const r = (await c.call('queue.take', { sessionId: rt.id, id: q.id, ack: true })) as { result: { take: string } };
    const done = (await c.call('phone.takeDone', { take: r.result.take })) as { ok: boolean; result: { taken: boolean } };
    expect(done.result.taken).toBe(true);
    expect(rt.queue.map((m) => m.text)).toEqual(['second']);
    expect(((await c.call('phone.takeDone', { take: r.result.take })) as { result: { taken: boolean } }).result.taken).toBe(true);
    expect(rt.queue.map((m) => m.text)).toEqual(['second']);
    expect(rt.items.some((i) => i.type === 'user' && (i as UserItem).text === 'first')).toBe(false);
  });

  it('kept: false puts it back at once; a word after the hold takes it only while it is unchanged', async () => {
    const { app, phone, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    const a = rt.enqueue('a');
    const ra = (await c.call('queue.take', { sessionId: rt.id, id: a.id, ack: true })) as { result: { take: string } };
    expect(((await c.call('phone.takeDone', { take: ra.result.take, kept: false })) as { result: { taken: boolean } }).result.taken).toBe(false);
    expect(rt.isReserved(a.id)).toBe(false);
    expect(rt.queue.map((m) => m.text)).toEqual(['a']);
    phone.takeHoldMs = 50;
    const b = rt.enqueue('b');
    const rb = (await c.call('queue.take', { sessionId: rt.id, id: b.id, ack: true })) as { result: { take: string } };
    await until(() => !rt.isReserved(b.id));
    expect(((await c.call('phone.takeDone', { take: rb.result.take })) as { result: { taken: boolean } }).result.taken).toBe(true);
    expect(rt.queue.map((m) => m.text)).toEqual(['a']);
    const rc = (await c.call('queue.take', { sessionId: rt.id, id: a.id, ack: true })) as { result: { take: string } };
    await until(() => !rt.isReserved(a.id));
    await app.call('queue.update', { sessionId: rt.id, id: a.id, text: 'a, edited on the desktop' });
    expect(((await c.call('phone.takeDone', { take: rc.result.take })) as { result: { taken: boolean } }).result.taken).toBe(false);
    expect(rt.queue.map((m) => m.text)).toEqual(['a, edited on the desktop']);
  });

  it("another phone's receipt takes nothing", async () => {
    const { app, port, home } = await setup();
    const one = await pairSecure(app, port, 'One');
    const two = await pairSecure(app, port, 'Two');
    const rt = await chatOf(app, one.c, home);
    const q = rt.enqueue('mine');
    const r = (await one.c.call('queue.take', { sessionId: rt.id, id: q.id, ack: true })) as { result: { take: string } };
    expect(((await two.c.call('phone.takeDone', { take: r.result.take })) as { result: { taken: boolean } }).result.taken).toBe(false);
    expect(rt.queue.map((m) => m.text)).toEqual(['mine']);
  });
});

// ── 21 ──

describe("a phone's message checked before anything changes (21)", () => {
  it('a send without words during a turn queues nothing, and the chat still reads on the phone', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    rt.beginTurn('Thinking');
    const r = await c.call('session.send', { sessionId: rt.id });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('A message needs its words.');
    expect(rt.queue).toHaveLength(0);
    expect(() => app.call('session.send', { sessionId: rt.id, text: 7 as unknown as string })).rejects.toThrow('A message needs its words.');
    expect(rt.queue).toHaveLength(0);
    expect((await c.call('phone.tail', { sessionId: rt.id })).ok).toBe(true);
  });

  it('an edit with an empty list of pictures removes them; one without the field keeps them', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    const pic = { id: 'pic1', kind: 'image' as const, name: 'a.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mime: 'image/png', size: 8 };
    const q = rt.enqueue('with a picture', [pic]);
    expect((await c.call('queue.update', { sessionId: rt.id, id: q.id, text: 'still with it' })).ok).toBe(true);
    expect(rt.queue[0].attachments?.map((a) => a.id)).toEqual(['pic1']);
    expect((await c.call('queue.update', { sessionId: rt.id, id: q.id, text: 'without it', attachments: [] })).ok).toBe(true);
    expect(rt.queue[0].text).toBe('without it');
    expect(rt.queue[0].attachments).toBeUndefined();
  });
});

// ── 23 ──

describe('pages bounded by bytes (23)', () => {
  it('app.hello with more waiting than one frame holds: within its budget, the rest by cursor', async () => {
    const { app, port, home } = await setup();
    const snap = await app.call('session.create', { provider: 'demo', cwd: home });
    const rt = app.sessions.get(snap.session.id)!;
    // 500 requests, each a change of 40,000 characters (about 20 MB in all), there before the phone connects.
    const line = '+'.concat('x'.repeat(1999));
    const diff = [{ path: path.join(home, 'big.txt'), status: 'modified' as const, additions: 20, deletions: 0, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 20, lines: Array.from({ length: 20 }, () => line) }] }];
    for (let i = 0; i < 500; i++) void rt.requestPermission({ toolName: 'Edit', kind: 'edit', title: `Edit ${i}?`, detail: {}, diff, options: [{ id: 'allow', label: 'Allow once', tone: 'allow' }] });
    const { c } = await pairSecure(app, port);
    const hello = (await c.call('app.hello', {}, 20_000)) as { ok: boolean; result: PhoneHelloState; error?: string };
    expect(hello.error).toBeUndefined();
    expect(hello.ok).toBe(true);
    const first = hello.result.prompts!.permissions;
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(500);
    expect(hello.result.permissionsTotal).toBe(500);
    const seen = new Set(first.map((p) => p.id));
    let cursor = hello.result.promptsCursor;
    for (let n = 0; cursor && n < 50; n++) {
      const page = (await c.call('phone.prompts', { cursor }, 20_000)) as { ok: boolean; result: PhonePromptsPage };
      expect(page.ok).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(page.result))).toBeLessThan(PHONE_BYTES.prompts + 100_000);
      for (const p of page.result.permissions) seen.add(p.id);
      cursor = page.result.cursor;
    }
    expect(cursor).toBeUndefined();
    expect(seen.size).toBe(500);
  });

  it("a chat's page counts what waits in bytes as they go out (three-byte characters): the rest by cursor", async () => {
    const { app, port, home } = await setup();
    const snap = await app.call('session.create', { provider: 'demo', cwd: home });
    const rt = app.sessions.get(snap.session.id)!;
    const { c } = await pairSecure(app, port);
    // Twenty questionnaires of about 1.6 MB each in UTF-8 (under the page's count of 20).
    const words = (n: number) => '問'.repeat(n);
    for (let i = 0; i < 20; i++) {
      void rt.ask(
        Array.from({ length: 12 }, (_, k) => ({ question: `${i}-${k} ${words(300)}`, header: 'H', multiSelect: false, options: Array.from({ length: 24 }, (_, j) => ({ label: `${j} ${words(250)}`, description: words(1500) })) })),
      );
    }
    const tail = (await c.call('phone.tail', { sessionId: rt.id }, 20_000)) as { ok: boolean; result: PhoneTail; error?: string };
    expect(tail.error).toBeUndefined();
    expect(tail.result.questions.length).toBeLessThan(20);
    expect(tail.result.questionsTotal).toBe(20);
    const seen = new Set(tail.result.questions.map((q) => q.id));
    let cursor = tail.result.promptsCursor;
    for (let n = 0; cursor && n < 40; n++) {
      const page = (await c.call('phone.prompts', { sessionId: rt.id, cursor }, 20_000)) as { ok: boolean; result: PhonePromptsPage };
      expect(page.ok).toBe(true);
      for (const q of page.result.questions) seen.add(q.id);
      cursor = page.result.cursor;
    }
    expect(seen.size).toBe(20);
  });

  it("the chats' list too: a hello within its budget, phone.sessions reads on from its cursor", () => {
    const meta = (i: number): SessionMeta => ({ id: `s${i}`, provider: 'demo', cwd: `C:\\work\\${'p'.repeat(400)}${i}`, title: `Chat ${i} ${'t'.repeat(300)}`, titleSource: 'user', model: 'm', mode: 'default', status: 'idle', createdAt: i, updatedAt: i, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } });
    const sessions = Array.from({ length: 12_000 }, (_, i) => meta(i));
    const hello = phoneResult('app.hello', { sessions, providers: [], projects: [], settings: {}, version: '1', platform: 'win32', home: 'C:\\' } as unknown as AppState) as PhoneHelloState;
    expect(Buffer.byteLength(JSON.stringify(hello.sessions))).toBeLessThanOrEqual(PHONE_BYTES.helloSessions);
    expect(hello.sessionsTotal).toBe(12_000);
    const seen = new Set(hello.sessions.map((s) => s.id));
    let cursor = hello.sessionsCursor;
    while (cursor) {
      const at = Number(cursor.split(':')[0]);
      const page = sessionsPage(sessions, at, PHONE_BYTES.sessions);
      for (const s of page.sessions) seen.add(s.id);
      cursor = page.cursor;
    }
    expect(seen.size).toBe(12_000);
  });
});

// ── 7, what the phone is told ──

describe('a file the desktop cannot prove is in the chat folder (7)', () => {
  it('is refused for what it is: not called a link unless it is one', async () => {
    const { CONTAIN } = await import('../server/core/contain');
    const was = CONTAIN.how;
    CONTAIN.how = 'none';
    cleanups.push(() => void (CONTAIN.how = was));
    const { app, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    const shareOf = (id: string, file: string) => ({ id, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'done', detail: { files: [{ path: file, name: path.basename(file), size: statSync(file).size }] } }) as unknown as ToolItem;
    writeFileSync(path.join(rt.meta.cwd, 'plain.txt'), 'plain words');
    writeFileSync(path.join(rt.meta.cwd, 'target.txt'), 'linked words');
    linkSync(path.join(rt.meta.cwd, 'target.txt'), path.join(rt.meta.cwd, 'linked.txt'));
    rt.add(shareOf('s1', path.join(rt.meta.cwd, 'plain.txt')));
    rt.add(shareOf('s2', path.join(rt.meta.cwd, 'linked.txt')));
    await rt.handing('s1');
    await rt.handing('s2');
    const plain = await c.call('phone.fileStart', { sessionId: rt.id, itemId: 's1', index: 0 });
    expect(plain.error).toBe("Sable could not confirm that file is in the chat's folder. Only a share you allowed on the desktop goes to the phone.");
    const linked = await c.call('phone.fileStart', { sessionId: rt.id, itemId: 's2', index: 0 });
    expect(linked.error).toBe('That file is a link to another place.');
  });
});

// ── 5, the plain link of a phone paired before the secure channel ──

describe('a plain download link serves only the bytes the share recorded (5)', () => {
  it('a file rewritten in place while it is being served: nothing new goes out', async () => {
    const { CONTAIN } = await import('../server/core/contain');
    const was = CONTAIN.how;
    // Inside the chat folder as a walk sees it (what this test is about is the bytes, not the place).
    if (CONTAIN.how === 'none') CONTAIN.how = 'walk';
    cleanups.push(() => void (CONTAIN.how = was));
    const { app, port, home, old } = await setup({ legacy: [{ id: 'old-a' }] });
    const plain = await helloPlain(port, old[0].token);
    cleanups.push(() => plain.ws.close());
    const created = (await plain.call('session.create', { provider: 'demo', cwd: beside(home) })) as { result: PhoneTail };
    const rt = app.sessions.get(created.result.session.id)!;
    const { FILE_CHUNK } = await import('../server/services/phone-files');
    const file = path.join(rt.meta.cwd, 'notes.bin');
    // Big enough that the serve waits for the phone (a paused reader) long before its end.
    const body = Buffer.alloc(FILE_CHUNK * 64, 'a');
    writeFileSync(file, body);
    rt.add({ id: 's1', type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'done', detail: { files: [{ path: file, name: 'notes.bin', size: body.length }] } } as unknown as ToolItem);
    await rt.handing('s1');
    const link = (await plain.call('phone.fileLink', { sessionId: rt.id, itemId: 's1', index: 0 })) as { ok: boolean; result: { path: string }; error?: string };
    expect(link.error).toBeUndefined();
    const { openSync, writeSync, closeSync } = await import('node:fs');
    const http = await import('node:http');
    const got = await new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      http
        .get(`http://127.0.0.1:${port}${link.result.path}`, (res) => {
          res.once('data', () => {
            // The first bytes are in: the reader pauses, the file's last block is rewritten in place, then it reads on.
            res.pause();
            const fd = openSync(file, 'r+');
            writeSync(fd, Buffer.alloc(16, 'Z'), 0, 16, FILE_CHUNK * 63 + 5);
            closeSync(fd);
            setTimeout(() => res.resume(), 100);
          });
          res.on('data', (d: Buffer) => parts.push(d));
          res.on('close', () => resolve(Buffer.concat(parts)));
          res.on('error', () => resolve(Buffer.concat(parts)));
        })
        .on('error', () => resolve(Buffer.concat(parts)));
    });
    expect(got.includes(Buffer.from('ZZZZ'))).toBe(false);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(body.length);
    expect(got.equals(body.subarray(0, got.length))).toBe(true);
  });
});

// Keeps the type import used (PhoneService is the endpoint's own class).
export type { PhoneService };
