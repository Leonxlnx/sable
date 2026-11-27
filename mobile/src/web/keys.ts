import { goBack } from '../lib/back';
import { nav } from '../lib/nav';
import { isSplit } from './allow';

/**
 * Escape in a browser (a tablet's keyboard): it closes what floats (a sheet, a message's menu, the picture
 * viewer), through the same handlers Android's back button runs (lib/back.ts). In the tablet layout it
 * then goes back from a screen over the chat (its changes, a diff), never from the chat itself (the
 * list chooses that); in the phone's flow it goes back as Android's back does.
 */
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  const floating = !!document.querySelector('.sheet-layer:not([data-closing]), .peek-layer, .msg-layer, .viewer');
  if (!isSplit()) {
    if (goBack()) e.preventDefault();
    return;
  }
  if (floating) {
    e.preventDefault();
    goBack();
    return;
  }
  const top = nav.stack[nav.stack.length - 1];
  if (top && top.name !== 'chat') {
    e.preventDefault();
    nav.pop();
  }
});
