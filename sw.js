/* sw.js — v0.2.1: RETE PRIMA per l'app (così gli aggiornamenti arrivano subito), cache solo come fallback offline.
   I dati (data/) idem: rete, con copia in cache per l'uso offline. */
const SHELL = "bond-shell-v0.10.0";
const ASSETS = ["./", "index.html", "app.css", "app.js", "yields.js", "portfolio.js", "alerts.js", "sim.js", "sync.js", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== "bond-data").map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const cacheName = url.pathname.includes("/data/") ? "bond-data" : SHELL;
  e.respondWith(
    fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(cacheName).then(c => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request).then(hit => hit || Response.error()))
  );
});
