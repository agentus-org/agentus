package app.agentslot.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Renders one ActivityObject into a notification. This is the "generic renderer" the
 * contract is built around: it knows how to draw title/progress/actions/input/deeplink and
 * nothing at all about what an agent is doing. New kinds of notification therefore need a
 * new payload, not a new APK.
 */
final class Notifier {
    static final String SERVICE_CHANNEL = "agentslot-service";
    static final String DEFAULT_CHANNEL = "agentslot-default";
    /** One channel for everything the server muted while a call is live (see apply(): an existing
     *  channel's sound cannot be changed, so silence needs a channel of its own). */
    static final String QUIET_CHANNEL = "agentslot-quiet";
    static final int SERVICE_ID = 1;

    /** The tap target, which must be an EXPLICIT intent into this app.
     *
     *  An implicit `ACTION_VIEW` on the cockpit URL is handed to whatever browser claims http(s) —
     *  which is exactly what the operator saw: "消息提醒打开后为什么是浏览器". Two things ride along:
     *  the absolute target URL (the cockpit with `?session=<id>`, so the page opens on the session the
     *  notification is about) and the server it belongs to (the operator may have switched since).
     *  The data URI is only there to keep two targets from being collapsed into one PendingIntent. */
    static Intent openIntent(Context ctx, String url, String serverUrl) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setAction(Intent.ACTION_VIEW);
        i.putExtra(MainActivity.EXTRA_OPEN_URL, url == null ? "" : url);
        i.putExtra(MainActivity.EXTRA_OPEN_SERVER, serverUrl == null ? "" : serverUrl);
        i.setData(Uri.parse("agentslot://open?u=" + Uri.encode(url == null ? "" : url)));
        // singleTop + NEW_TASK: an app already in the foreground gets onNewIntent instead of a second
        // instance (a second instance would mean a second WebView, i.e. a reload of the cockpit).
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return i;
    }

    /** The intent a tap (or an 「打开」 action) fires, per the sender's `open.prefer` and — decisively —
     *  the device's own allow-list. Policy table: docs/android-notify-contract.md §5.2.
     *
     *  `web` always goes to the platform's web handler. Otherwise the URL is opened INSIDE this app only
     *  if its origin is one of the operator's saved servers: a payload must never be able to navigate
     *  the authenticated cockpit somewhere else (a webhook sender would otherwise gain a navigation
     *  primitive inside the operator's session). Anything foreign is handed to the platform, where the
     *  chooser (not this app) decides. */
    static Intent openFor(Context ctx, String url, String serverUrl, String prefer) {
        if (url == null || url.isEmpty()) return null;
        if (!"web".equals(prefer) && ownOrigin(ctx, url, serverUrl)) {
            return openIntent(ctx, url, serverUrl);
        }
        Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return view;
    }

    /** Is this URL one of the operator's own servers? */
    static boolean ownOrigin(Context ctx, String url, String serverUrl) {
        String want = originOf(url);
        if (want == null) return false;
        if (originOf(serverUrl) != null && want.equals(originOf(serverUrl))) return true;
        try {
            for (Profiles.P p : new Profiles(ctx).all()) {
                if (p.url != null && want.equals(originOf(p.url))) return true;
            }
        } catch (Exception ignored) {
            /* an unreadable profile list means "not mine" — the safe answer */
        }
        return false;
    }

    private static String originOf(String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme();
            String host = u.getHost();
            if (scheme == null || host == null) return null;
            int port = u.getPort();
            if (port == -1) port = "https".equalsIgnoreCase(scheme) ? 443 : 80;
            return (scheme + "://" + host + ":" + port).toLowerCase();
        } catch (Exception e) {
            return null;
        }
    }

    static int color(String hex) {
        try {
            return Color.parseColor(hex);
        } catch (Exception e) {
            return Color.GRAY;
        }
    }

    /** The server owns channel ids/names/importance — that is why importance or sound can
     *  change without a new build. */
    static void ensureChannel(Context ctx, String id, String name, String importance, boolean sound, boolean vibration) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(id) != null) return;
        int imp = switch (importance == null ? "default" : importance) {
            case "min" -> NotificationManager.IMPORTANCE_MIN;
            case "low" -> NotificationManager.IMPORTANCE_LOW;
            case "high" -> NotificationManager.IMPORTANCE_HIGH;
            default -> NotificationManager.IMPORTANCE_DEFAULT;
        };
        NotificationChannel ch = new NotificationChannel(id, name == null ? id : name, imp);
        if (!sound) ch.setSound(null, null);
        if (!vibration) {
            ch.enableVibration(false);
            ch.setVibrationPattern(new long[]{0L});
        }
        nm.createNotificationChannel(ch);
    }

    static void ensureServiceChannel(Context ctx) {
        ensureChannel(ctx, SERVICE_CHANNEL, "AgentSlot 服务", "low", false, false);
    }

    /** Stable per activity: one activityId = one notification slot, updated in place. */
    static int idFor(String activityId) {
        int h = Math.abs(activityId.hashCode() % 100000);
        return h < 2 ? h + 2 : h;
    }

    static void apply(Context ctx, String baseUrl, JSONObject a) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        String activityId = a.optString("activityId", "");
        if (activityId.isEmpty()) return;
        String op = a.optString("op", "upsert");
        if ("dismiss".equals(op)) {
            nm.cancel(idFor(activityId));
            return;
        }
        if ("clear_all".equals(op)) {
            nm.cancelAll();
            return;
        }

        JSONObject channel = a.optJSONObject("channel");
        String channelId = channel != null ? channel.optString("id", DEFAULT_CHANNEL) : DEFAULT_CHANNEL;
        boolean muted = channel != null && channel.optBoolean("muted", false);
        if (channel != null) {
            // A channel's sound and importance are IMMUTABLE once it exists (Android 8+), and
            // ensureChannel deliberately returns early for an existing id — so telling an
            // already-loud "任务完成" channel to be quiet silently does nothing. Frames the server
            // muted (a call is live: the tone would be recorded by the agent's own microphone) go to
            // ONE dedicated quiet channel instead: importance low (no heads-up) and no sound.
            String wantId = muted ? QUIET_CHANNEL : channelId;
            String wantName = muted ? "通话中（静音）" : channel.optString("name", channelId);
            ensureChannel(ctx, wantId, wantName,
                muted ? "low" : channel.optString("importance", "default"),
                muted ? false : channel.optBoolean("sound", true),
                muted ? false : channel.optBoolean("vibration", true));
            channelId = wantId;
        } else {
            ensureChannel(ctx, DEFAULT_CHANNEL, "AgentSlot", "default", true, true);
        }

        int revision = Math.max(1, a.optInt("revision", 1));
        boolean ongoing = a.optBoolean("ongoing", false);
        String title = a.optString("title", "AgentSlot");
        String subtitle = a.optString("subtitle", "");
        String body = a.optString("body", "");
        String text = !body.isEmpty() ? body : subtitle;

        Notification.Builder b = new Notification.Builder(ctx, channelId)
            .setSmallIcon(smallIcon(ctx, a.optString("smallIcon", "agentslot")))
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            // an update must not re-alert: only the first revision of an activity is news
            .setOnlyAlertOnce(revision > 1)
            .setShowWhen(false);

        if (!subtitle.isEmpty() && !body.isEmpty()) {
            b.setSubText(subtitle);
        }

        String visibility = a.optString("visibility", "private");
        b.setVisibility("public".equals(visibility) ? Notification.VISIBILITY_PUBLIC
            : "secret".equals(visibility) ? Notification.VISIBILITY_SECRET
            : Notification.VISIBILITY_PRIVATE);

        JSONObject progress = a.optJSONObject("progress");
        if (progress != null && Build.VERSION.SDK_INT < 36) {
            // below API 36 the fancy ProgressStyle does not exist; a plain bar is the honest fallback
            boolean indeterminate = progress.optBoolean("indeterminate", false);
            int pct = (int) Math.round(Math.max(0d, Math.min(1d, progress.optDouble("value", 0d))) * 100d);
            b.setProgress(100, pct, indeterminate || !progress.has("value"));
        }

        boolean promoted = false;
        String focus = null;
        if (ongoing && a.optBoolean("promotable", false)) {
            // Vendor first, on purpose. On Xiaomi the island IS the vendor feature, and it exists on
            // Android 14/15/16 alike; asking AOSP first handed HyperOS a promoted notification it does
            // not render as an island, so the notification looked fine and simply never appeared up
            // top. One path owns the notification, and the log says which.
            //
            // `path` overrides the order, for the one question this ordering cannot answer: does
            // HyperOS 3 render Android 16's OWN Live Update at all? "aosp" skips the vendor call
            // entirely, "xiaomi" skips the AOSP one, anything else keeps the order above.
            String want = a.optString("path", "");
            boolean tryVendor = !"aosp".equals(want);
            boolean tryAosp = !"xiaomi".equals(want);
            if (tryVendor) focus = XiaomiFocus.apply(ctx, b, a);
            if (focus == null && tryAosp && Build.VERSION.SDK_INT >= 36 && LiveUpdate.available(ctx)) {
                promoted = LiveUpdate.apply(b, a);
            }
            if (!want.isEmpty()) {
                NotifyService.log("路径：" + want + " → 小米=" + (focus != null ? "用了" : (tryVendor ? "没用" : "跳过"))
                    + " · 原生实时动态=" + (promoted ? "用了" : (tryAosp ? "没用" : "跳过")));
            }
        }
        if (!promoted && ongoing) {
            // no promotion available: still make it a live-ish ongoing notification
            b.setStyle(new Notification.BigTextStyle().bigText(text));
        }

        // `open` is the contract's abstract tap target (url + how much the sender insists on an app);
        // `deeplink` is what an app built before it understands.
        JSONObject open = a.optJSONObject("open");
        String prefer = open != null ? open.optString("prefer", "auto") : "auto";
        String link = absoluteLink(baseUrl, open != null
            ? open.optString("url", a.optString("deeplink", ""))
            : a.optString("deeplink", ""));
        if (!link.isEmpty()) {
            Intent target = openFor(ctx, link, baseUrl, prefer);
            if (target != null) {
                b.setContentIntent(PendingIntent.getActivity(ctx, idFor(activityId) + 7, target,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            }
        }

        JSONArray actions = a.optJSONArray("actions");
        if (actions != null) {
            for (int i = 0; i < actions.length() && i < 3; i++) {
                JSONObject act = actions.optJSONObject(i);
                if (act == null) continue;
                b.addAction(notificationAction(ctx, a, act, link, prefer, i));
            }
        }

        long expiresAt = a.optLong("expiresAt", 0L);
        if (expiresAt > 0) {
            long after = expiresAt - System.currentTimeMillis();
            if (after > 1000) b.setTimeoutAfter(after);
        }

        nm.notify(idFor(activityId), b.build());
        NotifyService.log("通知 " + activityId
            + (promoted ? "（已请求提升为实时动态）" : focus != null ? "（" + focus + "）" : "")
            + " · " + title);
    }

    private static Notification.Action notificationAction(Context ctx, JSONObject activity,
                                                        JSONObject act, String link, String prefer, int index) {
        String actionId = act.optString("id");
        String label = act.optString("label", actionId);
        boolean isOpen = "open".equals(actionId);
        Intent i = new Intent(ctx, ActionReceiver.class)
            .setAction("app.agentslot.companion.ACTION")
            .putExtra("activityId", activity.optString("activityId"))
            .putExtra("actionId", actionId)
            .putExtra("revision", activity.optInt("revision", 1))
            .putExtra("url", link)
            .putExtra("prefer", prefer)
            .putExtra("open", isOpen);
        int request = idFor(activity.optString("activityId")) * 31 + index;
        PendingIntent pi = PendingIntent.getBroadcast(ctx, request, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Action.Builder ab = new Notification.Action.Builder(
            Icon.createWithResource(ctx, R.drawable.ic_notify), label, pi);

        JSONObject input = activity.optJSONObject("input");
        if (input != null && input.optBoolean("enabled", false) && index == 0) {
            // inline reply rides the first action, the way every messaging app does it
            RemoteInput ri = new RemoteInput.Builder("reply")
                .setLabel(input.optString("placeholder", "回复"))
                .build();
            Intent reply = new Intent(ctx, ActionReceiver.class)
                .setAction("app.agentslot.companion.REPLY")
                .putExtra("activityId", activity.optString("activityId"))
                .putExtra("actionId", actionId)
                .putExtra("revision", activity.optInt("revision", 1))
                .putExtra("url", link);
            // No addResultsToIntent here: the platform attaches the typed text to this
            // pending intent itself, and ActionReceiver reads it with getResultsFromIntent.
            PendingIntent rpi = PendingIntent.getBroadcast(ctx, request + 1000, reply,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            return new Notification.Action.Builder(Icon.createWithResource(ctx, R.drawable.ic_notify), label, rpi)
                .addRemoteInput(ri)
                .build();
        }
        return ab.build();
    }

    private static int smallIcon(Context ctx, String name) {
        if (name != null && !name.isEmpty() && !"agentslot".equals(name)) {
            int id = ctx.getResources().getIdentifier(name, "drawable", ctx.getPackageName());
            if (id != 0) return id;
        }
        return R.drawable.ic_notify;
    }

    /** The deeplink is a server-relative path; the phone needs the whole URL. */
    static String absoluteLink(String baseUrl, String deeplink) {
        if (deeplink == null || deeplink.isEmpty()) return "";
        if (deeplink.startsWith("http://") || deeplink.startsWith("https://")) return deeplink;
        if (baseUrl == null || baseUrl.isEmpty()) return "";
        return baseUrl.replaceAll("/+$", "") + (deeplink.startsWith("/") ? "" : "/") + deeplink;
    }

    static Notification serviceNotification(Context ctx, String status) {
        Intent open = new Intent(ctx, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(ctx, 99, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(ctx, SERVICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("AgentSlot")
            .setContentText(status)
            .setContentIntent(pi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .build();
    }
}