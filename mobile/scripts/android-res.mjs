// Sable's look for the Android project Capacitor generates: dark launch, the mark as launcher,
// splash and notification icon, the pairing deep link, permissions. Run after `cap add android`:
//   node scripts/android-res.mjs        (from mobile/; renders PNG icons with playwright-core from the repo root)
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { shortcutResources } from './shortcuts-res.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(here, '..', 'android', 'app', 'src', 'main');
const res = path.join(main, 'res');
const MARK = 'M0 0H4V2H3V3H2V4H0Z M3 3H4V4H3Z';
const BG = '#0C0C0E';
const INK = '#070708';
const IVORY = '#F2F1EE';

const w = (p, s) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, s);
};

// Vectors: the mark in a 108 box (adaptive icon layout: centred in the safe zone), and a 24 box for notifications.
const vector = (size, box, at, scale, color) => `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${size}dp" android:height="${size}dp" android:viewportWidth="${box}" android:viewportHeight="${box}">
    <group android:translateX="${at}" android:translateY="${at}" android:scaleX="${scale}" android:scaleY="${scale}">
        <path android:fillColor="${color}" android:pathData="${MARK}"/>
    </group>
</vector>
`;
w(path.join(res, 'drawable', 'ic_stat_sable.xml'), vector(24, 24, 4, 4, '#FFFFFFFF'));
w(path.join(res, 'drawable', 'splash_mark.xml'), vector(108, 108, 38, 8, IVORY));
w(
  path.join(res, 'drawable', 'splash.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/sable_ink"/>
    <item android:gravity="center" android:width="108dp" android:height="108dp" android:drawable="@drawable/splash_mark"/>
</layer-list>
`,
);
for (const d of readdirSync(res)) {
  if (/^drawable-(land|port)-/.test(d)) rmSync(path.join(res, d), { recursive: true, force: true });
}
rmSync(path.join(res, 'drawable', 'splash.png'), { force: true });
rmSync(path.join(res, 'drawable-v24', 'ic_launcher_foreground.xml'), { force: true });
rmSync(path.join(res, 'drawable', 'ic_launcher_background.xml'), { force: true });

w(
  path.join(res, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BG}</color>
    <color name="sable_ink">${INK}</color>
</resources>
`,
);
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
w(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive);
w(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive);

w(
  path.join(res, 'values', 'styles.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.NoActionBar">
        <item name="colorPrimary">@color/sable_ink</item>
        <item name="colorPrimaryDark">@color/sable_ink</item>
        <item name="colorAccent">#F2F1EE</item>
        <item name="android:windowBackground">@color/sable_ink</item>
    </style>

    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.NoActionBar">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
        <item name="android:background">@null</item>
        <item name="android:windowBackground">@color/sable_ink</item>
        <item name="android:statusBarColor">@android:color/transparent</item>
        <item name="android:navigationBarColor">@android:color/transparent</item>
        <item name="android:windowLightStatusBar">false</item>
    </style>

    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="windowSplashScreenBackground">@color/sable_ink</item>
        <item name="windowSplashScreenAnimatedIcon">@drawable/splash_mark</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
        <item name="android:background">@drawable/splash</item>
    </style>
</resources>
`,
);

// Manifest: deep link, camera (pairing scan), notifications, cleartext to the home network, keyboard resize.
const mf = path.join(main, 'AndroidManifest.xml');
let m = readFileSync(mf, 'utf8');
if (!m.includes('android:scheme="sable"')) {
  m = m.replace(
    /(<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>)/,
    `$1

            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="sable" android:host="pair" />
            </intent-filter>`,
  );
}
// The pairing token stays on the phone: no cloud or adb backup of the app's data.
m = m.replace('android:allowBackup="true"', 'android:allowBackup="false"');
if (!m.includes('usesCleartextTraffic')) m = m.replace('android:supportsRtl="true"', 'android:supportsRtl="true"\n        android:usesCleartextTraffic="true"');
if (!m.includes('windowSoftInputMode')) m = m.replace('android:launchMode="singleTask"', 'android:launchMode="singleTask"\n            android:windowSoftInputMode="adjustResize"');
for (const perm of ['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS', 'android.permission.VIBRATE', 'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE', 'android.permission.REQUEST_INSTALL_PACKAGES']) {
  if (!m.includes(`${perm}"`)) m = m.replace('<uses-permission android:name="android.permission.INTERNET" />', `<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="${perm}" />`);
}
// The connection kept while a chat runs and the app is in the background (KeepAliveService.java).
if (!m.includes('KeepAliveService'))
  m = m.replace(
    '\n    </application>',
    `
        <!-- Keeps the connection while a chat runs and the app is in the background (KeepAliveService). -->
        <service
            android:name=".KeepAliveService"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="Keeps the connection to the paired computer while an agent works, to tell the user when it is done or waits for an answer." />
        </service>
    </application>`,
  );
if (!m.includes('android.hardware.camera')) m = m.replace('<!-- Permissions -->', '<!-- Permissions -->\n    <uses-feature android:name="android.hardware.camera" android:required="false" />');
writeFileSync(mf, m);

// The app icon's shortcuts: "New chat", and the icons for the chats the app adds (shortcuts-res.mjs).
shortcutResources(main, path.join(here, '..', 'src', 'ui', 'icon-data.ts'));

// PNG launcher icons (legacy and adaptive foreground), drawn by headless Edge.
const require = createRequire(path.join(here, '..', '..', 'package.json'));
const { chromium } = require('playwright-core');
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({ headless: true, ...(edge ? { executablePath: edge } : { channel: 'chrome' }) });
const page = await browser.newPage();
const svg = (kind) => {
  const box = kind === 'fg' ? 108 : 48;
  const cell = kind === 'fg' ? 8 : 5.5;
  const at = (box - cell * 4) / 2;
  const back = kind === 'square' ? `<rect width="48" height="48" rx="11" fill="${BG}"/>` : kind === 'round' ? `<circle cx="24" cy="24" r="24" fill="${BG}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" shape-rendering="crispEdges">${back}<path d="${MARK}" transform="translate(${at} ${at}) scale(${cell})" fill="${IVORY}"/></svg>`;
};
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(dens)) {
  for (const [name, kind, dp] of [
    ['ic_launcher', 'square', 48],
    ['ic_launcher_round', 'round', 48],
    ['ic_launcher_foreground', 'fg', 108],
  ]) {
    const px = Math.round(dp * k);
    await page.setViewportSize({ width: px, height: px });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg(kind).replace('<svg ', `<svg width="${px}" height="${px}" `)}</body></html>`);
    await page.screenshot({ path: path.join(res, `mipmap-${d}`, `${name}.png`), omitBackground: true });
  }
}
await browser.close();
console.log('android resources written');
