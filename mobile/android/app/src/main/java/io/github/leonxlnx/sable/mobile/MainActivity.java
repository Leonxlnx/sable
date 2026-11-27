package io.github.leonxlnx.sable.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.content.res.Configuration;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private final PageInsets insets = new PageInsets();
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FilesPlugin.class);
        registerPlugin(SystemPlugin.class);
        registerPlugin(NotesPlugin.class);
        super.onCreate(savedInstanceState);
        // Capacitor shows its recovery layout and leaves the bridge null if WebView creation fails.
        // Leave that screen in place. Neither insets nor a page listener can be installed without a bridge.
        Bridge bridge = getBridge();
        if (bridge == null) return;
        // The page's edges and the keyboard, one path on every phone (PageInsets).
        insets.install(this, bridge.getWebView());
        // Awake off screen while a chat works (PageLife), and the page told whether it is on screen.
        PageLife.install(bridge.getWebView());
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                insets.again(MainActivity.this);
            }
        });
        Notes.channels(this);
        takeShare(getIntent());
    }

    // Another app's share sheet (2.22): text or a link handed to Sable goes to the page, which asks which
    // chat's draft it belongs in (SystemPlugin.shared). Nothing is sent by itself.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        takeShare(intent);
    }

    private void takeShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        // Taken once: a recreated activity (a rotation) does not hand it over again.
        intent.setAction(null);
        Bridge bridge = getBridge();
        if (text == null || bridge == null) return;
        PluginHandle h = bridge.getPlugin("System");
        if (h != null && h.getInstance() instanceof SystemPlugin) ((SystemPlugin) h.getInstance()).shared(text.toString(), subject);
    }

    @Override
    public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        insets.again(this);
    }

    // On screen or not, as the page reads it (lib/screen.ts): the activity's own word, never the page's
    // visibility, which PageLife holds at visible while a chat works off screen.
    @Override
    public void onStart() {
        super.onStart();
        PageLife.shown(true);
    }

    @Override
    public void onStop() {
        super.onStop();
        PageLife.shown(false);
    }

    // Leaving the screen with a chat at work: the connection stays (KeepAliveService); back on screen, it is not needed.
    @Override
    public void onPause() {
        super.onPause();
        KeepAliveService.onAppHidden(this);
    }

    @Override
    public void onResume() {
        super.onResume();
        KeepAliveService.onAppVisible(this);
    }
}
