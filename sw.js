const CACHE = 'silent-pwa-v7'; // <--- versione nuova
const ASSETS = [
  './','./index.html','./styles.css','./app.js','./crypto.js','./i18n.js',
  './manifest.webmanifest','./icons/maskable-192.png','./icons/maskable-512.png'
];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e=>{
  const r = e.request;
  if (r.method !== 'GET') return;
  e.respondWith(caches.match(r).then(c => c || fetch(r).catch(()=>caches.match('./index.html'))));
});
