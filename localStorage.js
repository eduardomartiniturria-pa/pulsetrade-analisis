// Reemplaza el localStorage del navegador por uno respaldado en Supabase (Postgres),
// para que el motor original (engine.js) no necesite cambios en su lógica de guardado.
//
// engine.js espera getItem/setItem/removeItem SÍNCRONOS. Como hablar con Supabase es
// async, la estrategia es: cargar todo en memoria una vez al arrancar (init(), que hay
// que esperar ANTES de requerir engine.js) y desde ahí leer/escribir en memoria sin
// esperar a la base — cada escritura además dispara un guardado async hacia Supabase
// de fondo, así no se pierde nada aunque Render reinicie el servicio.
//
// FIX (bug de señales perdidas en redeploys/reinicios): antes, cada escritura a
// Supabase era pura "fire and forget" — se disparaba la promesa y se seguía de largo
// sin esperarla. Si Render mataba el proceso (por un redeploy, o por el plan free
// reiniciando el servicio) en la ventana de milisegundos/segundos antes de que esa
// escritura terminara, la señal quedaba guardada solo en la memoria del proceso viejo
// y se perdía para siempre — el próximo arranque cargaba desde Supabase una foto
// vieja, sin esa entrada. Esto se confirmó con evidencia real: una señal ganadora
// (BTCUSD, EMA Cross Scalping, detectada 19:49:11) desapareció del historial, y el
// historial completo quedó "congelado" en 21:59:48 durante casi 2 horas mientras el
// motor seguía generando señales nuevas en memoria.
//
// Ahora: cada escritura pendiente se trackea en un Set. Antes de que el proceso se
// apague (SIGTERM, que es la señal que manda Render al redeployar; SIGINT para Ctrl+C
// local), se espera (con un timeout de seguridad) a que todas las escrituras
// pendientes terminen antes de dejar morir el proceso. Así, un redeploy normal ya no
// pierde nada — solo un crash abrupto (que no manda SIGTERM) podría seguir perdiendo
// la última escritura, pero eso es mucho más raro que un redeploy común.
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// CRÍTICO: sin este listener, cualquier corte de red en un cliente inactivo del pool
// (típico en Supabase, que cierra conexiones idle) tira un evento 'error' sin manejar
// y Node mata el proceso entero — la app queda muda de golpe hasta que Render la
// reinicie sola, sin ningún log claro de qué pasó. Con el listener, el error se loguea
// y el pool sigue vivo (pg abre una conexión nueva la próxima vez que la necesita).
if (pool) {
  pool.on('error', (err) => {
    console.error('Error inesperado en un cliente idle del pool de Supabase (contenido, no se cae el server):', err.message);
  });
}

let store = {};

// Escrituras a Supabase que todavía no terminaron. Se usa un Set porque cada promesa
// se borra sola de la lista apenas termina (ver persistKey/deleteKey), así que en
// cualquier momento este Set refleja exactamente lo que falta esperar antes de apagar.
const pendingWrites = new Set();

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
  const p = pool
    .query(
      'INSERT INTO kv_store (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, value]
    )
    .catch(e => console.error(`No se pudo guardar "${key}" en Supabase:`, e.message))
    .finally(() => pendingWrites.delete(p));
  pendingWrites.add(p);
}

function deleteKey(key) {
  if (!pool) return;
  const p = pool
    .query('DELETE FROM kv_store WHERE key = $1', [key])
    .catch(e => console.error(`No se pudo borrar "${key}" en Supabase:`, e.message))
    .finally(() => pendingWrites.delete(p));
  pendingWrites.add(p);
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

// Espera a que terminen todas las escrituras pendientes, con un tope de tiempo por si
// alguna quedó colgada (por ejemplo, Supabase no responde) — así el proceso no queda
// trabado para siempre esperando algo que nunca va a terminar.
async function flushPending(timeoutMs = 8000) {
  if (!pendingWrites.size) return;
  console.log(`Esperando ${pendingWrites.size} escritura(s) pendiente(s) a Supabase antes de apagar...`);
  const all = Promise.allSettled([...pendingWrites]);
  const timeout = new Promise(resolve => setTimeout(resolve, timeoutMs));
  await Promise.race([all, timeout]);
  if (pendingWrites.size) {
    console.warn(`Se apagó el proceso con ${pendingWrites.size} escritura(s) todavía sin confirmar (timeout de ${timeoutMs}ms alcanzado).`);
  } else {
    console.log('Todas las escrituras pendientes se guardaron correctamente.');
  }
}

// Render manda SIGTERM cuando va a matar el proceso viejo en un redeploy (le da unos
// segundos de gracia antes de forzar el apagado). Ese es el momento de asegurarse de
// que no quede ninguna señal a medio guardar.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Señal ${signal} recibida, cerrando de forma prolija...`);
  await flushPending();
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
