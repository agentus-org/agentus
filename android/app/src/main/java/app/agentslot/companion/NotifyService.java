package app.agentslot.companion;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.Deque;
import java.util.List;
import java.util.Locale;

import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Holds ONE websocket to the ACTIVE saved server and turns what arrives into notifications.
 *
 * Switching servers is a stop-then-start of this service: one live connection is the honest
 * model (two servers can mint the same activity ids, and a phone does not need two islands).
 * A rejected device token self-heals once — re-pair with the saved login, then reconnect.
 *
 * Why a foreground service: the server has to be able to reach the phone, and a phone behind
 * NAT is only reachable over a connection the phone opened itself and keeps open. The manifest
 * declares `specialUse` (NOT `dataSync`, which Android 15 caps at 6h/24h).
 *
 * Nothing here interprets agent semantics: frames are contract objects handed to Notifier.
 */
public final class NotifyService extends Service {
    private static final String TAG = "AgentSlotNotify";
    public static final String ACTION_START = "app.agentslot.companion.START";
    public static final String ACTION_STOP = "app.agentslot.companion.STOP";

    /** Read by MainActivity (a polled status beats a broadcast for a one-screen app). */
    static volatile String status = "未启动";
    static volatile boolean connected = false;
    static volatile String connectedTo = null;

    private static final Deque<String> LOG = new ArrayDeque<>();
    private static final SimpleDateFormat STAMP = new SimpleDateFormat("HH:mm:ss", Locale.US);

    /** Every state change goes through here: the log IS the remote operator's debugger. */
    static synchronized void log(String line) {
        status = line;
        LOG.addFirst(STAMP.format(new Date()) + "  " + line);
        while (LOG.size() > 60) LOG.removeLast();
        Log.i(TAG, line);
    }

    static synchronized List<String> logLines() {
        return new ArrayList<>(LOG);
    }

    static synchronized void clearLog() {
        LOG.clear();
    }

    private static final long[] BACKOFF_MS = {2000, 4000, 8000, 15000, 30000, 60000};

    private Profiles profiles;
    private Handler handler;
    private WebSocket socket;
    private int attempt = 0;
    private boolean wantConnection = true;
    /** One self-heal per outage: a wrong password must not turn into a retry loop. */
    private boolean healed = false;
    private ConnectivityManager.NetworkCallback networkCallback;

