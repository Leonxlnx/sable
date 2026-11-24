/**
 * The composer's still side, second design pass: home starts on the folder last worked in, a first
 * send with no folder answers at the folder chip, the strips are one stack with the pane.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../shared/protocol';
import { lastFolder } from '../src/features/home/last-folder';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const meta = (id: string, cwd: string, updatedAt: number, more: Partial<SessionMeta> = {}) => ({ id, cwd, updatedAt, createdAt: 0, ...more }) as SessionMeta;

describe('home starts on the folder the person last worked in', () => {
  it('is the folder of the chat changed most recently', () => {
    expect(lastFolder({ a: meta('a', 'D:/one', 10), b: meta('b', 'D:/two', 30), c: meta('c', 'D:/three', 20) })).toBe('D:/two');
  });

  it('skips chats with no folder of their own, the Customize chat and archived chats', () => {
    const s = {
      a: meta('a', 'D:/one', 10),
      chat: meta('chat', 'C:/sable/chats/x', 40, { chat: true }),
      custom: meta('custom', 'C:/sable/custom', 50, { custom: true }),
      old: meta('old', 'D:/archived', 60, { archived: true }),
    };
    expect(lastFolder(s)).toBe('D:/one');
  });

  it('counts a chat in a lane for the folder it was started in, not its worktree', () => {
    const lane = { folder: 'D:/repo/app', root: 'D:/repo', path: 'C:/sable/lanes/x', branch: 'sable/x', base: 'abc', createdAt: 0 };
    expect(lastFolder({ a: meta('a', 'C:/sable/lanes/x', 10, { lane }) })).toBe('D:/repo/app');
  });

  it('is nothing when nothing says where the person works', () => {
    expect(lastFolder({})).toBeNull();
    expect(lastFolder({ chat: meta('chat', 'C:/x', 1, { chat: true }) })).toBeNull();
  });

  it('keeps a folder the way home named, and "No folder"', () => {
    const src = read('src/features/home/Home.tsx');
    expect(src).toMatch(/if \(s\.ui\.homeChat \|\| named\) return;/);
    expect(src).toMatch(/named = s\.ui\.homeCwd !== prev\.ui\.homeCwd \|\| s\.ui\.homeChat !== prev\.ui\.homeChat;/);
  });
});

describe('a first send with no folder answers at the folder chip', () => {
  it('leaves nothing in the air: the menu opens before the words leave the field', () => {
    const src = read('src/features/composer/Composer.tsx');
    const guard = src.indexOf("openComposerMenu('folder');");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(src.indexOf('const flight = flew ? launchFlight('));
    expect(guard).toBeLessThan(src.indexOf("if (ta) ta.value = '';"));
  });

  it('is amber only once a send waited on it, a plain chip at rest', () => {
    const css = read('src/features/composer/composer.css');
    expect(css).not.toMatch(/\.hc\[data-missing\][^{]*\{[^}]*--amber/);
    expect(css).toMatch(/\.hc\[data-asked\] \{\n  color: var\(--amber\);/);
  });
});

describe('the strips above the composer are one stack with the pane', () => {
  it('the task strip is the composer’s own, the farthest of its stack, never the prompt dock’s', () => {
    const composer = read('src/features/composer/Composer.tsx');
    expect(composer.indexOf('<TaskSlot sessionId={sessionId} />')).toBeLessThan(composer.indexOf('<UntilStrip sessionId={sessionId} />'));
    expect(read('src/features/prompts/PromptDock.tsx')).not.toMatch(/TaskStrip|data-slot="tasks"/);
    expect(read('src/features/prompts/TaskStrip.tsx')).toMatch(/className="us-slot" data-slot="tasks"/);
    // Tucked behind the next layer with the pane's corners and its rim.
    expect(read('src/features/prompts/prompts.css')).toMatch(/\.ts \{\n  position: relative;\n  padding-bottom: 20px;\n  border-radius: var\(--r-pane\) var\(--r-pane\) 0 0;/);
    expect(read('src/features/composer/until.css')).toMatch(/\.us::before,\n\.ts::before,\n\.cq::before \{/);
  });

  it('the queue tray names its rows with a word and no number', () => {
    const tray = read('src/features/composer/QueueTray.tsx');
    expect(tray).not.toMatch(/cq-count|<Roll/);
    expect(tray).toMatch(/<span className="cq-title">Queued<\/span>/);
  });
});
