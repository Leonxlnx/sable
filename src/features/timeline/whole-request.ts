import { loadWholeItem } from '@/state/actions';
import { useStore } from '@/state/store';

/** Keep an open detail current until it is whole or its view closes. */
export function requestWhileCut(sessionId: string, id: string): () => void {
  let open = true;
  let delay = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = () => {
    const row = useStore.getState().data[sessionId]?.items[id];
    return row && 'more' in row && row.more;
  };
  const request = async () => {
    if (!open || !cut()) return;
    await loadWholeItem(sessionId, id);
    if (open && cut()) {
      timer = setTimeout(request, delay);
      delay = Math.min(8000, delay * 2);
    }
  };
  void request();
  return () => { open = false; clearTimeout(timer); };
}
