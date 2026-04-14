/**
 * OmniSense Lab — Service Worker（離線快取）
 * 對應釋出：0.4.3 · 版本規則：docs/VERSIONING.md
 */
const CACHE_NAME = 'omnisense-lab-web-v0.4.4';
const ASSETS_TO_CACHE = [
  './index.html',
  './manifest.json',
  './sw.js',
  './shell.js',
  './hardwarePreset.js',
  './projects.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('OmniSense SW: addAll 部分失敗', err);
        return cache.add('./index.html').catch(() => {});
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  const pathname = new URL(url).pathname;
  const isLocalBundle = pathname.includes('/__omni_local__/');
  const isHtml =
    event.request.mode === 'navigate' ||
    /\/index\.html(\?|$)/.test(url) ||
    url.endsWith('/') ||
    (event.request.headers.get('accept') || '').includes('text/html');

  if (isLocalBundle) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).catch(() => new Response('Local bundle asset not found', { status: 404 }));
      })
    );
    return;
  }

  if (isHtml) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match('./index.html') || caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
