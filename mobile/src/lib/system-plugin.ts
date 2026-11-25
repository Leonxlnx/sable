import { registerPlugin } from '@capacitor/core';

/**
 * android/…/SystemPlugin.java, registered once (Capacitor refuses a second registration of a name):
 * the share sheet, the app icon's shortcuts, a preference written before it answers, and whether
 * the app is on screen (lib/screen.ts).
 */
export const System = registerPlugin<{
  share(o: { text: string; title?: string }): Promise<void>;
  shortcuts(o: { chats: { id: string; title: string }[] }): Promise<void>;
  keep(o: { key: string; value?: string }): Promise<void>;
  screen(): Promise<{ shown: boolean }>;
}>('System');
