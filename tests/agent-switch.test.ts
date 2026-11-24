/**
 * Switching a chat's agent in place (session.switchAgent), and the model chosen without sending
 * anything (session.setModel, `/model <name>`). A second fake agent stands in for Codex: the Demo
 * under the id "codex" with models of its own. No real agent is ever started.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matchModel, type Capabilities, type ModelInfo, type NoticeItem, type ProviderId, type ToolItem, type UserItem } from '../shared/protocol';
import { App } from '../server/app';
import { handoverText } from '../server/accounts/handover';
import { undoableSwitch, workedIn } from '../server/core/agent-switch';
import { DemoProvider } from '../server/providers/demo';
import { capabilities } from '../server/providers/demo-catalog';
import type { Provider, ProviderContext } from '../server/providers/types';

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(pred: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const FAKE_MODELS: ModelInfo[] = [
  { id: 'gpt-6', name: 'GPT-6', isDefault: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'gpt-6-mini', name: 'GPT-6 Mini', efforts: ['low', 'medium'], defaultEffort: 'low' },
];
const fakeCaps = (): Capabilities => ({ ...capabilities(), models: FAKE_MODELS.map((m) => ({ ...m })) });

/** What every fake agent was told and did, across App restarts. */
interface Log {
  sent: { provider: ProviderId; text: string; conversation?: string }[];
  opened: { provider: ProviderId; resumed?: string }[];
  models: { provider: ProviderId; model: string }[];
}

/** The Demo as `id`, recording what it is sent; "codex" gets models of its own. */
function fake(id: ProviderId, name: string, log: Log) {
  return (ctx: ProviderContext): Provider => {
    const p = new DemoProvider(ctx, { speed: 0 });
    Object.assign(p, { id, name });
    const open = p.open.bind(p);
    if (id !== 'demo') p.caps = async () => fakeCaps();
    p.open = async (rt, opts) => {
      const resumed = rt.meta.providerSessionId;
      if (id !== 'demo' && !rt.meta.model) rt.update({ model: 'gpt-6' });
      const s = await open(rt, opts);
      if (id !== 'demo') rt.setCaps(fakeCaps());
      log.opened.push({ provider: id, resumed });
      const send = s.send.bind(s);
      s.send = async (item, options) => {
        log.sent.push({ provider: id, text: item.text, conversation: rt.meta.providerSessionId });
        options?.check?.();
        await send(item);
        if (id === 'codex') options?.taken?.(); // The real adapter acknowledges an accepted turn/start.
      };
      const setModel = s.setModel.bind(s);
      s.setModel = async (model) => {
        log.models.push({ provider: id, model });
        return setModel(model);
      };
      return s;
    };
    return p as unknown as Provider;
  };
}

function setup(home = mkdtempSync(path.join(tmpdir(), 'sable-switch-')), log: Log = { sent: [], opened: [], models: [] }) {
  if (!dirs.includes(home)) dirs.push(home);
  const app = new App({ home, providers: [fake('demo', 'Demo', log), fake('codex', 'Codex', log)], quiet: true });
  apps.push(app);
  return { app, home, log };
}

function folder() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'sable-switch-cwd-'));
  dirs.push(cwd);
  return cwd;
}

async function turn(app: App, id: string, text: string) {
  const rt = app.sessions.get(id)!;
  const answers = rt.items.filter((i) => i.type === 'turn').length;
  await app.call('session.send', { sessionId: id, text });
  await until(() => rt.items.filter((i) => i.type === 'turn').length > answers && rt.meta.status === 'idle', `the turn for "${text}"`);
}

const switches = (app: App, id: string) => app.sessions.get(id)!.items.filter((i): i is NoticeItem => i.type === 'notice' && !!i.agentSwitch);
const users = (app: App, id: string) => app.sessions.get(id)!.items.filter((i): i is UserItem => i.type === 'user');

