package io.github.leonxlnx.sable.mobile;

import android.app.Notification;
import android.app.NotificationManager;
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
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The live notifications while agents work, and the connection to the computer kept meanwhile while
 * the app is in the background (Android cuts an app's network in the background: without it the phone
 * would hear nothing, no "Done", no "Waiting for you", until it is opened again).
 *
 * The page says what works (`NotesPlugin.live`, from mobile/src/lib/notes.ts `livePayload`) on every
 * change; this service only draws it:
 * - One card per chat at work (LiveCards, the page's `cards`), at the chat's own notification id, in
 *   the group "sable.live": what it does now, the turn's clock, the checkpoint, a segment per checkpoint
 *   closed, the other chats, Open and Stop. On Android 16 each card asks to be a Live Update (a status
 *   bar chip with the turn's clock; HyperOS's island where it shows Live Updates). When a chat's turn
 *   ends or it waits on the person, the page posts its news at the same id (Notes.post), which takes
 *   the card's place: the result ("Finished · 3 files changed"), no longer ongoing; a card whose chat
 *   left the live set with no news goes (only while it is still a live card: `Notes.cancelLive`).
 * - The service's own notification is that group's summary: Android hides a summary with one card
 *   under it, shows it as the header of two or more, and alone (no chat at work: a chat waiting, or the
 *   minute after work) it is the quiet line that keeps the connection.
 * - A card the person swiped away is not put up again until its chat's next turn (the platform's rule
 *   for Live Updates). Stop asks once: the card turns into "Stop this turn?" with Stop now (unlocked
 *   only) and Keep going, for eight seconds; Stop now goes to the page (NotesPlugin.deliverStop), which
 *   checks the chat still runs and stops it as the chat's own Stop does.
 *
 * It holds no wake lock and polls nothing: the page's socket is the only connection, updates come from
 * the page's events (at most one redraw a second), the clocks are drawn by Android, and a card is put
 * up again every two minutes only so that one left by a process that died goes by itself (TTL).
 * Leaving the activity tries to start the service with the latest work; a later socket update also
 * tries while hidden; if Android denies that start, ordinary notifications still follow the updates
 * the page receives. Returning to the activity stops the service and takes the cards away, as does
 * three hours without a state update.
 */
public class KeepAliveService extends Service {
    static final int ID = 7001;
    private static final long LINGER_MS = 60_000L;
    private static final long MAX_MS = 3 * 60 * 60 * 1000L;
    private static final long REDRAW_MS = 1000L;
    private static final long REFRESH_MS = 2 * 60_000L;
    private static final long ASK_MS = 8_000L;
    private static final long RESULT_KEEP_MS = 10 * 60_000L;
    /** How long a connection lost while chats worked is tried again (lib/notes.ts LIVE_LOST_MS, the same). */
    private static final long LOST_MS = 10 * 60_000L;
    /** The line left when the connection never came back (the cards are gone by then). */
    static final int LOST_ID = 7002;

    /** What the page said last (null: nothing yet), and when it said it. */
    private static JSONObject live;
    private static long liveAt;
    /** When work and waiting last ended (elapsed realtime), or 0 while something works or waits. */
    private static long idleSince;
    // Plugin updates, Activity callbacks, receivers and the service all run on the main looper.
    private static boolean hidden, startPending, startDenied;
    private static KeepAliveService self;
    private boolean stopping;
    private static final Handler fallbackHandler = new Handler(Looper.getMainLooper());

    /** The note ids of the cards up now, by chat. */
    private static final Map<String, Integer> drawn = new HashMap<>();
    /** Chats whose card the person swiped away during this turn. */
    private static final Set<String> dismissed = new HashSet<>();
    /** Chats whose Stop waits for its confirmation, until when (elapsed realtime). */
    private static final Map<String, Long> asking = new HashMap<>();
    /** Chats whose Stop went to the page. */
    private static final Set<String> stoppingChats = new HashSet<>();
    /** Each chat's last card and when it left the live set (for its result: Notes.post). Guarded by Notes.class. */
    private static final Map<String, JSONObject> lastCards = new HashMap<>();
    private static final Map<String, Long> leftAt = new HashMap<>();

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable redraw = this::draw;
    private final Runnable check = this::checkStop;
    private final Runnable refresh = () -> {
        drawnAt = 0;
        draw();
    };
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

