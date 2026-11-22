/**
 * Customize Sable and the phone (review wave 8, #6): a paired phone cannot reach the person's live
 * stylesheet through a chat. It may not start a chat anywhere in Sable's data folder (the custom folder
 * included, a chat folder there or a link into it), and may only read and
 * stop the Customize chat (or any chat in `<data>/custom`): no message, steer, answer, mode or model.
 * `custom.*` stays off its allowlist. Demo agent and local sockets only: nothing real is started.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PHONE_METHODS, type PhoneTail } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { PHONE_CUSTOM_REFUSED, PHONE_DATA_REFUSED, registerCustom } from '../server/services/custom';
import { registerFs } from '../server/services/fs';
import { registerPhone } from '../server/services/phone';
import { pairSecure } from './phone-wire';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'sable-custom-phone-'));
  homes.push(root);
  const home = path.join(root, 'data');
  const app = new App({ home, userHome: root, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  registerFs(app);
  registerCustom(app);
  registerPhone(app, { port: 0, host: '127.0.0.1' });
  const status = await app.call('phone.setEnabled', { on: true });
  const { c } = await pairSecure(app, status.port);
  return { app, home, root, phone: c };
}

describe('a phone and the person’s stylesheet', () => {
  it('cannot start a chat in Sable’s data folder: the custom folder, below it, the data folder itself, or a chat folder there', async () => {
    const { app, home, root, phone } = await setup();
    const custom = path.join(home, 'custom');
    mkdirSync(path.join(custom, 'deeper'), { recursive: true });
    for (const cwd of [custom, path.join(custom, 'deeper'), home, path.join(home, 'lanes'), custom.toUpperCase()]) {
      mkdirSync(cwd, { recursive: true });
      const r = await phone.call('session.create', { provider: 'demo', cwd, mode: 'bypassPermissions' });
      expect(r, cwd).toMatchObject({ ok: false, error: PHONE_DATA_REFUSED });
    }
    // A link into it is followed.
    const link = path.join(root, 'looks-harmless');
    try {
      symlinkSync(custom, link, 'junction');
      expect(await phone.call('session.create', { provider: 'demo', cwd: link })).toMatchObject({ ok: false, error: PHONE_DATA_REFUSED });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }
    // Chats without a folder land in the chats folder: refused when that is inside the data folder.
    await app.call('app.setSettings', { patch: { chatsFolder: custom } });
    expect(await phone.call('session.create', { provider: 'demo', cwd: root, chat: { text: 'make the sidebar pink' } })).toMatchObject({ ok: false, error: PHONE_DATA_REFUSED });
    expect([...app.sessions.values()]).toHaveLength(0);
    // Elsewhere as before.
    await app.call('app.setSettings', { patch: { chatsFolder: path.join(root, 'chats') } });
    const work = path.join(root, 'work');
    mkdirSync(work, { recursive: true });
    expect(await phone.call('session.create', { provider: 'demo', cwd: work })).toMatchObject({ ok: true });
  });

  it('may read and stop the Customize chat, never send, steer, answer or change it', async () => {
    const { app, phone } = await setup();
    const snap = await app.call('custom.open', { provider: 'demo' });
    const id = snap.session.id;
    // Reading works.
    const tail = (await phone.call('phone.tail', { sessionId: id })) as { ok: boolean; result: PhoneTail };
    expect(tail.ok).toBe(true);
    expect(tail.result.session.custom).toBe(true);
    expect(await phone.call('session.snapshot', { sessionId: id })).toMatchObject({ ok: true });
    expect(await phone.call('session.interrupt', { sessionId: id })).toMatchObject({ ok: true });
    // Nothing that makes its agent act or changes what it may do.
    const refused: [string, Record<string, unknown>][] = [
      ['session.send', { sessionId: id, text: 'make the composer red' }],
      ['queue.update', { sessionId: id, id: 'q', text: 'x' }],
      ['queue.sendNow', { sessionId: id, id: 'q' }],
      ['queue.take', { sessionId: id, id: 'q', take: 't' }],
      ['permission.respond', { sessionId: id, requestId: 'r', optionId: 'allow' }],
      ['question.respond', { sessionId: id, requestId: 'r', answers: {} }],
      ['phone.answer', { sessionId: id, requestId: 'r', picks: [] }],
      ['session.setMode', { sessionId: id, mode: 'bypassPermissions' }],
      ['session.setModel', { sessionId: id, model: 'x' }],
      ['session.setOptions', { sessionId: id, options: { remoteControl: true } }],
      ['session.switchAgent', { sessionId: id, provider: 'demo' }],
      ['session.switchAccount', { sessionId: id, accountId: 'x' }],
      ['turn.check', { sessionId: id, turnId: 't' }],
    ];
    for (const [method, params] of refused) expect(await phone.call(method, params), method).toMatchObject({ ok: false, error: PHONE_CUSTOM_REFUSED });
    expect(app.sessions.get(id)!.items.some((it) => it.type === 'user')).toBe(false);
    expect(app.sessions.get(id)!.meta.mode).not.toBe('bypassPermissions');
    // A chat the desktop started in the custom folder is the same.
    const other = await app.call('session.create', { provider: 'demo', cwd: path.join(app.store.dir, 'custom') });
    expect(await phone.call('session.send', { sessionId: other.session.id, text: 'x' })).toMatchObject({ ok: false, error: PHONE_CUSTOM_REFUSED });
  });

  it('custom.* stays off the phone’s allowlist', async () => {
    const { phone } = await setup();
    expect(PHONE_METHODS.some((m) => m.startsWith('custom.'))).toBe(false);
    for (const m of ['custom.open', 'custom.original', 'custom.state', 'custom.setup', 'custom.build', 'custom.use', 'custom.bring']) {
      expect((await phone.call(m, { text: 'x' })).ok, m).toBe(false);
    }
  });
});
