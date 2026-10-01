// AgentSlot service worker — app-shell strategy, staleness-safe.
// Rules:
//  - HTML/navigation: NETWORK FIRST (avoid stale bundles), offline => cached shell.
//  - hashed assets (/assets/): CACHE FIRST (immutable by content hash).
//  - other static (icons/manifest): cache-first with network fill.
//  - /api /ws /healthz: NEVER touch (live agent state must always be live).
const SHELL = "agentslot-shell-v2";

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
