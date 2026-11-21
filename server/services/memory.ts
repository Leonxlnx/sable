import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MemoryFile, ProviderId } from '../../shared/protocol';
import type { App } from '../app';

export const MEMORY_NAMES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);

function locations(cwd: string, provider: ProviderId, home: string): Omit<MemoryFile, 'exists'>[] {
  const dir = path.resolve(cwd);
  if (provider === 'codex') {
    return [
      { path: path.join(home, '.codex', 'AGENTS.md'), scope: 'user' },
      { path: path.join(dir, 'AGENTS.md'), scope: 'project' },
    ];
  }
  if (provider === 'opencode') {
    return [
      { path: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'AGENTS.md'), scope: 'user' },
      { path: path.join(dir, 'AGENTS.md'), scope: 'project' },
    ];
  }
  // 'claude' and 'demo'
  return [
    { path: path.join(home, '.claude', 'CLAUDE.md'), scope: 'user' },
    { path: path.join(dir, 'CLAUDE.md'), scope: 'project' },
    { path: path.join(dir, '.claude', 'CLAUDE.md'), scope: 'project' },
    { path: path.join(dir, 'CLAUDE.local.md'), scope: 'local' },
  ];
}

export async function memoryList(cwd: string, provider: ProviderId, home = os.homedir()): Promise<MemoryFile[]> {
  return Promise.all(
    locations(cwd, provider, home).map(async (loc): Promise<MemoryFile> => {
      try {
        const content = await readFile(loc.path, 'utf8');
        return { ...loc, exists: true, content };
      } catch {
        return { ...loc, exists: false };
      }
    }),
  );
}

export async function memoryWrite(p: string, content: string): Promise<{ ok: boolean }> {
  const file = path.resolve(p);
  const name = path.basename(file);
  if (!MEMORY_NAMES.has(name)) {
    throw new Error(`Refusing to write ${file}: only CLAUDE.md, CLAUDE.local.md or AGENTS.md can be edited here`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return { ok: true };
}

export function registerMemory(app: App, opts: { home?: string } = {}) {
  const home = opts.home ?? os.homedir();
  app.register('memory.list', ({ cwd, provider }) => memoryList(cwd, provider, home));
  app.register('memory.write', ({ path: p, content }) => memoryWrite(p, content));
}
