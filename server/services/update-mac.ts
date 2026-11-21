import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/**
 * Installing an update on a Mac. The release carries Sable as a zip (`Sable-<version>-mac-<arch>.zip`);
 * it is downloaded and checked like the Windows installer. "Restart to update" then hands one small
 * shell script to the system and quits: the script waits for this process to end, unpacks the zip
 * next to the installed app, swaps the two folders (the old one is kept until the new one is in
 * place and put back if anything fails), and opens the new Sable.
 *
 * The download is made by Sable itself, so it carries no quarantine flag and Gatekeeper has nothing
 * to ask about: the first launch after an update needs no "Open anyway".
 */

/** `/Applications/Sable.app` for `/Applications/Sable.app/Contents/MacOS/Sable`; null when not run from an app bundle. */
export function appBundleOf(execPath: string): string | null {
  const parts = execPath.split('/');
  const i = parts.findIndex((p) => p.endsWith('.app'));
  if (i < 1 || parts[i + 1] !== 'Contents') return null;
  return parts.slice(0, i + 1).join('/');
}

/**
 * The script: arguments are the pid to wait for, the zip and the app bundle. Every failure ends
 * in reopening whatever app is installed, so a failed update never leaves the person without Sable.
 */
export const MAC_INSTALL_SCRIPT = `#!/bin/sh
PID="$1"; ZIP="$2"; APP="$3"
PARENT="$(dirname "$APP")"
NAME="$(basename "$APP")"
n=0
while kill -0 "$PID" 2>/dev/null && [ "$n" -lt 150 ]; do sleep 0.2; n=$((n+1)); done
if kill -0 "$PID" 2>/dev/null; then exit 1; fi
WORK="$(mktemp -d "$PARENT/.sable-update.XXXXXX")" || { /usr/bin/open "$APP"; exit 1; }
if /usr/bin/ditto -x -k "$ZIP" "$WORK" && [ -d "$WORK/$NAME" ]; then
  OLD="$WORK/previous.app"
  if mv "$APP" "$OLD"; then
    if mv "$WORK/$NAME" "$APP"; then
      /usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null
    else
      rm -rf "$APP"
      mv "$OLD" "$APP"
    fi
  fi
fi
rm -rf "$WORK"
/usr/bin/open "$APP"
`;

/** Whether this process may replace the app bundle (it needs to write next to it, as /Applications allows an admin). */
export function canReplace(bundle: string): boolean {
  try {
    accessSync(path.dirname(bundle), constants.W_OK);
    accessSync(bundle, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the script, detached, for the downloaded zip. Throws (without having changed anything)
 * when Sable is not running from an app bundle it may replace; the zip is then shown in Finder so the
 * person can drag the new Sable into Applications by hand.
 */
export function installMac(zip: string, opts: { execPath?: string; pid?: number } = {}): void {
  const bundle = appBundleOf(opts.execPath ?? process.execPath);
  if (!bundle || !canReplace(bundle)) {
    try {
      spawn('/usr/bin/open', ['-R', zip], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      /* the message below says where the file is */
    }
    throw new Error(`Sable cannot replace itself here. Open ${path.basename(zip)} from the Finder window that appeared and drag Sable into Applications.`);
  }
  spawn('/bin/sh', ['-c', MAC_INSTALL_SCRIPT, 'sable-update', String(opts.pid ?? process.pid), zip, bundle], { detached: true, stdio: 'ignore' }).unref();
}
