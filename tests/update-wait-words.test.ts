/** The words of a restart that waits: one rule for the sidebar's row, its menu and Settings › About. */
import { describe, expect, it } from 'vitest';
import type { UpdateWait } from '../shared/protocol';
import { waitChats, waitLabel, waitWord } from '../src/features/sidebar/update-wait';

const now = 1_000_000;
const titles: Record<string, string> = { a: 'Sign-in fix', b: 'Phone app' };
const title = (id: string) => titles[id];

describe('what a chat holds, in a word', () => {
  it.each<[UpdateWait, string]>([
    [{ sessionId: 'a', kind: 'turn' }, 'Working'],
    [{ sessionId: 'a', kind: 'starting' }, 'Starting'],
    [{ sessionId: 'a', kind: 'asks' }, 'Waiting for you'],
    [{ sessionId: 'a', kind: 'moving' }, 'Changing account'],
    [{ sessionId: 'a', kind: 'agents' }, 'Sub-agent'],
    [{ sessionId: 'a', kind: 'agents', count: 3 }, '3 sub-agents'],
    [{ sessionId: 'a', kind: 'command', until: now + 12 * 60_000 }, 'Command · 12 min'],
    [{ sessionId: 'a', kind: 'command', count: 2, until: now + 20_000 }, '2 commands · 1 min'],
    [{ sessionId: 'a', kind: 'wake', until: now + 40 * 60_000 + 1 }, 'Wake-up · 41 min'],
    [{ sessionId: 'a', kind: 'agent' }, 'Agent busy'],
    [{ sessionId: 'a', kind: 'agent', until: now - 5 }, 'Agent busy'],
    [{ kind: 'sable' }, 'Finishing a step'],
  ])('%j reads %s', (wait, word) => {
    expect(waitWord(wait, now)).toBe(word);
  });
});

describe('the row', () => {
  it('names the one chat it waits for', () => {
    expect(waitLabel([{ sessionId: 'a', kind: 'turn' }], title)).toBe('Waits for Sign-in fix');
  });

  it('counts several chats, each once', () => {
    const waits: UpdateWait[] = [{ sessionId: 'a', kind: 'turn' }, { sessionId: 'b', kind: 'command', until: now + 1 }, { sessionId: 'a', kind: 'agents' }, { kind: 'sable' }];
    expect(waitChats(waits).map((w) => w.sessionId)).toEqual(['a', 'b']);
    expect(waitLabel(waits, title)).toBe('Waits for 2 chats');
  });

  it('says so when only a step of Sable holds it, and keeps the old words when the bridge names nothing', () => {
    expect(waitLabel([{ kind: 'sable' }], title)).toBe('Finishing a step');
    expect(waitLabel(undefined, title)).toBe('Waits for agents');
    expect(waitLabel([], title)).toBe('Waits for agents');
  });

  it('never shows an empty name', () => {
    expect(waitLabel([{ sessionId: 'gone', kind: 'turn' }], title)).toBe('Waits for 1 chat');
    expect(waitLabel([{ sessionId: 'a', kind: 'turn' }], () => '   ')).toBe('Waits for 1 chat');
  });
});
