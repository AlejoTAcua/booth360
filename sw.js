// Service worker: la app funciona sin conexión una vez cargada.
// Abre desde la caché al instante (aunque el Wi-Fi del salón no tenga internet) y se actualiza por detrás:
// la versión nueva se usa la próxima vez que se abre. Para publicar cambios, subí VERSION.
const VERSION = 'booth360-v5';
const SHELL = [
  './', './index.html', './css/app.css', './css/fonts.css', './manifest.webmanifest',
  './js/app.js', './js/capture.js', './js/render.js', './js/effects.js', './js/overlay.js', './js/audio.js', './js/db.js', './js/settings.js', './js/beats.js',
  './vendor/mediabunny.min.mjs', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-180.png',
  './fonts/great-vibes-latin-400-normal.woff2',
  './fonts/dancing-script-latin-400-normal.woff2',
  './fonts/dancing-script-latin-700-normal.woff2',
  './fonts/pacifico-latin-400-normal.woff2',
  './fonts/playfair-display-latin-400-normal.woff2',
  './fonts/playfair-display-latin-700-normal.woff2',
  './fonts/bebas-neue-latin-400-normal.woff2',
  './fonts/montserrat-latin-400-normal.woff2',
  './fonts/montserrat-latin-700-normal.woff2',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    const refresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || Response.error();
  })());
});
