package io.github.leonxlnx.sable.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import androidx.activity.result.ActivityResult;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
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

    /**
     * Whether the app is on screen (the activity started), for the page's start (lib/screen.ts); later
     * changes come as `window.__sableScreen(bool)` (PageLife). Never the page's visibility, which
     * PageLife holds at visible while a chat works off screen.
     */
    @PluginMethod
    public void screen(PluginCall call) {
        com.getcapacitor.JSObject r = new com.getcapacitor.JSObject();
        r.put("shown", PageLife.isShown());
        call.resolve(r);
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

    /**
     * Whether the phone has the system's own dictation (a speech recognizer an app may start), for the
     * composer's mic (2.21). Android 11 and later see it through the manifest's queries.
     */
    @PluginMethod
    public void canDictate(PluginCall call) {
        com.getcapacitor.JSObject r = new com.getcapacitor.JSObject();
        boolean on;
        try {
            Intent ask = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            on = SpeechRecognizer.isRecognitionAvailable(getContext()) || !getContext().getPackageManager().queryIntentActivities(ask, 0).isEmpty();
        } catch (Exception e) {
            on = false;
        }
        r.put("on", on);
        call.resolve(r);
    }

    /**
     * The system's dictation (2.21): Android's own speech dialog, in the phone's language; what it heard
     * comes back as `text` (empty when the person cancelled). Nothing is recorded by the app itself.
     */
    @PluginMethod
    public void dictate(PluginCall call) {
        Intent ask = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        ask.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        ask.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        try {
            startActivityForResult(call, ask, "dictated");
        } catch (ActivityNotFoundException e) {
            call.reject("This phone has no dictation.");
        }
    }

    @ActivityCallback
    private void dictated(PluginCall call, ActivityResult result) {
        if (call == null) return;
        com.getcapacitor.JSObject r = new com.getcapacitor.JSObject();
        String text = "";
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            ArrayList<String> heard = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            if (heard != null && !heard.isEmpty() && heard.get(0) != null) text = heard.get(0);
        }
        r.put("text", text);
        call.resolve(r);
    }
}
