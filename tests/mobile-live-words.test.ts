/**
 * Phone 2.21: what a chat at work says about itself where it is listed (home's live rows, the chat's
 * header, the Now screen), from the bridge's reading of the running turn (`SessionMeta.live`): the kind
 * of step and never its content, since when, its steps and checkpoints; without that reading the
 * activity line's verb only; its own turn over with sub-agents or commands still at work, what still works.
 */
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@shared/protocol';
import { clockOf, liveWords, stepsWords } from '../mobile/src/lib/live-words';

const meta = (p: Partial<SessionMeta>) => ({ status: 'running', ...p }) as SessionMeta;

describe('liveWords', () => {
  it('reads the running turn by kind and count, never a file name', () => {
    const w = liveWords(meta({ activity: 'Edit src/secret-plan.ts', live: { startedAt: 1000, steps: 8, checkpoints: 2, checkpointSteps: 3, files: 3, doing: 'edit', doingCount: 3 } }));
    expect(w).toEqual({ line: 'Editing 3 files', since: 1000, steps: 8, done: 2, open: 3 });
    expect(JSON.stringify(w)).not.toContain('secret');
  });

  it('names a command, sub-agents and thinking in plain words', () => {
    expect(liveWords(meta({ live: { startedAt: 1, steps: 1, checkpoints: 0, checkpointSteps: 1, files: 0, doing: 'bash' } })).line).toBe('Running a command');
    expect(liveWords(meta({ live: { startedAt: 1, steps: 2, checkpoints: 0, checkpointSteps: 2, files: 0, doing: 'agent', doingCount: 2 } })).line).toBe('Running 2 sub-agents');
    expect(liveWords(meta({ live: { startedAt: 1, steps: 0, checkpoints: 0, checkpointSteps: 0, files: 0, doing: 'thinking' } })).line).toBe('Thinking');
  });

  it('falls back to the activity line verb when the desktop gives no reading', () => {
    const w = liveWords(meta({ activity: 'Run npm test -- --grep secret' }));
    expect(w.line).toBe('Running a command');
    expect(w.steps).toBe(0);
    expect(w.since).toBeUndefined();
  });

  it('says Starting while the agent starts', () => {
    expect(liveWords(meta({ status: 'starting' })).line).toBe('Starting');
  });

  it('says what still works once its own turn ended', () => {
    expect(liveWords(meta({ status: 'idle', background: 2 })).line).toMatch(/2 sub-agents/);
  });
});

describe('stepsWords and clockOf', () => {
  it('counts steps, then checkpoints once one closed', () => {
    expect(stepsWords({ line: '', steps: 0, done: 0, open: 0 })).toBe('');
    expect(stepsWords({ line: '', steps: 1, done: 0, open: 1 })).toBe('1 step');
    expect(stepsWords({ line: '', steps: 9, done: 2, open: 4 })).toBe('2 checkpoints · 9 steps');
  });

  it('reads a turn clock as the desktop does', () => {
    expect(clockOf(42_000)).toBe('0:42');
    expect(clockOf(12 * 60_000 + 5_000)).toBe('12:05');
    expect(clockOf(3_730_000)).toBe('1:02:10');
    expect(clockOf(-5)).toBe('0:00');
  });
});
