package app.agentus.companion;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;


import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * One screen: the saved servers, a form to add or edit one, and the live log.
 *
 * Deliberately a list rather than a single "current server": the operator runs more than one
 * Agentus (home LAN, the public tunnel, a work box), and switching must be one tap — with the
 * password kept so a token the server forgot can be re-minted without anyone typing it again.
 *
 * Foldable-aware (the operator's phone is a Xiaomi MIX Fold 4): the cover screen is a normal
 * ~411dp phone and gets one column, the unfolded ~847dp inner screen gets two. The layout is
 * rebuilt from whatever the current configuration says, and the half-typed form survives the
 * rebuild — HyperOS force-relaunches an activity on fold/unfold rather than trusting its
 * configChanges, so the state has to be saved properly instead of assumed.
 */
public final class MainActivity extends Activity {
    private static final String S_NAME = "form.name";
    private static final String S_URL = "form.url";
    private static final String S_USER = "form.user";
    private static final String S_PASS = "form.pass";
    private static final String S_PAIR = "form.pair";
    private static final String S_REMEMBER = "form.remember";
    private static final String S_EDITING = "form.editing";

    /** 720dp ≈ 7"-class tablet width; MIX Fold 4 unfolded reports ~847dp, its cover screen ~411dp. */
    private static final int TWO_PANE_MIN_DP = 720;

    private Profiles profiles;
    private LinearLayout listBox;
    private TextView formTitle;
    private EditText fName, fUrl, fUser, fPass, fPair;
    private CheckBox fRemember;
    private TextView statusView, infoView, logView;
    private String editingId = null;
    private boolean wide = false;
    private int renderedRevision = -1;
    /** 上岛自检进行中（再点一次就是取消）。 */
    private boolean selfTestRunning = false;
    /** 页面要麦克风、而 App 还没拿到系统录音权限时，把这次请求挂住，别 deny。 */
    private PermissionRequest pendingAudioRequest = null;
    /** 最近一次语音自检的结果：原生那半（App 自己能不能录）与页面那半（WebView 能不能拿到）。 */
    private volatile String nativeProbe = "（未跑）";
    private volatile String pageProbe = "（未跑）";
    /** 原生桥（window.AgentusMic）那一半：页面直接让 App 录音、帧有没有真的到页面。 */
    private volatile String bridgeProbe = "（未跑）";
    /** 页面探针的轮询次数（探针可能一步都不返回，等不到就不能一直等）。 */
    private int probeTries = 0;
    /** 页面要麦克风的次数 / 放行次数 / 挂起去申请系统权限的次数——判断"请求到底有没有到过我们"。 */
    private volatile int audioReq = 0, audioGranted = 0, audioHeld = 0;
    private String renderedLogHead = "";
    private final Handler ticker = new Handler(Looper.getMainLooper());
    private final AtomicReference<String> lastMessage = new AtomicReference<>("就绪");

    // ---- screens -------------------------------------------------------------
    // The app OPENS ON THE COCKPIT — the actual Agentus web UI in a WebView — because that is what
    // "install the app" is supposed to mean. The configuration screen is one tap away in the toolbar.
    // (An earlier build opened straight into the settings list; the operator's reaction to that was
    // the correct one: "为什么我打开后就是在设置界面，没有我们的这个 slot 网页".)
    private static final int SCREEN_COCKPIT = 0;
    private static final int SCREEN_CONFIG = 1;
    private static final String S_CONFIG_OPEN = "ui.configOpen";
    private FrameLayout content;
    private View configView;
    private TextView titleView;
    private WebView webView;
    /** The native microphone behind {@code window.AgentusMic} (see Mic: the WebView's own capture
     *  will not open on this ROM, this app's AudioRecord does). */
    private Mic mic;
    private int screen = SCREEN_COCKPIT;
    /** What the WebView currently has loaded, so switching servers reloads and re-using does not. */
    private String loadedUrl = "";
    /** Is the page in the WebView one of the operator's servers? Read by the JS bridge (see
     *  bridgeAllowed), written only on the UI thread. */
    private volatile boolean pageIsSavedServer = false;
    /** A notification tap arrived (see handleIntent); consumed by showCockpit / openPending. */
    private String pendingOpen = null;
    /** Extras the notification's own intent carries (Notifier.openIntent). */
    static final String EXTRA_OPEN_URL = "open_url";
    static final String EXTRA_OPEN_SERVER = "open_server";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        profiles = new Profiles(this);
        setContentView(buildUi());
        // Built once and kept alive: the 1-second refresh reads its widgets, so they must exist even
        // while the cockpit is the visible screen.
        configView = configUi();
        if (savedInstanceState != null) restoreForm(savedInstanceState);
        handleIntent(getIntent());
        // Opening the app means "the channel should be up". Until now only an explicit action
        // (pairing, switching, the 重连 button) brought the service back, so a task the system had
        // killed stayed dead even while the operator was staring at the app. onStartCommand is
        // idempotent (it only connects when there is no socket), so this is safe to repeat.
        Profiles.P boot = profiles.active();
        if (boot != null && boot.hasToken()) NotifyService.start(this);
        boolean wantConfig = savedInstanceState != null && savedInstanceState.getBoolean(S_CONFIG_OPEN, false);
        boolean hasServer = boot != null && boot.url != null && !boot.url.isEmpty();
        if (wantConfig || !hasServer) showConfig();
        else showCockpit();
        ticker.post(new Runnable() {
            @Override public void run() {
                refresh();
                ticker.postDelayed(this, 1000);
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        // populated on the first launch, so an empty form restores as an empty form
        out.putString(S_NAME, fName.getText().toString());
        out.putString(S_URL, fUrl.getText().toString());
        out.putString(S_USER, fUser.getText().toString());
        out.putString(S_PASS, fPass.getText().toString());
        out.putString(S_PAIR, fPair.getText().toString());
        out.putBoolean(S_REMEMBER, fRemember.isChecked());
        out.putString(S_EDITING, editingId);
        out.putBoolean(S_CONFIG_OPEN, screen == SCREEN_CONFIG);
    }

    @Override
    public void onBackPressed() {
        // Back inside the page history first, then back to the server list, then out — the order a
        // browser-shaped app is expected to have.
        if (screen == SCREEN_COCKPIT && webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        if (screen == SCREEN_COCKPIT) {
            showConfig();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        ticker.removeCallbacksAndMessages(null);
        if (mic != null) mic.stop();   // never leave AudioRecord open behind a dead activity
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    private void restoreForm(Bundle in) {
        fName.setText(nullToEmpty(in.getString(S_NAME)));
        fUrl.setText(nullToEmpty(in.getString(S_URL)));
        fUser.setText(nullToEmpty(in.getString(S_USER)));
        fPass.setText(nullToEmpty(in.getString(S_PASS)));
        fPair.setText(nullToEmpty(in.getString(S_PAIR)));
        fRemember.setChecked(in.getBoolean(S_REMEMBER, true));
        editingId = in.getString(S_EDITING);
        formTitle.setText(editingId == null ? "添加服务器" : "编辑服务器");
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    // ---- UI -----------------------------------------------------------------

    private int dp(int v) {
        return (int) (getResources().getDisplayMetrics().density * v);
    }

    // ---- screens: the cockpit (default) vs the configuration -----------------

    private View buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        // From Android 15 on, an app draws edge to edge whether it wants to or not: without this the
        // toolbar (and the first row of the server form) hides behind the status bar, which is also
        // why a tap meant for 服务器 landed in SystemUI's touch area (found on the emulator).
        //
        // The IME is part of the same story and is why `windowSoftInputMode="adjustResize"` is not
        // enough: for an app targeting SDK 35+ the window is NOT resized when the keyboard comes up,
        // so the page under it just sits there with the keyboard over it (the operator: 「输入法弹出时
        // 页面没任何反应」). Below API 35 adjustResize still works and the ime inset stays 0, so this
        // only takes over where the platform stopped doing it. Padding the root is what makes the
        // WebView — and the settings form — genuinely shrink, the way a browser window does.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top = 0;
            int bottom = 0;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                top = bars.top;
                bottom = bars.bottom;
                if (Build.VERSION.SDK_INT >= 35 && insets.isVisible(WindowInsets.Type.ime())) {
                    bottom = Math.max(bottom, insets.getInsets(WindowInsets.Type.ime()).bottom);
                }
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(0, top, 0, bottom);
            return WindowInsets.CONSUMED;
        });
        root.addView(toolbar(), new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        return root;
    }

    /** 一条工具条：回服务器列表 / 当前是哪台、在线否 / 刷新。 */
    private View toolbar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(8), dp(6), dp(8), dp(6));
        bar.setBackgroundColor(Color.parseColor("#f2f2ef"));
        bar.addView(toolButton("服务器", v -> showConfig()));
        titleView = new TextView(this);
        titleView.setTextSize(12);
        titleView.setTextColor(Color.parseColor("#4a4a48"));
        titleView.setSingleLine(true);
        titleView.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        titleView.setGravity(Gravity.CENTER_VERTICAL);
        titleView.setPadding(dp(10), 0, dp(6), 0);
        bar.addView(titleView, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(toolButton("刷新", v -> reloadCockpit()));
        return bar;
    }

    private void showConfig() {
        screen = SCREEN_CONFIG;
        content.removeAllViews();
        if (webView != null && webView.getParent() == content) content.removeView(webView);
        content.addView(configView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        updateToolbar();
    }

    private void showCockpit() {
        Profiles.P p = profiles.active();
        if (p == null || p.url == null || p.url.isEmpty()) {
            showConfig();
            setMessage("先加一台服务器，再进驾驶舱");
            return;
        }
        screen = SCREEN_COCKPIT;
        content.removeAllViews();
        ensureWebView();
        content.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        String want = p.url.replaceAll("/+$", "");
        if (pendingOpen != null && !pendingOpen.isEmpty()) {
            // a tap is waiting for a WebView to exist: it wins over the bare cockpit URL
            String target = pendingOpen;
            pendingOpen = null;
            loadedUrl = want;
            webView.loadUrl(target);
        } else if (!want.equals(loadedUrl)) {
            loadedUrl = want;
            webView.loadUrl(want);
        }
        updateToolbar();
    }

    private void reloadCockpit() {
        if (webView != null && screen == SCREEN_COCKPIT) webView.reload();
        else showCockpit();
    }

    private void updateToolbar() {
        if (titleView == null) return;
        Profiles.P p = profiles.active();
        String where = p == null ? "（还没有服务器）" : p.label() + (NotifyService.connected ? " ●" : " ○");
        titleView.setText(screen == SCREEN_CONFIG
            ? "设置 · " + where
            : where + (p == null ? "" : " · " + p.url));
    }

    /**
     * The cockpit itself, in a plain WebView. The notification stack stays native (a page cannot
     * deliver anything once the app is closed), but the UI is the page: there is exactly one
     * cockpit, and re-implementing it natively would be a second product to keep in sync.
     */
    private void ensureWebView() {
        if (webView != null) return;
        WebView.setWebContentsDebuggingEnabled(true); // a sideloaded personal build
        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        // the cockpit reads its replies out loud; requiring a gesture first would swallow them
        s.setMediaPlaybackRequiresUserGesture(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        // The page's microphone, straight from the app. Chromium's own capture never opens on this
        // ROM (the page gets NotReadableError after every permission grant — see Mic), so the page
        // can record natively instead. Gated to the operator's own saved servers: a page that is not
        // one of them cannot make this app record.
        mic = new Mic(this, webView, this::bridgeAllowed);
        webView.addJavascriptInterface(mic, "AgentusMic");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if ("agentus".equals(scheme)) {              // a pairing link on the page
                    handleIntent(new Intent(Intent.ACTION_VIEW, u));
                    return true;
                }
                if (isSavedHost(u)) return false;              // our own server stays in the app
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u)); // anything else: the browser
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // The operator's own server uses a self-signed certificate, and a WebView cannot be
                // handed a TrustManager (our own sockets pin the CA instead). So: proceed only for a
                // host that is one of the SAVED servers, refuse everything else. The toolbar always
                // shows which server that is, so this consent is never invisible.
                if (isSavedHost(Uri.parse(error.getUrl()))) handler.proceed();
                else handler.cancel();
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                // The bridge is off until the loaded page PROVES it is one of the operator's servers.
                pageIsSavedServer = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loadedUrl = url == null ? "" : url.replaceAll("/+$", "");
                pageIsSavedServer = isSavedHost(Uri.parse(loadedUrl));
                updateToolbar();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 页面上的听写/通话要麦克风 —— 页面里那句 "Could not start audio source" 就是这里没做全：
                //   ① 页面这一层要 grant（WebView 自己的权限）
                //   ② App 这一层要真的持有系统 RECORD_AUDIO（运行时权限）
                // 之前是先把页面请求 deny 掉、再去申请系统权限，于是第一次按下必然失败，得再按一次。
                // 现在把请求挂住（不 deny），系统授权回来后把**同一个**请求 grant 掉，页面那次
                // getUserMedia 就能直接拿到麦克风。
                for (String res : request.getResources()) {
                    if ("android.webkit.resource.AUDIO_CAPTURE".equals(res)) {
                        audioReq++;
                        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            audioGranted++;
                            NotifyService.log("页面要麦克风：系统权限已有，直接放行");
                            request.grant(new String[]{res});
                        } else {
                            audioHeld++;
                            NotifyService.log("页面要麦克风：系统权限没有，弹系统授权（请求先挂住）");
                            pendingAudioRequest = request;
                            setMessage("页面要麦克风：先在系统弹窗里允许「录音」");
                            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 2);
                        }
                        return;
                    }
                }
                NotifyService.log("页面要别的权限（不是麦克风），拒掉：" + java.util.Arrays.toString(request.getResources()));
                request.deny();
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                return false; // no popups: a target=_blank link loads in this very view
            }
        });
    }

    /** Is this URL one of the servers the operator saved? (host + port, scheme-agnostic) */
    private boolean isSavedHost(Uri u) {
        String host = u.getHost() == null ? "" : u.getHost();
        if (host.isEmpty()) return false;
        String port = portOf(u);
        for (Profiles.P p : profiles.all()) {
            if (p.url == null || p.url.isEmpty()) continue;
            Uri saved = Uri.parse(p.url);
            String savedHost = saved.getHost() == null ? "" : saved.getHost();
            if (savedHost.equalsIgnoreCase(host) && portOf(saved).equals(port)) return true;
        }
        return false;
    }

    private static String portOf(Uri u) {
        if (u.getPort() > 0) return String.valueOf(u.getPort());
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        return scheme.startsWith("https") || scheme.startsWith("wss") ? "443" : "80";
    }

    /** May the page that is loaded right now use the native microphone? Same test as the saved-host
     *  SSL waiver: the operator's own servers only.
     *
     *  CACHED on purpose: this is called from the JS-bridge thread, and touching a WebView from any
     *  thread but the UI thread throws ("All WebView methods must be called on the same thread") —
     *  which is exactly how the first bridge build failed its own probe: the page got a Java exception
     *  instead of a microphone. The flag is maintained where the URL is known, on the UI thread. */
    private boolean bridgeAllowed() {
        return pageIsSavedServer;
    }

    private View configUi() {
        Configuration cfg = getResources().getConfiguration();
        wide = cfg.screenWidthDp >= TWO_PANE_MIN_DP;

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(20), dp(20), dp(10));

        TextView title = new TextView(this);
        title.setText("服务器与通知");
        title.setTextSize(22);
        root.addView(title);

        TextView hint = new TextView(this);
        hint.setText("App 打开就是驾驶舱（这台服务器的网页）。这里只配两件事：连哪台服务器、通知怎么推。"
            + "地址 + 用户名密码配对后，它会自己拿设备令牌；多台服务器都留在这儿，点「切换」即换。");
        hint.setTextSize(13);
        hint.setPadding(0, dp(6), 0, dp(10));
        root.addView(hint);

        if (wide) {
            // unfolded: servers on the left, the form + live state on the right
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.addView(scroll(listPanel()), new LinearLayout.LayoutParams(dp(320), ViewGroup.LayoutParams.MATCH_PARENT));
            LinearLayout.LayoutParams rightLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f);
            rightLp.leftMargin = dp(16);
            row.addView(scroll(detailPanel()), rightLp);
            root.addView(row, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
            return root;
        }

        // cover screen / ordinary phone: one column, one scroll
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.addView(listPanel());
        column.addView(detailPanel());
        ScrollView single = new ScrollView(this);
        single.addView(column, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return single;
    }

    private View scroll(View content) {
        ScrollView sv = new ScrollView(this);
        sv.addView(content, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return sv;
    }

    /** Left (or top) panel: the saved servers. */
    private View listPanel() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);

        TextView h = new TextView(this);
        h.setText("服务器");
        h.setTextSize(17);
        box.addView(h);

        listBox = new LinearLayout(this);
        listBox.setOrientation(LinearLayout.VERTICAL);
        box.addView(listBox);
        return box;
    }

    /** Right (or bottom) panel: the add/edit form, the tools and the live state. */
    private View detailPanel() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        // ---- add / edit form
        formTitle = new TextView(this);
        formTitle.setText("添加服务器");
        formTitle.setTextSize(17);
        formTitle.setPadding(0, dp(14), 0, dp(4));
        root.addView(formTitle);

        fName = field("名称（可留空）", false);
        fUrl = field("服务器地址，例如 https://i207f47592.wicp.vip:38787", false);
        fUser = field("用户名", false);
        fPass = field("密码", true);
        fRemember = new CheckBox(this);
        fRemember.setText("记住密码（换令牌/重连时自动用）");
        fRemember.setChecked(true);
        // Creating a field is not the same as showing it: these must be attached, or the form is
        // invisible and only the pairing-string path works at all (found on a real emulator by
        // dumping the accessibility tree — the screen looked "plausible" without them).
        root.addView(fName);
        root.addView(fUrl);
        root.addView(fUser);
        root.addView(fPass);
        root.addView(fRemember);

        LinearLayout saveRow = new LinearLayout(this);
        saveRow.setOrientation(LinearLayout.HORIZONTAL);
        saveRow.addView(button("保存并连接", v -> saveForm()));
        saveRow.addView(button("取消编辑", v -> resetForm()));
        root.addView(saveRow);

        // ---- advanced: a pairing string (what the server's /notify page prints)
        TextView adv = new TextView(this);
        adv.setText("或者贴服务端页面上那行配对串：");
        adv.setTextSize(13);
        adv.setPadding(0, dp(12), 0, dp(2));
        root.addView(adv);
        fPair = field("agentus://pair?u=…&c=…", false);
        root.addView(button("用配对串添加", v -> addFromPairString()));

        // ---- the way back to the thing the app is for, plus the island self-test (the two "act now"
        // buttons — buried under the form they were invisible on a phone, which is how you end up
        // being asked "小米灵动岛我怎么测试")
        LinearLayout tools0 = new LinearLayout(this);
        tools0.setOrientation(LinearLayout.HORIZONTAL);
        tools0.addView(button("进驾驶舱", v -> showCockpit()));
        tools0.addView(button("上岛自检", v -> islandSelfTest("", "上岛自检")));
        // Option A, on its own button: the AOSP promoted path with the vendor path skipped. Android 16's
        // Live Updates need NO Xiaomi grant (only a normal permission this app already declares), so this
        // is the one island route an individual can take without a company entity — but HyperOS may or
        // may not render it, and only this phone can answer that.
        tools0.addView(button("原生实时动态", v -> islandSelfTest("aosp", "原生动态自检")));
        root.addView(tools0);
        LinearLayout tools0b = new LinearLayout(this);
        tools0b.setOrientation(LinearLayout.HORIZONTAL);
        tools0b.addView(button("语音自检", v -> voiceSelfTest()));
        tools0b.addView(button("复制诊断", v -> copyDiagnosis()));
        root.addView(tools0b);

        // ---- live state
        LinearLayout tools = new LinearLayout(this);
        tools.setOrientation(LinearLayout.HORIZONTAL);
        tools.addView(button("申请通知权限", v -> requestNotificationPermission()));
        tools.addView(button("实时动态开关", v -> openPromotedSettings()));
        root.addView(tools);
        LinearLayout tools2 = new LinearLayout(this);
        tools2.setOrientation(LinearLayout.HORIZONTAL);
        tools2.addView(button("发测试通知", v -> probe()));
        tools2.addView(button("重连", v -> {
            NotifyService.restart(this);
            setMessage("已请求重连");
        }));
        tools2.addView(button("清日志", v -> NotifyService.clearLog()));
        root.addView(tools2);
        LinearLayout tools3 = new LinearLayout(this);
        tools3.setOrientation(LinearLayout.HORIZONTAL);
        tools3.addView(button("小米焦点通知权限", v -> checkXiaomiFocus()));
        tools3.addView(button("系统设置", v -> openAppSettings()));
        root.addView(tools3);

        statusView = new TextView(this);
        statusView.setTextSize(14);
        statusView.setPadding(0, dp(12), 0, dp(4));
        root.addView(statusView);

        infoView = new TextView(this);
        infoView.setTextSize(12);
        root.addView(infoView);

        logView = new TextView(this);
        logView.setTextSize(11);
        logView.setPadding(0, dp(8), 0, 0);
        root.addView(logView);
        return root;
    }

    private EditText field(String hint, boolean password) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setTextSize(14);
        if (password) e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        return e;
    }

    /**
     * Buttons are pills, not the platform Button. A default Button carries a 48dp minimum height, a
     * wide intrinsic padding and a raised grey gradient — in a 34dp toolbar that reads as two
     * oversized slabs (the operator's words: 「刷新按钮太大太丑」). One helper, so the toolbar, the
     * rows and the form all get the same shape.
     */
    private TextView pill(String label, float textSize, int padH, int padV, View.OnClickListener click) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextSize(textSize);
        t.setTextColor(Color.parseColor("#1b1b1b"));
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(padH), dp(padV), dp(padH), dp(padV));
        t.setMinWidth(0);
        t.setMinimumWidth(0);
        t.setMinHeight(0);
        t.setMinimumHeight(0);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#ffffff"));
        bg.setCornerRadius(dp(18));
        bg.setStroke(Math.max(1, dp(1)), Color.parseColor("#dcdcd6"));
        t.setBackground(new RippleDrawable(
            ColorStateList.valueOf(Color.parseColor("#1a000000")), bg, null));
        t.setClickable(true);
        t.setFocusable(true);
        t.setOnClickListener(click);
        return t;
    }

    /** A normal action (settings rows, form): comfortable to hit. */
    private TextView button(String label, View.OnClickListener click) {
        return pill(label, 14f, 14, 9, click);
    }

    /** A toolbar action: deliberately smaller. */
    private TextView toolButton(String label, View.OnClickListener click) {
        return pill(label, 13f, 11, 5, click);
    }

    // ---- render --------------------------------------------------------------

    private void refresh() {
        if (profiles.revision() != renderedRevision) {
            renderedRevision = profiles.revision();
            renderList();
            updateToolbar(); // a server switching / coming online must show up in the toolbar too
        }
        statusView.setText(lastMessage.get() + "\n" + NotifyService.status);

        Profiles.P active = profiles.active();
        StringBuilder sb = new StringBuilder();
        sb.append("当前: ").append(active == null ? "（未配置服务器）" : active.label() + " · " + active.url).append('\n');
        sb.append("令牌: ").append(active == null ? "—" : (active.hasToken() ? "有（" + active.deviceId + "）" : "无，连接时自动配对")).append('\n');
        sb.append("连接: ").append(NotifyService.connected ? "在线" : "不在线")
          .append(NotifyService.connectedTo != null ? "（" + NotifyService.connectedTo + "）" : "").append('\n');
        sb.append("游标: ").append(active == null ? "—" : String.valueOf(active.cursor)).append('\n');
        sb.append("密码存储: ").append(profiles.encrypted() ? "Keystore 加密" : "未加密（设备无 Keystore）").append('\n');
        sb.append("系统: Android ").append(Build.VERSION.RELEASE).append("（API ").append(Build.VERSION.SDK_INT).append("）")
          .append(XiaomiFocus.isXiaomi() ? " · " + XiaomiFocus.miuiVersion() : "").append('\n');
        sb.append("实时动态: ").append(Build.VERSION.SDK_INT >= 36
            ? (LiveUpdate.available(this) ? "可用" : "被系统/用户关闭") : "这台设备没有（API<36）").append('\n');
        sb.append("麦克风: ").append(checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            ? "已授权" : "未授权（页面里按语音会弹系统授权）")
          .append(isInsecureOrigin() ? " · 当前地址是 http，浏览器不给麦克风 —— 语音请用 https 那条" : "").append('\n');
        Configuration cfg = getResources().getConfiguration();
        sb.append("屏幕: ").append(cfg.screenWidthDp).append("×").append(cfg.screenHeightDp).append("dp · ")
          .append(cfg.smallestScreenWidthDp).append("sw · ")
          .append(wide ? "双栏（展开态）" : "单栏（折叠态）").append('\n');
        sb.append("小米岛: ").append(!XiaomiFocus.isXiaomi() ? "非小米设备"
            : (XiaomiFocus.canShowFocus(this) ? "开关已开" : "开关关着（澎湃白名单）")
              + " · 协议 " + XiaomiFocus.protocolVersion(this)
              + " · 岛特性 " + (XiaomiFocus.islandSupported() ? "有" : "无")
              + (XiaomiFocus.islandAvailable(this) ? " · 按岛模板发" : " · 只发焦点通知")).append('\n');
        sb.append("版本: ").append(BuildConfig.VERSION_NAME);
        infoView.setText(sb.toString());

        List<String> lines = NotifyService.logLines();
        String head = lines.isEmpty() ? "" : lines.get(0);
        if (!head.equals(renderedLogHead)) {
            renderedLogHead = head;
            StringBuilder log = new StringBuilder();
            int max = wide ? 30 : 14;
            for (int i = 0; i < lines.size() && i < max; i++) log.append(lines.get(i)).append('\n');
            logView.setText(log.toString());
        }
    }

    private void renderList() {
        listBox.removeAllViews();
        List<Profiles.P> all = profiles.all();
        Profiles.P active = profiles.active();
        if (all.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText("还没有服务器 —— 在下面填地址和用户名密码，或用配对串添加。");
            empty.setTextSize(13);
            listBox.addView(empty);
            return;
        }
        for (Profiles.P p : all) {
            boolean isActive = active != null && p.id.equals(active.id);
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(0, dp(8), 0, dp(4));

            TextView head = new TextView(this);
            head.setTextSize(15);
            head.setText((isActive ? "● " : "○ ") + p.label()
                + (isActive && NotifyService.connected ? "　在线" : "")
                + (isActive ? "　【当前】" : ""));
            row.addView(head);

            TextView sub = new TextView(this);
            sub.setTextSize(12);
            sub.setText(p.url
                + (p.hasLogin() ? "　·　" + p.username : "　·　无账号")
                + (p.hasToken() ? "　·　已配对" : "　·　待配对"));
            row.addView(sub);

            LinearLayout actions = new LinearLayout(this);
            actions.setOrientation(LinearLayout.HORIZONTAL);
            if (!isActive) actions.addView(button("切换", v -> switchTo(p)));
            actions.addView(button("编辑", v -> edit(p)));
            actions.addView(button("删除", v -> remove(p)));
            row.addView(actions);
            listBox.addView(row);
        }
    }

    private void setMessage(String msg) {
        lastMessage.set(msg);
    }

    // ---- actions -------------------------------------------------------------

    private void switchTo(Profiles.P p) {
        profiles.setActive(p.id);
        NotifyService.restart(this);
        setMessage("已切换到 " + p.label() + "（正在连接）");
        renderedRevision = -1; // force a redraw of the list
        showCockpit();         // switching servers means "take me to that cockpit"
    }

    private void edit(Profiles.P p) {
        editingId = p.id;
        fName.setText(p.name);
        fUrl.setText(p.url);
        fUser.setText(p.username);
        fPass.setText(p.password);
        fRemember.setChecked(p.remember);
        formTitle.setText("编辑：" + p.label());
        setMessage("正在编辑 " + p.label());
    }

    private void resetForm() {
        editingId = null;
        fName.setText("");
        fUrl.setText("");
        fUser.setText("");
        fPass.setText("");
        fPair.setText("");
        fRemember.setChecked(true);
        formTitle.setText("添加服务器");
    }

    private void remove(Profiles.P p) {
        boolean wasActive = profiles.active() != null && profiles.active().id.equals(p.id);
        profiles.remove(p.id);
        if (wasActive) NotifyService.restart(this);
        setMessage("已删除 " + p.label());
        renderedRevision = -1;
    }

    private void saveForm() {
        String url = Pairing.normalise(fUrl.getText().toString());
        if (url.isEmpty()) {
            setMessage("先填服务器地址");
            return;
        }
        Profiles.P p = editingId != null ? profiles.byId(editingId) : null;
        if (p == null) p = new Profiles.P();
        // a different address is a different server: the old token and cursor would be lies
        if (!url.equals(p.url)) {
            p.token = null;
            p.deviceId = null;
            p.cursor = 0L;
        }
        p.name = fName.getText().toString().trim();
        p.url = url;
        p.username = fUser.getText().toString().trim();
        p.password = fPass.getText().toString();
        p.remember = fRemember.isChecked();
        p.lastUsedAt = System.currentTimeMillis();
        profiles.upsert(p);
        profiles.setActive(p.id);
        resetForm();
        NotifyService.restart(this);
        setMessage("已保存并连接 " + p.label()
            + (p.hasLogin() ? "" : "（没有账号密码：需要配对串，或编辑它补上）"));
        renderedRevision = -1;
        requestNotificationPermission();
        showCockpit(); // saved and paired ⇒ show the thing the app is for
    }

    /** The pairing string path: an address and a code, no password needed. */
    private void addFromPairString() {
        String raw = fPair.getText().toString().trim();
        if (raw.isEmpty()) {
            setMessage("先粘配对串");
            return;
        }
        String[] parsed = Pairing.parsePairString(raw);
        if (parsed == null || parsed[0] == null || parsed[0].isEmpty()) {
            setMessage("配对串读不出地址");
            return;
        }
        final String base = parsed[0];
        final String code = parsed[1];
        final Profiles.P p = new Profiles.P();
        p.url = base;
        final String body;
        try {
            body = new JSONObject().put("code", code == null ? JSONObject.NULL : code).toString();
        } catch (Exception e) {
            setMessage("配对串解析失败");
            return;
        }
        setMessage("正在用配对串连接 " + base + " …");
        new Thread(() -> {
            try {
                JSONObject extra = new JSONObject(body);
                Pairing.Result r = Pairing.pair(this, base, extra);
                profiles.upsert(p);
                profiles.saveTokens(p.id, r.deviceId, r.deviceToken);
                profiles.setActive(p.id);
                runOnUiThread(() -> {
                    fPair.setText("");
                    setMessage("已添加并连接：" + p.label());
                    renderedRevision = -1;
                    NotifyService.restart(this);
                    requestNotificationPermission();
                    showCockpit(); // a pairing link should land in the cockpit, not in a form
                });
            } catch (Exception e) {
                runOnUiThread(() -> setMessage("配对失败：" + e.getMessage()));
            }
        }, "agentus-pair").start();
    }

    /**
     * Everything this phone can say about itself, as text: the build, the ROM's focus generation,
     * whitelist/permission probes, the microphone state, the address in use, and the exact payload
     * the island path would attach. Both the log and the server report are this one string.
     */
    private String diagnosis() {
        StringBuilder sb = new StringBuilder();
        sb.append("App ").append(BuildConfig.VERSION_NAME).append("（code ").append(BuildConfig.VERSION_CODE).append("）\n");
        Profiles.P p = profiles.active();
        sb.append("服务器: ").append(p == null ? "（无）" : p.url).append('\n');
        sb.append(XiaomiFocus.describe(this)).append('\n');
        sb.append("麦克风: ").append(checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            ? "已授权" : "未授权")
          .append(" · 页面请求过 ").append(audioReq).append(" 次（放行 ").append(audioGranted)
          .append(" / 挂起申请 ").append(audioHeld).append("）")
          .append(" · 原生桥=").append(mic == null ? "没建" : ("有 · 送出帧=" + mic.sentFrames()))
          .append(" · 改动音频设置权限=")
          .append(checkSelfPermission(Manifest.permission.MODIFY_AUDIO_SETTINGS) == PackageManager.PERMISSION_GRANTED
              ? "有" : "没有")
          .append('\n');
        sb.append("语音自检: 页面 getUserMedia=").append(pageProbe)
          .append(" / 原生桥=").append(bridgeProbe)
          .append(" / 裸 AudioRecord=").append(nativeProbe).append('\n');
        try {
            sb.append(XiaomiFocus.preview(this, selfTestPayload(3, 8, "", "上岛自检")));
        } catch (Exception e) {
            sb.append("岛参数构造失败: ").append(e.getMessage());
        }
        return sb.toString();
    }

    /**
     * 语音自检：把"页面拿不到麦克风"拆成两半分别验，因为它们的修法完全不同。
     *
     *   原生那半 — {@code AudioRecord} 直接开一次。能录 ⇒ 系统/权限没问题，问题在 WebView 那条路；
     *              录不了 ⇒ 是 OS 这一层不让（错误串会说明是 SecurityException 还是设备忙）。
     *   页面那半 — 往 WebView 里注入 getUserMedia，拿到确切的 error.name / message、是不是安全上下文、
     *              Permissions API 怎么说。这里报出来的就是页面上那句 "Could not start audio source" 的真身。
     *
     * Both halves end up in the diagnosis that goes back to the server, so the answer does not depend on
     * anyone reading a log off a phone by hand.
     */
    private void voiceSelfTest() {
        nativeProbe = "（跑着…）";
        pageProbe = "（跑着…）";
        bridgeProbe = "（跑着…）";
        probeTries = 0;
        setMessage("语音自检：页面那条路 → 原生桥 → 裸 AudioRecord，约 20 秒");
        // The page probe runs FIRST and every later stage waits for it, on purpose: a native
        // AudioRecord takes the microphone for a moment, and a capture that starts a millisecond later
        // on the same device can fail for that reason alone — the test must not create the failure it
        // reports. Same reason the native bridge test runs after the three getUserMedia variants.
        webViewVoiceProbe();
    }

    /** Open AudioRecord once and read a frame — with the WebView out of the picture. */
    private void runNativeProbe() {
        new Thread(() -> {
            nativeProbe = audioRecordProbe();
            NotifyService.log("语音自检（原生 AudioRecord，页面探针之后跑）: " + nativeProbe);
            runOnUiThread(() -> {
                setMessage("语音自检完成，已上报");
                reportDiagnosis();
            });
        }, "agentus-audioprobe").start();
    }

    /** Can THIS APP record at all, WebView out of the picture? */
    private String audioRecordProbe() {
        final int rate = 16000;
        android.media.AudioRecord rec = null;
        try {
            int min = android.media.AudioRecord.getMinBufferSize(rate,
                android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) return "getMinBufferSize=" + min + "（设备没给可用参数）";
            rec = new android.media.AudioRecord(android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION,
                rate, android.media.AudioFormat.CHANNEL_IN_MONO,
                android.media.AudioFormat.ENCODING_PCM_16BIT, Math.max(min, rate));
            if (rec.getState() != android.media.AudioRecord.STATE_INITIALIZED) {
                return "初始化失败（state=" + rec.getState() + "）";
            }
            rec.startRecording();
            short[] buf = new short[Math.max(160, min / 2)];
            int n = rec.read(buf, 0, buf.length);
            rec.stop();
            return n > 0 ? "可以录（读到 " + n + " 帧）" : "read 返回 " + n;
        } catch (Throwable t) {
            return "录不了：" + t.getClass().getSimpleName() + " :: " + t.getMessage();
        } finally {
            try { if (rec != null) rec.release(); } catch (Throwable ignored) { }
        }
    }

    /** The page-side half: the exact outcome of the very API the cockpit's voice button calls. */
    private void webViewVoiceProbe() {
        if (webView == null) {
            pageProbe = "WebView 还没建（先进驾驶舱一次）";
            reportDiagnosis();
            return;
        }
        // evaluateJavascript does not await promises — an async IIFE comes back as "{}" (learned the
        // hard way). So: kick the probe off, have it park the answer on `window`, read it back later.
        //
        // Three constraint sets, because "the processed pipeline will not open on this ROM" and "capture
        // is broken here" look identical from one attempt: a(n) = what the page asks for today,
        // b(n) = the same with the WebRTC audio processing off, c(n) = 16 kHz mono with processing off
        // (what the streaming recogniser wants).
        //
        // Every step has a TIMEOUT and the result is written after EACH step: a getUserMedia that
        // neither resolves nor rejects used to leave the read-back showing "（跑着…）" — an answer of
        // "no answer", which cost a whole round trip on the real phone.
        String js = "window.__asVoice=JSON.stringify({step:'start',secure:window.isSecureContext,"
            + "md:!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia),"
            + "bridge:!!(window.AgentusMic&&window.AgentusMic.available)});"
            + "(async()=>{const o=JSON.parse(window.__asVoice);const put=()=>{window.__asVoice=JSON.stringify(o)};"
            + "const to=(p,ms)=>Promise.race([p,new Promise((_,r)=>setTimeout(()=>r(Object.assign(new Error('timeout'),{name:'TimeoutError'})),ms))]);"
            + "try{o.perm=(await to(navigator.permissions.query({name:'microphone'}),2000)).state}catch(e){o.perm='err:'+e.name}"
            + "try{o.nIn=(await to(navigator.mediaDevices.enumerateDevices(),2000)).filter(d=>d.kind==='audioinput').length}catch(e){o.nIn='err:'+e.name}"
            + "put();"
            + "const one=async(n,c)=>{o.step=n;put();try{const s=await to(navigator.mediaDevices.getUserMedia(c),4000);"
            + "const t=s.getAudioTracks()[0];o[n]='OK:'+((t&&t.label)||'(no label)');"
            + "try{o[n+'_set']=JSON.stringify(t.getSettings())}catch(e){}"
            + "s.getTracks().forEach(x=>x.stop())}catch(e){o[n]=e.name+' :: '+String(e.message||'').slice(0,120)}put()};"
            + "await one('a_default',{audio:true});"
            + "await one('b_noProc',{audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});"
            + "await one('c_16k',{audio:{sampleRate:16000,channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});"
            + "o.step='done';put()})();'started'";
        webView.evaluateJavascript(js, ignored -> { });
        // Poll instead of one fixed wait: the probe is normally done in ~14 s, and a slow ROM should be
        // read rather than declared "（跑着…）".
        ticker.postDelayed(new Runnable() {
            @Override public void run() {
                if (webView == null || ++probeTries > 8) {
                    if (webView == null) { runNativeProbe(); return; }
                    pageProbe = "（超时：探针没跑完）";
                    NotifyService.log("语音自检（页面侧）: " + pageProbe);
                    runBridgeProbe();
                    return;
                }
                webView.evaluateJavascript("window.__asVoice || '（无结果）'", value -> {
                    String v = unquote(value);
                    if (v.contains("\"step\":\"done\"")) {
                        pageProbe = v;
                        NotifyService.log("语音自检（页面侧）: " + pageProbe);
                        runBridgeProbe();
                    } else {
                        ticker.postDelayed(this, 2500);
                    }
                });
            }
        }, 4000);
    }

    /**
     * The native-bridge round trip: exactly what the page will do to record (Mic.start) and whether
     * frames really arrive in the page (window.__asMic) — the fallback path, end to end, on the device.
     */
    private void runBridgeProbe() {
        if (webView == null) {
            bridgeProbe = "WebView 还没建";
            runNativeProbe();
            return;
        }
        String js = "window.__asMicProbe='（跑着…）';(function(){var c=window.AgentusMic;"
            + "if(!c||!c.available()){window.__asMicProbe='没有原生桥';return}"
            + "window.__asMicN=0;window.__asMic=function(){window.__asMicN++};var r;"
            + "try{r=String(c.start(16000))}catch(e){r='throw:'+e.message}"
            + "window.__asMicStart=r;setTimeout(function(){try{c.stop()}catch(e){}"
            + "window.__asMicProbe=r+' · 收到帧='+window.__asMicN;window.__asMic=null},3000)})();'go'";
        webView.evaluateJavascript(js, ignored -> { });
        ticker.postDelayed(() -> {
            if (webView == null) {
                runNativeProbe();
                return;
            }
            webView.evaluateJavascript("window.__asMicProbe || '（无结果）'", value -> {
                bridgeProbe = unquote(value);
                NotifyService.log("语音自检（原生桥）: " + bridgeProbe);
                runNativeProbe();
            });
        }, 4200);
    }

    /** evaluateJavascript hands back JSON (quoted, escaped); the log wants the text inside. */
    private static String unquote(String v) {
        if (v == null) return "（null）";
        String s = v.trim();
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) s = s.substring(1, s.length() - 1);
        return s.replace("\\\"", "\"").replace("\\n", " ").replace("\\\\", "\\");
    }

    /**
     * Ship the diagnosis to the server (POST /api/notify/diag) so the operator can read the phone's
     * own account of itself without a cable, a screenshot or a chat round-trip. Falls back to the
     * local log when there is no server/token; 「复制诊断」 covers the rest.
     */
    private void reportDiagnosis() {
        final String text = diagnosis();
        for (String line : text.split("\n")) NotifyService.log(line);
        final Profiles.P p = profiles.active();
        if (p == null || !p.hasToken()) {
            NotifyService.log("诊断只留在本机（没有服务器或设备令牌）");
            return;
        }
        new Thread(() -> {
            try {
                Http.postJson(this, p.url + "/api/notify/diag", p.token,
                    new JSONObject().put("text", text).put("appVersion", BuildConfig.VERSION_NAME).toString());
                runOnUiThread(() -> setMessage("诊断已上报服务器，后台可直接读"));
            } catch (Exception e) {
                runOnUiThread(() -> setMessage("诊断上报失败：" + e.getMessage() + " —— 可点「复制诊断」"));
            }
        }, "agentus-diag").start();
    }

    /** The same text on the clipboard, for when the server is unreachable. */
    private void copyDiagnosis() {
        String text = diagnosis();
        try {
            android.content.ClipboardManager cm =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(android.content.ClipData.newPlainText("Agentus 诊断", text));
            setMessage("诊断已复制到剪贴板（粘给谁都行）");
        } catch (Exception e) {
            setMessage("复制失败：" + e.getMessage());
        }
    }

    /** Deep link to this app's own system page — where a denied 录音 permission actually gets fixed. */
    private void openAppSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            setMessage("打不开系统设置：" + e.getMessage());
        }
    }

    /**
     * The microphone is the one thing the page cannot ask the system for: WebView hands the request to
     * the activity, and the activity still has to hold RECORD_AUDIO. Denying first and asking after
     * (what this used to do) means the press that triggered it always fails — grant the held request
     * instead, so the page's own getUserMedia call succeeds on the first try.
     */
    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != 2) return;
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (pendingAudioRequest != null) {
            if (granted) pendingAudioRequest.grant(new String[]{"android.webkit.resource.AUDIO_CAPTURE"});
            else pendingAudioRequest.deny();
            pendingAudioRequest = null;
            NotifyService.log(granted ? "麦克风已授权：已放行页面的麦克风请求" : "麦克风被拒：页面的麦克风请求已拒绝");
        } else {
            NotifyService.log("系统授权回来了但没有挂着的页面请求（可能页面已重载，再按一次语音即可）");
        }
        setMessage(granted ? "麦克风已授权，语音输入可以用了" : "麦克风被拒：语音用不了，去系统设置里给 Agentus 开「录音」");
        refresh();
    }

    /** getUserMedia needs a secure context; an http:// LAN address is not one, so voice is dead there. */
    private boolean isInsecureOrigin() {
        Profiles.P p = profiles.active();
        if (p == null || p.url == null) return false;
        String u = p.url.toLowerCase();
        if (!u.startsWith("http://")) return false;
        return !(u.contains("//127.0.0.1") || u.contains("//localhost") || u.contains("//10.0.2.2"));
    }

    /** Ask the active server to send its canned sequence to every paired device. */
    private void probe() {
        final Profiles.P p = profiles.active();
        if (p == null) {
            setMessage("先添加服务器");
            return;
        }
        if (!p.hasToken()) {
            setMessage("这台服务器还没有令牌：等它连上，或编辑补上账号密码");
            return;
        }
        new Thread(() -> {
            try {
                Http.postJson(this, p.url + "/api/notify/probe", p.token, "{}");
                runOnUiThread(() -> setMessage("已请求探针序列（约 6 秒内到）"));
            } catch (Exception e) {
                runOnUiThread(() -> setMessage("探针失败：" + e.getMessage()));
            }
        }, "agentus-probe").start();
    }

    /**
     * 上岛自检：不走服务器，直接用真实的渲染管线在本机发一条持续通知（进度会动），12 秒后自己收起。
     *
     * Why it exists: "can this phone show the island" was answerable only by waiting for a real agent
     * task and guessing. This posts through the *same* Notifier path the server's frames take (so it
     * tests the real thing, including the AOSP-vs-Xiaomi ordering), prints the full diagnosis into the
     * log, and finishes on its own — ten seconds, no server, no waiting for a turn to start.
     */
    private void islandSelfTest(String path, String title) {
        if (selfTestRunning) {
            selfTestRunning = false;
            setMessage("已取消自检");
            return;
        }
        for (String line : XiaomiFocus.describe(this).split("\n")) NotifyService.log(line);
        reportDiagnosis();
        final Profiles.P p = profiles.active();
        final String base = p == null ? null : p.url;
        final String forced = path == null ? "" : path;
        final String label = title == null || title.isEmpty() ? "上岛自检" : title;
        final String id = forced.isEmpty() ? "agentus-selftest" : "agentus-selftest-" + forced;
        selfTestRunning = true;
        setMessage(label + "中：盯住状态栏 / 锁屏 / 息屏（12 秒）");
        NotifyService.log("自检：通道=" + (forced.isEmpty() ? "自动（先小米焦点通知，再安卓原生）" : forced)
            + " · 标题=" + label);
        final int steps = 8;
        ticker.post(new Runnable() {
            int i = 0;

            @Override public void run() {
                if (!selfTestRunning) return;
                try {
                    JSONObject a = i < steps ? selfTestPayload(i, steps, forced, label)
                        : new JSONObject().put("activityId", id).put("op", "dismiss");
                    Notifier.apply(MainActivity.this, base, a);
                } catch (Exception e) {
                    NotifyService.log("自检失败：" + e.getMessage());
                }
                i++;
                if (i <= steps) {
                    ticker.postDelayed(this, 1500);
                } else {
                    selfTestRunning = false;
                    setMessage(label + "结束 —— 日志里写了走的是哪条路");
                }
            }
        });
    }

    /** One frame of the self-test, shaped exactly like the server's activity objects. */
    private JSONObject selfTestPayload(int i, int steps, String path, String title) throws Exception {
        double v = (double) (i + 1) / steps;
        int done = Math.max(1, (int) Math.round(v * 100));
        String label = title == null || title.isEmpty() ? "上岛自检" : title;
        JSONObject a = new JSONObject()
            .put("activityId", path == null || path.isEmpty() ? "agentus-selftest" : "agentus-selftest-" + path)
            .put("op", "upsert")
            .put("revision", i + 1)
            .put("ongoing", true)
            .put("promotable", true)
            .put("title", label)
            .put("subtitle", "Agentus")
            .put("body", "第 " + (i + 1) + "/" + steps + " 步 · 假装一个任务在跑")
            .put("channel", new JSONObject()
                .put("id", "agentus-selftest").put("name", "上岛自检")
                .put("importance", "default").put("sound", false).put("vibration", false))
            .put("progress", new JSONObject().put("value", v).put("segments", new org.json.JSONArray()
                .put(new JSONObject().put("length", done).put("color", "#2f6f4f"))
                .put(new JSONObject().put("length", Math.max(1, 100 - done)).put("color", "#e2e2dd"))))
            .put("actions", new org.json.JSONArray()
                .put(new JSONObject().put("id", "open").put("label", "查看")))
            .put("deeplink", "/");
        if (path != null && !path.isEmpty()) a.put("path", path);
        return a;
    }

    /**
     * HyperOS gates 焦点通知/超级岛 behind a permission we cannot request with an API — it is a
     * HyperOS-side grant (Xiaomi's dev platform or an on-device module). Say so plainly instead of
     * leaving the operator staring at a normal notification wondering why the island never shows.
     */
    private void checkXiaomiFocus() {
        XiaomiFocus.forgetPermission();
        if (!XiaomiFocus.isXiaomi()) {
            setMessage("这台设备不是小米/澎湃系统，走的是 Android 原生通道");
            return;
        }
        boolean ok = XiaomiFocus.canShowFocus(this);
        NotifyService.log("小米焦点通知权限探测: " + (ok ? "有" : "无"));
        if (ok) {
            setMessage("澎湃已授权焦点通知：任务进行中会上岛（点「上岛自检」可当场验）");
            return;
        }
        setMessage("澎湃未授权焦点通知。小米对三方应用是白名单制（要发邮件申请 + 场景审核，还要公司主体），"
            + "自建 App 基本拿不到；普通通知照常，只是不上岛。真想强上岛只能 root + LSPosed 的 HyperIsland 模块。");
        try {
            startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        } catch (Exception ignored) { }
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        // A notification tap: our own activity with the cockpit URL of the session it is about. The
        // intent is explicit (see Notifier.openIntent) — an implicit ACTION_VIEW would open a browser.
        String target = intent.getStringExtra(EXTRA_OPEN_URL);
        Uri data = intent.getData();
        if ((target == null || target.isEmpty()) && data != null
            && "agentus".equals(data.getScheme()) && "open".equals(data.getHost())) {
            target = data.getQueryParameter("u");
        }
        if (target != null && !target.isEmpty()) {
            pendingOpen = target;
            String server = intent.getStringExtra(EXTRA_OPEN_SERVER);
            if (server != null && !server.isEmpty()) switchServer(server);
            NotifyService.log("点通知 → 打开 " + target);
            if (screen == SCREEN_COCKPIT) openPending();
            else showCockpit(); // on the way up: showCockpit() consumes pendingOpen
            return;
        }
        if (data == null) return;
        if (!"agentus".equals(data.getScheme())) return;
        if (!"pair".equals(data.getHost())) return;
        String u = data.getQueryParameter("u");
        String c = data.getQueryParameter("c");
        if (u != null) {
            fPair.setText("agentus://pair?u=" + u + (c != null ? "&c=" + c : ""));
            addFromPairString();
        }
    }

    /** A tap belongs to the server that sent it; the operator may have switched servers since. */
    private void switchServer(String base) {
        Profiles.P active = profiles.active();
        if (active != null && sameBase(active.url, base)) return;
        for (Profiles.P p : profiles.all()) {
            if (sameBase(p.url, base)) {
                profiles.setActive(p.id);
                loadedUrl = ""; // the WebView is on another server: the next showCockpit must reload
                NotifyService.start(this);
                return;
            }
        }
    }

    private static boolean sameBase(String a, String b) {
        if (a == null || b == null) return false;
        String x = a.replaceAll("/+$", "");
        String y = b.replaceAll("/+$", "");
        return x.equalsIgnoreCase(y);
    }

    /** Navigate to a tap target that arrived while the cockpit was already on screen. */
    private void openPending() {
        if (pendingOpen == null || pendingOpen.isEmpty()) return;
        if (webView == null || screen != SCREEN_COCKPIT) { showCockpit(); return; }
        String target = pendingOpen;
        pendingOpen = null;
        NotifyService.log("驾驶舱已在屏上 → " + target);
        webView.loadUrl(target);
        updateToolbar();
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    /** The one system switch that decides whether a Live Update may be promoted. */
    private void openPromotedSettings() {
        try {
            startActivity(new Intent("android.settings.MANAGE_APP_PROMOTED_NOTIFICATIONS")
                .setData(Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            try {
                startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
            } catch (Exception e2) {
                setMessage("这台设备没有这个设置入口");
            }
        }
    }

    /** Kept for the contract doc: the capabilities this build actually implements. */
    static void forEachCapability(android.content.Context ctx, Consumer<String> sink) {
        try {
            org.json.JSONArray caps = Pairing.capabilities(ctx);
            for (int i = 0; i < caps.length(); i++) sink.accept(caps.getString(i));
        } catch (Exception ignored) { }
    }
}