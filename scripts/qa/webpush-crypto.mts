// Web Push 的密码学守卫：没有它，推送只会「静默不显示」。
//
// 这条链路上没有任何环节会报错 —— 加密错了，push service 照样 201，浏览器只是丢包，锁屏一片安静。
// 所以它必须有确定性证据，而不是「在我机器上好像能收」：
//
//   1. RFC 8291 §5 的官方测试向量（连 Appendix A 的中间值一起对），逐字节比对最终 body；
//   2. 反向解密（按 RFC 写的接收方逻辑，不复用被测代码）：header 布局、0x02 分隔符、GCM tag；
//   3. VAPID JWT：ES256 用公钥验签、aud 必须是该 endpoint 的 origin；
//   4. 打到一个本地假 push service：看真实请求头 + 把收到的 body 解回原文，404/410 撤订阅。
//
//   npx tsx scripts/qa/webpush-crypto.mts
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebPushService, b64u, encryptPush, unb64u } from "../../packages/server/src/notify/webpush.js";
import { NotifyCenter } from "../../packages/server/src/notify/center.js";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, what: string, extra = ""): void => {
  if (cond) { pass++; console.log(`  ✓ ${what}`); }
  else { fail++; console.log(`  ✗ ${what}${extra ? `  — ${extra}` : ""}`); }
};
const eq = (got: unknown, want: unknown, what: string): void => ok(got === want, what, `got ${String(got)} want ${String(want)}`);

// ---- 1. RFC 8291 §5 ----------------------------------------------------------
console.log("\nRFC 8291 §5 测试向量");

const V = {
  plaintext: Buffer.from("When I grow up, I want to be a watermelon", "utf8"),
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  // Appendix A 给的是「header（86 字节）」与「ciphertext（58 字节）」两段各自的 base64url。
  // §5 正文里那串 144 字节的 body 是这两段**分别编码后并列**印出来的（RFC 纯文本里还做了
  // 换行与 \_ 转义），所以它不能直接当「一份 base64」解回来 —— 按附录两段各自解码再拼接，
  // 才是线上的真实 body。第一版测试就是照 §5 那串字面量比的，结果差在 ct 首字节（0x32 vs 0xf2），
  // 而 0xf2 正是附录 A 的 ciphertext 首字节。
  ct: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
  // Appendix A
  ecdh: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  prkKey: "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  prk: "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
};

const uaPoint = unb64u(V.uaPublic);
const asPoint = unb64u(V.asPublic);
const jwkOf = (point: Buffer, priv?: string) => ({
  kty: "EC", crv: "P-256",
  x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)),
  ...(priv ? { d: priv } : {}),
});
const asPrivate = crypto.createPrivateKey({ key: jwkOf(asPoint, V.asPrivate), format: "jwk" });
const asPublic = crypto.createPublicKey({ key: jwkOf(asPoint), format: "jwk" });
const uaPrivate = crypto.createPrivateKey({ key: jwkOf(uaPoint, V.uaPrivate), format: "jwk" });

// 中间值也验一遍：body 对了但推导顺序巧合相同的可能性不予考虑，但中间值能一眼指出错在哪一步。
const ecdh = crypto.diffieHellman({ privateKey: asPrivate, publicKey: crypto.createPublicKey({ key: jwkOf(uaPoint), format: "jwk" }) });
eq(b64u(ecdh), V.ecdh, "ecdh_secret");
const prkKey = Buffer.from(crypto.hkdfSync("sha256", ecdh, unb64u(V.auth), Buffer.from("WebPush: info\0", "utf8").subarray(0, 0), 32));
const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), uaPoint, asPoint]);
const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdh, unb64u(V.auth), keyInfo, 32));
eq(b64u(ikm), V.ikm, "IKM");
void prkKey;

