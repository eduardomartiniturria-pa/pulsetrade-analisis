// Reemplaza el localStorage del navegador por uno respaldado en Supabase (Postgres),
// para que el motor original (engine.js) no necesite cambios en su lógica de guardado.
//
// engine.js espera getItem/setItem/removeItem SÍNCRONOS. Como hablar con Supabase es
// async, la estrategia es: cargar todo en memoria una vez al arrancar (init(), que hay
// que esperar ANTES de requerir engine.js) y desde ahí leer/escribir en memoria sin
// esperar a la base — cada escritura además dispara un guardado async hacia Supabase
// de fondo, así no se pierde nada aunque Render reinicie el servicio.
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

let store = {};

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
}

async function loadAll() {
  const res = await pool.query('SELECT key, value FROM kv_store');
  for (const row of res.rows) store[row.key] = row.value;
}

function persistKey(key, value) {
  if (!pool) return;
  pool
    .query(
      'INSERT INTO kv_store (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, value]
    )
    .catch(e => console.error(`No se pudo guardar "${key}" en Supabase:`, e.message));
}

function deleteKey(key) {
  if (!pool) return;
  pool
    .query('DELETE FROM kv_store WHERE key = $1', [key])
    .catch(e => console.error(`No se pudo borrar "${key}" en Supabase:`, e.message));
}

global.localStorage = {
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
  },
  setItem(key, value) {
    store[key] = String(value);
    persistKey(key, store[key]);
  },
  removeItem(key) {
    delete store[key];
    deleteKey(key);
  }
};

// Hay que llamar y esperar esto ANTES de require('./engine.js'), porque engine.js lee
// varias claves de localStorage apenas se carga el módulo (API keys, config guardada, etc.)
async function init() {
  if (!pool) {
    console.warn(
      'DATABASE_URL no configurada: el historial NO va a persistir entre reinicios (se pierde en cada redeploy de Render).'
    );
    return;
  }
  await ensureTable();
  await loadAll();
  console.log(`Supabase conectado — ${Object.keys(store).length} claves cargadas.`);
}

module.exports = { init };
