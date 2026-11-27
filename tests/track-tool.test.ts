/**
 * `track_work` as each agent gets it (`server/providers/track-tool.ts`): Claude Code from Sable's
 * in-process server, allowed without a prompt, the call's own step named to the bridge; Codex as a
 * client-defined tool. Only a chat's own agent: never a sub-agent's process or a read-only check.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/protocol';
import type { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';
import { describeTool } from '../server/providers/claude-tools';
import { CodexProvider } from '../server/providers/codex';
import { TRACK_DESCRIPTION, TRACK_INPUT_SCHEMA, TRACK_TOOL, TRACK_TOOL_ID, describeTrackCall, trackDynamicAnswer } from '../server/providers/track-tool';
import type { ProviderContext } from '../server/providers/types';

function setup() {
  const calls: { rt: SessionRuntime; args: unknown; id: string | undefined }[] = [];
  const ctx: ProviderContext = {
    emit: () => {},
    log: () => {},
    settings: () => ({ ...DEFAULT_SETTINGS, generativeUi: false, userProfile: false }),
    trackWork: (rt, args, id) => {
      calls.push({ rt, args, id });
      return { ok: true, text: 'Tracking "A job" (process 5).' };
    },
  };
  return { ctx, calls };
}

const meta = { cwd: process.cwd(), model: '', mode: 'default', options: { browserTab: false } };
type Registered = { description?: string; inputSchema?: unknown; handler(args: unknown, extra: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> };
const toolsOf = (opts: { mcpServers?: Record<string, unknown> }) => (opts.mcpServers?.sable as { instance: { _registeredTools: Record<string, Registered> } } | undefined)?.instance._registeredTools ?? {};

describe('Claude Code', () => {
  it("gets the tool on Sable's server, allowed without asking; a call reaches the bridge with the chat and its own step", async () => {
    const { ctx, calls } = setup();
    const p = new ClaudeProvider(ctx);
    const rt = { id: 'chat' } as unknown as SessionRuntime;
    const owner = { session: { runtime: () => rt } } as unknown as Parameters<typeof p.agentOptions>[1];
    const opts = p.agentOptions(meta, owner);
    expect(TRACK_TOOL_ID).toBe('mcp__sable__track_work');
    expect(opts.allowedTools).toContain(TRACK_TOOL_ID);
    const tool = toolsOf(opts)[TRACK_TOOL];
    expect(tool).toBeTruthy();
    expect(tool.description).toBe(TRACK_DESCRIPTION);
    const args = { title: 'A job', pid: 5, log: 'job.log', by: 'Codex' };
    const answer = await tool.handler(args, { _meta: { 'claudecode/toolUseId': 'toolu_1' } });
    expect(answer.isError).toBe(false);
    expect(answer.content[0].text).toContain('Tracking');
    expect(calls).toEqual([{ rt, args, id: 'toolu_1' }]);
    // No step named (an older CLI): the bridge finds the call's step itself.
    await tool.handler(args, {});
    expect(calls[1].id).toBeUndefined();
  });

  it('answers a call before a chat owns the process, and gives the tool to no sub-agent and no read-only check', async () => {
    const { ctx, calls } = setup();
    const p = new ClaudeProvider(ctx);
    const none = await toolsOf(p.agentOptions(meta, {}))[TRACK_TOOL].handler({ title: 'A job', pid: 5 }, {});
    expect(none.isError).toBe(true);
    expect(calls).toHaveLength(0);
    for (const other of [{ ...meta, id: 'sub-1' }, { ...meta, options: { browserTab: false, readOnly: true } }]) {
      const opts = p.agentOptions(other, {});
      expect(opts.allowedTools ?? []).not.toContain(TRACK_TOOL_ID);
      expect(toolsOf(opts)[TRACK_TOOL]).toBeUndefined();
    }
    // A bridge that tracks nothing (a bare test, an older host): no tool at all.
    const bare = new ClaudeProvider({ emit: () => {}, log: () => {}, settings: ctx.settings }).agentOptions(meta, {});
    expect(bare.allowedTools ?? []).not.toContain(TRACK_TOOL_ID);
  });

  it('the conversation shows the call by the title a person reads, who runs it beside it, and never the log', () => {
    expect(describeTool(TRACK_TOOL_ID, { title: 'Codex builds the sign-in fix', pid: 5, log: 'D:/x/job.log', by: 'Codex' })).toEqual({ kind: 'other', title: 'Codex builds the sign-in fix', detail: { description: 'Codex' } });
    expect(describeTrackCall({})).toEqual({ kind: 'other', title: 'Track work', detail: {} });
  });
});

describe('Codex', () => {
  it('gets it as a client-defined tool with the same inputs; the call goes to the bridge', () => {
    const { ctx, calls } = setup();
    const p = new CodexProvider(ctx);
    const tools = p.dynamicTools({ options: { browserTab: false } }) ?? [];
    const tool = tools.find((t) => t.name === TRACK_TOOL);
    expect(tool).toMatchObject({ type: 'function', name: 'track_work', description: TRACK_DESCRIPTION, inputSchema: TRACK_INPUT_SCHEMA });
    expect(TRACK_INPUT_SCHEMA.required).toEqual(['title', 'pid']);
    expect(Object.keys(TRACK_INPUT_SCHEMA.properties)).toEqual(['title', 'pid', 'log', 'by']);
    const rt = { id: 'chat' } as unknown as SessionRuntime;
    const answer = p.trackWork(rt, { title: 'A job', pid: 5 }, 'turn1:call1');
    expect(calls).toEqual([{ rt, args: { title: 'A job', pid: 5 }, id: 'turn1:call1' }]);
    expect(trackDynamicAnswer(answer)).toEqual({ contentItems: [{ type: 'inputText', text: answer.text }], success: true });
    // Only a chat's own thread.
    expect((p.dynamicTools({ id: 'sub-1', options: { browserTab: false } }) ?? []).some((t) => t.name === TRACK_TOOL)).toBe(false);
    expect((p.dynamicTools({ options: { browserTab: false, readOnly: true } }) ?? []).some((t) => t.name === TRACK_TOOL)).toBe(false);
    expect(new CodexProvider({ emit: () => {}, log: () => {}, settings: ctx.settings }).trackWork(rt, {}, undefined).ok).toBe(false);
  });

  it('tells the agent when to use it, what Sable does and does not do, and what comes back', () => {
    expect(TRACK_DESCRIPTION).toMatch(/outlives the call that started it/);
    expect(TRACK_DESCRIPTION).toMatch(/only watches: it never starts, signals or stops the process/);
    expect(TRACK_DESCRIPTION).toMatch(/you get one message/);
    expect(TRACK_DESCRIPTION).toMatch(/do not poll/);
    expect(TRACK_DESCRIPTION).toMatch(/At most 16 at once per chat/);
  });
});
