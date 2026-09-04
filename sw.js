const CACHE = "emberpage-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./vendor/jszip.min.js",
  "./fonts/fonts-local.css",
  "./fonts/fraunces-italic-500.woff2",
  "./fonts/fraunces-normal-400.woff2",
  "./fonts/fraunces-normal-600.woff2",
  "./fonts/fraunces-normal-700.woff2",
  "./fonts/literata-italic-400.woff2",
  "./fonts/literata-normal-400.woff2",
  "./fonts/literata-normal-500.woff2",
  "./fonts/literata-normal-600.woff2",
  "./fonts/manrope-normal-500.woff2",
  "./fonts/manrope-normal-600.woff2",
  "./fonts/manrope-normal-700.woff2",
  "./fonts/manrope-normal-800.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((resp) => {
          if (resp && resp.ok && req.url.indexOf(self.location.origin) === 0) {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => {
          if (req.mode === "navigate") return caches.match("./index.html");
          return new Response("", { status: 504, statusText: "Offline" });
        });
    })
  );
});
