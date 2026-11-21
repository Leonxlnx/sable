import { randomUUID } from 'node:crypto';
import { realpathSync, statSync, type Stats } from 'node:fs';
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
    return key ? { pair: { key, name: typeof pair.name === 'string' ? pair.name.slice(0, HELLO_FIELD) : '' } } : null;
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
  expires: number;
}

/** How long a link works. */
export const GRANT_MS = 15 * 60_000;

/** The same file, unchanged since `g` was made: its size, time and identity. */
function sameFile(st: Stats, g: Pick<FileGrant, 'size' | 'mtimeMs' | 'ino'>): boolean {
  return st.isFile() && st.size === g.size && st.mtimeMs === g.mtimeMs && (!g.ino || st.ino === g.ino);
}

/**
 * The grant for file `index` of share step `itemId` in a chat: only a step that finished (`done`:
 * the share was allowed and went through), its path resolved against the chat's folder, a regular
 * file that is still the size the step recorded. Throws a plain sentence otherwise.
 */
export function grantFor(snap: Pick<SessionSnapshot, 'session' | 'items'>, itemId: string, index: number, deviceId: string, now = Date.now()): FileGrant {
  const item = snap.items.find((i) => i.id === itemId);
  const share = item?.type === 'tool' && item.kind === 'share' ? item : undefined;
  if (!share || !Number.isInteger(index) || index < 0) throw new Error('That file is not in this chat.');
  // Pending, denied, cancelled or failed: nothing was handed over.
  if (share.status !== 'done') throw new Error('That file was not shared.');
  const file = share.detail.files?.[index];
  if (!file || typeof file.path !== 'string' || !file.path) throw new Error('That file is not in this chat.');
  let real: string;
  let st: Stats;
  try {
    real = realpathSync(path.resolve(snap.session.cwd, file.path));
    st = statSync(real);
  } catch {
    throw new Error('That file is no longer on the computer.');
  }
  if (!st.isFile()) throw new Error('That file is no longer on the computer.');
  if (typeof file.size === 'number' && file.size !== st.size) throw new Error('That file changed after it was shared.');
  return { deviceId, path: real, name: file.name || path.basename(real), size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, expires: now + GRANT_MS };
}

/** Opens a grant's file for serving, or says why not: the handle is checked against the grant, so a file changed or replaced since is refused. */
export async function openGrant(g: FileGrant): Promise<{ fh: FileHandle } | { code: number; text: string }> {
  let fh: FileHandle | undefined;
  try {
    fh = await openFile(g.path, 'r');
    if (sameFile(await fh.stat(), g)) return { fh };
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
