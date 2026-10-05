package app.agentslot.companion;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
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
        rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, hz,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, hz * 2));
        if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
            int state = rec.getState();
            release();
            NotifyService.log("原生麦克风：初始化失败 state=" + state);
            return "error: init state=" + state;
        }
        rec.startRecording();
        running = true;
        pump = new Thread(this::pump, "agentslot-mic");
        pump.start();
        NotifyService.log("原生麦克风：已开始（" + hz + "Hz 单声道 s16le）");
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

    /** Frames handed to the page so far (see the field: "sent" and "received" are different bugs). */
    int sentFrames() {
        return sent;
    }

    private void release() {
        AudioRecord r = rec;
        rec = null;
        if (r == null) return;
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
}
