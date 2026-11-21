/**
 * Customize Sable (`server/services/custom.ts`): the person's stylesheet (what is served, to whom, and
 * live), the build's switch and the server's root as a function of it, the start watchdog with a fake
 * clock, the workspace's steps with a fake runner (nothing here runs git, pnpm or the network), the
 * Customize chat, and the brief only that chat's agent gets. No agent runs here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CUSTOM_READY_MS, DEFAULT_SETTINGS, type AppSettings, type BridgeEvent, type CustomState } from '@shared/protocol';
import { App } from '../server/app';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import { DemoProvider } from '../server/providers/demo';
import { createStaticServer } from '../server/serve';
import { BUILD_OFF, BUILD_SHIPS, BUILD_STATE_FILE, conflictMessage, customBrief, Customizer, ownOrigin, registerCustom, remoteRef, type CustomRunner, type RunResult } from '../server/services/custom';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'sable-custom-'));
  dirs.push(d);
  return d;
};
const servers: Server[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const a of apps.splice(0)) await a.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const writeStyles = (home: string, css: string) => {
  mkdirSync(path.join(home, 'custom'), { recursive: true });
  writeFileSync(path.join(home, 'custom', 'styles.css'), css);
};

function make(home: string, extra: Partial<ConstructorParameters<typeof Customizer>[0]> = {}, settings: Partial<AppSettings> = {}) {
  const events: CustomState[] = [];
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const c = new Customizer({ home, version: '0.3.0', watch: false, settings: () => s, emit: (st) => events.push(st), ...extra });
  return { c, events, settings: s };
}

describe('what a stylesheet may ask for', () => {
  it('flags every way of reaching the internet', () => {
    expect(remoteRef('.a { background: url(https://example.com/x.png) }')).toBe('https://example.com/x.png');
    expect(remoteRef('@import "http://example.com/a.css";')).toMatch(/^http:\/\/example\.com/);
    expect(remoteRef('.a { background: url(//example.com/x.png) }')).toBe('//example.com/x.png');
    expect(remoteRef('.a { background: image-set("https://e.com/a.png" 1x) }')).toMatch(/^https:\/\/e\.com/);
    // Escapes are decoded before looking.
    expect(remoteRef('.a { background: \\75 rl(\\68 ttps://e.com/a.png) }')).toMatch(/^https:\/\/e\.com/);
    expect(remoteRef('.a { background: url("ht\\tps://e.com/a.png") }')).toMatch(/e\.com/);
  });

  it('leaves local and data: references alone, and comments out of it', () => {
    expect(remoteRef(':root { --bg: #000 } .sidebar { width: 200px }')).toBeUndefined();
    expect(remoteRef(".a { background: url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>\") }")).toBeUndefined();
    expect(remoteRef(".a { background: url(data:image/svg+xml;utf8,<svg%20xmlns='http://www.w3.org/2000/svg'/>) }")).toBeUndefined();
    expect(remoteRef('/* from https://example.com */ .a { background: url(/assets/x.svg) }')).toBeUndefined();
  });
});

