package io.github.leonxlnx.sable.mobile;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

/**
 * The home-screen widget (2.22): how many chats work and how many wait on the person, as the page last
 * counted them (SystemPlugin `widget`, written whenever the counts change while the page lives; the
 * page lives while a chat works, PageLife). A count older than a quarter hour is not believed (the app
 * may have been closed since): the widget then shows dashes until the app counts again. A tap opens
 * Sable. Nothing here asks the computer anything.
 */
public class NowWidget extends AppWidgetProvider {
    private static final String PREFS = "sable.widget";
    private static final long STALE_MS = 15 * 60_000L;
    private static final int AMBER = 0xFFF0C14B;
    private static final int INK = 0xFFF2F1EE;
    private static final int QUIET = 0xFF57564F;

    /** The page's count, kept for the widget, then every widget drawn again. */
    static void put(Context context, int working, int waiting, String desktop) {
        SharedPreferences.Editor e = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        e.putInt("working", Math.max(0, working));
        e.putInt("waiting", Math.max(0, waiting));
        e.putLong("at", System.currentTimeMillis());
        if (desktop != null) e.putString("desktop", desktop.length() > 60 ? desktop.substring(0, 60) : desktop);
        e.apply();
        refresh(context);
    }

    static void refresh(Context context) {
        AppWidgetManager m = AppWidgetManager.getInstance(context);
        int[] ids = m.getAppWidgetIds(new ComponentName(context, NowWidget.class));
        if (ids.length > 0) for (int id : ids) m.updateAppWidget(id, views(context));
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) manager.updateAppWidget(id, views(context));
    }

    private static RemoteViews views(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long at = p.getLong("at", 0);
        boolean known = at > 0 && System.currentTimeMillis() - at < STALE_MS;
        int working = p.getInt("working", 0);
        int waiting = p.getInt("waiting", 0);
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_now);
        v.setTextViewText(R.id.widget_working, known ? String.valueOf(working) : "–");
        v.setTextViewText(R.id.widget_waiting, known ? String.valueOf(waiting) : "–");
        v.setTextColor(R.id.widget_working, known && working > 0 ? INK : QUIET);
        v.setTextColor(R.id.widget_waiting, known && waiting > 0 ? AMBER : QUIET);
        v.setTextViewText(R.id.widget_desktop, p.getString("desktop", "Sable"));
        v.setContentDescription(R.id.widget_root, known ? working + " working, " + waiting + " waiting for you. Open Sable" : "Open Sable");
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        v.setOnClickPendingIntent(R.id.widget_root, pi);
        return v;
    }
}
