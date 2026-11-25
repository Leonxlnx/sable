package io.github.leonxlnx.sable.mobile;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.widget.RemoteViews;
import androidx.core.app.NotificationCompat;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * One chat's live card while its agent works, drawn from the page's card (mobile/src/lib/note-live.ts
 * `liveCard`): the chat's name and agent, what it does now by kind of step, the turn's clock, the open
 * checkpoint's steps and time, a segment per checkpoint closed, the other chats at work or waiting, and
 * Open and Stop. It stands at the chat's own notification id, so the chat's next news (done, waiting)
 * takes its place: the same notification becomes the result (Notes.post).
 *
 * - Android 16: a ProgressStyle notification that asks to be promoted as a Live Update (no RemoteViews,
 *   not colorized, not a summary, a channel above MIN: the platform's rules). The status bar chip is
 *   the small icon and the turn's clock (the chronometer counts up from when the work began, so the
 *   chip ticks without a redraw from the app). Segments: one per checkpoint closed, filled, and the open
 *   one after them; before the first closes, the bar moves by itself (indeterminate).
 * - Android 14 and 15 (and older): the same facts in Sable's own layout inside the system's frame
 *   (DecoratedCustomViewStyle): the agent's mark, the name, the line, and expanded a meter of
 *   checkpoints (a filled bar each, the open one a track with a dithered head, like the app's meter),
 *   the checkpoint's own clock and the others. Text takes the system's notification styles, so it reads
 *   on a light and a dark shade alike.
 *
 * The small icon is Sable's mark with one cell lit per step in dither order (the app's working mark,
 * one frame per step, never an animation), the whole mark once the turn has ended.
 */
final class LiveCards {
    static final String EXTRA_LIVE = "sable.live";
    static final String EXTRA_SESSION = "sable.session";
    static final String GROUP = "sable.live";
    static final String ACTION_STOP_ASK = "io.github.leonxlnx.sable.mobile.LIVE_STOP_ASK";
    static final String ACTION_STOP = "io.github.leonxlnx.sable.mobile.LIVE_STOP";
    static final String ACTION_STOP_KEEP = "io.github.leonxlnx.sable.mobile.LIVE_STOP_KEEP";
    static final String ACTION_DISMISSED = "io.github.leonxlnx.sable.mobile.LIVE_DISMISSED";
    /** A card not refreshed for this long goes by itself (a process that died leaves no "Working" behind). */
    static final long TTL_MS = 10 * 60_000L;
    private static final int SEGMENTS = 10;

    /** The mark's cells (column, row) and their dither order, as mobile/src/ui/marks.tsx `MARK_CELLS` / `TILE_ORDER`. */
    private static final int[][] CELLS = {
        {0, 0}, {2, 2}, {2, 0}, {0, 2}, {1, 1}, {3, 3}, {3, 1}, {1, 3},
        {1, 0}, {3, 0}, {1, 2}, {0, 1}, {2, 1}, {0, 3},
    };
    private static final int[][] TILE_ORDER = {
        {0, 8, 2, 10},
        {12, 4, 14, 6},
        {3, 11, 1, 9},
        {15, 7, 13, 5},
    };

    private LiveCards() {}

