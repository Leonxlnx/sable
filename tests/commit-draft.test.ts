import { describe, expect, it } from 'vitest';
import { cleanCommit, commitPrompt } from '../server/core/commit-draft';

describe('cleanCommit', () => {
  it('keeps a subject and a body, drops the fence, the lead and the quotes', () => {
    expect(cleanCommit('```\nCommit message: "Add folder button."\n\nShow it in the sidebar.\n```')).toBe('Add folder button\nShow it in the sidebar.');
  });

  it('returns null when nothing is left', () => {
    expect(cleanCommit('  \n ')).toBeNull();
    expect(cleanCommit(null)).toBeNull();
  });
});

describe('commitPrompt', () => {
  it('cuts a long diff and says so', () => {
    const p = commitPrompt({ files: ['a.ts'], patch: 'x'.repeat(20_000), subjects: ['Fix'] }, '/repo');
    expect(p.user).toContain('(cut)');
    expect(p.maxTokens).toBeDefined();
    expect(p.cwd).toBe('/repo');
  });
});
