import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { copyFile, opendir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { DEFAULT_ACCOUNT, type BridgeEvent, type NoticeItem, type SessionMeta, type UserItem } from '../shared/protocol';
import { App } from '../server/app';
import * as contain from '../server/core/contain';
import { carry, prefix, type Agent, type Pair } from '../server/accounts/conversation-files';
import type { ConversationCopies } from '../server/accounts/dedupe';
import { DemoProvider } from '../server/providers/demo';
import { CodexProvider } from '../server/providers/codex';
import type { ProviderContext } from '../server/providers/types';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, copyFile: vi.fn(fs.copyFile), opendir: vi.fn(fs.opendir), unlink: vi.fn(fs.unlink) };
});
vi.mock('../server/accounts/conversation-files', async importOriginal => {
  const files = await importOriginal<typeof import('../server/accounts/conversation-files')>();
  return { ...files, prefix: vi.fn(files.prefix) };
});
vi.setConfig({ testTimeout: 30_000 });

const main = 'projects/k/chat-1.jsonl';
const side = 'projects/k/chat-1/subagents/agent-a.jsonl';
const tool = 'projects/k/chat-1/tool-results/result.txt';
const history = 'file-history/chat-1/file@v1';
const rollout = 'sessions/2026/11/25/rollout-2026-11-25T13-04-55-chat-1.jsonl';
const files = (agent: Agent) => agent === 'claude' ? [main, side, history] : [rollout, rollout.replace('13-04', '14-07')];
const built: { app: App; dir: string }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const { app, dir } of built.splice(0)) {
    await app.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  vi.restoreAllMocks();
});