describe('who gets the stylesheet', () => {
  const req = (headers: Record<string, string>) => ({ headers }) as never;
  it('only the app’s own page on a loopback host', () => {
    expect(ownOrigin(req({ host: '127.0.0.1:5191' }))).toBe(true);
    expect(ownOrigin(req({ host: 'localhost:5191', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(ownOrigin(req({ host: '127.0.0.1:5191', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(ownOrigin(req({ host: '127.0.0.1:5191', 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(ownOrigin(req({ host: '127.0.0.1:5191', origin: 'http://evil.test' }))).toBe(false);
    expect(ownOrigin(req({ host: 'evil.test:5191' }))).toBe(false);
  });
});

/** A static server on a free port over `own`, with the customizer's route and root. */
async function serve(own: string, c: Customizer) {
  const server = createStaticServer(own, undefined, () => c);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const get = (p: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; type?: string; cache?: string }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, type: res.headers['content-type'], cache: res.headers['cache-control'] }));
      });
      r.on('error', reject);
      r.end();
    });
  return { get };
}

const ownDist = () => {
  const own = tmp();
  writeFileSync(path.join(own, 'index.html'), '<title>Sable</title>own');
  return own;
};

describe('the stylesheet route', () => {
  it('serves the file, empty when missing, off, ignored or asking for the internet; never to another origin', async () => {
    const home = tmp();
    const { c, settings } = make(home);
    const { get } = await serve(ownDist(), c);
    let r = await get('/custom/styles.css');
    expect([r.status, r.body, r.type, r.cache]).toEqual([200, '', 'text/css; charset=utf-8', 'no-cache']);

    writeStyles(home, '.sidebar { width: 200px }');
    c.readStyles();
    r = await get('/custom/styles.css');
    expect(r.body).toBe('.sidebar { width: 200px }');
    expect((await get('/custom/styles.css', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await get('/custom/styles.css', { origin: 'http://evil.test' })).status).toBe(403);

    settings.customStyles = false;
    expect((await get('/custom/styles.css')).body).toBe('');
    settings.customStyles = undefined;

    writeStyles(home, '.a { background: url(https://example.com/x.png) }');
    c.readStyles();
    expect((await get('/custom/styles.css')).body).toBe('');
    expect(c.state().styles.blocked).toContain('https://example.com/x.png');

    const ignored = make(home, { ignore: true }).c;
    writeStyles(home, '.sidebar { width: 200px }');
    ignored.readStyles();
    expect(ignored.stylesheet()).toBe('');
    expect(ignored.state().ignored).toBe(true);
  });

  it('a change of the file moves the rev; reading the same file again does not', () => {
    const home = tmp();
    const { c } = make(home);
    const r0 = c.state().styles.rev;
    writeStyles(home, '.a{}');
    expect(c.readStyles()).toBe(true);
    const r1 = c.state().styles.rev;
    expect(r1).toBeGreaterThan(r0);
    c.readStyles();
    expect(c.state().styles.rev).toBe(r1);
  });

  it('watches the folder: a save is pushed with a new rev, without being asked', async () => {
    const home = tmp();
    const { c, events } = make(home, { watch: true });
    try {
      writeStyles(home, '.sidebar { width: 180px }');
      const deadline = Date.now() + 4000;
      while (!events.some((e) => e.styles.exists) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(events.at(-1)?.styles.exists).toBe(true);
      expect(c.stylesheet()).toBe('.sidebar { width: 180px }');
    } finally {
      c.dispose();
    }
  });
});

/** A workspace with a finished build in it, and a customizer that serves builds. */
function built(home: string, opts: Partial<ConstructorParameters<typeof Customizer>[0]> = {}) {
  const ws = path.join(home, 'custom', 'src');
  mkdirSync(path.join(ws, '.git'), { recursive: true });
  mkdirSync(path.join(ws, 'dist'), { recursive: true });
  writeFileSync(path.join(ws, 'dist', 'index.html'), '<title>Sable</title>mine');
  writeFileSync(path.join(home, BUILD_STATE_FILE), JSON.stringify({ builtFor: '0.3.0', builtAt: 1 }));
  let timer: (() => void) | undefined;
  const made = make(home, { serving: true, build: true, setTimer: (fn) => ((timer = fn), 1), clearTimer: () => (timer = undefined), ...opts });
  return { ...made, ws, fire: () => timer?.(), pending: () => !!timer };
}

describe('your build: served instead of the app’s own', () => {
  it('only once the person switched it on; the root is a function of it', async () => {
    const home = tmp();
    const own = ownDist();
    const { c, ws } = built(home);
    const { get } = await serve(own, c);
    expect((await get('/')).body).toContain('own');
    c.use(true);
    expect(c.root(own)).toBe(path.join(ws, 'dist'));
    expect((await get('/')).body).toContain('mine');
    expect((await get('/some/route')).body).toContain('mine');
    c.use(false);
    expect((await get('/')).body).toContain('own');
  });

  it('a rebuild nobody switched on is not served (an agent cannot swap the interface)', () => {
    const home = tmp();
    const own = ownDist();
    const { c, ws } = built(home);
    c.use(true);
    writeFileSync(path.join(ws, 'dist', 'index.html'), '<title>Sable</title>changed by someone');
    expect(c.root(own)).toBe(own);
    expect(c.state().build.serving).toBe(false);
  });

  it('made for another version: the app’s own interface, and the state says so', () => {
    const home = tmp();
    const { c } = built(home);
    c.use(true);
    const next = new Customizer({ home, version: '0.3.1', watch: false, serving: true, build: true, settings: () => DEFAULT_SETTINGS });
    const own = ownDist();
    expect(next.root(own)).toBe(own);
    expect(next.state().build).toMatchObject({ active: true, serving: false, builtFor: '0.3.0' });
    expect(() => next.use(true)).toThrow(/made for 0\.3\.0/);
  });

  it('ignored with --original, and not by the dev server', () => {
    const home = tmp();
    built(home).c.use(true);
    const own = ownDist();
    expect(new Customizer({ home, version: '0.3.0', watch: false, serving: true, build: true, ignore: true, settings: () => DEFAULT_SETTINGS }).root(own)).toBe(own);
    expect(new Customizer({ home, version: '0.3.0', watch: false, serving: false, settings: () => DEFAULT_SETTINGS }).root(own)).toBe(own);
  });
});

describe('your build: not in this version', () => {
  it('nothing offers it: not supported, never served, every step answers that it is not available', async () => {
    const home = tmp();
    const own = ownDist();
    // A workspace with a finished build that was switched on (an older run, or a hand-made file).
    const ws = path.join(home, 'custom', 'src');
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    mkdirSync(path.join(ws, 'dist'), { recursive: true });
    writeFileSync(path.join(ws, 'dist', 'index.html'), 'mine');
    writeFileSync(path.join(home, BUILD_STATE_FILE), JSON.stringify({ builtFor: '0.3.0', builtAt: 1 }));
    const on = new Customizer({ home, version: '0.3.0', watch: false, serving: true, build: true, settings: () => DEFAULT_SETTINGS });
    on.use(true);
    expect(on.serving()).toBe(true);
    const { calls, run } = fakeRunner(() => {});
    const { c } = make(home, { serving: true, runner: run });
    expect(c.state().build).toMatchObject({ supported: false, serving: false });
    expect(c.root(own)).toBe(own);
    const { get } = await serve(own, c);
    expect((await get('/')).body).toContain('own');
    await expect(c.setup()).rejects.toThrow(BUILD_OFF);
    await expect(c.build(true)).rejects.toThrow(BUILD_OFF);
    await expect(c.bring()).rejects.toThrow(BUILD_OFF);
    expect(() => c.use(true)).toThrow(BUILD_OFF);
    expect(calls).toEqual([]);
    expect(BUILD_SHIPS).toBe(false);
  });

  it('the bridge’s build methods answer the same', async () => {
    const home = tmp();
    const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    apps.push(app);
    registerCustom(app);
    for (const m of ['custom.setup', 'custom.build', 'custom.bring'] as const) await expect(app.call(m, {} as never)).rejects.toThrow(BUILD_OFF);
    await expect(app.call('custom.use', { on: true })).rejects.toThrow(BUILD_OFF);
  });
});

describe('the start watchdog', () => {
  it('a custom page that says it started keeps running', async () => {
    const home = tmp();
    const own = ownDist();
    const { c, pending } = built(home);
    c.use(true);
    const { get } = await serve(own, c);
    await get('/');
    expect(pending()).toBe(true);
    expect(c.ready()).toBe(true);
    expect(pending()).toBe(false);
    expect(c.state().build.serving).toBe(true);
  });

  it('one that does not is set aside after the time: the window reloads into the app’s own', async () => {
    const home = tmp();
    const own = ownDist();
    let ms = 0;
    const { c, fire } = built(home, { setTimer: (fn, t) => ((ms = t), (pendingFn = fn), 1) });
    let pendingFn: (() => void) | undefined;
    c.use(true);
    const reloads: string[] = [];
    c.onReload((why) => reloads.push(why));
    const { get } = await serve(own, c);
    await get('/');
    expect(ms).toBe(CUSTOM_READY_MS);
    void fire;
    pendingFn!();
    expect(reloads).toEqual(['fallback']);
    expect(c.state().build.failed?.reason).toMatch(/did not start/);
    expect(c.root(own)).toBe(own);
    expect((await get('/')).body).toContain('own');
    // The person tries again: switching on clears it.
    c.use(true);
    expect(c.state().build.failed).toBeUndefined();
  });

  it('the app’s own page starts no watchdog', async () => {
    const home = tmp();
    const { c, pending } = built(home);
    const { get } = await serve(ownDist(), c);
    await get('/');
    expect(pending()).toBe(false);
    expect(c.ready()).toBe(false);
  });
});

/** A runner that records every call and answers from `answer`; nothing real runs. */
function fakeRunner(answer: (cmd: string, args: string[], cwd: string) => Partial<RunResult> | void) {
  const calls: string[] = [];
  const run: CustomRunner = async (cmd, args, opts) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return { code: 0, stdout: '', stderr: '', ...(answer(cmd, args, opts.cwd) ?? {}) };
  };
  return { run, calls };
}

describe('your build: the workspace’s steps (fake runner)', () => {
  it('says in one line what the machine lacks', async () => {
    const home = tmp();
    const { run } = fakeRunner((cmd) => (cmd === 'pnpm' ? { code: 1 } : undefined));
    const { c } = make(home, { serving: true, build: true, runner: run });
    await expect(c.setup()).rejects.toThrow(/pnpm is missing: npm install -g pnpm/);
    expect(c.state().build.missing).toMatch(/pnpm/);
  });

  it('setup clones at the running version’s tag on a branch mine and installs; build switches on', async () => {
    const home = tmp();
    const ws = path.join(home, 'custom', 'src');
    const { run, calls } = fakeRunner((cmd, args) => {
      if (cmd === 'git' && args[0] === 'clone') mkdirSync(path.join(ws, '.git'), { recursive: true });
      if (cmd === 'pnpm' && args.includes('build')) {
        mkdirSync(path.join(ws, 'dist'), { recursive: true });
        writeFileSync(path.join(ws, 'dist', 'index.html'), 'built');
      }
    });
    const { c, events } = make(home, { serving: true, build: true, runner: run });
    const reloads: string[] = [];
    c.onReload((w) => reloads.push(w));
    await c.setup();
    expect(calls.filter((x) => !x.endsWith('--version'))).toEqual([
      `git clone --filter=blob:none --branch v0.3.0 https://github.com/Leonxlnx/sable.git ${ws}`,
      'git checkout -b mine',
      'pnpm install --frozen-lockfile',
    ]);
    expect(events.map((e) => e.build.step).filter(Boolean)).toEqual(['checking', 'cloning', 'installing']);
    expect(c.state().build).toMatchObject({ workspace: true, active: false });
    await c.build(true);
    expect(calls.at(-1)).toBe('pnpm exec vite build');
    expect(c.state().build).toMatchObject({ active: true, serving: true, builtFor: '0.3.0' });
    expect(reloads).toEqual(['switch']);
    expect(JSON.parse(readFileSync(path.join(home, BUILD_STATE_FILE), 'utf8')).index).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a failed build says why and switches nothing', async () => {
    const home = tmp();
    const { ws } = built(home);
    void ws;
    const { run } = fakeRunner((cmd) => (cmd === 'pnpm' ? { code: 1, stderr: 'error TS2304: Cannot find name x' } : undefined));
    const c = new Customizer({ home, version: '0.3.0', watch: false, serving: true, build: true, runner: run, settings: () => DEFAULT_SETTINGS });
    rmSync(path.join(home, 'custom', 'src', 'dist'), { recursive: true });
    await expect(c.build(true)).rejects.toThrow(/The build failed: error TS2304/);
    expect(c.state().build).toMatchObject({ active: false, error: expect.stringMatching(/TS2304/) });
  });

  it('bring: keeps uncommitted edits, rebases onto the new tag, installs when the lockfile changed, builds and switches', async () => {
    const home = tmp();
    built(home).c.use(true);
    const ws = path.join(home, 'custom', 'src');
    let lock = 'aaa';
    const { run, calls } = fakeRunner((cmd, args) => {
      if (cmd === 'git' && args[0] === 'status') return { stdout: ' M src/features/sidebar/Sidebar.tsx\n' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: `${lock}\n` };
      if (cmd === 'git' && args.includes('rebase')) lock = 'bbb';
      if (cmd === 'pnpm' && args.includes('build')) writeFileSync(path.join(ws, 'dist', 'index.html'), 'built for 0.3.1');
    });
    const c = new Customizer({ home, version: '0.3.1', watch: false, serving: true, build: true, runner: run, settings: () => DEFAULT_SETTINGS });
    const r = await c.bring();
    expect(r.conflict).toBeUndefined();
    expect(calls).toEqual([
      'git status --porcelain',
      'git add -A',
      'git -c user.name=Sable -c user.email=sable@localhost commit -m My changes',
      'git fetch --filter=blob:none origin refs/tags/v0.3.1:refs/tags/v0.3.1',
      'git rev-parse HEAD:pnpm-lock.yaml',
      'git -c user.name=Sable -c user.email=sable@localhost rebase --onto v0.3.1 v0.3.0 mine',
      'git rev-parse HEAD:pnpm-lock.yaml',
      'pnpm install --frozen-lockfile',
      'pnpm exec vite build',
    ]);
    expect(r.build).toMatchObject({ builtFor: '0.3.1', active: true, serving: true });
    expect(JSON.parse(readFileSync(path.join(home, BUILD_STATE_FILE), 'utf8')).base).toBe('v0.3.1');
  });

  it('bring: a conflict is aborted and becomes a message for the Customize chat', async () => {
    const home = tmp();
    built(home).c.use(true);
    const told: string[] = [];
    const { run, calls } = fakeRunner((cmd, args) => {
      if (cmd === 'git' && args.includes('rebase') && args.includes('--onto')) return { code: 1, stderr: 'CONFLICT (content): Merge conflict in src/features/sidebar/Sidebar.tsx' };
      if (cmd === 'git' && args[0] === 'diff') return { stdout: 'src/features/sidebar/Sidebar.tsx\n' };
    });
    const c = new Customizer({ home, version: '0.3.1', watch: false, serving: true, build: true, runner: run, settings: () => DEFAULT_SETTINGS, tell: async (t) => told.push(t) });
    const r = await c.bring();
    expect(r.conflict).toEqual(['src/features/sidebar/Sidebar.tsx']);
    expect(calls).toContain('git rebase --abort');
    expect(calls.some((x) => x.includes('vite build'))).toBe(false);
    expect(told).toEqual([conflictMessage('0.3.1', '0.3.0', ['src/features/sidebar/Sidebar.tsx'])]);
    expect(told[0]).toMatch(/^Bring my changes to 0\.3\.1/);
    // Still made for the old version: the app's own interface runs, and it can be tried again.
    expect(r.build).toMatchObject({ builtFor: '0.3.0', serving: false });
  });

  it('one step at a time', async () => {
    const home = tmp();
    built(home);
    let release!: () => void;
    const run: CustomRunner = () => new Promise((r) => (release = () => r({ code: 0, stdout: '', stderr: '' })));
    const c = new Customizer({ home, version: '0.3.0', watch: false, serving: true, build: true, runner: run, settings: () => DEFAULT_SETTINGS });
    const first = c.build(false);
    await expect(c.build(false)).rejects.toThrow(/already working/);
    release();
    await first;
  });
});

describe('the brief, only in the Customize chat', () => {
  const brief = customBrief({ dir: 'C:/data/custom', reference: 'C:/data/custom/reference', version: '0.3.0' });
  const ctx = { emit: () => {}, log: () => {}, settings: () => ({ ...DEFAULT_SETTINGS, generativeUi: false }), customBrief: () => brief };
  const meta = { cwd: process.cwd(), model: '', mode: 'default', options: { browserTab: false } };

  it('says where the reference is, styles first, the file, and the rules', () => {
    expect(brief).toContain('C:/data/custom/reference/CLAUDE.md');
    expect(brief).toContain('C:/data/custom/styles.css');
    expect(brief).toMatch(/write only inside C:\/data\/custom/);
    // Your build does not ship in this version: the brief never mentions one.
    expect(brief).not.toMatch(/build|Settings, Customize|branch mine/i);
    expect(brief).toMatch(/stylesheet only/);
    expect(customBrief({ dir: 'C:/d/custom', reference: 'C:/d/custom/reference', workspace: 'C:/d/custom/src', version: '0.3.0' })).not.toMatch(/C:\/d\/custom\/src/);
    // Its code is kept: switched on, the brief names the workspace again.
    expect(customBrief({ dir: 'C:/d/custom', reference: 'C:/d/custom/reference', workspace: 'C:/d/custom/src', version: '0.3.0', build: true })).toMatch(/never build, switch/);
    expect(customBrief({ dir: 'C:/d/custom', reference: 'C:/d/custom/reference', version: '0.3.0', build: true })).toMatch(/Settings, Customize/);
    // Short: it is paid for on every turn.
    expect(brief.length).toBeLessThan(2000);
  });

  it('Claude Code: appended to its system prompt for that chat only', () => {
    const p = new ClaudeProvider(ctx);
    const on = p.agentOptions({ ...meta, custom: true }, {}).systemPrompt as { append?: string };
    expect(on.append).toContain(brief);
    const off = p.agentOptions(meta, {}).systemPrompt as { append?: string };
    expect(JSON.stringify(off)).not.toContain('customize_sable');
  });

  it('Codex: in the developer instructions for that chat only', async () => {
    const p = new CodexProvider(ctx);
    (p as unknown as { client: () => Promise<unknown> }).client = async () => ({ request: async () => ({ config: {} }) });
    expect(await p.developerInstructions(process.cwd(), { options: {}, custom: true })).toContain(brief);
    expect(await p.developerInstructions(process.cwd(), { options: {} })).not.toContain('customize_sable');
  });
});

describe('the Customize chat', () => {
  it('one chat, kept, in the custom folder; a message goes to it; the reference is copied there', async () => {
    const home = tmp();
    const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    apps.push(app);
    registerCustom(app);
    const events: BridgeEvent[] = [];
    app.subscribe((e) => events.push(e));
    const snap = await app.call('custom.open', { provider: 'demo' });
    expect(snap.session).toMatchObject({ custom: true, chat: true, cwd: path.join(home, 'custom'), title: 'Customize Sable', titleSource: 'user' });
    expect(app.store.state.projects.some((p) => p.path === path.join(home, 'custom'))).toBe(false);
    const again = await app.call('custom.open', { text: 'make the sidebar narrower', provider: 'demo' });
    expect(again.session.id).toBe(snap.session.id);
    expect((await app.call('custom.state', {})).sessionId).toBe(snap.session.id);
    expect(existsSync(path.join(home, 'custom', 'reference', 'CLAUDE.md'))).toBe(true);
    expect(existsSync(path.join(home, 'custom', 'reference', 'styles', 'styles', 'tokens.css'))).toBe(true);
    // Switched off from the palette or Settings: the setting, and a new rev for the windows.
    const before = (await app.call('custom.state', {})).styles.rev;
    const after = await app.call('custom.original', {});
    await new Promise((r) => setTimeout(r, 10));
    expect(app.store.state.settings.customStyles).toBe(false);
    expect(after.styles.rev).toBeGreaterThan(before);
    expect(events.some((e) => e.type === 'custom.updated')).toBe(true);
  });
});
