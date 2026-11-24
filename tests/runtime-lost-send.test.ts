import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ToolItem } from '@shared/protocol';
import { App } from '../server/app';
import type { SessionRuntime } from '../server/core/runtime';
import { DemoProvider } from '../server/providers/demo';

it('a rejected send leaves the lost-task note for the first accepted send after restart', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-lost-send-'));
  const sent: string[] = [];
  let reject = true;
  class Demo extends DemoProvider {
    override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }) {
      const session = await super.open(rt, opts);
      session.send = async (item) => {
        sent.push(item.text);
        if (reject) throw new Error('Demo refused the send');
      };
      return session;
    }
  }
  const start = () => new App({ home, userHome: home, quiet: true, providers: [(ctx) => new Demo(ctx, { speed: 0 })] });
  let app = start();
  try {
    const { session } = await app.call('session.create', { provider: 'demo', cwd: home });
    const rt = app.runtime(session.id);
    const step = rt.add<ToolItem>({ type: 'tool', kind: 'bash', name: 'Bash', title: 'Check build', status: 'done', detail: {} });
    rt.taskStarted(step.id, { id: 'build1', kind: 'command' });
    rt.tasksLost('move');
    const send = (text: string) => app.call('session.send', { sessionId: session.id, text });
    const task = '"Check build" (command, task build1)';
    await send('first attempt');
    expect(sent.at(-1)).toContain(task);
    await app.dispose();
    reject = false;
    app = start();
    await send('retry');
    expect(sent.at(-1)).toContain(task);
    await app.dispose();
    app = start();
    await send('after acceptance');
    expect(sent.at(-1)).toBe('after acceptance');
  } finally {
    await app.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
