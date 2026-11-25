package io.github.leonxlnx.sable.mobile;

import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewTreeObserver;
import android.webkit.WebView;
import java.lang.ref.WeakReference;

/**
 * Keeps the app's page from being frozen while KeepAliveService runs, and tells the page whether the
 * person can see the app.
 *
 * Chromium freezes a hidden page (the Page Lifecycle `freeze`: its timers and its socket's events
 * stop) a while after it was hidden: 5 minutes up to WebView 142, 1 minute since 143 (Blink's
 * `stop-in-background`, page_scheduler_impl.cc, counted from the page's last visibility change).
 * Only being visible or audible keeps a page from it; an open WebSocket or a Web Lock does not. The
 * page holds the only connection to the computer and decides every notification, so frozen it would
 * tell nothing (no "Finished", no "Waiting for you", cards left as they were) until opened again.
 *
 * WebView takes its page's visibility from its window's (BrowserViewRenderer::IsClientVisible: not
 * paused, attached and its window visible; the view's own visibility does not count). While the
 * service runs (a chat works or waits, a lost connection is tried again, or the minute after) and the
 * app is off screen, the WebView is told its window is visible for a moment every `PULSE_MS`: each
 * change of visibility starts Blink's freeze clock again, so the page is never frozen, and between
 * the moments it is an ordinary hidden page (its socket's events arrive at once, timers at most once
 * a second, no frames). Held visible all the time instead, the page kept the main thread busy with a
 * frame loop nobody sees (about 9% of a core on the emulator). When the service stops the WebView
 * hears only the system's word again and the page may sleep.
 *
 * The page therefore never reads its visibility as "the person looks": it asks lib/screen.ts, which
 * this class feeds with the activity's own state (onStart / onStop: `window.__sableScreen(bool)`, and
 * SystemPlugin `screen` at start).
 */
public final class PageLife {
    /** How often the page is shown for a moment: well inside the freeze delay (60 s now, 300 s before). */
    static final long PULSE_MS = 20_000L;
    /** How long a moment is: long enough for WebView's own posted update and the renderer to see it. */
    static final long LIFT_MS = 300L;

    private static WeakReference<WebView> view = new WeakReference<>(null);
    /** KeepAliveService runs as a foreground service. */
    private static boolean keep;
    /** The activity is started (on screen, or visible behind a dialog). */
    private static volatile boolean shown;
    /** A moment of visibility is under way. */
    private static boolean lifted;
    /** The window visibility the WebView heard last, from the system or from here. */
    private static int heard = View.VISIBLE;
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static final Runnable pulse = PageLife::pulse;
    private static final Runnable rest = () -> {
        lifted = false;
        apply();
    };

    private PageLife() {}

    /** Called once the bridge made its WebView (main thread). */
    static void install(WebView w) {
        view = new WeakReference<>(w);
        heard = w.getWindowVisibility();
        ViewTreeObserver.OnWindowVisibilityChangeListener listener = (visibility) -> {
            // The system has just told the WebView itself (ViewRootImpl dispatches to the views first).
            heard = visibility;
            apply();
        };
        w.getViewTreeObserver().addOnWindowVisibilityChangeListener(listener);
        // A tree observer taken before the view is attached is merged into the window's on attach; a
        // WebView moved to another window gets the listener again.
        w.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            @Override
            public void onViewAttachedToWindow(View v) {
                ViewTreeObserver o = v.getViewTreeObserver();
                o.removeOnWindowVisibilityChangeListener(listener);
                o.addOnWindowVisibilityChangeListener(listener);
                heard = v.getWindowVisibility();
                apply();
            }

            @Override
            public void onViewDetachedFromWindow(View v) {}
        });
    }

    /** KeepAliveService became a foreground service (true) or stops (false). Main thread. */
    static void keep(boolean on) {
        if (keep == on) return;
        keep = on;
        // Started while the app is already off screen: the page may have been hidden a while, so a moment now.
        schedule(on && !shown ? 0 : PULSE_MS);
    }

    /** The activity was started (true) or stopped (false): the page hears it at once. Main thread. */
    static void shown(boolean on) {
        shown = on;
        // Just left the screen: the page was visible a moment ago, the first moment comes a period later.
        schedule(PULSE_MS);
        WebView w = view.get();
        if (w == null) return;
        // Straight into the page: a plugin event may wait for the page, and the order of the two must hold.
        w.evaluateJavascript("window.__sableScreen&&window.__sableScreen(" + on + ")", null);
    }

    static boolean isShown() {
        return shown;
    }

    /** The moments run while the service runs and the app is off screen, the first after `firstMs`. */
    private static void schedule(long firstMs) {
        handler.removeCallbacks(pulse);
        handler.removeCallbacks(rest);
        lifted = false;
        if (keep && !shown) handler.postDelayed(pulse, firstMs);
        apply();
    }

    private static void pulse() {
        if (!keep || shown) return;
        lifted = true;
        apply();
        handler.postDelayed(rest, LIFT_MS);
        handler.postDelayed(pulse, PULSE_MS);
    }

    /**
     * What the WebView should believe: VISIBLE while the activity is started (its window's own
     * visibility arrives with the next traversal: the service stopped in onResume must not hide the
     * page for that frame) or for a moment of a pulse, else the system's word.
     */
    private static void apply() {
        WebView w = view.get();
        if (w == null) return;
        int system = w.getWindowVisibility();
        int want = shown || lifted ? View.VISIBLE : system;
        if (want == heard) return;
        heard = want;
        w.dispatchWindowVisibilityChanged(want);
    }
}
