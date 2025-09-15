const CACHE = 'silent-pwa-v4'; // <--- versione nuova
const ASSETS = [
  './','./index.html','./styles.css','./app.js','./crypto.js','./i18n.js',
  './manifest.webmanifest','./icons/maskable-192.png','./icons/maskable-512.png'
];
self.addEventListener('install', (event) => {
  const assets = [
    './', './index.html', './styles.css', './app.js',
    './crypto.js', './i18n.js', './sw.js', './manifest.webmanifest',
    // aggiungi qui SOLO file che esistono davvero e sono same-origin
  ];
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const url of assets) {
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
        } catch (err) {
          console.warn('[SW] skip caching', url, err);
        }
      }
    })
  );
});