const got = encryptPush(uaPoint, unb64u(V.auth), V.plaintext, { salt: unb64u(V.salt), asKeys: [asPrivate, asPublic] });
const ct = unb64u(V.ct);
eq(b64u(got.subarray(86)), V.ct, "ciphertext 与附录 A 逐字节相同");
// 期望值自己拼（不拿 got 的 header 拼，否则这条断言同义反复）：
// salt ‖ rs(u32 BE) ‖ idlen ‖ AS 公钥 ‖ ciphertext
const rsBytes = Buffer.alloc(4);
rsBytes.writeUInt32BE(4096, 0);
const expected = Buffer.concat([unb64u(V.salt), rsBytes, Buffer.from([65]), asPoint, ct]);
eq(b64u(got), b64u(expected), "body = salt ‖ rs ‖ idlen ‖ as_public ‖ ciphertext（附录 A 拼接）");
eq(got.length, 86 + ct.length, "body 长度 86 + 58 = 144");

// ---- 2. 反向解密（接收方逻辑，独立实现） --------------------------------------
console.log("\n反向解密（接收方视角）");

/** RFC 8188/8291 的接收方：拆 header → ECDH(ua_private, as_public) → 同一套 HKDF → AES-GCM → 去掉 0x02。 */
function decryptAsBrowser(body: Buffer, uaPriv: crypto.KeyObject, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  eq(idlen, 65, "header idlen = 65（uncompressed point）");
  eq(body.subarray(16, 20).readUInt32BE(0), 4096, "header rs = 4096");
  const secret = crypto.diffieHellman({ privateKey: uaPriv, publicKey: crypto.createPublicKey({ key: jwkOf(asPub), format: "jwk" }) });
  const uaPub = Buffer.from(crypto.createPublicKey(uaPriv).export({ format: "jwk" }).x ?? "", "base64");
  void uaPub;
  const uaPointOwn = Buffer.concat([Buffer.from([4]), unb64u((crypto.createPublicKey(uaPriv).export({ format: "jwk" }) as { x: string }).x), unb64u((crypto.createPublicKey(uaPriv).export({ format: "jwk" }) as { y: string }).y)]);
  const info = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), uaPointOwn, asPub]);
  const ikm2 = Buffer.from(crypto.hkdfSync("sha256", secret, auth, info, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm2, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm2, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));
  const tag = ct.subarray(ct.length - 16);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(tag);
  const rec = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  eq(rec[rec.length - 1], 0x02, "末字节是 0x02 分隔符");
  return rec.subarray(0, rec.length - 1);
}

eq(decryptAsBrowser(got, uaPrivate, unb64u(V.auth)).toString("utf8"), V.plaintext.toString("utf8"), "解密回原文");

// ---- 3. VAPID JWT ------------------------------------------------------------
console.log("\nVAPID（RFC 8292）");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-vapid-"));
const svc = new WebPushService(dir, { subject: "mailto:test@example.com", log: () => {} });
const pub = svc.publicKey();
eq(unb64u(pub).length, 65, "applicationServerKey 是 65 字节 uncompressed point");
eq(unb64u(pub)[0], 4, "首字节 0x04");

const endpoint = "https://push.example.net/push/abc123";
// @ts-expect-error private on purpose: the header is what a push service checks, so the test reads it
const authHeader = svc["vapidAuth"](endpoint) as string;
const m = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader);
ok(Boolean(m), "header 形状是 `vapid t=<jwt>, k=<key>`");
const [h, c, s] = (m?.[1] ?? "").split(".");
const jwtHeader = JSON.parse(unb64u(h).toString("utf8")) as { alg: string; typ: string };
const claims = JSON.parse(unb64u(c).toString("utf8")) as { aud: string; exp: number; sub: string };
eq(jwtHeader.alg, "ES256", "alg=ES256");
eq(claims.aud, "https://push.example.net", "aud = endpoint 的 origin");
ok(claims.exp > Date.now() / 1000, "exp 在未来");
eq(claims.sub, "mailto:test@example.com", "sub 来自配置");
eq(m?.[2], pub, "k 与 publicKey() 一致");
const verifyKey = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(unb64u(pub).subarray(1, 33)), y: b64u(unb64u(pub).subarray(33, 65)) }, format: "jwk" });
ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: verifyKey, dsaEncoding: "ieee-p1363" }, unb64u(s)), "签名可被公钥验证（raw R‖S，不是 DER）");

