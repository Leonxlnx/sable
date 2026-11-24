/**
 * A turn with nothing of the agent's in view shows no figures of its own: after a restart a resumed
 * process's first result booked a cost with no tokens, and "$0.10" stood alone under the message.
 */
import { describe, expect, it } from 'vitest';
import { groupTurns, turnShows, type TurnGroup } from '../src/features/timeline/turns';

const turnsOf = (shape: string) => {
  const ids = [...shape].map((_, i) => String(i + 1));
  return groupTurns(ids, shape, false).groups.filter((g): g is TurnGroup => g.kind === 'turn');
};

describe('whether a turn has anything in view', () => {
  it('a message and a record with nothing between shows nothing; a record alone is no turn at all', () => {
    const turns = turnsOf('UT');
    expect(turns).toHaveLength(1);
    expect(turnShows(turns[0])).toBe(false);
    expect(turnsOf('T')).toEqual([]);
  });

  it('a turn with words, with work, or with both shows', () => {
    for (const shape of ['UtT', 'UwT', 'UwtT', 'wT', 'tT']) {
      const turns = turnsOf(shape);
      expect(turns.some((t) => turnShows(t))).toBe(true);
    }
  });

  it('an empty record after a finished turn adds no turn, and a message after it begins one that shows nothing yet', () => {
    expect(turnsOf('UtTT').map((t) => turnShows(t))).toEqual([true]);
    expect(turnsOf('UtTUT').map((t) => turnShows(t))).toEqual([true, false]);
  });
});
