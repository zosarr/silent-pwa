const CACHE = 'silent-pwa-v8'; // bump

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
  event.notification.close();
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow('./');
  })());
});


self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(_){}
  const title = data.title || 'Silent';
  const body = data.body || '';
  const icon = 'icons/1.png';
  const badge = 'icons/2.png';
  event.waitUntil(self.registration.showNotification(title, {
    body, icon, badge, tag:'incoming', renotify:true, data
  }));
});
