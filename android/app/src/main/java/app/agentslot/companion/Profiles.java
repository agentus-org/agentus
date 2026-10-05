package app.agentslot.companion;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/**
 * The saved servers.
 *
 * One profile = one AgentSlot server the phone can notify from: address, optionally the
 * login (so pairing can happen again without the operator's involvement), the device token
 * this server issued, and this server's own event cursor. Cursors are per server on purpose —
 * replaying server B's events with server A's cursor would silently drop notifications.
 *
 * The whole list is sealed with SecretBox (Keystore AES/GCM) before it is written.
 */
final class Profiles {
    static final class P {
        String id = UUID.randomUUID().toString().substring(0, 8);
        String name = "";
        String url = "";
        String username = "";
        String password = "";
        boolean remember = true;
        String token = null;
        String deviceId = null;
        long cursor = 0L;
        long lastUsedAt = 0L;

        boolean hasLogin() {
            return username != null && !username.isEmpty() && password != null && !password.isEmpty();
        }

        boolean hasToken() {
            return token != null && !token.isEmpty();
        }

        String label() {
            if (name != null && !name.isEmpty()) return name;
            return host();
        }

        String host() {
            String u = url == null ? "" : url.replaceFirst("^https?://", "").replaceAll("/+$", "");
            return u.isEmpty() ? "(未命名服务器)" : u;
        }
    }

    private static final String KEY = "profiles.v1";
    private final SharedPreferences sp;
    private final List<P> list = new ArrayList<>();
    private String activeId = null;
    private boolean encrypted = false;
    private int revision = 0;

    Profiles(Context context) {
        this.sp = context.getApplicationContext().getSharedPreferences("agentslot", Context.MODE_PRIVATE);
        load();
    }

    // ---- reads ---------------------------------------------------------------

    synchronized List<P> all() {
        List<P> out = new ArrayList<>(list);
        out.sort(Comparator.comparingLong((P p) -> p.lastUsedAt).reversed());
        return out;
    }

    synchronized P active() {
        if (activeId == null) return list.isEmpty() ? null : list.get(0);
        for (P p : list) if (p.id.equals(activeId)) return p;
        return list.isEmpty() ? null : list.get(0);
    }

    synchronized P byId(String id) {
        for (P p : list) if (p.id.equals(id)) return p;
        return null;
    }

    synchronized boolean encrypted() {
        return encrypted;
    }

    /** Bumped on every write, so a UI can rebuild its list only when something changed. */
    synchronized int revision() {
        return revision;
    }

    // ---- writes --------------------------------------------------------------

    synchronized P upsert(P p) {
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).id.equals(p.id)) {
                list.set(i, p);
                save();
                return p;
            }
        }
        list.add(p);
        if (activeId == null) activeId = p.id;
        save();
        return p;
    }

    synchronized void remove(String id) {
        list.removeIf(p -> p.id.equals(id));
        if (id.equals(activeId)) activeId = list.isEmpty() ? null : list.get(0).id;
        save();
    }

    synchronized void setActive(String id) {
        activeId = id;
        P p = byId(id);
        if (p != null) p.lastUsedAt = System.currentTimeMillis();
        save();
    }

    synchronized void saveTokens(String id, String deviceId, String token) {
        P p = byId(id);
        if (p == null) return;
        p.deviceId = deviceId;
        p.token = token;
        save();
    }

    synchronized void clearToken(String id) {
        P p = byId(id);
        if (p == null) return;
        p.token = null;
        p.deviceId = null;
        p.cursor = 0L;
        save();
    }

    synchronized void setCursor(String id, long seq) {
        P p = byId(id);
        if (p == null || seq <= p.cursor) return;
        p.cursor = seq;
        save();
    }

    synchronized void touch(String id) {
        P p = byId(id);
        if (p == null) return;
        p.lastUsedAt = System.currentTimeMillis();
        save();
    }

    // ---- disk ----------------------------------------------------------------

    private void load() {
        String raw = sp.getString(KEY, null);
        if (raw == null) return;
        if (raw.startsWith("enc:")) {
            String opened = SecretBox.open(raw);
            if (opened == null) return; // unreadable (restored to another device): start clean
            raw = opened;
            encrypted = true;
        }
        try {
            JSONObject root = new JSONObject(raw);
            activeId = root.optString("active", null);
            JSONArray arr = root.optJSONArray("profiles");
            if (arr == null) return;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                P p = new P();
                p.id = o.optString("id", p.id);
                p.name = o.optString("name", "");
                p.url = o.optString("url", "");
                p.username = o.optString("username", "");
                p.password = o.optString("password", "");
                p.remember = o.optBoolean("remember", true);
                p.token = o.isNull("token") ? null : o.optString("token", null);
                p.deviceId = o.isNull("deviceId") ? null : o.optString("deviceId", null);
                p.cursor = o.optLong("cursor", 0L);
                p.lastUsedAt = o.optLong("lastUsedAt", 0L);
                if (!p.url.isEmpty()) list.add(p);
            }
        } catch (Exception ignored) {
            // a corrupt blob must not brick the app: the operator re-adds the server
        }
    }

    private void save() {
        try {
            JSONObject root = new JSONObject();
            root.put("active", activeId == null ? JSONObject.NULL : activeId);
            JSONArray arr = new JSONArray();
            for (P p : list) {
                JSONObject o = new JSONObject();
                o.put("id", p.id);
                o.put("name", p.name);
                o.put("url", p.url);
                // a password is only written when the operator asked to remember it
                o.put("username", p.username);
                o.put("password", p.remember ? p.password : "");
                o.put("remember", p.remember);
                o.put("token", p.token == null ? JSONObject.NULL : p.token);
                o.put("deviceId", p.deviceId == null ? JSONObject.NULL : p.deviceId);
                o.put("cursor", p.cursor);
                o.put("lastUsedAt", p.lastUsedAt);
                arr.put(o);
            }
            root.put("profiles", arr);
            String json = root.toString();
            String sealed = SecretBox.seal(json);
            encrypted = sealed != null;
            sp.edit().putString(KEY, sealed != null ? sealed : ("raw:" + json)).apply();
            revision++;
        } catch (Exception ignored) {
            // never let a persistence failure take the app down
        }
    }
}