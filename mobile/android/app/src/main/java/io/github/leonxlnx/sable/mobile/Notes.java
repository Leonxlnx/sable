package io.github.leonxlnx.sable.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The chats' notifications, drawn by Android itself (the page decides what they say:
 * mobile/src/lib/notes.ts; lib/native.ts posts them through NotesPlugin).
 *
 * Channels, each in its own tone: "Waiting on you" (high: it sounds and peeks), "Finished"
 * (default), "Working" (low and silent: the live notification while an agent works,
 * KeepAliveService) and "Connection" (min: the connection kept for a minute after work, or while
 * a chat waits). One notification per chat under a fixed id, so its newest state replaces the
 * last; two chats or more are held by one summary. Private on the lock screen: there it shows the
 * chat's name. A tap opens that chat
 * (`sable://chat/<id>?at=prompt|turn`, routed by App.tsx). Allow once and Deny ride on a
 * permission only when the page says the notification shows all of it; they ask for the phone to
 * be unlocked and go through the page's own answer (NoteActionReceiver, the phone's approval path).
 */
final class Notes {
    static final String CH_WAITING = "waiting";
    static final String CH_DONE = "done";
    static final String CH_WORKING = "working";
    static final String CH_LINK = "link";
    static final String GROUP = "sable.chats";
    static final int SUMMARY_ID = 1;
    static final String TOKEN = "sable.noteToken";
    private static final String ACTIONABLE = "sable.canAnswer";
    static final int IVORY = 0xFFF2F1EE;

