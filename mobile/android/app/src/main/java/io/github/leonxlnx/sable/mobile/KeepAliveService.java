package io.github.leonxlnx.sable.mobile;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import org.json.JSONObject;

/**
 * The live notification while an agent works, and the connection to the computer kept meanwhile
 * while the app is in the background (Android cuts an app's network in the background: without it
 * the phone would hear nothing, no "Done", no "Waiting for you", until it is opened again).
 *
 * The page says what works (`NotesPlugin.live`, from mobile/src/lib/notes.ts) on every change; this
 * service only draws it. Three states:
 * - Working: one ongoing notification on the "Working" channel (silent): the chat and what it does
 *   now, a chronometer since the work began, steps done where known, an indeterminate progress bar
 *   (Android draws its motion). On Android 16 it is a ProgressStyle notification that asks to be
 *   promoted as a Live Update (`android.requestPromotedOngoing`): a status bar chip, and where the
 *   system shows Live Updates there (HyperOS 3.1), its island. Xiaomi's own focus template is added
 *   only when HyperOS says it takes it from this app (`canShowFocus`, granted by Xiaomi's review).
 * - Waiting, or the minute after work ended: the quiet "Connection" notification (minimum
 *   importance: no icon in the status bar), so an answer from a notification and the next turn still
 *   reach the phone. A minute after the last work, with nothing waiting, the service stops.
 * - Nothing: no service.
 *
 * It holds no wake lock and polls nothing: the page's socket is the only connection, updates come
 * from the page's events (at most one redraw a second), and the chronometer is drawn by Android.
 * Leaving the activity tries to start the service with the latest work. A later socket update
 * also tries while hidden. If Android denies that start, an ordinary notification can still
 * reflect updates delivered to the page. Returning to the activity stops the service, as does
 * three hours without a state update.
 */
public class KeepAliveService extends Service {
    static final int ID = 7001;
    private static final long LINGER_MS = 60_000L;
    private static final long MAX_MS = 3 * 60 * 60 * 1000L;
    private static final long REDRAW_MS = 1000L;

    /** What the page said last (null: nothing yet). */
    private static JSONObject live;
    /** When work and waiting last ended (elapsed realtime), or 0 while something works or waits. */
    private static long idleSince;
    // Plugin updates, Activity callbacks and the service all run on the main looper.
    private static boolean hidden, startPending, startDenied;
    private static KeepAliveService self;
    private boolean stopping;
    private static final Handler fallbackHandler = new Handler(Looper.getMainLooper());

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable redraw = this::draw;
    private final Runnable check = this::checkStop;
    private final Runnable cap = () -> {
        live = null;
        idleSince = 0;
        finish();
    };
    private long drawnAt;
    private boolean drawQueued;
    private Boolean focus;

    private static int chats(JSONObject l) {
        return l == null ? 0 : l.optInt("chats", 0);
    }

    private static int waiting(JSONObject l) {
        return l == null ? 0 : l.optInt("waiting", 0);
    }

    /** Something to keep the connection for: work, a chat waiting, or the minute after. */
    private static boolean wanted() {
        JSONObject l = live;
        if (chats(l) > 0 || waiting(l) > 0) return true;
        return idleSince > 0 && SystemClock.elapsedRealtime() - idleSince < LINGER_MS;
    }

    static void setLive(Context context, JSONObject next) {
        boolean busy = chats(next) > 0 || waiting(next) > 0;
        boolean was = chats(live) > 0 || waiting(live) > 0;
        live = next;
        if (busy || next.optBoolean("stop")) idleSince = 0;
        else if (was) idleSince = SystemClock.elapsedRealtime();
        if (self != null) self.changed();
        else if (hidden) startIfWanted(context);
    }

    static void onAppHidden(Context context) {
        hidden = true;
        startIfWanted(context);
    }

