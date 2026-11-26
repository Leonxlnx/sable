const entries = new Map<string, string>();
export const pageStorage: Storage = {
  get length() { return entries.size; },
  key: i => [...entries.keys()][i] ?? null,
  getItem: k => entries.get(k) ?? null,
  setItem(k, v) { entries.set(k, String(v)); },
  removeItem(k) { entries.delete(k); },
  clear() { entries.clear(); },
};
Object.defineProperty(globalThis, 'sablePageStorage', { value: pageStorage });