// ---- 4. 打到本地假 push service ----------------------------------------------
console.log("\n真实发一次（本地假 push service）");

const uaKeys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const uaJwk = uaKeys.publicKey.export({ format: "jwk" }) as { x: string; y: string };
const uaPub = Buffer.concat([Buffer.from([4]), unb64u(uaJwk.x), unb64u(uaJwk.y)]);
const authSecret = crypto.randomBytes(16);

interface Captured { headers: http.IncomingHttpHeaders; body: Buffer }
let captured: Captured | null = null;
let status = 201;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (ch) => chunks.push(Buffer.from(ch)));
  req.on("end", () => {
    captured = { headers: req.headers, body: Buffer.concat(chunks) };
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(status === 201 ? "ok" : "gone");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const reg = svc.subscribe({
  endpoint: `http://127.0.0.1:${port}/push/sub-1`,
  keys: { p256dh: b64u(uaPub), auth: b64u(authSecret) },
  ua: "qa/webpush",
});
ok(!("error" in reg), "subscribe() 接受合法的订阅");
eq(svc.subscriptions().length, 1, "订阅表里有 1 条");

svc.subscribe({ endpoint: `http://127.0.0.1:${port}/push/sub-1`, keys: { p256dh: b64u(uaPub), auth: b64u(authSecret) } });
eq(svc.subscriptions().length, 1, "同一 endpoint 再订阅一次不新增行（浏览器每次加载都会重订）");
ok("error" in svc.subscribe({ endpoint: "not-a-url", keys: { p256dh: b64u(uaPub), auth: b64u(authSecret) } }), "非 http(s) endpoint 被拒");
ok("error" in svc.subscribe({ endpoint: `http://127.0.0.1:${port}/x`, keys: { p256dh: b64u(Buffer.alloc(10)), auth: b64u(authSecret) } }), "p256dh 长度不对被拒");

const payload = { title: "已完成", body: "hello · 用时 3s", open: "/?session=abc" };
const r1 = await svc.send(svc.subscriptions()[0], payload, { ttlSec: 60, urgency: "high" });
ok(r1.ok, "push service 返回 201 时 ok=true", r1.error);
const cap = captured as Captured | null;
ok(Boolean(cap), "假 push service 收到了请求");
if (cap) {
  eq(cap.headers["content-encoding"], "aes128gcm", "content-encoding: aes128gcm");
  eq(cap.headers.ttl, "60", "ttl 透传");
  eq(cap.headers.urgency, "high", "urgency 透传");
  ok(String(cap.headers.authorization ?? "").startsWith("vapid t="), "带 VAPID authorization");
  eq(decryptAsBrowser(cap.body, uaKeys.privateKey, authSecret).toString("utf8"), JSON.stringify(payload), "收到的 body 解出原文");
}

status = 410;
const r2 = await svc.send(svc.subscriptions()[0], payload);
ok(!r2.ok && r2.gone, "410 被识别为「订阅已失效」");
eq(svc.subscriptions().length, 0, "410 之后该订阅被撤掉（不再对死端点重试）");

status = 500;
const dead = svc.subscribe({ endpoint: `http://127.0.0.1:${port}/push/sub-2`, keys: { p256dh: b64u(uaPub), auth: b64u(authSecret) } });
const r3 = await svc.send(dead as never, payload);
ok(!r3.ok && !r3.gone, "500 不算失效");
eq(svc.subscriptions()[0].fails, 1, "失败计数 +1（给界面看，不静默）");

server.close();
fs.rmSync(dir, { recursive: true, force: true });

// ---- 5. 通知中心真的会推，且只推该推的 --------------------------------------
// 这一节测的是「哪条事件该叫醒手机」，不是密码学：运行中永不推、看着的那个会话不推、
// 批准卡撤销要推（否则锁屏上留着一张已经处理过的卡）。
console.log("\n通知中心 → 推送（规则闸门）");

const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-center-"));
const center = new NotifyCenter({ dataDir: dir2, log: () => {} });

interface Pushed { at: number; payload: any; urgency: string }
const pushed: Pushed[] = [];
const uaKeys2 = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const uaJwk2 = uaKeys2.publicKey.export({ format: "jwk" }) as { x: string; y: string };
const uaPub2 = Buffer.concat([Buffer.from([4]), unb64u(uaJwk2.x), unb64u(uaJwk2.y)]);
const auth2 = crypto.randomBytes(16);
const rx = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.from(c)));
  req.on("end", () => {
    try {
      pushed.push({
        at: Date.now(),
        payload: JSON.parse(decryptAsBrowser(Buffer.concat(chunks), uaKeys2.privateKey, auth2).toString("utf8")),
        urgency: String(req.headers.urgency ?? ""),
      });
    } catch { /* 解不开就当作没收到：这条本身就是失败证据 */ }
    res.writeHead(201);
    res.end();
  });
});
await new Promise<void>((r) => rx.listen(0, "127.0.0.1", () => r()));
const rxPort = (rx.address() as { port: number }).port;