function put(home: string, rel: string, data = 'original') {
  const file = path.join(home, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function junction(ctx: TestContext, target: string, link: string) {
  mkdirSync(path.dirname(link), { recursive: true });
  try { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EPERM' || code === 'EOPNOTSUPP') {
      ctx.skip(`Directory links unavailable on ${process.platform} (${code})`);
    }
    throw err;
  }
}

function fixture(agent: Agent = 'claude', patch: Partial<SessionMeta> = {}, redirected = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sable-copies-'));
  const data = redirected ? path.join(dir, 'redirected') : dir;
  if (redirected) {
    const physical = path.join(dir, 'physical');
    mkdirSync(physical);
    symlinkSync(physical, data, 'junction');
  }
  const home = path.join(data, 'sable'), a = path.join(data, agent), b = path.join(data, 'extra'), c = path.join(data, 'third');
  const meta: SessionMeta = { id: 'chat', provider: agent, providerSessionId: 'chat-1', cwd: dir, title: 'Chat', titleSource: 'user',
    model: 'm', mode: 'default', status: 'idle', usage: { turns: 0, inputTokens: 0, outputTokens: 0 }, createdAt: 0, updatedAt: 0, ...patch };
  const accounts = [{ provider: agent, id: 'extra', dir: b }, { provider: agent, id: 'third', dir: c }];
  put(home, 'state.json', JSON.stringify({ sessions: [meta], accounts, settings: { continueAtLimit: true } }));
  const make = (ctx: ProviderContext) => Object.assign(new DemoProvider(ctx, { speed: 0 }), {
    id: agent, configHome: () => ctx.account?.dir ?? a,
    adoptConversation: (from: string, id: string) => carry(agent, from, ctx.account?.dir ?? a, id),
  });
  const providers = [make, (ctx: ProviderContext) => Object.assign(new DemoProvider(ctx), { id: meta.provider !== agent ? meta.provider : 'demo' as const })];
  const app = new App({ home, providers, quiet: true, userHome: dir });
  built.push({ app, dir });
  const rt = app.runtime('chat');
  const internal = app as unknown as { conversationCopies: ConversationCopies; switching: Set<string> };
  return { a, b, c, home, dir, app, rt, internal, sweep: () => internal.conversationCopies.sweep() };
}

it.each(['claude', 'codex'] as const)('moves %s files after commit and carries their new contents back', async agent => {
  const { app, rt, a, b, c, home, internal } = fixture(agent);
  const targeted = vi.spyOn(internal.conversationCopies, 'sweep');
  const rels = files(agent);
  for (const rel of rels) { put(a, rel); put(b, rel, 'orig'); put(c, rel, rel.endsWith('.jsonl') ? 'orig' : 'original'); }
  const unrelated = agent === 'claude' ? 'projects/k/other.jsonl' : rollout.replace('chat-1', 'another-chat-1');
  put(a, unrelated);
  const first = await app.switchAccount(rt, 'extra');
  expect(first.carried).toBe('conversation');
  expect(JSON.parse(readFileSync(path.join(home, 'state.json'), 'utf8')).sessions[0].accountId).toBe('extra');
  for (const rel of rels) {
    expect(existsSync(path.join(a, rel))).toBe(false);
    expect(readFileSync(path.join(b, rel), 'utf8')).toBe('original');
  }
  expect(targeted).toHaveBeenCalledTimes(1);
  await targeted.mock.results[0].value;
  expect(existsSync(path.join(c, rels[0]))).toBe(false);
  for (const rel of rels) put(b, rel, 'original and new');
  expect((await app.switchAccount(rt, DEFAULT_ACCOUNT)).carried).toBe('conversation');
  for (const rel of rels) {
    expect(existsSync(path.join(b, rel))).toBe(false);
    expect(readFileSync(path.join(a, rel), 'utf8')).toBe('original and new');
  }
  if (agent === 'claude') for (const folder of ['projects/k/chat-1', 'file-history/chat-1']) expect(existsSync(path.join(b, folder))).toBe(false);
  expect(existsSync(path.join(a, unrelated))).toBe(true);
});

it('restores a usable source after copying succeeds but the destination fails to start', async () => {
  const { app, rt, a, b } = fixture();
  for (const rel of files('claude')) put(a, rel);
  rt.handle = await app.provider('claude').open(rt, {});
  const closed = vi.spyOn(rt.handle, 'close');
  vi.spyOn(app.provider('claude', 'extra'), 'open').mockImplementationOnce(async () => {
    expect(closed).toHaveBeenCalled();
    expect(existsSync(path.join(b, main))).toBe(true);
    throw Error('destination unavailable');
  });
  await expect(app.switchAccount(rt, 'extra', { automatic: true })).rejects.toThrow('destination unavailable');
  expect(rt.meta.accountId).toBeUndefined();
  expect(rt.meta.providerSessionId).toBe('chat-1');
  for (const rel of files('claude')) expect(readFileSync(path.join(a, rel), 'utf8')).toBe('original');
  expect(rt.handle).toBeDefined();
  await app.call('session.send', { sessionId: rt.id, text: 'Continue on this account' });
  await vi.waitFor(() => expect(rt.items.some(i => i.type === 'text' && i.text.length)).toBe(true), { timeout: 5000 });
});

it('requires the saved registry to confirm the destination, even if a save returns successfully', async () => {
  const { app, rt, a, home, internal } = fixture();
  put(a, main);
  await app.store.flush();
  vi.spyOn(app.store, 'saveState').mockImplementation(() => {});
  const targeted = vi.spyOn(internal.conversationCopies, 'sweep');
  expect((await app.switchAccount(rt, 'extra')).carried).toBe('conversation');
  await targeted.mock.results[0].value;
  expect(JSON.parse(readFileSync(path.join(home, 'state.json'), 'utf8')).sessions[0].accountId).toBeUndefined();
  expect(readFileSync(path.join(a, main), 'utf8')).toBe('original');
});

it.each(['different', 'longer'])('replaces a %s destination transcript and side files on an automatic move', async conflict => {
  const { app, rt, a, b } = fixture();
  for (const rel of files('claude')) { put(a, rel); put(b, rel, 'orig'); }
  for (const rel of files('claude')) put(b, rel, conflict === 'longer' ? 'original plus other work' : 'oRiginal');
  expect((await app.switchAccount(rt, 'extra', { automatic: true })).carried).toBe('conversation');
  for (const rel of files('claude')) {
    expect(readFileSync(path.join(b, rel), 'utf8')).toBe('original');
    expect(existsSync(path.join(a, rel))).toBe(false);
  }
});

it('keeps a successful move when source removal fails and retries only that conversation', async () => {
  const { app, rt, a, b, internal } = fixture();
  const targeted = vi.spyOn(internal.conversationCopies, 'sweep');
  for (const rel of files('claude')) put(a, rel);
  const other = 'projects/k/other.jsonl';
  for (const home of [a, b]) put(home, other);
  const otherChat = { ...rt.meta, id: 'other-chat', providerSessionId: 'other' };
  (app as unknown as { hidden: SessionMeta[] }).hidden.push(otherChat);
  app.store.state.sessions.push(otherChat);
  vi.mocked(unlink).mockRejectedValueOnce(Object.assign(Error('locked'), { code: 'EPERM' }));
  expect((await app.switchAccount(rt, 'extra')).carried).toBe('conversation');
  for (const rel of files('claude')) expect(existsSync(path.join(a, rel))).toBe(true);
  for (const rel of [main, side]) appendFileSync(path.join(b, rel), ' continued');
  await targeted.mock.results[0].value;
  expect(existsSync(path.join(a, main))).toBe(false);
  for (const home of [a, b]) expect(existsSync(path.join(home, other))).toBe(true);
});

it('sweeps a saved inactive agent leg without opening the chat and retries only proven side files', async () => {
  const { app, a, b, sweep } = fixture('claude', { provider: 'codex', providerSessionId: 'new',
    agents: [{ provider: 'claude', providerSessionId: 'chat-1', accountId: 'extra', model: 'm', mode: 'default' }] });
  const read = vi.spyOn(app.store, 'loadSessionAsync');
  const log = vi.spyOn(app, 'log');
  for (const rel of files('claude')) { put(a, rel, 'abc'); put(b, rel, rel === history ? 'abc' : 'abcdef'); }
  put(a, side + '.unique');
  put(a, side + '.different', 'left'); put(b, side + '.different', 'lest');
  await sweep();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('removed 3 files (9 bytes), skipped 1'));
  for (const rel of files('claude')) expect(existsSync(path.join(a, rel))).toBe(false);
  for (const suffix of ['.unique', '.different']) expect(existsSync(path.join(a, side + suffix))).toBe(true);
  await sweep();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('removed 0 files (0 bytes), skipped 1'));
  put(b, side + '.unique');
  await sweep();
  expect(existsSync(path.join(a, side + '.unique'))).toBe(false);
  expect(read).not.toHaveBeenCalled();
});

it.each(['different', 'longer', 'missing', 'running', 'moving', 'switching', 'background', 'commands', 'unreferenced', 'unsafe ID', 'ambiguous'])(
  'leaves all files when %s', async reason => {
    const { app, rt, a, b, c, sweep, internal } = fixture('claude', reason === 'unsafe ID' ? { providerSessionId: '..' } :
      reason === 'unreferenced' ? { providerSessionId: 'new-id', agents: [{ provider: 'claude', providerSessionId: 'chat-1', accountId: 'extra', model: 'm', mode: 'default' }] } : {});
    for (const rel of files('claude')) for (const home of [a, b, c]) put(home, rel, home === a && rel.endsWith('.jsonl') ? 'original newer' : 'original');
    if (reason === 'different') put(c, main, 'origInal');
    if (reason === 'longer') put(c, main, 'original newer plus extra');
    if (reason === 'missing') rmSync(path.join(a, main));
    if (reason === 'running') rt.beginTurn();
    if (reason === 'background') rt.update({ background: 1 });
    if (reason === 'commands') rt.update({ commands: 1 });
    if (reason === 'moving') rt.update({ moving: true });
    if (reason === 'switching') internal.switching.add(rt.id);
    if (reason === 'ambiguous') app.store.state.sessions.push({ ...rt.meta, id: 'second', accountId: 'extra' });
    const log = vi.spyOn(app, 'log');
    await sweep();
    if (reason === 'unsafe ID') expect(log).toHaveBeenLastCalledWith(expect.stringContaining('unsafe path 1'));
    if (reason === 'missing') expect(log).toHaveBeenLastCalledWith(expect.stringContaining('no current file 1'));
    for (const home of [b, c]) for (const rel of files('claude')) expect(existsSync(path.join(home, rel))).toBe(true);
  });

