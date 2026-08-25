require('dotenv').config();

const { init, onBeforeShutdown } = require('./localStorage'); // ahora es async: hay que esperarlo antes de tocar engine.js
const Subscriptions = require('./subscriptions'); // también async: ahora persiste en Supabase, no en disco

(async () => {
  await init(); // conecta a Supabase y carga todo lo guardado en memoria (localStorage global)
  await Subscriptions.init(); // carga las suscripciones push desde Supabase (o disco si no hay DATABASE_URL)

  // A partir de acá, todo sigue exactamente igual que antes.
  const express = require('express');
  const path = require('path');
  const { addSubscription, removeSubscription, getCount } = Subscriptions;

  // engine.js declara ASSETS, CONFIG, state, refreshAllData, BacktestEngine, etc. como globales
  // de módulo (era un <script> de navegador). Lo cargamos aquí y usamos esas mismas funciones,
  // sin haber tocado su lógica de señales/aprendizaje.
  // startAutoRefreshLoop reemplaza al cron fijo de 5 min: corre solo, y decide internamente
  // cada cuánto refrescar (15 min normal, 1 min dentro de la ventana Kill Zone NY 10:30-13:30 ARG).
  // startCryptoQuickCheckLoop (7.1, medida intermedia): loop aparte, cada 5min fijo, solo
  // para BTC/ETH — chequea precio actual contra SL/TP de señales en curso, sin generar
  // señales nuevas ni pedir OHLCV/HTF completo (ver detalle en CONFIG.CRYPTO_QUICK_CHECK_INTERVAL_MS).
  const { state, ASSETS, CONFIG, refreshAllData, BacktestEngine, startAutoRefreshLoop, stopAutoRefreshLoop, startCryptoQuickCheckLoop, stopCryptoQuickCheckLoop } = require('./engine.js');

  // Se registra ACÁ (no en localStorage.js, que se carga antes y no conoce a engine.js)
  // para que, apenas llegue SIGTERM (redeploy en Render), el motor deje de arrancar
  // ciclos nuevos ANTES de que localStorage.js empiece a esperar las escrituras
  // pendientes. Esto es lo que le faltaba al fix anterior: sin esto, una señal podía
  // generarse y empezar a guardarse DESPUÉS de que ya se había tomado la foto de "qué
  // hay que esperar", y se perdía igual pese a que el flush en sí funcionaba bien.
  onBeforeShutdown(stopAutoRefreshLoop);
  onBeforeShutdown(stopCryptoQuickCheckLoop);

  // El motor original leía las API keys desde localStorage (las cargaba el usuario a mano en el
  // navegador). Aquí vienen del .env del servidor, una sola vez para todos.
  state.apiKeys = {
    twelveData: process.env.TWELVEDATA_API_KEY || null,
    finnhub: process.env.FINNHUB_API_KEY || null,
    alphaVantage: process.env.ALPHAVANTAGE_API_KEY || null,
    fmp: process.env.FMP_API_KEY || null,
    // CryptoCompare (ahora CCData) exige API key en todos los pedidos — es gratis igual,
    // solo hay que registrarse. Sin esto, ese proveedor se salta siempre (requiresKey: true).
    // CoinGecko Demo (gratis, 10.000 pedidos/mes) — respaldo de cripto (BTC/ETH) para cuando
    // TwelveData se queda sin cupo. Reemplaza a CryptoCompare, discontinuada en mayo 2026.
    // Se saca gratis en https://www.coingecko.com/en/developers/dashboard
    coingecko: process.env.COINGECKO_API_KEY || null
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
      // Señales de las 7 estrategias independientes (Kill Zone NY, Pivots B&R, Price
      // Action+RSI+EMA, Supply&Demand, EMA Cross Scalping, Divergencia RSI, Bollinger
      // Squeeze). Antes se calculaban y se notificaban por push, pero nunca se exponían
      // acá — el panel no tenía forma de mostrarlas mientras estaban activas.
      customSignals: state.lastCustomDisplay || {},
      prices: state.livePrices || {},
      history: (state.signalHistory || []).slice(-50).reverse(),
      // Ganadas/perdidas (y R promedio) por símbolo + estrategia, para la tabla comparativa
      // del panel (renderStrategyStatsTable en index.html). Faltaba exponerlo acá — el campo
      // ya existía en engine.js (state.strategyStatsBySymbol) pero nunca llegaba al frontend.
      strategyStatsBySymbol: state.strategyStatsBySymbol || {},
      // Cuántas velas HTF (H1) llegó a recibir cada símbolo en el último ciclo — para
      // confirmar sin ir a los logs de Render si el filtro de tendencia mayor de
      // supply_demand (necesita >=50) está activo o desactivado en la práctica.
      htfDiagnostics: state.htfDiagnostics || {},
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

  app.post('/api/subscribe', async (req, res) => {
    if (!req.body || !req.body.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
    try {
      await addSubscription(req.body);
      res.json({ ok: true });
    } catch (e) {
      console.error('Error guardando suscripción:', e.message);
      res.status(500).json({ error: 'No se pudo guardar la suscripción' });
    }
  });

  app.post('/api/unsubscribe', async (req, res) => {
    try {
      if (req.body && req.body.endpoint) await removeSubscription(req.body.endpoint);
      res.json({ ok: true });
    } catch (e) {
      console.error('Error borrando suscripción:', e.message);
      res.status(500).json({ error: 'No se pudo borrar la suscripción' });
    }
  });

  // Disparo manual (por si quieres forzar un chequeo desde el panel, no depende del scheduler).
  app.post('/api/check-now', async (req, res) => {
    refreshAllData(true).catch(e => console.error('Error en check-now:', e.message));
    res.json({ ok: true, started: true });
  });

  // NUEVO: dispara BacktestEngine.runAll(true) a demanda, con force=true (recalibración
  // completa de autoConfidenceThreshold/patternStats/strategyStatsBySymbol). Se agregó tras
  // el fix de ATR (Wilder, ronda de custom-strategies.js/engine.js): el auto-tune runAll(false)
  // que corre solo al arrancar el server NO fuerza recalibración, así que el cambio de ATR
  // nunca se reflejaba en los umbrales de confianza hasta correr esto manualmente. Es un GET
  // (no POST) a propósito, para poder dispararlo abriendo la URL directo desde el navegador
  // sin necesitar curl ni Postman. isRunning evita que se pise con otra corrida en simultáneo.
  let recalibrateRunning = false;
  app.get('/api/recalibrate', async (req, res) => {
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

  // ---------------------------------------------------------
  // Historial navegable por día/semana/mes (solo lectura, para el panel).
  // Lee los keys `closed_signals:YYYY-MM-DD` que engine.js escribe cada vez que una
  // señal se resuelve win/loss (ver appendClosedSignal en engine.js). No toca
  // pt_v4_signals ni ninguna lógica de trading/auto-tune.
  // ---------------------------------------------------------
  function localDayKeyFromDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function getClosedSignalsForDay(dayKey) {
    try { return JSON.parse(localStorage.getItem(`closed_signals:${dayKey}`) || '[]'); }
    catch (e) { return []; }
  }

  // CAMBIO (13/8, módulo de historial visual): antes strategyBreakdown solo traía
  // {key, count, pct} — cuántas señales cerradas (ganadas+perdidas juntas) aportó cada
  // estrategia al total del período, sin distinguir cuántas de esas fueron ganadas o
  // perdidas. Para el desglose activo→estrategia (winrate por estrategia) hace falta
  // wins/losses/winRate reales por estrategia, no solo el conteo. Se agregan esos campos
  // sin sacar ninguno de los que ya existían.
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

  // Mismo resumen que arriba, pero separado por activo (BTCUSD/ETHUSD/EURUSD/XAUUSD) —
  // para la navegación Período → Activo → Estrategia del módulo de historial. Reutiliza
  // summarizeClosedSignals sobre el subconjunto de entries de cada símbolo, así la lógica
  // de cálculo de winrate/strategyBreakdown queda en un solo lugar.
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

  // Lista de días que tienen al menos una señal cerrada — así el panel arma la lista
  // cronológica sin tener que adivinar fechas ni barrer keys a ciegas.
  app.get('/api/history/days', (req, res) => {
    let days;
    try { days = JSON.parse(localStorage.getItem('closed_signals_days') || '[]'); }
    catch (e) { days = []; }
    res.json({ days });
  });

  // :period = day | week | month. :date = YYYY-MM-DD, cualquier día dentro del
  // período que se quiere consultar (para 'week' y 'month' se calcula el rango
  // completo a partir de esa fecha ancla).
  app.get('/api/history/:period/:date', (req, res) => {
    const { period, date } = req.params;
    const anchor = new Date(`${date}T00:00:00`);
    if (isNaN(anchor.getTime())) return res.status(400).json({ error: 'Fecha inválida, formato esperado YYYY-MM-DD' });

    let days = [];
    if (period === 'day') {
      days = [anchor];
    } else if (period === 'week') {
      // Semana de lunes a domingo, calculada a partir de la fecha ancla.
      const dow = anchor.getDay(); // 0=domingo
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
    // bySymbol: mismo resumen (wins/losses/winRate/strategyBreakdown) pero recortado a
    // cada activo — así el panel puede mostrar primero el total del período y, al
    // elegir un activo, el desglose por estrategia de ESE activo únicamente.
    const bySymbol = groupBySymbol(entries);
    res.json({ period, anchor: date, days: dayKeys, ...summary, bySymbol });
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
  // Loop aparte (7.1, medida intermedia), fijo cada 5min, solo BTC/ETH — no compite con el
  // rate limit de arriba porque solo pide precio (getQuote), no OHLCV/HTF.
  startCryptoQuickCheckLoop();
})().catch(e => {
  console.error('Error fatal iniciando el servidor:', e);
  process.exit(1);
});
