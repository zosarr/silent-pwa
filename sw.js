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



self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const url = (n && n.data && n.data.url) ? n.data.url : (self.registration.scope || './');
  n.close();
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Try to focus an existing client
    for (const client of allClients) {
      try {
        if ('focus' in client) {
          await client.focus();
          try { if ('navigate' in client) await client.navigate(url); } catch (_) {}
          return;
        }
      } catch (_) {}
    }
    // Otherwise open a new window
    if (clients.openWindow) {
      await clients.openWindow(url);
    }
  })());
});