it.for(['projects/k', 'projects/k/chat-1', 'file-history/chat-1', 'sessions/2026/11'])('refuses a junction at %s', async (rel, ctx) => {
  const agent = rel.startsWith('sessions') ? 'codex' : 'claude';
  const { a, b, c, dir, sweep } = fixture(agent);
  const outside = path.join(dir, 'outside');
  for (const file of files(agent)) {
    put(a, file, file.endsWith('.jsonl') ? 'original newer' : 'original'); put(c, file);
    if (file.startsWith(rel + '/')) put(outside, file.slice(rel.length + 1));
    else put(b, file);
  }
  const link = path.join(b, rel);
  junction(ctx, outside, link);
  await sweep();
  for (const file of files(agent)) {
    expect(readFileSync(path.join(c, file), 'utf8')).toBe('original');
    if (file.startsWith(rel + '/')) expect(readFileSync(path.join(outside, file.slice(rel.length + 1)), 'utf8')).toBe('original');
  }
});

it('stops at an unlink failure and tries the files again on the next pass', async () => {
  const { app, a, b, sweep } = fixture();
  const log = vi.spyOn(app, 'log');
  for (const rel of files('claude')) { put(a, rel, rel.endsWith('.jsonl') ? 'original newer' : 'original'); put(b, rel); }
  vi.mocked(unlink).mockRejectedValueOnce(Object.assign(Error('busy'), { code: 'EBUSY' }));
  await sweep();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('error 1)'));
  for (const rel of files('claude')) expect(existsSync(path.join(b, rel))).toBe(true);
  await sweep();
  for (const rel of files('claude')) expect(existsSync(path.join(b, rel))).toBe(false);
});

it('leaves hard-linked side files and their conversation intact', async () => {
  const { a, b, dir, sweep } = fixture();
  for (const rel of files('claude')) { put(a, rel, rel.endsWith('.jsonl') ? 'original newer' : 'original'); put(b, rel); }
  linkSync(path.join(b, side), path.join(dir, 'outside'));
  await sweep();
  for (const rel of files('claude')) expect(existsSync(path.join(b, rel))).toBe(true);
  expect(readFileSync(path.join(dir, 'outside'), 'utf8')).toBe('original');
});

it('checks the final partial chunk and every rollout before unlinking any', async () => {
  const { a, b, sweep } = fixture('codex');
  const [one, two] = files('codex');
  for (const home of [a, b]) {
    put(home, one, home === a ? 'original extra' : 'original');
    put(home, two, 'x'.repeat(1024 * 1024 + 10) + (home === a ? 'aa' : 'b'));
  }
  await sweep();
  for (const rel of [one, two]) expect(existsSync(path.join(b, rel))).toBe(true);
});

it('leaves a differently cased Codex thread ID at another rollout time untouched', async () => {
  const { a, b, sweep } = fixture('codex');
  const other = rollout.replace('13-04', '15-04').replace('chat-1', 'CHAT-1');
  for (const rel of [rollout, other]) { put(a, rel, 'original newer'); put(b, rel); }
  await sweep();
  expect(existsSync(path.join(b, rollout))).toBe(false);
  expect(readFileSync(path.join(b, other), 'utf8')).toBe('original');
});

it('leaves both copies on quit, including a sweep already queued', async () => {
  const { app, a, b, sweep } = fixture();
  for (const home of [a, b]) put(home, main);
  const pending = sweep();
  await app.dispose();
  await pending;
  for (const home of [a, b]) expect(existsSync(path.join(home, main))).toBe(true);
});

it('closes a registry handle held by a sweep before the final quit save', async () => {
  const { app, a, b, home, sweep } = fixture();
  put(a, main, 'original newer'); put(b, main);
  const open = contain.openContained;
  let entered!: () => void, release!: () => void;
  const opened = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(contain, 'openContained').mockImplementationOnce(async (...args) => {
    const registry = await open(...args);
    expect(args[0]).toBe(path.join(home, 'state.json'));
    entered();
    await gate;
    return registry;
  });
  const scan = sweep();
  await opened;
  const seal = vi.spyOn(app.store, 'seal');
  const quit = app.dispose();
  try { expect(seal).not.toHaveBeenCalled(); } finally { release(); }
  await Promise.all([quit, scan]);
  expect(seal).toHaveBeenCalledTimes(1);
  expect(existsSync(path.join(b, main))).toBe(true);
});

it('starts one minute after startup and reads an unopened chat solely from its metadata', async () => {
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const { app, a, b, internal } = fixture();
  const start = timers.mock.calls.findLast(([, delay]) => delay === 60_000)?.[0];
  timers.mockRestore();
  const base = vi.spyOn(app.store, 'loadSessionAsync');
  const sweep = vi.spyOn(internal.conversationCopies, 'sweep');
  put(a, main, 'original newer'); put(b, main);
  expect(start).toBeTypeOf('function');
  (start as () => void)();
  expect(sweep).toHaveBeenCalledTimes(1);
  await sweep.mock.results[0].value;
  expect(existsSync(path.join(b, main))).toBe(false);
  expect(base).not.toHaveBeenCalled();
});

it('compares two 200 MiB transcripts with event-loop stalls below 50 ms and sends one quiet toast', async () => {
  const { app, a, b, sweep } = fixture();
  for (const home of [a, b]) { put(home, main); truncateSync(path.join(home, main), 200 * 1024 * 1024 + Number(home === a)); }
  const events: BridgeEvent[] = [];
  app.subscribe(e => { if (e.type === 'toast') events.push(e); });
  let last = performance.now(), longest = 0, ticks = 0;
  const sample = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; ticks++; };
  const timer = setInterval(sample, 2);
  try { await sweep(); sample(); } finally { clearInterval(timer); }
  console.info(`200 MiB prefix comparison: ${ticks} heartbeats, longest gap ${longest.toFixed(1)} ms`);
  expect(existsSync(path.join(b, main))).toBe(false);
  expect(ticks).toBeGreaterThan(2);
  expect(longest).toBeLessThan(50);
  expect(events).toEqual([{ type: 'toast', level: 'info', text: 'Removed 209.7 MB of duplicate conversation copies' }]);
}, 30_000);

