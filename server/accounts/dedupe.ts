import { lstat, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { DEFAULT_ACCOUNT, type SessionMeta } from '../../shared/protocol';
import type { App } from '../app';
import { NotAFile, openContained } from '../core/contain';
import { accountRoot, checkedPair, currentFile, directory, prefix, projectSide, regular, resolveRoot, safeId, sameFile, sideFiles,
  transcriptArea, transcriptIndex, unchanged, Unproven, UnsafePath, withPair, type Agent, type Pair, type Root, type Stamp } from './conversation-files';

interface Ref { chat: string; agent: Agent; id: string; account: string }
const reasons = ['busy', 'no current file', 'old current file', 'unproven copy', 'unsafe path', 'error'] as const;
type Reason = typeof reasons[number];
class Skipped extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}

function skipReason(err: unknown): Reason {
  if (err instanceof Skipped) return err.reason;
  if (err instanceof Unproven) return 'unproven copy';
  if (err instanceof UnsafePath || err instanceof NotAFile) return 'unsafe path';
  return 'error';
}

function report() {
  return { files: 0, bytes: 0, dirs: 0, looked: new Set<string>(), skipped: new Map<string, Reason>() };
}
type Report = ReturnType<typeof report>;
const refKey = (r: Ref) => JSON.stringify([r.chat, r.agent, r.id, r.account]);
const MAX_AGE = 20 * 24 * 60 * 60_000;

function refs(m: SessionMeta): Ref[] {
  // The current agent's saved leg is a snapshot from when the chat last LEFT it.
  const legs = [m, ...(m.agents ?? []).filter(l => l.provider !== m.provider)];
  return legs.flatMap(l => (l.provider === 'claude' || l.provider === 'codex') && typeof l.providerSessionId === 'string' && l.providerSessionId
    ? [{ chat: m.id, agent: l.provider, id: l.providerSessionId, account: l.accountId ?? DEFAULT_ACCOUNT }] : []);
}

async function savedRefs(dir: string) {
  const root = await accountRoot(dir);
  if (!root) return [];
  const file = path.join(root, 'state.json');
  if (!await regular(root, file)) return [];
  const registry = await openContained(file, root, true);
  let contents: string;
  try {
    if (!registry.inside) throw new UnsafePath();
    contents = await registry.fh.readFile('utf8');
  } finally { await registry.fh.close(); }
  const saved: { sessions: SessionMeta[] } = JSON.parse(contents);
  const owners = new Map<string, { ref: Ref; ambiguous: boolean }>();
  for (const meta of saved.sessions) for (const ref of refs(meta)) {
    const key = ref.agent + '/' + ref.id.toLowerCase();
    owners.set(key, { ref, ambiguous: owners.has(key) });
  }
  return [...owners.values()];
}

interface Areas { account?: Root; main?: Root; history?: Root }
const identity = (s: Stamp) => s.dev + '/' + s.ino;

// Resolve each configured account and conversation area once per pass.
function scan(only: string | undefined, check: () => void) {
  const roots = new Map<string, ReturnType<typeof resolveRoot>>();
  const root = (home: string) => {
    if (!roots.has(home)) roots.set(home, resolveRoot(home));
    return roots.get(home)!;
  };
  const indices = new Map<string, ReturnType<typeof transcriptIndex>>();
  return {
    async areas(home: string, agent: Agent): Promise<Areas> {
      const account = await root(home);
      if (!account) return {};
      const main = await root(path.join(account.dir, transcriptArea(agent)));
      const history = agent === 'claude' ? await root(path.join(account.dir, 'file-history')) : undefined;
      return { account, main, history };
    },
    async mains(ref: Ref, root: string) {
      const key = ref.agent + '/' + root;
      if (!indices.has(key)) indices.set(key, transcriptIndex(ref.agent, root, check, only));
      return (await indices.get(key)!)(ref.id);
    },
  };
}
type Scan = ReturnType<typeof scan>;

// A physical area can belong to several older accounts with different folders for the other area.
function olderAreas(current: Areas, others: Areas[], area: 'main' | 'history') {
  const groups = new Map<string, { root: Root; accounts: Areas[] }>();
  for (const account of others) {
    const root = account[area], kept = current[area];
    if (!root || kept && sameFile(root.stamp, kept.stamp)) continue;
    const key = identity(root.stamp);
    const group = groups.get(key);
    if (group) group.accounts.push(account);
    else groups.set(key, { root, accounts: [account] });
  }
  return groups;
}

