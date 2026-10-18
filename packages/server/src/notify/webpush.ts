// Web Push — the third renderer of the same notification decision.
//
// The three channels and why they exist:
//
//   phone (WS)   — the Android companion holds one long connection; only works while the phone is awake.
//   page         — the open tab draws a notification through the page's own Notification API.
//   push (here)  — the ONLY channel that survives a locked screen: the page is frozen by iOS/Android
//                  the moment it leaves the foreground, and no JS runs to notice anything. A push
//                  service holds the message until the device is reachable, wakes the service worker,
//                  and the worker draws the card. That is why this exists and the page renderer cannot
//                  replace it.
//
// Nothing here decides WHAT is worth notifying — `center.ts` owns that (one decision, three renderers).
// This module only knows how to hand bytes to a push service: encryption (RFC 8291 / aes128gcm) and
// VAPID authorization (RFC 8292).
//
// No dependency on `web-push`: the whole job is ~120 lines of node:crypto, and a dependency here would
// mean an npm install on a machine whose registry access is already the flakiest part of a release.
// The RFC's own test vector is checked by `scripts/qa/webpush-crypto.mts` — see the note at encryptPush().
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

/** One browser's subscription, as `pushManager.subscribe()` returned it. */
export interface PushSubscriptionRecord {
  endpoint: string;
  /** base64url of the UA's uncompressed P-256 point (65 bytes) — the `keys.p256dh` the browser gave us. */
  p256dh: string;
  /** base64url of the 16-byte auth secret — `keys.auth`. */
  auth: string;
  ua?: string;
  createdAt: number;
  /** Last time a push was accepted by the push service (HTTP 201). */
  lastOkAt?: number;
  fails: number;
  lastError?: string;
}

interface VapidFile {
  /** base64url uncompressed point (65 bytes) — what the browser needs as applicationServerKey. */
  publicKey: string;
  /** The private half, kept as a JWK because that is what createPrivateKey() eats. */
  jwk: { kty: string; crv: string; x: string; y: string; d: string };
  subject: string;
}

interface SubscriptionFile {
  subs: PushSubscriptionRecord[];
}

// ---- base64url ----------------------------------------------------------------

export const b64u = (buf: Buffer): string => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const unb64u = (str: string): Buffer => Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// ---- RFC 8291: encrypting one push message ------------------------------------

/** The message body a push service carries for us: `aes128gcm` single record (RFC 8188 §2, RFC 8291 §4).
 *
 *  Layout of the body: 16-byte salt ‖ rs (u32 BE = 4096) ‖ idlen (u8 = 65) ‖ AS public key ‖ ciphertext.
 *  The plaintext gets the padding delimiter 0x02 appended, because it is the last (only) record.
 *
 *  `opts` exists ONLY so the RFC 8291 §5 test vector can be reproduced byte-for-byte: it pins the salt
 *  and the application-server keypair. Production calls always pass no salt and a fresh keypair — the
 *  whole security property rests on both being random per message.
 *
 *  Verified against that vector (Appendix A gives every intermediate: ecdh_secret, PRK_key, IKM, PRK,
 *  CEK, NONCE, and the final body). If this function and the vector disagree, the push is silently
 *  undecryptable by the browser and nothing else in the system would tell us — hence a test, not hope. */
export function encryptPush(
  uaPublicRaw: Buffer,
  authSecret: Buffer,
  plaintext: Buffer,
  opts: { salt?: Buffer; asKeys?: crypto.KeyObject[] } = {},
): Buffer {
  const salt = opts.salt ?? crypto.randomBytes(16);
  const pair = opts.asKeys ?? (() => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    return [privateKey, publicKey];
  })();
  const [asPrivate, asPublic] = pair;

  const uaPublic = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64u(uaPublicRaw.subarray(1, 33)), y: b64u(uaPublicRaw.subarray(33, 65)) },
    format: "jwk",
  });
  const ecdhSecret = crypto.diffieHellman({ privateKey: asPrivate, publicKey: uaPublic });
  const asPoint = pointFromJwk(asPublic.export({ format: "jwk" }) as { x: string; y: string });

  // IKM = HKDF-Extract(auth_secret, ecdh_secret) then Expand with "WebPush: info\0" ‖ ua ‖ as.
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), uaPublicRaw, asPoint]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));

  // CEK/NONCE come from RFC 8188's HKDF with the per-message salt.
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));

  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPoint.length]), asPoint, ct]);
}

