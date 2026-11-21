/**
 * An open row in Settings › Prompts closes only once what was typed is stored (review wave 3, #25):
 * a write the bridge refuses (another window changed the field after this one looked) keeps the row
 * open with the words, and one refused after the row was closed another way opens it again.
 */
import { describe, expect, it } from 'vitest';
import { RowWrites } from '../src/features/settings/prompt-edits';

function gate() {
  let open!: (v: boolean) => void;
  const shut = new Promise<boolean>((r) => (open = r));
  return { wait: () => shut, open };
}

describe('#25: a saved-prompt edit closes only once it is stored', () => {
  it('Done waits for the write; a refused one keeps the row open, a stored one closes it', async () => {
    const g = gate();
    let open = true;
    const answers = [g.wait(), Promise.resolve(true)];
    const writes = new RowWrites(() => answers.shift()!, { isOpen: () => open, refusedClosed: () => {} });
    void writes.send({ text: 'Mine.' }, { text: 'Seen.' });
    let closed = false;
    const done = writes.closeWhenStored(() => (closed = true));
    await new Promise((r) => setTimeout(r, 10));
    // Not closed while the write is out.
    expect(closed).toBe(false);
    g.open(false);
    expect(await done).toBe(false);
    expect(closed).toBe(false);
    // Picked and sent again, stored: Done closes it.
    void writes.send({ text: 'Mine.' }, { text: 'Theirs.' });
    expect(await writes.closeWhenStored(() => ((closed = true), (open = false)))).toBe(true);
    expect(closed).toBe(true);
  });

  it('a write that fails outright counts as refused', async () => {
    const writes = new RowWrites(() => Promise.reject(new Error('Saved prompts could not be written')), { isOpen: () => true, refusedClosed: () => {} });
    void writes.send({ name: 'New name' }, { name: 'Old' });
    let closed = false;
    expect(await writes.closeWhenStored(() => (closed = true))).toBe(false);
    expect(closed).toBe(false);
  });

  it('refused after the row was closed another way: the row is asked to open again on its words', async () => {
    const g = gate();
    let open = true;
    const seen: string[] = [];
    const writes = new RowWrites(() => g.wait(), { isOpen: () => open, refusedClosed: () => seen.push('reopen'), idle: () => seen.push('idle') });
    const w = writes.send({ text: 'Mine.' }, { text: 'Seen.' });
    // The person opens another row: this one closes while its write is out.
    open = false;
    expect(writes.busy).toBe(true);
    g.open(false);
    await w;
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['reopen']);
  });

  it('stored after the row closed: it may follow the prompt again', async () => {
    let open = true;
    const seen: string[] = [];
    const writes = new RowWrites(async () => true, { isOpen: () => open, refusedClosed: () => seen.push('reopen'), idle: () => seen.push('idle') });
    const w = writes.send({ text: 'Mine.' }, { text: 'Seen.' });
    open = false;
    await w;
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['idle']);
    expect(writes.busy).toBe(false);
  });
});
