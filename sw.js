// Service worker · Chequeos COMFRUT · Creado por Daniel Zunino · Integra Prevención SpA
const V = 'chequeo-comfrut-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(['./', './index.html', './mejoras.js'].map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()).catch(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(Promise.race([fetch(r), new Promise((_, no) => setTimeout(() => no('lento'), 4500))])
    .then(res => { if (res && res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; })
    .catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || caches.match('./index.html'))));
});