async function checkPairPaths(p: Pair) {
  if (!currentFile(p.destinationStat, await regular(p.current, p.dst), p.appending) ||
    !unchanged(p.sourceStat, await regular(p.old, p.src))) throw new Unproven();
}

// Preflight all accounts before the first unlink. Delete primary transcripts last so a
// locked side file leaves its transcript in place for another pass.
async function removeCopies(ref: Ref, current: Areas, others: Areas[], pass: Scan, check: () => void,
  validateRoots: () => Promise<void>, owned: () => void, totals: Report, justCarried: boolean) {
  const oldMains = olderAreas(current, others, 'main'), oldHistories = olderAreas(current, others, 'history');
  if (!oldMains.size && !oldHistories.size) return;
  const currentMain = current.main;
  if (!currentMain) throw new Skipped('no current file');
  const area = currentMain.dir;
  const mains = await pass.mains(ref, area);
  if (!mains.length) throw new Skipped('no current file');
  const anchors = new Map<string, Stamp>();
  for (const rel of mains) {
    const file = path.join(area, rel), st = await regular(area, file);
    if (!st) throw new Skipped('no current file');
    if (!justCarried && Number(st.mtimeMs) < Date.now() - MAX_AGE) throw new Skipped('old current file');
    anchors.set(file, st);
  }
  if (ref.agent === 'claude') {
    await sideFiles(area, mains.map(rel => projectSide(rel, ref.id)), check);
    if (current.history) await sideFiles(current.history.dir, [ref.id], check);
  }
  const primary: Pair[] = [], side: Pair[] = [];
  const dirs: { root: string; path: string; stamp: Stamp }[] = [];
  const absentMains: { root: string; file: string }[] = [];
  const provenAreas = new Set<string>();
  let unprovenSide = false;
  const compareSides = async (old: string, dest: string | undefined, folder: string, direction: 'proven' | 'absent' | 'shared') => {
    const tree = await sideFiles(old, [folder], check);
    if (!justCarried && direction === 'shared') {
      if (tree.files.length) unprovenSide = true;
      return;
    }
    for (const rel of tree.files) {
      const p = dest && await checkedPair(old, dest, rel);
      const equal = p && p.sourceStat.size === p.destinationStat.size;
      if (p && (rel.endsWith('.jsonl') ? justCarried || direction === 'proven' || !equal : equal) && await prefix(p, check)) side.push(p);
      else if (justCarried) throw new Unproven();
      else unprovenSide = true;
    }
    if (!dest) return;
    for (const rel of tree.dirs) {
      const dir = path.join(old, rel), twin = path.join(dest, rel);
      if (!await directory(dest, twin)) continue;
      const stamp = await lstat(dir, { bigint: true });
      if (sameFile(stamp, await lstat(twin, { bigint: true }))) throw new UnsafePath();
      dirs.push({ root: old, path: dir, stamp });
    }
  };
  for (const [areaId, { root }] of oldMains) {
    check();
    const old = root.dir;
    const proofs = new Map<string, Stamp>();
    for (const rel of await pass.mains(ref, old)) {
      const p = await checkedPair(old, area, rel, justCarried);
      // Opposing sweeps cannot both prove a strictly longer primary.
      if (!p || !justCarried && p.sourceStat.size === p.destinationStat.size || !await prefix(p, check)) throw new Unproven();
      primary.push(p);
      proofs.set(identity(p.sourceStat), p.sourceStat);
    }
    if (ref.agent !== 'claude') continue;
    if (proofs.size) provenAreas.add(areaId);
    for (const rel of mains) {
      const file = path.join(old, rel), stamp = await regular(old, file);
      // Match the actual file in this key, including differently cased names on Windows.
      if (stamp && !unchanged(stamp, proofs.get(identity(stamp)))) throw new Unproven();
      if (!stamp) absentMains.push({ root: old, file });
      await compareSides(old, area, projectSide(rel, ref.id), stamp ? 'proven' : 'absent');
    }
  }
  for (const { root, accounts } of oldHistories.values()) {
    // History is per conversation, outside the project keys. Every account sharing this
    // older history must agree on the direction before using equality for a side transcript.
    const sharedMain = accounts.some(a => a.main && sameFile(a.main.stamp, currentMain.stamp));
    const proven = accounts.every(a => a.main && provenAreas.has(identity(a.main.stamp)));
    await compareSides(root.dir, current.history?.dir, ref.id, sharedMain ? 'shared' : proven ? 'proven' : 'absent');
  }
  const checkAnchors = async () => {
    for (const [file, st] of anchors) if (!currentFile(st, await regular(area, file), justCarried)) throw new Unproven();
  };
  await checkAnchors();
  const remove = async (p: Pair, checkDirection: boolean) => {
    await withPair(p, async () => {
      await validateRoots();
      await checkAnchors();
      if (checkDirection) {
        for (const proof of primary) await checkPairPaths(proof);
        for (const absent of absentMains) if (await regular(absent.root, absent.file)) throw new Unproven();
      }
      await checkPairPaths(p);
      check();
      owned();
      await unlink(p.src);
      totals.files++;
      totals.bytes += Number(p.sourceStat.size);
    });
  };
  for (const p of side) await remove(p, !justCarried);
  for (const p of primary) await remove(p, false);
  for (const dir of dirs) {
    await validateRoots();
    if (!await directory(dir.root, dir.path) || !sameFile(dir.stamp, await lstat(dir.path, { bigint: true }))) throw new UnsafePath();
    check();
    owned();
    try { await rmdir(dir.path); totals.dirs++; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw err;
    }
  }
  if (unprovenSide) throw new Unproven();
}

