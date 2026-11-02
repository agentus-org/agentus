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
            activity.runOnUiThread(() ->
                activity.requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_MIC));
            NotifyService.log("原生麦克风：还没有录音权限，弹系统授权");
            return "permission";
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
        // because nothing here ever named an input device. Bluetooth headsets are worse than that
        // — their microphone lives on the HFP/SCO link, which Android only opens in communication
        // mode, and A2DP (music profile) carries sound one way and never a microphone at all.
        final AudioManager am = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
        AudioDeviceInfo headset = pickHeadset(am);
        int source = MediaRecorder.AudioSource.VOICE_RECOGNITION;
        if (headset != null) {
            routed = headset;
            if (isBluetooth(headset.getType())) {
                source = MediaRecorder.AudioSource.VOICE_COMMUNICATION;
                try {
                    if (prevMode == AudioManager.MODE_INVALID) prevMode = am.getMode();
                    am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        if (am.setCommunicationDevice(headset)) commDevice = headset;
                        else NotifyService.log("原生麦克风：setCommunicationDevice 拒绝 " + name(headset));
                    } else {
                        am.startBluetoothSco();
                        am.setBluetoothScoOn(true);
                        scoLegacy = true;
                    }
                } catch (Throwable t) {
                    NotifyService.log("原生麦克风：切蓝牙通道失败 " + t.getClass().getSimpleName()
                        + " :: " + t.getMessage());
                }
            }
            NotifyService.log("原生麦克风：选择输入设备 " + name(headset));
        } else {
            NotifyService.log("原生麦克风：没有耳机输入设备，用手机自带麦克风");
        }
        rec = new AudioRecord(source, hz,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, hz * 2));
        if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
            int state = rec.getState();
            release();
            NotifyService.log("原生麦克风：初始化失败 state=" + state);
            return "error: init state=" + state;
        }
        if (headset != null) {
            // Wired / USB headsets need this one call; for Bluetooth it pins the SCO route the
            // communication device just opened. Must be before startRecording().
            try {
                if (!rec.setPreferredDevice(headset)) {
                    NotifyService.log("原生麦克风：setPreferredDevice 拒绝 " + name(headset));
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
        NotifyService.log("原生麦克风：已开始（" + hz + "Hz 单声道 s16le，走 " + live + "）");
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

    /** Which input to record from, most-specific first. Bluetooth ranks above wired because it is
     *  the case that silently falls back to the phone's own microphone: the HFP input only exists
     *  once the SCO link is up, so it is also looked for in the full device list. */
    private AudioDeviceInfo pickHeadset(AudioManager am) {
        if (am == null) return null;
        AudioDeviceInfo best = null;
        int bestRank = 0;
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            int r = rank(d.getType());
            if (r > bestRank) {
                best = d;
                bestRank = r;
            }
        }
        if (best != null && isBluetooth(best.getType())) return best;
        // A headset that is connected but whose input is not listed yet (SCO down) still has to be
        // found: without selecting it there is nothing for setCommunicationDevice to bring up.
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_ALL)) {
            int r = rank(d.getType());
            if (r > bestRank) {
                best = d;
                bestRank = r;
            }
        }
        return best;
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