it.each(['account junction', 'data junction'])('carries, retires and sweeps through a configured %s', async redirect => {
  const { app, rt, a, b, c, dir, internal } = fixture('claude', {}, redirect === 'data junction');
  if (redirect === 'account junction') {
    const target = path.join(dir, 'physical');
    mkdirSync(target);
    symlinkSync(target, b, 'junction');
  }
  for (const rel of files('claude')) put(a, rel);
  put(c, main, 'orig');
  const after = vi.spyOn(internal.conversationCopies, 'sweep');
  expect((await app.switchAccount(rt, 'extra', { automatic: true })).carried).toBe('conversation');
  for (const rel of files('claude')) {
    expect(readFileSync(path.join(b, rel), 'utf8')).toBe('original');
    expect(existsSync(path.join(a, rel))).toBe(false);
  }
  await after.mock.results[0].value;
  expect(existsSync(path.join(c, main))).toBe(false);
});

it.each(['junction', 'case'] as const)('leaves one physical account untouched through its %s alias', async alias => {
  const { app, rt, a, b, internal } = fixture();
  put(a, main);
  let other = b;
  if (alias === 'junction') symlinkSync(a, b, 'junction');
  else {
    other = a.toUpperCase();
    if (!existsSync(other)) other = a; // case-sensitive volume
    app.store.state.accounts.find(ac => ac.id === 'extra')!.dir = other;
  }
  const before = statSync(path.join(a, main), { bigint: true });
  const after = vi.spyOn(internal.conversationCopies, 'sweep');
  expect((await app.switchAccount(rt, 'extra')).carried).toBe('conversation');
  await after.mock.results[0].value;
  const st = statSync(path.join(other, main), { bigint: true });
  expect([st.ino, st.mtimeNs]).toEqual([before.ino, before.mtimeNs]);
  expect(readFileSync(path.join(a, main), 'utf8')).toBe('original');
});

it.for([
  { agent: 'claude', areas: ['projects', 'file-history'] },
  { agent: 'claude', areas: ['projects'] },
  { agent: 'claude', areas: ['file-history'] },
  { agent: 'codex', areas: ['sessions'] },
] as const)('moves with shared $areas and sweeps each physical area once', async ({ agent, areas }, ctx) => {
  const { app, rt, a, b, c, dir, internal, sweep } = fixture(agent);
  for (const area of areas) {
    const target = path.join(dir, 'shared', area);
    mkdirSync(target, { recursive: true });
    for (const root of [a, b, c]) junction(ctx, target, path.join(root, area));
  }
  const rels = files(agent);
  const shared = rels.filter(rel => areas.some(area => rel.startsWith(area + '/')));
  for (const rel of rels) put(a, rel);
  const before = shared.map(rel => statSync(path.join(a, rel), { bigint: true }));
  // With shared projects this third account has an equal primary. Its separate history stays.
  if (agent === 'claude' && !shared.includes(history)) put(c, history);
  vi.mocked(copyFile).mockClear();
  const after = vi.spyOn(internal.conversationCopies, 'sweep');
  expect((await app.switchAccount(rt, 'extra', { automatic: true })).carried).toBe('conversation');
  expect(vi.mocked(copyFile)).toHaveBeenCalledTimes(rels.length - shared.length);
  await after.mock.results[0].value;
  vi.mocked(unlink).mockClear();
  await sweep();
  expect(unlink).not.toHaveBeenCalled();
  for (const rel of rels) {
    expect(readFileSync(path.join(b, rel), 'utf8')).toBe('original');
    if (!shared.includes(rel)) expect(existsSync(path.join(a, rel))).toBe(false);
  }
  for (const [i, rel] of shared.entries()) for (const root of [a, b, c]) {
    const st = statSync(path.join(root, rel), { bigint: true });
    expect([st.dev, st.ino, st.mtimeNs]).toEqual([before[i].dev, before[i].ino, before[i].mtimeNs]);
  }
  if (agent === 'claude' && !shared.includes(history)) expect(readFileSync(path.join(c, history), 'utf8')).toBe('original');
});

it('skips a key junction inside shared projects during carry and vetoes removal in other accounts', async ctx => {
  const { app, a, b, c, dir, sweep } = fixture();
  const shared = path.join(dir, 'shared'), linked = path.join(dir, 'linked');
  put(linked, 'chat-1.jsonl', 'original newer');
  junction(ctx, linked, path.join(shared, 'k'));
  for (const root of [a, b]) junction(ctx, shared, path.join(root, 'projects'));
  expect(await carry('claude', a, c, 'chat-1')).toBe(false);
  expect(existsSync(path.join(c, main))).toBe(false);
  const safe = 'projects/plain/chat-1.jsonl';
  put(a, safe, 'original newer'); put(c, safe);
  const log = vi.spyOn(app, 'log');
  await sweep();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('unsafe path 1'));
  expect(readFileSync(path.join(c, safe), 'utf8')).toBe('original');
  expect(readFileSync(path.join(linked, 'chat-1.jsonl'), 'utf8')).toBe('original newer');
});