export class ConversationCopies {
  private pending = Promise.resolve();
  private reading = new Set<ReturnType<typeof savedRefs>>();
  private waiting = new Map<string, Ref>();
  private retry?: NodeJS.Timeout;

  constructor(private app: App, private closing: () => boolean, private busy: (chat: string) => boolean) {
    const startup = setTimeout(() => { void this.sweep(); }, 60_000).unref();
    const stop = () => { clearTimeout(startup); clearTimeout(this.retry); this.retry = undefined; this.waiting.clear(); };
    const off = app.subscribe(event => { if (event.type === 'update.state' && this.closing()) stop(); });
    app.onDispose(() => { stop(); off(); return this.pending; });
  }

  private owns(ref: Ref) {
    let mine = false;
    for (const m of this.app.store.state.sessions) {
      for (const r of refs(m)) if (r.agent === ref.agent && r.id.toLowerCase() === ref.id.toLowerCase()) {
        if (mine || r.chat !== ref.chat || r.id !== ref.id || r.account !== ref.account) return false;
        mine = true;
      }
    }
    return mine;
  }

  private running = () => {
    if (this.closing()) throw new Skipped('busy');
    if (this.app.store.registryUnavailable) throw new Skipped('error');
  };

  private async saved() {
    this.running();
    const read = savedRefs(this.app.store.dir);
    this.reading.add(read);
    try { return await read; } finally { this.reading.delete(read); }
  }

  // Windows cannot atomically replace an open registry. Once quit starts no new
  // reader is admitted; only an existing registry read can hold up the final save.
  finishRegistryReads() {
    if (this.reading.size) return Promise.allSettled(this.reading);
  }

  private async clean(ref: Ref, pass: Scan, totals: Report, source?: string) {
    const key = refKey(ref);
    totals.looked.add(key);
    this.waiting.delete(key);
    try {
      this.running();
      if (!safeId(ref.id)) throw new UnsafePath();
      if (!this.app.providers.has(ref.agent)) throw new Skipped('no current file');
      const accounts = this.app.accountList(ref.agent);
      if (!accounts.some(a => a.id === ref.account)) throw new Skipped('no current file');
      const home = (id: string) => {
        if (!safeId(id)) throw new UnsafePath();
        const dir = id === DEFAULT_ACCOUNT ? this.app.providers.get(ref.agent)?.configHome?.() : this.app.accountDir(ref.agent, id);
        if (!dir || !path.isAbsolute(dir)) throw new UnsafePath();
        return path.resolve(dir);
      };
      const others = accounts.filter(a => a.id !== ref.account && (source === undefined || source === a.id));
      if (!others.length) return;
      const homes = [ref.account, ...others.map(a => a.id)].map(id => ({ id, dir: home(id) }));
      const check = () => {
        this.running();
        if (source === undefined && this.busy(ref.chat)) throw new Skipped('busy');
      };
      const owned = () => {
        if (!this.owns(ref) || !homes.every(h => this.app.accountList(ref.agent).some(a => a.id === h.id) && home(h.id) === h.dir)) throw new Unproven();
        if (ref.agent === 'codex' && others.some(a => {
          const provider = this.app.provider(ref.agent, a.id);
          return 'conversationReleased' in provider && typeof provider.conversationReleased === 'function' && !provider.conversationReleased(ref.id);
        })) throw new Skipped('busy');
      };
      check();
      owned();
      const [current, ...old] = await Promise.all(homes.map(h => pass.areas(h.dir, ref.agent)));
      if (!current.account) throw new Skipped('no current file');
      // Re-pointing a configured junction during a proof must not orphan the surviving file.
      const roots = new Set([current, ...old].flatMap(a => [a.account, a.main, a.history]));
      const missingProjects = old.flatMap(a => a.account && a.history && !a.main ? [path.join(a.account.dir, 'projects')] : []);
      const validateRoots = async () => {
        for (const root of roots) {
          if (root && !sameFile(root.stamp, await stat(root.home, { bigint: true }))) throw new UnsafePath();
        }
        for (const dir of missingProjects) if (await directory(dir, dir)) throw new Unproven();
      };
      await removeCopies(ref, current, old, pass, check, validateRoots, owned, totals, source !== undefined);
    } catch (err) {
      const reason = skipReason(err);
      totals.skipped.set(key, reason);
      if (reason === 'busy' && !this.closing()) this.waiting.set(key, ref);
    }
  }

