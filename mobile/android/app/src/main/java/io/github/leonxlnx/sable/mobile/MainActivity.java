package io.github.leonxlnx.sable.mobile;

import android.os.Bundle;
import android.content.res.Configuration;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private final PageInsets insets = new PageInsets();
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FilesPlugin.class);
        registerPlugin(SystemPlugin.class);
        registerPlugin(NotesPlugin.class);
        super.onCreate(savedInstanceState);
        // The page's edges and the keyboard, one path on every phone (PageInsets).
        insets.install(this, getBridge().getWebView());
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                insets.again(MainActivity.this);
            }
        });
        Notes.channels(this);
    }

    @Override
    public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        insets.again(this);
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
