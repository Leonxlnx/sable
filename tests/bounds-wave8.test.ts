/**
 * Review wave 8, finding 24: what an agent sends is bounded before it is kept. An ACP frame is cut
 * as it grows (one endless line must not fill memory), every field of a commit draft's prompt has a
 * budget, and a quick answer (a title, a commit message) past its limit stops the turn.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { commitPrompt } from '../server/core/commit-draft';
import { CodexProvider, QUICK_MAX_CHARS } from '../server/providers/codex';
import { boundedLines } from '../server/util/lines';

describe('bounded frames', () => {
  it('keeps lines whole across chunks and drops one over the bound up to its newline', () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const dropped: number[] = [];
    boundedLines(input, 16, (l) => lines.push(l), (n) => dropped.push(n));
    input.write('{"a":1}\r\n{"b"');
    input.write(':2}\n');
    // An endless frame: nothing of it is kept beyond the bound while it grows.
    for (let i = 0; i < 100; i++) input.write('x'.repeat(1000));
    input.write('\n{"c":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toBe(100_000);
  });

  it('a multi-byte character split across chunks stays whole', () => {
    const input = new PassThrough();
    const lines: string[] = [];
    boundedLines(input, 1024, (l) => lines.push(l));
    const bytes = Buffer.from('"größer"\n', 'utf8');
    input.write(bytes.subarray(0, 4));
    input.write(bytes.subarray(4));
    expect(lines).toEqual(['"größer"']);
  });
});

describe('a commit draft prompt within its budget', () => {
  it('cuts an endless subject and an endless file name, and keeps only a few subjects', () => {
    const p = commitPrompt({ files: ['a.ts', `${'d/'.repeat(5000)}b.ts`], patch: 'diff', subjects: ['x'.repeat(1_000_000), ...Array.from({ length: 50 }, (_, i) => `Subject ${i}`)] }, '/repo');
    expect(p.user.length).toBeLessThan(5_000);
    expect(p.user).toContain('Subject 0');
    expect(p.user).not.toContain('Subject 10');
  });

  it('a list of huge file names stays within its budget', () => {
    const files = Array.from({ length: 200 }, (_, i) => `${i}-${'n'.repeat(400)}`);
    const p = commitPrompt({ files, patch: '', subjects: [] }, '/repo');
    expect(p.user.length).toBeLessThan(14_000);
    expect(p.user).toMatch(/and \d+ more/);
  });
});

describe('a quick answer that does not end', () => {
  it('Codex: the answer stops at its limit and the turn is interrupted', async () => {
    const requests: { method: string; params: any }[] = [];
    const provider = new CodexProvider({ emit: () => {}, log: () => {} } as never);
    const any = provider as unknown as Record<string, any>;
    const rpc = {
      request: async (method: string, params: any) => {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'tt1' } };
        if (method === 'mcpServerStatus/list') return { data: [] };
        if (method === 'turn/start') {
          // The model streams far past any commit message.
          setTimeout(() => {
            for (let i = 0; i < 100; i++) any.onNotification('item/agentMessage/delta', { threadId: 'tt1', delta: 'y'.repeat(1000) });
          }, 0);
          return { turn: { id: 'tu1' } };
        }
        return {};
      },
    };
    any.client = async () => rpc;
    any.caps = async () => ({ models: [{ id: 'gpt-mini', name: 'GPT mini', description: 'Smaller and faster', isDefault: false }] });
    const text = await provider.quickTitle({ system: 's', user: 'u', cwd: '/repo', maxTokens: '600' }, new AbortController().signal);
    if (!requests.some((r) => r.method === 'thread/start')) return expect.fail('no small model was picked');
    expect(text?.length).toBe(QUICK_MAX_CHARS);
    await new Promise((r) => setTimeout(r, 0));
    expect(requests.some((r) => r.method === 'turn/interrupt' && r.params.turnId === 'tu1')).toBe(true);
  });
});
