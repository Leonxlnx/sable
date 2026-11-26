/**
 * Hotfix of 0.2.38, the owner's rule: Ctrl+Enter sends NOW. At rest (and while the agent only starts)
 * a plain send, in a running turn the steer, never the queue, but with an agent that takes nothing
 * mid-turn (OpenCode), where the key's tooltip says so.
 */
import { describe, expect, it } from 'vitest';
import { enterAction, sendKeys, type EnterState } from '../src/features/composer/enter-keys';

const ctrl = { mod: true, shift: false };
const plain = { mod: false, shift: false };
const shift = { mod: false, shift: true };
const ctrlShift = { mod: true, shift: true };
const states = (o: Partial<EnterState>): EnterState => ({ turnRuns: false, steerable: true, sendWithEnter: true, ...o });

describe('Ctrl+Enter', () => {
  it('never queues where the agent takes a message mid-turn, whatever the setting', () => {
    for (const sendWithEnter of [true, false]) {
      expect(enterAction(ctrl, states({ sendWithEnter }))).toBe('send');
      expect(enterAction(ctrl, states({ sendWithEnter, turnRuns: true }))).toBe('steer');
    }
  });

  it('is a plain send while the agent only starts (a message sent to an idle chat): no turn runs', () => {
    // The composer passes turnRuns only for running and awaiting, never for starting.
    expect(enterAction(ctrl, states({ turnRuns: false }))).toBe('send');
    expect(enterAction(plain, states({ turnRuns: false }))).toBe('send');
  });

  it('queues only with an agent that takes nothing mid-turn', () => {
    expect(enterAction(ctrl, states({ turnRuns: true, steerable: false }))).toBe('queue');
    expect(enterAction(ctrl, states({ turnRuns: true, steerable: false, sendWithEnter: false }))).toBe('queue');
  });
});

describe('the other keys', () => {
  it('Enter sends at rest and queues in a running turn when it sends; makes a new line otherwise', () => {
    expect(enterAction(plain, states({}))).toBe('send');
    expect(enterAction(plain, states({ turnRuns: true }))).toBe('queue');
    expect(enterAction(plain, states({ sendWithEnter: false }))).toBe('newline');
    expect(enterAction(plain, states({ sendWithEnter: false, turnRuns: true }))).toBe('newline');
    expect(enterAction(shift, states({}))).toBe('newline');
    expect(enterAction(shift, states({ turnRuns: true }))).toBe('newline');
  });

  it('Ctrl+Shift+Enter queues where Enter makes a new line', () => {
    expect(enterAction(ctrlShift, states({ sendWithEnter: false, turnRuns: true }))).toBe('queue');
    expect(enterAction(ctrlShift, states({ sendWithEnter: false }))).toBe('send');
  });
});

describe("the send key's tooltip", () => {
  it('names the keys that do what a press does', () => {
    expect(sendKeys('steer', { steerable: true, sendWithEnter: false })).toBe('mod+enter');
    expect(sendKeys('queue', { steerable: true, sendWithEnter: false })).toBe('mod+shift+enter');
    expect(sendKeys('queue', { steerable: true, sendWithEnter: true })).toBe('enter');
    expect(sendKeys('queue', { steerable: false, sendWithEnter: false })).toBe('mod+enter');
    expect(sendKeys('send', { steerable: true, sendWithEnter: false })).toBe('mod+enter');
    expect(sendKeys('send', { steerable: true, sendWithEnter: true })).toBe('enter');
  });
});
