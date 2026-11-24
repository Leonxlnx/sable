import { describe, expect, it, vi } from 'vitest';
import type { TextItem, TimelineItem, ToolItem, UserItem } from '@shared/protocol';
import { groupTurns, liveBelowCards, shapeOf, type TurnGroup } from '@/features/timeline/turns';

vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));

const prompt: UserItem = { id: 'prompt', ts: 1, type: 'user', text: 'Go through every module.' };
const steer: UserItem = { id: 'steer', ts: 3, type: 'user', text: 'What is 2+2?', steered: true, state: 'queued' };
const taken: UserItem = { ...steer, state: 'sent' };
const step = (id: string, ts: number, status: ToolItem['status'] = 'done'): ToolItem => ({ id, ts, type: 'tool', name: 'Read', title: 'Read file', kind: 'read', status, detail: {} });
const note = (id: string, ts: number): TextItem => ({ id, ts, type: 'text', text: 'Done with 25 steps so far; nothing unexpected.', streaming: false });

const turnOf = (items: TimelineItem[]) => groupTurns(items.map((i) => i.id), items.map(shapeOf).join(''), true).groups.at(-1) as TurnGroup;

describe('the live line and a waiting steer (win2 day 7)', () => {
  it('stays above a waiting card after a note, as it does while a step runs: the card never hops', () => {
    // Waiting, the work ends in a note (the moment between a note and the next step).
    expect(liveBelowCards(turnOf([prompt, step('a', 2), steer, note('n', 4)]), true)).toBe(false);
    // Waiting, the next step began.
    expect(liveBelowCards(turnOf([prompt, step('a', 2), steer, note('n', 4), step('b', 5, 'running')]), true)).toBe(false);
  });

  it('goes below the card once the agent took it and nothing came after it yet', () => {
    const turn = turnOf([prompt, step('a', 2), note('n', 4), taken]);
    expect(turn.liveSegment).toBeDefined();
    expect(liveBelowCards(turn, true)).toBe(true);
    // Settled: no live line at all.
    expect(liveBelowCards(turn, false)).toBe(false);
  });
});
