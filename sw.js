/* Audit Scan offline cache. Bump VERSION on every release so phones pick up the update. */
const VERSION = "1.3.2";
const CACHE = "audit-scan-" + VERSION;
const APP = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "db.js",
  "pdf.js",
  "cv-worker.js",
  "flatten.js",
  "ml-worker.js",
  "live-worker.js",
  "manifest.webmanifest",
  "fonts/atkinson-hyperlegible-latin-400-normal.woff2",
  "fonts/atkinson-hyperlegible-latin-700-normal.woff2",
  "fonts/barlow-condensed-latin-600-normal.woff2",
  "fonts/barlow-condensed-latin-700-normal.woff2",
  "fonts/ibm-plex-mono-latin-500-normal.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];
// Large, versioned files that never change in place; the browser's own cache copy is fine.
const ENGINE = [
  "vendor/opencv.js",
  "vendor/ml/ort.min.js",
  "vendor/ml/ort-wasm-simd-threaded.mjs",
  "vendor/ml/ort-wasm-simd-threaded.wasm",
  "vendor/ml/doccornernet_lean.ort",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP.map((u) => new Request(u, { cache: "reload" })));
    await cache.addAll(ENGINE);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("audit-scan-") && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

// GitHub Pages can't send the headers that let the page finder use several CPU cores
// (cross-origin isolation), so the worker adds them to every file it serves. The app loads
// nothing from other sites, so nothing is blocked by them.
function isolated(res) {
  if (!res || res.status === 0 || res.type === "opaque" || res.type === "opaqueredirect") return res;
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return isolated(hit);
    try {
      return isolated(await fetch(req));
    } catch (err) {
      if (req.mode === "navigate") {
        const shell = await cache.match("index.html");
        if (shell) return isolated(shell);
      }
      throw err;
    }
  })());
});
