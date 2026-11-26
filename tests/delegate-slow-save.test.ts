/**
 * A long chat saves slower than the 5 s a delegate's bookkeeping waits for. A save that only misses that
 * deadline is no failure: the runtime follows it to its real end and says nothing; only a save that
 * really rejects is said, once.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '../server/core/runtime';
import { lateEnd, withDeadline } from '../server/util/deadline';
import type { ToolItem } from '../shared/protocol';

function held(save: () => Promise<void>) {
  const rt = new SessionRuntime({ id: 'parent', provider: 'codex', cwd: process.cwd(), title: 'test', titleSource: 'user',
    model: 'm', mode: 'default', status: 'idle', createdAt: 1, updatedAt: 1, usage: { turns: 0, inputTokens: 0, outputTokens: 0 } }, () => {}, () => {});
  rt.add<ToolItem>({ type: 'tool', id: 'step', name: 'delegate_to_codex', kind: 'agent', title: 'Review', status: 'done', detail: {},
    delegateReport: 'pending', result: { text: 'Findings' } });
  rt.pendingDelegateReports.add('step');
  rt.persistDelegate = () => withDeadline(save(), 5000, 'Saving the delegate');
  const notices = () => rt.items.filter(i => i.type === 'notice');
  return { rt, notices };
}

describe('a delegate save that misses its deadline', () => {
  it('is no failure when it ends well: the held report is saved and nothing is said', async () => {
    let finish!: () => void;
    const saves = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    vi.useFakeTimers();
    try {
      const h = held(saves);
      h.rt.holdDelegateReports('stop');
      expect(h.rt.get<ToolItem>('step')?.delegateWait).toBe('stop');
      await vi.advanceTimersByTimeAsync(5010);
      expect(h.notices()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60_000);
      finish();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.notices()).toHaveLength(0);
      // The slow save is followed, never started again.
      expect(saves).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it.each(['at once', 'late'])('says once that a save which rejects (%s) did not save', async when => {
    let fail!: () => void;
    const saves = vi.fn(() => when === 'late' ? new Promise<void>((_, reject) => { fail = () => reject(Error('disk full')); }) : Promise.reject(Error('disk full')));
    vi.useFakeTimers();
    try {
      const h = held(saves);
      h.rt.holdDelegateReports('stop');
      await vi.advanceTimersByTimeAsync(5010);
      if (when === 'late') {
        expect(h.notices()).toHaveLength(0);
        fail();
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(h.notices()).toHaveLength(1);
      expect(h.notices()[0]).toMatchObject({ text: 'Could not save the held delegate report', detail: 'Error: disk full' });
      expect(saves).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('is followed through a deadline inside a deadline', async () => {
    let finish!: () => void;
    const work = new Promise<void>(resolve => { finish = resolve; });
    vi.useFakeTimers();
    try {
      const outer = withDeadline(withDeadline(work, 100, 'Inner'), 50, 'Outer');
      let ended = false;
      const followed = outer.catch(lateEnd).then(() => { ended = true; });
      await vi.advanceTimersByTimeAsync(500);
      expect(ended).toBe(false);
      finish();
      await vi.advanceTimersByTimeAsync(1);
      await followed;
      expect(ended).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