it('carries the plain and hard-linked side files, skips odd entries and retains the entire source', async () => {
  const { app, rt, a, b, dir, internal } = fixture();
  const folder = 'projects/k/chat-1';
  for (const rel of files('claude')) put(a, rel);
  const target = path.join(dir, 'outside');
  put(target, 'secret', 'untouched');
  symlinkSync(target, path.join(a, folder, 'junction'), 'junction');
  const link = path.join(a, folder, 'link');
  try { symlinkSync(path.join(target, 'secret'), link, 'file'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err; }
  linkSync(path.join(target, 'secret'), path.join(a, folder, 'hard'));
  put(a, folder + '/auth.json', 'sign-in');
  const after = vi.spyOn(internal.conversationCopies, 'sweep');
  expect((await app.switchAccount(rt, 'extra', { automatic: true })).carried).toBe('conversation');
  appendFileSync(path.join(b, main), ' continued');
  await after.mock.results[0].value;
  for (const rel of files('claude')) expect(existsSync(path.join(a, rel)) && existsSync(path.join(b, rel))).toBe(true);
  for (const name of ['junction', 'link', 'auth.json']) expect(existsSync(path.join(b, folder, name))).toBe(false);
  expect(lstatSync(path.join(a, folder, 'junction')).isSymbolicLink()).toBe(true);
  expect(readFileSync(path.join(a, folder, 'auth.json'), 'utf8')).toBe('sign-in');
  expect(readFileSync(path.join(b, folder, 'hard'), 'utf8')).toBe('untouched');
  expect(statSync(path.join(b, folder, 'hard')).nlink).toBe(1);
  expect(readFileSync(path.join(target, 'secret'), 'utf8')).toBe('untouched');
});

it('skips a junction on the destination side and never overwrites another name of a destination file', async () => {
  const { app, rt, a, b, dir } = fixture();
  for (const rel of files('claude')) put(a, rel);
  put(dir, 'outside/secret', 'untouched');
  put(b, main);
  mkdirSync(path.dirname(path.join(b, history)), { recursive: true });
  linkSync(path.join(dir, 'outside/secret'), path.join(b, history));
  symlinkSync(path.join(dir, 'outside'), path.join(b, 'projects/k/chat-1'), 'junction');
  expect((await app.switchAccount(rt, 'extra')).carried).toBe('conversation');
  expect(readFileSync(path.join(b, history), 'utf8')).toBe('original');
  expect(readFileSync(path.join(dir, 'outside/secret'), 'utf8')).toBe('untouched');
  expect(existsSync(path.join(dir, 'outside/subagents'))).toBe(false);
  for (const rel of files('claude')) expect(existsSync(path.join(a, rel))).toBe(true);
});

it.each(['claude', 'codex'] as const)('refreshes the mtime of every carried file from a forty-day-old %s chat', async agent => {
  const { app, rt, a, b } = fixture(agent);
  const old = new Date(Date.now() - 40 * 86400_000);
  for (const rel of files(agent)) { put(a, rel); utimesSync(path.join(a, rel), old, old); }
  const start = Date.now();
  expect((await app.switchAccount(rt, 'extra')).carried).toBe('conversation');
  for (const rel of files(agent)) {
    expect(statSync(path.join(b, rel)).mtimeMs).toBeGreaterThanOrEqual(start - 1);
    expect(existsSync(path.join(a, rel))).toBe(false);
  }
});

it('protects all older copies when the current transcript is over twenty days old', async () => {
  const { app, a, b, sweep } = fixture();
  for (const rel of files('claude')) { put(a, rel, rel.endsWith('.jsonl') ? 'original newer' : 'original'); put(b, rel); }
  const log = vi.spyOn(app, 'log');
  const old = new Date(Date.now() - 21 * 86400_000);
  utimesSync(path.join(a, main), old, old);
  await sweep();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('old current file 1'));
  for (const rel of files('claude')) expect(existsSync(path.join(b, rel))).toBe(true);
  utimesSync(path.join(a, main), new Date(), new Date());
  await sweep();
  for (const rel of files('claude')) expect(existsSync(path.join(b, rel))).toBe(false);
});

it('keeps equal copies on conflicting sweeps and retires the equal source under a move reservation', async () => {
  const { app, rt, a, b, sweep, home } = fixture();
  for (const root of [a, b]) for (const rel of [main, side, tool]) put(root, rel);
  await sweep();
  for (const rel of [main, side, tool]) expect(existsSync(path.join(b, rel))).toBe(true);
  rt.update({ accountId: 'extra' });
  await app.store.persistInput(rt.id, true);
  expect(JSON.parse(readFileSync(path.join(home, 'state.json'), 'utf8')).sessions[0].accountId).toBe('extra');
  await sweep();
  for (const rel of [main, side, tool]) expect(existsSync(path.join(a, rel))).toBe(true);
  expect((await app.switchAccount(rt, DEFAULT_ACCOUNT)).carried).toBe('conversation');
  expect(readFileSync(path.join(a, main), 'utf8')).toBe('original');
  expect(existsSync(path.join(b, main))).toBe(false);
});

it('retires an equal finished sub-agent and tool result before their strictly shorter primary', async () => {
  const { a, b, sweep } = fixture();
  for (const rel of [main, side, tool]) { put(b, rel); put(a, rel, rel === main ? 'original newer' : 'original'); }
  const different = 'projects/k/chat-1/subagents/unfinished.jsonl';
  put(b, different, 'left'); put(a, different, 'lest');
  vi.mocked(unlink).mockClear();
  await sweep();
  const removed = vi.mocked(unlink).mock.calls.map(([file]) => file);
  expect(removed.slice(0, -1).sort()).toEqual([path.join(b, side), path.join(b, tool)].sort());
  expect(removed.at(-1)).toBe(path.join(b, main));
  for (const rel of [main, side, tool]) {
    expect(existsSync(path.join(b, rel))).toBe(false);
    expect(existsSync(path.join(a, rel))).toBe(true);
  }
  expect(readFileSync(path.join(b, different), 'utf8')).toBe('left');
  expect(existsSync(path.dirname(path.join(b, different)))).toBe(true);
  expect(existsSync(path.dirname(path.join(b, tool)))).toBe(false);
});

it('uses the orphan rules when only another project key or account has a proven older primary', async () => {
  const { a, b, c, sweep } = fixture();
  const other = main.replace('/k/', '/j/');
  put(a, main, 'original newer'); put(a, other, 'original newer');
  put(b, other); put(c, main);
  for (const root of [a, b, c]) { put(root, side); put(root, tool); }
  const growing = side.replace('agent-a', 'agent-b');
  put(a, growing, 'original newer'); put(b, growing);
  await sweep();
  expect(existsSync(path.join(c, side))).toBe(false);
  expect(existsSync(path.join(b, other))).toBe(false);
  expect(readFileSync(path.join(b, side), 'utf8')).toBe('original');
  for (const rel of [tool, growing]) expect(existsSync(path.join(b, rel))).toBe(false);
});

