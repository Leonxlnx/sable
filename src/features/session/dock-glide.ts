/** How long the task strip and the conversation take to follow a card that arrives or leaves (ms). */
export const DOCK_GLIDE_MS = 260;
/**
 * The dock's curve: quick but not sudden. Its first frame takes about a seventh of the way (an
 * expo-out took two fifths there, which read as a step before the glide), and it lands softly.
 * The queue tray, the strips and the conversation's end all glide on it (composer/stack-glide.ts).
 */
export const DOCK_GLIDE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

let cardLeft = 0;

/**
 * A prompt card leaves the dock now (prompts/leave.ts on the person's answer, PromptDock when the
 * bridge took it away): the conversation's end, which comes down into its room, waits for the page
 * before it follows (Timeline.tsx, `glideY` with `hold`). Nothing else that changes the dock says
 * this: the queue tray's rows and the conversation's end keep one clock.
 */
export function cueCardLeft(now = performance.now()): void {
  cardLeft = now;
}

/** Whether the dock's change being handled now is a card that left (true once per cue, and only for a second after it). */
export function takeCardLeft(now = performance.now(), within = 1000): boolean {
  const hit = cardLeft > 0 && now - cardLeft <= within;
  cardLeft = 0;
  return hit;
}
