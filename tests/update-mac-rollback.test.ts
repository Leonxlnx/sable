/**
 * Review wave 8, finding 25: the Mac updater's script must never delete the only app bundle left.
 * When the new bundle cannot be moved into place and the old one cannot be moved back either, the
 * old one stays in the work folder and Finder is asked to show it. Run with a POSIX sh (the
 * system's on a Mac or Linux, Git's on Windows) against made-up app folders; `mv` is a stand-in
 * that fails for the chosen target, ditto and open are stubs.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAC_INSTALL_SCRIPT } from '../server/services/update-mac';

function findSh(): string | null {
  if (process.platform !== 'win32') return existsSync('/bin/sh') ? '/bin/sh' : null;
  for (const p of ['C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe']) if (existsSync(p)) return p;
  return null;
}
const sh = findSh();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A path as the shell takes it (forward slashes). */
const p = (s: string) => s.replace(/\\/g, '/');
/** A folder as a PATH entry inside the shell (Git's sh on Windows wants /c/..., a colon separates entries). */
const msys = (s: string) => (process.platform === 'win32' ? p(s).replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`) : s);

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sable-mac-rollback-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  // Unpacks a sound new bundle.
  stub('ditto', 'mkdir -p "$4/Sable.app/Contents/MacOS" && touch "$4/Sable.app/Contents/Info.plist" && echo new > "$4/Sable.app/version"');
  stub('xattr', 'exit 0');
  stub('open', 'echo "$*" >> "$OPENED"');
  // mv that refuses to move anything onto $FAIL_TO; every other move is the real one.
  const realMv = spawnSync(sh!, ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim();
  // With FAIL_ONCE set, only the first such move fails (a marker file remembers it).
  stub(
    'mv',
    `for a; do last="$a"; done\nif [ -n "$FAIL_TO" ] && [ "$last" = "$FAIL_TO" ]; then\n  if [ -z "$FAIL_ONCE" ] || [ ! -e "$FAIL_ONCE" ]; then [ -n "$FAIL_ONCE" ] && touch "$FAIL_ONCE"; exit 1; fi\nfi\nexec "${realMv}" "$@"`,
  );
  const app = path.join(dir, 'Sable.app');
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), '');
  writeFileSync(path.join(app, 'version'), 'old\n');
  const opened = path.join(dir, 'opened');
  const run = (failTo?: string, once = false) =>
    spawnSync(sh!, ['-c', `PATH="$STUBS:$PATH"; export PATH
${MAC_INSTALL_SCRIPT}`, 'x', '999999', p(path.join(dir, 'Sable.zip')), p(app)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        STUBS: msys(bin),
        SABLE_DITTO: p(path.join(bin, 'ditto')),
        SABLE_OPEN: p(path.join(bin, 'open')),
        SABLE_XATTR: p(path.join(bin, 'xattr')),
        OPENED: p(opened),
        FAIL_TO: failTo ?? '',
        FAIL_ONCE: once ? p(path.join(dir, 'failed-once')) : '',
      },
    });
  const said = () => (existsSync(opened) ? readFileSync(opened, 'utf8').trim() : '');
  const work = () => readdirSync(dir).filter((f) => f.startsWith('.sable-update'));
  return { dir, app, run, said, work };
}

describe.skipIf(!sh)('the Mac updater when moving fails', { timeout: 60_000 }, () => {
  it('the new bundle cannot go in and the old one cannot come back: the old one is kept and shown', () => {
    const h = setup();
    // Every move onto the app's place fails: the new bundle's and the old one's way back.
    h.run(p(h.app));
    expect(existsSync(h.app)).toBe(false);
    const work = h.work();
    expect(work).toHaveLength(1);
    const kept = path.join(h.dir, work[0], 'previous.app');
    expect(readFileSync(path.join(kept, 'version'), 'utf8').trim()).toBe('old');
    expect(h.said()).toBe(`-R ${p(kept)}`);
  });

  it('the new bundle cannot go in but the old one comes back: it is reopened and nothing is left over', () => {
    const h = setup();
    h.run(p(h.app), true);
    expect(readFileSync(path.join(h.app, 'version'), 'utf8').trim()).toBe('old');
    expect(h.work()).toEqual([]);
    expect(h.said()).toBe(p(h.app));
  });

  it('nothing fails: the new bundle is in place and the old one is gone', () => {
    const h = setup();
    h.run();
    expect(readFileSync(path.join(h.app, 'version'), 'utf8').trim()).toBe('new');
    expect(h.work()).toEqual([]);
    expect(h.said()).toBe(p(h.app));
  });
});
