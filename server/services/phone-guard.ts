import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { open as openFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment, PhoneHello, SessionSnapshot } from '../../shared/protocol';

/**
 * What crosses the phone boundary besides conversations (phone.ts): the first frame of a socket,
 * pictures a phone attaches, the files a phone may download, and the size of what goes back.
 */

// ── the first frame ──

/** The biggest token, key or name a first frame may carry. */
const HELLO_FIELD = 512;

/**
 * A socket's first frame as one of the two it may be (`hello` with a token, `pair` with a key), or
 * null for anything else: not JSON, not an object (a number, null, a list), or fields of the wrong
 * kind. Never throws.
 */
export function readHello(text: string): PhoneHello | null {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= HELLO_FIELD ? v : undefined);
  const hello = obj(m.hello);
  if (hello) {
    const token = str(hello.token);
    return token ? { hello: { token, ...(typeof hello.name === 'string' ? { name: hello.name.slice(0, HELLO_FIELD) } : {}) } } : null;
  }
  const pair = obj(m.pair);
  if (pair) {
    const key = str(pair.key);
    // The older pairing it had with this desktop (removed once this one is allowed): its device and
    // the migration ticket this desktop gave it (`phone.migrate`), both, or nothing. Never a token.
    const was = obj(pair.replaces);
    const replaces = was && str(was.id) && str(was.ticket) ? { id: str(was.id)!, ticket: str(was.ticket)! } : undefined;
    return key ? { pair: { key, name: typeof pair.name === 'string' ? pair.name.slice(0, HELLO_FIELD) : '', ...(replaces ? { replaces } : {}) } } : null;
  }
  return null;
}

// ── pictures a phone attaches ──

/** Pictures per message, the biggest one (a data URL's length) and all of them together. */
export const PHONE_ATTACH = { count: 8, each: 8 * 1024 * 1024, total: 12 * 1024 * 1024 };
const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/;

