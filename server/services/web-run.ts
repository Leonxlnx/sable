import { Worker } from 'node:worker_threads';

/**
 * Runs a program from a worker thread, so that starting it never holds the bridge's thread (web access's
 * PowerShell runs: the key folder's DACL, the key reads, the look at the networks). Starting a process on
 * Windows is synchronous inside libuv: 6 to 57 ms measured here per PowerShell start, 118 ms once under a
 * test run's load (scratch/day8/web2/hold-parts.mts); three of them in one certificate issue held every
 * chat and socket. The worker starts with the first run, is never what keeps the app alive, and ends
 * after ten seconds with nothing to do. Its standard output comes back as bytes; a failure carries the
 * exit code as `status` (and `killed` when the timeout ended it).
 */
export interface RunFailure extends Error { status?: number; killed?: boolean }

const source = `
const { parentPort } = require('node:worker_threads');
const { execFile } = require('node:child_process');
parentPort.on('message', ({ id, file, args, env, timeout, maxBuffer }) => {
  execFile(file, args, { windowsHide: true, env, encoding: 'buffer', timeout, maxBuffer }, (err, stdout) => {
    if (err) parentPort.postMessage({ id, error: { message: String(err.message), status: typeof err.code === 'number' ? err.code : undefined, killed: !!err.killed } });
    else parentPort.postMessage({ id, stdout });
  });
});`;

type Reply = { id: number; stdout?: Uint8Array; error?: { message: string; status?: number; killed?: boolean } };
type Job = { resolve: (b: Buffer) => void; reject: (e: RunFailure) => void };
interface Thread { worker: Worker; jobs: Map<number, Job>; idle?: NodeJS.Timeout }
let current: Thread | undefined, next = 0;

function thread(): Thread {
  if (current) return current;
  const t: Thread = current = { worker: new Worker(source, { eval: true, execArgv: [] }), jobs: new Map() };
  t.worker.unref();
  t.worker.on('message', (m: Reply) => {
    const job = t.jobs.get(m.id);
    if (!job) return;
    t.jobs.delete(m.id);
    if (m.error) job.reject(Object.assign(new Error(m.error.message), { status: m.error.status, killed: m.error.killed }));
    else job.resolve(Buffer.from(m.stdout ?? new Uint8Array()));
    rest(t);
  });
  // A thread that failed or ended fails only its own runs; the next run starts a new one.
  const gone = (err: Error) => {
    if (current === t) current = undefined;
    clearTimeout(t.idle);
    for (const job of t.jobs.values()) job.reject(err);
    t.jobs.clear();
  };
  t.worker.on('error', gone);
  t.worker.on('exit', () => gone(new Error('The worker that runs programs ended.')));
  return t;
}

/** Ten seconds with nothing to run: the thread goes. */
function rest(t: Thread) {
  clearTimeout(t.idle);
  if (t.jobs.size) return;
  t.idle = setTimeout(() => {
    if (t.jobs.size) return;
    if (current === t) current = undefined;
    void t.worker.terminate();
  }, 10_000);
  t.idle.unref();
}

export function runOff(file: string, args: string[], env: NodeJS.ProcessEnv, opts: { timeout?: number; maxBuffer?: number } = {}): Promise<Buffer> {
  const t = thread();
  clearTimeout(t.idle);
  const id = ++next;
  return new Promise<Buffer>((resolve, reject) => {
    t.jobs.set(id, { resolve, reject });
    t.worker.postMessage({ id, file, args, env: { ...env }, timeout: opts.timeout ?? 60_000, maxBuffer: opts.maxBuffer ?? 1 << 20 });
  });
}
