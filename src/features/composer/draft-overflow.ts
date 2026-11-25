// Pasted pictures can exceed localStorage's per-origin limit. Its small pointer is committed
// only after the IndexedDB transaction containing the full recovery draft has finished.
let database: Promise<IDBDatabase> | undefined;
function open() {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('sable.draft-recovery', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('drafts');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(err => { database = undefined; throw err; });
  }
  return database;
}

export async function overflowDraft(key: string, value?: string | null): Promise<string | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', value === undefined ? 'readonly' : 'readwrite');
    const store = tx.objectStore('drafts');
    const req = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key);
    tx.oncomplete = () => resolve(value === undefined ? req.result : undefined);
    tx.onabort = () => reject(tx.error);
  });
}
