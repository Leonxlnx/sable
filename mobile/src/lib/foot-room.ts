/**
 * The room a prompt bar takes at the foot of a screen (2.21): the bar lies OVER the list or the
 * conversation (it scrolls on under the glass), so what scrolls needs that much room after its last
 * line. A ref callback for the bar's own box: its height (padding included) goes to the screen as a
 * custom property (`--foot-h` on a chat, `--dock-h` on home), written in the commit that mounts it and
 * again whenever the bar's size changes. Nothing is read per frame.
 */
export function footRoom(name: '--foot-h' | '--dock-h', host: (el: HTMLElement) => HTMLElement | null = (el) => el.parentElement) {
  return (el: HTMLElement | null) => {
    if (!el) return;
    const screen = host(el);
    if (!screen) return;
    let last = -1;
    const set = () => {
      const h = el.offsetHeight;
      if (h === last) return;
      last = h;
      screen.style.setProperty(name, `${h}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      // A foot that goes (the review pane once nothing waits) leaves no room behind.
      screen.style.removeProperty(name);
    };
  };
}