    private static JSONArray cards(JSONObject l) {
        JSONArray a = l == null ? null : l.optJSONArray("cards");
        return a == null ? new JSONArray() : a;
    }

    /** When the connection was lost while chats worked (ms, the page's clock), or 0. */
    private static long lost(JSONObject l) {
        return l == null ? 0 : l.optLong("lost", 0);
    }

    /** The connection was lost a moment ago while chats worked: it is tried again for LOST_MS. */
    private static boolean reconnecting(JSONObject l) {
        long t = lost(l);
        return t > 0 && System.currentTimeMillis() - t < LOST_MS;
    }

    /** Something to keep the connection for: work, a chat waiting, a lost connection tried again, or the minute after. */
    private static boolean wanted() {
        JSONObject l = live;
        if (chats(l) > 0 || waiting(l) > 0 || reconnecting(l)) return true;
        return idleSince > 0 && SystemClock.elapsedRealtime() - idleSince < LINGER_MS;
    }

    /** The notification id of a chat's own notification (lib/native.ts `idFor`, the same reckoning). */
    static int noteId(String sessionId) {
        int h = 7;
        for (int i = 0; i < sessionId.length(); i++) h = h * 31 + sessionId.charAt(i);
        long id = (Math.abs((long) h) % 2_000_000_000L) + 2;
        return id == ID ? 2_000_000_002 : (int) id;
    }

    static void setLive(Context context, JSONObject next) {
        boolean lostNow = lost(next) > 0;
        boolean busy = chats(next) > 0 || waiting(next) > 0 || lostNow;
        boolean was = chats(live) > 0 || waiting(live) > 0 || lost(live) > 0;
        remember(next);
        live = next;
        liveAt = System.currentTimeMillis();
        if (busy || next.optBoolean("stop")) idleSince = 0;
        else if (was) idleSince = SystemClock.elapsedRealtime();
        // Connected and working again: a line left by a connection that never came back goes.
        if (chats(next) > 0 || waiting(next) > 0) clearLost(context);
        // A chat that left the live set may come back with its next turn: its swipe and its Stop are
        // spent. Not while the connection is lost: the chats are not known then, not gone.
        if (!lostNow) {
            Set<String> now = new HashSet<>();
            JSONArray cs = cards(next);
            for (int i = 0; i < cs.length(); i++) {
                JSONObject c = cs.optJSONObject(i);
                if (c != null) now.add(c.optString("id"));
            }
            dismissed.retainAll(now);
            asking.keySet().retainAll(now);
            stoppingChats.retainAll(now);
        }
        if (self != null) self.changed();
        else if (hidden) startIfWanted(context);
        else if (!drawn.isEmpty()) clearCards(context);
    }

    /** Each chat's newest card, kept a while after it left the live set, so its result can say what it did. */
    private static void remember(JSONObject next) {
        synchronized (Notes.class) {
            long t = System.currentTimeMillis();
            Set<String> now = new HashSet<>();
            JSONArray cs = cards(next);
            for (int i = 0; i < cs.length(); i++) {
                JSONObject c = cs.optJSONObject(i);
                if (c == null) continue;
                String id = c.optString("id");
                now.add(id);
                lastCards.put(id, c);
                leftAt.remove(id);
            }
            for (String id : lastCards.keySet()) if (!now.contains(id) && !leftAt.containsKey(id)) leftAt.put(id, t);
            leftAt.entrySet().removeIf((e) -> {
                if (t - e.getValue() < RESULT_KEEP_MS) return false;
                lastCards.remove(e.getKey());
                return true;
            });
        }
    }

