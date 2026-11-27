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
// A plugin of the app's own (SystemPlugin.java and the like) does not exist in a browser: every method
// fails as a call that is not available (each caller already handles that), and a listener is accepted
// and never called. (A bare `{}` threw at once on `addListener`: the phone flow's share sheet, 2.22,
// took the whole page down at 390 px.)
const absent = () => Promise.reject(new Error('Not available in a browser.'));
export const registerPlugin = () => new Proxy({}, {
  get: (_t, key) => key === 'then' ? undefined : key === 'addListener' ? async () => ({ remove: async () => {} }) : absent,
});
export const App = {}, Haptics = {}, ImpactStyle = {}, NotificationType = {}, LocalNotifications = {}, Keyboard = {};

