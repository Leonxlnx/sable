import { bridge } from '@/lib/bridge';
import { useStore } from '@/state/store';

/** Until green from the composer: `/until <check>`, `/until off`, and the strip's Stop and Check now. */

const fail = (err: unknown) => useStore.getState().toast((err as Error)?.message ?? String(err), 'error');

/**
 * What follows `/until`: arms the session's loop (replacing one already armed), or stops it with
 * `off`. False when it was not armed (no check, refused, the bridge unreachable): the composer puts
 * the command back with its arguments.
 */
export async function untilCommand(sessionId: string, arg: string): Promise<boolean> {
  const s = useStore.getState();
  if (!arg.trim()) {
    s.toast('Add a check after /until, like /until pnpm test');
    return false;
  }
  try {
    const r = await bridge.call('until.set', { sessionId, text: arg });
    if (r.error) {
      s.toast(r.error);
      return false;
    }
    // `off` with no loop running: said so; there is nothing to retry.
    if (!r.ok && /^(off|stop)$/i.test(arg.trim())) s.toast('No loop runs in this chat');
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

export const stopUntil = (sessionId: string) => bridge.call('until.stop', { sessionId }).catch(fail);

export const checkUntilNow = (sessionId: string) => bridge.call('until.check', { sessionId }).catch(fail);
