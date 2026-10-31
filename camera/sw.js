// Service Worker: App offline verfügbar machen. Netzwerk zuerst (damit
// Aktualisierungen sofort ankommen), bei Funkloch aus dem Zwischenspeicher.

const CACHE = 'filmkamera-v1';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/camera.css',
  'js/main.js',
  'js/films.js',
  'js/model.js',
  'js/gl.js',
  'js/camera.js',
  'js/store.js',
  'js/develop.js',
  'js/icons.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await Promise.race([
          fetch(req, { cache: 'no-cache' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
        ]);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        return fetch(req);
      }
    })(),
  );
});
