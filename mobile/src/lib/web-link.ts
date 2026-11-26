import { PAIR_LINK_PREFIX } from '@shared/protocol';

/** Called during module evaluation, before React or any asynchronous pairing work. */
export function readWebFragment(page: Location, history: History) {
  if (!page.hash) return;
  const params = new URLSearchParams(page.hash.slice(1));
  history.replaceState(history.state, '', page.pathname + page.search);
  const key = params.get('p') ?? '';
  const fp = params.get('f') ?? '';
  if (page.protocol !== 'https:' || !/^[\w-]{22}$/.test(key) || !/^[\w-]{43}$/.test(fp)) return;
  return PAIR_LINK_PREFIX + new URLSearchParams({ h: page.hostname, p: page.port || '443', s: key, f: fp });
}

