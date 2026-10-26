// Service worker: keeps the app shell, resort packs and every map tile it has
// seen, so the map keeps working where the mountain has no signal.
const VERSION = 'v6';
const SHELL = `fl-shell-${VERSION}`;
const DATA = 'fl-data';
const TILES = 'fl-tiles';
const OFFLINE = 'fl-offline';
const MAX_TILES = 6000;

const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/style.js', 'js/terrain.js', 'js/terrain-client.js', 'js/terrain-worker.js',
  'js/pistes.js', 'js/info.js', 'js/gpx.js', 'js/sun.js', 'js/i18n.js', 'js/format.js', 'js/offline.js',
  'js/sentinel.js', 'js/recent.js',
  'vendor/maplibre-gl/maplibre-gl.mjs', 'vendor/maplibre-gl/maplibre-gl-worker.mjs', 'vendor/maplibre-gl/maplibre-gl.css',
  'vendor/maplibre-contour/maplibre-contour.mjs',
  'data/resorts.json', 'data/skiareas.json', 'icons/icon.svg', 'icons/icon-192.png',
];

const TILE_HOSTS = [
  'tiles.mapterhorn.com', 'server.arcgisonline.com', 'tile.opentopomap.org',
  'tiles.openfreemap.org', 'overpass-api.de', 'maps.mail.ru', 'overpass.private.coffee',
  'fonts.googleapis.com', 'fonts.gstatic.com',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so a deploy is picked up whole.
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('fl-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

let trimTimer = 0;
function trimSoon() {
  clearTimeout(trimTimer);
  trimTimer = setTimeout(async () => {
    const c = await caches.open(TILES);
    const keys = await c.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await c.delete(k);
  }, 10000);
}

// Tiles: anything saved or seen before is served from cache; otherwise fetch
// and remember it. Mapterhorn's 404s are kept too: they mean "no finer data here".
async function tile(req) {
  const hit = (await caches.match(req, { cacheName: OFFLINE, ignoreVary: true })) || (await caches.match(req, { cacheName: TILES, ignoreVary: true }));
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || (res.status === 404 && req.url.includes('mapterhorn'))) {
    const copy = res.clone();
    caches.open(TILES).then((c) => c.put(req, copy)).then(trimSoon);
  }
  return res;
}

// App files: answer from cache at once and refresh it in the background.
async function shell(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  if (hit) {
    net.catch(() => {});
    return hit;
  }
  return net;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      // Pages: network first so a deploy shows up on the next visit.
      e.respondWith(fetch(req).then((res) => {
        caches.open(SHELL).then((c) => c.put('index.html', res.clone()));
        return res;
      }).catch(() => caches.match('index.html', { cacheName: SHELL })));
    } else if (url.pathname.includes('/data/packs/')) {
      e.respondWith(shell(req, DATA));
    } else {
      e.respondWith(shell(req, SHELL));
    }
    return;
  }
  if (TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) e.respondWith(tile(req));
});

// "Save this area": fetch a list of URLs into the offline cache, six at a time.
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'save') return;
  const port = e.ports[0];
  const urls = e.data.urls;
  e.waitUntil((async () => {
    const cache = await caches.open(OFFLINE);
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const u = urls[next++];
        try {
          if (!(await cache.match(u, { ignoreVary: true }))) {
            const res = (await caches.match(u, { cacheName: TILES, ignoreVary: true })) || (await fetch(u, { mode: 'cors' }));
            if (res.ok || res.status === 404) await cache.put(u, res.clone());
          }
        } catch {}
        done++;
        if (done % 10 === 0 || done === urls.length) port.postMessage({ done, total: urls.length });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  })());
});
