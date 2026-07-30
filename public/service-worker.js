// Service Worker de PulseTrade PRO
// Se encarga de: 1) recibir las notificaciones push que manda el servidor
// (vía subscriptions.js/web-push) y mostrarlas, y 2) abrir/enfocar la app
// cuando el usuario toca la notificación.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// El payload lo arma notifyNewSignal() en engine.js:
// { title, body, symbol, signal }
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'PulseTrade PRO', body: event.data ? event.data.text() : 'Nueva señal' };
  }

  const title = data.title || 'PulseTrade PRO';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.symbol || 'pulsetrade-signal', // evita apilar notis del mismo símbolo
    renotify: true,
    data: { symbol: data.symbol || null, signal: data.signal || null }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Al tocar la notificación: si ya hay una pestaña de la app abierta, la enfoca;
// si no, abre una nueva en la raíz.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});
