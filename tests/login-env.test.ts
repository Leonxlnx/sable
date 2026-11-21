/**
 * The login shell's PATH for a desktop app started from Finder (server/util/login-env.ts): picking
 * the value out of a noisy shell, merging without duplicates, and a shell that fails or stalls.
 */
import { describe, expect, it } from 'vitest';
import { fixPathFromLoginShell, mergePath, parseLoginPath, wellKnownDirs } from '../server/util/login-env';

describe('parseLoginPath', () => {
  it('takes the value between the markers, whatever the profile printed around it', () => {
    const out = 'Welcome back!\nnvm: using node 22\n__SABLE_PATH_START__/opt/homebrew/bin:/usr/bin__SABLE_PATH_END__\nbye\n';
    expect(parseLoginPath(out)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('uses the last pair when a profile prints the markers itself', () => {
    expect(parseLoginPath('__SABLE_PATH_START__old__SABLE_PATH_END____SABLE_PATH_START__/a:/b__SABLE_PATH_END__')).toBe('/a:/b');
  });

  it('refuses a missing, empty or broken answer', () => {
    expect(parseLoginPath('')).toBeUndefined();
    expect(parseLoginPath('__SABLE_PATH_START____SABLE_PATH_END__')).toBeUndefined();
    expect(parseLoginPath('__SABLE_PATH_START__/a:/b')).toBeUndefined();
    expect(parseLoginPath('__SABLE_PATH_START__/a\n/b__SABLE_PATH_END__')).toBeUndefined();
  });
});

describe('mergePath', () => {
  it('keeps the first list in front and adds only what is new', () => {
    expect(mergePath('/a:/b', '/b:/c', undefined, '/a:/d')).toBe('/a:/b:/c:/d');
  });

  it('drops empty entries', () => {
    expect(mergePath('/a::/b:', ':/c')).toBe('/a:/b:/c');
  });
});

describe('fixPathFromLoginShell', () => {
  const home = '/Users/me';
  const present = new Set(['/bin/zsh', '/opt/homebrew/bin', '/Users/me/.local/bin']);
  const exists = (p: string) => present.has(p);

  it('does nothing on Windows', async () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows' };
    expect(await fixPathFromLoginShell({ platform: 'win32', env })).toBeUndefined();
    expect(env.PATH).toBe('C:\\Windows');
  });

  it('puts the shell PATH in front of the bare launchd one and adds tool folders that exist', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' };
    const path = await fixPathFromLoginShell({ platform: 'darwin', env, exists, home, ask: async () => '/Users/me/.nvm/bin:/usr/bin' });
    expect(path).toBe('/Users/me/.nvm/bin:/usr/bin:/bin:/opt/homebrew/bin:/Users/me/.local/bin');
    expect(env.PATH).toBe(path);
  });

  it('still adds the tool folders when the shell cannot be asked', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    const path = await fixPathFromLoginShell({ platform: 'darwin', env, exists, home, ask: async () => undefined });
    expect(path).toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/me/.local/bin');
  });

  it('does not ask a shell that is not there', async () => {
    let asked = false;
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', SHELL: '/nowhere/zsh' };
    await fixPathFromLoginShell({ platform: 'darwin', env, exists, home, ask: async () => ((asked = true), '/x') });
    expect(asked).toBe(false);
    expect(env.PATH).toBe('/usr/bin:/opt/homebrew/bin:/Users/me/.local/bin');
  });
});

describe('wellKnownDirs', () => {
  it('covers Homebrew on both chips', () => {
    const d = wellKnownDirs('/Users/me');
    expect(d).toContain('/opt/homebrew/bin');
    expect(d).toContain('/usr/local/bin');
  });
});