    /** What a chat's result says in its header ("Finished · 3 files changed"), or null when its work was not seen. Called with Notes.class held. */
    static String resultOf(String sessionId, String kind) {
        JSONObject c = lastCards.get(sessionId);
        if (c == null) return null;
        JSONObject r = c.optJSONObject("result");
        if (r == null) return null;
        String s = r.optString("failed".equals(kind) ? "failed" : "done", "");
        return s.isEmpty() ? null : s;
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

    /** Without the service: the cards alone, as ordinary notifications that follow the open socket. */
    private static void fallback(Context context) {
        if (!hidden || chats(live) == 0) {
            fallbackHandler.removeCallbacksAndMessages(null);
            clearCards(context);
        } else if (!fallbackHandler.hasMessages(0)) {
            fallbackHandler.postDelayed(() -> {
                if (!hidden || chats(live) == 0) return;
                drawCards(context);
            }, REDRAW_MS);
        }
    }

    static void onAppVisible(Context context) {
        hidden = false;
        clearLost(context);
        // Also clears cards left by a previous WebView process (fallback clears them when nothing works).
        if (self == null && !startPending) fallback(context);
        startDenied = false;
        if (self != null) self.finish();
        else clearCards(context);
    }

    /** Stop was pressed on a chat's card: it asks once (Stop now, Keep going) for a few seconds. */
    static void askStop(Context context, String sessionId) {
        if (sessionId == null || !drawn.containsKey(sessionId)) return;
        asking.put(sessionId, SystemClock.elapsedRealtime() + ASK_MS);
        fallbackHandler.postDelayed(() -> {
            Long until = asking.get(sessionId);
            if (until != null && SystemClock.elapsedRealtime() >= until) {
                asking.remove(sessionId);
                redrawNow(context);
            }
        }, ASK_MS + 50);
        redrawNow(context);
    }

    static void keepGoing(Context context, String sessionId) {
        if (asking.remove(sessionId) != null) redrawNow(context);
    }

    /** Stop now: confirmed (and unlocked). The page stops the chat if it still runs. */
    static void confirmStop(Context context, String sessionId, Intent intent) {
        if (sessionId == null || asking.remove(sessionId) == null) return;
        stoppingChats.add(sessionId);
        redrawNow(context);
        NotesPlugin.deliverStop(sessionId);
    }

    /** The person swiped a card away: it stays away until its chat's next turn. */
    static void cardDismissed(Context context, String sessionId) {
        if (sessionId == null) return;
        dismissed.add(sessionId);
        drawn.remove(sessionId);
    }

    private static void redrawNow(Context context) {
        if (self != null) {
            self.drawnAt = 0;
            self.handler.removeCallbacks(self.redraw);
            self.draw();
        } else if (hidden) {
            drawCards(context);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startPending = false;
        self = this;
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, summary(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(ID, summary());
            // The cards follow at once (drawnAt stays 0): a summary never stands alone over work.
        } catch (Exception e) {
            startDenied = true;
            finish();
            return START_NOT_STICKY;
        }
        // Off screen the page is kept from being frozen while this service runs (Chromium freezes a hidden page).
        PageLife.keep(true);
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
            // The connection never came back: said once, quietly, so nobody waits for a "Finished" that cannot come.
            if (hidden && lost(live) > 0) lostLine(this);
            finish();
            return;
        }
        JSONObject l = live;
        if (chats(l) > 0 || waiting(l) > 0) return;
        if (lost(l) > 0) handler.postDelayed(check, Math.max(500, LOST_MS - (System.currentTimeMillis() - lost(l))));
        else if (idleSince > 0) handler.postDelayed(check, Math.max(500, LINGER_MS - (SystemClock.elapsedRealtime() - idleSince)));
    }

    /** One quiet line (the connection channel, no sound) once a lost connection is given up off screen; a tap opens home. */
    private static void lostLine(Context c) {
        try {
            Notification n = Notes.base(c, Notes.CH_LINK, "Not connected to your computer", "Open Sable to connect again. It cannot tell you when a chat finishes until then.")
                .setSilent(true)
                .setShowWhen(true)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setContentIntent(Notes.open(c, "sable://home", LOST_ID))
                .build();
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(LOST_ID, n);
        } catch (RuntimeException ignored) {
            // notifications off: nothing to say it with
        }
    }

    private static void clearLost(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(LOST_ID);
    }

    private void finish() {
        stopping = true;
        PageLife.keep(false);
        handler.removeCallbacksAndMessages(null);
        clearCards(getApplicationContext());
        stopSelf();
    }

    private void draw() {
        drawQueued = false;
        if (stopping) return;
        drawnAt = SystemClock.elapsedRealtime();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            // The cards first, then their summary, so the group never shows the summary alone for a frame.
            drawCards(this);
            Notification n = summary();
            if (chats(live) > 0) focus(n, chats(live) == 1 ? live.optString("title", "Sable") : "Sable");
            nm.notify(ID, n);
        } catch (SecurityException ignored) {
            // notifications off: the service still keeps the connection
        }
        handler.removeCallbacks(refresh);
        if (!drawn.isEmpty()) handler.postDelayed(refresh, REFRESH_MS);
    }

