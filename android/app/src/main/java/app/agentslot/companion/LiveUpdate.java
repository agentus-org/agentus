package app.agentslot.companion;

import android.app.Notification;
import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The API-36 half of the renderer: Notification.ProgressStyle + setRequestPromotedOngoing,
 * which is what turns an ongoing notification into a Live Update (the status-bar chip the
 * user calls "the island").
 *
 * It lives in its own class on purpose: a device on API < 36 must never load a class whose
 * bytecode references API-36 types, or ART fails verification. Notifier only touches this
 * class behind a version check.
 */
final class LiveUpdate {

    /** True when the platform could promote us AND the user has not switched it off. */
    static boolean available(Context context) {
        try {
            android.app.NotificationManager nm =
                (android.app.NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            return nm != null && nm.canPostPromotedNotifications();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * Style the notification as a progress-centric one and ask to be promoted.
     * Returns false when anything is unavailable — the caller then keeps its plain shape.
     */
    static boolean apply(Notification.Builder builder, JSONObject activity) {
        try {
            JSONObject progress = activity.optJSONObject("progress");
            Notification.ProgressStyle style = new Notification.ProgressStyle();
            style.setStyledByProgress(false);
            if (progress != null) {
                boolean indeterminate = progress.optBoolean("indeterminate", false);
                if (!indeterminate && progress.has("value")) {
                    double v = progress.optDouble("value", 0d);
                    style.setProgress((int) Math.round(Math.max(0d, Math.min(1d, v)) * 100d));
                }
                JSONArray segments = progress.optJSONArray("segments");
                if (segments != null && segments.length() > 0) {
                    java.util.List<Notification.ProgressStyle.Segment> list = new java.util.ArrayList<>();
                    for (int i = 0; i < segments.length(); i++) {
                        JSONObject seg = segments.optJSONObject(i);
                        if (seg == null) continue;
                        Notification.ProgressStyle.Segment s =
                            new Notification.ProgressStyle.Segment(Math.max(1, seg.optInt("length", 1)));
                        s.setColor(Notifier.color(seg.optString("color", "#888888")));
                        list.add(s);
                    }
                    style.setProgressSegments(list);
                }
                JSONArray points = progress.optJSONArray("points");
                if (points != null && points.length() > 0) {
                    java.util.List<Notification.ProgressStyle.Point> list = new java.util.ArrayList<>();
                    for (int i = 0; i < points.length(); i++) {
                        JSONObject p = points.optJSONObject(i);
                        if (p == null) continue;
                        Notification.ProgressStyle.Point pt =
                            new Notification.ProgressStyle.Point(Math.max(1, p.optInt("position", 1)));
                        pt.setColor(Notifier.color(p.optString("color", "#888888")));
                        list.add(pt);
                    }
                    style.setProgressPoints(list);
                }
            }
            builder.setStyle(style);
            builder.setRequestPromotedOngoing(true);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}