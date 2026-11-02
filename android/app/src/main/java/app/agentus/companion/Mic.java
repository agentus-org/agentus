package app.agentus.companion;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.function.BooleanSupplier;

/**
 * The microphone the PAGE cannot open.
 *
 * Why this exists: on some vendor WebViews (seen on HyperOS 3 / Android 16) Chromium's own capture
 * refuses to start — {@code NotReadableError: Could not start audio source} — even with RECORD_AUDIO
 * granted, a secure origin, a granted page request and 18 successful onPermissionRequest grants,
 * while this app's plain {@code AudioRecord} records fine on the very same device. Chasing Chromium's
 * pipeline through constraint variants is guesswork with a build in the loop; recording natively and
 * handing the PCM to the page is not.
 *
 * The page keeps doing everything else it did — it still opens {@code /ws/asr} itself, still measures
 * the level for the orb, still gates the relay while the call is speaking. Only the SOURCE changes:
 * 16 kHz mono s16le frames arrive at {@code window.__asMic(base64)} instead of from getUserMedia.
 *
 * The bridge is gated: only a page that is one of the operator's saved servers may open the mic, so a
 * link that ends up in this WebView cannot silently record.
 */
@SuppressLint("JavascriptInterface")
final class Mic {
    /** 1024 samples = 64 ms at 16 kHz: small enough for live partials, large enough not to flood the bridge. */
    private static final int FRAME = 1024;
    /** Permission request code for the case where the page went straight to the bridge and never asked. */
    private static final int REQ_MIC = 3;

    private final Activity activity;
    private final WebView web;
    private final BooleanSupplier allowed;
    /** The MAIN looper, not the WebView's: `View.post()` on a DETACHED view parks the runnable in the
     *  view's run queue until it is attached again — the app shows the config screen by detaching the
     *  WebView, so every frame of a self-test taken from that screen sat in the queue and the page saw
     *  "送出帧=60 · 收到帧=0". The main handler runs either way. */
    private final Handler ui = new Handler(Looper.getMainLooper());

    private AudioRecord rec;
    private Thread pump;
    private volatile boolean running = false;
    /** The headset input we routed to (null = the device's own microphone). */
    private AudioDeviceInfo routed;
    /** The communication device we selected, and the mode we found on the way in, so `release()`
     *  can put the phone back exactly as it was. Leaving MODE_IN_COMMUNICATION behind makes every
     *  other app's audio sound like a phone call. */
    private AudioDeviceInfo commDevice;
    private int prevMode = AudioManager.MODE_INVALID;
    private boolean scoLegacy = false;
    /** Set once we have asked for BLUETOOTH_CONNECT: a refused permission must not become a dialog
     *  on every single tap. Routing still works without it, just to the built-in microphone. */
    private boolean askedBt = false;
    /** Non-null while `start()` is waiting on a permission dialog, so the answer can wake it. */
    private java.util.concurrent.CountDownLatch permGate;
    /** Frames handed to the page. If the page reports 0 received while this is > 0, the bridge is
     *  broken; if this is 0, the recorder never filled. Two numbers, two different causes. */
    private volatile int sent = 0;

    Mic(Activity activity, WebView web, BooleanSupplier allowed) {
        this.activity = activity;
        this.web = web;
        this.allowed = allowed;
    }

    /** The page asks this first: is there a native microphone behind the bridge? */
    @JavascriptInterface
    public boolean available() {
        return true;
    }

    /**
     * Start capturing. Returns "ok" / "already" / "permission" (a system dialog is up — ask again in
     * a moment) / "denied" (this page is not a saved server) / "error: …" (the device refused).
     */
    @JavascriptInterface
    public String start(int rate) {
        // The bridge boundary is a bad place to throw: a RuntimeException becomes the page's
        // "Java exception was raised during method invocation" and the operator learns nothing.
        try {
            return startInner(rate);
        } catch (Throwable t) {
            release();
            String msg = t.getClass().getSimpleName() + " :: " + t.getMessage();
            NotifyService.log("原生麦克风：起不来 " + msg);
            return "error: " + msg;
        }
    }