  // Awaited under the move reservation, after the last rollback point.
  async moved(meta: SessionMeta, id: string, account: string, source: string) {
    const ref = refs(meta).find(r => r.agent === meta.provider && r.id === id && r.account === account);
    if (!ref) return;
    const totals = report();
    try {
      await this.app.store.persistInput(meta.id, true);
      if (!this.closing() && (await this.saved()).some(r => !r.ambiguous && refKey(r.ref) === refKey(ref))) {
        await this.clean(ref, scan(id, this.running), totals, source);
      }
    } catch { totals.looked.add(refKey(ref)); totals.skipped.set(refKey(ref), 'error'); }
    void this.sweep(ref, totals);
  }

  private scheduleRetry() {
    if (!this.waiting.size || this.closing()) { clearTimeout(this.retry); this.retry = undefined; return; }
    this.retry ??= setTimeout(() => {
      this.retry = undefined;
      void this.sweep(undefined, report(), true);
    }, 10 * 60_000).unref();
  }

  sweep(only?: Ref, totals = report(), retryBusy = false) {
    this.pending = this.pending.then(async () => {
      // Let switchAccount release its reservation before running a targeted sweep.
      await pause(25);
      if (this.closing()) return;
      const known = await this.saved();
      const pass = scan(only?.id, this.running);
      const retry = new Set(this.waiting.keys());
      if (!only) this.waiting.clear();
      for (const { ref, ambiguous } of known) {
        if (this.closing()) break;
        const key = refKey(ref);
        if (only && key !== refKey(only) || retryBusy && !retry.has(key)) continue;
        if (ambiguous) { totals.looked.add(key); totals.skipped.set(key, 'unproven copy'); }
        else await this.clean(ref, pass, totals);
        if (!only) await pause(25);
      }
    }).catch(err => {
      // An unreadable registry cannot authorize removal. Count the affected in-memory
      // references without logging their identities or the filesystem error message.
      const affected = only ? [only] : retryBusy ? this.waiting.values() : this.app.store.state.sessions.flatMap(refs);
      for (const ref of affected) { totals.looked.add(refKey(ref)); totals.skipped.set(refKey(ref), skipReason(err)); }
    }).then(() => {
      this.scheduleRetry();
      if (this.closing() || !totals.files && !totals.dirs && !totals.skipped.size) return;
      const counts = reasons.map(reason => reason + ' ' + [...totals.skipped.values()].filter(r => r === reason).length);
      this.app.log(`Conversation copies: checked ${totals.looked.size}, removed ${totals.files} files (${totals.bytes} bytes), skipped ${totals.skipped.size} (${counts.join(', ')})`);
      if (totals.bytes > 100_000_000) {
        const gb = totals.bytes >= 1e9;
        const size = Number((totals.bytes / (gb ? 1e9 : 1e6)).toFixed(1));
        this.app.emit({ type: 'toast', level: 'info', text: `Removed ${size} ${gb ? 'GB' : 'MB'} of duplicate conversation copies` });
      }
    });
    return this.pending;
  }
}
