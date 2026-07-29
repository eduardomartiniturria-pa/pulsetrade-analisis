const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'subscriptions.json');

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) { /* arranca en blanco si el archivo está corrupto */ }
  return [];
}

function save(subs) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(subs));
}

let subscriptions = load();

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('⚠️  Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en .env — las notificaciones push no funcionarán hasta configurarlas.');
}

function addSubscription(sub) {
  const exists = subscriptions.some(s => s.endpoint === sub.endpoint);
  if (!exists) {
    subscriptions.push(sub);
    save(subscriptions);
  }
}

function removeSubscription(endpoint) {
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  save(subscriptions);
}

async function sendPushToAll(payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subscriptions.map(sub => webpush.sendNotification(sub, body))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected' && (r.reason.statusCode === 404 || r.reason.statusCode === 410)) {
      // La suscripción ya no es válida (el usuario desinstaló la app o revocó el permiso).
      removeSubscription(subscriptions[i].endpoint);
    }
  });
}

module.exports = { addSubscription, removeSubscription, sendPushToAll, getCount: () => subscriptions.length };
