const prefix = 'clearbill-';
const cacheName = `${prefix}2026q4-v1`;
const root = self.registration.scope;
const paths = [
  'index.html', 'styles.css', 'favicon.svg', 'src/app.js', 'src/data.js', 'src/fixtures.js',
  'src/engine.js', 'src/exchange.js', 'src/worksheet.js',
];
const urls = new Set(paths.map(path => new URL(path, root).href));
const index = new URL('index.html', root).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll([...urls].map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(prefix) && name !== cacheName) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const navigation = request.mode === 'navigate' && (url.href === root || url.href === index);
  if (!navigation && !urls.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return await cache.match(navigation ? index : request) || fetch(request);
  })());
});
