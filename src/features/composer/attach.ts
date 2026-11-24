import type { Attachment } from '@shared/protocol';
import { baseName, formatBytes, langFromPath } from '@/lib/format';

/** Turning dropped, pasted or picked files into message attachments. */

const MAX_SIDE = 2000;
const MAX_TEXT = 200 * 1024;
const MAX_TOTAL = 18 * 1024 * 1024;
const MAX_IMAGES = 10;

const TEXT_EXT =
  /\.(txt|md|mdx|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env|csv|tsv|log|xml|html?|css|scss|less|svg|[cm]?[jt]sx?|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|bat|sql|graphql|gql|proto|lua|r|dart|ex|exs|erl|clj|scala|tf|gradle|dockerfile|gitignore|editorconfig|lock)$/i;

let seq = 0;
const newId = () => `att-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const sizeOf = (a: Attachment) => a.size ?? a.text?.length ?? 0;

/** How long a text attachment is, as its chip says it: "1 line", "24 lines" (a last line break counts for nothing). */
export function linesOf(text: string): string {
  const n = text.replace(/\n$/, '').split('\n').length;
  return `${n} ${n === 1 ? 'line' : 'lines'}`;
}

function readAs(file: File, how: 'dataUrl' | 'text'): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    if (how === 'dataUrl') r.readAsDataURL(file);
    else r.readAsText(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the image'));
    img.src = src;
  });
}

const dataUrlBytes = (url: string) => Math.round(((url.length - url.indexOf(',') - 1) * 3) / 4);

/** Reads an image, scaling it down when its longest side is above ~2000px. */
async function toImage(file: File): Promise<Attachment> {
  let dataUrl = await readAs(file, 'dataUrl');
  let mime = file.type || 'image/png';
  if (mime !== 'image/gif') {
    try {
      const img = await loadImage(dataUrl);
      const side = Math.max(img.naturalWidth, img.naturalHeight);
      if (side > MAX_SIDE) {
        const k = MAX_SIDE / side;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * k);
        canvas.height = Math.round(img.naturalHeight * k);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          mime = mime === 'image/png' ? 'image/png' : 'image/jpeg';
          dataUrl = canvas.toDataURL(mime, 0.9);
          if (dataUrlBytes(dataUrl) > 4 * 1024 * 1024) {
            mime = 'image/jpeg';
            dataUrl = canvas.toDataURL(mime, 0.85);
          }
        }
      }
    } catch {
      /* keep the original */
    }
  }
  const name = file.name || `Pasted image.${mime.split('/')[1] ?? 'png'}`;
  return { id: newId(), kind: 'image', name, mime, dataUrl, size: dataUrlBytes(dataUrl) };
}

function looksText(file: File) {
  return file.type.startsWith('text/') || /json|xml|javascript|typescript|yaml|toml|sql|x-sh/.test(file.type) || TEXT_EXT.test(file.name) || (!file.type && !file.name.includes('.'));
}

/** An image keeps the size of the file it came from, so the same file dropped again is recognised. */
type SizedAttachment = Attachment & { srcSize?: number };

export interface ReadResult {
  added: Attachment[];
  refused: string | null;
}

/** What makes two attachments the same file: its path when known, else its name and size. */
export const sameFileKey = (a: { name: string; size?: number; path?: string }) => (a.path ? `p:${a.path.toLowerCase()}` : `n:${a.name}:${a.size ?? -1}`);

/**
 * Classifies files: images (when the provider takes them), small text files, or a calm refusal.
 * In the desktop app `pathOf` gives a file's real path: anything that is not an image then goes to
 * the agent by that path (`kind: 'file'`) instead of its contents, whatever its size. A file that
 * is already attached is skipped quietly.
 */
export async function readFiles(files: File[], opts: { images: boolean; current: Attachment[]; pathOf?: (f: File) => string | undefined }): Promise<ReadResult> {
  const added: Attachment[] = [];
  const problems = new Set<string>();
  let total = opts.current.reduce((n, a) => n + (a.kind === 'file' ? 0 : sizeOf(a)), 0);
  let images = opts.current.filter((a) => a.kind === 'image').length;
  // Images are re-encoded (their size changes), so they are known by the original file's size.
  const seen = new Set(opts.current.map((a) => sameFileKey({ name: a.name, size: (a as SizedAttachment).srcSize ?? a.size, path: a.path })));

  for (const file of files) {
    const path = opts.pathOf?.(file) || undefined;
    const key = sameFileKey({ name: file.name, size: file.size, path });
    if (file.name && seen.has(key)) continue;
    seen.add(key);
    try {
      const isImage = file.type.startsWith('image/') && file.type !== 'image/svg+xml';
      if (path && !isImage) {
        added.push({ id: newId(), kind: 'file', name: file.name || baseName(path), path, size: file.size, mime: file.type || undefined });
        continue;
      }
      if (isImage) {
        if (!opts.images) {
          problems.add('This agent does not accept images');
          continue;
        }
        if (images >= MAX_IMAGES) {
          problems.add(`Up to ${MAX_IMAGES} images per message`);
          continue;
        }
        const att: SizedAttachment = { ...(await toImage(file)), srcSize: file.size, ...(path ? { path } : {}) };
        if (total + sizeOf(att) > MAX_TOTAL) {
          problems.add(`Attachments are limited to ${formatBytes(MAX_TOTAL)} per message`);
          continue;
        }
        total += sizeOf(att);
        images++;
        added.push(att);
      } else if (looksText(file)) {
        if (file.size > MAX_TEXT) {
          problems.add(`${file.name} is too large to attach as text (${formatBytes(file.size)}). Mention it with @ instead`);
          continue;
        }
        const text = await readAs(file, 'text');
        if (text.includes('\u0000')) {
          problems.add(`${file.name} is not a text file`);
          continue;
        }
        total += text.length;
        added.push({ id: newId(), kind: 'text', name: file.name, text, size: file.size, mime: file.type || undefined });
      } else {
        problems.add(`${file.name || 'This file'} is not ${opts.images ? 'an image or ' : ''}a text file`);
      }
    } catch {
      problems.add(`Could not read ${file.name}`);
    }
  }
  return { added, refused: problems.size ? [...problems][0] : null };
}

/** Text attachments travel inside the message as fenced blocks. */
export function withTextAttachments(text: string, atts: Attachment[]): string {
  const blocks = atts
    .filter((a) => a.kind === 'text' && a.text != null)
    .map((a) => {
      const lang = langFromPath(a.name);
      const body = a.text!.replace(/\s+$/, '');
      const fence = body.includes('```') ? '````' : '```';
      return `${a.name}\n${fence}${lang === 'text' ? '' : lang}\n${body}\n${fence}`;
    });
  return [text, ...blocks].filter(Boolean).join('\n\n');
}
