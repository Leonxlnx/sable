import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { InitializeParams, InitializeResponse, RequestId } from './codex-types';
import { homedir } from 'node:os';
import { authGate, gateKey, GATE } from '../core/auth-gate';
import type { AuthScope, EndReason } from '../core/auth-journal';
import { cliCommand, killTree as stopTree } from '../util/proc';
import { trustedPathDirs } from '../util/which';

/**
 * JSON-RPC client for `codex app-server` (newline-delimited JSON over stdio, no
 * "jsonrpc" field). Owns the child process; never leaves it orphaned.
 */

export class RpcError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown,
  ) {
    super(message);
  }
}

export interface CodexCommand {
  file: string;
  args: string[];
  shell: boolean;
  env: NodeJS.ProcessEnv;
}

// ── process bookkeeping ──

const live = new Set<ChildProcess>();
const servers = new Map<string, CodexRpc>();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 'exit' handlers must be synchronous: taskkill via spawnSync / kill() both are.
  process.once('exit', () => {
    const children = [...live].filter(c => c.pid && c.exitCode === null && c.signalCode === null);
    if (process.platform === 'win32' && children.length) {
      // One bounded cleanup for every remaining tree, even with many accounts.
      try { spawnSync('taskkill', [...children.flatMap(c => ['/pid', String(c.pid)]), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 1000 }); }
      catch { /* fall back to each root below */ }
    }
    for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  });
}

/** Kills the process and (on Windows) its whole tree. Synchronous. */
export function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } catch {
      /* fall through */
    }
    if (child.exitCode === null) child.kill();
  } else {
    child.kill('SIGTERM');
  }
}

// ── binary resolution ──

