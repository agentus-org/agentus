package app.agentus.companion;

import android.app.NotificationManager;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import org.json.JSONObject;

/**
 * The "one row of handler" the contract promises: a notification button becomes a POST
 * against /api/notify/actions, and what that means to an agent is the server's business.
 * Runs from the lock screen without opening the app; the work rides goAsync() so the
 * receiver is not killed while the request is in flight.
 */
public final class ActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        final Profiles profiles = new Profiles(context);
        final Profiles.P profile = profiles.active();
        final String activityId = intent.getStringExtra("activityId");
        final String actionId = intent.getStringExtra("actionId");
        final int revision = intent.getIntExtra("revision", 1);
        final String url = intent.getStringExtra("url");
        final boolean open = intent.getBooleanExtra("open", false);

        CharSequence reply = null;
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        if (results != null) reply = results.getCharSequence("reply");

        if (open || "open".equals(actionId)) {
            if (url != null && !url.isEmpty()) {
                // Same policy as a tap on the body (Notifier.openFor): an implicit http(s) VIEW goes to
                // the browser, and only one of the operator's own servers may open inside this app.
                Intent target = Notifier.openFor(context, url, profile == null ? null : profile.url,
                    intent.getStringExtra("prefer"));
                if (target != null) context.startActivity(target);
            }
            return;
        }
        if (activityId == null || actionId == null || profile == null || !profile.hasToken()) return;

        // A reply replaces the notification with the usual "sent" state.
        if (reply != null) {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(Notifier.idFor(activityId));
        }

        final String body;
        try {
            body = new JSONObject()
                .put("activityId", activityId)
                .put("revision", revision)
                .put("actionId", actionId)
                .put("input", reply != null ? reply.toString() : JSONObject.NULL)
                .put("ts", System.currentTimeMillis())
                .toString();
        } catch (Exception e) {
            return;
        }

        final String endpoint = profile.url.replaceAll("/+$", "") + "/api/notify/actions";
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                Http.postJson(context, endpoint, profile.token, body);
                NotifyService.log("已回传按钮：" + actionId);
            } catch (Exception e) {
                NotifyService.log("按钮回传失败：" + e.getMessage());
            } finally {
                pending.finish();
            }
        }, "agentus-action").start();
    }
}