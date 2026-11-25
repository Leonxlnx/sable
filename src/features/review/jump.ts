import { emptyIndex } from '@/state/revision';
import { useEffect, useRef } from 'react';
import { foldKey, setFold } from '@/features/timeline/fold';
import { revealItem } from '@/features/timeline/reveal';
import { showRailTab } from '@/state/actions';
import { useStore } from '@/state/store';
import type { ReviewComment } from './model';

/**
 * "Jump to a comment" from the review bar's list: the diff it sits in is opened where it lives (the
 * Changes tab's file row, or the edit step in the conversation), then the comment is brought into
 * view and lit once. The places that hold a diff open themselves when asked (`useJumpOpen`).
 */
const JUMP_EVENT = 'sable:review-jump';

export interface JumpRequest {
  sessionId: string;
  scope: string;
  path: string;
  id: string;
}

/** The request still looking for its comment; a place that mounts later takes it from here. */
let pending: JumpRequest | null = null;

export const stepScope = (itemId: string, n: number) => `step:${itemId}:${n}`;
export const stepOf = (scope: string) => (scope.startsWith('step:') ? scope.slice(5, scope.lastIndexOf(':')) : null);

export function jumpToComment(sessionId: string, c: ReviewComment) {
  const req: JumpRequest = { sessionId, scope: c.scope, path: c.path, id: c.id };
  pending = req;
  const step = stepOf(c.scope);
  if (step) {
    // An edit made by a sub-agent: the agents it sits under open too.
    const items = useStore.getState().data[sessionId]?.items ?? emptyIndex;
    for (let p = items[step]?.parentId, guard = 0; p && guard < 8; p = items[p]?.parentId, guard++) setFold(foldKey(sessionId, p, 'agent'), true);
    revealItem(sessionId, step);
  } else showRailTab('changes');
  window.dispatchEvent(new CustomEvent<JumpRequest>(JUMP_EVENT, { detail: req }));
  seek(req);
}

/**
 * Opens what holds a diff when a jump asks for it: `match` says whether a request is for this
 * place, `open` opens it (a file row, an edit step). Also answers a request made before it mounted.
 */
export function useJumpOpen(match: (r: JumpRequest) => boolean, open: (r: JumpRequest) => void, enabled = true) {
  // The latest callbacks: a place kept across chats (the same folder) answers for the chat it shows now.
  const fns = useRef({ match, open });
  fns.current = { match, open };
  useEffect(() => {
    if (!enabled) return;
    const answer = (r: JumpRequest | null) => {
      if (r && fns.current.match(r)) fns.current.open(r);
    };
    answer(pending);
    const on = (e: Event) => answer((e as CustomEvent<JumpRequest>).detail);
    window.addEventListener(JUMP_EVENT, on);
    return () => window.removeEventListener(JUMP_EVENT, on);
  }, [enabled]);
}

let seeking = 0;

/**
 * Looks for the comment for a moment while its diff opens and builds (folds mount their content a
 * frame or two later, diffs far from view build when they come near): the diff is brought near
 * first, then the comment into the middle of the view, lit once.
 */
function seek(req: JumpRequest) {
  cancelAnimationFrame(seeking);
  const until = performance.now() + 2500;
  let nearDone = false;
  let placed: HTMLElement | null = null;
  let holdUntil = 0;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // A comment already on screen is found while the list's menu is still closing; the menu takes the
  // keyboard back as it goes (then it falls to the page). For a moment, put it back on the comment,
  // unless the person has moved it somewhere else meanwhile.
  const holdFocus = () => {
    if (!placed?.isConnected || performance.now() > holdUntil) return;
    const a = document.activeElement;
    if (a !== placed) {
      if (a && a !== document.body && !a.closest('.rv-pop')) return;
      placed.focus({ preventScroll: true });
    }
    seeking = requestAnimationFrame(holdFocus);
  };
  const tick = () => {
    if (pending !== req) return;
    const card = document.querySelector<HTMLElement>(`[data-rv-id="${CSS.escape(req.id)}"]`);
    // Once what it sits in has finished opening, so the scroll is measured against the real height.
    const opening = card?.closest('.collapse:not([data-settled]), .rv-grow:not([data-settled])');
    if (card && (!opening || performance.now() > until - 1500)) {
      pending = null;
      placed = card;
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
      card.removeAttribute('data-flash');
      void card.offsetWidth;
      card.setAttribute('data-flash', '');
      window.setTimeout(() => card.removeAttribute('data-flash'), 1400);
      holdUntil = performance.now() + 800;
      seeking = requestAnimationFrame(holdFocus);
      return;
    }
    if (!nearDone) {
      const diff = document.querySelector<HTMLElement>(`[data-rv-scope="${CSS.escape(req.scope)}"]`);
      if (diff) {
        nearDone = true;
        diff.scrollIntoView({ block: 'nearest' });
      }
    }
    if (performance.now() < until) seeking = requestAnimationFrame(tick);
    else pending = null;
  };
  seeking = requestAnimationFrame(tick);
}
