require('dotenv').config();
require('./localStorage'); // debe cargarse ANTES que engine.js, que asume localStorage global

const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { addSubscription, removeSubscription, getCount } = require('./subscriptions');

// engine.js declara ASSETS, CONFIG, state, refreshAllData, BacktestEngine, etc. como globales
// de módulo (era un <script> de navegador). Lo cargamos aquí y usamos esas mismas funciones,
// sin haber tocado su lógica de señales/aprendizaje.
const { state, ASSETS, CONFIG, refreshAllData, BacktestEngine } = require('./engine.js');

// El motor original leía las API keys desde localStorage (las cargaba el usuario a mano en el
// navegador). Aquí vienen del .env del servidor, una sola vez para todos.
state.apiKeys = {
  twelveData: process.env.TWELVEDATA_API_KEY || null,
  finnhub: process.env.FINNHUB_API_KEY || null,
  alphaVantage: process.env.ALPHAVANTAGE_API_KEY || null,
  fmp: process.env.FMP_API_KEY || null
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

// Disparo manual (por si quieres forzar un chequeo desde el panel, no depende del cron).
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
async function runCycle() {
  try {
    await refreshAllData(false);
  } catch (e) {
    console.error('Error en el ciclo de señales:', e.message);
  }
}

// Arranque: primer chequeo inmediato. El backtest de calibración se corre 2 minutos después,
// para no pedirle datos a Twelve Data al mismo tiempo que el primer chequeo (juntos superaban
// el límite gratuito de 8 pedidos/minuto y todo fallaba).
runCycle();
setTimeout(() => BacktestEngine.runAll(false), 2 * 60 * 1000);

// Cada 5 minutos (ajustable con CRON_SCHEDULE en .env). Con notificaciones push no hace falta
// el refresco cada 30s del navegador: 5 min es de sobra para timeframes de 15m/1h.
const schedule = process.env.CRON_SCHEDULE || '*/5 * * * *';
cron.schedule(schedule, runCycle);
