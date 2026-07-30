// ============================================================
// PULSE TRADE v4.0 - MOTOR DE SEÑALES PROFESIONAL
// ============================================================

const { sendPushToAll } = require('./subscriptions');

const CONFIG = {
  REFRESH_INTERVAL: 30000,
  HISTORY_LIMIT: 50,
  REQUEST_TIMEOUT: 3500,
  MAX_RETRIES: 2,
  RETRY_DELAY: 1000,
  CACHE_TTL: 30000,
  CONFIDENCE_THRESHOLD: 70,
  // Tiempo mínimo entre señales de dirección distinta para el mismo activo (evita el "parpadeo" LONG/SHORT).
  SIGNAL_COOLDOWN_MS: 15 * 60 * 1000,
  // Timeframe superior usado para el filtro de tendencia HTF. Los proveedores solo soportan
  // 5m/15m/1h, así que 1h no tiene un HTF real disponible y el filtro no aplica en ese caso.
  HTF_MAP: { '5m': '1h', '15m': '1h' },
  // Múltiplo sobre el spread promedio reciente a partir del cual se considera "anómalo"
  // (baja liquidez / posible gap) y se bloquea la emisión de nuevas señales.
  SPREAD_ANOMALY_MULTIPLIER: 2.5,
  // Auto-ajuste: en vez de un panel manual, la app recalibra sola el umbral de confianza
  // según el rendimiento real registrado en el historial (nadie tiene que decidir nada).
  // v2: el umbral se calibra POR SÍMBOLO (cada activo tiene su propio comportamiento) y se
  // usa expectancy en múltiplos de R (no solo win rate) para no penalizar sistemas con buen
  // R:R aunque acierten menos de la mitad de las veces.
  AUTO_TUNE: {
    minSampleSize: 10,     // mínimo de señales cerradas (ganada/perdida) por símbolo para empezar a ajustar
    windowSize: 20,        // ventana móvil: solo mira las últimas N señales cerradas de ESE símbolo
    // Expectancy = R promedio por operación (win aporta +tp1Pips/slPips, loss aporta -1).
    // Los valores por defecto equivalen aprox. a los umbrales de win rate 45%/65% del diseño
    // original, dado el RR fijo de 1:2 (expectancy = 3*winRate - 1).
    targetExpectancyLow: 0.35,   // por debajo de esto, rendimiento pobre => sube el umbral
    targetExpectancyHigh: 0.95,  // por encima de esto, rendimiento sólido => baja el umbral
    step: 2,               // cuánto sube/baja el umbral en cada ajuste
    minThreshold: 65,
    maxThreshold: 90,
    // Ponderación por patrón SMC: bonus/penalización de confianza según el acierto histórico
    // real de cada patrón (BOS, CHoCH, OB, FVG, sweep), no solo del sistema en conjunto.
    PATTERN_MIN_SAMPLE: 8,  // mínimo de cierres de ESE patrón para empezar a ponderarlo
    PATTERN_MAX_BONUS: 8    // tope +/- de ajuste de confianza por patrón
  },
  // Backtesting real: en vez de esperar semanas a que el auto-ajuste en vivo junte suficientes
  // señales cerradas, se simula el mismo motor (SMCEngine) sobre velas históricas REALES de
  // Binance (BTC/ETH, único par con histórico largo, gratuito y fiable sin API key) para
  // "adelantar" la calibración. Los resultados solo actúan como SEMILLA: en cuanto el
  // aprendizaje en vivo junta muestra suficiente (real, con operaciones reales), ese toma el
  // control y el resultado del backtest deja de usarse para ese símbolo/patrón.
  BACKTEST: {
    SYMBOLS: ['BTCUSD', 'ETHUSD', 'EURUSD', 'XAUUSD'],
    // BTC/ETH: Binance público, sin API key. EUR/USD y XAU/USD: no existen en Binance, así que
    // usan el histórico de Twelve Data (requiere que el usuario haya cargado esa API key; si no,
    // ese símbolo simplemente no tiene semilla de backtest y aprende solo en vivo, como antes).
    CANDLE_LIMIT: 1000,          // máximo permitido por Binance en una sola petición de velas
    TWELVEDATA_CANDLE_LIMIT: 800, // Twelve Data free tier: outputsize máximo razonable sin gastar toda la cuota diaria
    TIMEFRAMES: ['15m', '1h'],
    MIN_LOOKBACK: 60,            // velas mínimas de contexto antes de poder simular la primera señal
    WINDOW_SIZE: 150,            // tamaño de la ventana deslizante que "ve" el motor en cada punto (similar a en vivo)
    MAX_HOLD_CANDLES: 200,       // velas máximas esperando que toque TP o SL antes de descartar la operación simulada
    COOLDOWN_CANDLES: 6,         // separación mínima entre señales de dirección opuesta (evita parpadeo, igual que en vivo)
    RERUN_INTERVAL_MS: 24 * 60 * 60 * 1000, // recalibra como máximo una vez al día
    SEED_CAP: 40,                // tope de muestras "sintéticas" por patrón, para no opacar el aprendizaje real en vivo
    YIELD_EVERY: 40              // cada cuántas velas simuladas se cede el hilo principal (para no congelar la interfaz)
  },
  PROVIDER_PRIORITY: ['twelveData', 'finnhub', 'alphaVantage', 'fmp', 'binanceSpot', 'binanceFutures', 'cryptocompare'],
  ENDPOINTS: {
    BINANCE_SPOT: 'https://api.binance.com/api/v3',
    BINANCE_FUTURES: 'https://fapi.binance.com/fapi/v1',
    CRYPTOCOMPARE: 'https://min-api.cryptocompare.com/data',
    EXCHANGERATE: 'https://api.exchangerate-api.com/v4/latest',
    TWELVEDATA: 'https://api.twelvedata.com',
    FINNHUB: 'https://finnhub.io/api/v1',
    ALPHAVANTAGE: 'https://www.alphavantage.co/query',
    FMP: 'https://financialmodelingprep.com/api/v3'
  }
};

class MarketData {
  constructor({ bid, ask, last, open, high, low, close, volume, timestamp, timeframe, marketStatus, spread, source, symbol, estimatedSpread = false }) {
    this.bid = bid;
    this.ask = ask;
    this.last = last;
    this.open = open;
    this.high = high;
    this.low = low;
    this.close = close;
    this.volume = volume;
    this.timestamp = timestamp;
    this.timeframe = timeframe || '1d';
    this.marketStatus = marketStatus || 'unknown';
    this.spread = spread;
    this.source = source;
    this.symbol = symbol;
    this.estimatedSpread = estimatedSpread;
    this.isValid = this.validate();
  }

  validate() {
    if (this.last === null || this.last === undefined || isNaN(this.last)) return false;
    if (this.timestamp === null || Date.now() - this.timestamp > 300000) return false;
    if (this.spread !== null && this.spread > 500) return false;
    return true;
  }
}

class OHLCVData {
  constructor(candles) {
    this.candles = candles || [];
    this.isValid = candles && candles.length >= 30;
  }
}

const ASSETS = {
  BTCUSD: {
    name: 'BTC/USD', market: 'crypto', type: 'crypto',
    symbols: { twelveData: 'BTC/USD', finnhub: 'BINANCE:BTCUSDT', alphaVantage: 'BTC', fmp: 'BTCUSD', binance: 'BTCUSDT', cryptocompare: 'BTC' },
    decimals: 2, pipSize: 1, is24h: true, timezone: 'UTC',
    openHour: 0, closeHour: 24, openDays: [0,1,2,3,4,5,6],
    providerPriority: ['binanceSpot', 'binanceFutures', 'cryptocompare', 'twelveData', 'finnhub', 'alphaVantage']
  },
  ETHUSD: {
    name: 'ETH/USD', market: 'crypto', type: 'crypto',
    symbols: { twelveData: 'ETH/USD', finnhub: 'BINANCE:ETHUSDT', alphaVantage: 'ETH', fmp: 'ETHUSD', binance: 'ETHUSDT', cryptocompare: 'ETH' },
    decimals: 2, pipSize: 1, is24h: true, timezone: 'UTC',
    openHour: 0, closeHour: 24, openDays: [0,1,2,3,4,5,6],
    providerPriority: ['binanceSpot', 'binanceFutures', 'cryptocompare', 'twelveData', 'finnhub', 'alphaVantage']
  },
  EURUSD: {
    // Forex no usa openHour/closeHour/openDays: su horario real (Dom 22:00 UTC a Vie 22:00 UTC,
    // sesiones solapadas) lo resuelve isForexWeekOpen()/FX_SESSIONS, no el modelo de "horas fijas por día".
    name: 'EUR/USD', market: 'forex', type: 'forex',
    symbols: { twelveData: 'EUR/USD', finnhub: 'OANDA:EUR_USD', alphaVantage: 'EURUSD', fmp: 'EURUSD', cryptocompare: 'EUR', exchangerate: 'EUR' },
    decimals: 5, pipSize: 0.0001, is24h: false, timezone: 'UTC',
    providerPriority: ['exchangerate', 'cryptocompare', 'twelveData', 'finnhub', 'alphaVantage', 'fmp']
  },
  XAUUSD: {
    // Igual que EUR/USD: horario real resuelto por isForexWeekOpen()/FX_SESSIONS.
    name: 'XAU/USD (Oro)', market: 'forex', type: 'commodity',
    symbols: { twelveData: 'XAU/USD', finnhub: 'OANDA:XAU_USD', alphaVantage: 'XAU', fmp: 'GCUSD', cryptocompare: 'XAU' },
    decimals: 2, pipSize: 0.1, is24h: false, timezone: 'UTC',
    providerPriority: ['cryptocompare', 'twelveData', 'finnhub', 'alphaVantage', 'fmp']
  }
};

let state = {
  currentTF: '15m',
  lastPrice: null,
  prevPrice: null,
  klineHistory: {},
  signalHistory: (() => {
    try {
      return JSON.parse(localStorage.getItem('pt_v4_signals') || '[]');
    } catch (e) {
      console.warn('Error al leer historial de localStorage, reiniciando:', e);
      return [];
    }
  })(),
  providers: {},
  providerStats: {},
  currentProvider: null,
  autoRefresh: null,
  lastFetchTime: null,
  currentData: null,
  logs: [],
  activeSignals: {},
  lastSignalAt: {},
  spreadHistory: (() => {
    try { return JSON.parse(localStorage.getItem('pt_spread_history') || '{}'); }
    catch (e) { return {}; }
  })(),
  // v2: umbral de confianza auto-ajustado POR SÍMBOLO (antes era un único valor global).
  // Migra el valor legado (single-threshold) como semilla para todos los símbolos si existe.
  autoConfidenceThreshold: (() => {
    try {
      const v2 = JSON.parse(localStorage.getItem('pt_auto_threshold_v2') || 'null');
      if (v2 && typeof v2 === 'object') return v2;
    } catch (e) { /* ignorar y usar semilla */ }
    const legacy = parseFloat(localStorage.getItem('pt_auto_threshold'));
    const seed = !isNaN(legacy) ? legacy : CONFIG.CONFIDENCE_THRESHOLD;
    const obj = {};
    Object.keys(ASSETS).forEach(sym => { obj[sym] = seed; });
    return obj;
  })(),
  // v2: estadísticas de auto-ajuste por símbolo: { [symbol]: { sampleSize, lastWinRate, lastExpectancy } }
  autoTuneStats: (() => {
    try { return JSON.parse(localStorage.getItem('pt_auto_stats_v2') || '{}'); }
    catch (e) { return {}; }
  })(),
  // Acierto histórico por patrón SMC: { [patternKey]: { wins, losses } }, usado para ponderar
  // la confianza de cada patrón según su rendimiento real registrado.
  patternStats: (() => {
    try { return JSON.parse(localStorage.getItem('pt_pattern_stats') || '{}'); }
    catch (e) { return {}; }
  })(),
  // Semilla de backtesting real (Binance BTC/ETH): solo se usa mientras el aprendizaje en vivo
  // de cada símbolo/patrón no tenga muestra suficiente propia. Ver getEffectivePatternStats()
  // y getThresholdForSymbol().
  backtestPatternStats: (() => {
    try { return JSON.parse(localStorage.getItem('pt_backtest_pattern_stats') || '{}'); }
    catch (e) { return {}; }
  })(),
  backtestAutoTune: (() => {
    try { return JSON.parse(localStorage.getItem('pt_backtest_autotune') || '{}'); }
    catch (e) { return {}; }
  })(),
  backtestRunning: false,
  soundEnabled: localStorage.getItem('pt_sound_enabled') !== 'false',
  persistKeys: localStorage.getItem('pt_persist_keys') === 'true',
  strictMode: localStorage.getItem('pt_strict_mode') === 'true',
  apiKeys: {
    twelveData: localStorage.getItem('pt_api_twelve') || null,
    finnhub: localStorage.getItem('pt_api_finnhub') || null,
    alphaVantage: localStorage.getItem('pt_api_alpha') || null,
    fmp: localStorage.getItem('pt_api_fmp') || null
  },
  refreshPaused: false,
  wakeLock: null
};

function getNow() { return new Date(); }

