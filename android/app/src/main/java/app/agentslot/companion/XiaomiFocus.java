package app.agentslot.companion;

import android.app.Notification;
import android.content.Context;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;

import org.json.JSONObject;

/**
 * Xiaomi HyperOS 的「焦点通知 / 超级岛」——小米对 Android 16 Live Updates 的自有等价物。
 *
 * Why this exists at all: the phone in the operator's pocket (Xiaomi MIX Fold 4) ships Android 14
 * / HyperOS, where {@code POST_PROMOTED_NOTIFICATIONS} and {@code ProgressStyle} do not exist, so
 * the AOSP promoted path is dead code there. HyperOS has its own island API instead: you write a
 * JSON blob into {@code notification.extras["miui.focus.param"]} and the OS renders the 状态栏小岛 /
 * 大岛 / 息屏卡片. Same contract idea as LiveUpdate.java — one isolated class, so the API level
 * checks live in exactly one place.
 *
 * HyperOS gates it behind a per-app 焦点通知 permission, so we never touch a notification unless
 * {@link #canShowFocus} says yes: a wrong guess would otherwise risk the notification itself.
 */
final class XiaomiFocus {
    private static final String KEY_PARAM = "miui.focus.param";
    private static final String KEY_PICS = "miui.focus.pics";
    private static final String PIC = "miui.focus.pic_agentslot";

    private static Boolean cachedCanShow = null;
    private static Boolean cachedIsXiaomi = null;

    private XiaomiFocus() { }

    /** HyperOS / MIUI detection that does not need a manifest permission. */
    static boolean isXiaomi() {
        if (cachedIsXiaomi != null) return cachedIsXiaomi;
        boolean yes = false;
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
        if (maker.contains("xiaomi") || maker.contains("redmi") || maker.contains("poco")) {
            yes = true;
        } else {
            try {
                Class<?> sp = Class.forName("android.os.SystemProperties");
                Object v = sp.getMethod("get", String.class, String.class)
                    .invoke(null, "ro.miui.ui.version.name", "");
                yes = !TextUtils.isEmpty((String) v);
            } catch (Throwable ignored) { }
        }
        cachedIsXiaomi = yes;
        return yes;
    }

    /**
     * Ask HyperOS whether this app may show a focus notification at all:
     * {@code content://miui.statusbar.notification.public} / {@code canShowFocus}.
     * False on every non-Xiaomi device, and on HyperOS until the user (or the whitelist) allows it.
     */
    static boolean canShowFocus(Context ctx) {
        if (cachedCanShow != null) return cachedCanShow;
        boolean ok = false;
        if (isXiaomi()) {
            try {
                Bundle extras = new Bundle();
                extras.putString("package", ctx.getPackageName());
                Bundle out = ctx.getContentResolver().call(
                    Uri.parse("content://miui.statusbar.notification.public"), "canShowFocus", null, extras);
                ok = out != null && out.getBoolean("canShowFocus", false);
            } catch (Throwable ignored) { ok = false; }
        }
        cachedCanShow = ok;
        return ok;
    }

    /** The permission can be toggled while we run — the UI asks again on demand. */
    static void forgetPermission() { cachedCanShow = null; }

    /**
     * Which focus-notification generation this ROM speaks:
     * {@code 0} unknown / none, {@code 1} OS1, {@code 2} OS2 (焦点通知), {@code 3} OS3 (超级岛).
     *
     * Read from Settings.System["notification_focus_protocol"] — the same place the community SDK for
     * this API reads it. It matters because the payload is not the same shape across generations: the
     * island node ({@code param_island}) only exists from OS3 on, and sending it to OS2 means SystemUI
     * parses a template it does not have.
     */
    static int protocolVersion(Context ctx) {
        try {
            return android.provider.Settings.System.getInt(ctx.getContentResolver(),
                "notification_focus_protocol", 0);
        } catch (Throwable t) {
            return 0;
        }
    }

    /** HyperOS' own switch for the island UI (persist.sys.feature.island) — false on phones without it. */
    static boolean islandSupported() {
        return "true".equals(prop("persist.sys.feature.island", "false"))
            || "1".equals(prop("persist.sys.feature.island", "0"));
    }

    /** True when this device can render 小米超级岛 (OS3 + the island feature). */
    static boolean islandAvailable(Context ctx) {
        return canShowFocus(ctx) && islandPayloadSupported(ctx);
    }

    /** The payload-shape decision on its own: OS3 (or an island-capable ROM) takes the island template. */
    static boolean islandPayloadSupported(Context ctx) {
        return protocolVersion(ctx) >= 3 || islandSupported();
    }

