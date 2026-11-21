/**
 * Removing the pairing's token from the phone's storage, checked: the removal, then a read that must
 * find nothing. Anything else (the removal throws, the read throws, a value is still there) is a
 * failure the person is told about, so Forget never looks done while a restart would connect with the
 * old token again. Pure over the storage it is given (native.ts passes Capacitor Preferences).
 */
export interface KeyStore {
  remove(o: { key: string }): Promise<unknown>;
  get(o: { key: string }): Promise<{ value: string | null }>;
}

export const FORGET_FAILED = 'This phone could not forget the computer. Try again.';

export async function removeChecked(store: KeyStore, key: string): Promise<void> {
  let left: string | null;
  try {
    await store.remove({ key });
    left = (await store.get({ key })).value;
  } catch {
    left = 'unknown';
  }
  if (left) throw new Error(FORGET_FAILED);
}
