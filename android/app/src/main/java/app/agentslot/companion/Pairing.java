package app.agentslot.companion;

import android.content.Context;
import android.os.Build;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The pairing call, in one place: the service needs it (a token can expire or be revoked) and
 * the activity needs it (adding a server).
 *
 * The app reports exactly what it implements — no `icon_url`, because there is no icon
 * downloader yet. The server degrades what a device cannot do instead of guessing.
 */
final class Pairing {
    static final class Result {
        final String deviceId;
        final String deviceToken;
        final String baseUrl;

        Result(String deviceId, String deviceToken, String baseUrl) {
            this.deviceId = deviceId;
            this.deviceToken = deviceToken;
            this.baseUrl = baseUrl;
        }
    }

    /** Trim a typed address into the base URL the rest of the app uses. */
    static String normalise(String raw) {
        String url = raw == null ? "" : raw.trim();
        if (url.isEmpty()) return "";
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
        return url.replaceAll("/+$", "");
    }

    /** Parse `agentslot://pair?u=<base>&c=<code>`, or "<base> <code>", into {base, code}. */
    static String[] parsePairString(String raw) {
        if (TextUtils.isEmpty(raw)) return null;
        String text = raw.trim();
        if (text.startsWith("agentslot://")) {
            try {
                android.net.Uri uri = android.net.Uri.parse(text);
                return new String[]{normalise(uri.getQueryParameter("u")), uri.getQueryParameter("c")};
            } catch (Exception e) {
                return null;
            }
        }
        if (text.contains(" ")) {
            String[] parts = text.split("\\s+");
            return new String[]{normalise(parts[0]), parts.length > 1 ? parts[1].trim() : null};
        }
        return new String[]{normalise(text), null};
    }

    static JSONArray capabilities(Context ctx) {
        JSONArray caps = new JSONArray();
        caps.put("progress");
        caps.put("actions");
        caps.put("remote_input");
        caps.put("channels");
        caps.put("deeplink");
        // Only claim it when the platform would really promote: SDK 36 alone is not enough (the user
        // can switch Live Updates off, and some vendor builds do not implement it at all).
        if (Build.VERSION.SDK_INT >= 36 && LiveUpdate.available(ctx)) caps.put("live_update");
        // Xiaomi's own island, available well below API 36 — report it as what it is
        if (XiaomiFocus.canShowFocus(ctx)) caps.put("xiaomi_focus");
        return caps;
    }

    /**
     * POST /api/notify/pair. `extra` is either {"code": …} or {"username": …, "password": …}.
     * Throws with the server's message when it refuses, so the UI can show it verbatim.
     */
    static Result pair(Context context, String baseUrl, JSONObject extra) throws Exception {
        JSONObject body = new JSONObject()
            .put("deviceName", Build.MODEL)
            .put("platform", "android")
            .put("sdkInt", Build.VERSION.SDK_INT)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("schema", 1)
            .put("capabilities", capabilities(context));
        if (extra != null) {
            java.util.Iterator<String> keys = extra.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                body.put(k, extra.get(k));
            }
        }
        String response = Http.postJson(context, baseUrl + "/api/notify/pair", null, body.toString());
        JSONObject json = new JSONObject(response);
        String token = json.optString("deviceToken", "");
        if (token.isEmpty()) throw new IllegalStateException("服务器没有返回 deviceToken");
        return new Result(json.optString("deviceId", ""), token,
            json.optString("baseUrl", baseUrl).replaceAll("/+$", ""));
    }
}