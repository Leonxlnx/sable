import { expect, it } from 'vitest';
import { claudeHistory } from '../server/providers/claude-history';

it('terminates a stalled SDK reader while another account reads its own configuration', async () => {
  const fake = 'data:text/javascript,' + encodeURIComponent(`
    export async function getSessionMessages(id, { dir }) {
      if (id === 'slow') {
        const count = new Int32Array(dir);
        Atomics.add(count, 0, 1);
        return new Promise(() => setInterval(() => Atomics.add(count, 0, 1), 5));
      }
      return [{ type: 'user', uuid: process.env.CLAUDE_CONFIG_DIR }];
    }
  `);
  const count = new Int32Array(new SharedArrayBuffer(4));
  const ac = new AbortController();
  const slow = claudeHistory('getSessionMessages', ['slow', { dir: count.buffer as unknown as string }],
    { CLAUDE_CONFIG_DIR: 'first' }, ac.signal, undefined, fake);
  const rejected = expect(slow).rejects.toThrow('deadline');
  try {
    await expect.poll(() => Atomics.load(count, 0)).toBeGreaterThan(0);
    const fast = await claudeHistory('getSessionMessages', ['fast', {}], { CLAUDE_CONFIG_DIR: 'second' },
      AbortSignal.timeout(2000), undefined, fake);
    expect(fast[0].uuid).toBe('second');
  } finally { ac.abort(Error('deadline')); }
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 100));
  const final = Atomics.load(count, 0);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(Atomics.load(count, 0)).toBe(final);
});
