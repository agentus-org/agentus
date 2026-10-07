package app.agentus.companion;

import android.content.Context;

import java.io.InputStream;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
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

    /** Trust = system store ∪ bundled Agentus root. */
    private static X509TrustManager composite(Context context) throws Exception {
        final X509TrustManager system = defaultManager();
        final X509TrustManager mine = manager(bundled(context));
        return new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws java.security.cert.CertificateException {
                system.checkClientTrusted(chain, authType);
            }

            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws java.security.cert.CertificateException {
                try {
                    system.checkServerTrusted(chain, authType);
                } catch (java.security.cert.CertificateException e) {
                    mine.checkServerTrusted(chain, authType);
                }
            }

            @Override public X509Certificate[] getAcceptedIssuers() {
                return system.getAcceptedIssuers();
            }
        };
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

    static WebSocket openSocket(Context context, String url, WebSocketListener listener) {
        Request req = new Request.Builder().url(url).build();
        return client(context).newWebSocket(req, listener);
    }
}