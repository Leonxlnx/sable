import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accountInUse, accountMark, markWords } from '../src/features/accounts/model';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const acct = (id: string, isDefault = false) => ({ id, isDefault });

/**
 * 22 Nov, the owner, in a chat that ran on Max3 while the check stood on Max2 (the default for new
 * chats, its 5-hour window full): "on which subscription are you … why is showing me that max2
 * limits 5h are reached". The check now stands on the account in use.
 */
describe('the switcher says which account is in use', () => {
  const claude = [acct('max1'), acct('max2', true), acct('max3'), acct('ultra1')];

  it('the account in use is the open chat’s own, whatever the default is', () => {
    expect(accountInUse(claude, 'max3')?.id).toBe('max3');
    // With no chat of this agent open (and no choice on home): the default.
    expect(accountInUse(claude, undefined)?.id).toBe('max2');
    // A chat whose account is gone: the default, never nothing.
    expect(accountInUse(claude, 'removed')?.id).toBe('max2');
    expect(accountInUse([acct('a'), acct('b')], undefined)?.id).toBe('a');
    expect(accountInUse([], 'x')).toBeUndefined();
  });

  it('one check, on the chat’s account; the default for new chats is the quiet mark', () => {
    const marks = claude.map((a) => accountMark(a, 'max3'));
    expect(marks).toEqual([undefined, 'next', 'here', undefined]);
    expect(marks.filter((m) => m === 'here')).toHaveLength(1);
  });

  it('a chat on the default account: the check alone', () => {
    expect(claude.map((a) => accountMark(a, 'max2'))).toEqual([undefined, 'here', undefined, undefined]);
  });

  it('an agent the open chat does not run with has no check, only where its new chats start', () => {
    const codex = [acct('default', true), acct('work')];
    expect(codex.map((a) => accountMark(a, undefined))).toEqual(['next', undefined]);
  });

  it('says it in words for a screen reader', () => {
    expect(markWords('here')).toBe(', in use');
    expect(markWords('next')).toBe(', new chats start here');
    expect(markWords(undefined)).toBe('');
  });

  it('both lists draw the row by that rule, and never check the default by itself', () => {
    const short = read('../src/features/accounts/Switcher.tsx');
    const long = read('../src/features/accounts/ManyAccounts.tsx');
    for (const src of [short, long]) {
      expect(src).toContain('const mark = accountMark(account, inUse ? account.id : undefined);');
      expect(src).toContain("data-current={mark === 'here' || undefined}");
      expect(src).toContain('<MarkCell mark={mark} />');
      expect(src).not.toMatch(/account\.isDefault &&[^\n]*name="check"/);
      expect(src).not.toMatch(/data-current=\{account\.isDefault/);
    }
    // The row the footer names is the one the menu checks: both come from the same account.
    expect(short).toContain('const current = accountInUse(list, focus === active ? accountId : undefined);');
    expect(short).toContain('inUse={{ provider: focus, accountId: current?.id }}');
    expect(short).toContain('inUse={id === focus ? current?.id : undefined}');
    // The mark for new chats is a dot, not a second check.
    const cell = long.slice(long.indexOf('export function MarkCell'), long.indexOf('export function SignIn'));
    expect(cell.split('name="check"').length - 1).toBe(1);
    expect(cell).toContain('className="acs-next"');
  });
});