    private static void startIfWanted(Context context) {
        if (self != null || startPending) return;
        if (startDenied) {
            fallback(context);
            return;
        }
        if (!wanted()) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, KeepAliveService.class));
            startPending = true;
        } catch (IllegalStateException | SecurityException denied) {
            // Work first arrived after Android's visible-activity exemption expired.
            startDenied = true;
            fallback(context);
        }
    }

    private static void fallback(Context context) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (!hidden || chats(live) == 0) {
            fallbackHandler.removeCallbacksAndMessages(null);
            nm.cancel(ID);
        } else if (!fallbackHandler.hasMessages(0)) {
            // An ordinary notification can still follow the open socket. It expires if the process dies.
            fallbackHandler.postDelayed(() -> {
                if (!hidden || chats(live) == 0) return;
                try {
                    nm.notify(ID, working(context, live, MAX_MS));
                } catch (SecurityException ignored) { /* Notifications disabled. */ }
            }, REDRAW_MS);
        }
    }

    static void onAppVisible(Context context) {
        hidden = false;
        // Also clears a fallback left by a previous WebView process.
        if (self == null && !startPending) fallback(context);
        startDenied = false;
        if (self != null) self.finish();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startPending = false;
        self = this;
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(ID, build());
            drawnAt = SystemClock.elapsedRealtime();
        } catch (Exception e) {
            startDenied = true;
            finish();
            return START_NOT_STICKY;
        }
        changed();
        return START_NOT_STICKY;
    }

    /** The page said something: redraw (at most once a second), arm the stop and the cap. */
    private void changed() {
        if (stopping) return;
        handler.removeCallbacks(cap);
        handler.postDelayed(cap, MAX_MS);
        checkStop();
        if (stopping) return;
        long wait = REDRAW_MS - (SystemClock.elapsedRealtime() - drawnAt);
        if (wait <= 0) {
            handler.removeCallbacks(redraw);
            draw();
        } else if (!drawQueued) {
            drawQueued = true;
            handler.postDelayed(redraw, wait);
        }
    }

    private void checkStop() {
        handler.removeCallbacks(check);
        if (!hidden || !wanted()) {
            finish();
            return;
        }
        JSONObject l = live;
        if (chats(l) == 0 && waiting(l) == 0 && idleSince > 0) handler.postDelayed(check, Math.max(500, LINGER_MS - (SystemClock.elapsedRealtime() - idleSince)));
    }

    private void finish() {
        stopping = true;
        handler.removeCallbacksAndMessages(null);
        stopSelf();
    }

    private void draw() {
        drawQueued = false;
        if (stopping) return;
        drawnAt = SystemClock.elapsedRealtime();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            Notification n = build();
            if (chats(live) > 0) focus(n, chats(live) == 1 ? live.optString("title", "Sable") : "Sable");
            nm.notify(ID, n);
        } catch (SecurityException ignored) {
            // notifications off: the service still keeps the connection
        }
    }

    private Notification build() {
        JSONObject l = live;
        if (chats(l) > 0) return working(this, l, 0);
        return quiet(l);
    }

    /** Waiting on you, or the minute after work: kept quiet, at the bottom of the shade. */
    private Notification quiet(JSONObject l) {
        int w = waiting(l);
        String line = w > 1 ? w + " chats waiting for you" : w == 1 ? "A chat is waiting for you" : "Connected to your computer";
        return new NotificationCompat.Builder(this, Notes.CH_LINK)
            .setSmallIcon(R.drawable.ic_stat_sable)
            .setColor(Notes.IVORY)
            .setContentTitle("Sable")
            .setContentText(line)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(Notes.base(this, Notes.CH_LINK, "Sable", null).setShowWhen(false).build())
            .setContentIntent(Notes.open(this, "sable://home", ID))
            .build();
    }

    /** At work: the live notification. */
    private static Notification working(Context c, JSONObject l, long timeout) {
        String title = Notes.cut(l.optString("title", "Working"), 80);
        String text = Notes.cut(l.optString("text", "Working"), 400);
        String first = text.contains("\n") ? text.substring(0, text.indexOf('\n')) : text;
        String sub = l.optString("sub", "");
        long since = l.optLong("since", System.currentTimeMillis());
        boolean several = chats(l) > 1;
        String chat = l.optString("chat", "");
        PendingIntent tap = Notes.open(c, chat.isEmpty() ? "sable://home" : Notes.chatUri(chat, "turn"), ID);
        if (Build.VERSION.SDK_INT >= 36) return promoted(c, title, text, first, sub, since, several, tap, timeout);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, Notes.CH_WORKING)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setSmallIcon(R.drawable.ic_stat_sable)
            .setColor(Notes.IVORY)
            .setContentTitle(title)
            .setContentText(first)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(timeout)
            .setSilent(true)
            .setWhen(since)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setProgress(0, 0, true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                Notes.base(c, Notes.CH_WORKING, several ? "Sable" : title, null).setShowWhen(false).build()
            )
            .setContentIntent(tap);
        if (!sub.isEmpty()) b.setSubText(sub);
        if (several) b.setStyle(new NotificationCompat.BigTextStyle().bigText(text));
        return b.build();
    }

    /** Android 16: a ProgressStyle notification asking to be a Live Update (a status bar chip, the island where the system shows them). */
    private static Notification promoted(Context c, String title, String text, String first, String sub, long since, boolean several, PendingIntent tap, long timeout) {
        Notification.Builder b = new Notification.Builder(c, Notes.CH_WORKING)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .setSmallIcon(R.drawable.ic_stat_sable)
            .setColor(Notes.IVORY)
            .setContentTitle(title)
            .setContentText(first)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(timeout)
            .setWhen(since)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(
                Notes.base(c, Notes.CH_WORKING, several ? "Sable" : title, null).setShowWhen(false).build()
            )
            .setContentIntent(tap);
        if (!sub.isEmpty()) b.setSubText(sub);
        if (several) b.setStyle(new Notification.BigTextStyle().bigText(text));
        else b.setStyle(new Notification.ProgressStyle().setProgressIndeterminate(true));
        Bundle ex = new Bundle();
        // Notification.EXTRA_REQUEST_PROMOTED_ONGOING (public from Android 16 QPR2; read by 16 as well).
        ex.putBoolean("android.requestPromotedOngoing", true);
        b.addExtras(ex);
        return b.build();
    }

    /**
     * Xiaomi's focus template (dev.mi.com/xiaomihyperos, "miui.focus.param"), only where HyperOS says
     * it shows focus notifications from this app: that permission comes from Xiaomi's review of an
     * app listed in its store, so on a phone with Sable installed from an APK it is not given and
     * nothing is added. Asked once per service start.
     */
    private void focus(Notification n, String title) {
        if (focus == null) focus = focusAllowed();
        if (!focus) return;
        try {
            // Vendor extras may also render on the always-on display.
            String publicTitle = Notes.cut(title, 40);
            JSONObject pic = new JSONObject().put("type", 1).put("pic", "miui.focus.pic_icon");
            JSONObject island = new JSONObject()
                .put("islandProperty", 1)
                .put("bigIslandArea", new JSONObject().put("imageTextInfoLeft", new JSONObject().put("type", 1).put("picInfo", pic).put("textInfo", new JSONObject().put("title", publicTitle))))
                .put("smallIslandArea", new JSONObject().put("picInfo", pic));
            JSONObject v2 = new JSONObject()
                .put("protocol", 1)
                .put("business", "sable_working")
                .put("updatable", true)
                .put("enableFloat", false)
                .put("ticker", publicTitle)
                .put("aodTitle", publicTitle)
                .put("param_island", island)
                .put("baseInfo", new JSONObject().put("type", 2).put("title", publicTitle));
            String param = new JSONObject().put("param_v2", v2).toString();
            if (param.getBytes("UTF-8").length > 3072) return;
            Bundle pics = new Bundle();
            pics.putParcelable("miui.focus.pic_icon", Icon.createWithResource(this, R.mipmap.ic_launcher));
            n.extras.putString("miui.focus.param", param);
            n.extras.putBundle("miui.focus.pics", pics);
        } catch (Exception ignored) {
            // a template that cannot be written: the plain notification
        }
    }

    private boolean focusAllowed() {
        if (!"xiaomi".equalsIgnoreCase(Build.MANUFACTURER)) return false;
        try {
            if (Settings.System.getInt(getContentResolver(), "notification_focus_protocol", 0) < 1) return false;
            Bundle extras = new Bundle();
            extras.putString("package", getPackageName());
            Bundle r = getContentResolver().call(Uri.parse("content://miui.statusbar.notification.public"), "canShowFocus", null, extras);
            return r != null && r.getBoolean("canShowFocus", false);
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (self == this) self = null;
        super.onDestroy();
        // Home again during a stop: the newer visibility and work win once this instance has gone.
        if (stopping && hidden && wanted()) startIfWanted(getApplicationContext());
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
