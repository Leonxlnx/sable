/**
 * What Enter does in a chat's field, with or without its modifiers (the owner's rule): Ctrl+Enter
 * (Cmd+Enter on a Mac) sends NOW. In a chat at rest, or one whose agent is only starting, it is a
 * plain send; while a turn runs it is the steer (the message goes into the turn). It never puts a
 * message into the queue, but with an agent that takes nothing mid-turn (OpenCode), where the key's
 * tooltip says so. The queue is the plain send key while a turn runs: Enter, or Ctrl+Shift+Enter where
 * Enter makes a new line (`sendWithEnter` off). Pure, so the field and the send key's tooltip read one rule.
 */
export type EnterAction = 'send' | 'steer' | 'queue' | 'newline';

export interface EnterState {
  /** A turn runs (running, or waiting on a prompt of the person's): not an agent that only starts. */
  turnRuns: boolean;
  /** The agent takes a message mid-turn. */
  steerable: boolean;
  /** Enter sends (else Ctrl+Enter does, and Enter makes a new line). */
  sendWithEnter: boolean;
}

export function enterAction(keys: { mod: boolean; shift: boolean }, s: EnterState): EnterAction {
  const { mod, shift } = keys;
  if (!s.turnRuns) {
    const send = s.sendWithEnter ? !shift || mod : mod;
    return send ? 'send' : 'newline';
  }
  if (mod && !shift) return s.steerable ? 'steer' : 'queue';
  const queue = s.sendWithEnter ? !mod && !shift : mod && shift;
  return queue ? 'queue' : 'newline';
}

/** The keys the send key's tooltip names for what a press of it does now. */
export function sendKeys(what: 'send' | 'steer' | 'queue', s: Pick<EnterState, 'steerable' | 'sendWithEnter'>): string {
  if (what === 'steer') return 'mod+enter';
  if (what === 'queue' && s.steerable) return s.sendWithEnter ? 'enter' : 'mod+shift+enter';
  return s.sendWithEnter ? 'enter' : 'mod+enter';
}