function pointFromJwk(jwk: { x: string; y: string }): Buffer {
  return Buffer.concat([Buffer.from([0x04]), unb64u(jwk.x), unb64u(jwk.y)]);
}

// ---- VAPID + delivery ---------------------------------------------------------

export interface SendResult { ok: boolean; status: number; error?: string; gone?: boolean }

export class WebPushService {
  private readonly dir: string;
  private readonly subject: string;
  private readonly log: (line: string) => void;
  private vapidCache: VapidFile | null = null;
  private subsCache: PushSubscriptionRecord[] | null = null;

  constructor(dataDir: string, opts: { subject?: string; log?: (line: string) => void } = {}) {
    this.dir = path.join(dataDir, "notify");
    this.subject = opts.subject ?? process.env.AGENTUS_VAPID_SUBJECT ?? "mailto:agentus@localhost";
    this.log = opts.log ?? ((l) => console.log(l));
  }

  private get vapidFile(): string { return path.join(this.dir, "vapid.json"); }
  private get subsFile(): string { return path.join(this.dir, "webpush.json"); }

  /** The server's identity to push services. Generated on first use and then never rotated by itself:
   *  rotating the VAPID key invalidates every existing subscription, so that must stay a deliberate act. */
  private vapid(): VapidFile {
    if (this.vapidCache) return this.vapidCache;
    try {
      this.vapidCache = JSON.parse(fs.readFileSync(this.vapidFile, "utf8")) as VapidFile;
      return this.vapidCache;
    } catch { /* first boot */ }
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = privateKey.export({ format: "jwk" }) as VapidFile["jwk"];
    const record: VapidFile = { publicKey: b64u(pointFromJwk(jwk)), jwk, subject: this.subject };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.vapidFile, JSON.stringify(record, null, 1), { mode: 0o600 });
    this.log(`[notify] generated a VAPID keypair (${this.vapidFile}) — back it up with the rest of <data>`);
    this.vapidCache = record;
    return record;
  }

  /** `applicationServerKey` for `pushManager.subscribe()`. */
  publicKey(): string { return this.vapid().publicKey; }

  subscriptions(): PushSubscriptionRecord[] {
    if (this.subsCache) return this.subsCache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.subsFile, "utf8")) as SubscriptionFile;
      this.subsCache = Array.isArray(raw.subs) ? raw.subs : [];
    } catch {
      this.subsCache = [];
    }
    return this.subsCache;
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.subsFile, JSON.stringify({ subs: this.subsCache ?? [] }, null, 1), { mode: 0o600 });
  }

  /** Idempotent by endpoint: re-subscribing the same browser replaces its keys instead of piling up rows.
   *  A browser re-subscribes on every page load in some engines, so this must not grow. */
  subscribe(input: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; ua?: unknown }): PushSubscriptionRecord | { error: string } {
    const endpoint = typeof input.endpoint === "string" ? input.endpoint : "";
    const p256dh = typeof input.keys?.p256dh === "string" ? input.keys.p256dh : "";
    const auth = typeof input.keys?.auth === "string" ? input.keys.auth : "";
    if (!/^https?:\/\//.test(endpoint)) return { error: "endpoint must be an https URL from the browser" };
    if (unb64u(p256dh).length !== 65) return { error: "keys.p256dh must be an uncompressed P-256 point (65 bytes)" };
    if (unb64u(auth).length !== 16) return { error: "keys.auth must be 16 bytes" };
    const subs = this.subscriptions();
    const prior = subs.find((s) => s.endpoint === endpoint);
    const rec: PushSubscriptionRecord = {
      endpoint, p256dh, auth,
      ua: typeof input.ua === "string" ? input.ua.slice(0, 200) : undefined,
      createdAt: prior?.createdAt ?? Date.now(),
      lastOkAt: prior?.lastOkAt,
      fails: 0,
    };
    this.subsCache = [...subs.filter((s) => s.endpoint !== endpoint), rec];
    this.save();
    return rec;
  }

  unsubscribe(endpoint: string): boolean {
    const subs = this.subscriptions();
    const next = subs.filter((s) => s.endpoint !== endpoint);
    if (next.length === subs.length) return false;
    this.subsCache = next;
    this.save();
    return true;
  }

  /** ES256 JWT over the endpoint's own origin (RFC 8292 §2). `aud` is per-endpoint on purpose: a token
   *  minted for one push service must not be replayable at another. */
  private vapidAuth(endpoint: string, now = Date.now()): string {
    const { publicKey, jwk } = this.vapid();
    const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64u(Buffer.from(JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now / 1000) + 12 * 3600,
      sub: this.subject,
    })));
    const signingInput = `${header}.${claims}`;
    const key = crypto.createPrivateKey({ key: jwk, format: "jwk" });
    // ieee-p1363 = raw R‖S; JWS wants exactly that, DER would be rejected.
    const sig = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
    return `vapid t=${signingInput}.${b64u(sig)}, k=${publicKey}`;
  }

  /** Hand one message to one push service. `urgency` maps to the RFC 8030 header the platforms honour:
   *  a lock-screen approval is `high` (deliver immediately, wake the device), a "finished" is `normal`,
   *  and taking a stale card back is `very-low` (do not wake anything for it). */
  async send(
    rec: PushSubscriptionRecord,
    payload: unknown,
    opts: { ttlSec?: number; urgency?: "very-low" | "low" | "normal" | "high"; timeoutMs?: number } = {},
  ): Promise<SendResult> {
    let body: Buffer;
    try {
      body = encryptPush(unb64u(rec.p256dh), unb64u(rec.auth), Buffer.from(JSON.stringify(payload), "utf8"));
    } catch (e) {
      return { ok: false, status: 0, error: `encrypt: ${(e as Error).message}` };
    }
    let auth: string;
    try {
      auth = this.vapidAuth(rec.endpoint);
    } catch (e) {
      return { ok: false, status: 0, error: `vapid: ${(e as Error).message}` };
    }
    const url = new URL(rec.endpoint);
    const mod = url.protocol === "http:" ? http : https;
    return await new Promise<SendResult>((resolve) => {
      const req = mod.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          authorization: auth,
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          "content-length": String(body.length),
          ttl: String(opts.ttlSec ?? 3600),
          urgency: opts.urgency ?? "normal",
        },
        timeout: opts.timeoutMs ?? 8000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          const text = Buffer.concat(chunks).toString("utf8").slice(0, 300);
          const gone = status === 404 || status === 410;
          if (ok) {
            rec.lastOkAt = Date.now();
            rec.fails = 0;
            rec.lastError = undefined;
            this.save();
          } else {
            rec.fails += 1;
            rec.lastError = `${status} ${text}`.trim();
            // 404/410 = the browser threw the subscription away (app uninstalled, permission reset).
            // Keeping it would retry a dead endpoint forever and log a failure on every notification.
            if (gone) this.unsubscribe(rec.endpoint);
            else this.save();
          }
          resolve({ ok, status, error: ok ? undefined : `${status} ${text}`.trim(), gone });
        });
      });
      req.on("timeout", () => { req.destroy(new Error("push service timed out")); });
      req.on("error", (e) => resolve({ ok: false, status: 0, error: e.message }));
      req.end(body);
    });
  }

  /** Send the same payload to every subscription. Returns one result per device so the settings card can
   *  say "2 台设备都收到了" or which one is dead — a silent broadcast would hide a broken device. */
  async broadcast(payload: unknown, opts: { ttlSec?: number; urgency?: "very-low" | "low" | "normal" | "high" } = {}): Promise<SendResult[]> {
    const subs = this.subscriptions();
    if (!subs.length) return [];
    return await Promise.all(subs.map((s) => this.send(s, payload, opts)));
  }
}
