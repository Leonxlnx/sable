import { describe, expect, it } from 'vitest';
import { accountWord } from '../src/features/sidebar/status';

const acc = (id: string, label: string) => ({ id, label });

describe('accountWord: the account a sidebar row names on hover', () => {
  it('says nothing when the agent has one account', () => {
    expect(accountWord([acc('default', 'Max')], undefined)).toBeNull();
    expect(accountWord(undefined, 'a')).toBeNull();
  });
  it('names the chat\'s account by its label, the built-in one when the chat names none', () => {
    const list = [acc('default', 'Personal'), acc('u4', 'Ultra4')];
    expect(accountWord(list, 'u4')).toBe('Ultra4');
    expect(accountWord(list, undefined)).toBe('Personal');
  });
  it('never shows an email or an empty label, nor a removed account', () => {
    const list = [acc('default', 'me@example.com'), acc('b', '  '), acc('c', 'Team')];
    expect(accountWord(list, 'default')).toBeNull();
    expect(accountWord(list, 'b')).toBeNull();
    expect(accountWord(list, 'gone')).toBeNull();
  });
});
