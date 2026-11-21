/** Saved prompts in the composer's `/` menu, and the palette's message lines (the match near the start, its words marked). */
import { describe, expect, it } from 'vitest';
import type { BridgeEvent, SavedPrompt } from '@shared/protocol';
import { bridge } from '../src/lib/bridge';
import { APP_COMMANDS, appCommandsFor, commandRows, knownTokens } from '../src/features/composer/commands';
import { getPrompts } from '../src/features/saved/prompts-store';
import { leadIn, markIndices, wordsOf } from '../src/features/palette/messages';

const prompt = (id: string, name: string, text: string): SavedPrompt => ({ id, name, text, createdAt: 1, updatedAt: 1 });

/** As if the bridge pushed the list. */
function push(prompts: SavedPrompt[]) {
  for (const l of (bridge as unknown as { listeners: Set<(e: BridgeEvent) => void> }).listeners) l({ type: 'prompts.updated', prompts });
}

describe('saved prompts in the / menu', () => {
  it('lists them first, by name, and keeps the composer able to find them', () => {
    push([prompt('a1', 'Review for bugs', 'Review the diff for bugs.'), prompt('b2', 'Tests first', 'Write the tests first.')]);
    expect(getPrompts().map((p) => p.name)).toEqual(['Review for bugs', 'Tests first']);
    const rows = commandRows('', undefined, null);
    expect(rows.slice(0, 2).map((r) => [r.group, r.label, r.kind])).toEqual([
      ['Prompts', 'Review for bugs', 'app'],
      ['Prompts', 'Tests first', 'app'],
    ]);
    expect(rows[2].group).toBe('Sable');
    // The menu looks a chosen row up among the app's commands.
    expect(APP_COMMANDS.find((c) => c.name === rows[0].name)?.prompt?.text).toBe('Review the diff for bugs.');
    // Typed letters find a prompt by its name; Sable's own commands stay as they were.
    expect(commandRows('rev', undefined, null)[0].label).toBe('Review for bugs');
    expect(commandRows('tests-first', undefined, null)[0].label).toBe('Tests first');
    expect(commandRows('new', undefined, null).some((r) => r.label === '/new')).toBe(true);
    // A prompt is not a token the field marks as a command.
    expect([...knownTokens(undefined, null).commands].some((n) => n.startsWith('prompt:'))).toBe(false);
  });

  it('follows the list as it changes', () => {
    push([prompt('c3', 'Only one', 'One.')]);
    expect(appCommandsFor(null).filter((c) => c.prompt).map((c) => c.prompt!.name)).toEqual(['Only one']);
    push([]);
    expect(appCommandsFor(null).some((c) => c.prompt)).toBe(false);
    expect(commandRows('', undefined, null)[0].group).toBe('Sable');
  });
});

describe('a message line in the palette', () => {
  it('starts near the match and marks every word', () => {
    const words = wordsOf('Session  EXPIRY');
    expect(words).toEqual(['session', 'expiry']);
    const text = 'I will start by reading the module, then I will find everywhere session expiry is decided today.';
    const line = leadIn(text, words);
    expect(line.startsWith('…')).toBe(true);
    expect(line).toContain('session expiry is decided');
    expect(line.indexOf('session')).toBeLessThan(30);
    // A match near the start leaves the text as it is.
    expect(leadIn('Expiry now lives in the store.', ['expiry'])).toBe('Expiry now lives in the store.');
    const marks = markIndices('Session store: session expiry', ['session', 'expiry']);
    const lit = marks.map((i) => 'Session store: session expiry'[i]).join('');
    expect(lit).toBe('Sessionsessionexpiry');
  });
});
