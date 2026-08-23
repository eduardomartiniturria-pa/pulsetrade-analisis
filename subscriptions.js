// Suscripciones push — persistidas en Supabase (Postgres), igual que localStorage.js.
//
// ANTES vivían solo en un archivo en disco (data/subscriptions.json). En el plan free
// de Render el disco es efímero: cada redeploy o reinicio de contenedor lo borraba. Eso
// dejaba al servidor con 0 suscriptores SIN NINGÚN ERROR VISIBLE — el motor seguía
// detectando señales y llamaba a sendPushToAll() con normalidad, pero el array de
// destinatarios estaba vacío, así que no se mandaba (ni fallaba) nada. Silencio total
// y silencioso, literalmente. Esto es lo que probablemente pasó en el último corte.
//
// Si no hay DATABASE_URL configurada, se mantiene el fallback a disco (útil para correr
// local sin Supabase), pero avisando que no sobrevive a un redeploy en Render.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const webpush = require('web-push');
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
// Mismo motivo que en localStorage.js: sin este listener, un corte de red en un cliente
// idle del pool tira un evento 'error' sin manejar y Node mata el proceso entero.
if (pool) {
  pool.on('error', (err) => {
    console.error('Error inesperado en un cliente idle del pool de Supabase (subscriptions, no se cae el server):', err.message);
  });
}
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'subscriptions.json');
function loadFromDisk() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) { /* arranca en blanco si el archivo está corrupto */ }
  return [];
}
function saveToDisk(subs) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(subs));
}
let subscriptions = [];
async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions ( endpoint TEXT PRIMARY KEY, subscription JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now() )`);
}
async function loadFromDb() {
  const res = await pool.query('SELECT subscription FROM push_subscriptions');
  subscriptions = res.rows.map(r => r.subscription);
}
// Hay que llamar y esperar esto ANTES de que el servidor empiece a aceptar tráfico
// (mismo patrón que localStorage.init()), para no perder ninguna suscripción mientras carga.
async function init() {
  if (!pool) {
    console.warn('DATABASE_URL no configurada: las suscripciones push se guardan en disco (data/subscriptions.json) y se pierden en cada redeploy de Render.');
    subscriptions = loadFromDisk();
    return;
  }
  await ensureTable();
  await loadFromDb();
  console.log(`Suscripciones push cargadas desde Supabase: ${subscriptions.length}`);
}
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('⚠️  Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en .env — las notificaciones push no funcionarán hasta configurarlas.');
}
// IMPORTANTE: esto es idempotente a propósito (no hace nada si el endpoint ya existe).
// El frontend ahora llama a /api/subscribe SIEMPRE al cargar, aunque el navegador ya
// tenga una suscripción local — así, si Supabase/disco perdieron el registro por algún
// motivo, el próximo refresh() del panel lo repone solo, sin que el usuario tenga que
// tocar el botón de campanita de nuevo.
async function addSubscription(sub) {
  const exists = subscriptions.some(s => s.endpoint === sub.endpoint);
  if (exists) return;
  subscriptions.push(sub);
  if (!pool) { saveToDisk(subscriptions); return; }
  try {
    await pool.query(
      'INSERT INTO push_subscriptions (endpoint, subscription) VALUES ($1, $2) ON CONFLICT (endpoint) DO NOTHING',
      [sub.endpoint, JSON.stringify(sub)]
    );
  } catch (e) {
    console.error('No se pudo guardar la suscripción en Supabase:', e.message);
  }
}
async function removeSubscription(endpoint) {
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  if (!pool) { saveToDisk(subscriptions); return; }
  try {
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  } catch (e) {
    console.error('No se pudo borrar la suscripción en Supabase:', e.message);
  }
}
async function sendPushToAll(payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  const body = JSON.stringify(payload);
  // Se fija la lista de destinatarios en "targets" ANTES de mandar, por la misma razón
  // que antes: removeSubscription() reasigna "subscriptions" y desalinearía los índices
  // si se leyera directo del array mutable dentro del propio loop.
  const targets = subscriptions;
  const results = await Promise.allSettled(
    targets.map(sub => webpush.sendNotification(sub, body))
  );
  await Promise.all(results.map((r, i) => {
    if (r.status === 'rejected' && (r.reason.statusCode === 404 || r.reason.statusCode === 410)) {
      // La suscripción ya no es válida (el usuario desinstaló la app o revocó el permiso).
      return removeSubscription(targets[i].endpoint);
    }
    return Promise.resolve();
  }));
}
module.exports = {
  init,
  addSubscription,
  removeSubscription,
  sendPushToAll,
  getCount: () => subscriptions.length
};
