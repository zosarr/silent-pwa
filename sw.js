const CACHE = 'silent-pwa-v10'; // bump

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



self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  n.close();
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      try { if ('focus' in client) { await client.focus(); return; } } catch (_) {}
    }
    const target = (self.registration && self.registration.scope) ? self.registration.scope : './';
    if (clients.openWindow) await clients.openWindow(target + '#chat');
  })());
});