const attachName = (v: unknown) =>
  String(typeof v === 'string' ? v : '')
    .replace(/[\u0000-\u001f\u007f<>"]/g, '')
    .trim()
    .slice(0, 120) || 'Photo';

/**
 * Attachments as a phone may send them: pictures as image data within the caps, and nothing that
 * names a place on the computer (a path, a file, text read elsewhere). `known`: the attachments the
 * desktop already holds for this message (a queued message edited on the phone): one the phone names
 * by its id is the desktop's own copy, never what the phone sent with it. Throws when something else
 * was sent.
 */
export function phoneAttachments(list: unknown, known?: readonly Attachment[]): Attachment[] | undefined {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) throw new Error('Only pictures can be attached from the phone.');
  if (list.length > PHONE_ATTACH.count) throw new Error(`At most ${PHONE_ATTACH.count} pictures can go with one message.`);
  let total = 0;
  const out = list.map((raw): Attachment => {
    const a = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const mine = typeof a.id === 'string' ? known?.find((k) => k.id === a.id) : undefined;
    if (mine) return mine;
    const data = a.dataUrl;
    if (typeof data !== 'string' || !IMAGE_DATA.test(data)) throw new Error('Only pictures can be attached from the phone.');
    if (data.length > PHONE_ATTACH.each) throw new Error('That picture is too big to send.');
    total += data.length;
    if (total > PHONE_ATTACH.total) throw new Error('These pictures are too big to send together.');
    const comma = data.indexOf(',');
    const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return {
      id: typeof a.id === 'string' && /^[\w:.-]{1,100}$/.test(a.id) ? a.id : randomUUID(),
      kind: 'image',
      name: attachName(a.name),
      dataUrl: data,
      mime: data.slice(5, data.indexOf(';')),
      size: Math.max(0, Math.floor(((data.length - comma - 1) * 3) / 4) - pad),
    };
  });
  return out.length ? out : undefined;
}

// ── files a phone may download ──

/** What a download link serves: one file a finished share step of a chat lists, as it was when the link was made. */
export interface FileGrant {
  /** The phone the link was made for: it goes when that phone is removed. */
  deviceId: string;
  /** The file itself (links followed), resolved against the chat's folder. */
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  ino: number;
  /** The volume it is on (absent: not checked). */
  dev?: number;
  /** The exact file id in decimal (`ino` as a number rounds Windows' 64-bit ids; absent: not checked). */
  fileId?: string;
  expires: number;
  /** SHA-256 (hex) of the bytes as the share completed (core/handed.ts); absent while it is read, or never (`unhashed`). */
  sha256?: string;
  unhashed?: 'big' | 'changed' | 'unreadable';
}

/** How long a link works. */
export const GRANT_MS = 15 * 60_000;

/** The same file, unchanged since `g` was made: its size, time and identity (`exact`: the same file's id, read as a bigint). */
function sameFile(st: Stats, g: Pick<FileGrant, 'size' | 'mtimeMs' | 'ino' | 'dev' | 'fileId'>, exact?: bigint): boolean {
  if (g.fileId !== undefined && (exact === undefined || exact.toString() !== g.fileId)) return false;
  return st.isFile() && st.size === g.size && st.mtimeMs === g.mtimeMs && (!g.ino || st.ino === g.ino) && (g.dev === undefined || st.dev === g.dev);
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * The grant for file `index` of share step `itemId` in a chat: only a step that went through, and
 * only the file it handed over then (`handed`, captured by the bridge the moment the step turned done
 * with a successful result: core/handed.ts): in the chat's folder, links followed, or outside it when
 * the person allowed that share themselves; still at the same real place with the same size, time and
 * identity. A step restored from a stored transcript has no such record and is refused, as is a file
 * rewritten, replaced, or reached through a link that now leads elsewhere. Throws a plain sentence otherwise.
 */
export function grantFor(snap: Pick<SessionSnapshot, 'session' | 'items'>, itemId: string, index: number, deviceId: string, now = Date.now()): FileGrant {
  const item = snap.items.find((i) => i.id === itemId);
  const share = item?.type === 'tool' && item.kind === 'share' ? item : undefined;
  if (!share || !Number.isInteger(index) || index < 0) throw new Error('That file is not in this chat.');
  // Pending, denied, cancelled or failed: nothing was handed over.
  if (share.status !== 'done') throw new Error('That file was not shared.');
  const file = share.detail.files?.[index];
  if (!file || typeof file.path !== 'string' || !file.path) throw new Error('That file is not in this chat.');
  // No record of what went over (a step restored from a stored transcript, or from before Sable kept one).
  if (!Array.isArray(share.handed)) throw new Error('Ask the agent to share that file again.');
  const handed = share.handed[index];
  if (!handed) throw new Error('That file is no longer on the computer.');
  const cwd = snap.session.cwd;
  const listed = path.resolve(cwd, file.path);
  if (!handed.inside && !handed.granted) {
    const rel = path.relative(cwd, listed);
    const named = rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
    if (!named) throw new Error('That file is outside the chat\'s folder.');
    // Named inside it but not proven there: a link (or a hard link), or a system that cannot say where
    // an open file lies (Windows, core/contain.ts): only a share the person allowed goes to a phone.
    let link = false;
    try {
      const st = lstatSync(listed);
      link = st.isSymbolicLink() || st.nlink > 1;
    } catch {
      /* gone: said below as a link would be */
      link = true;
    }
    throw new Error(link ? 'That file is a link to another place.' : 'Sable could not confirm that file is in the chat\'s folder. Only a share you allowed on the desktop goes to the phone.');
  }
  let real: string;
  let st: Stats;
  let exact: bigint;
  try {
    real = realpathSync(listed);
    st = statSync(real);
    exact = statSync(real, { bigint: true }).ino;
  } catch {
    throw new Error('That file is no longer on the computer.');
  }
  if (!st.isFile()) throw new Error('That file is no longer on the computer.');
  const was = { size: handed.size, mtimeMs: handed.mtimeMs, ino: Number(handed.ino), dev: handed.dev, fileId: String(handed.ino) };
  // The same file at the same place: what a link leads to now, a replacement or a rewrite is not what was shared.
  if (!samePath(real, handed.path) || !sameFile(st, was, exact)) throw new Error('That file changed after it was shared.');
  return {
    deviceId,
    path: handed.path,
    name: file.name || path.basename(real),
    ...was,
    expires: now + GRANT_MS,
    ...(typeof handed.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(handed.sha256) ? { sha256: handed.sha256.toLowerCase() } : {}),
    ...(handed.unhashed ? { unhashed: handed.unhashed } : {}),
  };
}

/** Opens a grant's file for serving, or says why not: the handle is checked against the grant, so a file changed or replaced since is refused. */
export async function openGrant(g: FileGrant): Promise<{ fh: FileHandle } | { code: number; text: string }> {
  let fh: FileHandle | undefined;
  try {
    fh = await openFile(g.path, 'r');
    if (sameFile(await fh.stat(), g, g.fileId !== undefined ? (await fh.stat({ bigint: true })).ino : undefined)) return { fh };
    await fh.close().catch(() => {});
    return { code: 409, text: 'The file changed after it was shared. Open it again in Sable.' };
  } catch {
    await fh?.close().catch(() => {});
    return { code: 404, text: 'The file is no longer on the computer.' };
  }
}

// ── what goes back ──

/** The biggest frame a phone gets: a result (a picture of a step can be most of it), an event. */
export const FRAME_MAX = { result: 16 * 1024 * 1024, event: 1024 * 1024 };
