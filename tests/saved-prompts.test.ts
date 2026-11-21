/** Saved prompts (server/services/prompts.ts): kept in their own file under the data folder, in the person's order, pushed to windows when they change. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { cleanName, MAX_NAME, nameFromText, PromptStore, PROMPTS_FILE, registerPrompts } from '../server/services/prompts';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const tmp = () => {
  const h = mkdtempSync(path.join(tmpdir(), 'sable-prompts-'));
  homes.push(h);
  return h;
};

describe('the prompt store', () => {
  it('saves, renames, edits, reorders and deletes, and keeps it all on disk', () => {
    const dir = tmp();
    const pushed: string[][] = [];
    const store = new PromptStore(dir, (list) => pushed.push(list.map((p) => p.name)));
    expect(store.all()).toEqual([]);
    expect(existsSync(path.join(dir, PROMPTS_FILE))).toBe(false);

    const a = store.add('Review', 'Review the diff for bugs.\r\n\r\n');
    const b = store.add('  Tests\nfirst ', 'Write the tests first.');
    expect(a.text).toBe('Review the diff for bugs.');
    expect(b.name).toBe('Tests first');
    // A new prompt goes first.
    expect(store.all().map((p) => p.name)).toEqual(['Tests first', 'Review']);

    const renamed = store.update(a.id, { name: 'Review the diff' });
    expect(renamed.name).toBe('Review the diff');
    expect(renamed.text).toBe(a.text);
    expect(store.update(a.id, { text: 'Review it twice.' }).text).toBe('Review it twice.');
    // An emptied name keeps the old one; an emptied text is refused.
    expect(store.update(a.id, { name: '   ' }).name).toBe('Review the diff');
    expect(() => store.update(a.id, { text: '  ' })).toThrow();
    expect(() => store.update('nope', { name: 'x' })).toThrow();

    expect(store.reorder([a.id]).map((p) => p.id)).toEqual([a.id, b.id]);
    // Unknown ids are ignored; ones not named keep their place after the named ones.
    const c = store.add('Third', 'Third text');
    expect(store.reorder(['ghost', b.id]).map((p) => p.id)).toEqual([b.id, c.id, a.id]);

    expect(store.remove(c.id)).toBe(true);
    expect(store.remove(c.id)).toBe(false);

    // A fresh store reads the same from the file.
    const again = new PromptStore(dir);
    expect(again.all()).toEqual(store.all());
    const file = JSON.parse(readFileSync(path.join(dir, PROMPTS_FILE), 'utf8'));
    expect(file.version).toBe(1);
    expect(file.prompts.map((p: { name: string }) => p.name)).toEqual(['Tests first', 'Review the diff']);
    // Every change was pushed, with the whole list in order.
    expect(pushed.at(-1)).toEqual(['Tests first', 'Review the diff']);
  });

  it('names a prompt saved without a name from its first words, and refuses an empty one', () => {
    const store = new PromptStore(tmp());
    expect(store.add('', '## Review\nLook at every file that changed and list the bugs you find, worst first.').name).toBe('Review');
    expect(store.add(undefined, 'Look at every file that changed and list the bugs you find.').name).toBe('Look at every file that changed and');
    expect(() => store.add('Empty', '   \n ')).toThrow();
    expect(nameFromText('   ')).toBe('Prompt');
    expect(cleanName('x'.repeat(200))).toHaveLength(MAX_NAME);
  });

  it('reads past a damaged file without losing it', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, PROMPTS_FILE), '{ not json');
    const store = new PromptStore(dir);
    expect(store.all()).toEqual([]);
    expect(readFileSync(path.join(dir, PROMPTS_FILE), 'utf8')).toBe('{ not json');
    writeFileSync(path.join(dir, PROMPTS_FILE), JSON.stringify({ version: 1, prompts: [{ id: 'a', name: 'One', text: 'One text' }, { id: 'a', name: 'Dup', text: 'x' }, { name: 'No id', text: 'y' }, null] }));
    expect(new PromptStore(dir).all().map((p) => p.name)).toEqual(['One']);
  });
});

describe('the prompt store when the file fails', () => {
  it('changes nothing it could not write: a failed delete keeps the prompt, and a later save does not carry the deletion', () => {
    const dir = tmp();
    const pushed: string[][] = [];
    const store = new PromptStore(dir, (list) => pushed.push(list.map((p) => p.name)));
    const a = store.add('Keep', 'Keep this one.');
    const b = store.add('Other', 'Another one.');
    const n = pushed.length;
    // The file cannot be replaced (here: a folder in its place, as a sharing violation would on Windows).
    const file = path.join(dir, PROMPTS_FILE);
    rmSync(file);
    mkdirSync(file);
    expect(() => store.remove(a.id)).toThrow();
    expect(store.all().map((p) => p.id)).toEqual([b.id, a.id]);
    expect(pushed.length).toBe(n);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    // Once it can be written again, the next change keeps the prompt the failed delete left.
    rmSync(file, { recursive: true });
    store.update(b.id, { name: 'Other one' });
    expect(new PromptStore(dir).all().map((p) => p.name)).toEqual(['Other one', 'Keep']);
  });

  it('never replaces a damaged file blindly: it is kept beside the new one', () => {
    const dir = tmp();
    const file = path.join(dir, PROMPTS_FILE);
    writeFileSync(file, '{ "version": 1, "prompts": [ { "id": "a", "name": "Half');
    const store = new PromptStore(dir);
    expect(store.all()).toEqual([]);
    store.add('New', 'A new prompt.');
    const kept = readdirSync(dir).filter((f) => f.startsWith('prompts.damaged-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(path.join(dir, kept[0]), 'utf8')).toBe('{ "version": 1, "prompts": [ { "id": "a", "name": "Half');
    expect(new PromptStore(dir).all().map((p) => p.name)).toEqual(['New']);
  });

  it('a file it cannot read is not an empty list: changes are refused, and it is read again later', () => {
    const dir = tmp();
    const file = path.join(dir, PROMPTS_FILE);
    mkdirSync(file);
    const store = new PromptStore(dir);
    expect(store.all()).toEqual([]);
    expect(() => store.add('New', 'A new prompt.')).toThrow(/could not be read/);
    rmSync(file, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, prompts: [{ id: 'a', name: 'One', text: 'One text' }] }));
    expect(store.all().map((p) => p.name)).toEqual(['One']);
  });

  it('refuses a change to a field another window changed since this edit began', () => {
    const store = new PromptStore(tmp());
    const a = store.add('Name', 'First text.');
    store.update(a.id, { text: 'Changed in B.' });
    expect(() => store.update(a.id, { text: 'Changed in A.' }, { text: 'First text.' })).toThrow(/another window/);
    expect(store.all()[0].text).toBe('Changed in B.');
    // A field that was not changed elsewhere goes through; so does one changed to the same words.
    expect(store.update(a.id, { name: 'Renamed in A' }, { name: 'Name' }).name).toBe('Renamed in A');
    expect(store.update(a.id, { text: 'Changed in B.' }, { text: 'First text.' }).text).toBe('Changed in B.');
  });
});

describe('prompts over the bridge', () => {
  it('answers the prompts.* methods and pushes prompts.updated', async () => {
    const home = tmp();
    const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    apps.push(app);
    registerPrompts(app);
    const events: BridgeEvent[] = [];
    app.subscribe((e) => events.push(e));
    const p = await app.call('prompts.save', { name: 'Explain', text: 'Explain this code.' });
    expect(await app.call('prompts.list', {})).toEqual([p]);
    await app.call('prompts.update', { id: p.id, name: 'Explain it' });
    const q = await app.call('prompts.save', { name: 'Shorter', text: 'Make it shorter.' });
    expect((await app.call('prompts.reorder', { ids: [p.id, q.id] })).map((x) => x.name)).toEqual(['Explain it', 'Shorter']);
    expect(await app.call('prompts.remove', { id: q.id })).toEqual({ ok: true });
    await expect(app.call('prompts.remove', { id: '' })).rejects.toThrow();
    const pushed = events.filter((e): e is Extract<BridgeEvent, { type: 'prompts.updated' }> => e.type === 'prompts.updated');
    expect(pushed.at(-1)?.prompts.map((x) => x.name)).toEqual(['Explain it']);
    expect(existsSync(path.join(home, PROMPTS_FILE))).toBe(true);
  });
});
