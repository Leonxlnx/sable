/**
 * A share the person allowed grants a phone only the files they were shown (review wave 3, #5): the
 * approval captures the listed files' real places and identities when the permission is presented,
 * and the completed share must be exactly those before a file outside the chat's folder is granted.
 * A link retargeted, a file replaced or a file added between the approval and the result is not.
 * Fakes only: no agent process starts.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMeta, ToolItem } from '@shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { grantFor } from '../server/services/phone-guard';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function place() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-share-ok-'));
  homes.push(home);
  const cwd = path.join(home, 'chat');
  mkdirSync(cwd);
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'claude', cwd, title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, () => {}, () => {});
  const put = (rel: string, body: string) => {
    const f = path.join(home, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
    utimesSync(f, 1_700_000_000, 1_700_000_000);
    return f;
  };
  /** The agent asks to share `files`; the person allows it (or not); `meanwhile` runs before the result; then it goes through. */
  const share = async (id: string, files: string[], meanwhile?: () => void, completed = files) => {
    const list = (fs: string[]) => fs.map((p) => ({ path: p, name: path.basename(p) }));
    rt.add<ToolItem>({ id, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'pending', detail: { files: list(files) } });
    const asked = rt.requestPermission({ itemId: id, toolName: 'SendUserFile', kind: 'share', title: 'Share', detail: { files: list(files) }, options: [{ id: 'allow', label: 'Allow once', tone: 'allow' }, { id: 'deny', label: 'Deny', tone: 'deny' }] });
    rt.answerPermission(rt.prompts().permissions[0].id, { optionId: 'allow' }, { person: true });
    await asked;
    meanwhile?.();
    rt.patch<ToolItem>(id, { status: 'done', detail: { files: list(completed) } });
    return rt.get<ToolItem>(id)!.handed!;
  };
  const link = (id: string, index = 0) => grantFor({ session: rt.meta, items: rt.items }, id, index, 'phone1');
  return { home, cwd, rt, put, share, link };
}

describe('#5: an allowed share grants only the files the person was shown', () => {
  it('a link retargeted between the approval and the result grants nothing outside', async () => {
    const { home, put, share, link } = place();
    put('reports-a/report.pdf', 'report one');
    put('reports-b/report.pdf', 'report two');
    const via = path.join(home, 'latest');
    symlinkSync(path.join(home, 'reports-a'), via, 'junction');
    const handed = await share('s1', [path.join(via, 'report.pdf')], () => {
      // The junction now leads to another folder with a report of the same name and size.
      unlinkSync(via);
      symlinkSync(path.join(home, 'reports-b'), via, 'junction');
    });
    expect(handed[0]?.path.toLowerCase()).toContain('reports-b');
    expect(handed[0]?.granted).toBeUndefined();
    expect(() => link('s1')).toThrow("That file is outside the chat's folder.");
  });

  it('a file replaced by another of the same size and time grants nothing; the one shown, unchanged, does', async () => {
    const { home, put, share, link } = place();
    const f = put('downloads/report.pdf', 'the report');
    const handed = await share('s1', [f], () => {
      const next = put('downloads/report.next', 'another!!!');
      renameSync(next, f);
      expect(statSync(f).size).toBe(10);
    });
    expect(handed[0]?.granted).toBeUndefined();
    expect(() => link('s1')).toThrow("That file is outside the chat's folder.");
    // Unchanged from the approval to the result: granted.
    const ok = await share('s2', [put('downloads/other.pdf', 'other report')]);
    expect(ok[0]).toMatchObject({ inside: false, granted: true });
    expect(link('s2').path.toLowerCase()).toBe(path.join(home, 'downloads', 'other.pdf').toLowerCase());
  });

  it('a file the person was not shown is not granted, even beside one they were', async () => {
    const { put, share, link } = place();
    const shown = put('out/a.txt', 'shown');
    const extra = put('out/b.txt', 'never shown');
    const handed = await share('s1', [shown], undefined, [shown, extra]);
    expect(handed[0]).toMatchObject({ granted: true });
    expect(handed[1]?.granted).toBeUndefined();
    expect(link('s1', 0).name).toBe('a.txt');
    expect(() => link('s1', 1)).toThrow("That file is outside the chat's folder.");
  });
});
