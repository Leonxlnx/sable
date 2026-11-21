/**
 * The OpenCode adapter against a fake ACP client (no process, no model): the sender's guard at
 * dispatch, a Stop before the prompt went, a turn that always ends, and permission requests whose
 * scope the phone can show or not.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, PermissionRequest, SessionMeta, UserItem } from '@shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { OpenCodeProvider } from '../server/providers/opencode';
import { permissionScope } from '../server/providers/opencode-map';
import { phonePermission } from '../server/services/phone';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Call = { method: string; params: any; resolve: (v: unknown) => void; reject: (e: Error) => void };

function fakeAcp() {
  const calls: Call[] = [];
  const notes: { method: string; params: any }[] = [];
  const acp = {
    alive: true,
    init: { agentCapabilities: {} },
    request(method: string, params: any) {
      return new Promise((resolve, reject) => {
        calls.push({ method, params, resolve, reject });
        if (method === 'session/new') resolve({ sessionId: 'oc-1', configOptions: [] });
        if (method === 'session/set_config_option') resolve({});
      });
    },
    notify(method: string, params: any) {
      notes.push({ method, params });
    },
    close: async () => {},
  };
  return { acp, calls, notes, prompts: () => calls.filter((c) => c.method === 'session/prompt') };
}

async function chat(opts: { slowClient?: Promise<void> } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'sable-oc-'));
  dirs.push(cwd);
  const events: BridgeEvent[] = [];
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'opencode', cwd, title: 'New session', titleSource: 'auto', model: '', mode: 'build', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, (e) => events.push(e), () => {});
  const fake = fakeAcp();
  const provider = new OpenCodeProvider({ emit: () => {}, log: () => {} });
  let gate: Promise<void> | undefined;
  (provider as unknown as { client: () => Promise<unknown> }).client = async () => {
    if (gate) await gate;
    return fake.acp;
  };
  (provider as unknown as { servers: () => Promise<unknown[]> }).servers = async () => [];
  const session = await provider.open(rt, {});
  gate = opts.slowClient;
  const user = (text: string) => rt.add<UserItem>({ type: 'user', text, state: 'sent' });
  return { rt, provider, session, fake, user, events };
}

describe('OpenCode turns', () => {
  it('sends a prompt and ends the turn when OpenCode answers', async () => {
    const { rt, session, fake, user } = await chat();
    await session.send(user('hi'));
    expect(rt.turnActive).toBe(true);
    expect(fake.prompts()).toHaveLength(1);
    fake.prompts()[0].resolve({ stopReason: 'end_turn' });
    await new Promise((r) => setTimeout(r, 0));
    expect(rt.turnActive).toBe(false);
    expect(rt.items.at(-1)?.type).toBe('turn');
  });

  it("asks the sender's guard right before the prompt goes, and sends nothing when it refuses", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { session, fake, user } = await chat({ slowClient: slow });
    let allowed = true;
    const check = () => {
      if (!allowed) throw new Error('gone');
    };
    const sent = session.send(user('hi'), { check });
    allowed = false;
    release();
    await expect(sent).rejects.toThrow('gone');
    expect(fake.prompts()).toHaveLength(0);
  });

  it('a Stop before the prompt went ends the turn at once and nothing goes later', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { rt, session, fake, user } = await chat({ slowClient: slow });
    const sent = session.send(user('hi'));
    await session.interrupt();
    expect(rt.turnActive).toBe(false);
    release();
    await sent;
    expect(fake.prompts()).toHaveLength(0);
    expect(rt.turnActive).toBe(false);
  });

  it('a message from a removed phone that waited in the queue never goes', async () => {
    const { rt, session, fake, user } = await chat();
    await session.send(user('first'));
    let allowed = true;
    const queued = user('second');
    await session.send(queued, {
      check: () => {
        if (!allowed) throw new Error('gone');
      },
    });
    allowed = false;
    fake.prompts()[0].resolve({ stopReason: 'end_turn' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.prompts()).toHaveLength(1);
    expect(rt.get(queued.id)).toBeUndefined();
    expect(rt.turnActive).toBe(false);
  });

  it('a prompt that never answers still ends after a Stop', async () => {
    const { rt, session, fake, user } = await chat();
    await session.send(user('hi'));
    await session.interrupt();
    expect(fake.notes.map((n) => n.method)).toContain('session/cancel');
    // OpenCode does not answer the cancel: the turn ends by itself (8 s); here it is answered at once.
    fake.prompts()[0].resolve({ stopReason: 'cancelled' });
    await new Promise((r) => setTimeout(r, 0));
    expect(rt.turnActive).toBe(false);
  });
});

describe('OpenCode permission scope', () => {
  const ask = (over: Partial<PermissionRequest>): PermissionRequest =>
    ({ id: 'p1', sessionId: 's1', toolName: 'Edit', kind: 'edit', title: 'Edit a.ts', detail: {}, options: [{ id: 'once', label: 'Allow once', tone: 'allow' }, { id: 'always', label: 'Always allow', tone: 'always' }], createdAt: 0, ...over }) as PermissionRequest;

  it('an edit names its files; one the diff shows needs no line', () => {
    const r = permissionScope('edit', { locations: [{ path: '/w/a.ts' }, { path: '/w/b.ts' }] }, {}, ['/w/a.ts']);
    expect(r.scope?.files).toEqual([{ path: '/w/a.ts' }, { path: '/w/b.ts' }]);
    expect(r.lines).toEqual(['/w/b.ts']);
    const shown = phonePermission(ask({ scope: r.scope, reason: r.lines.join('\n'), diff: [{ path: '/w/a.ts', hunks: [], additions: 0, deletions: 0 } as any] }));
    expect(shown.incomplete).toBeUndefined();
  });

  it('a fetch names its host; a read its paths', () => {
    expect(permissionScope('fetch', {}, { url: 'https://example.com/x' }).lines).toEqual(['Network access to example.com']);
    expect(permissionScope('read', { locations: [{ path: '/etc/hosts' }] }, {}).lines).toEqual(['Read: /etc/hosts']);
  });

  it('what Sable cannot describe is the desktop\'s, and "always" never goes to the phone', () => {
    const mcp = permissionScope('other', {}, {});
    expect(mcp.scope?.unknown).toBe(true);
    expect(phonePermission(ask({ scope: mcp.scope })).incomplete).toBe(true);
    const cmd = permissionScope('execute', {}, { command: 'ls' }, [], true);
    const shown = phonePermission(ask({ kind: 'bash', scope: cmd.scope }));
    expect(shown.incomplete).toBeUndefined();
    expect(shown.options.map((o) => o.id)).toEqual(['once']);
  });
});
