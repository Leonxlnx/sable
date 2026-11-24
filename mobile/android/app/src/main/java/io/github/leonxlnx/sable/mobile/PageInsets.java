package io.github.leonxlnx.sable.mobile;

import android.app.Activity;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import java.util.List;
import java.util.Locale;

/**
 * The page's edges, in one place, the same on every phone. The window is always edge to edge (the
 * page draws under the status bar, the gesture pill and a camera cutout) and nothing native is ever
 * padded; the page is told, in CSS px, how far each edge's bars reach and how far the keyboard will
 * lift its bottom (`window.__sableInsets([top, right, bottom, left], lift, ms)`, read by
 * lib/keyboard.ts into `--sat` `--sar` `--sab` `--sal` `--kb` `--kb-ms`).
 *
 * Before this the page leaned on Capacitor's SystemBars, which takes one of two paths by the
 * WebView's version: before 140 it pads the window (the emulator's 124: a black band under the
 * page), from 140 on it passes the insets through to the WebView (the owner's phone), and the page
 * guessed which path ran from the window's padding. Only the first path could ever be run here.
 * Now there is one path, whatever the WebView: SystemBars' insets handling is off
 * (capacitor.config.ts), and the WebView never hears of the bars or the keyboard (it would shrink
 * its visual viewport for the keyboard and pan the page).
 *
 * The keyboard: the page keeps its size; at the start of the keyboard's slide it is told where the
 * keyboard will end and how long the slide takes, and lifts its own bottom on the same curve.
 */
final class PageInsets {
    private static final int BARS = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
    private static final int GESTURES = WindowInsetsCompat.Type.mandatorySystemGestures();
    private static final int IME = WindowInsetsCompat.Type.ime();

    private static final class State {
        int top, right, bottom, left, lift;
        WindowInsetsAnimationCompat animation;
        String sent = "";
    }

    private final State st = new State();

    void install(Activity activity, WebView webView) {
        if (webView == null) return;
        Window window = activity.getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        if (Build.VERSION.SDK_INT >= 29) {
            // No scrim behind a transparent gesture bar: the page's own ink shows under the pill.
            window.setNavigationBarContrastEnforced(false);
            window.setStatusBarContrastEnforced(false);
        }
        final View decor = window.getDecorView();

        ViewCompat.setOnApplyWindowInsetsListener(decor, (v, insets) -> {
            if (v.getPaddingLeft() != 0 || v.getPaddingTop() != 0 || v.getPaddingRight() != 0 || v.getPaddingBottom() != 0) v.setPadding(0, 0, 0, 0);
            Insets bars = insets.getInsets(BARS);
            // The gesture pill's own strip, where a swipe goes home: never under a control.
            Insets gestures = insets.getInsets(GESTURES);
            int bottom = Math.max(bars.bottom, gestures.bottom);
            int ime = insets.isVisible(IME) ? insets.getInsets(IME).bottom : 0;
            st.top = bars.top;
            st.right = bars.right;
            st.left = bars.left;
            st.bottom = bottom;
            st.lift = Math.max(0, ime - bottom);
            push(webView, st, false, 0);
            // The page's children get nothing to act on: every edge is the page's own to keep.
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(BARS, Insets.NONE)
                .setInsets(IME, Insets.NONE)
                .setVisible(IME, false)
                .build();
        });

        ViewCompat.setWindowInsetsAnimationCallback(
            decor,
            new WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP) {
                @Override
                public void onPrepare(@NonNull WindowInsetsAnimationCompat animation) {
                    if ((animation.getTypeMask() & IME) != 0) st.animation = animation;
                }

                @NonNull
                @Override
                public WindowInsetsAnimationCompat.BoundsCompat onStart(
                    @NonNull WindowInsetsAnimationCompat animation,
                    @NonNull WindowInsetsAnimationCompat.BoundsCompat bounds
                ) {
                    if (st.animation == animation) {
                        long ms = animation.getDurationMillis();
                        push(webView, st, true, ms < 0 ? 280 : Math.min(500, ms));
                    }
                    return bounds;
                }

                @NonNull
                @Override
                public WindowInsetsCompat onProgress(@NonNull WindowInsetsCompat insets, @NonNull List<WindowInsetsAnimationCompat> running) {
                    return insets;
                }

                @Override
                public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
                    if (st.animation == animation) {
                        st.animation = null;
                        // An interrupted IME slide can end somewhere other than its original target.
                        ViewCompat.requestApplyInsets(decor);
                    }
                }
            }
        );
        ViewCompat.requestApplyInsets(decor);
    }

    /** A page that just loaded asks again (what was sent before it existed went to the page before it). */
    void again(Activity activity) {
        View decor = activity.getWindow().getDecorView();
        decor.post(() -> {
            st.sent = "";
            st.animation = null;
            ViewCompat.requestApplyInsets(decor);
        });
    }

    private static void push(WebView webView, State st, boolean force, long ms) {
        // While the keyboard slides, its end was sent at its start; nothing in between.
        if (st.animation != null && !force) return;
        float density = webView.getResources().getDisplayMetrics().density;
        final String js = String.format(
            Locale.US,
            "window.__sableInsetsState=[[%.1f,%.1f,%.1f,%.1f],%.1f,%d];window.__sableInsets&&window.__sableInsets([%.1f,%.1f,%.1f,%.1f],%.1f,%d)",
            st.top / density, st.right / density, st.bottom / density, st.left / density, st.lift / density, ms,
            st.top / density, st.right / density, st.bottom / density, st.left / density, st.lift / density, ms
        );
        // The same edges again (a dispatch for another reason) cost the page nothing.
        if (!force && js.equals(st.sent)) return;
        st.sent = js;
        webView.post(() -> webView.evaluateJavascript(js, null));
    }
}
