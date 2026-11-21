package io.github.leonxlnx.sable.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * What the app asks of Android itself: the share sheet for a message's text, and the app icon's
 * shortcuts for the last chats (a long press on the icon; "New chat" is static, res/xml/shortcuts.xml).
 * A shortcut opens `sable://chat/<id>` in this activity; the page routes it (App.tsx). And `keep`:
 * a preference written to the phone's storage before it answers (the pairing, an erasure's mark,
 * words taken back from the queue).
 */
@CapacitorPlugin(name = "System")
public class SystemPlugin extends Plugin {
    private static final int SHARE_MAX = 100_000;

    @PluginMethod
    public void share(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.trim().isEmpty()) {
            call.reject("Nothing to share.");
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, text.length() > SHARE_MAX ? text.substring(0, SHARE_MAX) : text);
        String title = call.getString("title");
        if (title != null && !title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
        Intent chooser = Intent.createChooser(send, null);
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(chooser);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("Nothing here can share it.");
        }
    }

    /**
     * Writes (or, without `value`, removes) a key of Capacitor's preferences (the same store
     * `Preferences.get` reads) with Android's commit: it resolves only once the value is on the phone's
     * storage, where Capacitor's own `set` and `remove` apply it in the background.
     */
    @PluginMethod
    public void keep(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("Nothing to keep.");
            return;
        }
        String value = call.getString("value");
        SharedPreferences.Editor e = getContext().getSharedPreferences("CapacitorStorage", Activity.MODE_PRIVATE).edit();
        if (value == null) e.remove(key);
        else e.putString(key, value);
        if (e.commit()) call.resolve();
        else call.reject("This phone could not keep it.");
    }

    private static String cut(String s, int n) {
        return s.length() > n ? s.substring(0, n - 1).trim() + "…" : s;
    }

    @PluginMethod
    public void shortcuts(PluginCall call) {
        JSArray chats = call.getArray("chats");
        List<ShortcutInfoCompat> list = new ArrayList<>();
        try {
            for (int i = 0; chats != null && i < chats.length() && list.size() < 2; i++) {
                JSONObject c = chats.getJSONObject(i);
                String id = c.optString("id", "");
                String title = c.optString("title", "").trim();
                if (id.isEmpty()) continue;
                if (title.isEmpty()) title = "Chat";
                Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse("sable://chat/" + Uri.encode(id)));
                open.setClass(getContext(), MainActivity.class);
                list.add(
                    new ShortcutInfoCompat.Builder(getContext(), "chat:" + id)
                        .setShortLabel(cut(title, 25))
                        .setLongLabel(cut(title, 60))
                        .setIcon(IconCompat.createWithResource(getContext(), R.drawable.ic_shortcut_chat))
                        .setIntent(open)
                        .setRank(i + 1)
                        .build()
                );
            }
            ShortcutManagerCompat.setDynamicShortcuts(getContext(), list);
            call.resolve();
        } catch (Exception e) {
            call.reject("The shortcuts could not be set.");
        }
    }
}