it('keeps side files in both accounts when the current primary is absent', async () => {
  const { a, b, sweep } = fixture();
  put(b, main);
  for (const root of [a, b]) for (const rel of [side, tool]) put(root, rel);
  await sweep();
  for (const root of [a, b]) for (const rel of [side, tool]) expect(readFileSync(path.join(root, rel), 'utf8')).toBe('original');
  expect(existsSync(path.join(b, main))).toBe(true);
});

it('retains a strict-prefix history backup and tool result while retiring a proven transcript', async () => {
  const { a, b, sweep } = fixture();
  for (const rel of [main, history, tool]) { put(a, rel, 'original extended'); put(b, rel); }
  await sweep();
  expect(existsSync(path.join(b, main))).toBe(false);
  for (const rel of [history, tool]) expect(readFileSync(path.join(b, rel), 'utf8')).toBe('original');
});

it('vetoes the conversation for a junction unique to the current tree', async () => {
  const { app, a, b, dir, sweep } = fixture();
  put(a, main, 'original newer'); put(b, main); put(a, side);
  put(dir, 'outside/file');
  symlinkSync(path.join(dir, 'outside'), path.join(a, 'projects/k/chat-1/new-link'), 'junction');
  const log = vi.spyOn(app, 'log');
  await sweep();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('unsafe path 1'));
  expect(readFileSync(path.join(b, main), 'utf8')).toBe('original');
  expect(existsSync(path.join(dir, 'outside/file'))).toBe(true);
});

async function interceptProof(after: (p: Pair) => void | Promise<void>, during = false) {
  const { prefix: compare } = await vi.importActual<typeof import('../server/accounts/conversation-files')>('../server/accounts/conversation-files');
  vi.mocked(prefix).mockImplementationOnce(async (pair, check) => {
    let chunks = 0;
    const result = await compare(pair, () => {
      check();
      if (during && ++chunks === 2) after(pair);
    });
    if (!during) await after(pair);
    return result;
  });
}

it.for(['projects', 'file-history', 'sessions'].flatMap(area => ['current', 'older'].map(which => ({ area, which }))))(
  'vetoes removal when the $which $area junction is repointed after the proof', async ({ area, which }, ctx) => {
    const agent = area === 'sessions' ? 'codex' : 'claude';
    const { app, a, b, dir, sweep } = fixture(agent);
    const redirected = which === 'current' ? a : b;
    const target = path.join(dir, 'target'), replacement = path.join(dir, 'replacement');
    for (const folder of [target, replacement]) mkdirSync(folder);
    const link = path.join(redirected, area);
    junction(ctx, target, link);
    junction(ctx, replacement, link + '-next');
    for (const rel of files(agent)) { put(a, rel, rel === main || agent === 'codex' ? 'original newer' : 'original'); put(b, rel); }
    await interceptProof(() => { unlinkSync(link); renameSync(link + '-next', link); });
    const log = vi.spyOn(app, 'log');
    await sweep();
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('unsafe path 1'));
    for (const rel of files(agent)) {
      const original = rel.startsWith(area + '/') ? path.join(target, rel.slice(area.length + 1)) : path.join(redirected, rel);
      expect(existsSync(original)).toBe(true);
      expect(existsSync(path.join(redirected === a ? b : a, rel))).toBe(true);
    }
  });

it('rechecks the older primary before unlinking a side file whose equality it proved', async () => {
  const { a, b, sweep } = fixture();
  for (const rel of [main, side, tool]) { put(a, rel, rel === main ? 'original newer' : 'original'); put(b, rel); }
  const { prefix: compare } = await vi.importActual<typeof import('../server/accounts/conversation-files')>('../server/accounts/conversation-files');
  vi.mocked(prefix).mockImplementationOnce(compare).mockImplementationOnce(async (pair, check) => {
    const equal = await compare(pair, check);
    appendFileSync(path.join(b, main), ' newer again');
    return equal;
  });
  await sweep();
  expect(readFileSync(path.join(b, main), 'utf8')).toBe('original newer again');
  for (const rel of [side, tool]) expect(readFileSync(path.join(b, rel), 'utf8')).toBe('original');
});

it.each((['during comparison', 'after proof'] as const).flatMap(when =>
  (['current', 'old'] as const).flatMap(which => (['grow', 'shrink', 'replace'] as const).map(change => ({ when, which, change })))
))('keeps both transcripts when the $which file changes ($change, $when)', async ({ when, which, change }) => {
  const { a, b, sweep } = fixture();
  const data = 'x'.repeat(1024 * 1024 + 128);
  put(a, main, data + ' newer'); put(b, main, data);
  const file = path.join(which === 'current' ? a : b, main);
  let changed = false;
  await interceptProof(() => {
    if (change === 'grow') appendFileSync(file, 'changed');
    if (change === 'shrink') truncateSync(file, 1);
    if (change === 'replace') {
      renameSync(file, file + '.before');
      writeFileSync(file, readFileSync(file + '.before'));
    }
    changed = true;
  }, when === 'during comparison');
  await sweep();
  expect(changed).toBe(true);
  expect(existsSync(path.join(a, main)) && existsSync(path.join(b, main))).toBe(true);
});

it('retires the equal move source while the destination appends after the byte proof', async () => {
  const { app, rt, a, b } = fixture();
  put(a, main);
  await interceptProof(pair => appendFileSync(pair.dst, ' continued'));
  expect((await app.switchAccount(rt, 'extra')).carried).toBe('conversation');
  expect(existsSync(path.join(a, main))).toBe(false);
  expect(readFileSync(path.join(b, main), 'utf8')).toBe('original continued');
});