    /** 澎湃/MIUI 版本名（ro.miui.ui.version.name），给日志和面板用；拿不到就返回 —。 */
    static String miuiVersion() {
        return prop("ro.miui.ui.version.name", "—");
    }

    /**
     * Attach the island parameters to an ongoing notification. Returns a human log line, or null
     * when we left the notification alone (not Xiaomi, or the permission is off).
     *
     * The payload is built per the ROM's focus-protocol generation, because OS2 and OS3 do NOT take the
     * same template:
     *
     *   OS2 (protocol 2)  focus notification: ticker / aodTitle / baseInfo / hintInfo
     *   OS3 (protocol 3)  super island: the same common fields PLUS param_island
     *                     (islandProperty + smallIslandArea + bigIslandArea{imageTextInfoLeft,
     *                     imageTextInfoRight{textInfo}}), which is what the island is drawn from.
     *
     * Both generations keep the whole thing under the {@code param_v2} root — that is Xiaomi's naming,
     * not ours (their OS3 island template still serialises under param_v2), and the pictures ride along
     * in the {@code miui.focus.pics} bundle under the keys the components reference.
     */
    static String apply(Context ctx, Notification.Builder b, JSONObject a) {
        if (!canShowFocus(ctx)) return null;
        try {
            boolean os3 = islandPayloadSupported(ctx);
            Bundle pics = new Bundle();
            pics.putParcelable(PIC, Icon.createWithResource(ctx, R.drawable.ic_notify));
            Bundle extras = new Bundle();
            extras.putString(KEY_PARAM, payload(a, os3).toString());
            extras.putBundle(KEY_PICS, pics);
            b.addExtras(extras);
            return os3 ? "小米超级岛参数已附加（协议 " + protocolVersion(ctx) + "）"
                       : "小米焦点通知参数已附加（协议 " + protocolVersion(ctx) + "，无岛）";
        } catch (Throwable t) {
            return "小米焦点通知参数构造失败：" + t.getMessage();
        }
    }

    /**
     * What would be sent right now, as one line for the log — built even when the permission is off, so
     * "上岛没反应" can be answered by reading the exact JSON the OS was handed instead of guessing.
     * (Verifying the payload is not the same as verifying the island appears; this is the half that can
     * be checked anywhere, including on an emulator with {@code settings put system
     * notification_focus_protocol 3}.)
     */
    static String preview(Context ctx, JSONObject a) {
        try {
            return "会发出的焦点通知参数（岛模板=" + islandPayloadSupported(ctx) + "）: " + payload(a, islandPayloadSupported(ctx));
        } catch (Throwable t) {
            return "岛参数构造失败：" + t.getMessage();
        }
    }

    /** The param_v2 object, in the shape the ROM's protocol generation expects. */
    private static JSONObject payload(JSONObject a, boolean os3) throws Exception {
        String title = clip(a.optString("title", "AgentSlot"), 20);
        String subtitle = a.optString("subtitle", "");
        String body = a.optString("body", subtitle);
        String ticker = clip(subtitle.isEmpty() ? title : subtitle, 40);
        String content = clip(body.isEmpty() ? title : body, 60);

        JSONObject v2 = new JSONObject()
            .put("business", "agentslot")
            .put("enableFloat", false)     // an update must not yank the island open
            .put("updatable", true)        // same notification id keeps updating in place
            .put("ticker", ticker)         // status-bar line
            .put("aodTitle", title)        // 息屏 line
            .put("baseInfo", new JSONObject()
                .put("type", 1)
                .put("title", title)
                .put("content", content));

        if (os3) {
            JSONObject picInfo = new JSONObject().put("type", 1).put("pic", PIC);
            JSONObject textInfo = new JSONObject().put("title", title).put("content", content);
            JSONObject island = new JSONObject()
                .put("islandProperty", 1)          // 1 = information-first (2 would be action-first)
                .put("islandTimeout", 3600)        // seconds; the notification still cancels first
                // 小岛 (collapsed / cover screen): the icon alone, there is no room for text
                .put("smallIslandArea", new JSONObject().put("picInfo", picInfo))
                // 大岛: icon cell on the left, the running task on the right
                .put("bigIslandArea", new JSONObject()
                    .put("imageTextInfoLeft", new JSONObject()
                        .put("type", 1)
                        .put("picInfo", picInfo))
                    .put("imageTextInfoRight", new JSONObject()
                        .put("type", 2)
                        .put("textInfo", textInfo)));
            v2.put("islandFirstFloat", true).put("param_island", island);
        } else {
            // OS2 has no island node at all — a second text line is what it does take.
            v2.put("hintInfo", new JSONObject()
                .put("type", 1)
                .put("title", clip(subtitle, 20))
                .put("content", content));
        }
        return new JSONObject().put("param_v2", v2);
    }

