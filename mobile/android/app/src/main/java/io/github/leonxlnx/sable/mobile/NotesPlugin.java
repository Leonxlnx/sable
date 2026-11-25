package io.github.leonxlnx.sable.mobile;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The page's notifications (Notes) and the live notification while chats work (KeepAliveService).
 * An Allow once or Deny pressed on a chat's notification goes to the page as
 * `window.__sableNoteAction({...})` (lib/native.ts `onNoteAction`).
 */
@CapacitorPlugin(name = "Notes")
public class NotesPlugin extends Plugin {
    private static volatile NotesPlugin instance;

    @Override
    public void load() {
        instance = this;
        Notes.channels(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /** Hands an unlocked tap to the current page. The notification already offers Open if delivery fails. */
    static void deliver(Intent intent) {
        NotesPlugin p = instance;
        if (p == null || p.getBridge() == null || p.getBridge().getWebView() == null) return;
        JSObject data = new JSObject();
        data.put("noteId", intent.getIntExtra("noteId", 0));
        data.put("token", intent.getStringExtra(Notes.TOKEN));
        for (String key : new String[] { "sessionId", "requestId", "optionId", "verb", "detail", "deviceId" }) {
            data.put(key, intent.getStringExtra(key));
        }
        // Straight into the page: a plugin event (notifyListeners) reaches a page in the background
        // only once the app is on screen again, which is too late for an answer from the shade.
        final android.webkit.WebView wv = p.getBridge().getWebView();
        final String js = "window.__sableNoteAction&&window.__sableNoteAction(" + data.toString() + ")";
        // Manifest receiver callbacks already run on the main thread.
        wv.evaluateJavascript(js, null);
    }

    /**
     * Stop now, confirmed on a live card: to the page as `window.__sableNoteStop({ sessionId })`
     * (lib/note-answer.ts `stopFromNote`), which stops the chat only if it still runs.
     */
    static void deliverStop(String sessionId) {
        NotesPlugin p = instance;
        if (p == null || p.getBridge() == null || p.getBridge().getWebView() == null) return;
        JSObject data = new JSObject();
        data.put("sessionId", sessionId);
        p.getBridge().getWebView().evaluateJavascript("window.__sableNoteStop&&window.__sableNoteStop(" + data.toString() + ")", null);
    }

    @PluginMethod
    public void post(PluginCall call) {
        if (Notes.post(getContext(), call.getData())) call.resolve();
        else call.reject("Android could not post on this notification channel.");
    }

    @PluginMethod
    public void summary(PluginCall call) {
        Notes.summary(getContext(), call.getInt("chats", 0), call.getArray("lines"), null);
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Notes.cancel(getContext(), call.getArray("ids"));
        call.resolve();
    }

    @PluginMethod
    public void cancelAction(PluginCall call) {
        int id = call.getInt("noteId", 0);
        JSObject result = new JSObject();
        result.put("removed", Notes.cancelAction(getContext(), id, call.getString("token")));
        call.resolve(result);
    }

    @PluginMethod
    public void delivered(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ids", Notes.active(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void clearAll(PluginCall call) {
        Notes.clearAll(getContext());
        call.resolve();
    }

    /** Current work and waiting counts, or an explicit stop from the page. */
    @PluginMethod
    public void live(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            KeepAliveService.setLive(getContext(), call.getData());
            call.resolve();
        });
    }

    /** What Android allows here: notifications at all, and (Android 16) Live Updates. */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("enabled", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        if (Build.VERSION.SDK_INT >= 36) {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) r.put("live", nm.canPostPromotedNotifications());
        }
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    /** Android's own page for Sable's notifications (`live`: its Live Updates page, where there is one). */
    @PluginMethod
    public void settings(PluginCall call) {
        Context c = getContext();
        boolean live = Boolean.TRUE.equals(call.getBoolean("live", false));
        Intent i;
        if (live && Build.VERSION.SDK_INT >= 36) i = new Intent("android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS");
        else if (Build.VERSION.SDK_INT >= 26) i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        else i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + c.getPackageName()));
        i.putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName());
        i.putExtra("app_package", c.getPackageName());
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            c.startActivity(i);
            call.resolve();
        } catch (Exception e) {
            try {
                Intent j = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                c.startActivity(j);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Android's settings could not be opened.");
            }
        }
    }
}
