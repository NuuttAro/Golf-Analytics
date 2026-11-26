// Network-first for the app shell, cache fallback so the app opens offline on the course.
const CACHE = 'carry-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'js/app.js', 'js/store.js', 'js/sg.js', 'js/caddie.js', 'js/course.js', 'js/seed.js', 'js/cloud.js', 'icon.svg', 'icon-180.png', 'manifest.webmanifest'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  const sameOrigin = url.origin === location.origin;
  const isLib = /cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host);
  if (!sameOrigin && !isLib) return; // tiles, OSM: straight to network
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request)));
});
