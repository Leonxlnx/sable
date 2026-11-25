import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../server/app';
import { detectScripts, findLockfiles, makeTargets, packageScripts, pickManager, registerScripts, tomlTable } from '../server/services/scripts';
import { servingCommand } from '@shared/dev-url';
import { devServerUrls, devUrl, devUrlLabel, lastDevUrl } from '@/lib/dev-url';
import { scriptForCommand } from '@/features/rail/scripts-store';

let base = '';
const dir = (...parts: string[]) => {
  const p = path.join(base, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const write = (file: string, text: string) => writeFileSync(file, text);
const all = () => true;

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'sable-scripts-'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

// ───────────────────────────── package manager ─────────────────────────────

describe('package manager', () => {
  it('follows the lockfile, in the order pnpm, yarn, bun, npm', () => {
    expect(pickManager(['pnpm-lock.yaml'])).toBe('pnpm');
    expect(pickManager(['yarn.lock'])).toBe('yarn');
    expect(pickManager(['bun.lockb'])).toBe('bun');
    expect(pickManager(['bun.lock'])).toBe('bun');
    expect(pickManager(['package-lock.json'])).toBe('npm');
    expect(pickManager(['package-lock.json', 'yarn.lock'])).toBe('yarn');
    expect(pickManager(['bun.lock', 'pnpm-lock.yaml'])).toBe('pnpm');
  });

  it('falls back to the packageManager field, then npm', () => {
    expect(pickManager([], 'pnpm@9.1.0')).toBe('pnpm');
    expect(pickManager([], 'yarn@4.0.2+sha256.abc')).toBe('yarn');
    expect(pickManager([], 'cargo@1')).toBe('npm');
    expect(pickManager([], 42)).toBe('npm');
    expect(pickManager([])).toBe('npm');
    // A lockfile beats the field.
    expect(pickManager(['yarn.lock'], 'pnpm@9')).toBe('yarn');
  });

  it("finds a workspace root's lockfile above a package, and stops at a repository or outside a workspace", () => {
    const root = dir('mono');
    write(path.join(root, 'package.json'), '{"private":true}');
    write(path.join(root, 'pnpm-lock.yaml'), '');
    const pkg = dir('mono', 'packages', 'web');
    write(path.join(pkg, 'package.json'), '{}');
    // packages/ has no package.json: the walk stops there.
    expect(findLockfiles(pkg)).toBeNull();
    write(path.join(root, 'packages', 'package.json'), '{}');
    expect(findLockfiles(pkg)).toEqual({ dir: root, files: ['pnpm-lock.yaml'] });

    const repo = dir('repo-app');
    mkdirSync(path.join(repo, '.git'));
    write(path.join(repo, 'package.json'), '{}');
    expect(findLockfiles(repo)).toBeNull();
  });
});

// ───────────────────────────── detection ─────────────────────────────

describe('package.json scripts', () => {
  it('keeps file order, drops lifecycle hooks and a script’s own pre/post steps', () => {
    const pkg = {
      scripts: {
        dev: 'vite',
        predev: 'node gen.js',
        build: 'tsc && vite build',
        postbuild: 'node post.js',
        prepare: 'husky',
        postinstall: 'patch-package',
        preview: 'vite preview',
        'test:unit': 'vitest',
        'with space': 'echo hi',
        'bad"quote': 'echo no',
        empty: 42,
      },
    };
    expect(packageScripts(pkg, 'pnpm').map((s) => [s.name, s.run])).toEqual([
      ['dev', 'pnpm run dev'],
      ['build', 'pnpm run build'],
      // "preview" is a script of its own: no "view" script exists.
      ['preview', 'pnpm run preview'],
      ['test:unit', 'pnpm run test:unit'],
      ['with space', 'pnpm run "with space"'],
    ]);
    expect(packageScripts(pkg, 'npm')[0]).toEqual({ name: 'dev', command: 'vite', run: 'npm run dev', source: 'package' });
    expect(packageScripts({ scripts: ['x'] }, 'npm')).toEqual([]);
    expect(packageScripts(null, 'npm')).toEqual([]);
  });
});

describe('Makefile targets', () => {
  it('lists plain targets with their first recipe line, and nothing special, pattern or variable', () => {
    const text = [
      'GO ?= go',
      'BIN := bin/app',
      '.PHONY: run test',
      '',
      '# Start the server',
      'run: build',
      '\t@echo starting',
      '\t$(GO) run ./cmd/server',
      '',
      'test lint:',
      '\t-$(GO) test ./...',
      '',
      '%.o: %.c',
      '\tcc -c $<',
      '$(BIN): main.go',
      '\tgo build -o $(BIN)',
      'clean:',
      '\trm -rf bin',
      'FOO = bar:baz',
      'deps::',
      '\tgo mod download',
    ].join('\n');
    expect(makeTargets(text)?.map((t) => [t.name, t.command, t.run])).toEqual([
      ['run', 'echo starting', 'make run'],
      ['test', '$(GO) test ./...', 'make test'],
      ['lint', '$(GO) test ./...', 'make lint'],
      ['clean', 'rm -rf bin', 'make clean'],
    ]);
    expect(makeTargets('X := 1\n%.o: %.c\n\tcc\n')).toBeNull();
  });
});

describe('pyproject.toml tables', () => {
  it('reads plain entries of one table, inline tables by their callable', () => {
    const text = [
      '[project]',
      'name = "app"',
      '',
      '[project.scripts]',
      'serve = "app.server:main"',
      "'my-cli' = 'app.cli:run'  # a comment",
      'weird = { callable = "app.w:go" }',
      'skip = 3',
      '',
      '[tool.poetry.scripts]',
      'lint = "app.lint:main"',
    ].join('\n');
    expect(tomlTable(text, 'project.scripts')).toEqual([
      ['serve', 'app.server:main'],
      ['my-cli', 'app.cli:run'],
      ['weird', 'app.w:go'],
    ]);
    expect(tomlTable(text, 'tool.poetry.scripts')).toEqual([['lint', 'app.lint:main']]);
    expect(tomlTable(text, 'tool.pdm.scripts')).toBeNull();
  });
});

describe('detectScripts', () => {
  it('reads every source of a folder, each run its own way', () => {
    const d = dir('full');
    write(path.join(d, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js', test: 'vitest' } }));
    write(path.join(d, 'yarn.lock'), '');
    write(path.join(d, 'Makefile'), 'up:\n\tdocker compose up\n');
    write(path.join(d, 'pyproject.toml'), '[project.scripts]\napi = "api.main:run"\n[tool.poetry.scripts]\nworker = "api.worker:main"\n');
    write(path.join(d, 'uv.lock'), '');
    const r = detectScripts(d, { has: all });
    expect(r.manager).toBe('yarn');
    expect(r.scripts.map((s) => `${s.source} ${s.name}: ${s.run}`)).toEqual([
      'package dev: yarn run dev',
      'package test: yarn run test',
      'make up: make up',
      'python api: uv run api',
      'python worker: poetry run worker',
    ]);
    expect(r.skipped).toEqual([]);
  });

  it('says what it left out and why', () => {
    const d = dir('skips');
    write(path.join(d, 'package.json'), '{ "scripts": { "dev": "vite", } ');
    write(path.join(d, 'Makefile'), 'all:\n\techo hi\n');
    write(path.join(d, 'pyproject.toml'), '[project.scripts]\napi = "api.main:run"\n');
    const r = detectScripts(d, { has: (p) => p !== 'make' });
    expect(r.manager).toBe('npm');
    expect(r.scripts).toEqual([]);
    expect(r.skipped).toEqual(['package.json: not valid JSON', 'Makefile: make is not installed', 'pyproject.toml: its scripts need uv, Poetry or PDM (no lockfile)']);

    const e = dir('plain');
    expect(detectScripts(e, { has: all })).toMatchObject({ manager: null, scripts: [], skipped: [] });
  });
});

describe('project.scripts', () => {
  let app: App;
  beforeAll(() => {
    app = new App({ home: path.join(base, 'store'), providers: [], quiet: true });
    registerScripts(app);
  });
  afterAll(async () => {
    await app.dispose();
  });

  it('answers from the files, again only when they change', async () => {
    const d = dir('rpc');
    write(path.join(d, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    write(path.join(d, 'pnpm-lock.yaml'), '');
    const a = await app.call('project.scripts', { cwd: d });
    expect(a.scripts.map((s) => s.run)).toEqual(['pnpm run dev']);
    const b = await app.call('project.scripts', { cwd: d });
    expect(b).toBe(a);
    // A change of size is a change, whatever the clock's resolution.
    write(path.join(d, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }));
    const c = await app.call('project.scripts', { cwd: d });
    expect(c.sig).not.toBe(a.sig);
    expect(c.scripts.map((s) => s.name)).toEqual(['dev', 'build']);
    await expect(app.call('project.scripts', { cwd: path.join(base, 'missing') })).rejects.toThrow(/Folder not found/);
  });
});

// ───────────────────────────── dev server addresses ─────────────────────────────

describe('dev server addresses', () => {
  const ESC = '\u001b';

  it('recognizes plain server and watcher commands without reading script arguments as commands', () => {
    for (const cmd of ['npm run dev', 'pnpm serve', 'yarn start', 'bun run preview', 'npm run watch', 'vite', 'npx vite --host', 'cd web && npm run dev', 'next dev', 'astro dev', 'nuxt dev', 'webpack serve', 'http-server .', 'python -m http.server 3311', 'php -S localhost:8080', 'tsc --watch', 'tsc -p . -w', 'nodemon index.js', 'tail -f log', 'pnpm test --watch']) {
      expect(servingCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ['pnpm test', 'npm install', 'vite build', 'vite --debug build', 'next build', 'npm run devtools', 'echo vite', 'npm install nodemon', 'node dev.js', 'vite --version', 'tsc -p watch', 'tail -n 2 log']) {
      expect(servingCommand(cmd), cmd).toBe(false);
    }
  });

  it('reads the usual banners', () => {
    const vite = `\n  ${ESC}[32m${ESC}[1mVITE${ESC}[22m v5.2.0${ESC}[39m  ready in 312 ms\n\n  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m\n  ➜  Network: use --host to expose\n  ➜  Inspect: http://localhost:5173/__inspect/\n`;
    expect(devServerUrls(vite)).toEqual([{ url: 'http://localhost:5173/', label: 'localhost:5173' }]);
    expect(lastDevUrl('  ▲ Next.js 14.2.3\n  - Local:        http://localhost:3000\n  - Network:      http://192.168.1.20:3000\n')).toEqual({ url: 'http://localhost:3000/', label: 'localhost:3000' });
    expect(lastDevUrl('<i> [webpack-dev-server] Project is running at:\n<i> [webpack-dev-server] Loopback: http://localhost:8080/, http://[::1]:8080/\n')?.label).toBe('localhost:8080');
    // Rails: both loopback names are the same server.
    expect(devServerUrls('* Listening on http://127.0.0.1:3000\n* Listening on http://[::1]:3000\nUse Ctrl-C to stop\n')).toEqual([{ url: 'http://127.0.0.1:3000/', label: 'localhost:3000' }]);
    expect(lastDevUrl('Starting development server at http://127.0.0.1:8000/\nQuit the server with CTRL-BREAK.\n')?.url).toBe('http://127.0.0.1:8000/');
    expect(lastDevUrl(' * Running on http://127.0.0.1:5000\nPress CTRL+C to quit\n')?.label).toBe('localhost:5000');
    expect(lastDevUrl('INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)\n')?.url).toBe('http://127.0.0.1:8000/');
    // Every interface means localhost to a browser.
    expect(lastDevUrl('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...\n')).toEqual({ url: 'http://localhost:8000/', label: 'localhost:8000' });
    expect(lastDevUrl('Serving HTTP on :: port 8000 (http://[::]:8000/) ...\n')?.url).toBe('http://localhost:8000/');
    expect(lastDevUrl('** Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/ **\n')?.label).toBe('localhost:4200');
    expect(lastDevUrl('   INFO  Server running on [http://127.0.0.1:8000].\n')?.url).toBe('http://127.0.0.1:8000/');
    // Gatsby and CRA print the address on a line of its own.
    expect(lastDevUrl('You can now view app in the browser.\n\n  http://localhost:8000/\n')?.label).toBe('localhost:8000');
    // A progress line rewritten with carriage returns ends on the banner.
    expect(lastDevUrl('starting…\r  ➜  Local:   http://localhost:4321/\n')?.label).toBe('localhost:4321');
  });

  it('ignores errors, requests and addresses without a port', () => {
    expect(devServerUrls('Error: connect ECONNREFUSED http://127.0.0.1:5432\n')).toEqual([]);
    expect(devServerUrls('FetchError: request to http://localhost:3000/api failed, reason: connect ECONNREFUSED\n')).toEqual([]);
    expect(devServerUrls('GET http://localhost:3000/api/users 200 in 12ms\n')).toEqual([]);
    expect(devServerUrls('Server running at http://localhost:3000\n', 'curl -s http://localhost:3000')).toEqual([]);
    expect(devServerUrls('Local: http://localhost/\nSee https://vitejs.dev/guide\n')).toEqual([]);
    expect(lastDevUrl('Local: http://shop.localhost.example.com:3311')).toBeNull();
    expect(lastDevUrl('Local: http://localhost:123456')).toBeNull();
    expect(lastDevUrl('Local: http://localhost:80/')?.label).toBe('localhost:80');
    expect(lastDevUrl(undefined)).toBeNull();
    expect(lastDevUrl('nothing to see')).toBeNull();
  });

  it('counts any local address a server command prints, and orders servers by their latest line', () => {
    expect(devServerUrls('GET http://localhost:3000/api 200\n')).toEqual([]);
    expect(devServerUrls('GET http://localhost:3000/api 200\n', 'pnpm run dev')).toEqual([{ url: 'http://localhost:3000/api', label: 'localhost:3000' }]);
    const two = 'api  | listening on http://localhost:4000\nweb  | ➜ Local: http://localhost:5173/\napi  | listening on http://localhost:4000\n';
    expect(devServerUrls(two).map((u) => u.label)).toEqual(['localhost:5173', 'localhost:4000']);
    expect(lastDevUrl(two)?.label).toBe('localhost:4000');
  });

  it('reads a long output at its start and its end', () => {
    const noise = 'GET /api/items 200 in 3ms\n'.repeat(8000);
    expect(lastDevUrl(`  ➜  Local:   http://localhost:5173/\n${noise}`)?.label).toBe('localhost:5173');
    expect(lastDevUrl(`${noise}  ➜  Local:   http://localhost:5174/\n`)?.label).toBe('localhost:5174');
    expect(lastDevUrl(`${noise}  ➜  Local:   http://localhost:9999/\n${noise}`)).toBeNull();
  });

  it('names addresses plainly', () => {
    expect(devUrl('http://127.0.0.1:8000/).')).toEqual({ url: 'http://127.0.0.1:8000/', label: 'localhost:8000' });
    expect(devUrl('https://localhost:5173/app/')).toEqual({ url: 'https://localhost:5173/app/', label: 'localhost:5173' });
    expect(devUrl('http://shop.localhost/cart')).toEqual({ url: 'http://shop.localhost/cart', label: 'shop.localhost' });
    expect(devUrl('http://localhost/')).toBeNull();
    expect(devUrlLabel('http://[::1]:8080/x')).toBe('localhost:8080');
    expect(devUrlLabel('http://example.com/a')).toBe('example.com');
  });
});

describe('typed commands that are scripts', () => {
  const list = (manager: 'npm' | 'pnpm') => ({
    cwd: '/x',
    manager,
    skipped: [],
    sig: '',
    scripts: [
      { name: 'dev', command: 'vite', run: `${manager} run dev`, source: 'package' as const },
      { name: 'start', command: 'node .', run: `${manager} run start`, source: 'package' as const },
      { name: 'up', command: 'docker compose up', run: 'make up', source: 'make' as const },
    ],
  });

  it('matches the run command, and the short forms each manager takes', () => {
    expect(scriptForCommand(list('pnpm'), 'pnpm run dev')?.name).toBe('dev');
    expect(scriptForCommand(list('pnpm'), '  pnpm   dev ')?.name).toBe('dev');
    expect(scriptForCommand(list('npm'), 'npm dev')).toBeUndefined();
    expect(scriptForCommand(list('npm'), 'npm start')?.name).toBe('start');
    expect(scriptForCommand(list('npm'), 'make up')?.name).toBe('up');
    expect(scriptForCommand(list('npm'), 'pnpm run dev')).toBeUndefined();
    expect(scriptForCommand(undefined, 'npm start')).toBeUndefined();
  });
});