describe('switching the agent in place', () => {
  it('goes on in the same chat with the other agent, which starts from a handover', async () => {
    const { app, log } = setup();
    const cwd = folder();
    const a = await app.call('session.create', { provider: 'demo', cwd });
    const id = a.session.id;
    await turn(app, id, 'hi');
    const demoConversation = app.sessions.get(id)!.meta.providerSessionId;
    expect(demoConversation).toBeTruthy();

    const r = await app.call('session.switchAgent', { sessionId: id, provider: 'codex', model: 'gpt-6-mini' });
    expect(r.ok).toBe(true);
    const meta = app.sessions.get(id)!.meta;
    expect(app.sessions.size).toBe(1);
    expect(meta.provider).toBe('codex');
    expect(meta.model).toBe('gpt-6-mini');
    expect(meta.providerSessionId).toBeUndefined();
    expect(meta.agents?.find((l) => l.provider === 'demo')?.providerSessionId).toBe(demoConversation);
    const [line] = switches(app, id);
    expect(line.text).toBe('Switched to Codex');
    expect(line.agentSwitch).toEqual({ from: 'demo', to: 'codex' });

    await turn(app, id, 'hello codex');
    const got = log.sent.filter((s) => s.provider === 'codex');
    expect(got).toHaveLength(1);
    expect(got[0].text).toMatch(/^This continues a conversation the user had with Demo/);
    expect(got[0].text).toContain('User: hi');
    expect(got[0].text.endsWith('hello codex')).toBe(true);
    // The timeline shows only what was typed, and the handover went once.
    expect(users(app, id).map((u) => u.text)).toEqual(['hi', 'hello codex']);
    expect(app.sessions.get(id)!.meta.agentHandover).toBeFalsy();
    await turn(app, id, 'hey again');
    expect(log.sent.filter((s) => s.provider === 'codex')[1].text).toBe('hey again');
  });

  it('switches back to the earlier agent, which resumes its own conversation and hears what happened since', async () => {
    const { app, log } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: folder() });
    const id = a.session.id;
    await turn(app, id, 'hi');
    const demoConversation = app.sessions.get(id)!.meta.providerSessionId;
    await app.call('session.switchAgent', { sessionId: id, provider: 'codex' });
    await turn(app, id, 'hello codex');
    const codexConversation = app.sessions.get(id)!.meta.providerSessionId;

    await app.call('session.switchAgent', { sessionId: id, provider: 'demo' });
    const meta = app.sessions.get(id)!.meta;
    expect(meta.provider).toBe('demo');
    expect(meta.providerSessionId).toBe(demoConversation);
    const lines = switches(app, id);
    expect(lines.map((l) => l.text)).toEqual(['Switched to Codex', 'Switched back to Demo']);
    expect(lines[1].agentSwitch).toEqual({ from: 'codex', to: 'demo', back: true });
    // Only the latest line offers to switch back.
    expect(lines[0].agentSwitch?.past).toBe(true);

    await turn(app, id, 'hey demo');
    expect(log.opened.at(-1)).toEqual({ provider: 'demo', resumed: demoConversation });
    const told = log.sent.filter((s) => s.provider === 'demo').at(-1)!;
    expect(told.conversation).toBe(demoConversation);
    expect(told.text).toMatch(/^Since your last reply here, the user went on with Codex/);
    expect(told.text).toContain('User: hello codex');
    // What it already knows is not told again.
    expect(told.text).not.toContain('User: hi\n');
    expect(told.text.endsWith('hey demo')).toBe(true);

    // And back again: Codex resumes its own thread and hears only the Demo's part since.
    await app.call('session.switchAgent', { sessionId: id, provider: 'codex' });
    expect(app.sessions.get(id)!.meta.providerSessionId).toBe(codexConversation);
    expect(app.sessions.get(id)!.meta.model).toBe('gpt-6');
    await turn(app, id, 'hello once more');
    const again = log.sent.filter((s) => s.provider === 'codex').at(-1)!;
    expect(again.conversation).toBe(codexConversation);
    expect(again.text).toMatch(/^Since your last reply here, the user went on with Demo/);
    expect(again.text).toContain('User: hey demo');
    expect(again.text).not.toContain('hello codex');
    expect(switches(app, id)).toHaveLength(3);
  });

  it('undoes a switch when nothing was sent since', async () => {
    const { app, log } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: folder() });
    const id = a.session.id;
    await turn(app, id, 'hi');
    const demoConversation = app.sessions.get(id)!.meta.providerSessionId;
    await app.call('session.switchAgent', { sessionId: id, provider: 'codex' });
    expect(switches(app, id)).toHaveLength(1);
    const r = await app.call('session.switchAgent', { sessionId: id, provider: 'demo' });
    expect(r.undone).toBe(true);
    expect(switches(app, id)).toHaveLength(0);
    const meta = app.sessions.get(id)!.meta;
    expect(meta.provider).toBe('demo');
    expect(meta.providerSessionId).toBe(demoConversation);
    await turn(app, id, 'hey demo');
    // Nothing happened elsewhere: the message goes alone, into the same conversation.
    expect(log.sent.at(-1)).toEqual({ provider: 'demo', text: 'hey demo', conversation: demoConversation });
  });

  it('undoes a switch back too: the earlier line offers to switch back again, and nothing is handed over', async () => {
    const { app, log } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: folder() });
    const id = a.session.id;
    await turn(app, id, 'hi');
    await app.call('session.switchAgent', { sessionId: id, provider: 'codex' });
    await turn(app, id, 'hello codex');
    const codexConversation = app.sessions.get(id)!.meta.providerSessionId;
    await app.call('session.switchAgent', { sessionId: id, provider: 'demo' });
    expect(switches(app, id)[0].agentSwitch?.past).toBe(true);
    expect((await app.call('session.switchAgent', { sessionId: id, provider: 'codex' })).undone).toBe(true);
    const lines = switches(app, id);
    expect(lines).toHaveLength(1);
    expect(lines[0].agentSwitch?.past).toBe(false);
    expect(app.sessions.get(id)!.meta.providerSessionId).toBe(codexConversation);
    await turn(app, id, 'hey there');
    expect(log.sent.at(-1)).toEqual({ provider: 'codex', text: 'hey there', conversation: codexConversation });
  });

  it('refuses while a turn or background work runs', async () => {
    const { app } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: folder() });
    const id = a.session.id;
    await turn(app, id, 'hi');
    const rt = app.sessions.get(id)!;
    rt.turnActive = true;
    await expect(app.call('session.switchAgent', { sessionId: id, provider: 'codex' })).rejects.toThrow(/still working/);
    rt.turnActive = false;
    rt.add<ToolItem>({ type: 'tool', name: 'Agent', kind: 'agent', title: 'Explore the code', status: 'done', result: { agent: { background: 'running' } } } as never);
    await expect(app.call('session.switchAgent', { sessionId: id, provider: 'codex' })).rejects.toThrow(/Background work/);
    expect(rt.meta.provider).toBe('demo');
    expect(switches(app, id)).toHaveLength(0);
  });

  it('keeps the switch, its agents and the handover still to send across a restart', async () => {
    const first = setup();
    const a = await first.app.call('session.create', { provider: 'demo', cwd: folder() });
    const id = a.session.id;
    await turn(first.app, id, 'hi');
    const demoConversation = first.app.sessions.get(id)!.meta.providerSessionId;
    await first.app.call('session.switchAgent', { sessionId: id, provider: 'codex' });
    await first.app.dispose();
    apps.splice(apps.indexOf(first.app), 1);

    const { app, log } = setup(first.home, first.log);
    const meta = app.sessions.get(id)!.meta;
    expect(meta.provider).toBe('codex');
    expect(meta.agents?.find((l) => l.provider === 'demo')?.providerSessionId).toBe(demoConversation);
    expect(meta.agentHandover).toEqual({ from: 'demo' });
    await app.call('session.snapshot', { sessionId: id });
    expect(switches(app, id).map((l) => l.text)).toEqual(['Switched to Codex']);
    await turn(app, id, 'hello codex');
    expect(log.sent.at(-1)!.text).toMatch(/^This continues a conversation the user had with Demo[\s\S]*User: hi[\s\S]*hello codex$/);

    await app.call('session.switchAgent', { sessionId: id, provider: 'demo' });
    await turn(app, id, 'hey demo');
    expect(log.sent.at(-1)!.conversation).toBe(demoConversation);
  });

  it('hands over compactly: the newest exchanges within the budget, steps as one line', async () => {
    const { app, log } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: folder() });
    const id = a.session.id;
    const rt = app.sessions.get(id)!;
    for (let n = 0; n < 40; n++) {
      rt.add<UserItem>({ type: 'user', text: `question ${n} ${'x'.repeat(300)}`, state: 'sent' });
      rt.add({ type: 'text', text: `answer ${n} ${'y'.repeat(600)}` } as never);
    }
    await app.call('session.switchAgent', { sessionId: id, provider: 'codex' });
    await turn(app, id, 'hello codex');
    const text = log.sent.at(-1)!.text;
    const handover = text.slice(0, text.lastIndexOf('\n\n---\n\n'));
    expect(handover.length).toBeLessThanOrEqual(4600);
    expect(handover).toContain('(earlier messages left out)');
    expect(handover).toContain('question 39');
    expect(handover).not.toContain('question 0 ');
  });

  it('a huge chat hands over a bounded brief with the task as last put, the open todos and the files changed', { timeout: 20_000 }, async () => {
    const { app, log } = setup();
    const cwd = folder();
    const a = await app.call('session.create', { provider: 'demo', cwd });
    const id = a.session.id;
    const rt = app.sessions.get(id)!;
    for (let n = 0; n < 2000; n++) {
      rt.add<UserItem>({ type: 'user', text: `question ${n} ${'x'.repeat(300)}`, state: 'sent' });
      rt.add({ type: 'text', text: `answer ${n} ${'y'.repeat(2000)}` } as never);
    }
    rt.add<UserItem>({ type: 'user', text: 'Port the importer to streams', state: 'sent' });
    for (let n = 0; n < 30; n++) {
      rt.add({ type: 'text', text: `progress ${n} ${'p'.repeat(1000)}`, streaming: false } as never);
      rt.add({ type: 'tool', name: 'Edit', kind: 'edit', title: `Edit f${n}.ts`, status: 'done', detail: { path: path.join(cwd, 'src', `f${n}.ts`) } } as never);
    }
    rt.setTodos([
      { content: 'Stream the parser', status: 'completed' },
      { content: 'Keep the CLI flags', status: 'in_progress' },
    ]);
    await app.call('session.switchAgent', { sessionId: id, provider: 'codex' });
    // What it gets is what matters here (the Demo's reply to it may pick any scenario).
    await app.call('session.send', { sessionId: id, text: 'hello codex' });
    await until(() => log.sent.some((s) => s.provider === 'codex'), 'the send to codex');
    const text = log.sent.find((s) => s.provider === 'codex')!.text;
    const handover = text.slice(0, text.lastIndexOf('\n\n---\n\n'));
    expect(handover.length).toBeLessThanOrEqual(4600);
    expect(handover).toContain('User: Port the importer to streams');
    expect(handover).toContain('Open todos:\n- Keep the CLI flags (in progress)');
    expect(handover).toMatch(/Files changed: src\/f0\.ts, .*, and 15 more/);
    expect(text.endsWith('hello codex')).toBe(true);
  });

  it('names who worked since an agent was left', () => {
    const items = [
      { id: 'n1', ts: 0, type: 'notice', variant: 'info', text: '', agentSwitch: { from: 'claude', to: 'codex' } },
      { id: 'u1', ts: 0, type: 'user', text: 'a', state: 'sent' },
      { id: 'n2', ts: 0, type: 'notice', variant: 'info', text: '', agentSwitch: { from: 'codex', to: 'demo' } },
      { id: 'n3', ts: 0, type: 'notice', variant: 'info', text: '', agentSwitch: { from: 'demo', to: 'claude' } },
    ] as never[];
    expect(workedIn(items, 'claude')).toEqual(['codex']);
    expect(undoableSwitch(items, 'claude', 'demo')?.id).toBe('n3');
    expect(undoableSwitch(items, 'claude', 'codex')).toBeUndefined();
    expect(handoverText([{ id: 'u', ts: 0, type: 'user', text: 'fix it', state: 'sent' }], { from: 'Codex', since: true })).toMatch(/^Since your last reply here, the user went on with Codex/);
  });
});