    private Notes() {}

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel waiting = new NotificationChannel(CH_WAITING, "Waiting on you", NotificationManager.IMPORTANCE_HIGH);
        waiting.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        waiting.enableVibration(true);
        NotificationChannel done = new NotificationChannel(CH_DONE, "Finished", NotificationManager.IMPORTANCE_DEFAULT);
        done.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        NotificationChannel working = new NotificationChannel(CH_WORKING, "Working", NotificationManager.IMPORTANCE_LOW);
        working.setSound(null, null);
        working.enableVibration(false);
        working.setShowBadge(false);
        working.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        NotificationChannel link = new NotificationChannel(CH_LINK, "Connection", NotificationManager.IMPORTANCE_MIN);
        link.setShowBadge(false);
        nm.createNotificationChannel(waiting);
        nm.createNotificationChannel(done);
        nm.createNotificationChannel(working);
        nm.createNotificationChannel(link);
        // The single channel of earlier versions (LocalNotifications'): its notifications now each have their tone.
        if (nm.getNotificationChannel("turns") != null) nm.deleteNotificationChannel("turns");
    }

    /** Opens the app at `uri` (a chat, or home), in this activity. */
    static PendingIntent open(Context c, String uri, int code) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(uri));
        i.setClass(c, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static String chatUri(String sessionId, String at) {
        return "sable://chat/" + Uri.encode(sessionId) + (at == null || at.isEmpty() ? "" : "?at=" + Uri.encode(at));
    }

    private static String label(String kind) {
        if ("waiting".equals(kind)) return "Waiting for you";
        if ("failed".equals(kind)) return "Stopped";
        return "Done";
    }

    /** Posts (or replaces) one chat's notification and, for two chats or more, the summary. */
    static synchronized boolean post(Context c, JSONObject spec) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        if (!nm.areNotificationsEnabled()) return false;
        channels(c);
        int id = spec.optInt("id");
        String sid = spec.optString("sessionId", "");
        String title = cut(spec.optString("title", "Chat"), 120);
        String text = cut(spec.optString("text", ""), 300);
        String kind = spec.optString("kind", "done");
        boolean waiting = "waiting".equals(kind);
        String channel = waiting ? CH_WAITING : CH_DONE;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel target = nm.getNotificationChannel(channel);
            if (target == null || target.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        }
        String label = label(kind);
        PendingIntent tap = open(c, chatUri(sid, waiting ? "prompt" : "turn"), id);

        // The redacted notification carries only the chat's name.
        NotificationCompat.Builder pub = base(c, channel, title, null).setShowWhen(false);

        NotificationCompat.Builder b = base(c, channel, title, text)
            .setSubText(label)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(true)
            .setGroup(GROUP)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setCategory(waiting ? NotificationCompat.CATEGORY_REMINDER : NotificationCompat.CATEGORY_STATUS)
            .setPriority(waiting ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(pub.build())
            .setContentIntent(tap);

        JSONObject ask = spec.optJSONObject("ask");
        JSONArray lines = spec.optJSONArray("lines");
        if (ask != null) {
            String detail = ask.optString("detail", text);
            b.setStyle(new NotificationCompat.BigTextStyle().bigText(detail));
            String token = java.util.UUID.randomUUID().toString();
            b.getExtras().putString(TOKEN, token);
            b.getExtras().putBoolean(ACTIONABLE, true);
            b.addAction(action(c, id, sid, title, ask, "allow", "Allow once", token));
            b.addAction(action(c, id, sid, title, ask, "deny", "Deny", token));
        } else if (lines != null && lines.length() > 1) {
            NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle();
            for (int i = 0; i < lines.length() && i < 5; i++) inbox.addLine(cut(lines.optString(i, ""), 160));
            b.setStyle(inbox);
        } else if (text.length() > 40) {
            b.setStyle(new NotificationCompat.BigTextStyle().bigText(text));
        }
        b.addAction(new NotificationCompat.Action.Builder(0, "Open", tap).build());
        try {
            nm.notify(id, b.build());
        } catch (SecurityException e) {
            return false; // notifications were turned off meanwhile
        }

        int chats = spec.optInt("chats", 1);
        if (chats > 1) summary(c, chats, spec.optJSONArray("summary"), channel);
        return true;
    }

    static synchronized void summary(Context c, int chats, JSONArray lines, String channel) {
        if (channel == null) {
            channel = CH_DONE;
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationManager nm = c.getSystemService(NotificationManager.class);
                for (StatusBarNotification n : nm.getActiveNotifications()) {
                    if (n.getId() != SUMMARY_ID && GROUP.equals(n.getNotification().getGroup())) {
                        channel = n.getNotification().getChannelId();
                        break;
                    }
                }
            }
        }
        String count = chats + (chats == 1 ? " chat" : " chats");
        NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle().setSummaryText(count);
        for (int i = 0; lines != null && i < lines.length() && i < 6; i++) inbox.addLine(cut(lines.optString(i, ""), 160));
        NotificationCompat.Builder group = base(c, channel, "Sable", count)
            .setStyle(inbox)
            .setGroup(GROUP)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(base(c, channel, "Sable", null).setShowWhen(false).build())
            .setContentIntent(open(c, "sable://home", SUMMARY_ID));
        try {
            NotificationManagerCompat.from(c).notify(SUMMARY_ID, group.build());
        } catch (SecurityException ignored) {
            // turned off meanwhile
        }
    }

    /** A stale tap or RPC completion must never change a later post in this chat. */
    private static boolean current(Context c, int id, String token, boolean requireAction) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || token == null) return false;
        for (StatusBarNotification n : nm.getActiveNotifications()) {
            if (n.getId() == id && token.equals(n.getNotification().extras.getString(TOKEN))) {
                return !requireAction || n.getNotification().extras.getBoolean(ACTIONABLE);
            }
        }
        return false;
    }

    /** Remains usable even if the WebView is absent, suspended or offline. */
    static synchronized boolean openToAnswer(Context c, int id, String sessionId, String title, String token) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        if (!nm.areNotificationsEnabled() || !current(c, id, token, true)) return false;
        PendingIntent tap = open(c, chatUri(sessionId, "prompt"), id);
        NotificationCompat.Builder b = base(c, CH_WAITING, title, "Open Sable to answer")
            .setSubText("Waiting for you")
            .setGroup(GROUP)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(base(c, CH_WAITING, title, null).setShowWhen(false).build())
            .setContentIntent(tap)
            .addAction(new NotificationCompat.Action.Builder(0, "Open", tap).build());
        b.getExtras().putString(TOKEN, token);
        try {
            nm.notify(id, b.build());
            return true;
        } catch (SecurityException ignored) {
            return false;
        }
    }

    static synchronized boolean cancelAction(Context c, int id, String token) {
        if (!current(c, id, token, false)) return false;
        NotificationManagerCompat.from(c).cancel(id);
        return true;
    }

    private static NotificationCompat.Action action(Context c, int id, String sid, String title, JSONObject ask, String verb, String label, String token) {
        String requestId = ask.optString("requestId");
        String optionId = ask.optString(verb);
        Intent i = new Intent(c, NoteActionReceiver.class);
        i.setData(new Uri.Builder().scheme("sable").authority("note-action").appendPath(sid).appendPath(requestId).appendPath(optionId).appendPath(token).build());
        i.putExtra(TOKEN, token);
        i.putExtra("detail", ask.optString("detail"));
        i.putExtra("deviceId", ask.optString("deviceId"));
        i.setAction("io.github.leonxlnx.sable.mobile.NOTE_" + verb.toUpperCase(java.util.Locale.US));
        i.putExtra("noteId", id);
        i.putExtra("sessionId", sid);
        i.putExtra("title", title);
        i.putExtra("requestId", requestId);
        i.putExtra("optionId", optionId);
        i.putExtra("verb", verb);
        PendingIntent pi = PendingIntent.getBroadcast(c, id, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_ONE_SHOT);
        // An answer from the notification needs the phone unlocked (Android 12 and later; before, the
        // lock screen shows the public version, which has no keys).
        return new NotificationCompat.Action.Builder(0, label, pi).setAuthenticationRequired(true).build();
    }

    static NotificationCompat.Builder base(Context c, String channel, String title, String text) {
        return new NotificationCompat.Builder(c, channel)
            .setSmallIcon(R.drawable.ic_stat_sable)
            .setColor(IVORY)
            .setContentTitle(title)
            .setContentText(text);
    }

    static synchronized void cancel(Context c, JSONArray ids) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        for (int i = 0; ids != null && i < ids.length(); i++) nm.cancel(ids.optInt(i));
    }

    /** The ids of this app's notifications Android shows now (the live one left out). */
    static JSONArray active(Context c) {
        JSONArray out = new JSONArray();
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return out;
        for (StatusBarNotification n : nm.getActiveNotifications()) if (n.getId() != KeepAliveService.ID) out.put(n.getId());
        return out;
    }

    /** Every chat's notification goes (the live one goes with its service). */
    static synchronized void clearAll(Context c) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        NotificationManager raw = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (raw == null) {
            nm.cancelAll();
            return;
        }
        for (StatusBarNotification n : raw.getActiveNotifications()) if (n.getId() != KeepAliveService.ID) nm.cancel(n.getId());
    }

    static String cut(String s, int n) {
        if (s == null) return "";
        String t = s.trim();
        return t.length() > n ? t.substring(0, n - 1).trim() + "…" : t;
    }
}
