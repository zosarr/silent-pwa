// sw.js — basic PWA caching (app shell)
const CACHE = 'silent-cache-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './crypto.js',
  './i18n.js',
  './manifest.webmanifest',
  './icons/1.png',
  './icons/2.png',
  './sw.js'
];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if(url.pathname.startsWith('/ws')) return;
  e.respondWith(caches.match(e.request).then(resp => resp || fetch(e.request)));
});