    /** Every chat at work gets its card; a chat that left the live set loses its own (unless its news took its place). */
    private static void drawCards(Context c) {
        JSONObject l = live;
        JSONArray cs = cards(l);
        Set<String> keep = new HashSet<>();
        long now = SystemClock.elapsedRealtime();
        for (int i = 0; i < cs.length(); i++) {
            JSONObject card = cs.optJSONObject(i);
            if (card == null) continue;
            String sid = card.optString("id", "");
            if (sid.isEmpty() || dismissed.contains(sid)) continue;
            int id = noteId(sid);
            Long until = asking.get(sid);
            boolean ask = until != null && now < until;
            try {
                if (Notes.postLive(c, id, LiveCards.build(c, card, id, ask, stoppingChats.contains(sid)), liveAt)) {
                    drawn.put(sid, id);
                    keep.add(sid);
                }
            } catch (RuntimeException ignored) {
                // a card that cannot be drawn (a bad icon on an odd system): the summary still says it
            }
        }
        for (Map.Entry<String, Integer> e : new HashMap<>(drawn).entrySet()) {
            if (keep.contains(e.getKey())) continue;
            Notes.cancelLive(c, e.getValue());
            drawn.remove(e.getKey());
        }
    }

    /** Every card goes (the app is on screen, or the service stops). A chat's news at the same id stays. */
    private static void clearCards(Context c) {
        for (Integer id : drawn.values()) Notes.cancelLive(c, id);
        drawn.clear();
        Notes.cancelStrayLive(c);
    }

    /** The service's own notification: the summary of the cards, or alone the quiet line that keeps the connection. */
    private Notification summary() {
        JSONObject l = live;
        int n = chats(l);
        int w = waiting(l);
        if (n == 0) {
            String line = reconnecting(l) ? "Reconnecting to your computer" : w > 1 ? w + " chats waiting for you" : w == 1 ? "A chat is waiting for you" : "Connected to your computer";
            return new NotificationCompat.Builder(this, Notes.CH_LINK)
                .setSmallIcon(R.drawable.ic_stat_sable)
                .setColor(Notes.IVORY)
                .setContentTitle("Sable")
                .setContentText(line)
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setGroup(LiveCards.GROUP)
                .setGroupSummary(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(Notes.base(this, Notes.CH_LINK, "Sable", null).setShowWhen(false).build())
                .setContentIntent(Notes.open(this, "sable://home", ID))
                .build();
        }
        String title = n == 1 ? Notes.cut(l.optString("title", "Working"), 80) : n + " chats working";
        String text = n == 1 ? Notes.cut(l.optString("text", "Working"), 120) : (w > 0 ? w + " waiting for you" : "");
        NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle();
        JSONArray cs = cards(l);
        for (int i = 0; i < cs.length() && i < 6; i++) {
            JSONObject c = cs.optJSONObject(i);
            if (c != null) inbox.addLine(Notes.cut(c.optString("title", "Chat"), 40) + " · " + Notes.cut(c.optString("line", ""), 60));
        }
        inbox.setSummaryText(n + (n == 1 ? " chat working" : " chats working"));
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, Notes.CH_WORKING)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setSmallIcon(R.drawable.ic_stat_sable)
            .setColor(Notes.IVORY)
            .setContentTitle(title)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setWhen(l.optLong("since", System.currentTimeMillis()))
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setStyle(inbox)
            .setGroup(LiveCards.GROUP)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(Notes.base(this, Notes.CH_WORKING, "Sable", n == 1 ? "A chat is working" : n + " chats working").setShowWhen(false).build())
            .setContentIntent(Notes.open(this, n == 1 && !l.optString("chat").isEmpty() ? Notes.chatUri(l.optString("chat"), "turn") : "sable://home", ID));
        if (!text.isEmpty()) b.setContentText(text);
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
        if (self == this) {
            self = null;
            PageLife.keep(false);
        }
        super.onDestroy();
        // Home again during a stop: the newer visibility and work win once this instance has gone.
        if (stopping && hidden && wanted()) startIfWanted(getApplicationContext());
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