// 订阅表是私有的；测试直接放一条进去（等价于 POST /api/notify/webpush/subscribe 的结果）
(center as unknown as { push: WebPushService }).push.subscribe({
  endpoint: `http://127.0.0.1:${rxPort}/p`,
  keys: { p256dh: b64u(uaPub2), auth: b64u(auth2) },
});
const settle = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 100)); if (pushed.length) return; }
};
const reset = (): void => { pushed.length = 0; };

center.observe({ t: "turn-start", sessionId: "sA", at: Date.now() } as never);
await new Promise((r) => setTimeout(r, 700));
eq(pushed.length, 0, "「运行中」永不推送（锁屏上那句「还在跑」就是噪音）");

center.observe({ t: "turn-end", sessionId: "sA", at: Date.now(), durationMs: 3200 } as never);
await settle();
eq(pushed.length, 1, "回合结束推一条");
eq(pushed[0]?.payload?.op, "upsert", "是 upsert");
eq(pushed[0]?.payload?.kind, "agent_done", "kind = agent_done");
eq(pushed[0]?.urgency, "normal", "完成用 normal（不叫醒设备）");
eq(pushed[0]?.payload?.open, "/?session=sA", "点通知能回到那条会话");

reset();
center.setPresence("sA", true);
center.observe({ t: "turn-end", sessionId: "sA", at: Date.now() } as never);
await new Promise((r) => setTimeout(r, 700));
eq(pushed.length, 0, "正在看这个会话 ⇒ 不推（推了等于打扰眼前的窗口）");

reset();
center.setPresence(null, false);
center.observe({ t: "permission-resolved", requestId: "req1", sessionId: "sA", at: Date.now() } as never);
await settle();
eq(pushed.length, 1, "批准卡撤销也推一条");
eq(pushed[0]?.payload?.op, "dismiss", "op = dismiss（锁屏上那张卡要收掉）");
eq(pushed[0]?.payload?.noticeId, "perm:req1", "按 noticeId 收卡");
eq(pushed[0]?.urgency, "very-low", "撤卡不叫醒任何设备");

reset();
center.setRules({ web: { enabled: false, turnStart: false, approval: true, completion: true } });
center.observe({ t: "turn-end", sessionId: "sA", at: Date.now() } as never);
await new Promise((r) => setTimeout(r, 700));
eq(pushed.length, 0, "网页通知总开关关掉 ⇒ 一条都不推");

rx.close();
center.close();
fs.rmSync(dir2, { recursive: true, force: true });

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} checks, ${fail} failed`);
process.exit(fail ? 1 : 0);
