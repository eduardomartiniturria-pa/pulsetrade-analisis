require('dotenv').config();
require('./localStorage'); // debe cargarse ANTES que engine.js, que asume localStorage global

const express = require('express');
const path = require('path');
const { addSubscription, removeSubscription, getCount } = require('./subscriptions');

// engine.js declara ASSETS, CONFIG, state, refreshAllData, BacktestEngine, etc. como globales
// de módulo (era un <script> de navegador). Lo cargamos aquí y usamos esas mismas funciones,
// sin haber tocado su lógica de señales/aprendizaje.
// startAutoRefreshLoop reemplaza al cron fijo de 5 min: corre solo, y decide internamente
// cada cuánto refrescar (15 min normal, 1 min dentro de la ventana Kill Zone NY 10:30-13:30 ARG).
const { state, ASSETS, CONFIG, refreshAllData, BacktestEngine, startAutoRefreshLoop } = require('./engine.js');

// El motor original leía las API keys desde localStorage (las cargaba el usuario a mano en el
// navegador). Aquí vienen del .env del servidor, una sola vez para todos.
state.apiKeys = {
  twelveData: process.env.TWELVEDATA_API_KEY || null,
  finnhub: process.env.FINNHUB_API_KEY || null,
  alphaVantage: process.env.ALPHAVANTAGE_API_KEY || null,
  fmp: process.env.FMP_API_KEY || null,
  // CryptoCompare (ahora CCData) dejó de aceptar pedidos sin API key — antes andaba gratis
  // sin registrarse, por eso el código viejo no la pedía. Es gratis igual, solo hay que
  // registrarse. Sin esta key, CryptoCompare devuelve HTTP 401 siempre.
  cryptocompare: process.env.CRYPTOCOMPARE_API_KEY || null
};
state.lastDisplay = state.lastDisplay || {};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Estado actual: última señal/no-señal por símbolo + historial + qué tan calibrado está
// el auto-tune de cada activo. Esto es lo que consume el panel (PWA) en vez de generarlo él mismo.
app.get('/api/state', (req, res) => {
  res.json({
    signals: state.lastDisplay,
    prices: state.livePrices || {},
    history: (state.signalHistory || []).slice(-50).reverse(),
    autoTune: {
      threshold: state.autoConfidenceThreshold,
      stats: state.autoTuneStats
    },
    strictMode: state.strictMode,
    subscriberCount: getCount(),
    updatedAt: Date.now()
  });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

app.post('/api/subscribe', (req, res) => {
  if (!req.body || !req.body.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
  addSubscription(req.body);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  if (req.body && req.body.endpoint) removeSubscription(req.body.endpoint);
  res.json({ ok: true });
});

// Disparo manual (por si quieres forzar un chequeo desde el panel, no depende del scheduler).
app.post('/api/check-now', async (req, res) => {
  refreshAllData(true).catch(e => console.error('Error en check-now:', e.message));
  res.json({ ok: true, started: true });
});

// Usado por el "pinger" externo (cron-job.org) para mantener despierto el server gratuito
// Y como probe de salud.
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PulseTrade backend escuchando en :${PORT}`));

// ---- Motor en segundo plano: corre solo, sin depender de ningún celular abierto ----
// El backtest de calibración se corre 2 minutos después del arranque, para no pedirle datos
// a Twelve Data al mismo tiempo que el primer chequeo (juntos superaban el límite gratuito
// de 8 pedidos/minuto y todo fallaba).
setTimeout(() => BacktestEngine.runAll(false), 2 * 60 * 1000);

// Arranca el scheduler autoajustable de engine.js: hace el primer chequeo inmediato y a partir
// de ahí decide solo cada cuánto volver a refrescar (15 min normal / 1 min en Kill Zone NY).
// Reemplaza al viejo cron.schedule('*/5 * * * *', runCycle) — NO agregar un cron aparte acá,
// se duplicarían los requests contra los proveedores y empeoraría el rate limit.
startAutoRefreshLoop();
