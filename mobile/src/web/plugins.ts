import { pageStorage } from './storage';
import { deviceLabel } from './device';

// The web build aliases every Capacitor import here. Only pairing can reach persistent storage.
const store = (key: string) => key === 'pairing' ? window.localStorage : pageStorage;
export const Preferences = {
  async get({ key }: { key: string }) { return { value: store(key).getItem(key) }; },
  async set({ key, value }: { key: string; value: string }) { store(key).setItem(key, value); },
  async remove({ key }: { key: string }) { store(key).removeItem(key); },
};
export const Capacitor = { isNativePlatform: () => false };
// What this browser is ("iPad · Safari"): the name the pairing screen offers, which the person may change.
export const Device = { getInfo: async () => ({ name: deviceLabel(navigator.userAgent, navigator.maxTouchPoints) }) };
export const registerPlugin = () => ({});
export const App = {}, Haptics = {}, ImpactStyle = {}, NotificationType = {}, LocalNotifications = {}, Keyboard = {};

