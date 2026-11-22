/**
 * "This chat is about to open": said in the click, before anything is known about how long the
 * chat takes to be here. A chat not in memory is fetched first (`openSession` holds the view for
 * up to 160 ms), and until the view changed the click had no answer on the stage. The stage
 * listens and starts its veil at once (`useShownView` in App.tsx); the open itself goes on as ever.
 */
type Listener = (sessionId: string) => void;

const listeners = new Set<Listener>();

export function cueOpen(sessionId: string) {
  for (const l of listeners) l(sessionId);
}

export function onOpenCue(l: Listener): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
