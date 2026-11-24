package io.github.leonxlnx.sable.mobile;

import android.content.BroadcastReceiver;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;

/**
 * Allow once or Deny on a chat's notification. The answer is the page's to give (it checks the
 * request is still waiting and still the one the notification showed, then answers through the
 * phone's own approval path, which the computer checks again). Open stays available if the page
 * cannot deliver the answer. A confirmed answer clears only the notification that supplied it.
 */
public class NoteActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        int noteId = intent.getIntExtra("noteId", 0);
        String sessionId = intent.getStringExtra("sessionId");
        String requestId = intent.getStringExtra("requestId");
        String optionId = intent.getStringExtra("optionId");
        String verb = intent.getStringExtra("verb");
        String title = intent.getStringExtra("title");
        String token = intent.getStringExtra(Notes.TOKEN);
        String detail = intent.getStringExtra("detail");
        if (sessionId == null || requestId == null || optionId == null || detail == null || !("allow".equals(verb) || "deny".equals(verb))) return;
        if (title == null) title = "Chat";
        if (!Notes.openToAnswer(context, noteId, sessionId, title, token)) return;
        KeyguardManager lock = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        if (lock != null && !lock.isKeyguardLocked()) NotesPlugin.deliver(intent);
    }
}
