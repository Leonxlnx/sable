import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type * as SDK from '@anthropic-ai/claude-agent-sdk';

type HistoryMethod = 'getSessionMessages' | 'listSessions' | 'forkSession';
type Filter = { issued?: Set<string>; tools?: Set<string>; deliveries?: Set<string> };

function sdkUrl() {
  const bundle = new URL('./sdk.cjs', import.meta.url);
  return existsSync(fileURLToPath(bundle)) ? bundle.href
    : pathToFileURL(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')).href;
}

// Keep the worker self-contained in the packaged desktop bundle. Only matching receipt
// candidates cross back to the bridge. The existing receipt verifier checks their exact bodies.
const reader = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { url, method, args, filter } = workerData;
  (async () => {
    const mod = await import(url);
    const sdk = mod.default?.sdk ?? mod;
    let rows = await sdk[method](...args);
    if (filter) rows = rows.flatMap(row => {
      if (row.type !== 'user' || row.parent_tool_use_id) return [];
      if (filter.issued) return filter.issued.has(row.uuid) ? [{ type: 'user', uuid: row.uuid }] : [];
      const content = row.message?.content;
      const marked = text => typeof text === 'string' && text.includes('Delivery ID:') &&
        [...filter.deliveries].some(id => text.includes(id));
      if (marked(content)) return [{ type: 'user', message: { content } }];
      if (!Array.isArray(content)) return [];
      const blocks = content.filter(block => block?.type === 'text' && marked(block.text) ||
        block?.type === 'tool_result' && (filter.tools.has(block.tool_use_id) ||
          JSON.stringify(block.content ?? '').includes('[Sable delegate receipt ')));
      return blocks.length ? [{ type: 'user', message: { content: blocks } }] : [];
    });
    parentPort.postMessage({ rows });
  })().catch(error => parentPort.postMessage({ error: String(error) }));
`;

export function claudeHistory<M extends HistoryMethod>(method: M, args: Parameters<typeof SDK[M]>,
  env: NodeJS.ProcessEnv, signal: AbortSignal, filter?: Filter, url = sdkUrl()): ReturnType<typeof SDK[M]> {
  signal.throwIfAborted();
  const worker = new Worker(reader, { eval: true, execArgv: [], env, workerData: { method, args, filter, url } });
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', reply => reply.error ? reject(Error(reply.error)) : resolve(reply.rows));
    worker.once('error', reject);
    worker.once('exit', code => reject(Error('Claude history reader exited (' + code + ').')));
    worker.once('exit', () => signal.removeEventListener('abort', abort));
  }).finally(() => { void worker.terminate().catch(() => {}); }) as ReturnType<typeof SDK[M]>;
}
