// Agentus service worker — app-shell strategy, staleness-safe.
// Rules:
//  - HTML/navigation: NETWORK FIRST (avoid stale bundles), offline => cached shell.
//  - hashed assets (/assets/): CACHE FIRST (immutable by content hash).
//  - other static (icons/manifest): cache-first with network fill.
//  - /api /ws /healthz: NEVER touch (live agent state must always be live).
const SHELL = "agentus-shell-v2";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(["/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.pathname.startsWith("/api") || url.pathname === "/ws" || url.pathname === "/healthz") return;

  const nav = e.request.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html");
  if (nav) {
    // network first, fall back to cached shell
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }

  // assets: cache first (content-hashed), then network-fill
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
            return res;
          })
          .catch(() => hit),
    ),
  );
});

// Notification clicks (the browser channel of the notify feature).
//
// The worker draws the card — it is the only thing that can on a phone browser, and `new Notification()`
// in a page throws there — so it also receives the click, and it CANNOT select a session: a service
// worker has no cockpit. So it hands the target to a tab that does.
//
// Focus first, then ask that tab to switch sessions IN PLACE (`state.ts`'s opener) — a reload would
// throw away whatever the operator had half-typed. `openWindow` is only for the case where no tab is
// left, and it lands on the same `?session=<id>` the phone's tap target uses, so there is one owner of
// "open the session that notified me".
self.addEventListener("notificationclick", (e) => {
  const data = e.notification.data || {};
  const open = typeof data.open === "string" && data.open ? data.open : null;
  e.notification.close();
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const mine = all.filter((c) => {
        try {
          return new URL(c.url).origin === self.location.origin;
        } catch {
          return false;
        }
      });
      if (mine.length) {
        const client = mine[0];
        try {
          await client.focus();
        } catch {
          /* some engines refuse focus outside a gesture; the message still lands */
        }
        for (const c of mine) c.postMessage({ t: "agentus:notify-open", open });
        return;
      }
      if (open) await self.clients.openWindow(open);
    })(),
  );
});