it.each(['current', 'old'])('rechecks ownership when the %s account is removed after proof', async which => {
  const { app, a, b, sweep } = fixture('claude', { accountId: which === 'current' ? 'extra' : undefined });
  put(a, main, which === 'current' ? 'original' : 'original newer');
  put(b, main, which === 'current' ? 'original newer' : 'original');
  await interceptProof(async () => { await app.call('account.remove', { provider: 'claude', accountId: 'extra' }); });
  await sweep();
  expect(app.accountList('claude').some(ac => ac.id === 'extra')).toBe(false);
  // Both are externally registered folders; forgetting one must not authorize an unlink.
  expect(existsSync(path.join(a, main)) && existsSync(path.join(b, main))).toBe(true);
});

it('skips two saved chats claiming the same conversation even when only one is opened', async () => {
  const { app, rt, home, a, b, sweep } = fixture();
  put(a, main, 'original newer'); put(b, main);
  await app.store.flush();
  const saved = JSON.parse(readFileSync(path.join(home, 'state.json'), 'utf8'));
  saved.sessions.push({ ...rt.meta, id: 'another-chat', accountId: 'extra' });
  put(home, 'state.json', JSON.stringify(saved));
  const log = vi.spyOn(app, 'log');
  await sweep();
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('unproven copy 1'));
  expect(existsSync(path.join(b, main))).toBe(true);
});

it.each(['move', 'agent switch'])('stops a proven unlink when a real %s starts mid-sweep', async operation => {
  const { app, rt, a, b, sweep } = fixture();
  put(a, main, 'original newer'); put(b, main);
  await app.call('session.snapshot', { sessionId: rt.id });
  rt.handle = await app.provider('claude').open(rt, {});
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(rt.handle, 'close').mockImplementationOnce(async () => { enter(); await hold; });
  let switching: Promise<unknown> | undefined;
  await interceptProof(async () => {
    switching = operation === 'move' ? app.switchAccount(rt, 'third') : app.switchAgent(rt, 'demo');
    await Promise.race([entered, switching]);
  });
  try {
    await sweep();
    expect(switching).toBeDefined();
    expect(readFileSync(path.join(b, main), 'utf8')).toBe('original');
  } finally { release(); await switching; }
});

it('uses one ten-minute timer for busy chats, rechecks their work and stops retrying when done', async () => {
  const { app, rt, a, b, internal, sweep } = fixture();
  put(a, main, 'original newer'); put(b, main);
  rt.update({ moving: true });
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const next = () => timers.mock.calls.flatMap((args, i) => args[1] === 600_000 ? [{ fire: args[0] as () => void, timer: timers.mock.results[i].value }] : []);
  const log = vi.spyOn(app, 'log');
  await sweep(); await sweep();
  expect(next()).toHaveLength(1);
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('busy 1'));
  const retry = vi.spyOn(internal.conversationCopies, 'sweep');
  clearTimeout(next()[0].timer); next()[0].fire();
  await retry.mock.results[0].value;
  expect(existsSync(path.join(b, main))).toBe(true);
  expect(next()).toHaveLength(2);
  rt.update({ moving: false });
  clearTimeout(next()[1].timer); next()[1].fire();
  await retry.mock.results[1].value;
  expect(existsSync(path.join(b, main))).toBe(false);
  expect(next()).toHaveLength(2);
});

it.each(['quit', 'update'])('clears the pending busy retry on %s', async stop => {
  const { app, rt, a, b, sweep } = fixture();
  put(a, main, 'original newer'); put(b, main);
  rt.update({ moving: true });
  const timers = vi.spyOn(globalThis, 'setTimeout');
  await sweep();
  const i = timers.mock.calls.findIndex(args => args[1] === 600_000);
  expect(i).toBeGreaterThanOrEqual(0);
  const clear = vi.spyOn(globalThis, 'clearTimeout');
  if (stop === 'quit') await app.dispose();
  else {
    app.updates = { installing: true, state: { status: 'ready', current: '0' }, dispose() {} };
    app.emit({ type: 'update.state', state: app.updates.state });
  }
  expect(clear).toHaveBeenCalledWith(timers.mock.results[i].value);
  expect(existsSync(path.join(b, main))).toBe(true);
});

it('stops before unlink when installation begins during the sweep', async () => {
  const { app, a, b, sweep } = fixture();
  put(a, main, 'original newer'); put(b, main);
  await interceptProof(() => {
    app.updates = { installing: true, state: { status: 'ready', current: '0' }, dispose() {} };
    app.emit({ type: 'update.state', state: app.updates.state });
  });
  await sweep();
  expect(app.updates?.installing).toBe(true);
  expect(existsSync(path.join(b, main))).toBe(true);
});

it('indexes each account and key once for a full sweep across several chats', async () => {
  const { app, rt, home, a, b, sweep } = fixture();
  const saved = JSON.parse(readFileSync(path.join(home, 'state.json'), 'utf8'));
  for (const id of ['chat-1', 'chat-2', 'chat-3']) {
    if (id !== 'chat-1') {
      const meta = { ...rt.meta, id, providerSessionId: id };
      saved.sessions.push(meta);
      app.store.state.sessions.push(meta);
    }
    for (const key of ['k', 'j']) {
      const rel = 'projects/' + key + '/' + id + '.jsonl';
      put(a, rel, 'original newer'); put(b, rel);
    }
  }
  put(home, 'state.json', JSON.stringify(saved));
  vi.mocked(opendir).mockClear();
  await sweep();
  for (const root of [a, b]) for (const folder of ['projects', 'projects/k', 'projects/j']) {
    expect(vi.mocked(opendir).mock.calls.filter(([file]) => file === path.join(root, folder))).toHaveLength(1);
  }
  for (const key of ['k', 'j']) for (const id of ['chat-1', 'chat-2', 'chat-3']) {
    expect(existsSync(path.join(b, 'projects', key, id + '.jsonl'))).toBe(false);
  }
});