function getThresholdForSymbol(symbol, regime = null) {
  const cfg = CONFIG.AUTO_TUNE;
  // 1) Umbral específico por régimen (tendencia/rango), solo si ESE símbolo+régimen ya
  //    acumuló su propia muestra suficiente. El sistema puede rendir muy distinto en
  //    tendencia que en rango, así que conviene no promediarlos cuando hay datos para separar.
  if (regime && regime !== 'unknown') {
    const regimeKey = symbol + '_' + regime;
    const regimeStats = state.autoTuneStats[regimeKey];
    if (regimeStats && regimeStats.sampleSize >= cfg.minSampleSize && state.autoConfidenceThreshold[regimeKey] != null) {
      return state.autoConfidenceThreshold[regimeKey];
    }
    // Sin muestra real propia todavía para este símbolo+régimen: si el backtest generó una
    // semilla específica para ese régimen, se usa como punto de partida en vez de mezclar
    // tendencia y rango en el umbral combinado del símbolo.
    const btRegime = state.backtestAutoTune && state.backtestAutoTune[regimeKey];
    if (btRegime && btRegime.threshold) return btRegime.threshold;
  }
  const liveStats = state.autoTuneStats[symbol];
  const liveReady = liveStats && liveStats.sampleSize >= cfg.minSampleSize;
  // Si el aprendizaje EN VIVO de este símbolo ya tiene muestra real suficiente, manda él
  // (es la fuente de verdad). Si no, y hay una calibración por backtest disponible, se usa
  // como punto de partida en vez del umbral base fijo.
  if (!liveReady) {
    const bt = state.backtestAutoTune && state.backtestAutoTune[symbol];
    if (bt && bt.threshold) return bt.threshold;
  }
  return (state.autoConfidenceThreshold && state.autoConfidenceThreshold[symbol]) || CONFIG.CONFIDENCE_THRESHOLD;
}

// Combina el acierto por patrón aprendido EN VIVO con la semilla de backtest: el patrón que ya
// tenga muestra real suficiente (PATTERN_MIN_SAMPLE) usa solo sus datos en vivo; el que todavía
// no, usa la semilla histórica si existe. Nunca se suman ambos (evita contar señales duplicadas
// entre backtest y operaciones reales).
function getEffectivePatternStats() {
  const cfg = CONFIG.AUTO_TUNE;
  const merged = {};
  const keys = new Set([...Object.keys(state.patternStats || {}), ...Object.keys(state.backtestPatternStats || {})]);
  keys.forEach(key => {
    const live = state.patternStats[key];
    const liveTotal = live ? (live.wins || 0) + (live.losses || 0) : 0;
    if (liveTotal >= cfg.PATTERN_MIN_SAMPLE) { merged[key] = live; return; }
    const bt = state.backtestPatternStats[key];
    if (bt) { merged[key] = bt; return; }
    if (live) merged[key] = live;
  });
  return merged;
}

function saveAutoTuneState() {
  localStorage.setItem('pt_auto_threshold_v2', JSON.stringify(state.autoConfidenceThreshold));
  localStorage.setItem('pt_auto_stats_v2', JSON.stringify(state.autoTuneStats));
}

// Reinicia el auto-ajuste a sus valores por defecto (umbral base para todos los símbolos,
// estadísticas y pesos por patrón vacíos). Útil si el umbral quedó "atascado" cerca del máximo
// por una mala racha antigua y las señales dejaron de aparecer.
function resetAutoTune() {
  const obj = {};
  Object.keys(ASSETS).forEach(sym => { obj[sym] = CONFIG.CONFIDENCE_THRESHOLD; });
  state.autoConfidenceThreshold = obj;
  state.autoTuneStats = {};
  state.patternStats = {};
  localStorage.setItem('pt_auto_threshold_v2', JSON.stringify(obj));
  localStorage.setItem('pt_auto_stats_v2', JSON.stringify({}));
  localStorage.setItem('pt_pattern_stats', JSON.stringify({}));
  renderAutoTuneStatus();
  Object.keys(ASSETS).forEach(sym => renderAutoTuneStatus(sym));
  refreshAllData(true);
  BacktestEngine.runAll(true); // reinicio manual: recalibra ya con historial real en vez de esperar
}

// Límites conocidos del plan free de cada proveedor (peticiones/día). Alpha Vantage es el más
// restrictivo (25/día en el plan free actual) y es fácil agotarlo sin darse cuenta si queda como
// fallback activo durante todo el día. Esto solo avisa en la UI, no bloquea peticiones.
const PROVIDER_DAILY_LIMITS = {
  twelveData: 800,
  finnhub: null,       // límite por minuto (60/min), no diario: no se trackea acá
  alphaVantage: 25,
  fmp: 250
};

const RequestTracker = {
  todayKey() { return 'pt_req_count_' + new Date().toISOString().slice(0, 10); },
  load() {
    try { return JSON.parse(localStorage.getItem(this.todayKey()) || '{}'); }
    catch (e) { return {}; }
  },
  record(providerName) {
    if (!providerName || !(providerName in PROVIDER_DAILY_LIMITS)) return;
    const counts = this.load();
    counts[providerName] = (counts[providerName] || 0) + 1;
    try { localStorage.setItem(this.todayKey(), JSON.stringify(counts)); } catch (e) { /* ignorar */ }
  },
  getUsage(providerName) {
    const counts = this.load();
    const used = counts[providerName] || 0;
    const limit = PROVIDER_DAILY_LIMITS[providerName];
    return { used, limit, pct: limit ? used / limit : 0 };
  }
};

async function fetchWithTimeout(url, timeout = CONFIG.REQUEST_TIMEOUT, options = {}, providerName = null) {
  RequestTracker.record(providerName);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error('Timeout: sin respuesta del proveedor');
    throw error;
  }
}

function getAssetLocalTime(asset) {
  const now = getNow();
  if (asset.timezone === 'UTC') return now;
  try { return new Date(now.toLocaleString('en-US', { timeZone: asset.timezone })); }
  catch(e) { return now; }
}

function isForexWeekOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 0) return hour >= 22;
  if (day === 5) return hour < 22;
  return true;
}

const FX_SESSIONS = [
  { key: 'sydney',  label: 'Sídney',     start: 21, end: 6  },
  { key: 'tokyo',   label: 'Tokio',      start: 0,  end: 9  },
  { key: 'london',  label: 'Londres',    start: 7,  end: 16 },
  { key: 'newyork', label: 'Nueva York', start: 12, end: 21 }
];

function getActiveForexSessions() {
  if (!isForexWeekOpen()) return [];
  const hour = new Date().getUTCHours();
  return FX_SESSIONS.filter(s => s.start < s.end
    ? (hour >= s.start && hour < s.end)
    : (hour >= s.start || hour < s.end)
  );
}

function isMarketOpenForAsset(symbol) {
  const asset = ASSETS[symbol];
  if (!asset) return false;
  if (asset.is24h) return true;
  if (asset.market === 'forex') return isForexWeekOpen();
  const localTime = getAssetLocalTime(asset);
  const day = localTime.getDay();
  const hour = localTime.getHours();
  if (!asset.openDays.includes(day)) return false;
  if (hour < asset.openHour || hour >= asset.closeHour) return false;
  return true;
}

function getNextMarketOpen(asset) {
  if (asset.market === 'forex') {
    return `Dom 22:00 UTC (apertura de Sídney)`;
  }
  let next = new Date(getAssetLocalTime(asset));
  let daysChecked = 0;
  while (daysChecked < 7) {
    next.setDate(next.getDate() + 1);
    next.setHours(asset.openHour, 0, 0, 0);
    if (asset.openDays.includes(next.getDay())) break;
    daysChecked++;
  }
  const days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  return `${days[next.getDay()]} ${String(next.getHours()).padStart(2,'0')}:00 ${asset.timezone}`;
}

function formatTradingHours(asset) {
  if (asset.is24h) return '24/7';
  if (asset.market === 'forex') return 'Dom 22:00 - Vie 22:00 UTC (Sídney→Tokio→Londres→NY)';
  const days = asset.openDays.map(d => ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d]).join(',');
  return `${days} ${String(asset.openHour).padStart(2,'0')}:00-${String(asset.closeHour).padStart(2,'0')}:00 ${asset.timezone}`;
}

function calculateSpread(bid, ask, pipSize = 0.0001) {
  if (!bid || !ask || bid <= 0 || ask <= 0) return null;
  return (ask - bid) / pipSize;
}

function addLog(provider, action, symbol) {
  const entry = { time: new Date().toLocaleTimeString('es-ES'), provider, action, symbol };
  state.logs.unshift(entry);
  if (state.logs.length > 20) state.logs.pop();
}

const ResponseCache = {
  data: {},
  get(key) {
    const entry = this.data[key];
    if (!entry) return null;
    if (Date.now() - entry.time > CONFIG.CACHE_TTL) {
      delete this.data[key];
      return null;
    }
    return entry.value;
  },
  set(key, value) {
    this.data[key] = { time: Date.now(), value };
  },
  clear() {
    this.data = {};
  },
  clearSymbol(symbol) {
    Object.keys(this.data).forEach(key => {
      if (key.includes(symbol)) delete this.data[key];
    });
  }
};

