import { pageStorage } from './storage';

// The web build aliases every Capacitor import here. Only pairing can reach persistent storage.
const store = (key: string) => key === 'pairing' ? window.localStorage : pageStorage;
export const Preferences = {
  async get({ key }: { key: string }) { return { value: store(key).getItem(key) }; },
  async set({ key, value }: { key: string; value: string }) { store(key).setItem(key, value); },
  async remove({ key }: { key: string }) { store(key).removeItem(key); },
};
export const Capacitor = { isNativePlatform: () => false };
export const Device = { getInfo: async () => ({ name: 'Web browser' }) };
export const registerPlugin = () => ({});
export const App = {}, Haptics = {}, ImpactStyle = {}, NotificationType = {}, LocalNotifications = {}, Keyboard = {};

