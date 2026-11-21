import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import readline from 'node:readline';
import { cliCommand } from '../util/proc';
import { killTree } from './codex-rpc';

/**
 * Client for `opencode acp`: the Agent Client Protocol (JSON-RPC 2.0, newline-delimited, over
 * stdio). One process serves every OpenCode session; it is never left orphaned.
 */

export class AcpError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown,
  ) {
    super(message);
  }
}

type Id = number | string;

export interface AcpExit {
  code: number | null;
  signal: string | null;
  stderr: string;
  error?: string;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

/** How to start OpenCode: SABLE_OPENCODE_BIN, else the `opencode` on the PATH. */
export function opencodeCommand(args: string[], env?: NodeJS.ProcessEnv) {
  const full = { ...process.env, ...env };
  const override = process.env.SABLE_OPENCODE_BIN;
  if (override && existsSync(override)) return { file: override, args, shell: false, env: full };
  return { ...cliCommand('opencode', args, full), env: full };
}

export class AcpClient {
  onNotification?: (method: string, params: any) => void;
  /** Return the result; throw to answer with a JSON-RPC error. */
  onRequest?: (method: string, params: any) => Promise<unknown>;
  onExit?: (info: AcpExit) => void;

  alive = true;
  /** The `initialize` answer: capabilities, agent name and version. */
  init: any;
  private nextId = 1;
  private pending = new Map<Id, Pending>();
  private stderrTail = '';
  private exited: Promise<void>;

  private constructor(
    private child: ChildProcess,
    private log: (...a: unknown[]) => void,
  ) {
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this.onLine(line));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    child.stdin!.on('error', () => {
      /* EPIPE when the child died: 'exit' reports it */
    });
    let spawnError: string | undefined;
    this.exited = new Promise((resolve) => {
      child.once('error', (err) => {
        spawnError = err.message;
        if (child.pid === undefined) this.handleExit(null, null, spawnError, resolve);
      });
      child.once('exit', (code, signal) => this.handleExit(code, signal, spawnError, resolve));
    });
    live.add(child);
    installExitHook();
  }

  private handleExit(code: number | null, signal: string | null, error: string | undefined, done: () => void) {
    if (!this.alive) return done();
    this.alive = false;
    live.delete(this.child);
    const err = new AcpError(`opencode exited${code !== null ? ` (code ${code})` : signal ? ` (${signal})` : ''}${error ? `: ${error}` : ''}`);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.onExit?.({ code, signal, stderr: this.stderrTail, error });
    done();
  }

  static async start(opts: { log: (...a: unknown[]) => void; clientVersion: string; env?: NodeJS.ProcessEnv }): Promise<AcpClient> {
    const cmd = opencodeCommand(['acp'], opts.env);
    opts.log('[opencode] spawning', cmd.file, cmd.args.join(' '));
    const child = spawn(cmd.file, cmd.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: cmd.shell, env: cmd.env });
    const acp = new AcpClient(child, opts.log);
    try {
      acp.init = await acp.request(
        'initialize',
        {
          protocolVersion: 1,
          // Sable reads and writes nothing for the agent: OpenCode uses its own tools.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'sable', title: 'Sable', version: opts.clientVersion },
        },
        30_000,
      );
    } catch (err) {
      await acp.close();
      const tail = acp.stderrTail.trim().split('\n').slice(-3).join('\n');
      throw new Error(`Could not start OpenCode: ${(err as Error).message}${tail ? `\n${tail}` : ''}`);
    }
    return acp;
  }

  get stderr() {
    return this.stderrTail;
  }

  private write(msg: unknown) {
    if (!this.alive || !this.child.stdin?.writable) throw new AcpError('OpenCode is not running');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(msg as object) }) + '\n');
  }

  /** A request. `timeoutMs` 0 waits as long as it takes (a prompt runs for minutes). */
  request<T = any>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new AcpError(`OpenCode ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params?: unknown) {
    try {
      this.write({ method, params });
    } catch {
      /* dead process: ignore */
    }
  }

  private respond(msg: unknown) {
    try {
      this.write(msg);
    } catch {
      /* ignore */
    }
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log('[opencode] unparseable line:', line.slice(0, 200));
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string') {
      if (hasId) void this.handleRequest(msg.id, msg.method, msg.params);
      else {
        try {
          this.onNotification?.(msg.method, msg.params ?? {});
        } catch (err) {
          this.log('[opencode] notification handler failed', msg.method, err);
        }
      }
      return;
    }
    if (!hasId) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new AcpError(String(msg.error.message ?? 'OpenCode error'), msg.error.code, msg.error.data));
    else p.resolve(msg.result);
  }

  private async handleRequest(id: Id, method: string, params: unknown) {
    if (!this.onRequest) return this.respond({ id, error: { code: -32601, message: `Unsupported: ${method}` } });
    try {
      this.respond({ id, result: await this.onRequest(method, params ?? {}) });
    } catch (err) {
      const e = err as AcpError;
      this.respond({ id, error: { code: typeof e.code === 'number' ? e.code : -32603, message: e.message || 'client error' } });
    }
  }

  /** Graceful stop: close stdin (the server exits on EOF), then force-kill the tree. */
  async close(graceMs = 1500) {
    if (!this.alive) return;
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    await Promise.race([this.exited, new Promise<void>((r) => setTimeout(r, graceMs).unref())]);
    if (this.alive) killTree(this.child);
    await Promise.race([this.exited, new Promise<void>((r) => setTimeout(r, 1000).unref())]);
  }
}

const live = new Set<ChildProcess>();
let hooked = false;
function installExitHook() {
  if (hooked) return;
  hooked = true;
  process.once('exit', () => {
    for (const c of live) killTree(c);
  });
}
