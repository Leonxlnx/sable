package io.github.leonxlnx.sable.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        registerPlugin(FilesPlugin.class);
        registerPlugin(SystemPlugin.class);
        super.onCreate(savedInstanceState);
        // The keyboard lifts the page's own bottom on its curve instead of shrinking the page at once.
        ImeLift.install(this, getBridge().getWebView());
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
        KeepAliveService.stop(this);
    }
}