const ProviderAdapters = {
  binanceSpot: {
    name: 'Binance Spot',
    requiresKey: false,
    supports: ['BTCUSD','ETHUSD'],
    async fetchQuote(symbol) {
      const asset = ASSETS[symbol];
      const cacheKey = `bs_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.BINANCE_SPOT}/ticker/24hr?symbol=${asset.symbols.binance}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const data = new MarketData({
        bid: parseFloat(d.bidPrice),
        ask: parseFloat(d.askPrice),
        last: parseFloat(d.lastPrice),
        open: parseFloat(d.openPrice),
        high: parseFloat(d.highPrice),
        low: parseFloat(d.lowPrice),
        close: parseFloat(d.prevClosePrice),
        volume: parseFloat(d.volume),
        timestamp: Date.now(),
        timeframe: '1d',
        marketStatus: 'open',
        spread: calculateSpread(parseFloat(d.bidPrice), parseFloat(d.askPrice), asset.pipSize),
        source: 'Binance Spot',
        symbol,
        estimatedSpread: false
      });
      ResponseCache.set(cacheKey, data);
      return data;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      const asset = ASSETS[symbol];
      const cacheKey = `bs_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const tfMap = { '5m': '5m', '15m': '15m', '1h': '1h' };
      const res = await fetchWithTimeout(
        `${CONFIG.ENDPOINTS.BINANCE_SPOT}/klines?symbol=${asset.symbols.binance}&interval=${tfMap[interval]||'15m'}&limit=${limit}`
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const result = new OHLCVData(data.map(k => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
      })));
      ResponseCache.set(cacheKey, result);
      return result;
    }
  },

  binanceFutures: {
    name: 'Binance Futures',
    requiresKey: false,
    supports: ['BTCUSD','ETHUSD'],
    async fetchQuote(symbol) {
      const asset = ASSETS[symbol];
      const cacheKey = `bf_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.BINANCE_FUTURES}/ticker/24hr?symbol=${asset.symbols.binance}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const data = new MarketData({
        bid: parseFloat(d.bidPrice), ask: parseFloat(d.askPrice), last: parseFloat(d.lastPrice),
        open: parseFloat(d.openPrice), high: parseFloat(d.highPrice), low: parseFloat(d.lowPrice),
        close: parseFloat(d.prevClosePrice), volume: parseFloat(d.volume),
        timestamp: Date.now(), timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(parseFloat(d.bidPrice), parseFloat(d.askPrice), asset.pipSize),
        source: 'Binance Futures', symbol,
        estimatedSpread: false
      });
      ResponseCache.set(cacheKey, data);
      return data;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      const asset = ASSETS[symbol];
      const cacheKey = `bf_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const tfMap = { '5m': '5m', '15m': '15m', '1h': '1h' };
      const res = await fetchWithTimeout(
        `${CONFIG.ENDPOINTS.BINANCE_FUTURES}/klines?symbol=${asset.symbols.binance}&interval=${tfMap[interval]||'15m'}&limit=${limit}`
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const result = new OHLCVData(data.map(k => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
      })));
      ResponseCache.set(cacheKey, result);
      return result;
    }
  },

  cryptocompare: {
    name: 'CryptoCompare',
    requiresKey: false,
    supports: ['BTCUSD','ETHUSD','XAUUSD','EURUSD'],
    async fetchQuote(symbol) {
      const asset = ASSETS[symbol];
      const fsym = asset.symbols.cryptocompare;
      const cacheKey = `cc_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.CRYPTOCOMPARE}/pricemultifull?fsyms=${fsym}&tsyms=USD`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const d = data.RAW[fsym].USD;
      const marketData = new MarketData({
        bid: d.BID, ask: d.ASK, last: d.PRICE,
        open: d.OPEN24HOUR || d.PRICE, high: d.HIGH24HOUR, low: d.LOW24HOUR,
        close: d.PRICE, volume: d.VOLUME24HOURTO,
        timestamp: d.LASTUPDATE * 1000, timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(d.BID, d.ASK, asset.pipSize),
        source: 'CryptoCompare', symbol,
        estimatedSpread: false
      });
      ResponseCache.set(cacheKey, marketData);
      return marketData;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      const asset = ASSETS[symbol];
      const fsym = asset.symbols.cryptocompare;
      const cacheKey = `cc_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const tfMap = { '5m': '5', '15m': '15', '1h': '60' };
      const res = await fetchWithTimeout(
        `${CONFIG.ENDPOINTS.CRYPTOCOMPARE}/v2/histominute?fsym=${fsym}&tsym=USD&limit=${limit}&aggregate=${tfMap[interval]||'15'}`
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.Response !== 'Success') throw new Error(data.Message);
      const result = new OHLCVData(data.Data.Data.map(k => ({
        time: k.time * 1000, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volumefrom
      })));
      ResponseCache.set(cacheKey, result);
      return result;
    }
  },

  exchangerate: {
    name: 'ExchangeRate-API',
    requiresKey: false,
    supports: ['EURUSD'],
    async fetchQuote(symbol) {
      const asset = ASSETS[symbol];
      const cacheKey = `er_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.EXCHANGERATE}/USD`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const rate = data.rates[asset.symbols.exchangerate];
      if (!rate) throw new Error('Rate not found');
      const price = 1 / rate;
      const marketData = new MarketData({
        bid: price * 0.9995, ask: price * 1.0005, last: price,
        open: price, high: price, low: price, close: price, volume: 0,
        timestamp: Date.now(), timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(price * 0.9995, price * 1.0005, asset.pipSize),
        source: 'ExchangeRate-API', symbol,
        estimatedSpread: true
      });
      ResponseCache.set(cacheKey, marketData);
      return marketData;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      throw new Error('ExchangeRate-API no soporta datos históricos');
    }
  },

  twelveData: {
    name: 'Twelve Data',
    requiresKey: true,
    supports: ['BTCUSD','ETHUSD','EURUSD','XAUUSD'],
    async fetchQuote(symbol) {
      if (!state.apiKeys.twelveData) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `td_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const headers = new Headers();
      headers.append('Authorization', `apikey ${state.apiKeys.twelveData}`);
      const res = await fetchWithTimeout(
        `${CONFIG.ENDPOINTS.TWELVEDATA}/quote?symbol=${asset.symbols.twelveData}`,
        CONFIG.REQUEST_TIMEOUT,
        { headers },
        'twelveData'
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      if (d.status === 'error') throw new Error(d.message || 'Error de Twelve Data');
      const data = new MarketData({
        bid: parseFloat(d.bid), ask: parseFloat(d.ask), last: parseFloat(d.price),
        open: parseFloat(d.open), high: parseFloat(d.high), low: parseFloat(d.low),
        close: parseFloat(d.previous_close), volume: parseFloat(d.volume),
        timestamp: Date.now(), timeframe: '1d', marketStatus: d.is_market_open ? 'open' : 'closed',
        spread: calculateSpread(parseFloat(d.bid), parseFloat(d.ask), asset.pipSize),
        source: 'Twelve Data', symbol,
        estimatedSpread: false
      });
      ResponseCache.set(cacheKey, data);
      return data;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      if (!state.apiKeys.twelveData) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `td_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const tfMap = { '5m': '5min', '15m': '15min', '1h': '1h' };
      const headers = new Headers();
      headers.append('Authorization', `apikey ${state.apiKeys.twelveData}`);
      const res = await fetchWithTimeout(
        `${CONFIG.ENDPOINTS.TWELVEDATA}/time_series?symbol=${asset.symbols.twelveData}&interval=${tfMap[interval]||'15min'}&outputsize=${limit}`,
        CONFIG.REQUEST_TIMEOUT,
        { headers },
        'twelveData'
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.status === 'error') throw new Error(data.message || 'Error de Twelve Data');
      const result = new OHLCVData(data.values.reverse().map(k => ({
        time: new Date(k.datetime).getTime(), open: parseFloat(k.open), high: parseFloat(k.high),
        low: parseFloat(k.low), close: parseFloat(k.close), volume: parseFloat(k.volume)
      })));
      ResponseCache.set(cacheKey, result);
      return result;
    }
  },

  finnhub: {
    name: 'Finnhub',
    requiresKey: true,
    supports: ['BTCUSD','ETHUSD','EURUSD','XAUUSD'],
    async fetchQuote(symbol) {
      if (!state.apiKeys.finnhub) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `fh_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const res = await fetchWithTimeout(
        `${CONFIG.ENDPOINTS.FINNHUB}/quote?symbol=${asset.symbols.finnhub}&token=${state.apiKeys.finnhub}`
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      const price = d.c;
      const bid = price * 0.9995;
      const ask = price * 1.0005;
      const data = new MarketData({
        bid: bid, ask: ask, last: price,
        open: d.o, high: d.h, low: d.l, close: d.pc,
        volume: d.v, timestamp: Date.now(), timeframe: '1d',
        marketStatus: 'open', spread: calculateSpread(bid, ask, asset.pipSize),
        source: 'Finnhub', symbol,
        estimatedSpread: true
      });
      ResponseCache.set(cacheKey, data);
      return data;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      if (!state.apiKeys.finnhub) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `fh_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const tfMap = { '5m': '5', '15m': '15', '1h': '60' };
      const now = Math.floor(Date.now() / 1000);
      const from = now - (limit * parseInt(tfMap[interval]||'15') * 60);
      const res = await fetchWithTimeout(
        `${CONFIG.ENDPOINTS.FINNHUB}/stock/candle?symbol=${asset.symbols.finnhub}&resolution=${tfMap[interval]||'15'}&from=${from}&to=${now}&token=${state.apiKeys.finnhub}`
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.s !== 'ok') throw new Error('Sin datos de velas');
      const result = new OHLCVData(data.t.map((t, i) => ({
        time: t * 1000, open: data.o[i], high: data.h[i], low: data.l[i], close: data.c[i], volume: data.v[i]
      })));
      ResponseCache.set(cacheKey, result);
      return result;
    }
  },

  alphaVantage: {
    name: 'Alpha Vantage',
    requiresKey: true,
    supports: ['BTCUSD','ETHUSD','EURUSD','XAUUSD'],
    async fetchQuote(symbol) {
      if (!state.apiKeys.alphaVantage) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `av_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      let url;
      if (asset.type === 'crypto') {
        url = `${CONFIG.ENDPOINTS.ALPHAVANTAGE}?function=CURRENCY_EXCHANGE_RATE&from_currency=${asset.symbols.alphaVantage}&to_currency=USD&apikey=${state.apiKeys.alphaVantage}`;
      } else {
        const fromCurr = asset.symbols.alphaVantage === 'EURUSD' ? 'EUR' : 'XAU';
        url = `${CONFIG.ENDPOINTS.ALPHAVANTAGE}?function=CURRENCY_EXCHANGE_RATE&from_currency=${fromCurr}&to_currency=USD&apikey=${state.apiKeys.alphaVantage}`;
      }
      const res = await fetchWithTimeout(url, CONFIG.REQUEST_TIMEOUT, {}, 'alphaVantage');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data['Error Message']) throw new Error(data['Error Message']);
      const d = data['Realtime Currency Exchange Rate'];
      if (!d) throw new Error('Respuesta inesperada de Alpha Vantage');
      const price = parseFloat(d['5. Exchange Rate']);
      const marketData = new MarketData({
        bid: price * 0.9995, ask: price * 1.0005, last: price,
        open: price, high: price, low: price, close: price, volume: 0,
        timestamp: Date.now(), timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(price * 0.9995, price * 1.0005, asset.pipSize),
        source: 'Alpha Vantage', symbol,
        estimatedSpread: true
      });
      ResponseCache.set(cacheKey, marketData);
      return marketData;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      if (!state.apiKeys.alphaVantage) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `av_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const tfMap = { '5m': '5min', '15m': '15min', '1h': '60min' };
      let url;
      if (asset.type === 'crypto') {
        url = `${CONFIG.ENDPOINTS.ALPHAVANTAGE}?function=CRYPTO_INTRADAY&symbol=${asset.symbols.alphaVantage}&market=USD&interval=${tfMap[interval]||'15min'}&apikey=${state.apiKeys.alphaVantage}`;
      } else {
        const fromSym = asset.symbols.alphaVantage === 'EURUSD' ? 'EUR' : 'XAU';
        url = `${CONFIG.ENDPOINTS.ALPHAVANTAGE}?function=FX_INTRADAY&from_symbol=${fromSym}&to_symbol=USD&interval=${tfMap[interval]||'15min'}&apikey=${state.apiKeys.alphaVantage}`;
      }
      const res = await fetchWithTimeout(url, CONFIG.REQUEST_TIMEOUT, {}, 'alphaVantage');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data['Error Message']) throw new Error(data['Error Message']);
      const key = Object.keys(data).find(k => k.includes('Time Series'));
      if (!key) throw new Error('Sin datos históricos');
      const result = new OHLCVData(Object.entries(data[key]).slice(0, limit).reverse().map(([time, vals]) => ({
        time: new Date(time).getTime(), open: parseFloat(vals['1. open']), high: parseFloat(vals['2. high']),
        low: parseFloat(vals['3. low']), close: parseFloat(vals['4. close']), volume: parseFloat(vals['5. volume'] || 0)
      })));
      ResponseCache.set(cacheKey, result);
      return result;
    }
  },

  fmp: {
    name: 'Financial Modeling Prep',
    requiresKey: true,
    supports: ['BTCUSD','ETHUSD','EURUSD','XAUUSD'],
    async fetchQuote(symbol) {
      if (!state.apiKeys.fmp) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `fmp_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const res = await fetchWithTimeout(
        `${CONFIG.ENDPOINTS.FMP}/quote/${asset.symbols.fmp}?apikey=${state.apiKeys.fmp}`,
        CONFIG.REQUEST_TIMEOUT, {}, 'fmp'
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data['Error Message']) throw new Error(data['Error Message']);
      const d = data[0];
      if (!d) throw new Error('Sin datos');
      const price = d.price;
      const bid = price * 0.9995;
      const ask = price * 1.0005;
      const marketData = new MarketData({
        bid: bid, ask: ask, last: price,
        open: d.open, high: d.dayHigh, low: d.dayLow, close: d.previousClose,
        volume: d.volume, timestamp: Date.now(), timeframe: '1d',
        marketStatus: d.isMarketOpen ? 'open' : 'closed',
        spread: calculateSpread(bid, ask, asset.pipSize),
        source: 'FMP', symbol,
        estimatedSpread: true
      });
      ResponseCache.set(cacheKey, marketData);
      return marketData;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      if (!state.apiKeys.fmp) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `fmp_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey);
      if (cached) return cached;

      const res = await fetchWithTimeout(
        `${CONFIG.ENDPOINTS.FMP}/historical-chart/${interval === '5m' ? '5min' : interval === '15m' ? '15min' : '1hour'}/${asset.symbols.fmp}?apikey=${state.apiKeys.fmp}`,
        CONFIG.REQUEST_TIMEOUT, {}, 'fmp'
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data['Error Message']) throw new Error(data['Error Message']);
      const result = new OHLCVData(data.slice(0, limit).reverse().map(k => ({
        time: new Date(k.date).getTime(), open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
      })));
      ResponseCache.set(cacheKey, result);
      return result;
    }
  }
};

const MarketDataProvider = {
  async getQuote(symbol, forceRefresh = false) {
    const asset = ASSETS[symbol];
    if (!asset) throw new Error('Activo no configurado: ' + symbol);
    if (!isMarketOpenForAsset(symbol)) throw new Error('MERCADO_CERRADO');

    const providerList = asset.providerPriority || CONFIG.PROVIDER_PRIORITY;
    const eligible = providerList.filter(providerName => {
      const adapter = ProviderAdapters[providerName];
      if (!adapter) return false;
      if (!adapter.supports.includes(symbol)) return false;
      if (adapter.requiresKey && !state.apiKeys[providerName]) return false;
      return true;
    });

    if (eligible.length === 0) throw new Error(`Datos de mercado temporalmente no disponibles para ${symbol}.`);

    const attempts = eligible.map(providerName => {
      const adapter = ProviderAdapters[providerName];
      addLog(adapter.name, 'INTENTO', symbol);
      return adapter.fetchQuote(symbol)
        .then(data => {
          if (!data.isValid) throw new Error('Datos inválidos');
          state.providers[providerName] = 'ok';
          state.providerStats[providerName] = {
            lastSuccess: Date.now(),
            successCount: (state.providerStats[providerName]?.successCount || 0) + 1
          };
          addLog(adapter.name, 'ÉXITO', symbol);
          return { providerName, data };
        })
        .catch(error => {
          state.providers[providerName] = 'fail';
          state.providerStats[providerName] = {
            lastSuccess: state.providerStats[providerName]?.lastSuccess || null,
            lastError: Date.now(),
            errorCount: (state.providerStats[providerName]?.errorCount || 0) + 1,
            lastErrorMsg: error.message
          };
          addLog(adapter.name, 'FALLO: ' + error.message, symbol);
          console.warn(`Provider ${providerName} falló para ${symbol}:`, error.message);
          throw error;
        });
    });

    try {
      const { providerName, data } = await Promise.any(attempts);
      state.currentProvider = providerName;
      state.currentData = data;
      return data;
    } catch (aggregateError) {
      const errors = aggregateError.errors || [];
      const detailMessages = errors.map((e, i) => {
        const name = eligible[i] || 'desconocido';
        return `${name}: ${e.message}`;
      }).join('; ');
      throw new Error(`Todos los proveedores fallaron: ${detailMessages}`);
    }
  },

  async getOHLCV(symbol, tf, limit = 100, forceRefresh = false) {
    const asset = ASSETS[symbol];
    if (!asset) return new OHLCVData([]);
    if (!isMarketOpenForAsset(symbol)) return state.klineHistory[symbol] || new OHLCVData([]);

    const providerList = asset.providerPriority || CONFIG.PROVIDER_PRIORITY;
    const eligible = providerList.filter(providerName => {
      const adapter = ProviderAdapters[providerName];
      return adapter && adapter.fetchOHLCV && adapter.supports.includes(symbol) &&
        !(adapter.requiresKey && !state.apiKeys[providerName]);
    });

    if (eligible.length > 0) {
      const attempts = eligible.map(providerName =>
        ProviderAdapters[providerName].fetchOHLCV(symbol, tf, limit)
          .then(data => {
            if (!data.isValid) throw new Error('Datos insuficientes');
            return data;
          })
          .catch(error => {
            console.warn(`OHLCV ${providerName} falló:`, error.message);
            throw error;
          })
      );
      try {
        const data = await Promise.any(attempts);
        state.klineHistory[symbol] = data;
        return data;
      } catch (aggregateError) {
        if (state.klineHistory[symbol] && state.klineHistory[symbol].candles.length > 0) {
          return state.klineHistory[symbol];
        }
        throw new Error(`No se pudieron obtener velas históricas: ${aggregateError.errors.map(e=>e.message).join('; ')}`);
      }
    }

    if (state.klineHistory[symbol] && state.klineHistory[symbol].candles.length > 0) {
      return state.klineHistory[symbol];
    }

    throw new Error('No hay datos históricos disponibles');
  },

  setApiKey(provider, key) {
    state.apiKeys[provider] = key;
    if (state.persistKeys) {
      const storageKey = { twelveData: 'pt_api_twelve', finnhub: 'pt_api_finnhub', alphaVantage: 'pt_api_alpha', fmp: 'pt_api_fmp' }[provider];
      if (storageKey) localStorage.setItem(storageKey, key);
    }
  }
};

// Detección de régimen de mercado (tendencia vs. rango) usando el Efficiency Ratio de Kaufman:
// ER = |movimiento neto| / (suma de movimientos absolutos vela a vela) sobre las últimas N velas.
// ER cerca de 1 = movimiento direccional limpio (tendencia). ER cerca de 0 = mucho ida y vuelta
// sin avance neto (rango/choppy). Liviano de calcular, sin librerías externas.
function detectMarketRegime(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 'unknown';
  const slice = candles.slice(-(period + 1));
  const netMove = Math.abs(slice[slice.length - 1].close - slice[0].close);
  let volatilitySum = 0;
  for (let i = 1; i < slice.length; i++) {
    volatilitySum += Math.abs(slice[i].close - slice[i - 1].close);
  }
  if (volatilitySum === 0) return 'ranging';
  const er = netMove / volatilitySum;
  return er >= 0.35 ? 'trending' : 'ranging';
}

class SMCEngine {
  static findSwingHighs(candles, leftBars = 3, rightBars = 3) {
    const swings = [];
    for (let i = leftBars; i < candles.length - rightBars; i++) {
      let isSwing = true;
      for (let j = 1; j <= leftBars; j++) if (candles[i].high <= candles[i-j].high) isSwing = false;
      for (let j = 1; j <= rightBars; j++) if (candles[i].high <= candles[i+j].high) isSwing = false;
      if (isSwing) swings.push({ index: i, price: candles[i].high, time: candles[i].time, type: 'high' });
    }
    return swings;
  }

  static findSwingLows(candles, leftBars = 3, rightBars = 3) {
    const swings = [];
    for (let i = leftBars; i < candles.length - rightBars; i++) {
      let isSwing = true;
      for (let j = 1; j <= leftBars; j++) if (candles[i].low >= candles[i-j].low) isSwing = false;
      for (let j = 1; j <= rightBars; j++) if (candles[i].low >= candles[i+j].low) isSwing = false;
      if (isSwing) swings.push({ index: i, price: candles[i].low, time: candles[i].time, type: 'low' });
    }
    return swings;
  }

  static detectBOS(candles, swingHighs, swingLows) {
    if (!candles || candles.length < 10 || swingHighs.length < 2 || swingLows.length < 2) {
      return { bullish: false, bearish: false, score: 0, details: [] };
    }
    const last = candles[candles.length - 1];
    const lastSH = swingHighs[swingHighs.length - 1];
    const lastSL = swingLows[swingLows.length - 1];

    let bullish = false, bearish = false;
    const details = [];

    if (last.close > lastSH.price) { bullish = true; details.push('BOS alcista'); }
    if (last.close < lastSL.price) { bearish = true; details.push('BOS bajista'); }

    return { bullish, bearish, score: (bullish || bearish) ? 20 : 0, details };
  }

  static detectCHoCH(candles, swingHighs, swingLows) {
    if (!candles || candles.length < 15 || swingHighs.length < 3 || swingLows.length < 3) {
      return { bullish: false, bearish: false, score: 0, details: [] };
    }
    const last = candles[candles.length - 1];
    const sh = swingHighs.slice(-3);
    const sl = swingLows.slice(-3);

    let bullish = false, bearish = false;
    const details = [];

    const lowerLows = sl[2].price < sl[1].price && sl[1].price < sl[0].price;
    const lastLH = sh[sh.length - 1];
    if (lowerLows && last.close > lastLH.price) {
      bullish = true;
      details.push('CHoCH alcista');
    }

    const higherHighs = sh[2].price > sh[1].price && sh[1].price > sh[0].price;
    const lastHL = sl[sl.length - 1];
    if (higherHighs && last.close < lastHL.price) {
      bearish = true;
      details.push('CHoCH bajista');
    }

    return { bullish, bearish, score: (bullish || bearish) ? 20 : 0, details };
  }

  static detectFVG(candles) {
    if (!candles || candles.length < 4) return { bullish: false, bearish: false, score: 0, details: [], bullZone: null, bearZone: null };
    const c1 = candles[candles.length - 4];
    const c3 = candles[candles.length - 2];
    const last = candles[candles.length - 1];

    let bullish = false, bearish = false;
    let bullZone = null, bearZone = null;
    const details = [];

    if (c3.low > c1.high && last.close > c3.low) {
      bullish = true;
      bullZone = { low: c1.high, high: c3.low };
      details.push('FVG alcista');
    }
    if (c3.high < c1.low && last.close < c3.high) {
      bearish = true;
      bearZone = { low: c3.high, high: c1.low };
      details.push('FVG bajista');
    }

    return { bullish, bearish, score: (bullish || bearish) ? 15 : 0, details, bullZone, bearZone };
  }

  static detectOrderBlocks(candles, atr) {
    if (!candles || candles.length < 5 || !atr) return { bullishOB: false, bearishOB: false, score: 0, details: [], bullZone: null, bearZone: null };
    const last = candles[candles.length - 1];
    const prev2 = candles[candles.length - 3];
    const prev3 = candles[candles.length - 4];

    let bullishOB = false, bearishOB = false;
    let bullZone = null, bearZone = null;
    const details = [];

    const impulsoUp = Math.abs(last.close - prev2.open) > atr * 1.5 && last.close > prev2.open;
    const impulsoDown = Math.abs(last.close - prev2.open) > atr * 1.5 && last.close < prev2.open;

    if (impulsoUp && prev3.close < prev3.open && prev2.close > prev2.open) {
      bullishOB = true;
      bullZone = { low: Math.min(prev2.open, prev2.close), high: Math.max(prev2.open, prev2.close) };
      details.push('Order Block alcista');
    }
    if (impulsoDown && prev3.close > prev3.open && prev2.close < prev2.open) {
      bearishOB = true;
      bearZone = { low: Math.min(prev2.open, prev2.close), high: Math.max(prev2.open, prev2.close) };
      details.push('Order Block bajista');
    }

    return { bullishOB, bearishOB, score: (bullishOB || bearishOB) ? 15 : 0, details, bullZone, bearZone };
  }

  static detectLiquiditySweep(candles, swingHighs, swingLows) {
    if (!candles || candles.length < 6 || swingHighs.length < 2 || swingLows.length < 2) {
      return { bullish: false, bearish: false, score: 0, details: [] };
    }
    const last = candles[candles.length - 1];
    const prevSH = swingHighs[swingHighs.length - 2];
    const lastSH = swingHighs[swingHighs.length - 1];
    const prevSL = swingLows[swingLows.length - 2];
    const lastSL = swingLows[swingLows.length - 1];

    let bullish = false, bearish = false;
    const details = [];

    if (last.low < lastSL.price && last.low < prevSL.price && last.close > lastSL.price) {
      bullish = true;
      details.push('Barrida de liquidez (mínimos)');
    }
    if (last.high > lastSH.price && last.high > prevSH.price && last.close < lastSH.price) {
      bearish = true;
      details.push('Barrida de liquidez (máximos)');
    }

    return { bullish, bearish, score: (bullish || bearish) ? 15 : 0, details };
  }

  // Patrón "V" (reversión en V): caída brusca hasta un mínimo local seguida de una recuperación
  // igual de brusca (V de piso, alcista), o su espejo: rally brusco hasta un máximo local
  // seguido de una caída igual de brusca (V invertida / techo, bajista). A diferencia de un
  // swing normal, exige que ambos tramos (bajada y subida, o subida y bajada) sean comparables
  // en magnitud y ocurran en pocas velas — es decir, un giro angosto y violento, no una
  // reversión gradual en varias velas.
  static detectVPattern(candles, atr, lookback = 14) {
    const empty = { bullish: false, bearish: false, score: 0, details: [] };
    if (!candles || candles.length < lookback + 1 || !atr) return empty;

    const window = candles.slice(-lookback);
    const last = window[window.length - 1];
    let troughIdx = 0, peakIdx = 0;
    for (let i = 1; i < window.length; i++) {
      if (window[i].low < window[troughIdx].low) troughIdx = i;
      if (window[i].high > window[peakIdx].high) peakIdx = i;
    }

    const minLegBars = 2;   // cada tramo (bajada/subida) necesita al menos 2 velas para no ser ruido
    const maxLegBars = 6;   // y no más de 6, para que sea un giro angosto y no una tendencia larga
    const steepMultiplier = 1.8; // cada tramo debe moverse al menos 1.8x ATR para considerarse "brusco"

    let bullish = false, bearish = false;
    const details = [];

    // V de piso: el mínimo del rango no puede estar pegado al borde (necesita tramo de bajada
    // antes y de subida después dentro del lookback).
    const downBars = troughIdx;
    const upBars = window.length - 1 - troughIdx;
    if (downBars >= minLegBars && downBars <= maxLegBars && upBars >= minLegBars && upBars <= maxLegBars) {
      const startHigh = window[0].high;
      const troughLow = window[troughIdx].low;
      const downMove = startHigh - troughLow;
      const upMove = last.close - troughLow;
      const symmetric = upMove >= downMove * 0.5; // la recuperación cubre al menos la mitad de la caída
      if (downMove >= atr * steepMultiplier && upMove >= atr * steepMultiplier && symmetric && last.close > last.open) {
        bullish = true;
        details.push('Patrón V (reversión en piso)');
      }
    }

    // V invertida / techo: mismo criterio, espejado.
    const upBarsToPeak = peakIdx;
    const downBarsFromPeak = window.length - 1 - peakIdx;
    if (upBarsToPeak >= minLegBars && upBarsToPeak <= maxLegBars && downBarsFromPeak >= minLegBars && downBarsFromPeak <= maxLegBars) {
      const startLow = window[0].low;
      const peakHigh = window[peakIdx].high;
      const upMove = peakHigh - startLow;
      const downMove = peakHigh - last.close;
      const symmetric = downMove >= upMove * 0.5;
      if (upMove >= atr * steepMultiplier && downMove >= atr * steepMultiplier && symmetric && last.close < last.open) {
        bearish = true;
        details.push('Patrón V invertida (reversión en techo)');
      }
    }

    return { bullish, bearish, score: (bullish || bearish) ? 15 : 0, details };
  }

  static calculatePivotPoints(candles) {
    if (!candles || candles.length < 10) return null;
    const byDay = {};
    candles.forEach(c => {
      const day = new Date(c.time).toISOString().slice(0, 10);
      (byDay[day] = byDay[day] || []).push(c);
    });
    const days = Object.keys(byDay).sort();
    const todayStr = new Date().toISOString().slice(0, 10);
    const completedDays = days.filter(d => d !== todayStr);

    let refCandles;
    if (completedDays.length > 0) {
      refCandles = byDay[completedDays[completedDays.length - 1]];
    } else {
      const half = Math.floor(candles.length / 2);
      refCandles = candles.slice(0, Math.max(half, 10));
    }

    const high = Math.max(...refCandles.map(c => c.high));
    const low = Math.min(...refCandles.map(c => c.low));
    const close = refCandles[refCandles.length - 1].close;

    const pivot = (high + low + close) / 3;
    return {
      pivot,
      r1: 2 * pivot - low,
      s1: 2 * pivot - high,
      r2: pivot + (high - low),
      s2: pivot - (high - low)
    };
  }

  static detectPivotBreakoutReversal(candles, pivots) {
    if (!candles || candles.length < 3 || !pivots) return { bullish: false, bearish: false, score: 0, details: [], level: null };
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const { r1, r2, s1, s2 } = pivots;
    let bullish = false, bearish = false, level = null;
    const details = [];

    if (prev.close <= r1 && last.close > r1) { bullish = true; level = 'R1'; details.push('Ruptura alcista de Pivot R1'); }
    else if (prev.close <= r2 && last.close > r2) { bullish = true; level = 'R2'; details.push('Ruptura alcista de Pivot R2'); }
    else if (last.low <= s1 && last.close > s1) { bullish = true; level = 'S1'; details.push('Reversión alcista en soporte Pivot S1'); }
    else if (last.low <= s2 && last.close > s2) { bullish = true; level = 'S2'; details.push('Reversión alcista en soporte Pivot S2'); }
    else if (prev.close >= s1 && last.close < s1) { bearish = true; level = 'S1'; details.push('Ruptura bajista de Pivot S1'); }
    else if (prev.close >= s2 && last.close < s2) { bearish = true; level = 'S2'; details.push('Ruptura bajista de Pivot S2'); }
    else if (last.high >= r1 && last.close < r1) { bearish = true; level = 'R1'; details.push('Reversión bajista en resistencia Pivot R1'); }
    else if (last.high >= r2 && last.close < r2) { bearish = true; level = 'R2'; details.push('Reversión bajista en resistencia Pivot R2'); }

    return { bullish, bearish, score: (bullish || bearish) ? 15 : 0, details, level };
  }

  static calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high, low = candles[i].low, prevClose = candles[i - 1].close;
      trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    const recent = trueRanges.slice(-period);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  static calculateEMA(candles, period) {
    if (!candles || candles.length < period) return null;
    const k = 2 / (period + 1);
    let ema = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) ema = candles[i].close * k + ema * (1 - k);
    return ema;
  }

  // WMA simple, usada como building block de la HMA (Hull Moving Average).
  static calculateWMA(values, period) {
    if (!values || values.length < period) return null;
    const slice = values.slice(-period);
    let weightedSum = 0, weightTotal = 0;
    for (let i = 0; i < slice.length; i++) {
      const weight = i + 1; // más peso a los valores recientes
      weightedSum += slice[i] * weight;
      weightTotal += weight;
    }
    return weightedSum / weightTotal;
  }

  // Serie completa de HMA sobre los cierres, punto a punto (necesaria porque el indicador
  // original de Pine Script consume el valor de HMA en cada vela, no solo el último).
  static calculateHMASeries(candles, period) {
    const closes = candles.map(c => c.close);
    const n = closes.length;
    const halfPeriod = Math.max(1, Math.round(period / 2));
    const sqrtPeriod = Math.max(1, Math.round(Math.sqrt(period)));
    const raw = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (i + 1 < period) continue;
      const slice = closes.slice(0, i + 1);
      const wmaHalf = this.calculateWMA(slice, halfPeriod);
      const wmaFull = this.calculateWMA(slice, period);
      if (wmaHalf === null || wmaFull === null) continue;
      raw[i] = 2 * wmaHalf - wmaFull;
    }
    const hma = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (raw[i] === null) continue;
      const rawSlice = raw.slice(0, i + 1).filter(v => v !== null);
      if (rawSlice.length < sqrtPeriod) continue;
      hma[i] = this.calculateWMA(rawSlice, sqrtPeriod);
    }
    return hma;
  }

  // Percentil "nearest rank", igual semántica que array.percentile_nearest_rank() de Pine Script.
  static percentileNearestRank(values, percentile) {
    if (!values || !values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((percentile / 100) * sorted.length);
    const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
    return sorted[idx];
  }

  // ------------------------------------------------------------------------------------------
  // Port del indicador "Reversal Signals & Trailing Stop [AlgoAlpha]" (Pine Script v6) a JS.
  // Recorre las velas en orden replicando el estado secuencial del script original (bandas de
  // reversión por percentil de movimientos direccionales + rechazo de mecha + trailing stop),
  // y devuelve si la ÚLTIMA vela cerrada disparó una señal alcista o bajista.
  // Parámetros por defecto = defaults del indicador original.
  static detectReversalBands(candles, opts = {}) {
    const midbandLength = opts.midbandLength || 50;
    const sampleMemory = opts.sampleMemory || 50;
    const movePercentile = opts.movePercentile || 90;
    const bandMultiplier = opts.bandMultiplier || 2.0;
    const atrLength = opts.atrLength || 14;
    const trailDistanceMultiplier = opts.trailDistanceMultiplier || 2.1;
    const invalidationBars = opts.invalidationBars || 2;
    const allowTrailInterruptions = !!opts.allowTrailInterruptions;

    const empty = { bullish: false, bearish: false };
    if (!candles || candles.length < midbandLength + 5) return empty;

    const hmaSeries = this.calculateHMASeries(candles, midbandLength);

    let bullishMoveBuild = 0, bearishMoveBuild = 0;
    const bullishMoves = [], bearishMoves = [];
    let trailDirection = 0, lastSignalDirection = 0, trailValue = null, outsideCount = 0;
    let lastBullishSignal = false, lastBearishSignal = false;

    // True Range para ATR "en vivo" (recalculado en cada paso, como ta.atr en Pine).
    const trueRanges = [];

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const midband = hmaSeries[i];

      if (i > 0) {
        const prevClose = candles[i - 1].close;
        trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
      }
      const atrWindow = trueRanges.slice(-atrLength);
      const atr = atrWindow.length ? atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length : null;

      const candleDirection = c.close > c.open ? 1 : -1;
      const candleBody = Math.abs(c.close - c.open);

      // Acumulación de movimientos direccionales (igual que el bloque bullish/bearish_move_build).
      if (candleDirection < 0) {
        if (bullishMoveBuild > 0) { bullishMoves.unshift(bullishMoveBuild); if (bullishMoves.length > sampleMemory) bullishMoves.pop(); }
        bullishMoveBuild = 0;
      } else {
        bullishMoveBuild += candleBody;
      }
      if (candleDirection > 0) {
        if (bearishMoveBuild > 0) { bearishMoves.unshift(bearishMoveBuild); if (bearishMoves.length > sampleMemory) bearishMoves.pop(); }
        bearishMoveBuild = 0;
      } else {
        bearishMoveBuild += candleBody;
      }

      lastBullishSignal = false;
      lastBearishSignal = false;
      if (midband === null || !atr) continue;

      const upperBand = this.percentileNearestRank(bullishMoves, movePercentile) * bandMultiplier + midband;
      const lowerBand = midband - this.percentileNearestRank(bearishMoves, movePercentile) * bandMultiplier;

      const closeInsideBands = c.close >= lowerBand && c.close <= upperBand;
      const bullishWickRejection = closeInsideBands && c.low < lowerBand;
      const bearishWickRejection = closeInsideBands && c.high > upperBand;

      const upperTrailSource = midband + (upperBand - midband) * trailDistanceMultiplier;
      const lowerTrailSource = midband - (midband - lowerBand) * trailDistanceMultiplier;

      const signalCanStart = trailDirection === 0 || allowTrailInterruptions;
      const bullishSignal = signalCanStart && bullishWickRejection && lastSignalDirection !== 1 && (!bearishWickRejection || c.close >= c.open);
      const bearishSignal = signalCanStart && bearishWickRejection && lastSignalDirection !== -1 && (!bullishWickRejection || c.close < c.open);

      if (bullishSignal) {
        trailDirection = 1; lastSignalDirection = 1; outsideCount = 0;
        const bullishStartDistance = Math.max(midband - lowerTrailSource, atr * trailDistanceMultiplier);
        trailValue = Math.min(midband - bullishStartDistance, c.low);
      } else if (bearishSignal) {
        trailDirection = -1; lastSignalDirection = -1; outsideCount = 0;
        const bearishStartDistance = Math.max(upperTrailSource - midband, atr * trailDistanceMultiplier);
        trailValue = Math.max(midband + bearishStartDistance, c.high);
      } else if (trailDirection === 1) {
        trailValue = Math.max(trailValue, lowerTrailSource);
        outsideCount = c.low < trailValue ? outsideCount + 1 : 0;
        if (outsideCount >= invalidationBars) { trailDirection = 0; trailValue = null; outsideCount = 0; }
      } else if (trailDirection === -1) {
        trailValue = Math.min(trailValue, upperTrailSource);
        outsideCount = c.high > trailValue ? outsideCount + 1 : 0;
        if (outsideCount >= invalidationBars) { trailDirection = 0; trailValue = null; outsideCount = 0; }
      }

      lastBullishSignal = bullishSignal;
      lastBearishSignal = bearishSignal;
    }

    return { bullish: lastBullishSignal, bearish: lastBearishSignal, trailDirection, trailValue };
  }

  static detectTrend(candles) {
    const ema20 = this.calculateEMA(candles, Math.min(20, Math.floor(candles.length / 2)));
    const ema50 = this.calculateEMA(candles, Math.min(50, candles.length - 1));
    if (ema20 === null || ema50 === null) return { direction: 'neutral', ema20, ema50 };
    if (ema20 > ema50 * 1.0005) return { direction: 'bullish', ema20, ema50 };
    if (ema20 < ema50 * 0.9995) return { direction: 'bearish', ema20, ema50 };
    return { direction: 'neutral', ema20, ema50 };
  }

  static isKillZone() {
    const utcHour = new Date().getUTCHours();
    const inLondon = utcHour >= 7 && utcHour < 10;
    const inNY = utcHour >= 12 && utcHour < 15;
    return inLondon || inNY;
  }

  // Filtro de volumen: exige que la vela actual supere el volumen promedio de las
  // últimas `lookback` velas por al menos `multiplier`. Si el activo no trae volumen
  // real (p. ej. forex spot vía algunos proveedores), no se bloquea la señal por esto:
  // simplemente no suma el bono ni actúa como gate (available: false).
  static checkVolumeConfirmation(candles, lookback = 20, multiplier = 1.2) {
    if (!candles || candles.length < lookback + 1) {
      return { confirmed: true, available: false, score: 0, ratio: null };
    }
    const last = candles[candles.length - 1];
    const prevCandles = candles.slice(-(lookback + 1), -1);
    const avgVolume = prevCandles.reduce((sum, c) => sum + (c.volume || 0), 0) / prevCandles.length;
    if (!avgVolume) {
      return { confirmed: true, available: false, score: 0, ratio: null };
    }
    const ratio = last.volume / avgVolume;
    const confirmed = ratio >= multiplier;
    return { confirmed, available: true, score: confirmed ? 10 : 0, ratio };
  }

  // Vela de confirmación (gate obligatorio, siempre activo): la última vela debe cerrar
  // a favor de la dirección de la señal y con cuerpo mínimo (evita dojis/indecisión).
  static checkConfirmationCandle(candles, direction, atr) {
    if (!direction || !candles || candles.length < 1) return { confirmed: false, bodyRatio: 0 };
    const last = candles[candles.length - 1];
    const body = Math.abs(last.close - last.open);
    const minBody = (atr || 0) * 0.3;
    const aligned = direction === 'long' ? last.close > last.open : last.close < last.open;
    const confirmed = aligned && body >= minBody;
    return { confirmed, bodyRatio: atr ? +(body / atr).toFixed(2) : 0 };
  }

  // Mitigación de OB/FVG (solo aplica en Modo Estricto): si la señal viene de un Order
  // Block o un FVG, exige que el precio esté retesteando esa zona (con margen de tolerancia)
  // en vez de perseguir el precio ya lejos de ella.
  static checkMitigation(candles, direction, ob, fvg, atr) {
    const zone = direction === 'long' ? (ob.bullZone || fvg.bullZone) : (ob.bearZone || fvg.bearZone);
    if (!zone) return { required: false, confirmed: true };
    const last = candles[candles.length - 1];
    const tolerance = (atr || 0) * 0.3;
    const confirmed = last.close >= zone.low - tolerance && last.close <= zone.high + tolerance;
    return { required: true, confirmed };
  }

  // Filtro de tendencia en timeframe superior (HTF): reutiliza detectTrend pero sobre velas
  // de un timeframe mayor. Si el HTF tiene una tendencia clara y contraria a la señal del
  // timeframe operativo, se bloquea — evita operar contra el sesgo dominante.
  static detectHTFTrend(htfCandles) {
    if (!htfCandles || htfCandles.length < 20) return null;
    return this.detectTrend(htfCandles);
  }

  // Premium/Discount con Fibonacci OTE (regla clásica ICT): dentro del rango reciente
  // (swing high a swing low de las últimas `lookback` velas), la mitad superior es "premium"
  // (zona para vender) y la mitad inferior es "discount" (zona para comprar). Nunca se debe
  // comprar en premium ni vender en descuento. La zona OTE (61.8%-79% de retroceso) es la
  // entrada óptima dentro de esa mitad favorable.
  static calculatePremiumDiscount(candles, lookback = 30) {
    if (!candles || candles.length < 10) return null;
    const slice = candles.slice(-Math.min(lookback, candles.length));
    const high = Math.max(...slice.map(c => c.high));
    const low = Math.min(...slice.map(c => c.low));
    const range = high - low;
    if (!range) return null;
    const equilibrium = low + range * 0.5;
    const last = candles[candles.length - 1];
    const zone = last.close > equilibrium ? 'premium' : 'discount';
    // OTE largo: retroceso 61.8%-79% medido desde el low hacia el high (zona de descuento profundo).
    const oteLongZone = { low: low + range * 0.618, high: low + range * 0.79 };
    // OTE corto: espejo, medido desde el high hacia el low (zona de premium profundo).
    const oteShortZone = { low: low + range * 0.21, high: low + range * 0.382 };
    const inOteLong = last.close >= oteLongZone.low && last.close <= oteLongZone.high;
    const inOteShort = last.close >= oteShortZone.low && last.close <= oteShortZone.high;
    return { high, low, equilibrium, zone, oteLongZone, oteShortZone, inOteLong, inOteShort };
  }

  static analyze(candles, strictMode = false, assetType = 'forex', htfCandles = null, confidenceThreshold = CONFIG.CONFIDENCE_THRESHOLD, patternStats = {}) {
    if (!candles || candles.length < 20) {
      return { valid: false, reason: 'Datos históricos insuficientes (se necesitan al menos 20 velas).' };
    }
    const swingHighs = this.findSwingHighs(candles);
    const swingLows = this.findSwingLows(candles);
    const atr = this.calculateATR(candles);
    const bos = this.detectBOS(candles, swingHighs, swingLows);
    const choch = this.detectCHoCH(candles, swingHighs, swingLows);
    const fvg = this.detectFVG(candles);
    const ob = this.detectOrderBlocks(candles, atr);
    const sweep = this.detectLiquiditySweep(candles, swingHighs, swingLows);
    const trend = this.detectTrend(candles);
    const killZone = this.isKillZone();
    const pivots = this.calculatePivotPoints(candles);
    const pivotSig = this.detectPivotBreakoutReversal(candles, pivots);
    const volumeCheck = this.checkVolumeConfirmation(candles);
    const htfTrend = this.detectHTFTrend(htfCandles);
    const premiumDiscount = this.calculatePremiumDiscount(candles);
    const reversal = this.detectReversalBands(candles);
    const vPattern = this.detectVPattern(candles, atr);

    // Pivot Breakout Reversal ya NO cuenta como estrategia independiente: casi siempre coincide
    // con la misma vela que dispara un BOS, así que contarlo aparte inflaba la confluencia con
    // evidencia duplicada. Ahora actúa solo como refuerzo (+4) cuando coincide con la dirección
    // ya determinada por las estrategias reales.
    const STRATEGIES = [
      { key: 'choch', label: 'CHoCH (cambio de carácter)', base: 82, bullish: choch.bullish, bearish: choch.bearish },
      { key: 'sweep', label: 'Barrida de liquidez', base: 78, bullish: sweep.bullish, bearish: sweep.bearish },
      { key: 'bos',   label: 'BOS (ruptura de estructura)', base: 76, bullish: bos.bullish, bearish: bos.bearish },
      { key: 'reversal', label: 'Bandas de Reversión (AlgoAlpha)', base: 75, bullish: reversal.bullish, bearish: reversal.bearish },
      { key: 'ob',    label: 'Order Block', base: 74, bullish: ob.bullishOB, bearish: ob.bearishOB },
      { key: 'vpattern', label: 'Patrón V', base: 70, bullish: vPattern.bullish, bearish: vPattern.bearish },
      { key: 'fvg',   label: 'FVG (Fair Value Gap)', base: 68, bullish: fvg.bullish, bearish: fvg.bearish }
    ];

    const bullHits = STRATEGIES.filter(s => s.bullish);
    const bearHits = STRATEGIES.filter(s => s.bearish);

    function evalSide(hits) {
      if (hits.length === 0) return { confidence: 0, hits: [] };
      // FVG nunca dispara solo: es el patrón más débil y el más propenso a falsos positivos
      // en rango lateral. Solo cuenta cuando confirma a otra estrategia, nunca como gatillo único.
      if (hits.length === 1 && hits[0].key === 'fvg') return { confidence: 0, hits: [] };
      const best = Math.max(...hits.map(s => s.base));
      const confluenceBonus = Math.min(18, (hits.length - 1) * 6);
      return { confidence: Math.min(100, best + confluenceBonus), hits };
    }

    const bullEval = evalSide(bullHits);
    const bearEval = evalSide(bearHits);

    let direction = null, confidence = 0, activeHits = [];
    if (bullEval.confidence > bearEval.confidence) { direction = 'long'; confidence = bullEval.confidence; activeHits = bullEval.hits; }
    else if (bearEval.confidence > bullEval.confidence) { direction = 'short'; confidence = bearEval.confidence; activeHits = bearEval.hits; }

    // Refuerzo de Pivot: solo suma si coincide con la dirección ya determinada por una
    // estrategia real (no cuenta para elegir la dirección ni para el conteo de confluencia).
    const pivotReinforces = !!(direction && ((direction === 'long' && pivotSig.bullish) || (direction === 'short' && pivotSig.bearish)));
    if (pivotReinforces) confidence = Math.min(100, confidence + 4);
    const pivotLevel = pivotReinforces ? pivotSig.level : null;

    // Kill Zone solo aplica a forex/oro: en cripto no hay una sesión dominante (opera 24/7),
    // así que el bono horario ahí era ruido, no señal real.
    const killZoneApplies = !!(direction && killZone && assetType !== 'crypto');
    if (killZoneApplies) confidence = Math.min(100, confidence + 6);

    // Bono OTE: si el precio está en la zona óptima de entrada (61.8%-79% Fibonacci) dentro
    // de la mitad favorable del rango, refuerza la confianza (no es obligatorio, solo suma).
    const oteBonusApplies = !!(direction && premiumDiscount &&
      ((direction === 'long' && premiumDiscount.inOteLong) ||
       (direction === 'short' && premiumDiscount.inOteShort)));
    if (oteBonusApplies) confidence = Math.min(100, confidence + 8);

    const isConfluence = activeHits.length > 1;
    const strategyLabels = activeHits.map(s => s.label);
    const strategyKeys = activeHits.map(s => s.key);

    // Ponderación por patrón: cada patrón SMC (BOS, CHoCH, OB, FVG, sweep) tiene su propio
    // historial de acierto (ver checkHistoryOutcomes()/updatePatternStats()). Un patrón que
    // viene rindiendo mal recientemente resta confianza aunque su score base sea alto; uno que
    // viene rindiendo bien suma. Solo se pondera una vez que hay muestra suficiente por patrón.
    const patternAdj = direction ? this.getPatternAdjustment(strategyKeys, patternStats) : 0;
    if (patternAdj) confidence = Math.max(0, Math.min(100, confidence + patternAdj));

    // Filtro de confianza mínima (auto-ajustado por rendimiento real, ver runAutoTune()):
    // aunque haya patrón detectado, si no llega al umbral no se abre operación.
    const filteredByConfidence = !!(direction && confidence < confidenceThreshold);
    if (filteredByConfidence) direction = null;

    // Filtro de volumen: aunque haya patrón y confianza suficiente, si el activo trae volumen
    // real y la vela de ruptura no lo confirma (< 1.2x el promedio de 20 velas), se bloquea.
    const filteredByVolume = !!(direction && volumeCheck.available && !volumeCheck.confirmed);
    if (filteredByVolume) direction = null;

    // Vela de confirmación: gate obligatorio, siempre activo.
    const confirmCandle = this.checkConfirmationCandle(candles, direction, atr);
    const filteredByCandle = !!(direction && !confirmCandle.confirmed);
    if (filteredByCandle) direction = null;

    // Mitigación de OB/FVG: gate opcional, solo cuando el Modo Estricto está activado.
    const mitigation = strictMode
      ? this.checkMitigation(candles, direction, ob, fvg, atr)
      : { required: false, confirmed: true };
    const filteredByMitigation = !!(direction && mitigation.required && !mitigation.confirmed);
    if (filteredByMitigation) direction = null;

    // Filtro Premium/Discount (regla ICT clásica, siempre activo): nunca se compra en premium
    // ni se vende en descuento. Es una regla de contexto de rango, no de sesión, así que aplica
    // igual a cripto que a forex/oro.
    const filteredByPremiumDiscount = !!(direction && premiumDiscount &&
      ((direction === 'long' && premiumDiscount.zone === 'premium') ||
       (direction === 'short' && premiumDiscount.zone === 'discount')));
    if (filteredByPremiumDiscount) direction = null;

    // Filtro de tendencia HTF: si el timeframe superior tiene tendencia clara y contraria
    // a la dirección de la señal, se bloquea. Si no hay datos HTF o la HTF está neutral,
    // no se penaliza (mejor esfuerzo, no se exige de más cuando falta información).
    const filteredByHTF = !!(direction && htfTrend && htfTrend.direction !== 'neutral' &&
      ((direction === 'long' && htfTrend.direction === 'bearish') ||
       (direction === 'short' && htfTrend.direction === 'bullish')));
    if (filteredByHTF) direction = null;

    const details = direction
      ? (isConfluence
          ? [`Confluencia de ${activeHits.length} estrategias: ${strategyLabels.join(' + ')}${pivotReinforces ? ' + Pivot' : ''}${killZoneApplies ? ' + Kill Zone' : ''}`]
          : [`Señal por estrategia individual: ${strategyLabels[0]}${pivotReinforces ? ' (+ Pivot)' : ''}${killZoneApplies ? ' (+ Kill Zone activa)' : ''}`])
      : [];

    return {
      valid: true, direction, confidence, atr, trend, killZone, isConfluence, strategyLabels, strategyKeys,
      regime: detectMarketRegime(candles),
      pivotLevel, pivots, filteredByConfidence, filteredByVolume, filteredByCandle, filteredByMitigation,
      filteredByHTF, htfTrendDirection: htfTrend ? htfTrend.direction : null,
      filteredByPremiumDiscount, premiumDiscountZone: premiumDiscount ? premiumDiscount.zone : null,
      volumeRatio: volumeCheck.ratio, volumeAvailable: volumeCheck.available,
      confidenceThreshold,
      patternAdj,
      strictMode,
      components: {
        bos: { score: (bos.bullish || bos.bearish) ? 76 : 0, max: 76 },
        choch: { score: (choch.bullish || choch.bearish) ? 82 : 0, max: 82 },
        fvg: { score: (fvg.bullish || fvg.bearish) ? 68 : 0, max: 68 },
        ob: { score: (ob.bullishOB || ob.bearishOB) ? 74 : 0, max: 74 },
        sweep: { score: (sweep.bullish || sweep.bearish) ? 78 : 0, max: 78 },
        reversal: { score: (reversal.bullish || reversal.bearish) ? 75 : 0, max: 75 },
        vpattern: { score: (vPattern.bullish || vPattern.bearish) ? 70 : 0, max: 70 },
        pivot: { score: pivotReinforces ? 4 : 0, max: 4 },
        killZone: { score: killZoneApplies ? 6 : 0, max: 6 },
        volume: { score: volumeCheck.score, max: 10 },
        candle: { score: confirmCandle.confirmed ? 10 : 0, max: 10 },
        htf: { score: (htfTrend && !filteredByHTF) ? 10 : 0, max: 10 },
        ote: { score: oteBonusApplies ? 8 : 0, max: 8 }
      },
      details
    };
  }

  // Bonus/penalización de confianza (+/- PATTERN_MAX_BONUS) según el acierto histórico real
  // de cada patrón activo en esta señal. Se promedia entre todos los patrones presentes.
  // Patrones sin muestra suficiente (< PATTERN_MIN_SAMPLE cierres) no influyen (devuelven 0).
  static getPatternAdjustment(keys, patternStats) {
    const cfg = CONFIG.AUTO_TUNE;
    if (!keys || !keys.length || !patternStats) return 0;
    const adjustments = keys.map(key => {
      const stat = patternStats[key];
      if (!stat) return 0;
      const total = (stat.wins || 0) + (stat.losses || 0);
      if (total < cfg.PATTERN_MIN_SAMPLE) return 0;
      const winRate = stat.wins / total;
      // winRate 0.5 (neutral) => 0; winRate 1.0 => +MAX; winRate 0.0 => -MAX.
      const raw = (winRate - 0.5) * (cfg.PATTERN_MAX_BONUS / 0.5);
      return Math.max(-cfg.PATTERN_MAX_BONUS, Math.min(cfg.PATTERN_MAX_BONUS, raw));
    });
    return adjustments.reduce((a, b) => a + b, 0) / adjustments.length;
  }
}

const SignalEngine = {
  build(symbol, quote, analysis) {
    const asset = ASSETS[symbol];
    if (!analysis.valid) {
      return { type: 'no-data', reason: analysis.reason };
    }
    if (!analysis.direction) {
      return { type: 'no-signal', analysis };
    }

    const entry = quote.last;
    const atr = analysis.atr || entry * 0.005;
    const risk = atr * 1.5;
    const isLong = analysis.direction === 'long';
    const sl = isLong ? entry - risk : entry + risk;
    // RR mínimo real de 1:2 en TP1 (antes era 1:1.5, por debajo del mínimo aceptable).
    const tp1 = isLong ? entry + risk * 2 : entry - risk * 2;
    const tp2 = isLong ? entry + risk * 3 : entry - risk * 3;

    const slPips = toPips(sl, entry, asset);
    const tp1Pips = toPips(tp1, entry, asset);
    const tp2Pips = toPips(tp2, entry, asset);

    return {
      type: analysis.direction, symbol, asset, entry, sl, tp1, tp2,
      slPips, tp1Pips, tp2Pips,
      rr1: '1:2', rr2: '1:3',
      confidence: analysis.confidence,
      trend: analysis.trend.direction,
      killZone: analysis.killZone,
      isConfluence: analysis.isConfluence,
      strategyLabels: analysis.strategyLabels,
      strategyKeys: analysis.strategyKeys,
      regime: analysis.regime,
      patternAdj: analysis.patternAdj,
      pivotLevel: analysis.pivotLevel,
      details: analysis.details.length ? analysis.details : ['Patrón técnico detectado'],
      components: analysis.components,
      timestamp: Date.now(),
      decimals: asset.decimals
    };
  }
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ============================================================
// MOTOR DE BACKTESTING REAL (calibración instantánea desde historial)
// ============================================================
// En vez de esperar semanas a que el auto-ajuste en vivo junte suficientes señales cerradas,
// esto corre EL MISMO SMCEngine sobre velas históricas reales de Binance (BTC/ETH), simulando
// cada señal como si hubiera ocurrido en vivo: mismas reglas de entrada/SL/TP, mismo cálculo de
// riesgo, mismos filtros. El resultado es solo una SEMILLA (ver getThresholdForSymbol() y
// getEffectivePatternStats()): en cuanto haya operaciones reales suficientes, esas mandan.
const BacktestEngine = {
  // Pide el máximo de velas reales que el proveedor permite en una sola llamada. Para cripto
  // usa Binance (endpoint público, sin API key, histórico largo y fiable). Para forex/oro, que
  // no existen en Binance, usa el histórico de Twelve Data — pero solo si el usuario cargó esa
  // API key; si no, devuelve null y ese símbolo se queda sin semilla de backtest (igual que
  // antes), sin romper el resto del proceso.
  async fetchCandles(symbol, interval) {
    const asset = ASSETS[symbol];
    if (asset.type === 'crypto') {
      const url = `${CONFIG.ENDPOINTS.BINANCE_SPOT}/klines?symbol=${asset.symbols.binance}&interval=${interval}&limit=${CONFIG.BACKTEST.CANDLE_LIMIT}`;
      const res = await fetchWithTimeout(url, 8000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
    }
    return this.fetchCandlesTwelveData(symbol, interval);
  },

  async fetchCandlesTwelveData(symbol, interval) {
    if (!state.apiKeys.twelveData) return null; // sin API key configurada, no hay forma de traer histórico de forex/oro
    const asset = ASSETS[symbol];
    const tfMap = { '15m': '15min', '1h': '1h' };
    const headers = { 'Authorization': `apikey ${state.apiKeys.twelveData}` };
    const url = `${CONFIG.ENDPOINTS.TWELVEDATA}/time_series?symbol=${asset.symbols.twelveData}&interval=${tfMap[interval] || '15min'}&outputsize=${CONFIG.BACKTEST.TWELVEDATA_CANDLE_LIMIT}`;
    const res = await fetchWithTimeout(url, 10000, { headers }, 'twelveData');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.status === 'error' || !data.values) throw new Error(data.message || 'Sin datos históricos');
    // Twelve Data devuelve del más reciente al más antiguo: se invierte para procesar en orden cronológico.
    return data.values.slice().reverse().map(v => ({
      time: new Date(v.datetime).getTime(),
      open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close),
      volume: v.volume ? parseFloat(v.volume) : 0
    }));
  },

  // Recorre el historial vela a vela, aplicando el motor real en cada punto (con ventana
  // deslizante, igual que en vivo) y simulando el resultado (TP/SL) contra las velas
  // siguientes. Cede el hilo principal cada N iteraciones para no congelar la interfaz.
  async simulate(candles, assetType) {
    const cfg = CONFIG.BACKTEST;
    const events = [];
    let lastSignalIndex = -9999;
    let lastDirection = null;

    for (let i = cfg.MIN_LOOKBACK; i < candles.length - 1; i++) {
      if (i % cfg.YIELD_EVERY === 0) await sleep(0);

      const windowStart = Math.max(0, i - cfg.WINDOW_SIZE + 1);
      const window = candles.slice(windowStart, i + 1);
      // Umbral 0 y patternStats vacíos: se quiere la detección "cruda" del patrón (sin el
      // propio filtro de confianza ni ponderación histórica), para poder calibrar ambos
      // DESPUÉS sobre el mismo resultado, sin tener que repetir la simulación.
      const analysis = SMCEngine.analyze(window, false, assetType, null, 0, {});
      if (!analysis.valid || !analysis.direction) continue;

      if (lastDirection && analysis.direction !== lastDirection && (i - lastSignalIndex) < cfg.COOLDOWN_CANDLES) continue;

      // Entrada en la APERTURA de la vela siguiente (no en el cierre de la señal), para no
      // hacer trampa mirando al futuro: en la práctica solo se sabe que hubo señal una vez
      // que la vela que la generó ya cerró.
      const entryCandle = candles[i + 1];
      if (!entryCandle) break;
      const entry = entryCandle.open;
      const atr = analysis.atr || entry * 0.005;
      const risk = atr * 1.5;
      const isLong = analysis.direction === 'long';
      const sl = isLong ? entry - risk : entry + risk;
      const tp1 = isLong ? entry + risk * 2 : entry - risk * 2;

      let result = null;
      const horizon = Math.min(candles.length, i + 1 + cfg.MAX_HOLD_CANDLES);
      for (let j = i + 1; j < horizon; j++) {
        const c = candles[j];
        const hitSL = isLong ? c.low <= sl : c.high >= sl;
        const hitTP = isLong ? c.high >= tp1 : c.low <= tp1;
        // Si la misma vela toca ambos niveles, se asume (de forma conservadora) que el SL
        // se activó primero, igual que hacen la mayoría de backtests serios.
        if (hitSL) { result = 'loss'; break; }
        if (hitTP) { result = 'win'; break; }
      }
      if (result) {
        events.push({ index: i, direction: analysis.direction, confidence: analysis.confidence, strategyKeys: analysis.strategyKeys, regime: analysis.regime, result });
        lastSignalIndex = i;
        lastDirection = analysis.direction;
      }
    }
    return events;
  },

  // Busca (en memoria, sin volver a simular) el umbral de confianza que habría dado una
  // expectancy saludable sobre las señales ya simuladas — el mismo criterio que usa
  // runAutoTune() en vivo, solo que aquí converge al instante en vez de a lo largo de semanas.
  calibrateThreshold(events) {
    const cfg = CONFIG.AUTO_TUNE;
    let threshold = CONFIG.CONFIDENCE_THRESHOLD;
    let lastStats = null;
    for (let iter = 0; iter < 10; iter++) {
      const filtered = events.filter(e => e.confidence >= threshold);
      const recent = filtered.slice(-cfg.windowSize);
      if (recent.length < cfg.minSampleSize) break;
      const wins = recent.filter(e => e.result === 'win').length;
      const winRate = wins / recent.length;
      const expectancy = recent.reduce((sum, e) => sum + (e.result === 'win' ? 2 : -1), 0) / recent.length;
      lastStats = { sampleSize: filtered.length, winRate, expectancy };
      if (expectancy < cfg.targetExpectancyLow) threshold = Math.min(cfg.maxThreshold, threshold + cfg.step);
      else if (expectancy > cfg.targetExpectancyHigh) threshold = Math.max(cfg.minThreshold, threshold - cfg.step);
      else break;
    }
    return { threshold, stats: lastStats };
  },

  aggregatePatternStats(events) {
    const stats = {};
    events.forEach(e => {
      (e.strategyKeys || []).forEach(key => {
        if (!stats[key]) stats[key] = { wins: 0, losses: 0 };
        if (e.result === 'win') stats[key].wins++; else stats[key].losses++;
      });
    });
    // Tope de muestras por patrón: si el backtest generó cientos de cierres de un patrón,
    // se reduce proporcionalmente (conservando el % de acierto) para que siga actuando como
    // semilla y nunca pese más que el aprendizaje real en vivo una vez que este arranque.
    const cap = CONFIG.BACKTEST.SEED_CAP;
    Object.keys(stats).forEach(key => {
      const s = stats[key];
      const total = s.wins + s.losses;
      if (total > cap) {
        const factor = cap / total;
        s.wins = Math.round(s.wins * factor);
        s.losses = cap - s.wins;
      }
    });
    return stats;
  },

  // Corre el backtest de UN símbolo en todos los timeframes configurados y combina resultados.
  async runSymbol(symbol) {
    const asset = ASSETS[symbol];
    let allEvents = [];
    let candlesAnalyzed = 0;
    for (const tf of CONFIG.BACKTEST.TIMEFRAMES) {
      try {
        const candles = await this.fetchCandles(symbol, tf);
        if (!candles || !candles.length) continue;
        candlesAnalyzed += candles.length;
        const events = await this.simulate(candles, asset.type);
        allEvents = allEvents.concat(events);
      } catch (e) {
        console.warn(`Backtest: no se pudo traer historial de ${symbol} en ${tf}:`, e.message);
      }
    }
    if (!allEvents.length) return null;

    const { threshold, stats } = this.calibrateThreshold(allEvents);
    const patternStats = this.aggregatePatternStats(allEvents);
    const wins = allEvents.filter(e => e.result === 'win').length;

    // Igual calibración pero separada por régimen (tendencia/rango), para que el backtest
    // alimente los mismos umbrales por-régimen que usa el aprendizaje en vivo (getThresholdForSymbol).
    const regimeCalibration = {};
    ['trending', 'ranging'].forEach(regime => {
      const regimeEvents = allEvents.filter(e => e.regime === regime);
      if (!regimeEvents.length) return;
      const r = this.calibrateThreshold(regimeEvents);
      if (r.stats) regimeCalibration[regime] = { threshold: r.threshold, sampleSize: regimeEvents.length, winRate: r.stats.winRate };
    });

    return {
      symbol,
      candlesAnalyzed,
      totalSignals: allEvents.length,
      winRate: wins / allEvents.length,
      calibratedThreshold: threshold,
      calibratedStats: stats,
      regimeCalibration,
      patternStats
    };
  },

  // Corre BTC y ETH en secuencia (no en paralelo, para no saturar el hilo principal ni el rate
  // limit público de Binance) y guarda el resultado como semilla. `force=true` ignora el
  // límite de "una vez al día" (se usa tras un reinicio manual del auto-ajuste).
  async runAll(force = false) {
    if (state.backtestRunning) return;
    const cfg = CONFIG.BACKTEST;
    const lastRun = parseInt(localStorage.getItem('pt_backtest_last_run') || '0', 10);
    if (!force && Date.now() - lastRun < cfg.RERUN_INTERVAL_MS) { renderBacktestStatus(); return; }

    state.backtestRunning = true;
    renderBacktestStatus();
    const results = {};
    try {
      for (const symbol of cfg.SYMBOLS) {
        const r = await this.runSymbol(symbol);
        if (r) results[symbol] = r;
      }

      if (Object.keys(results).length) {
        // Combina patrones de BTC y ETH en una sola semilla (los patrones SMC son los mismos
        // patrones técnicos independientemente del activo).
        const combinedPatternStats = {};
        Object.values(results).forEach(r => {
          Object.entries(r.patternStats).forEach(([key, s]) => {
            if (!combinedPatternStats[key]) combinedPatternStats[key] = { wins: 0, losses: 0 };
            combinedPatternStats[key].wins += s.wins;
            combinedPatternStats[key].losses += s.losses;
          });
        });
        state.backtestPatternStats = combinedPatternStats;
        localStorage.setItem('pt_backtest_pattern_stats', JSON.stringify(combinedPatternStats));

        const autoTune = {};
        Object.entries(results).forEach(([symbol, r]) => {
          autoTune[symbol] = {
            threshold: r.calibratedThreshold,
            sampleSize: r.totalSignals,
            winRate: r.winRate,
            candlesAnalyzed: r.candlesAnalyzed
          };
          Object.entries(r.regimeCalibration || {}).forEach(([regime, rc]) => {
            autoTune[symbol + '_' + regime] = { threshold: rc.threshold, sampleSize: rc.sampleSize, winRate: rc.winRate };
          });
        });
        state.backtestAutoTune = autoTune;
        localStorage.setItem('pt_backtest_autotune', JSON.stringify(autoTune));
        localStorage.setItem('pt_backtest_last_run', String(Date.now()));
        state.backtestResults = results;
      }
    } catch (e) {
      console.warn('Backtest: error general', e);
    } finally {
      state.backtestRunning = false;
      renderBacktestStatus();
      Object.keys(ASSETS).forEach(sym => renderAutoTuneStatus(sym));
      renderAutoTuneStatus();
    }
  }
};

function renderBacktestStatus() {} // era UI (DOM); el estado del backtest se sirve vía /api/state

function fmt(value, decimals) {
  if (value === null || value === undefined || isNaN(value)) return '--';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function toPips(priceA, priceB, asset) {
  if (priceA === null || priceA === undefined || priceB === null || priceB === undefined) return null;
  const pipSize = asset && asset.pipSize ? asset.pipSize : 1;
  return Math.abs(priceA - priceB) / pipSize;
}

function fmtPips(pips) {
  if (pips === null || pips === undefined || isNaN(pips)) return '--';
  return pips.toFixed(1) + ' pips';
}

function pctDiff(a, b) {
  if (a === null || a === undefined || !b) return 0;
  return ((a - b) / b) * 100;
}

// Filtro de spread anómalo: si el spread actual (real, no estimado) supera por mucho el
// promedio reciente del propio activo, se considera baja liquidez / posible gap y se
// bloquea la emisión de nuevas señales (las señales ya activas siguen su curso normal).
function checkSpreadAnomaly(symbol, quote) {
  if (!quote || quote.spread === null || quote.spread === undefined || quote.estimatedSpread) {
    return { anomalous: false, ratio: null };
  }
  const history = state.spreadHistory[symbol] || [];
  history.push(quote.spread);
  if (history.length > 20) history.shift();
  state.spreadHistory[symbol] = history;
  try { localStorage.setItem('pt_spread_history', JSON.stringify(state.spreadHistory)); } catch (e) { /* storage lleno o bloqueado: no rompe el flujo */ }

  if (history.length < 5) return { anomalous: false, ratio: null };
  const priorReadings = history.slice(0, -1);
  const avg = priorReadings.reduce((a, b) => a + b, 0) / priorReadings.length;
  if (!avg) return { anomalous: false, ratio: null };
  const ratio = quote.spread / avg;
  return { anomalous: ratio > CONFIG.SPREAD_ANOMALY_MULTIPLIER, ratio };
}


// ---- Stubs de UI (no aplica en backend, no hay DOM) ----
function updatePriceUI(symbol, quote, asset) {
  state.livePrices = state.livePrices || {};
  state.livePrices[symbol] = {
    name: asset.name,
    decimals: asset.decimals,
    last: quote.last,
    change: pctDiff(quote.last, quote.open),
    bid: quote.bid || null,
    ask: quote.ask || null,
    spread: quote.spread !== undefined ? quote.spread : null,
    estimatedSpread: !!quote.estimatedSpread,
    timestamp: quote.timestamp,
    source: quote.source
  };
}
function renderTradingHoursBar() {}
function assetFeedSkeleton() { return ''; }
function renderAssetsFeedSkeleton() {}
function renderAssetHoursPill() {}
function renderMarketBanner() {}
function renderApiError(symbol, message) { if (message) console.warn(`[${symbol}] ${message}`); }
function setLoading() {}
function renderSignal(symbol, signalDisplay) { state.lastDisplay[symbol] = signalDisplay; }
function renderConfidence() {}
function pushSignalHistory(signal) {
  if (signal.type !== 'long' && signal.type !== 'short') return;
  const last = state.signalHistory[0];
  if (last && last.symbol === signal.symbol && last.type === signal.type && last.result === 'pending') return;
  const entry = {
    id: Date.now(), symbol: signal.symbol, name: signal.asset.name, type: signal.type,
    entry: signal.entry, sl: signal.sl, tp1: signal.tp1, tp2: signal.tp2,
    slPips: signal.slPips, tp1Pips: signal.tp1Pips, tp2Pips: signal.tp2Pips,
    decimals: signal.decimals, confidence: signal.confidence, result: 'pending', timestamp: signal.timestamp,
    strategyKeys: signal.strategyKeys || [], rMultiple: null, regime: signal.regime || 'unknown'
  };
  state.signalHistory.unshift(entry);
  if (state.signalHistory.length > CONFIG.HISTORY_LIMIT) state.signalHistory.pop();
  localStorage.setItem('pt_v4_signals', JSON.stringify(state.signalHistory));
}

function checkHistoryOutcomes(symbol, currentPrice, candles) {
  let changed = false;
  const resolvedEntries = [];
  // Velas nuevas desde que se guardó cada señal: permite revisar el high/low REAL de cada
  // vela (no solo el último precio recibido cada 30s), igual criterio que usa el backtest.
  // Si por lo que sea no llegaron velas (fallback), se cae al chequeo simple contra el precio
  // actual para no dejar de resolver señales.
  state.signalHistory.forEach(h => {
    if (h.symbol !== symbol || h.result !== 'pending') return;
    const isLong = h.type === 'long';
    const rWin = (h.tp1Pips && h.slPips) ? +(h.tp1Pips / h.slPips).toFixed(2) : 2;

    let outcome = null;
    const relevantCandles = (candles || []).filter(c => c.time >= h.timestamp);
    if (relevantCandles.length) {
      // Orden cronológico ascendente para respetar cuál nivel se tocó primero.
      for (const c of relevantCandles) {
        const hitSL = isLong ? c.low <= h.sl : c.high >= h.sl;
        const hitTP = isLong ? c.high >= h.tp1 : c.low <= h.tp1;
        // Igual que en el backtest: si la misma vela toca ambos niveles, se asume
        // conservadoramente que el SL se activó primero.
        if (hitSL) { outcome = 'loss'; break; }
        if (hitTP) { outcome = 'win'; break; }
      }
    } else {
      // Fallback: sin velas disponibles, se compara contra el último precio (menos preciso,
      // puede no detectar una mecha que tocó y volvió).
      if (isLong && currentPrice >= h.tp1) outcome = 'win';
      else if (isLong && currentPrice <= h.sl) outcome = 'loss';
      else if (!isLong && currentPrice <= h.tp1) outcome = 'win';
      else if (!isLong && currentPrice >= h.sl) outcome = 'loss';
    }

    if (outcome) {
      h.result = outcome;
      h.rMultiple = outcome === 'win' ? rWin : -1;
      changed = true;
      resolvedEntries.push(h);
    }
  });
  if (changed) {
    localStorage.setItem('pt_v4_signals', JSON.stringify(state.signalHistory));
    resolvedEntries.forEach(updatePatternStats);
    runAutoTune(symbol);
  }
}

// Registra el resultado (win/loss) de la señal contra cada patrón SMC que participó en ella,
// para poder ponderar la confianza de cada patrón por separado (ver SMCEngine.getPatternAdjustment).
function updatePatternStats(entry) {
  if (!entry.strategyKeys || !entry.strategyKeys.length) return;
  entry.strategyKeys.forEach(key => {
    if (!state.patternStats[key]) state.patternStats[key] = { wins: 0, losses: 0 };
    if (entry.result === 'win') state.patternStats[key].wins++;
    else if (entry.result === 'loss') state.patternStats[key].losses++;
  });
  localStorage.setItem('pt_pattern_stats', JSON.stringify(state.patternStats));
}

// Auto-ajuste: recalibra sola el umbral de confianza de ESTE símbolo (y, si hay muestra
// suficiente, también por régimen de mercado: tendencia vs. rango) según su rendimiento real
// reciente (expectancy en R, no solo win rate).
//
// Dos mejoras sobre la versión anterior:
// 1) Shrinkage bayesiano: con muestras chicas (justo arriba del mínimo) la expectancy cruda
//    puede moverse mucho por pura casualidad. Se la "encoge" hacia 0 (breakeven) en proporción
//    a qué tan lejos está la muestra del mínimo, así el umbral no reacciona de más a rachas
//    cortas y se estabiliza a medida que se acumulan más operaciones reales.
// 2) Calibración por régimen: además del umbral combinado del símbolo, se mantiene un umbral
//    separado para "tendencia" y otro para "rango" una vez que cada uno junta su propia
//    muestra mínima — el mismo sistema puede rendir muy distinto en cada contexto.
function runAutoTuneForKey(key, closedEntries) {
  const cfg = CONFIG.AUTO_TUNE;
  if (!state.autoTuneStats[key]) state.autoTuneStats[key] = { sampleSize: 0, lastWinRate: null, lastExpectancy: null };
  const stats = state.autoTuneStats[key];
  stats.sampleSize = closedEntries.length;

  if (closedEntries.length < cfg.minSampleSize) {
    return;
  }

  // signalHistory está ordenado del más reciente al más antiguo (unshift), así que los
  // primeros `windowSize` elementos ya son la ventana móvil correcta.
  const recent = closedEntries.slice(0, cfg.windowSize);
  const wins = recent.filter(h => h.result === 'win').length;
  const winRate = wins / recent.length;
  const rawExpectancy = recent.reduce((sum, h) => sum + (h.rMultiple != null ? h.rMultiple : (h.result === 'win' ? 2 : -1)), 0) / recent.length;

  // k=15: con la muestra mínima (10) el peso real es 10/(10+15)=40% del valor crudo; con
  // 40+ cierres ya pesa >70% y se acerca a la expectancy real sin encoger casi nada.
  const shrinkageK = 15;
  const confidenceWeight = recent.length / (recent.length + shrinkageK);
  const expectancy = confidenceWeight * rawExpectancy;

  stats.lastWinRate = winRate;
  stats.lastExpectancy = expectancy;
  stats.rawExpectancy = +rawExpectancy.toFixed(2);
  stats.confidenceWeight = +confidenceWeight.toFixed(2);

  const currentThreshold = state.autoConfidenceThreshold[key] || CONFIG.CONFIDENCE_THRESHOLD;
  let newThreshold = currentThreshold;
  if (expectancy < cfg.targetExpectancyLow) {
    // Rendimiento flojo: se vuelve más exigente para filtrar señales de menor calidad.
    newThreshold = Math.min(cfg.maxThreshold, currentThreshold + cfg.step);
  } else if (expectancy > cfg.targetExpectancyHigh) {
    // Rendimiento sólido: se relaja un poco para no dejar pasar oportunidades válidas.
    newThreshold = Math.max(cfg.minThreshold, currentThreshold - cfg.step);
  }

  if (newThreshold !== currentThreshold) {
    state.autoConfidenceThreshold[key] = newThreshold;
  }
}

function runAutoTune(symbol) {
  const closedSymbol = state.signalHistory.filter(h => h.symbol === symbol && (h.result === 'win' || h.result === 'loss'));
  runAutoTuneForKey(symbol, closedSymbol);

  ['trending', 'ranging'].forEach(regime => {
    const closedRegime = closedSymbol.filter(h => h.regime === regime);
    if (closedRegime.length) runAutoTuneForKey(symbol + '_' + regime, closedRegime);
  });

  saveAutoTuneState();
  renderAutoTuneStatus(symbol);
}

// Actualiza la barra global (resumen de todos los símbolos) y, si se pasa un symbol, también
// la mini-línea de auto-ajuste específica de esa tarjeta.
function renderAutoTuneStatus() {}
function localDayKey(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


// ---- Stubs de historial/ajustes UI (servidos por la API en vez de renderizados) ----
function historyCardHtml() { return ''; }
function renderHistory() {}
function clearHistory() { state.history = []; try { localStorage.setItem('pt_v4_signals', '[]'); } catch (e) {} }
function renderSettings() {}
function togglePersistKeys() {}
function updateApiKey(provider, value) { state.apiKeys[provider] = value; }
function renderLogs() {}
function toggleSection() {}
function toggleView() {}
function requestNotification() {}
function playAlertBeep() {}
function showSignalAlertBanner() {}

// ---- Notificación real: en vez de sonido/banner en pantalla, manda Web Push ----
function notifyNewSignal(signal) {
  const asset = ASSETS[signal.symbol];
  const title = `${signal.type === 'long' ? '🟢 LONG' : '🔴 SHORT'} ${asset ? asset.name : signal.symbol}`;
  const body = `Entrada ${fmt(signal.entry, signal.decimals)} · SL ${fmt(signal.sl, signal.decimals)} · TP1 ${fmt(signal.tp1, signal.decimals)} · Confianza ${signal.confidence}%`;
  sendPushToAll({ title, body, symbol: signal.symbol, signal }).catch(err => console.error('Error enviando push:', err.message));
}

function toggleSound() {}
function toggleStrictMode() { state.strictMode = !state.strictMode; }
function resolveActiveSignal(symbol, quote, analysis) {
  if (!analysis.valid) {
    delete state.activeSignals[symbol];
    return { type: 'no-data', reason: analysis.reason };
  }
  if (!analysis.direction) {
    delete state.activeSignals[symbol];
    return { type: 'no-signal', analysis };
  }

  const existing = state.activeSignals[symbol];
  const isNewDirection = !existing || existing.type !== analysis.direction;

  const lastAt = state.lastSignalAt[symbol] || 0;
  const cooldownRemainingMs = CONFIG.SIGNAL_COOLDOWN_MS - (Date.now() - lastAt);
  const inCooldown = isNewDirection && cooldownRemainingMs > 0;

  if (isNewDirection && !inCooldown) {
    const frozen = SignalEngine.build(symbol, quote, analysis);
    frozen.detectedAt = Date.now();
    state.activeSignals[symbol] = frozen;
    state.lastSignalAt[symbol] = frozen.detectedAt;
    pushSignalHistory(frozen);
    notifyNewSignal(frozen);
  }

  // No hay señal activa para mostrar: nunca hubo, la anterior ya se resolvió, o la nueva
  // dirección detectada está bloqueada por el cooldown.
  if (!state.activeSignals[symbol]) {
    return {
      type: 'no-signal',
      analysis,
      cooldownMinutesLeft: inCooldown ? Math.ceil(cooldownRemainingMs / 60000) : null
    };
  }

  const frozen = state.activeSignals[symbol];
  const isLong = frozen.type === 'long';
  const hitTP = isLong ? quote.last >= frozen.tp1 : quote.last <= frozen.tp1;
  const hitSL = isLong ? quote.last <= frozen.sl : quote.last >= frozen.sl;

  const result = {
    type: frozen.type,
    frozen,
    currentPrice: quote.last,
    hitTP,
    hitSL,
    isNewDirection: isNewDirection && !inCooldown
  };

  if (hitTP || hitSL) delete state.activeSignals[symbol];

  return result;
}

async function refreshAsset(symbol, forceRefresh = false) {
  const asset = ASSETS[symbol];
  renderMarketBanner(symbol);
  renderAssetHoursPill(symbol);
  renderApiError(symbol, null);

  if (!isMarketOpenForAsset(symbol)) {
    renderSignal(symbol, { type: 'market-closed' });
    return;
  }

  try {
    const [quote, ohlcv] = await Promise.all([
      MarketDataProvider.getQuote(symbol, forceRefresh),
      MarketDataProvider.getOHLCV(symbol, state.currentTF, 100, forceRefresh)
        .catch(() => state.klineHistory[symbol] || new OHLCVData([]))
    ]);
    updatePriceUI(symbol, quote, asset);

    // Filtro HTF: solo se pide el timeframe superior si hay un mapeo definido para el TF
    // actual (5m/15m -> 1h). En 1h no hay HTF disponible con estos proveedores, se omite.
    const htfTF = CONFIG.HTF_MAP[state.currentTF] || null;
    let htfCandles = null;
    if (htfTF) {
      try {
        const htfOhlcv = await MarketDataProvider.getOHLCV(symbol, htfTF, 60, forceRefresh);
        htfCandles = htfOhlcv.candles;
      } catch (e) {
        htfCandles = null; // mejor esfuerzo: si falla, el filtro HTF simplemente no aplica
      }
    }

    const regimeForThreshold = detectMarketRegime(ohlcv.candles);
    const analysis = SMCEngine.analyze(ohlcv.candles, state.strictMode, asset.type, htfCandles, getThresholdForSymbol(symbol, regimeForThreshold), getEffectivePatternStats());

    // Logging de supresión silenciosa: cada gate que anula analysis.direction queda registrado
    // con su motivo específico, para poder ver en el log por qué no se emitió una señal aunque
    // se haya detectado un patrón técnico.
    if (analysis.filteredByConfidence) {
      addLog(quote.source, `Señal bloqueada: confianza insuficiente (umbral ${analysis.confidenceThreshold})`, symbol);
    }
    if (analysis.filteredByVolume) {
      addLog(quote.source, `Señal bloqueada: volumen no confirma (ratio ${analysis.volumeRatio ? analysis.volumeRatio.toFixed(2) : 'n/d'}x, se requiere 1.2x)`, symbol);
    }
    if (analysis.filteredByCandle) {
      addLog(quote.source, 'Señal bloqueada: vela de confirmación no cumplida', symbol);
    }
    if (analysis.filteredByMitigation) {
      addLog(quote.source, 'Señal bloqueada: mitigación de OB/FVG no confirmada (Modo Estricto)', symbol);
    }
    if (analysis.filteredByPremiumDiscount) {
      addLog(quote.source, `Señal bloqueada: filtro Premium/Discount (zona: ${analysis.premiumDiscountZone})`, symbol);
    }
    if (analysis.filteredByHTF) {
      addLog(quote.source, `Señal bloqueada: tendencia HTF contraria (${analysis.htfTrendDirection})`, symbol);
    }

    const spreadCheck = checkSpreadAnomaly(symbol, quote);
    if (spreadCheck.anomalous && analysis.direction) {
      addLog(quote.source, `Señal bloqueada por spread anómalo (${spreadCheck.ratio.toFixed(1)}x el promedio)`, symbol);
      analysis.direction = null;
      analysis.filteredBySpread = true;
      analysis.spreadRatio = spreadCheck.ratio;
    }

    const display = resolveActiveSignal(symbol, quote, analysis);
    if (display.cooldownMinutesLeft) {
      addLog(quote.source, `Cambio de dirección bloqueado por cooldown (${display.cooldownMinutesLeft} min restantes)`, symbol);
    }

    renderSignal(symbol, display);
    checkHistoryOutcomes(symbol, quote.last, ohlcv.candles);
  } catch (error) {
    if (error.message === 'MERCADO_CERRADO') {
      renderSignal(symbol, { type: 'market-closed' });
    } else {
      renderApiError(symbol, error.message || 'No se pudo obtener información de ningún proveedor. Revisa tu conexión o las claves de API en Ajustes.');
      renderSignal(symbol, { type: 'no-data', reason: 'Todos los proveedores de datos fallaron para este activo.' });
    }
  }
}

// Trae y renderiza los 4 activos en paralelo. En el refresco automático (cada 30s) no se
// muestra el overlay de pantalla completa para no interrumpir el scroll por el feed;
// solo se usa en la carga inicial y cuando el usuario toca el botón de refrescar.
async function refreshAllData(forceRefresh = false) {
  renderTradingHoursBar();
  if (forceRefresh) setLoading(true, 'Consultando proveedores de datos...');
  try {
    await Promise.allSettled(Object.keys(ASSETS).map(symbol => refreshAsset(symbol, forceRefresh)));
  } finally {
    if (forceRefresh) setLoading(false);
  }
}

// Wake Lock: le pide al navegador que no apague/bloquee la pantalla mientras la app esté
// abierta y visible en primer plano. No mantiene la app viva si la minimizas o cambias de
// pestaña (eso lo sigue impidiendo el propio navegador) — solo evita que la pantalla se
// bloquee sola por inactividad mientras la estás mirando. Soportado en Chrome/Edge/Android;
// en iOS Safari aún no existe esta API, así que ahí falla en silencio (la app sigue
// funcionando igual, solo que el usuario deberá ajustar el bloqueo automático desde Ajustes
// del sistema, como ya se explicó).
// requestWakeLock/releaseWakeLock/handleVisibilityChange no aplican: el servidor no tiene
// pantalla que bloquear ni pestaña que se oculte, corre siempre igual.
async function requestWakeLock() {}

module.exports = { state, CONFIG, ASSETS, refreshAllData, refreshAsset, BacktestEngine };
