/** The effort scale's rules (a drag, the keys, a pick, ultracode past the end), and the rules for a speed billed outside the plan. */
import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@shared/protocol';
import { clampStop, keyStop, land, lastStop, litLevels, positionOf, SCRUB_PX, scrubStop, ultraStop, type Scale, type Setting } from '../src/features/composer/effort-track';
import { defaultableSpeeds, offeredSpeeds, startSpeedFor, toggledSpeed } from '../shared/speed';

describe('the effort scale', () => {
  // Five levels and ultracode past the end: six stops, 0 to 5.
  const claude: Scale = { levels: 5, ultra: true };
  // Levels only (an agent without ultracode).
  const plain: Scale = { levels: 3, ultra: false };
  // Ultracode alone (a model whose level the agent decides).
  const bare: Scale = { levels: 0, ultra: true };
  const high: Setting = { level: 2, ultra: false };

  it('has one stop per level and one more past the end where ultracode is offered', () => {
    expect([lastStop(claude), ultraStop(claude)]).toEqual([5, 5]);
    expect([lastStop(plain), ultraStop(plain)]).toEqual([2, -1]);
    expect([lastStop(bare), ultraStop(bare)]).toEqual([0, 0]);
    expect(lastStop({ levels: 0, ultra: false })).toBe(-1);
  });

  it('stands on its level, and past the end while ultracode is on', () => {
    expect(positionOf(high, claude)).toBe(2);
    expect(positionOf({ level: 2, ultra: true }, claude)).toBe(5);
    // Ultracode reported on by an agent that does not offer it here: the level's own stop.
    expect(positionOf({ level: 2, ultra: true }, plain)).toBe(2);
    expect(positionOf({ level: -1, ultra: false }, claude)).toBe(-1);
  });

  it('lights the pips up to the level, and all of them past the end', () => {
    expect(litLevels(2, claude)).toBe(3);
    expect(litLevels(-1, claude)).toBe(0);
    expect(litLevels(5, claude)).toBe(5);
  });

  it('a drag moves one stop per step of travel, from where it began, and stops at the ends', () => {
    expect(scrubStop(2, 0, claude)).toBe(2);
    // Less than a whole step in either direction stays.
    expect(scrubStop(2, SCRUB_PX - 1, claude)).toBe(2);
    expect(scrubStop(2, -(SCRUB_PX - 1), claude)).toBe(2);
    expect(scrubStop(2, SCRUB_PX, claude)).toBe(3);
    expect(scrubStop(2, -SCRUB_PX, claude)).toBe(1);
    expect(scrubStop(2, SCRUB_PX * 3, claude)).toBe(5);
    expect(scrubStop(2, 900, claude)).toBe(5);
    expect(scrubStop(2, -900, claude)).toBe(0);
    expect(scrubStop(1, 900, plain)).toBe(2);
    // A scale that is ultracode alone: off is one step to the left.
    expect(scrubStop(0, -SCRUB_PX, bare)).toBe(-1);
    expect(scrubStop(-1, SCRUB_PX, bare)).toBe(0);
  });

  it('the arrows step, Home and End jump, and the ends hold', () => {
    expect(keyStop(2, 'ArrowRight', claude)).toBe(3);
    expect(keyStop(2, 'ArrowLeft', claude)).toBe(1);
    expect(keyStop(2, 'Home', claude)).toBe(0);
    expect(keyStop(2, 'End', claude)).toBe(5);
    expect(keyStop(5, 'ArrowRight', claude)).toBeNull();
    expect(keyStop(0, 'ArrowLeft', claude)).toBeNull();
    expect(keyStop(2, 'ArrowDown', claude)).toBeNull();
    expect(keyStop(-1, 'ArrowRight', claude)).toBe(0);
    expect(clampStop(9, plain)).toBe(2);
  });

  it('landing on a level sends that level', () => {
    expect(land(high, 4, claude, 'drag')).toEqual({ level: 4 });
    expect(land(high, 0, claude, 'pick')).toEqual({ level: 0 });
    expect(land(high, 2, claude, 'pick')).toEqual({});
  });

  it('landing past the end turns ultracode on and keeps the level under it', () => {
    expect(land(high, 5, claude, 'key')).toEqual({ ultra: true });
    expect(land(high, 5, claude, 'drag')).toEqual({ ultra: true });
    expect(land({ level: 2, ultra: true }, 5, claude, 'pick')).toEqual({});
    expect(land({ level: -1, ultra: false }, 0, bare, 'pick')).toEqual({ ultra: true });
  });

  it('one step down from ultracode by key only leaves it: back to the level that was kept', () => {
    const on: Setting = { level: 2, ultra: true };
    expect(land(on, keyStop(5, 'ArrowLeft', claude)!, claude, 'key')).toEqual({ ultra: false });
    // A drag or a pick names a stop: that level is set.
    expect(land(on, 4, claude, 'drag')).toEqual({ ultra: false, level: 4 });
    expect(land(on, 4, claude, 'pick')).toEqual({ ultra: false, level: 4 });
    // The kept level's own row, picked: ultracode off, the level as it was.
    expect(land(on, 2, claude, 'pick')).toEqual({ ultra: false });
    // Ultracode alone: off.
    expect(land({ level: -1, ultra: true }, -1, bare, 'key')).toEqual({ ultra: false });
    // No level set (the agent decides) under ultracode: the step down sets none, it only leaves.
    expect(land({ level: -1, ultra: true }, keyStop(5, 'ArrowLeft', claude)!, claude, 'key')).toEqual({ ultra: false });
    expect(positionOf({ level: -1, ultra: false }, claude)).toBe(-1);
  });
});

describe('a speed billed outside the plan', () => {
  const model: ModelInfo = {
    id: 'm',
    name: 'M',
    speeds: [
      { id: 'priority', name: 'Fast' },
      { id: 'fast', name: 'Fast', note: 'Extra usage', paid: true },
    ],
  };
  const claude: ModelInfo = { id: 'opus', name: 'Opus', speeds: [{ id: 'fast', name: 'Fast', paid: true }] };

  it('is offered only with extra usage on', () => {
    expect(offeredSpeeds(model, false).map((s) => s.id)).toEqual(['priority']);
    expect(offeredSpeeds(model, undefined).map((s) => s.id)).toEqual(['priority']);
    expect(offeredSpeeds(model, true).map((s) => s.id)).toEqual(['priority', 'fast']);
  });

  it('is never a default, and a saved one starts a session at standard', () => {
    expect(defaultableSpeeds(model).map((s) => s.id)).toEqual(['priority']);
    expect(startSpeedFor(claude, 'fast')).toBe('standard');
    expect(startSpeedFor(model, 'priority')).toBe('priority');
  });

  it('/fast toggles only what is offered', () => {
    expect(toggledSpeed(claude, 'standard', offeredSpeeds(claude, false))).toBe('standard');
    expect(toggledSpeed(claude, 'standard', offeredSpeeds(claude, true))).toBe('fast');
    expect(toggledSpeed(claude, 'fast', offeredSpeeds(claude, true))).toBe('standard');
  });
});
