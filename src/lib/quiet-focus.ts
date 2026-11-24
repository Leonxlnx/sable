/**
 * Focus without the ring: a control focused for the keyboard's sake when a view opens (the welcome's
 * button, a dialog's first option) shows its focus ring only once a key moves focus, never on a
 * pointer or programmatic open. A stable callback ref: `ref={quietFocus}` in place of `autoFocus`.
 */
export function quietFocus(el: HTMLElement | null) {
  el?.focus({ focusVisible: false, preventScroll: true } as FocusOptions);
}
