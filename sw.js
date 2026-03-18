self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

self.addEventListener('push', e => {
  let data = { title: '🚨 צבע אדום', body: 'היכנסו למרחב המוגן מיד!', tag: 'alert' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch(_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body, requireInteraction: true,
      vibrate: [300,100,300,100,600], dir: 'rtl',
      tag: data.tag, renotify: true,
      actions: [{ action: 'open', title: '📱 פתח' }, { action: 'dismiss', title: '✕ סגור' }]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      if (list.length) return list[0].focus();
      return clients.openWindow('/');
    })
  );
});