    private static String clip(String s, int max) {
        if (s == null) return "";
        String flat = s.replace('\n', ' ').trim();
        return flat.length() <= max ? flat : flat.substring(0, max - 1) + "…";
    }

    /**
     * Everything needed to answer "can this phone show the island at all, and why not" — printed
     * into the app's own log so the answer comes from the device instead of from a support page.
     *
     * Why the explicit blame matters: 焦点通知/超级岛 is NOT a permission an app can request. Xiaomi
     * grants it per app on review (apply by mail: 应用名称/包名/appid + 场景说明 + channel), and until
     * then {@code canShowFocus} answers false and the island simply never appears — while the ordinary
     * notification keeps working (param_v2.filterWhenNoPermission defaults to false, i.e. no filtering).
     * So a build that "tried and showed nothing" is expected, not broken; say which case this is.
     */
    static String describe(Context ctx) {
        StringBuilder sb = new StringBuilder();
        sb.append("设备: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n');
        sb.append("系统: Android ").append(Build.VERSION.RELEASE).append("（API ").append(Build.VERSION.SDK_INT).append("）\n");
        sb.append("小米系统版本: ").append(prop("ro.miui.ui.version.name", "—"))
          .append("（code ").append(prop("ro.miui.ui.version.code", "—")).append("）\n");
        sb.append("isXiaomi: ").append(isXiaomi() ? "是" : "否").append('\n');
        sb.append("canShowFocus（焦点通知开关）: ").append(canShowFocus(ctx) ? "开" : "关")
          .append(canShowFocus(ctx) ? "" : " —— 需小米侧开通（邮件申请 + 场景审核），否则只会是普通通知").append('\n');
        sb.append("焦点通知协议版本: ").append(protocolVersion(ctx))
          .append("（0 无 / 1 OS1 / 2 OS2 焦点通知 / 3 OS3 超级岛）\n");
        sb.append("超级岛特性: ").append(islandSupported() ? "有" : "无")
          .append("（persist.sys.feature.island）\n");
        sb.append("这条要不要按岛模板发: ")
          .append(islandAvailable(ctx) ? "是（OS3 岛模板）" : canShowFocus(ctx) ? "否（按 OS2 焦点通知发）" : "否（没权限）").append('\n');
        sb.append(probeSystemUi(ctx));
        sb.append("实时动态（Android 16 原生提升）: ").append(LiveUpdate.available(ctx) ? "可用" : "不可用");
        return sb.toString();
    }

    /** ro.* reads: SystemProperties is hidden API, so reflection with a soft failure. */
    private static String prop(String key, String fallback) {
        try {
            Class<?> sp = Class.forName("android.os.SystemProperties");
            Object v = sp.getMethod("get", String.class, String.class).invoke(null, key, fallback);
            return v == null ? fallback : (String) v;
        } catch (Throwable t) {
            return fallback;
        }
    }

    /**
     * The SystemUI-side surface, probed instead of guessed. Xiaomi documents one method
     * ({@code canShowFocus}); the island support/version queries live behind the same provider but the
     * names are not all published, so we try the plausible ones and print whatever comes back,
     * including every key of the returned bundle — an unknown method just throws, which is harmless.
     */
    private static String probeSystemUi(Context ctx) {
        if (!isXiaomi()) return "";
        String[] methods = {"canShowFocus", "isSupportIsland", "supportIsland", "getIslandVersion",
            "isSupportFocus", "getFocusVersion", "getVersion", "hasFocusPermission"};
        StringBuilder sb = new StringBuilder("SystemUI 探测（miui.statusbar.notification.public）:\n");
        Bundle extras = new Bundle();
        extras.putString("package", ctx.getPackageName());
        for (String m : methods) {
            try {
                Bundle out = ctx.getContentResolver().call(
                    Uri.parse("content://miui.statusbar.notification.public"), m, null, extras);
                if (out == null) {
                    sb.append("  ").append(m).append(": (null)\n");
                    continue;
                }
                out.setClassLoader(XiaomiFocus.class.getClassLoader());
                StringBuilder kv = new StringBuilder();
                for (String key : out.keySet()) {
                    kv.append(key).append('=').append(String.valueOf(out.get(key))).append(' ');
                }
                sb.append("  ").append(m).append(": ").append(kv.length() == 0 ? "(空)" : kv.toString().trim()).append('\n');
            } catch (Throwable t) {
                sb.append("  ").append(m).append(": 不支持（").append(t.getClass().getSimpleName()).append("）\n");
            }
        }
        return sb.toString();
    }
}