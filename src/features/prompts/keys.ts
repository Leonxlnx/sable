import { useEffect, useRef } from 'react';

/**
 * Whether a prompt card may act on a key press: not while typing somewhere (an empty
 * composer does not count), not with modifiers, not while a menu or dialog is open.
 */
export function promptKeyAllowed(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || e.repeat || e.altKey || e.metaKey || e.ctrlKey) return false;
  const t = e.target as HTMLElement | null;
  if (t && t !== document.body) {
    if (t.isContentEditable) return false;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
      if (!t.hasAttribute('data-composer') || (t as HTMLTextAreaElement).value !== '') return false;
    }
    // A focused button handles Enter and Space itself.
    if ((e.key === 'Enter' || e.key === ' ') && /^(BUTTON|A)$/.test(t.tagName)) return false;
  }
  if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"], [role="listbox"], [role="menu"]')) return false;
  return true;
}

/**
 * Listens on window in the capture phase, so a handled Escape is marked
 * `defaultPrevented` before the timeline's own Escape (interrupt) sees it.
 */
export function usePromptKeys(enabled: boolean, handler: (e: KeyboardEvent) => void) {
  const fn = useRef(handler);
  fn.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (promptKeyAllowed(e)) fn.current(e);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}