it('keeps a targeted pass quiet when there are no candidates', async () => {
  const { rt, app, a, b, internal } = fixture();
  put(a, main); mkdirSync(b);
  const log = vi.spyOn(app, 'log');
  const events: BridgeEvent[] = [];
  app.subscribe(e => { if (e.type === 'toast') events.push(e); });
  await internal.conversationCopies.sweep({ chat: rt.id, agent: 'claude', account: DEFAULT_ACCOUNT, id: 'chat-1' });
  expect(log.mock.calls.filter(([line]) => String(line).includes('Conversation copies'))).toEqual([]);
  expect(events).toEqual([]);
});

it('overwrites a longer destination left by a failed first send on the next automatic move', async () => {
  const { app, rt, a, b } = fixture();
  await app.call('session.snapshot', { sessionId: rt.id });
  put(a, main);
  const owner = rt.add<UserItem>({ type: 'user', text: 'retry', state: 'sent' });
  const card = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit',
    limit: { origin: 'user', userItemId: owner.id, provider: 'claude', next: 'extra' } });
  const dest = app.provider('claude', 'extra'), start = dest.open.bind(dest);
  vi.spyOn(dest, 'open').mockImplementationOnce(async (...args) => {
    const session = await start(...args);
    session.send = async () => { appendFileSync(path.join(b, main), ' failed first send'); throw Error('send rejected'); };
    return session;
  });
  await expect(app.switchAccount(rt, 'extra', { automatic: true, retry: true, refusalId: card.id })).rejects.toThrow();
  expect(rt.meta.accountId).toBeUndefined();
  expect(readFileSync(path.join(b, main), 'utf8')).toBe('original failed first send');
  expect(readFileSync(path.join(a, main), 'utf8')).toBe('original');
  expect((await app.switchAccount(rt, 'extra', { automatic: true })).carried).toBe('conversation');
  expect(readFileSync(path.join(b, main), 'utf8')).toBe('original');
  expect(existsSync(path.join(a, main))).toBe(false);
});

it.each(['current receipt', 'both reads pending', 'late original receipt'])('confirms a waiting steer after the move (%s)', async scenario => {
  const { app, rt, a, b } = fixture();
  await app.call('session.snapshot', { sessionId: rt.id });
  const uuid = 'receipt-1';
  put(a, main, uuid);
  const q = rt.enqueue('queued before the move');
  q.byHand = true;
  q.issuedUuid = uuid;
  q.issuedTo = { provider: 'claude', session: 'chat-1', cwd: rt.meta.cwd };
  const read = vi.fn(async () => scenario === 'late original receipt' ? [] : [readFileSync(path.join(b, main), 'utf8')]);
  app.provider('claude', 'extra').steerReceipts = read;
  let finishOld: (() => void) | undefined;
  const original = vi.fn(() => new Promise<string[]>((resolve, reject) => {
    finishOld = () => scenario === 'late original receipt' ? resolve([uuid]) : reject(Error('old file is gone'));
  }));
  app.provider('claude').steerReceipts = original;
  const old = scenario !== 'current receipt' ? (app as unknown as { restoreSteerReceipts(runtime: typeof rt): Promise<void> }).restoreSteerReceipts(rt) : undefined;
  try {
    if (old) await vi.waitFor(() => expect(original).toHaveBeenCalledTimes(1));
    expect((await app.switchAccount(rt, 'extra')).carried).toBe('conversation');
    expect(existsSync(path.join(a, main))).toBe(false);
    if (scenario === 'late original receipt') {
      // A negative in the new home cannot authorize a resend while the original read is in flight.
      await app.call('queue.sendNow', { sessionId: rt.id, id: q.id });
      expect(rt.queue.find(row => row.id === q.id)?.steerWait?.reason).toContain('Still checking');
    } else await vi.waitFor(() => expect(rt.queue.some(row => row.issuedUuid === uuid)).toBe(false));
  } finally { finishOld?.(); await old; }
  expect(read).toHaveBeenCalledWith('chat-1', rt.meta.cwd, new Set([uuid]));
  expect(original).toHaveBeenCalledTimes(Number(!!old));
  expect(rt.queue.some(row => row.issuedUuid === uuid)).toBe(false);
  expect(rt.items.some(item => item.type === 'user' && item.text === 'queued before the move')).toBe(true);
});

it.each(['answered', 'timed out during move', 'timed out before move'])('checks the Codex unsubscribe before retiring a source (%s)', async result => {
  const { app, rt, a, b, internal, sweep } = fixture('codex');
  await app.call('session.snapshot', { sessionId: rt.id });
  put(a, rollout);
  const source = new CodexProvider({ emit: () => {}, log: () => {}, account: { id: DEFAULT_ACCOUNT, dir: a } });
  const rpc = { request: vi.fn(async (method: string) => {
    if (method === 'thread/resume') return { thread: { id: 'chat-1' } };
    if (method === 'thread/unsubscribe' && result !== 'answered') throw Error('request timed out');
    return {};
  }) };
  Object.assign(source, { client: async () => rpc, caps: app.provider('codex').caps.bind(app.provider('codex')) });
  Object.assign(app.provider('codex'), { conversationReleased: source.conversationReleased.bind(source) });
  app.onDispose(() => source.dispose());
  rt.handle = await source.open(rt, {});
  if (result === 'timed out before move') {
    await rt.handle.close('limit');
    rt.handle = undefined;
  }
  const after = vi.spyOn(internal.conversationCopies, 'sweep');
  expect((await app.switchAccount(rt, 'extra')).carried).toBe('conversation');
  expect(rpc.request.mock.calls.some(([method]) => method === 'thread/unsubscribe')).toBe(true);
  expect(readFileSync(path.join(b, rollout), 'utf8')).toBe('original');
  if (result === 'answered') {
    expect(existsSync(path.join(a, rollout))).toBe(false);
    return;
  }
  appendFileSync(path.join(b, rollout), ' continued');
  await after.mock.results[0].value;
  expect(readFileSync(path.join(a, rollout), 'utf8')).toBe('original');
  (source as unknown as { onExit(rpc: unknown, info: unknown): void }).onExit(rpc, { code: 0, stderr: '' });
  await sweep();
  expect(existsSync(path.join(a, rollout))).toBe(false);
});
