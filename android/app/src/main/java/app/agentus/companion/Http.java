package app.agentus.companion;

import android.content.Context;

import java.io.InputStream;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Enumeration;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * One HTTP/WebSocket client for the whole app.
 *
 * The self-hosted server presents a certificate issued by the operator's own CA for a DDNS
 * name; a phone on the LAN reaches it by IP. System trust cannot express that, and hostname
 * verification would reject the IP against a DNS-only SAN, so this client:
 *
 *   * keeps the system trust store (so a later Let's Encrypt cert also works), and
 *   * additionally trusts the bundled Agentus root, and
 *   * accepts that root for whatever host the operator typed.
 *
 * That is CA pinning with a waived hostname, not "trust anything": a certificate that does
 * not chain to either store is still rejected.
 */
final class Http {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static OkHttpClient client;

    static synchronized OkHttpClient client(Context context) {
        if (client == null) {
            OkHttpClient.Builder b = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                // keeps NAT mappings and mobile radios alive without app-level pings
                .pingInterval(25, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true);
            try {
                b.sslSocketFactory(pinnedFactory(context), composite(context));
                b.hostnameVerifier((host, session) -> true);
            } catch (Exception e) {
                // No bundled CA (or an unreadable one): fall back to system trust so a
                // normal CA-signed deployment still works.
                NotifyService.log("CA 未内置，使用系统信任链：" + e.getMessage());
            }
            client = b.build();
        }
        return client;
    }

    /** Trust = (system store ∪ the CAs the operator installed) ∪ bundled Agentus root. */
    private static X509TrustManager composite(Context context) throws Exception {
        final X509TrustManager device = deviceManager();
        final X509TrustManager mine = manager(bundled(context));
        return new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws java.security.cert.CertificateException {
                device.checkClientTrusted(chain, authType);
            }

            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws java.security.cert.CertificateException {
                try {
                    device.checkServerTrusted(chain, authType);
                } catch (java.security.cert.CertificateException e) {
                    try {
                        mine.checkServerTrusted(chain, authType);
                    } catch (java.security.cert.CertificateException e2) {
                        // Say WHICH store failed and for what leaf: "trust anchor not found" from a
                        // phone is otherwise indistinguishable from a wrong host, a proxy, or a
                        // server that forgot to send its intermediate.
                        NotifyService.log("TLS 校验失败：" + describe(chain) + "；系统/用户信任链：" + e.getMessage()
                            + "；内置 CA：" + e2.getMessage());
                        throw e2;
                    }
                }
            }

            @Override public X509Certificate[] getAcceptedIssuers() {
                return device.getAcceptedIssuers();
            }
        };
    }

    private static String describe(X509Certificate[] chain) {
        if (chain == null || chain.length == 0) return "(空证书链)";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < chain.length; i++) {
            if (i > 0) sb.append(" <- ");
            sb.append(chain[i].getSubjectX500Principal().getName());
        }
        return sb.toString();
    }

    /**
     * The device's own trust sources, as ONE store: the system roots PLUS the CAs the operator
     * installed. Since Android 7 the user-added CAs are deliberately kept out of a third-party
     * app's default chain, and the browser ships its own store — which is exactly why "it opens
     * fine in Chrome" does not imply "this app trusts it". An operator's private root installed
     * for an internal reverse proxy is that case, and this is the only way the app can honour it.
     *
     * Purely additive: every anchor here is one the system already trusted, or one the operator
     * put on the device themselves. Nothing that was untrusted becomes trusted.
     */
    private static X509TrustManager deviceManager() throws Exception {
        KeyStore merged = KeyStore.getInstance(KeyStore.getDefaultType());
        merged.load(null, null);
        int n = 0;
        for (X509Certificate c : defaultManager().getAcceptedIssuers()) {
            merged.setCertificateEntry("system-" + (n++), c);
        }
        try {
            // The platform's own store, including the user: entries the default factory hides.
            KeyStore acs = KeyStore.getInstance("AndroidCAStore");
            acs.load(null, null);
            for (Enumeration<String> aliases = acs.aliases(); aliases.hasMoreElements(); ) {
                String alias = aliases.nextElement();
                java.security.cert.Certificate c = acs.getCertificate(alias);
                if (c instanceof X509Certificate) merged.setCertificateEntry("user-" + (n++), (X509Certificate) c);
            }
        } catch (Exception e) {
            // Not an Android runtime (the unit tests run on a JVM), where there is no such store
            // and the system roots above are the whole trust source. Not an error.
            NotifyService.log("AndroidCAStore 不可用（非 Android 运行时），仅用系统信任链：" + e.getMessage());
        }
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(merged);
        for (TrustManager tm : tmf.getTrustManagers()) {
            if (tm instanceof X509TrustManager) return (X509TrustManager) tm;
        }
        throw new IllegalStateException("no device X509TrustManager");
    }

    private static SSLSocketFactory pinnedFactory(Context context) throws Exception {
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{composite(context)}, new java.security.SecureRandom());
        return ctx.getSocketFactory();
    }

    private static X509TrustManager defaultManager() throws Exception {
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init((KeyStore) null);
        for (TrustManager tm : tmf.getTrustManagers()) {
            if (tm instanceof X509TrustManager) return (X509TrustManager) tm;
        }
        throw new IllegalStateException("no system X509TrustManager");
    }

    private static X509TrustManager manager(X509Certificate ca) throws Exception {
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        ks.setCertificateEntry("agentus-root", ca);
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(ks);
        for (TrustManager tm : tmf.getTrustManagers()) {
            if (tm instanceof X509TrustManager) return (X509TrustManager) tm;
        }
        throw new IllegalStateException("no X509TrustManager for the bundled CA");
    }

    static X509Certificate bundled(Context context) throws Exception {
        try (InputStream in = context.getResources().openRawResource(R.raw.agentus_ca)) {
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            return (X509Certificate) cf.generateCertificate(in);
        }
    }

    /** POST a JSON body; returns the response body as a string (throws on non-2xx). */
    static String postJson(Context context, String url, String token, String body) throws Exception {
        Request.Builder rb = new Request.Builder().url(url).post(RequestBody.create(body, JSON));
        if (token != null) rb.header("authorization", "Bearer " + token);
        try (Response r = client(context).newCall(rb.build()).execute()) {
            String text = r.body() != null ? r.body().string() : "";
            if (!r.isSuccessful()) throw new IllegalStateException("HTTP " + r.code() + " " + text);
            return text;
        }
    }

    /** GET with the app's trust rules; the caller owns the response and must close it. Used for
     *  downloads, where the system downloader would refuse the operator's self-signed cockpit. */
    static Response get(Context context, String url, String cookie, String token) throws Exception {
        Request.Builder rb = new Request.Builder().url(url).get();
        if (cookie != null && !cookie.isEmpty()) rb.header("cookie", cookie);
        if (token != null && !token.isEmpty()) rb.header("authorization", "Bearer " + token);
        return client(context).newCall(rb.build()).execute();
    }

    static WebSocket openSocket(Context context, String url, WebSocketListener listener) {
        Request req = new Request.Builder().url(url).build();
        return client(context).newWebSocket(req, listener);
    }
}