function winTarget(): { pkg: string; triple: string } | null {
  if (process.arch === 'x64') return { pkg: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' };
  if (process.arch === 'arm64') return { pkg: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' };
  return null;
}

/**
 * On Windows `codex` is an npm shim (cmd → node codex.js → codex.exe). Spawning the
 * shim through a shell leaves a cmd/node/exe chain whose leaf survives a plain kill,
 * so resolve the native binary the launcher would run and spawn it directly.
 */
export function resolveCodexCommand(args: string[], extraEnv?: Record<string, string>): CodexCommand {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const override = process.env.SABLE_CODEX_BIN;
  if (override && existsSync(override)) return { file: override, args, shell: false, env };
  if (process.platform !== 'win32') return { file: 'codex', args, shell: false, env };

  const target = winTarget();
  const dirs = trustedPathDirs(process.env.PATH ?? process.env.Path ?? '', 'win32');
  for (const dir of dirs) {
    if (existsSync(path.join(dir, 'codex.cmd')) && target) {
      const pkgRoot = path.join(dir, 'node_modules', '@openai', 'codex');
      const candidates = [
        path.join(pkgRoot, 'node_modules', '@openai', target.pkg, 'vendor', target.triple, 'bin', 'codex.exe'),
        path.join(dir, 'node_modules', '@openai', target.pkg, 'vendor', target.triple, 'bin', 'codex.exe'),
        path.join(pkgRoot, 'vendor', target.triple, 'bin', 'codex.exe'),
      ];
      const exe = candidates.find((c) => existsSync(c));
      if (exe) {
        try {
          env.CODEX_MANAGED_PACKAGE_ROOT = realpathSync(pkgRoot);
        } catch {
          /* ignore */
        }
        env.CODEX_MANAGED_BY_NPM = '1';
        return { file: exe, args, shell: false, env };
      }
    }
    const direct = path.join(dir, 'codex.exe');
    if (existsSync(direct)) return { file: direct, args, shell: false, env };
  }
  // Last resort: let the shell resolve the shim, as one command string (no DEP0190). killTree() uses taskkill /T for this.
  return { ...cliCommand('codex', args, env), env };
}

// ── client ──

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  stderr: string;
  error?: string;
}

export class CodexRpc {
  onNotification?: (method: string, params: any) => void;
  /** Return the result; throw to send a JSON-RPC error. */
  onRequest?: (method: string, params: any, id: RequestId) => Promise<unknown>;
  onExit?: (info: ExitInfo) => void;

  alive = true;
  initInfo?: InitializeResponse;
  private born = Date.now();
  private endReason?: EndReason;
  private forced = false;
  private endEvent?: (reason: EndReason, inFlight: boolean) => void;
  private turns = new Set<string>();
  private overdue = new Set<RequestId>();
  private answering = 0;
  get hasTurn() { return this.turns.size > 0; }
  get inFlight() { return this.pending.size > 0 || this.overdue.size > 0 || this.answering > 0 || this.hasTurn; }
  get ended() { return this.exited; }
  get pid() { return this.child.pid; }
  private nextId = 1;
  private pending = new Map<RequestId, Pending>();
  private stderrTail = '';
  private exited: Promise<void>;

  private constructor(
    private child: ChildProcess,
    private log: (...a: unknown[]) => void,
  ) {
    live.add(child);
    installExitHook();
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this.onLine(line));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    child.stdin!.on('error', () => {
      /* EPIPE when the child died; handled by 'exit' */
    });
    let spawnError: string | undefined;
    this.exited = new Promise((resolve) => {
      child.once('error', (err) => {
        spawnError = err.message;
        // 'exit' may not follow a spawn failure.
        if (child.pid === undefined) this.handleExit(null, null, spawnError, resolve);
      });
      child.once('exit', (code, signal) => this.handleExit(code, signal, spawnError, resolve));
    });
  }

  private handleExit(code: number | null, signal: string | null, error: string | undefined, done: () => void) {
    if (!this.alive) return done();
    this.alive = false;
    live.delete(this.child);
    this.endEvent?.(this.endReason ?? (code === 0 ? 'exit' : 'error'), this.inFlight);
    const err = new RpcError(`codex app-server exited${code !== null ? ` (code ${code})` : signal ? ` (${signal})` : ''}${error ? `: ${error}` : ''}`);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.onExit?.({ code, signal, stderr: this.stderrTail, error });
    done();
  }

  static async start(opts: {
    log: (...a: unknown[]) => void;
    clientVersion: string;
    folder?: string;
    scope?: AuthScope;
    closing?: () => boolean;
    env?: Record<string, string>;
    /** Opt into experimental methods (remote control lives there). */
    experimental?: boolean;
    /** Extra `-c key=value` config overrides for this app-server process. */
    config?: string[];
  }): Promise<CodexRpc> {
    const cmd = resolveCodexCommand(['app-server', ...(opts.config ?? []).flatMap((c) => ['-c', c])], opts.env);
    const folder = opts.folder ?? gateKey('codex', cmd.env.CODEX_HOME || path.join(homedir(), '.codex'));
    const leave = await authGate.enter(folder, 'start', opts.scope);
    let child: ChildProcess;
    try {
      if (opts.closing?.()) throw new Error('Codex provider is shut down');
      const previous = servers.get(folder);
      if (previous?.forced && previous.alive) {
        previous.child.kill('SIGKILL');
        await Promise.race([previous.ended, new Promise<void>(r => setTimeout(r, 1000).unref())]);
        if (previous.alive) throw new Error('This Codex folder is already in use by a process that has not exited. Try again.');
        if (opts.closing?.()) throw new Error('Codex provider is shut down');
      }
      if (servers.has(folder)) throw new Error('This Codex folder is already in use by another Sable account.');
      opts.log('[codex] spawning', cmd.file, cmd.args.join(' '));
      child = spawn(cmd.file, cmd.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: cmd.shell,
        env: cmd.env,
      });
    } catch (err) {
      leave();
      throw err;
    }
    const rpc = new CodexRpc(child, opts.log);
    servers.set(folder, rpc);
    if (child.pid && opts.scope) rpc.endEvent = opts.scope.journal?.started(opts.scope, folder, child.pid, () => rpc.inFlight, rpc.born);
    void rpc.exited.then(() => { servers.delete(folder); leave(); });
    const params: InitializeParams = {
      clientInfo: { name: 'sable', title: 'Sable', version: opts.clientVersion },
      capabilities: {
        experimentalApi: !!opts.experimental,
        requestAttestation: false,
        optOutNotificationMethods: ['rawResponseItem/completed', 'rawResponse/completed', ...(opts.experimental ? [] : ['remoteControl/status/changed'])],
      },
    };
    try {
      rpc.initInfo = await rpc.request<InitializeResponse>('initialize', params, 30_000);
      rpc.notify('initialized');
      setTimeout(leave, GATE.settleMs).unref();
    } catch (err) {
      await rpc.close(undefined, rpc.overdue.size ? 'timeout' : 'error');
      const tail = rpc.stderrTail.trim().split('\n').slice(-3).join('\n');
      throw new Error(`Could not start codex app-server: ${(err as Error).message}${tail ? `\n${tail}` : ''}`);
    }
    return rpc;
  }

  get stderr() {
    return this.stderrTail;
  }

  private write(msg: unknown) {
    if (!this.alive || !this.child.stdin?.writable) throw new RpcError('codex app-server is not running');
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.endReason) return Promise.reject(new RpcError('Codex app-server is closing'));
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.overdue.add(id);
        reject(new RpcError(`codex ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.write(params === undefined ? { id, method } : { id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params?: unknown) {
    try {
      this.write(params === undefined ? { method } : { method, params });
    } catch {
      /* dead process: ignore */
    }
  }

  private respond(id: RequestId, result: unknown) {
    try {
      this.write({ id, result });
    } catch {
      /* ignore */
    }
  }

  private respondError(id: RequestId, code: number, message: string) {
    try {
      this.write({ id, error: { code, message } });
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
      this.log('[codex] unparseable line:', line.slice(0, 200));
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string') {
      if (hasId) void this.handleRequest(msg.id, msg.method, msg.params);
      else {
        try {
          const id = msg.params?.turn?.id;
          if (typeof id === 'string') {
            if (msg.method === 'turn/started') this.turns.add(id);
            if (msg.method === 'turn/completed') this.turns.delete(id);
          }
          this.onNotification?.(msg.method, msg.params ?? {});
        } catch (err) {
          this.log('[codex] notification handler failed', msg.method, err);
        }
      }
      return;
    }
    if (!hasId) return;
    this.overdue.delete(msg.id);
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(String(msg.error.message ?? 'codex error'), msg.error.code, msg.error.data));
    else p.resolve(msg.result);
  }

  private async handleRequest(id: RequestId, method: string, params: unknown) {
    if (!this.onRequest) return this.respondError(id, -32601, `Unsupported: ${method}`);
    this.answering++;
    try {
      const result = await this.onRequest(method, params ?? {}, id);
      this.respond(id, result);
    } catch (err) {
      const e = err as RpcError;
      this.respondError(id, typeof e.code === 'number' ? e.code : -32603, e.message || 'client error');
    } finally { this.answering--; }
  }

  /** Graceful stop: close stdin (app-server exits on EOF), then force-kill the tree. */
  async close(graceMs = 1500, reason: EndReason = 'close') {
    this.endReason = reason;
    const drainUntil = reason === 'timeout' || reason === 'error' ? 0 : Date.now() + GATE.lingerMs;
    while (this.alive && (this.inFlight && Date.now() < drainUntil || Date.now() - this.born < GATE.minLifeMs)) {
      await new Promise<void>(resolve => setTimeout(resolve, 50).unref());
    }
    if (!this.alive) return;
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    const timer = new Promise<void>((r) => setTimeout(r, graceMs).unref());
    await Promise.race([this.exited, timer]);
    if (this.alive) {
      this.forced = true;
      stopTree(this.child);
    }
    await Promise.race([this.exited, new Promise<void>((r) => setTimeout(r, 1000).unref())]);
    if (this.alive) {
      this.child.kill('SIGKILL');
      await Promise.race([this.exited, new Promise<void>((r) => setTimeout(r, 1000).unref())]);
    }
  }
}