    private String startInner(int rate) {
        if (running) return "already";
        if (!allowed.getAsBoolean()) {
            NotifyService.log("原生麦克风：这个页面不是已保存的服务器，拒绝");
            return "denied";
        }
        if (activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            // The page never asked (it went straight to the bridge), so the app has to: the dialog is
            // the app's own runtime permission and only the activity can raise it.
            if (!askPermissions(true)) return "denied";
        } else if (!askPermissions(false)) {
            // BLUETOOTH_CONNECT is what makes the HFP link possible on Android 12+; without it the
            // recorder silently stays on the built-in microphone. Not fatal: record anyway.
            NotifyService.log("原生麦克风：蓝牙权限没给，只能走手机自带麦克风");
        }
        final int hz = rate > 0 ? rate : 16000;
        int min = AudioRecord.getMinBufferSize(hz, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) {
            NotifyService.log("原生麦克风：getMinBufferSize=" + min);
            return "error: getMinBufferSize=" + min;
        }
        // Which microphone, not just which sample rate. Plain AudioRecord binds the BUILT-IN mic:
        // the operator's earbuds were connected and the page still recorded the phone itself,
        // because nothing here ever named an input device.
        //
        // Bluetooth is the hard case and the order matters. Its microphone lives on the HFP/SCO
        // link, which is only raised in communication mode, and while that link is down the headset
        // is listed in getDevices() as an A2DP OUTPUT only — a "sink", never an input. So "pick a
        // headset input, then open the link" can never find a Bluetooth mic: the input appears only
        // AFTER the link is up. Raise the link first, then look for the input, then hand it to
        // AudioRecord. That is the whole bug behind "戴耳机还是手机麦".
        final AudioManager am = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
        final String inputs = listInputs(am);
        AudioDeviceInfo scoDev = pickBluetoothInput(am);
        AudioDeviceInfo wiredDev = pickWiredInput(am);
        final boolean btThere = scoDev != null || anyBluetooth(am);
        int source = MediaRecorder.AudioSource.VOICE_RECOGNITION;
        AudioDeviceInfo chosen = null;
        String link = "无";
        if (btThere) {
            if (prevMode == AudioManager.MODE_INVALID) prevMode = am.getMode();
            try {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            } catch (Throwable t) {
                NotifyService.log("原生麦克风：进通信模式失败 " + t.getMessage());
            }
            boolean viaComm = false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && scoDev != null) {
                try {
                    viaComm = am.setCommunicationDevice(scoDev);
                } catch (Throwable t) {
                    NotifyService.log("原生麦克风：setCommunicationDevice 抛错 " + t.getMessage());
                }
                if (viaComm) {
                    commDevice = scoDev;
                    link = "communicationDevice";
                } else {
                    NotifyService.log("原生麦克风：setCommunicationDevice 拒绝，改走 startBluetoothSco");
                }
            }
            if (!viaComm) {
                // Deprecated on 31+, still the only way to raise SCO when the candidate device is
                // not listed yet (which is exactly the state before the link exists).
                try {
                    am.startBluetoothSco();
                    am.setBluetoothScoOn(true);
                    scoLegacy = true;
                    link = "startBluetoothSco";
                } catch (Throwable t) {
                    NotifyService.log("原生麦克风：startBluetoothSco 失败 " + t.getMessage());
                }
            }
            // SCO is asynchronous: without this wait the recorder is built while the link is still
            // coming up and silently binds the built-in mic — the reported symptom, again.
            for (int i = 0; i < 12; i++) {
                if (i > 0) {
                    try {
                        Thread.sleep(150);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                AudioDeviceInfo up = pickBluetoothInput(am);
                if (up != null) {
                    scoDev = up;
                    break;
                }
            }
            if (scoDev != null) {
                chosen = scoDev;
                source = MediaRecorder.AudioSource.VOICE_COMMUNICATION;
            }
        }
        if (chosen == null && wiredDev != null) {
            chosen = wiredDev;
            source = MediaRecorder.AudioSource.VOICE_RECOGNITION;
        }
        if (chosen != null) {
            routed = chosen;
            NotifyService.log("原生麦克风：选择输入设备 " + name(chosen) + "（蓝牙链路 " + link + "）");
        } else {
            NotifyService.log("原生麦克风：没有耳机输入，用手机自带麦克风（有蓝牙设备=" + btThere
                + "，输入列表=" + inputs + "）");
        }
        rec = new AudioRecord(source, hz,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, hz * 2));
        if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
            int state = rec.getState();
            release();
            NotifyService.log("原生麦克风：初始化失败 state=" + state);
            return "error: init state=" + state;
        }
        if (chosen != null) {
            // Wired / USB headsets need this one call; for Bluetooth it pins the SCO route the
            // communication device just opened. Must be before startRecording().
            try {
                if (!rec.setPreferredDevice(chosen)) {
                    NotifyService.log("原生麦克风：setPreferredDevice 拒绝 " + name(chosen));
                }
            } catch (Throwable t) {
                NotifyService.log("原生麦克风：setPreferredDevice 抛错 " + t.getMessage());
            }
        }
        rec.startRecording();
        running = true;
        pump = new Thread(this::pump, "agentus-mic");
        pump.start();
        // What the OS actually routed to — the one line that tells a later "戴耳机还是手机麦"
        // report whether the request worked.
        String live = "";
        try {
            AudioDeviceInfo got = rec.getRoutedDevice();
            live = got == null ? "未知" : name(got);
        } catch (Throwable ignored) {
            // older ROMs
        }
        final String report = "原生麦克风：已开始（" + hz + "Hz 单声道 s16le，走 " + live
            + "）；请求=" + (chosen == null ? "手机自带" : name(chosen))
            + " 链路=" + link + " 模式=" + (am == null ? "?" : am.getMode())
            + " 蓝牙设备=" + btThere + " 输入列表=" + inputs;
        NotifyService.log(report);
        // The phone answers "戴耳机还是手机麦" itself: this line lands in the server's device record
        // (and its log) so the next round does not depend on anyone reading a log off the screen.
        reportToServer(report);
        return "ok";
    }

    /** Read → base64 → the page. A read that fails is not logged per frame: that is a loop, not a log.
     *  It IS logged when the loop produces nothing (a recorder that never fills) or dies — otherwise
     *  "0 frames arrived" has no cause anywhere, which is exactly what the first bridge build showed. */
    private void pump() {
        final short[] buf = new short[FRAME];
        final byte[] bytes = new byte[FRAME * 2];
        int frames = 0;
        int badReads = 0;
        try {
            while (running) {
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) {
                    badReads++;
                    // 500 empty reads ≈ a second of silence that never arrives: stop, do not spin
                    if (badReads == 1 || badReads % 100 == 0) {
                        NotifyService.log("原生麦克风：read=" + n + "（第 " + badReads + " 次读到空）");
                    }
                    if (badReads > 500) break;
                    continue;
                }
                for (int i = 0; i < n; i++) {
                    bytes[2 * i] = (byte) (buf[i] & 0xff);
                    bytes[2 * i + 1] = (byte) ((buf[i] >> 8) & 0xff);
                }
                final String b64 = Base64.encodeToString(bytes, 0, n * 2, Base64.NO_WRAP);
                if (!running) break;
                frames++;
                sent = frames;
                if (frames == 1 || frames % 100 == 0) {
                    NotifyService.log("原生麦克风：已送出 " + frames + " 帧（每帧 " + n + " 采样）");
                }
                ui.post(() -> {
                    try {
                        web.evaluateJavascript("window.__asMic&&window.__asMic('" + b64 + "')", null);
                    } catch (Throwable t) {
                        NotifyService.log("原生麦克风：送帧失败 " + t.getClass().getSimpleName() + " :: " + t.getMessage());
                    }
                });
            }
        } catch (Throwable t) {
            NotifyService.log("原生麦克风：读取中断 " + t.getClass().getSimpleName() + " :: " + t.getMessage());
        } finally {
            release();
            NotifyService.log("原生麦克风：pump 结束，共送出 " + frames + " 帧（空读 " + badReads + "）");
        }
    }

    /** Stop capturing. Idempotent; the pump thread releases the recorder itself. */
    @JavascriptInterface
    public void stop() {
        if (!running && rec == null) return;
        running = false;
        Thread t = pump;
        pump = null;
        if (t != null) {
            try {
                t.join(400);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        release();
        NotifyService.log("原生麦克风：已停止");
    }

    boolean isRunning() {
        return running;
    }

    /**
     * Ask for what the route needs, and WAIT for the answer.
     *
     * Returning "permission" and letting the page retry looked harmless, but the page gives up after
     * a few seconds and the dialog is answered whenever the operator gets to it — which turned a slow
     * tap into "点了没反应". One dialog, answered before anything else happens, is the whole point.
     */
    private boolean askPermissions(final boolean needMic) {
        final java.util.List<String> want = new java.util.ArrayList<>();
        if (needMic) want.add(android.Manifest.permission.RECORD_AUDIO);
        final boolean bt = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !askedBt
            && activity.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED;
        if (bt) want.add(android.Manifest.permission.BLUETOOTH_CONNECT);
        if (want.isEmpty()) return true;
        if (bt) askedBt = true;
        final java.util.concurrent.CountDownLatch gate = new java.util.concurrent.CountDownLatch(1);
        permGate = gate;
        activity.runOnUiThread(() -> {
            try {
                activity.requestPermissions(want.toArray(new String[0]), REQ_MIC);
            } catch (Throwable t) {
                NotifyService.log("原生麦克风：弹授权失败 " + t.getMessage());
                gate.countDown();
            }
        });
        NotifyService.log("原生麦克风：申请权限 " + want);
        try {
            gate.await(30, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        permGate = null;
        final boolean mic = activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
        final boolean btOk = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || activity.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
        NotifyService.log("原生麦克风：权限结果 录音=" + mic + " 蓝牙=" + btOk);
        return needMic ? mic : btOk;
    }

    /** Called from the activity's onRequestPermissionsResult for {@link #REQ_MIC}. */
    void onPermissionsResult(String[] permissions, int[] results) {
        final StringBuilder sb = new StringBuilder();
        for (int i = 0; i < permissions.length; i++) {
            if (sb.length() > 0) sb.append(' ');
            sb.append(permissions[i].replace("android.permission.", ""))
              .append('=').append(i < results.length && results[i] == PackageManager.PERMISSION_GRANTED
                  ? "给" : "拒");
        }
        NotifyService.log("原生麦克风：授权回来 " + sb);
        final java.util.concurrent.CountDownLatch gate = permGate;
        if (gate != null) gate.countDown();
    }

    /** The Bluetooth input, if the link already exists (SCO or LE Audio). */
    private AudioDeviceInfo pickBluetoothInput(AudioManager am) {
        if (am == null) return null;
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            if (isBluetooth(d.getType())) return d;
        }
        return null;
    }

    /** Wired / USB headsets need no link: they are inputs the moment they are plugged in. */
    private AudioDeviceInfo pickWiredInput(AudioManager am) {
        if (am == null) return null;
        AudioDeviceInfo best = null;
        int bestRank = 0;
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            int r = rank(d.getType());
            if (!isBluetooth(d.getType()) && r > bestRank) {
                best = d;
                bestRank = r;
            }
        }
        return best;
    }

    /**
     * Is a Bluetooth headset attached at all? Checked across every device, sinks included: before
     * the HFP link is up the headset shows up only as an A2DP output, and that output is the one
     * and only hint that there is a microphone to go and fetch.
     */
    private boolean anyBluetooth(AudioManager am) {
        if (am == null) return false;
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_ALL)) {
            int t = d.getType();
            if (isBluetooth(t) || t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP) return true;
        }
        return false;
    }

    /** Every input the OS reports, for the log line: the list itself is the evidence. */
    private String listInputs(AudioManager am) {
        if (am == null) return "（无 AudioManager）";
        StringBuilder sb = new StringBuilder();
        try {
            for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
                if (sb.length() > 0) sb.append('、');
                sb.append(name(d));
            }
        } catch (Throwable t) {
            return "枚举失败：" + t.getMessage();
        }
        return sb.length() == 0 ? "（空）" : sb.toString();
    }

    /**
     * One line back to the server (POST /api/notify/diag), best-effort and off the calling thread:
     * the point is that a routing answer exists on the server side afterwards, not that it always
     * arrives. The local log has the same text either way.
     */
    private void reportToServer(final String text) {
        try {
            final Profiles.P p = new Profiles(activity).active();
            if (p == null || !p.hasToken()) return;
            final String url = p.url + "/api/notify/diag";
            final String token = p.token;
            final String body = new JSONObject()
                .put("text", text)
                .put("appVersion", BuildConfig.VERSION_NAME)
                .toString();
            new Thread(() -> {
                try {
                    Http.postJson(activity, url, token, body);
                } catch (Throwable ignored) {
                    // offline is fine; the log line already holds it
                }
            }, "agentus-mic-diag").start();
        } catch (Throwable ignored) {
            // no profile store yet — nothing to report to
        }
    }

    private static int rank(int type) {
        if (type == AudioDeviceInfo.TYPE_BLE_HEADSET) return 5;
        if (type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) return 4;
        if (type == AudioDeviceInfo.TYPE_USB_HEADSET) return 3;
        if (type == AudioDeviceInfo.TYPE_WIRED_HEADSET) return 2;
        if (type == AudioDeviceInfo.TYPE_USB_DEVICE) return 1;
        return 0;
    }

    private static boolean isBluetooth(int type) {
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == AudioDeviceInfo.TYPE_BLE_HEADSET;
    }

    private static String name(AudioDeviceInfo d) {
        String n = String.valueOf(d.getProductName());
        return n + "(" + d.getType() + ")";
    }

    /** Frames handed to the page so far (see the field: "sent" and "received" are different bugs). */
    int sentFrames() {
        return sent;
    }

    private void release() {
        AudioRecord r = rec;
        rec = null;
        try {
            if (r != null) {
                try {
                    if (r.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) r.stop();
                } catch (Throwable ignored) {
                    // already stopped
                }
                try {
                    r.release();
                } catch (Throwable ignored) {
                    // already released
                }
            }
        } finally {
            restoreRoute();
        }
    }

    /** Put the phone's audio output back the way it was. Leaving MODE_IN_COMMUNICATION or a pinned
     *  communication device behind makes music and video sound like a phone call afterwards. */
    private void restoreRoute() {
        final AudioManager am = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
        AudioDeviceInfo comm = commDevice;
        commDevice = null;
        routed = null;
        if (am == null) return;
        try {
            if (comm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.clearCommunicationDevice();
            }
            if (scoLegacy) {
                am.setBluetoothScoOn(false);
                am.stopBluetoothSco();
                scoLegacy = false;
            }
            if (prevMode != AudioManager.MODE_INVALID) {
                am.setMode(prevMode);
                prevMode = AudioManager.MODE_INVALID;
            }
        } catch (Throwable t) {
            NotifyService.log("原生麦克风：恢复音频路由失败 " + t.getMessage());
        }
    }
}
