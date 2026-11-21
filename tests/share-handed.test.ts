/**
 * What a share step hands over is decided when it goes through, not later at its pathname (review
 * wave 2, #2 and #3):
 * - A stored transcript brings every tool call back as it ended: a call with no result of its own (a
 *   share still waiting for its answer when Claude Code stopped) is incomplete, never done, and a
 *   share restored from a transcript authorizes no download.
 * - A share that goes through records each file's real place, size, time and identity
 *   (`ToolItem.handed`); a phone link serves only that file: one replaced by another of the same size,
 *   one reached through a folder that became a link elsewhere, or one outside the chat's folder the
 *   person did not allow themselves is refused.
 * Fakes only: no agent process starts.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type SessionMeta, type ToolItem } from '@shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';
import { grantFor } from '../server/services/phone-guard';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function place() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-handed-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const cwd = path.join(home, 'chat');
  mkdirSync(cwd);
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'claude', cwd, title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, () => {}, () => {});
  const put = (rel: string, body: string, root = cwd) => {
    const f = path.join(root, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
    return f;
  };
  /** A share step as the agent's call shows it, then going through as its result comes. */
  const share = (id: string, files: string[]) => {
    rt.add<ToolItem>({ id, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'running', detail: { files: files.map((p) => ({ path: p, name: path.basename(p) })) } });
    rt.patch<ToolItem>(id, { status: 'done', endedAt: Date.now() });
  };
  const link = (id: string, index = 0) => grantFor({ session: rt.meta, items: rt.items }, id, index, 'phone1');
  return { home, cwd, rt, put, share, link };
}

describe('a share restored from a stored transcript', () => {
  async function restored(messages: Record<string, unknown>[]) {
    const p = new ClaudeProvider({ emit: () => {}, log: () => {}, settings: () => DEFAULT_SETTINGS });
    const anyP = p as unknown as Record<string, unknown>;
    // No Claude Code process: neither its capabilities probe nor its stored transcripts.
    anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: {} });
    anyP.readLimits = async () => [];
    anyP.withHistory = async () => messages;
    const { rt, put, link } = place();
    rt.meta.providerSessionId = 'cc1';
    const session = (await p.open(rt, {})) as unknown as { loadTranscript(): Promise<void>; close(): Promise<void> };
    cleanups.push(() => session.close());
    put('audit.txt', 'the audit');
    await session.loadTranscript();
    return { rt, link };
  }
  const call = (id: string) => ({ type: 'assistant', uuid: `a-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'SendUserFile', input: { files: ['audit.txt'] } }] } });
  const answer = (id: string, isError = false) => ({ type: 'user', uuid: `u-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'Failed' : 'Sent 1 file', is_error: isError }] } });

  it('with no result of its own is incomplete, not done', async () => {
    const { rt, link } = await restored([{ type: 'user', uuid: 'u0', message: { role: 'user', content: 'send me the audit' } }, call('t1')]);
    expect(rt.get<ToolItem>('t1')?.status).toBe('cancelled');
    expect(() => link('t1')).toThrow('That file was not shared.');
  });

  it('with its result keeps the outcome, but no download comes of it', async () => {
    const { rt, link } = await restored([call('t2'), answer('t2'), call('t3'), answer('t3', true)]);
    expect(rt.get<ToolItem>('t2')?.status).toBe('done');
    expect(rt.get<ToolItem>('t3')?.status).toBe('error');
    expect(rt.get<ToolItem>('t2')?.handed).toBeUndefined();
    expect(() => link('t2')).toThrow('Ask the agent to share that file again.');
  });
});

