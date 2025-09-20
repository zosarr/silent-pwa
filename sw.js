const CACHE = 'silent-pwa-v9'; // bump

self.addEventListener('install', (event) => {
  const assets = [
    './', './index.html', './styles.css', './app.js',
    './crypto.js', './i18n.js', './sw.js', './manifest.webmanifest',
    // ATTENZIONE: qui NON mettere icone che non esistono!
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

