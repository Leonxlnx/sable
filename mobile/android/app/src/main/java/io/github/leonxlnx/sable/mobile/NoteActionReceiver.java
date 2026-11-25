package io.github.leonxlnx.sable.mobile;

import android.content.BroadcastReceiver;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;

/**
 * The keys on Sable's notifications.
 *
 * - Allow once or Deny on a chat's notification. The answer is the page's to give (it checks the
 *   request is still waiting and still the one the notification showed, then answers through the
 *   phone's own approval path, which the computer checks again). Open stays available if the page
 *   cannot deliver the answer. A confirmed answer clears only the notification that supplied it.
 * - A live card's Stop (it asks once: the card turns into Stop now and Keep going), Stop now (only
 *   with the phone unlocked; the page checks the chat still runs and stops it as the chat's Stop does)
 *   and Keep going; a card swiped away (it stays away until its chat's next turn). KeepAliveService.
 */
public class NoteActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action != null && action.startsWith("io.github.leonxlnx.sable.mobile.LIVE_")) {
            live(context, intent, action);
            return;
        }
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

    private static void live(Context context, Intent intent, String action) {
        String sessionId = intent.getStringExtra("sessionId");
        if (sessionId == null || sessionId.isEmpty()) return;
        switch (action) {
            case LiveCards.ACTION_STOP_ASK:
                KeepAliveService.askStop(context, sessionId);
                break;
            case LiveCards.ACTION_STOP_KEEP:
                KeepAliveService.keepGoing(context, sessionId);
                break;
            case LiveCards.ACTION_STOP: {
                // The key asks for the phone to be unlocked; a locked phone that still got here stops nothing.
                KeyguardManager lock = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
                if (lock != null && lock.isKeyguardLocked()) return;
                KeepAliveService.confirmStop(context, sessionId, intent);
                break;
            }
            case LiveCards.ACTION_DISMISSED:
                KeepAliveService.cardDismissed(context, sessionId);
                break;
            default:
                break;
        }
    }
}
