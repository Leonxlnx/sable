/**
 * A shared file's name made canonical once, on the desktop (`phone.fileStart`, the legacy
 * `phone.fileLink`), and used as it is everywhere after: what the phone shows, the name it saves
 * the file under, and what decides whether a file is a package for the installer (in the page and in
 * FilesPlugin.java, which refuses a name that is not already canonical). One function, so the gate in
 * the page and the one at Android's intent can never read a name differently ("x.apk " with a space,
 * "x.APK.", a name with a control character).
 *
 * The rules: Unicode NFC (before and after the rest); control and format characters (bidi overrides, zero-width) gone; path and
 * reserved characters (`\ / : * ? " < > |`) become `_`; whitespace runs become one space; no
 * leading or trailing spaces or dots; at most 120 characters, the extension kept; empty becomes
 * `file`.
 */
export function canonicalName(raw: string): string {
  let s = String(raw ?? '').normalize('NFC');
  // Control (Cc) and format (Cf: bidi overrides, zero-width joiners) characters.
  s = s.replace(/[\p{Cc}\p{Cf}]/gu, '');
  s = s.replace(/[\\/:*?"<>|]/g, '_');
  s = s.replace(/\s+/gu, ' ');
  s = s.replace(/^[\s.]+|[\s.]+$/gu, '');
  if (!s) return 'file';
  if ([...s].length > 120) {
    const chars = [...s];
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? [...s.slice(dot)] : [];
    s = chars.slice(0, 120 - ext.length).join('').replace(/[\s.]+$/u, '') + ext.join('');
  }
  // Once more: a format character removed between a letter and its accent, or a cut, can leave a
  // decomposed pair the first pass could not compose (FilesPlugin.java refuses a name not in NFC).
  return s.normalize('NFC');
}

/** True for a name that is already canonical (what FilesPlugin.java checks before it decides anything by it). */
export const isCanonicalName = (name: string) => typeof name === 'string' && name.length > 0 && canonicalName(name) === name;

/** An Android package (the installer's), by its canonical name. */
export const isPackageName = (canonical: string) => /\.apk$/i.test(canonical);
