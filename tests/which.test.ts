/**
 * Review wave 8, finding 3: a tool Sable runs inside a project folder (git, gh, the terminal's
 * shell) never comes from that folder. On Windows a bare name is looked up in the current
 * directory first, and a relative PATH entry reads against it anywhere.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../server/services/git';
import { shellFor, windowsPowerShell } from '../server/services/term';
import { mergePath } from '../server/util/login-env';
import { findProgram, inside, trustedPathDirs } from '../server/util/which';

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('trusted PATH entries', () => {
  it('keeps absolute entries only, and none inside the working folder', () => {
    const value = ['.', '', 'bin', 'C:bin', '\\tools', 'C:\\Git\\cmd', '"C:\\Program Files\\GitHub CLI"', 'D:\\repo\\node_modules\\.bin', 'd:\\REPO'].join(';');
    expect(trustedPathDirs(value, 'win32', ['D:\\repo'])).toEqual(['C:\\Git\\cmd', 'C:\\Program Files\\GitHub CLI']);
    expect(trustedPathDirs('.:bin::/usr/bin:/work/app/bin:/opt/homebrew/bin', 'darwin', ['/work/app'])).toEqual(['/usr/bin', '/opt/homebrew/bin']);
  });

  it('tells a folder inside another apart from a neighbour with the same prefix', () => {
    expect(inside('D:\\repo', 'd:\\Repo\\bin', 'win32')).toBe(true);
    expect(inside('D:\\repo', 'D:\\repo2\\bin', 'win32')).toBe(false);
    expect(inside('/work/app', '/work/app-tools', 'linux')).toBe(false);
  });

  it('drops the relative entries a login shell reports on a Mac', () => {
    expect(mergePath('.:/opt/homebrew/bin', 'bin:/usr/bin')).toBe('/opt/homebrew/bin:/usr/bin');
  });
});

describe('finding a program', () => {
  it('never picks a gh.exe in the repository, even with "." or the repository on PATH', () => {
    const files = new Set(['D:\\repo\\gh.exe', 'C:\\gh\\gh.exe', 'D:\\repo\\tools\\git.exe']);
    const isProgram = (f: string) => files.has(f);
    const env = { Path: '.;D:\\repo;D:\\repo\\tools;C:\\gh' };
    expect(findProgram('gh', { platform: 'win32', env, outside: ['D:\\repo'], isProgram, real: (f) => f })).toBe('C:\\gh\\gh.exe');
    expect(findProgram('git', { platform: 'win32', env, outside: ['D:\\repo'], isProgram, real: (f) => f })).toBeNull();
  });

  it('takes only a native program on Windows, never a .cmd that needs a shell', () => {
    const files = new Set(['C:\\shims\\gh.cmd', 'C:\\gh\\gh.exe']);
    expect(findProgram('gh', { platform: 'win32', env: { Path: 'C:\\shims;C:\\gh' }, isProgram: (f) => files.has(f), real: (f) => f })).toBe('C:\\gh\\gh.exe');
  });

  it('skips a PATH entry that is a link into the repository', () => {
    const files = new Set(['/home/me/bin/git', '/usr/bin/git']);
    const real = (f: string) => (f.startsWith('/home/me/bin') ? f.replace('/home/me/bin', '/work/app/.bin') : f);
    expect(findProgram('git', { platform: 'linux', env: { PATH: '/home/me/bin:/usr/bin' }, outside: ['/work/app'], isProgram: (f) => files.has(f), real })).toBe('/usr/bin/git');
  });
});

describe.runIf(process.platform === 'win32')('a repository that ships its own git.exe (Windows)', () => {
  it('runs the git on PATH, not the one in the folder', async () => {
    const stand = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe');
    if (!existsSync(stand)) return;
    const repo = mkdtempSync(path.join(tmpdir(), 'sable-which-'));
    made.push(repo);
    mkdirSync(path.join(repo, 'sub'));
    // hostname.exe prints the machine's name: if it ran as git, the answer would not be git's.
    copyFileSync(stand, path.join(repo, 'git.exe'));
    copyFileSync(stand, path.join(repo, 'sub', 'git.exe'));
    // Some shells set this opt-out (it stops the lookup in the current directory); people's machines do not.
    const optOut = process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    try {
      for (const cwd of [repo, path.join(repo, 'sub')]) {
        const r = await runGit(cwd, ['--version']);
        expect(r.stdout).toMatch(/^git version/);
      }
    } finally {
      if (optOut !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = optOut;
    }
  });

  it('starts the terminal\'s PowerShell by its full path', () => {
    expect(path.win32.isAbsolute(windowsPowerShell())).toBe(true);
    expect(windowsPowerShell({ SystemRoot: '.\\evil' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(path.win32.isAbsolute(shellFor('echo hi').cmd)).toBe(true);
  });
});
