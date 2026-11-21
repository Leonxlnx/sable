import { describe, expect, it } from 'vitest';
import { fileKey, oneOfEach } from '../src/features/settings/files';

describe('settings file lists', () => {
  it('shows a file that is both the user file and the project file once, as the user file', () => {
    const files = [
      { scope: 'user', path: 'C:\\Users\\mara\\.claude\\settings.json' },
      { scope: 'project', path: 'C:/Users/Mara/.claude/settings.json' },
      { scope: 'local', path: 'C:\\Users\\mara\\.claude\\settings.local.json' },
    ];
    expect(oneOfEach(files).map((f) => f.scope)).toEqual(['user', 'local']);
  });

  it('keeps files that only share a name', () => {
    const files = [
      { scope: 'user', path: '/home/mara/.claude/CLAUDE.md' },
      { scope: 'project', path: '/home/mara/work/api/CLAUDE.md' },
    ];
    expect(oneOfEach(files)).toHaveLength(2);
  });

  it('keys by scope and path', () => {
    const a = { scope: 'user', path: '/x/settings.json' };
    const b = { scope: 'project', path: '/x/settings.json' };
    expect(fileKey(a)).not.toBe(fileKey(b));
  });
});
