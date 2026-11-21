/**
 * Smoke test for the OpenCode adapter against the real `opencode acp`.
 *
 *   pnpm exec tsx scripts/opencode-smoke.ts            # info, caps, history (no turns)
 *   pnpm exec tsx scripts/opencode-smoke.ts --turn     # one small turn with a free model (reads and writes in a temp folder), then a resume
 *   pnpm exec tsx scripts/opencode-smoke.ts --interrupt
 *
 * A turn uses the model named by SMOKE_MODEL (default: OpenCode's free Tidepool model).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionMeta, TimelineItem } from '../shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { OpenCodeProvider } from '../server/providers/opencode';

const args = new Set(process.argv.slice(2));
const clip = (s: string, n = 110) => (s.replace(/\s+/g, ' ').length > n ? s.replace(/\s+/g, ' ').slice(0, n) + '…' : s.replace(/\s+/g, ' '));
const ctx = { emit: () => {}, log: (...a: unknown[]) => console.log('  [log]', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))) };

function makeRuntime(cwd: string, extra: Partial<SessionMeta> = {}): SessionRuntime {
  const now = Date.now();
  const meta: SessionMeta = { id: `smoke-${now}`, provider: 'opencode', cwd, title: 'New session', titleSource: 'auto', model: '', mode: 'build', status: 'starting', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...extra };
  return new SessionRuntime(meta, () => {}, () => {});
}

const waitIdle = (rt: SessionRuntime, ms = 240_000) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('turn did not end in time')), ms);
    const tick = setInterval(() => {
      if (!rt.turnActive) (clearTimeout(t), clearInterval(tick), resolve());
    }, 100);
  });

function print(items: TimelineItem[]) {
  console.log(`\n== timeline (${items.length} items)`);
  for (const i of items) {
    if (i.type === 'user') console.log(`  user[${i.state}]: ${clip(i.text)}`);
    else if (i.type === 'text') console.log(`  text${i.streaming ? ' (STILL STREAMING)' : ''}: ${clip(i.text)}`);
    else if (i.type === 'thinking') console.log(`  thinking${i.streaming ? ' (STILL STREAMING)' : ''}: ${clip(i.text, 70)}`);
    else if (i.type === 'tool') console.log(`  tool ${i.kind}/${i.name} [${i.status}] "${i.title}" detail=${clip(JSON.stringify(i.detail), 90)} result=${clip(JSON.stringify(i.result ?? null), 140)}`);
    else if (i.type === 'notice') console.log(`  notice(${i.variant}): ${i.text}`);
    else if (i.type === 'turn') console.log(`  turn: ${i.durationMs}ms in=${i.inputTokens ?? '-'} out=${i.outputTokens ?? '-'} stop=${i.stopReason}${i.error ? ` error=${i.error}` : ''}`);
  }
}

const cwd = mkdtempSync(path.join(os.tmpdir(), 'sable-opencode-'));
const provider = new OpenCodeProvider(ctx);
try {
  console.log('== info()');
  console.log(JSON.stringify(await provider.info(true)));
  console.log('\n== caps()');
  const caps = await provider.caps(cwd);
  console.log(JSON.stringify({ models: caps.models.length, sample: caps.models.slice(0, 6).map((m) => `${m.id} → ${m.name}`), efforts: caps.models[0]?.efforts, modes: caps.modes.map((m) => `${m.id}:${m.tone}`), commands: caps.commands.map((c) => c.name), features: caps.features }));
  console.log('\n== history()');
  const history = await provider.history(undefined, 5);
  console.log(history.map((h) => `${h.title} (${h.cwd})`));

  if (args.has('--turn') || args.has('--interrupt')) {
    writeFileSync(path.join(cwd, 'note.txt'), 'hello world\n');
    const model = process.env.SMOKE_MODEL ?? 'opencode/tidepool-alpha-free';
    const rt = makeRuntime(cwd, { model });
    const session = await provider.open(rt, {});
    rt.handle = session;
    console.log('\n== opened', rt.meta.providerSessionId, 'model', rt.meta.model);
    const text = args.has('--interrupt') ? 'Write a long essay about the history of the compass, at least 800 words.' : 'Read note.txt, create copy.txt with the same text using your write tool, then say done in one short sentence.';
    const user = rt.add({ type: 'user', text, state: 'sent' } as never);
    await session.send(user as never);
    if (args.has('--interrupt')) {
      await new Promise((r) => setTimeout(r, 6000));
      await session.interrupt();
    }
    await waitIdle(rt);
    print(rt.items);
    console.log('\nusage', JSON.stringify(rt.meta.usage), 'todos', rt.todos.length, 'status', rt.meta.status);
    const id = rt.meta.providerSessionId!;
    await session.close();

    console.log('\n== resume with transcript');
    const rt2 = makeRuntime(cwd, { providerSessionId: id, model });
    const s2 = await provider.open(rt2, { loadTranscript: true });
    print(rt2.items);
    console.log('title', rt2.meta.title);
    await s2.close();
    // The conversation belongs to this temporary folder only: remove it from OpenCode.
    const acp = await provider.client();
    await acp.request('session/delete', { sessionId: id }, 15_000).catch(() => {});
  }
} finally {
  await provider.dispose();
  rmSync(cwd, { recursive: true, force: true });
}
process.exit(0);
