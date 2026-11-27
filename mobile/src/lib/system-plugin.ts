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
  /** 2.21: whether the phone has the system's dictation, and the system's own speech dialog (its words back, empty when cancelled). */
  canDictate(): Promise<{ on: boolean }>;
  dictate(): Promise<{ text: string }>;
  /** 2.22: the home-screen widget's figures (NowWidget; lib/widget.ts). */
  widget(o: { working: number; waiting: number; desktop?: string }): Promise<void>;
  /** 2.22: whether Android's battery saver is on (lib/saver.ts); later changes come as the `powerSave` event. */
  powerSave(): Promise<{ on: boolean }>;
  addListener(event: 'powerSave', listener: (r: { on: boolean }) => void): Promise<{ remove: () => Promise<void> }>;
  /** 2.22: text another app shared to Sable (MainActivity `takeShare`), kept until the page listens. */
  addListener(event: 'share', listener: (r: { text?: string; subject?: string }) => void): Promise<{ remove: () => Promise<void> }>;
}>('System');
