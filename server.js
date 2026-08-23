require('dotenv').config();
const { init, onBeforeShutdown } = require('./localStorage');
const Subscriptions = require('./subscriptions');

(async () => {
  await init();
  await Subscriptions.init();

  const express = require('express');
  const path = require('path');
  const { addSubscription, removeSubscription, getCount } = Subscriptions;
  const { state, ASSETS, CONFIG, refreshAllData, BacktestEngine, startAutoRefreshLoop, stopAutoRefreshLoop } = require('./engine.js');

  onBeforeShutdown(stopAutoRefreshLoop);

  state.apiKeys = {
    twelveData: process.env.TWELVEDATA_API_KEY || null,
    finnhub: process.env.FINNHUB_API_KEY || null,
    alphaVantage: process.env.ALPHAVANTAGE_API_KEY || null,
    fmp: process.env.FMP_API_KEY || null,
    coingecko: process.env.COINGECKO_API_KEY || null
  };
  state.lastDisplay = state.lastDisplay || {};

  const app = express();
  app.use(express.json({ limit: '10kb' }));

  // CORS: permitir requests desde el mismo origen + dominios configurados
  const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'];

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin) || origin === undefined) {
      res.header('Access-Control-Allow-Origin', origin || '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Token');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

  // Autenticación simple con token secreto para endpoints sensibles
  const API_SECRET = process.env.API_SECRET || 'pulsetrade-default-secret-change-me';

  function requireAuth(req, res, next) {
    const token = req.headers['x-api-token'] || req.query.token;
    if (token !== API_SECRET) {
      return res.status(401).json({ error: 'No autorizado. Token inválido.' });
    }
    next();
  }

  // Rate limiting manual (sin dependencias extra)
  const rateLimitStore = new Map();
  function rateLimit(maxRequests, windowMs) {
    return (req, res, next) => {
      const key = req.ip;
      const now = Date.now();
      const record = rateLimitStore.get(key) || { count: 0, resetAt: now + windowMs };
      if (now > record.resetAt) {
        record.count = 0;
        record.resetAt = now + windowMs;
      }
      record.count++;
      rateLimitStore.set(key, record);
      res.header('X-RateLimit-Limit', maxRequests);
      res.header('X-RateLimit-Remaining', Math.max(0, maxRequests - record.count));
      if (record.count > maxRequests) {
        return res.status(429).json({ error: 'Demasiados requests, esperá un momento' });
      }
      next();
    };
  }

  // Limpiar rate limit cada 10 minutos para no crecer el Map
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore) {
      if (now > record.resetAt) rateLimitStore.delete(key);
    }
  }, 10 * 60 * 1000);

  // --- ENDPOINTS PÚBLICOS (sin autenticación) ---

  app.get('/api/vapid-public-key', (req, res) => {
    res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime(), version: '4.6.2' });
  });

  // --- ENDPOINTS PROTEGIDOS (requieren token) ---

  app.get('/api/state', requireAuth, (req, res) => {
    res.json({
      signals: state.lastDisplay,
      customSignals: state.lastCustomDisplay || {},
      prices: state.livePrices || {},
      history: (state.signalHistory || []).slice(-50).reverse(),
      strategyStatsBySymbol: state.strategyStatsBySymbol || {},
      autoTune: {
        threshold: state.autoConfidenceThreshold,
        stats: state.autoTuneStats
      },
      strictMode: state.strictMode,
      subscriberCount: getCount(),
      updatedAt: Date.now()
    });
  });

  app.post('/api/subscribe', rateLimit(10, 60 * 1000), async (req, res) => {
    if (!req.body || !req.body.endpoint) {
      return res.status(400).json({ error: 'Suscripción inválida: falta endpoint' });
    }
    if (typeof req.body.endpoint !== 'string' || req.body.endpoint.length > 500) {
      return res.status(400).json({ error: 'Endpoint inválido' });
    }
    try {
      await addSubscription(req.body);
      res.json({ ok: true });
    } catch (e) {
      console.error('Error guardando suscripción:', e.message);
      res.status(500).json({ error: 'No se pudo guardar la suscripción' });
    }
  });

  app.post('/api/unsubscribe', rateLimit(10, 60 * 1000), async (req, res) => {
    try {
      if (req.body && req.body.endpoint) await removeSubscription(req.body.endpoint);
      res.json({ ok: true });
    } catch (e) {
      console.error('Error borrando suscripción:', e.message);
      res.status(500).json({ error: 'No se pudo borrar la suscripción' });
    }
  });

  app.post('/api/check-now', requireAuth, rateLimit(5, 60 * 1000), async (req, res) => {
    refreshAllData(true).catch(e => console.error('Error en check-now:', e.message));
    res.json({ ok: true, started: true });
  });

  let recalibrateRunning = false;
  app.get('/api/recalibrate', requireAuth, async (req, res) => {
    if (recalibrateRunning) {
      return res.status(409).json({ ok: false, error: 'Ya hay una recalibración en curso, esperá a que termine.' });
    }
    recalibrateRunning = true;
    res.json({ ok: true, started: true, message: 'Recalibración iniciada, revisá los logs de Render para ver el progreso.' });
    try {
      await BacktestEngine.runAll(true);
      console.log('[recalibrate] BacktestEngine.runAll(true) terminó OK');
    } catch (e) {
      console.error('[recalibrate] Error corriendo BacktestEngine.runAll(true):', e.message);
    } finally {
      recalibrateRunning = false;
    }
  });

  // --- HISTORIAL (público, solo lectura) ---

  function localDayKeyFromDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function getClosedSignalsForDay(dayKey) {
    try { return JSON.parse(localStorage.getItem(`closed_signals:${dayKey}`) || '[]'); }
    catch (e) { return []; }
  }

  function summarizeClosedSignals(entries) {
    const wins = entries.filter(e => e.result === 'win').length;
    const losses = entries.filter(e => e.result === 'loss').length;
    const total = wins + losses;
    const winRate = total ? +((wins / total) * 100).toFixed(1) : null;
    const byStrategy = {};
    entries.forEach(e => {
      const key = e.source || 'smc';
      if (!byStrategy[key]) byStrategy[key] = { wins: 0, losses: 0 };
      if (e.result === 'win') byStrategy[key].wins++;
      else if (e.result === 'loss') byStrategy[key].losses++;
    });
    const strategyBreakdown = Object.entries(byStrategy)
      .map(([key, s]) => {
        const stotal = s.wins + s.losses;
        return {
          key, wins: s.wins, losses: s.losses, count: stotal,
          winRate: stotal ? +((s.wins / stotal) * 100).toFixed(1) : null,
          pct: total ? +((stotal / total) * 100).toFixed(1) : 0
        };
      })
      .sort((a, b) => b.count - a.count);
    return { wins, losses, total, winRate, strategyBreakdown };
  }

  function groupBySymbol(entries) {
    const bySymbol = {};
    entries.forEach(e => {
      const sym = e.symbol || 'unknown';
      if (!bySymbol[sym]) bySymbol[sym] = [];
      bySymbol[sym].push(e);
    });
    const result = {};
    Object.keys(bySymbol).forEach(sym => { result[sym] = summarizeClosedSignals(bySymbol[sym]); });
    return result;
  }

  app.get('/api/history/days', (req, res) => {
    let days;
    try { days = JSON.parse(localStorage.getItem('closed_signals_days') || '[]'); }
    catch (e) { days = []; }
    res.json({ days });
  });

  app.get('/api/history/:period/:date', (req, res) => {
    const { period, date } = req.params;
    const anchor = new Date(`${date}T00:00:00`);
    if (isNaN(anchor.getTime())) return res.status(400).json({ error: 'Fecha inválida, formato esperado YYYY-MM-DD' });
    let days = [];
    if (period === 'day') {
      days = [anchor];
    } else if (period === 'week') {
      const dow = anchor.getDay();
      const diffToMonday = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(anchor);
      monday.setDate(anchor.getDate() + diffToMonday);
      days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
    } else if (period === 'month') {
      const year = anchor.getFullYear(), month = anchor.getMonth();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      days = Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1));
    } else {
      return res.status(400).json({ error: "period debe ser 'day', 'week' o 'month'" });
    }
    const dayKeys = days.map(localDayKeyFromDate);
    const entries = dayKeys.flatMap(getClosedSignalsForDay);
    const summary = summarizeClosedSignals(entries);
    const bySymbol = groupBySymbol(entries);
    res.json({ period, anchor: date, days: dayKeys, ...summary, bySymbol });
  });

  // --- 404 handler ---
  app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint no encontrado' });
  });

  // --- Error handler ---
  app.use((err, req, res, next) => {
    console.error('Error no manejado:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`PulseTrade backend v4.6.2 escuchando en :${PORT}`));

  setTimeout(() => BacktestEngine.runAll(false), 2 * 60 * 1000);
  startAutoRefreshLoop();
})().catch(e => {
  console.error('Error fatal iniciando el servidor:', e);
  process.exit(1);
});
