import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.leonxlnx.sable.mobile',
  appName: 'Sable',
  webDir: 'dist',
  backgroundColor: '#070708',
  server: {
    // http://localhost: the desktop endpoint is plain ws:// on the home network, which an https page could not open.
    androidScheme: 'http',
    cleartext: true,
    // Development only (SABLE_MOBILE_DEV=1 before `cap sync`): load the web build from `vite preview` through `adb reverse tcp:5190 tcp:5190`.
    ...(process.env.SABLE_MOBILE_DEV ? { url: 'http://localhost:5190' } : {}),
  },
  // Plugin calls are not written to the device log: the pairing token passes through Preferences.
  loggingBehavior: 'none',
  android: {
    backgroundColor: '#070708',
  },
  plugins: {
    // The page's edges are PageInsets.java's alone (one path on every WebView): SystemBars only colours the bars.
    SystemBars: { insetsHandling: 'disable', style: 'DARK' },
    Keyboard: { resizeOnFullScreen: false },
    LocalNotifications: { smallIcon: 'ic_stat_sable', iconColor: '#f2f1ee' },
  },
};

export default config;
