// The app icon's shortcuts in the Android project: the static "New chat" shortcut (res/xml), its
// label, the icons for it and for the chats the app adds itself (SystemPlugin.java: the last two
// chats), and the manifest's meta-data. Used by android-res.mjs; safe to run again.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const INK = '#17171A';
const IVORY = '#F2F1EE';
const PKG = 'io.github.leonxlnx.sable.mobile';

const w = (p, s) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, s);
};

/** A Phosphor icon's path (regular weight) from the app's generated icon data. */
function phosphor(iconData, name) {
  const line = readFileSync(iconData, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`  ${name}: [`));
  if (!line) throw new Error(`no icon ${name}`);
  const [regular] = JSON.parse(line.trim().slice(name.length + 2).replace(/,$/, ''));
  return /d="([^"]+)"/.exec(regular)[1];
}

/** The glyph on a 108 dp adaptive layer (inside the safe zone), or on a 24 dp plain icon for older Android. */
const glyph = (d, box, size, color) => {
  const s = size / 256;
  const at = (box - size) / 2;
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${box}dp" android:height="${box}dp" android:viewportWidth="${box}" android:viewportHeight="${box}">
    <group android:translateX="${at}" android:translateY="${at}" android:scaleX="${s}" android:scaleY="${s}">
        <path android:fillColor="${color}" android:pathData="${d}"/>
    </group>
</vector>
`;
};

export function shortcutResources(main, iconData) {
  const res = path.join(main, 'res');
  for (const [name, icon] of [
    ['ic_shortcut_new', 'plus'],
    ['ic_shortcut_chat', 'chat'],
  ]) {
    const d = phosphor(iconData, icon);
    w(path.join(res, 'drawable', `${name}_fg.xml`), glyph(d, 108, 40, IVORY));
    // Android 8 and later: an adaptive icon (the launcher masks it, as its own shortcuts).
    w(
      path.join(res, 'drawable-v26', `${name}.xml`),
      `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/sable_shortcut"/>
    <foreground android:drawable="@drawable/${name}_fg"/>
</adaptive-icon>
`,
    );
    // Older Android draws it on its own light disc: the glyph in ink.
    w(path.join(res, 'drawable', `${name}.xml`), glyph(d, 24, 18, INK));
  }
  w(
    path.join(res, 'values', 'shortcuts.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="sable_shortcut">${INK}</color>
    <string name="shortcut_new">New chat</string>
</resources>
`,
  );
  w(
    path.join(res, 'xml', 'shortcuts.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <shortcut
        android:shortcutId="new-chat"
        android:enabled="true"
        android:icon="@drawable/ic_shortcut_new"
        android:shortcutShortLabel="@string/shortcut_new"
        android:shortcutLongLabel="@string/shortcut_new">
        <intent
            android:action="android.intent.action.VIEW"
            android:targetPackage="${PKG}"
            android:targetClass="${PKG}.MainActivity"
            android:data="sable://new" />
    </shortcut>
</shortcuts>
`,
  );
  const mf = path.join(main, 'AndroidManifest.xml');
  let m = readFileSync(mf, 'utf8');
  if (!m.includes('android.app.shortcuts'))
    m = m.replace(
      /(<data android:scheme="sable" android:host="pair" \/>\s*<\/intent-filter>)/,
      `$1

            <!-- The app icon's shortcuts: "New chat" here, the last chats from the app (SystemPlugin). -->
            <meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />`,
    );
  writeFileSync(mf, m);
}
