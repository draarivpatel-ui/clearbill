const prefix = 'clearbill-';
const cacheName = `${prefix}2026q4-v5`;
const root = self.registration.scope;
const paths = [
  'index.html', 'styles.css', 'favicon.svg', 'src/app.js', 'src/data.js', 'src/fixtures.js',
  'src/engine.js', 'src/exchange.js', 'src/worksheet.js', 'src/sensitivity-lab.js', 'src/ai-appeal-reasoning.js',
];
const urls = new Set(paths.map(path => new URL(path, root).href));
const assetPaths = new Set(paths.map(path => new URL(path, root).pathname));
const index = new URL('index.html', root).href;
const rootPath = new URL(root).pathname;
const indexPath = new URL(index).pathname;

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
  const navigation = request.mode === 'navigate' && (url.pathname === rootPath || url.pathname === indexPath);
  if (!navigation && !assetPaths.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return await cache.match(navigation ? index : request, { ignoreSearch: true }) || fetch(request);
  })());
});