describe('a share that goes through', () => {
  it('records the files as they are then, and serves exactly them', () => {
    const { rt, put, share, link } = place();
    const f = put('reports/audit.txt', 'the audit');
    share('s1', ['reports/audit.txt']);
    const handed = rt.get<ToolItem>('s1')!.handed!;
    expect(handed).toHaveLength(1);
    const st = statSync(f);
    expect(handed[0]).toMatchObject({ size: 9, mtimeMs: st.mtimeMs, ino: statSync(f, { bigint: true }).ino.toString(), inside: true });
    expect(link('s1')).toMatchObject({ size: 9, mtimeMs: st.mtimeMs, deviceId: 'phone1' });
  });

  it('a file replaced by another of the same size and time is refused', () => {
    const { cwd, put, share, link } = place();
    const f = put('app.apk', 'build one');
    share('s1', [f]);
    const was = statSync(f);
    // A build writes a new file of the same size and moves it over the shared one, same time stamp.
    const next = put('app.apk.tmp', 'build two');
    utimesSync(next, was.atimeMs / 1000, was.mtimeMs / 1000);
    renameSync(next, path.join(cwd, 'app.apk'));
    expect(statSync(f).size).toBe(was.size);
    expect(() => link('s1')).toThrow('That file changed after it was shared.');
  });

  it('a folder on the way that became a link to another place is refused', () => {
    const { home, cwd, put, share, link } = place();
    put('build/app.apk', 'build one');
    share('s1', ['build/app.apk']);
    // The folder is swapped for a junction to a folder outside with a file of the same name and size.
    const outside = put('elsewhere/app.apk', 'other one', home);
    renameSync(path.join(cwd, 'build'), path.join(cwd, 'build-old'));
    symlinkSync(path.dirname(outside), path.join(cwd, 'build'), 'junction');
    expect(() => link('s1')).toThrow('That file changed after it was shared.');
  });

  it('a file outside the chat folder only when the person allowed that share themselves', async () => {
    const { home, rt, put, share, link } = place();
    const out = put('downloads/report.pdf', 'pdf bytes', home);
    // Allowed by the mode (no one asked): not for a phone.
    share('s1', [out]);
    expect(rt.get<ToolItem>('s1')!.handed![0]).toMatchObject({ inside: false });
    expect(() => link('s1')).toThrow("That file is outside the chat's folder.");
    // The person allowed this one.
    rt.add<ToolItem>({ id: 's2', type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'running', detail: { files: [{ path: out, name: 'report.pdf' }] } });
    const asked = rt.requestPermission({ itemId: 's2', toolName: 'SendUserFile', kind: 'share', title: 'Share report.pdf', detail: { files: [{ path: out, name: 'report.pdf' }] }, options: [{ id: 'allow', label: 'Allow once', tone: 'allow' }, { id: 'deny', label: 'Deny', tone: 'deny' }] });
    rt.answerPermission(rt.prompts().permissions[0].id, { optionId: 'allow' }, { person: true });
    expect(await asked).toEqual({ optionId: 'allow' });
    rt.patch<ToolItem>('s2', { status: 'done' });
    expect(rt.get<ToolItem>('s2')!.handed![0]).toMatchObject({ inside: false, granted: true });
    expect(link('s2').path.toLowerCase()).toBe(out.toLowerCase());
    // A mode answering for the person grants nothing.
    rt.add<ToolItem>({ id: 's3', type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'running', detail: { files: [{ path: out, name: 'report.pdf' }] } });
    const auto = rt.requestPermission({ itemId: 's3', toolName: 'SendUserFile', kind: 'share', title: 'Share report.pdf', detail: {}, options: [{ id: 'allow', label: 'Allow once', tone: 'allow' }] });
    rt.answerPermission(rt.prompts().permissions[0].id, { optionId: 'allow' });
    await auto;
    rt.patch<ToolItem>('s3', { status: 'done' });
    expect(() => link('s3')).toThrow("That file is outside the chat's folder.");
  });

  it('a share loaded as done without going through here authorizes nothing', () => {
    const { rt, put, link } = place();
    put('audit.txt', 'the audit');
    rt.load([{ id: 's1', ts: 1, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'audit.txt', status: 'done', detail: { files: [{ path: 'audit.txt', name: 'audit.txt', size: 9 }] } } as ToolItem]);
    expect(() => link('s1')).toThrow('Ask the agent to share that file again.');
  });
});
