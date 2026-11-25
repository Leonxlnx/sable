import type { PermissionRequest, PhonePermission } from '@shared/protocol';
import { onForget } from './forget';

/**
 * The permission requests this phone has had on screen (review 0235b, finding 23).
 *
 * A switch to a mode that never asks answers, from a phone, only what the phone showed: the desktop
 * takes `shownPermissions: [{ id, revision }]` with `session.setMode` and allows a waiting request
 * only when that revision is the one it sent this phone and still the request's own. So the phone
 * says what it really drew: a request whose card (`PermissionBody`, in a chat's sheet or in the deck)
 * was on screen, as the revision it was drawn from. A request that merely waits in the list ("+2"),
 * or that came shortened (`incomplete`: it has no revision), is never named.
 */
const seen = new Map<string, { sid: string; revision: string }>();
/** Bounded: requests answered elsewhere are dropped as their chat is read (`shownPermissions`). */
const MOST = 200;

/** A request's card is on screen: remembered as the revision it shows; one that came shortened is not shown whole. */
export function permissionShown(sid: string, req: PermissionRequest): void {
  const p = req as PhonePermission;
  if (p.incomplete || typeof p.revision !== 'string' || !p.revision) return void seen.delete(req.id);
  seen.delete(req.id);
  seen.set(req.id, { sid, revision: p.revision });
  if (seen.size > MOST) seen.delete(seen.keys().next().value as string);
}

/**
 * What goes with a mode change in `sid`: the requests that wait there now (`waiting`) whose card this
 * phone showed, each as the revision shown, and only while the request still is that revision (one
 * that changed since was not shown as it is now). Read at the tap.
 */
export function shownPermissions(sid: string, waiting: readonly PermissionRequest[]): { id: string; revision: string }[] {
  const out: { id: string; revision: string }[] = [];
  const here = new Set<string>();
  for (const req of waiting) {
    here.add(req.id);
    const was = seen.get(req.id);
    const p = req as PhonePermission;
    if (was && was.sid === sid && !p.incomplete && p.revision === was.revision) out.push({ id: req.id, revision: was.revision });
  }
  // Answered or gone meanwhile: nothing of them is kept.
  for (const [id, was] of seen) if (was.sid === sid && !here.has(id)) seen.delete(id);
  return out;
}

/** Forgetting the computer forgets what was shown for it. */
export function forgetShown(): void {
  seen.clear();
}
onForget(forgetShown);