describe('choosing the model', () => {
  it('stores the model and gives it to the running agent only with the next message', async () => {
    const { app, log } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: folder() });
    const id = a.session.id;
    await turn(app, id, 'hi');
    const opens = log.opened.length;
    await app.call('session.setModel', { sessionId: id, model: 'demo-fast' });
    expect(app.sessions.get(id)!.meta.model).toBe('demo-fast');
    expect(log.models).toEqual([]);
    await turn(app, id, 'hello');
    expect(log.models).toEqual([{ provider: 'demo', model: 'demo-fast' }]);
    // The same agent process: nothing was restarted.
    expect(log.opened.length).toBe(opens);
  });

  it('never gives the model to a running turn: a steer leaves it for the next message', async () => {
    const { app, log } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: folder(), mode: 'default' });
    const id = a.session.id;
    const rt = app.sessions.get(id)!;
    // The refactor asks before its first edit: the turn waits there, running.
    await app.call('session.send', { sessionId: id, text: 'refactor the session module' });
    await until(() => rt.prompts().permissions.length > 0, 'the permission prompt');
    await app.call('session.setModel', { sessionId: id, model: 'demo-mini' });
    await app.call('session.send', { sessionId: id, text: 'and keep the API', steer: true });
    expect(log.models).toEqual([]);
    await app.call('session.interrupt', { sessionId: id });
    await until(() => !rt.turnActive && rt.meta.status === 'idle', 'the stop');
    // The steer the stop handed back to the queue would ask again: it goes.
    for (const q of [...rt.queue]) await app.call('queue.remove', { sessionId: id, id: q.id });
    await turn(app, id, 'hello');
    expect(log.models).toEqual([{ provider: 'demo', model: 'demo-mini' }]);
  });

  it('takes /model <name> as the model, never as a message', async () => {
    const { app, log } = setup();
    const cwd = folder();
    const a = await app.call('session.create', { provider: 'demo', cwd });
    const id = a.session.id;
    await turn(app, id, 'hi');
    const sent = log.sent.length;
    const opens = log.opened.length;

    const r = await app.call('session.send', { sessionId: id, text: '/model demo fast' });
    expect(r).toEqual({ ok: true, model: 'demo-fast' });
    expect(app.sessions.get(id)!.meta.model).toBe('demo-fast');
    expect(await app.call('session.send', { sessionId: id, text: '/model Mini' })).toEqual({ ok: true, model: 'demo-mini' });
    const none = await app.call('session.send', { sessionId: id, text: '/model nothing-like-it' });
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/No model called/);
    expect((await app.call('session.send', { sessionId: id, text: '/model' })).ok).toBe(false);
    expect(log.sent.length).toBe(sent);
    expect(log.opened.length).toBe(opens);
    expect(users(app, id).map((u) => u.text)).toEqual(['hi']);

    // Another agent's model switches the chat to that agent (known and signed in).
    await app.call('auth.refresh', { provider: 'codex' });
    await app.call('provider.caps', { provider: 'codex', cwd });
    const other = await app.call('session.send', { sessionId: id, text: '/model gpt-6 mini' });
    expect(other).toEqual({ ok: true, model: 'gpt-6-mini', switched: 'codex' });
    expect(app.sessions.get(id)!.meta.provider).toBe('codex');
    expect(log.sent.length).toBe(sent);
  });

  it('finds a model by id, name or the start of its name', () => {
    const models: ModelInfo[] = [
      { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Most capable' },
      { id: 'opus', name: 'Opus', description: 'Opus 5.5 · Most capable' },
      { id: 'fable', name: 'Fable', description: 'Fable 5.2 · Fast' },
      { id: 'gpt-6-old', name: 'GPT-6 Old', picker: false },
      { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
    ];
    expect(matchModel('fable', models)?.id).toBe('fable');
    expect(matchModel('Opus', models)?.id).toBe('opus');
    expect(matchModel('opus 5.5', models)?.id).toBe('opus');
    expect(matchModel('sol', models)?.id).toBe('gpt-6-sol');
    expect(matchModel('FABLE 5.2', models)?.id).toBe('fable');
    expect(matchModel('gpt-6', models)?.id).toBe('gpt-6-sol');
    expect(matchModel('gpt 6 old', models)?.id).toBe('gpt-6-old');
    expect(matchModel('haiku', models)).toBeUndefined();
    expect(matchModel('  ', models)).toBeUndefined();
  });
});

describe('/model in the composer', () => {
  it('picks the named model at once, and opens the menu without a name', async () => {
    const { APP_COMMANDS } = await import('../src/features/composer/commands');
    const cmd = APP_COMMANDS.find((c) => c.name === 'model')!;
    const calls: string[] = [];
    const ctx = { sessionId: 's', openModel: () => calls.push('menu'), openMode: () => {}, openEffort: () => {}, setModel: (name: string) => calls.push(`set ${name}`) };
    cmd.run(ctx, 'fable');
    cmd.run(ctx, '');
    expect(calls).toEqual(['set fable', 'menu']);
  });
});