    static boolean start(Context ctx) {
        try {
            Intent i = new Intent(ctx, NotifyService.class).setAction(ACTION_START);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
            return true;
        } catch (Exception e) {
            // Android 12+ refuses a background FGS start in some situations (boot, for one).
            // A refusal must be visible to the caller, never a crash.
            log("启动服务被系统拒绝：" + e.getMessage());
            return false;
        }
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, NotifyService.class));
    }

    /** Switch servers: drop the old socket, then connect the newly active one. */
    static void restart(Context ctx) {
        stop(ctx);
        start(ctx);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        profiles = new Profiles(this);
        handler = new Handler(Looper.getMainLooper());
        Notifier.ensureServiceChannel(this);
        startForeground(Notifier.SERVICE_ID, Notifier.serviceNotification(this, "正在连接…"));
        watchNetwork();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            wantConnection = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        wantConnection = true;
        healed = false;
        Profiles.P p = profiles.active();
        if (p == null) {
            connectedTo = null;
            log("还没有服务器：先在 App 里添加一个");
            updateServiceNotification();
            return START_STICKY;
        }
        profiles.setActive(p.id);
        if (socket == null) connect();
        return START_STICKY;
    }

    // ---- connection ---------------------------------------------------------

    private void connect() {
        if (!wantConnection) return;
        final Profiles.P p = profiles.active();
        if (p == null) return;
        connectedTo = p.label();
        if (!p.hasToken()) {
            // no token yet: pair with the saved login, then come back here
            log(p.label() + "：还没有设备令牌，用保存的账号密码配对…");
            updateServiceNotification();
            new Thread(() -> {
                try {
                    pairNow(p);
                } catch (Exception e) {
                    log("配对失败：" + e.getMessage());
                }
                handler.post(this::connect);
            }, "agentslot-pair").start();
            return;
        }
        final String ws = p.url.replaceFirst("^http", "ws").replaceAll("/+$", "")
            + "/api/notify/ws?token=" + p.token + "&since=" + p.cursor
            // The build reports itself on every connect, so the server can tell which APK is
            // actually on the phone (the version recorded at pairing goes stale after a sideload).
            + "&v=" + BuildConfig.VERSION_NAME;
        log("连接 " + p.url + " …");
        updateServiceNotification();
        socket = Http.openSocket(this, ws, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                attempt = 0;
                connected = true;
                healed = false;
                log("已连接（" + p.label() + "）");
                updateServiceNotification();
            }

            @Override public void onMessage(WebSocket webSocket, String text) {
                handleFrame(text, webSocket);
            }

            @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                connected = false;
                socket = null;
                int code = response != null ? response.code() : 0;
                if (code == 401 && !healed) {
                    // the server forgot this device (revoked here, or its state was reset)
                    healed = true;
                    log("令牌被服务端拒绝，用保存的账号密码重新配对…");
                    profiles.clearToken(p.id);
                    updateServiceNotification();
                    handler.postDelayed(NotifyService.this::connect, 500);
                    return;
                }
                log("断开：" + (t != null ? t.getMessage() : "unknown") + (code != 0 ? "（HTTP " + code + "）" : ""));
                updateServiceNotification();
                scheduleReconnect();
            }

            @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                connected = false;
                socket = null;
                log("服务端关闭连接：" + code + " " + reason);
                updateServiceNotification();
                scheduleReconnect();
            }
        });
    }

    private void pairNow(Profiles.P p) throws Exception {
        if (!p.hasLogin()) throw new IllegalStateException("这个服务器没有令牌，也没有保存的账号密码（编辑它补上）");
        JSONObject extra = new JSONObject().put("username", p.username).put("password", p.password);
        Pairing.Result r = Pairing.pair(this, p.url, extra);
        profiles.saveTokens(p.id, r.deviceId, r.deviceToken);
        log("配对成功：" + r.deviceId + "（" + p.label() + "）");
    }

    private void handleFrame(String text, WebSocket ws) {
        try {
            JSONObject frame = new JSONObject(text);
            String t = frame.optString("t");
            Profiles.P p = profiles.active();
            if ("hello".equals(t)) {
                long cursor = frame.optLong("cursor", 0);
                log("握手完成，游标 " + cursor);
                sendAck(ws, cursor);
                return;
            }
            if ("activity".equals(t)) {
                long seq = frame.optLong("seq", 0);
                JSONObject activity = frame.optJSONObject("activity");
                if (activity == null) return;
                if (seq > 0 && p != null && seq <= p.cursor) return; // already applied before a reconnect
                Notifier.apply(this, p != null ? p.url : null, activity);
                if (seq > 0 && p != null) {
                    profiles.setCursor(p.id, seq);
                    sendAck(ws, seq);
                }
                return;
            }
            if ("bye".equals(t)) {
                log("服务端： " + frame.optString("reason", ""));
            }
        } catch (Exception e) {
            log("无法解析帧：" + e.getMessage());
        }
    }

    /** The cursor is how the server knows what not to resend. Best effort, never fatal. */
    private void sendAck(WebSocket ws, long seq) {
        try {
            ws.send(new JSONObject().put("t", "ack").put("cursor", seq).toString());
        } catch (Exception ignored) {
            // a lost ack only costs a duplicate replay
        }
    }

    private void scheduleReconnect() {
        if (!wantConnection) return;
        long delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt++;
        log("将在 " + (delay / 1000) + "s 后重连（第 " + attempt + " 次）");
        handler.postDelayed(this::connect, delay);
    }

    /** A wifi/mobile handover kills the socket; the phone knows before OkHttp does. */
    private void watchNetwork() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network network) {
                    if (!wantConnection || connected) return;
                    handler.postDelayed(NotifyService.this::connect, 1500);
                }
            };
            cm.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception e) {
            log("网络监听未注册：" + e.getMessage());
        }
    }

    private void updateServiceNotification() {
        try {
            startForeground(Notifier.SERVICE_ID, Notifier.serviceNotification(this,
                (connected ? "已连接 · " : "重连中 · ")
                    + (connectedTo != null ? connectedTo + " · " : "") + status));
        } catch (Exception ignored) {
            // never let cosmetics kill the connection
        }
    }

    @Override
    public void onDestroy() {
        wantConnection = false;
        connected = false;
        log("服务已停止");
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (socket != null) socket.close(1000, "service stopped");
        socket = null;
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && networkCallback != null) cm.unregisterNetworkCallback(networkCallback);
        } catch (Exception ignored) { }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}