    static boolean night(Context c) {
        return (c.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    /** The ink of marks and the meter on this shade: ivory on a dark one, ink on a light one. */
    static int inkOn(Context c) {
        return night(c) ? Notes.IVORY : 0xFF141417;
    }

    /** Sable's mark, `lit` of its 14 cells at full strength in dither order, the rest faint (14: the whole mark). */
    static Icon mark(Context c, int lit) {
        float d = c.getResources().getDisplayMetrics().density;
        int size = Math.max(24, Math.round(24 * d));
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(0xFFFFFFFF);
        float cell = size / 6f;
        float at = cell;
        int n = Math.max(0, Math.min(14, lit));
        // The cells ranked by dither order: the first `n` of them are lit.
        Integer[] order = new Integer[CELLS.length];
        for (int i = 0; i < order.length; i++) order[i] = i;
        java.util.Arrays.sort(order, (a, b) -> TILE_ORDER[CELLS[a][1]][CELLS[a][0]] - TILE_ORDER[CELLS[b][1]][CELLS[b][0]]);
        boolean[] on = new boolean[CELLS.length];
        for (int i = 0; i < n; i++) on[order[i]] = true;
        for (int i = 0; i < CELLS.length; i++) {
            p.setAlpha(on[i] ? 255 : 72);
            float x = at + CELLS[i][0] * cell;
            float y = at + CELLS[i][1] * cell;
            cv.drawRect(x, y, x + cell, y + cell, p);
        }
        return Icon.createWithBitmap(bmp);
    }

    /**
     * How many cells the icon lights for a turn of `steps` steps: one more per step, round again after
     * the whole mark; the whole mark while no step is known (a chat the phone has not opened).
     */
    static int litFor(int steps) {
        return steps <= 0 ? 14 : 1 + Math.floorMod(steps - 1, 14);
    }

    static int agentIcon(String agent) {
        if ("claude".equals(agent)) return R.drawable.ic_agent_claude;
        if ("codex".equals(agent)) return R.drawable.ic_agent_codex;
        if ("opencode".equals(agent)) return R.drawable.ic_agent_opencode;
        return R.drawable.ic_agent_demo;
    }

    /** Codex and OpenCode wear the ink of the text; Claude Code and the Demo their own colour. */
    static boolean agentInked(String agent) {
        return "codex".equals(agent) || "opencode".equals(agent);
    }

    static Icon agentMark(Context c, String agent) {
        Icon i = Icon.createWithResource(c, agentIcon(agent));
        if (agentInked(agent)) i.setTint(inkOn(c));
        return i;
    }

    /**
     * The meter of checkpoints, drawn once per change at the width it will be shown: a filled bar per
     * checkpoint closed and, after them, the open one: a faint track whose first 8dp are a dithered
     * head (the app's meter, `lm-fill::after`). A gap of 3dp between bars, ends rounded.
     */
    static Bitmap meter(Context c, int done, int widthPx) {
        float d = c.getResources().getDisplayMetrics().density;
        int h = Math.max(4, Math.round(4 * d));
        int w = Math.max(40, widthPx);
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);
        int ink = inkOn(c);
        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        fill.setColor(ink);
        fill.setAlpha(Math.round(255 * 0.82f));
        Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
        track.setColor(ink);
        track.setAlpha(Math.round(255 * (night(c) ? 0.10f : 0.12f)));
        int bars = Math.max(0, Math.min(SEGMENTS, done)) + 1;
        float gap = Math.round(3 * d);
        float seg = (w - gap * (bars - 1)) / bars;
        float r = h / 2f;
        for (int i = 0; i < bars; i++) {
            float x = i * (seg + gap);
            RectF box = new RectF(x, 0, x + seg, h);
            if (i < bars - 1) {
                cv.drawRoundRect(box, r, r, fill);
                continue;
            }
            cv.drawRoundRect(box, r, r, track);
            // The dithered head: a checker of whole device pixels, two pixels a cell, 8dp long.
            Paint dot = new Paint();
            dot.setColor(ink);
            dot.setAlpha(Math.round(255 * 0.82f));
            int cellPx = Math.max(1, Math.round(d * 0.75f));
            int head = Math.round(8 * d);
            for (int yy = 0; yy < h; yy += cellPx) {
                for (int xx = 0; xx < head && x + xx < x + seg; xx += cellPx) {
                    if (((xx / cellPx) + (yy / cellPx)) % 2 == 0) cv.drawRect(x + xx, yy, x + xx + cellPx, yy + cellPx, dot);
                }
            }
        }
        return bmp;
    }

    /** The width the expanded layout gives the meter: the shade's width less its margins and the card's padding. */
    static int meterWidth(Context c) {
        DisplayMetrics m = c.getResources().getDisplayMetrics();
        int shade = Math.min(m.widthPixels, Math.round(560 * m.density));
        return Math.max(80, shade - Math.round(64 * m.density));
    }

    static PendingIntent broadcast(Context c, String action, String sessionId, int code) {
        Intent i = new Intent(c, NoteActionReceiver.class);
        i.setAction(action);
        i.setData(new Uri.Builder().scheme("sable").authority("live").appendPath(sessionId).appendPath(action).build());
        i.putExtra("sessionId", sessionId);
        return PendingIntent.getBroadcast(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** The card for one chat. `asking`: Stop was pressed and waits for its confirmation. */
    static Notification build(Context c, JSONObject card, int noteId, boolean asking, boolean stopping) {
        String sid = card.optString("id", "");
        String title = Notes.cut(card.optString("title", "Chat"), 80);
        String line = Notes.cut(card.optString("line", "Working"), 120);
        String meta = Notes.cut(card.optString("meta", ""), 80);
        String others = Notes.cut(card.optString("others", ""), 80);
        String agent = card.optString("agent", "");
        long since = card.optLong("since", System.currentTimeMillis());
        long at = card.optLong("at", 0);
        int steps = card.optInt("steps", 0);
        int done = Math.max(0, Math.min(SEGMENTS, card.optInt("done", 0)));
        boolean canStop = false;
        JSONArray keys = card.optJSONArray("keys");
        for (int i = 0; keys != null && i < keys.length(); i++) if ("stop".equals(keys.optString(i))) canStop = true;
        if (stopping) line = "Stopping";
        else if (asking) line = "Stop this turn?";
        PendingIntent tap = Notes.open(c, Notes.chatUri(sid, "turn"), noteId);
        PendingIntent gone = broadcast(c, ACTION_DISMISSED, sid, noteId ^ 0x5a5a);
        List<Notification.Action> actions = new ArrayList<>();
        List<NotificationCompat.Action> compat = new ArrayList<>();
        if (asking && canStop && !stopping) {
            PendingIntent now = broadcast(c, ACTION_STOP, sid, noteId ^ 0x2b2b);
            PendingIntent keep = broadcast(c, ACTION_STOP_KEEP, sid, noteId ^ 0x3c3c);
            actions.add(new Notification.Action.Builder(null, "Stop now", now).setAuthenticationRequired(true).build());
            actions.add(new Notification.Action.Builder(null, "Keep going", keep).build());
            compat.add(new NotificationCompat.Action.Builder(0, "Stop now", now).setAuthenticationRequired(true).build());
            compat.add(new NotificationCompat.Action.Builder(0, "Keep going", keep).build());
        } else {
            actions.add(new Notification.Action.Builder(null, "Open", tap).build());
            compat.add(new NotificationCompat.Action.Builder(0, "Open", tap).build());
            if (canStop && !stopping) {
                PendingIntent ask = broadcast(c, ACTION_STOP_ASK, sid, noteId ^ 0x1a1a);
                actions.add(new Notification.Action.Builder(null, "Stop", ask).build());
                compat.add(new NotificationCompat.Action.Builder(0, "Stop", ask).build());
            }
        }
        // What the header says beside the app's name: the checkpoint; before one is known, the rest of
        // the live set (each chat at work has its own card beside this one, so it is not said twice).
        String sub = meta.isEmpty() ? others : meta;
        Icon small = mark(c, litFor(steps));
        if (Build.VERSION.SDK_INT >= 36) return promoted(c, card, title, line, sub, since, done, agent, small, tap, gone, actions, noteId);
        return custom(c, title, line, meta, others, since, at, done, agent, small, tap, gone, compat, sid);
    }

    /** The public version: only the chat's name and that it works (the lock screen of a person who hides details). */
    private static Notification hidden(Context c, String title, long since) {
        return new NotificationCompat.Builder(c, Notes.CH_WORKING)
            .setSmallIcon(R.drawable.ic_stat_sable)
            .setColor(Notes.IVORY)
            .setContentTitle(title)
            .setContentText("Working")
            .setWhen(since)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .build();
    }

    private static Notification promoted(Context c, JSONObject card, String title, String line, String sub, long since, int done, String agent, Icon small,
                                         PendingIntent tap, PendingIntent gone, List<Notification.Action> actions, int noteId) {
        Notification.ProgressStyle style = new Notification.ProgressStyle().setStyledByProgress(true);
        if (done == 0) {
            style.setProgressIndeterminate(true);
        } else {
            for (int i = 0; i <= done; i++) style.addProgressSegment(new Notification.ProgressStyle.Segment(100));
            style.setProgress(done * 100);
        }
        style.setProgressStartIcon(agentMark(c, agent));
        Notification.Builder b = new Notification.Builder(c, Notes.CH_WORKING)
            .setSmallIcon(small)
            .setColor(Notes.IVORY)
            .setContentTitle(title)
            .setContentText(line)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setWhen(since)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(hidden(c, title, since))
            .setGroup(GROUP)
            .setTimeoutAfter(TTL_MS)
            .setContentIntent(tap)
            .setDeleteIntent(gone)
            .setStyle(style);
        if (!sub.isEmpty()) b.setSubText(sub);
        for (Notification.Action a : actions) b.addAction(a);
        Bundle ex = new Bundle();
        // Notification.EXTRA_REQUEST_PROMOTED_ONGOING (public from Android 16 QPR2; read by 16 as well).
        ex.putBoolean("android.requestPromotedOngoing", true);
        ex.putBoolean(EXTRA_LIVE, true);
        ex.putString(EXTRA_SESSION, card.optString("id", ""));
        b.addExtras(ex);
        return b.build();
    }

    private static Notification custom(Context c, String title, String line, String meta, String others, long since, long at, int done, String agent, Icon small,
                                       PendingIntent tap, PendingIntent gone, List<NotificationCompat.Action> actions, String sid) {
        String pkg = c.getPackageName();
        RemoteViews small1 = new RemoteViews(pkg, R.layout.notif_live);
        small1.setImageViewIcon(R.id.live_agent, agentMark(c, agent));
        small1.setTextViewText(R.id.live_title, title);
        small1.setTextViewText(R.id.live_line, line);

        RemoteViews big = new RemoteViews(pkg, R.layout.notif_live_big);
        big.setImageViewIcon(R.id.live_agent, agentMark(c, agent));
        big.setTextViewText(R.id.live_title, title);
        big.setTextViewText(R.id.live_line, line);
        big.setImageViewBitmap(R.id.live_meter, meter(c, done, meterWidth(c)));
        big.setTextViewText(R.id.live_meta, meta.isEmpty() ? "Working" : meta);
        // The checkpoint's own clock (the header's counts the whole turn).
        long from = at > 0 ? at : since;
        big.setChronometer(R.id.live_clock, SystemClock.elapsedRealtime() - Math.max(0, System.currentTimeMillis() - from), null, true);
        if (others.isEmpty()) {
            big.setViewVisibility(R.id.live_others, android.view.View.GONE);
        } else {
            big.setViewVisibility(R.id.live_others, android.view.View.VISIBLE);
            big.setTextViewText(R.id.live_others, others);
        }

        NotificationCompat.Builder b = new NotificationCompat.Builder(c, Notes.CH_WORKING)
            .setSmallIcon(androidx.core.graphics.drawable.IconCompat.createFromIcon(c, small))
            .setColor(Notes.IVORY)
            .setContentTitle(title)
            .setContentText(line)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setWhen(since)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(hidden(c, title, since))
            .setGroup(GROUP)
            .setTimeoutAfter(TTL_MS)
            .setContentIntent(tap)
            .setDeleteIntent(gone)
            .setStyle(new NotificationCompat.DecoratedCustomViewStyle())
            .setCustomContentView(small1)
            .setCustomBigContentView(big);
        for (NotificationCompat.Action a : actions) b.addAction(a);
        b.getExtras().putBoolean(EXTRA_LIVE, true);
        b.getExtras().putString(EXTRA_SESSION, sid);
        return b.build();
    }
}
