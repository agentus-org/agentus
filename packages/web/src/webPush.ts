// 网页推送（Web Push）的浏览器侧 — 「关屏也能收」的那一半。
//
// 为什么不是 webNotify.ts 再加一个函数：那个文件管的是「页面还活着时怎么画通知」，而这里的
// 通知**根本不需要页面活着** —— 它由 service worker 画，页面可能早就被系统冻结了。两件事的
// 生命周期、失败方式、前置条件都不一样，混在一个模块里只会让「为什么没弹」更难查。
//
// 前置条件（缺一个就 subscribe 不了，且每个的报错长得完全不同）：
//   1. 安全上下文 —— https 或 localhost。局域网 http://192.168.x.x 没有 PushManager；
//   2. 通知权限 granted（必须由一次点击触发，浏览器不允许自动要）；
//   3. 已注册 service worker（index.html 在 load 时注册）；
//   4. iOS/iPadOS 16.4+，并且页面是「添加到主屏幕」后的独立窗口 —— Safari 的普通标签页不给
//      Web Push，`window.matchMedia('(display-mode: standalone)')` 能看出是不是主屏窗口。

export type PushAvailability =
  | "ok"
  | "insecure"      // 不是 https/localhost
  | "no-push"       // 这个引擎没有 PushManager（旧 Safari、WebView 壳）
  | "ios-needs-home" // iOS 但不在主屏窗口里
  | "no-sw";        // service worker 注册失败

export interface PushSubView {
  host: string;
  tail: string;
  ua?: string;
  createdAt: number;
  lastOkAt?: number;
  fails: number;
  lastError?: string;
}

export interface PushStatus {
  availability: PushAvailability;
  permission: NotificationPermission | "n/a";
  /** This browser has a live subscription right now. */
  subscribed: boolean;
  /** Subscriptions the SERVER knows about (all devices). */
  subs: PushSubView[];
}

/** iOS/iPadOS 的 Web Push 只在主屏窗口里可用。iPadOS 13+ 自称 Mac，所以要靠 maxTouchPoints 一起认。 */
function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const iPadAsMac = /Macintosh/.test(ua) && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 1;
  return iOS || iPadAsMac;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mm = window.matchMedia?.("(display-mode: standalone)").matches;
  // iOS 的旧标记：Safari 加桌面后 window.navigator.standalone === true
  const nav = navigator as Navigator & { standalone?: boolean };
  return Boolean(mm || nav.standalone);
}

function availability(): PushAvailability {
  if (typeof window === "undefined") return "no-sw";
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator)) return "no-sw";
  if (!("PushManager" in window) || !("Notification" in window)) {
    return isIos() ? "ios-needs-home" : "no-push";
  }
  if (isIos() && !isStandalone()) return "ios-needs-home";
  return "ok";
}

/** base64url → Uint8Array. `applicationServerKey` wants raw bytes; the server hands out base64url
 *  because that is what a JSON API can carry. */
function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  // 显式绑一个 ArrayBuffer：TS 5.7 起 Uint8Array<ArrayBufferLike> 不能当 BufferSource 用。
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/notify/webpush${path}`, { credentials: "same-origin", ...init });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

async function reg(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.ready);
  } catch {
    return null;
  }
}

export const webPush = {
  availability,

  async status(): Promise<PushStatus> {
    const permission = typeof Notification === "undefined" ? "n/a" : Notification.permission;
    let subscribed = false;
    const r = await reg();
    if (r) {
      try {
        subscribed = Boolean(await r.pushManager.getSubscription());
      } catch { /* some engines throw when push is blocked by policy */ }
    }
    let subs: PushSubView[] = [];
    try {
      subs = (await api<{ subs: PushSubView[] }>("", { method: "GET" })).subs ?? [];
    } catch { /* logged out or the route failed: the local half still tells the truth */ }
    return { availability: availability(), permission, subscribed, subs };
  },

  /** Ask for permission, subscribe, and hand the subscription to the server. All three or nothing:
   *  a local subscription the server does not know about is a device that will never be pushed to. */
  async enable(): Promise<{ ok: boolean; error?: string; subs?: PushSubView[] }> {
    if (availability() !== "ok") return { ok: false, error: AVAILABILITY_HINT[availability()] };
    if (Notification.permission !== "granted") {
      const got = await Notification.requestPermission();
      if (got !== "granted") return { ok: false, error: "浏览器没有给通知权限" };
    }
    const r = await reg();
    if (!r) return { ok: false, error: "service worker 没注册成功 —— 刷新一次再试（必须是 https 或 localhost）" };
    const { publicKey } = await api<{ publicKey: string }>("", { method: "GET" });
    let sub = await r.pushManager.getSubscription();
    if (!sub) {
      sub = await r.pushManager.subscribe({
        // Apple 与 Chrome 都要求 true：每条推送都必须由用户看得见，不允许静默推。
        userVisibleOnly: true,
        applicationServerKey: decodeKey(publicKey),
      });
    }
    const json = sub.toJSON();
    const out = await api<{ subs: PushSubView[] }>("/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, ua: navigator.userAgent }),
    });
    return { ok: true, subs: out.subs };
  },

  /** Unsubscribe locally AND tell the server: leaving the row behind would have the server push to a
   *  dead endpoint on every notification (and log a failure each time). */
  async disable(): Promise<{ ok: boolean; subs?: PushSubView[] }> {
    const r = await reg();
    const sub = r ? await r.pushManager.getSubscription() : null;
    if (sub) {
      const endpoint = sub.endpoint;
      try { await sub.unsubscribe(); } catch { /* already gone */ }
      try {
        const out = await api<{ subs: PushSubView[] }>("/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
        return { ok: true, subs: out.subs };
      } catch { return { ok: true }; }
    }
    return { ok: true };
  },

  /** Server-side test push to every subscribed device — the only test that exercises APNs/FCM,
   *  the worker and the lock screen. A page-local `new Notification()` proves none of that. */
  async test(): Promise<{ ok: boolean; error?: string; sent: number }> {
    try {
      const out = await api<{ ok: boolean; results: { ok: boolean; status: number; error?: string }[] }>("/test", { method: "POST" });
      return { ok: out.ok, sent: out.results.length, error: out.results.find((r) => !r.ok)?.error };
    } catch (e) {
      return { ok: false, sent: 0, error: (e as Error).message };
    }
  },
};

export const AVAILABILITY_HINT: Record<PushAvailability, string> = {
  ok: "",
  insecure: "需要 https 或 localhost 打开才能订阅推送（局域网明文地址不行）。",
  "no-push": "这个浏览器没有 Push API —— 页面通知还能用，但关屏收不到。",
  "ios-needs-home": "iPhone/iPad 上先「分享 → 添加到主屏幕」，再从主屏幕打开这个页面来开启（Safari 标签页不给推送权限）。",
  "no-sw": "service worker 没注册成功，刷新一次再试。",
};
