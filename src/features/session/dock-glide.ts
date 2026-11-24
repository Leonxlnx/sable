/** How long the task strip and the conversation take to follow a card that arrives or leaves (ms). */
export const DOCK_GLIDE_MS = 260;
/**
 * The dock's curve: quick but not sudden. Its first frame takes about a seventh of the way (an
 * expo-out took two fifths there, which read as a step before the glide), and it lands softly.
 * The queue tray, the strips and the conversation's end all glide on it (composer/stack-glide.ts).
 */
export const DOCK_GLIDE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
