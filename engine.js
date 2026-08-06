// ============================================================
// PULSE TRADE v4.1 - MOTOR DE SEÑALES PROFESIONAL (CORREGIDO PARA RENDER)
// ============================================================
// Cambios vs v4.0:
// - Binance Spot va primero para crypto (API pública, sin key, sin rate limit estricto)
// - ExchangeRate-API va primero para EUR/USD (gratis, sin key, sin límites)
// - Requests secuenciales por activo para no saturar rate limits
// - Timeout aumentado a 8s (Render tiene latencia alta)
// - Delays aumentados entre activos (8s) y entre requests (1.5s)
// - Proveedores de pago/fallidos al final de la lista
// - Cooldowns extendidos para rate limits (10min) y errores 402/403
//
// Cambios v4.1:
// - Se integran 3 estrategias INDEPENDIENTES (custom-strategies.js):
//   Zona de Caza (Kill Zone NY), Pivots Breakout & Reversal,
//   Price Action + RSI + EMA. Corren en paralelo a las estrategias SMC
//   (CHoCH, BOS, OB, FVG, Sweep, etc), NO pasan por evalSide() ni por
//   los filtros globales de confluencia/premium-discount/HTF, y emiten
//   su propia señal con su propio SL/TP cuando cumplen TODAS sus
//   condiciones.

const { sendPushToAll } = require('./subscriptions');
const CustomStrategies = require('./custom-strategies');

const CONFIG = {
  REFRESH_INTERVAL: 30000,
  HISTORY_LIMIT: 50,
  REQUEST_TIMEOUT: 8000,
  MAX_RETRIES: 2,
  RETRY_DELAY: 1000,
  CACHE_TTL: 30000,
  CONFIDENCE_THRESHOLD: 70,
  SIGNAL_COOLDOWN_MS: 15 * 60 * 1000,
  // Refresco dinámico: cada 15 min en horario normal (para no saturar rate limits),
  // pero cada 1 min dentro de la ventana Kill Zone NY (10:30-13:30 hora Argentina),
  // para no perderse el detalle de la vela de apertura ni la Bala de Plata.
  DYNAMIC_REFRESH: {
    normalIntervalMs: 15 * 60 * 1000,
    killZoneIntervalMs: 60 * 1000
  },
  HTF_MAP: { '5m': '1h', '15m': '1h' },
  SPREAD_ANOMALY_MULTIPLIER: 2.5,
  AUTO_TUNE: {
    minSampleSize: 10,
    windowSize: 20,
    targetExpectancyLow: 0.35,
    targetExpectancyHigh: 0.95,
    step: 2,
    minThreshold: 65,
    maxThreshold: 90,
    PATTERN_MIN_SAMPLE: 8,
    PATTERN_MAX_BONUS: 8
  },
  BACKTEST: {
    SYMBOLS: ['BTCUSD', 'ETHUSD', 'EURUSD', 'XAUUSD'],
    CANDLE_LIMIT: 1000,
    TWELVEDATA_CANDLE_LIMIT: 800,
    TIMEFRAMES: ['15m', '1h'],
    MIN_LOOKBACK: 60,
    WINDOW_SIZE: 150,
    MAX_HOLD_CANDLES: 200,
    COOLDOWN_CANDLES: 6,
    RERUN_INTERVAL_MS: 24 * 60 * 60 * 1000,
    SEED_CAP: 40,
    YIELD_EVERY: 40
  },
  // CryptoCompare vuelve como respaldo en vivo (con API key + cola de rate-limit propia,
  // ver fetchCryptoCompare) — se había sacado por completo pensando en el límite del
  // backtest (velas históricas masivas), pero para tráfico liviano de panel funciona bien.
  PROVIDER_PRIORITY: ['exchangerate', 'twelveData', 'cryptocompare', 'alphaVantage'],
  ENDPOINTS: {
    BINANCE_SPOT: 'https://api.binance.com/api/v3',
    BINANCE_FUTURES: 'https://fapi.binance.com/fapi/v1',
    CRYPTOCOMPARE: 'https://min-api.cryptocompare.com/data',
    EXCHANGERATE: 'https://api.exchangerate-api.com/v4/latest',
    TWELVEDATA: 'https://api.twelvedata.com',
    FINNHUB: 'https://finnhub.io/api/v1',
    ALPHAVANTAGE: 'https://www.alphavantage.co/query',
    FMP: 'https://financialmodelingprep.com/stable',
    // Región de tu cuenta MetaApi (se arma sola desde la variable de entorno
    // METAAPI_REGION que cargues en Render — la ves en el panel de MetaApi al
    // conectar tu cuenta: new-york, london, singapore, etc.)
    METAAPI_MARKET_DATA: `https://mt-market-data-client-api-v1.${process.env.METAAPI_REGION || 'new-york'}.agiliumtrade.ai`
  }
};

class MarketData {
  constructor({ bid, ask, last, open, high, low, close, volume, timestamp, timeframe, marketStatus, spread, source, symbol, estimatedSpread = false }) {
    this.bid = bid; this.ask = ask; this.last = last; this.open = open; this.high = high;
    this.low = low; this.close = close; this.volume = volume; this.timestamp = timestamp;
    this.timeframe = timeframe || '1d'; this.marketStatus = marketStatus || 'unknown';
    this.spread = spread; this.source = source; this.symbol = symbol;
    this.estimatedSpread = estimatedSpread; this.isValid = this.validate();
  }
  validate() {
    if (this.last === null || this.last === undefined || isNaN(this.last)) return false;
    if (this.timestamp === null || Date.now() - this.timestamp > 300000) return false;
    if (this.spread !== null && this.spread > 500) return false;
    return true;
  }
}

class OHLCVData {
  constructor(candles) { this.candles = candles || []; this.isValid = candles && candles.length >= 30; }
}

const ASSETS = {
  BTCUSD: {
    name: 'BTC/USD', market: 'crypto', type: 'crypto',
    symbols: { twelveData: 'BTC/USD', finnhub: 'BINANCE:BTCUSDT', alphaVantage: 'BTC', fmp: 'BTCUSD', binance: 'BTCUSDT', cryptocompare: 'BTC', metaapi: 'BTCUSD' },
    decimals: 2, pipSize: 1, is24h: true, timezone: 'UTC',
    openHour: 0, closeHour: 24, openDays: [0,1,2,3,4,5,6],
    providerPriority: ['metaapi', 'twelveData', 'cryptocompare', 'alphaVantage']
  },
  ETHUSD: {
    name: 'ETH/USD', market: 'crypto', type: 'crypto',
    symbols: { twelveData: 'ETH/USD', finnhub: 'BINANCE:ETHUSDT', alphaVantage: 'ETH', fmp: 'ETHUSD', binance: 'ETHUSDT', cryptocompare: 'ETH', metaapi: 'ETHUSD' },
    decimals: 2, pipSize: 1, is24h: true, timezone: 'UTC',
    openHour: 0, closeHour: 24, openDays: [0,1,2,3,4,5,6],
    providerPriority: ['metaapi', 'twelveData', 'cryptocompare', 'alphaVantage']
  },
  EURUSD: {
    name: 'EUR/USD', market: 'forex', type: 'forex',
    symbols: { twelveData: 'EUR/USD', finnhub: 'OANDA:EUR_USD', alphaVantage: 'EURUSD', fmp: 'EURUSD', cryptocompare: 'EUR', exchangerate: 'EUR', metaapi: 'EURUSD' },
    decimals: 5, pipSize: 0.0001, is24h: false, timezone: 'UTC',
    providerPriority: ['metaapi', 'exchangerate', 'twelveData', 'cryptocompare', 'alphaVantage']
  },
  XAUUSD: {
    name: 'XAU/USD (Oro)', market: 'forex', type: 'commodity',
    symbols: { twelveData: 'XAU/USD', finnhub: 'OANDA:XAU_USD', alphaVantage: 'XAU', fmp: 'GCUSD', cryptocompare: 'XAU', metaapi: 'XAUUSD' },
    decimals: 2, pipSize: 0.1, is24h: false, timezone: 'UTC',
    providerPriority: ['metaapi', 'twelveData', 'cryptocompare', 'alphaVantage']
  }
};

let state = {
  currentTF: '15m',
  lastPrice: null, prevPrice: null, klineHistory: {},
  signalHistory: (() => { try { return JSON.parse(localStorage.getItem('pt_v4_signals') || '[]'); } catch (e) { return []; } })(),
  providers: {}, providerStats: {}, currentProvider: null, autoRefresh: null,
  lastFetchTime: null, currentData: null, logs: [], activeSignals: {}, lastSignalAt: {},
  activeCustomSignals: {}, lastCustomSignalAt: {},
  spreadHistory: (() => { try { return JSON.parse(localStorage.getItem('pt_spread_history') || '{}'); } catch (e) { return {}; } })(),
  autoConfidenceThreshold: (() => {
    try { const v2 = JSON.parse(localStorage.getItem('pt_auto_threshold_v2') || 'null'); if (v2 && typeof v2 === 'object') return v2; } catch (e) {}
    const legacy = parseFloat(localStorage.getItem('pt_auto_threshold'));
    const seed = !isNaN(legacy) ? legacy : CONFIG.CONFIDENCE_THRESHOLD;
    const obj = {}; Object.keys(ASSETS).forEach(sym => { obj[sym] = seed; }); return obj;
  })(),
  autoTuneStats: (() => { try { return JSON.parse(localStorage.getItem('pt_auto_stats_v2') || '{}'); } catch (e) { return {}; } })(),
  patternStats: (() => { try { return JSON.parse(localStorage.getItem('pt_pattern_stats') || '{}'); } catch (e) { return {}; } })(),
  backtestPatternStats: (() => { try { return JSON.parse(localStorage.getItem('pt_backtest_pattern_stats') || '{}'); } catch (e) { return {}; } })(),
  backtestAutoTune: (() => { try { return JSON.parse(localStorage.getItem('pt_backtest_autotune') || '{}'); } catch (e) { return {}; } })(),
  // Estadísticas de backtest de las 5 estrategias independientes (custom-strategies.js).
  // Separado de backtestPatternStats/backtestAutoTune porque estas estrategias no usan
  // confianza ni régimen (trending/ranging) como SMCEngine — solo gana/pierde por estrategia.
  backtestCustomStats: (() => { try { return JSON.parse(localStorage.getItem('pt_backtest_custom_stats') || '{}'); } catch (e) { return {}; } })(),
  backtestRunning: false,
  soundEnabled: localStorage.getItem('pt_sound_enabled') !== 'false',
  persistKeys: localStorage.getItem('pt_persist_keys') === 'true',
  strictMode: localStorage.getItem('pt_strict_mode') === 'true',
  apiKeys: {
    twelveData: localStorage.getItem('pt_api_twelve') || null,
    finnhub: localStorage.getItem('pt_api_finnhub') || null,
    alphaVantage: localStorage.getItem('pt_api_alpha') || null,
    fmp: localStorage.getItem('pt_api_fmp') || null,
    metaapi: localStorage.getItem('pt_api_metaapi') || null
  },
  metaapiAccountId: localStorage.getItem('pt_metaapi_account_id') || null,
  refreshPaused: false, wakeLock: null
};

function getNow() { return new Date(); }

// Ventana Kill Zone NY en hora Argentina (10:30-13:30), usada solo para decidir
// la frecuencia de refresco del scheduler. Es independiente del cálculo que hace
// CustomStrategies.detectKillZoneNY() sobre las velas (ese sigue intacto).
function isArgKillZoneWindow(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(new Date(nowMs));
  const weekday = parts.find(p => p.type === 'weekday').value;
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
  const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const minutesNow = hour * 60 + minute;
  return minutesNow >= (10 * 60 + 30) && minutesNow < (13 * 60 + 30);
}

function getDynamicRefreshIntervalMs() {
  return isArgKillZoneWindow() ? CONFIG.DYNAMIC_REFRESH.killZoneIntervalMs : CONFIG.DYNAMIC_REFRESH.normalIntervalMs;
}

function getThresholdForSymbol(symbol, regime = null) {
  const cfg = CONFIG.AUTO_TUNE;
  if (regime && regime !== 'unknown') {
    const regimeKey = symbol + '_' + regime;
    const regimeStats = state.autoTuneStats[regimeKey];
    if (regimeStats && regimeStats.sampleSize >= cfg.minSampleSize && state.autoConfidenceThreshold[regimeKey] != null) {
      return state.autoConfidenceThreshold[regimeKey];
    }
    const btRegime = state.backtestAutoTune && state.backtestAutoTune[regimeKey];
    if (btRegime && btRegime.threshold) return btRegime.threshold;
  }
  const liveStats = state.autoTuneStats[symbol];
  const liveReady = liveStats && liveStats.sampleSize >= cfg.minSampleSize;
  if (!liveReady) {
    const bt = state.backtestAutoTune && state.backtestAutoTune[symbol];
    if (bt && bt.threshold) return bt.threshold;
  }
  return (state.autoConfidenceThreshold && state.autoConfidenceThreshold[symbol]) || CONFIG.CONFIDENCE_THRESHOLD;
}

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

function resetAutoTune() {
  const obj = {};
  Object.keys(ASSETS).forEach(sym => { obj[sym] = CONFIG.CONFIDENCE_THRESHOLD; });
  state.autoConfidenceThreshold = obj; state.autoTuneStats = {}; state.patternStats = {};
  localStorage.setItem('pt_auto_threshold_v2', JSON.stringify(obj));
  localStorage.setItem('pt_auto_stats_v2', JSON.stringify({}));
  localStorage.setItem('pt_pattern_stats', JSON.stringify({}));
  renderAutoTuneStatus();
  Object.keys(ASSETS).forEach(sym => renderAutoTuneStatus(sym));
  refreshAllData(true);
  BacktestEngine.runAll(true);
}

const PROVIDER_DAILY_LIMITS = { twelveData: 800, finnhub: null, alphaVantage: 25, fmp: 250 };

const RequestTracker = {
  todayKey() { return 'pt_req_count_' + new Date().toISOString().slice(0, 10); },
  load() { try { return JSON.parse(localStorage.getItem(this.todayKey()) || '{}'); } catch (e) { return {}; } },
  record(providerName) {
    if (!providerName || !(providerName in PROVIDER_DAILY_LIMITS)) return;
    const counts = this.load(); counts[providerName] = (counts[providerName] || 0) + 1;
    try { localStorage.setItem(this.todayKey(), JSON.stringify(counts)); } catch (e) {}
  },
  getUsage(providerName) { const counts = this.load(); const used = counts[providerName] || 0; const limit = PROVIDER_DAILY_LIMITS[providerName]; return { used, limit, pct: limit ? used / limit : 0 }; }
};

async function fetchWithTimeout(url, timeout = CONFIG.REQUEST_TIMEOUT, options = {}, providerName = null) {
  RequestTracker.record(providerName);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId); return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error('Timeout: sin respuesta del proveedor');
    throw error;
  }
}

// El plan free de CryptoCompare corta con "rate limit" si le llegan varios pedidos casi
// simultáneos. Esta cola serializa TODOS los pedidos a CryptoCompare de la app entera,
// dejando un margen mínimo entre uno y el siguiente. Solo se usa para tráfico EN VIVO
// (quote + velas del panel) — el backtest sigue yendo directo a TwelveData nada más,
// porque ahí sí se piden cientos de velas de una y se comería la cuota mensual rápido.
let ccQueue = Promise.resolve();
let ccLastCallAt = 0;
const CC_MIN_GAP_MS = 1100;
function fetchCryptoCompare(url, headers) {
  const run = ccQueue.then(async () => {
    const wait = ccLastCallAt + CC_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    ccLastCallAt = Date.now();
    return fetchWithTimeout(url, CONFIG.REQUEST_TIMEOUT, { headers }, 'cryptocompare');
  });
  ccQueue = run.catch(() => {});
  return run;
}

function getAssetLocalTime(asset) {
  const now = getNow();
  if (asset.timezone === 'UTC') return now;
  try { return new Date(now.toLocaleString('en-US', { timeZone: asset.timezone })); } catch(e) { return now; }
}

function isForexWeekOpen() {
  const now = new Date(); const day = now.getUTCDay(); const hour = now.getUTCHours();
  if (day === 6) return false; if (day === 0) return hour >= 22; if (day === 5) return hour < 22; return true;
}

const FX_SESSIONS = [
  { key: 'sydney', label: 'Sídney', start: 21, end: 6 },
  { key: 'tokyo', label: 'Tokio', start: 0, end: 9 },
  { key: 'london', label: 'Londres', start: 7, end: 16 },
  { key: 'newyork', label: 'Nueva York', start: 12, end: 21 }
];

function getActiveForexSessions() {
  if (!isForexWeekOpen()) return [];
  const hour = new Date().getUTCHours();
  return FX_SESSIONS.filter(s => s.start < s.end ? (hour >= s.start && hour < s.end) : (hour >= s.start || hour < s.end));
}

function isMarketOpenForAsset(symbol) {
  const asset = ASSETS[symbol]; if (!asset) return false;
  if (asset.is24h) return true; if (asset.market === 'forex') return isForexWeekOpen();
  const localTime = getAssetLocalTime(asset); const day = localTime.getDay(); const hour = localTime.getHours();
  if (!asset.openDays.includes(day)) return false;
  if (hour < asset.openHour || hour >= asset.closeHour) return false;
  return true;
}

function getNextMarketOpen(asset) {
  if (asset.market === 'forex') return `Dom 22:00 UTC (apertura de Sídney)`;
  let next = new Date(getAssetLocalTime(asset)); let daysChecked = 0;
  while (daysChecked < 7) { next.setDate(next.getDate() + 1); next.setHours(asset.openHour, 0, 0, 0); if (asset.openDays.includes(next.getDay())) break; daysChecked++; }
  const days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  return `${days[next.getDay()]} ${String(next.getHours()).padStart(2,'0')}:00 ${asset.timezone}`;
}

function formatTradingHours(asset) {
  if (asset.is24h) return '24/7'; if (asset.market === 'forex') return 'Dom 22:00 - Vie 22:00 UTC (Sídney→Tokio→Londres→NY)';
  const days = asset.openDays.map(d => ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d]).join(',');
  return `${days} ${String(asset.openHour).padStart(2,'0')}:00-${String(asset.closeHour).padStart(2,'0')}:00 ${asset.timezone}`;
}

function calculateSpread(bid, ask, pipSize = 0.0001) { if (!bid || !ask || bid <= 0 || ask <= 0) return null; return (ask - bid) / pipSize; }

function addLog(provider, action, symbol) {
  const entry = { time: new Date().toLocaleTimeString('es-ES'), provider, action, symbol };
  state.logs.unshift(entry); if (state.logs.length > 20) state.logs.pop();
}

function getProviderCooldownMs(errorMessage) {
  const msg = (errorMessage || '').toLowerCase();
  if (msg.includes('429') || msg.includes('rate limit')) return 10 * 60 * 1000;
  if (msg.includes('451')) return 30 * 60 * 1000;
  if (msg.includes('402')) return 60 * 60 * 1000;
  if (msg.includes('403')) return 15 * 60 * 1000;
  return null;
}

function markProviderCooldown(providerName, errorMessage) {
  const ms = getProviderCooldownMs(errorMessage); if (!ms) return;
  state.providerCooldownUntil = state.providerCooldownUntil || {};
  state.providerCooldownUntil[providerName] = Date.now() + ms;
}

function isProviderInCooldown(providerName) {
  const until = state.providerCooldownUntil && state.providerCooldownUntil[providerName];
  return !!until && Date.now() < until;
}

const ResponseCache = {
  data: {},
  get(key) {
    const entry = this.data[key]; if (!entry) return null;
    if (Date.now() - entry.time > CONFIG.CACHE_TTL) { delete this.data[key]; return null; }
    return entry.value;
  },
  set(key, value) { this.data[key] = { time: Date.now(), value }; },
  clear() { this.data = {}; },
  clearSymbol(symbol) { Object.keys(this.data).forEach(key => { if (key.includes(symbol)) delete this.data[key]; }); }
};

const ProviderAdapters = {
  metaapi: {
    name: 'MetaApi (MT5)', requiresKey: true, supports: ['BTCUSD','ETHUSD','EURUSD','XAUUSD'],
    async fetchQuote(symbol) {
      if (!state.apiKeys.metaapi || !state.metaapiAccountId) throw new Error('MetaApi no configurado (falta token o accountId)');
      const asset = ASSETS[symbol];
      const cacheKey = `ma_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const url = `${CONFIG.ENDPOINTS.METAAPI_MARKET_DATA}/users/current/accounts/${state.metaapiAccountId}/symbols/${asset.symbols.metaapi}/current-price`;
      const res = await fetchWithTimeout(url, CONFIG.REQUEST_TIMEOUT, { headers: { 'auth-token': state.apiKeys.metaapi } }, 'metaapi');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      // MetaApi devuelve bid/ask reales del broker conectado (a diferencia de la mayoría
      // de los proveedores gratuitos de arriba, que estiman el spread con ±0.05%).
      const bid = d.bid, ask = d.ask, last = (bid + ask) / 2;
      const data = new MarketData({
        bid, ask, last, open: d.open || last, high: d.high || last, low: d.low || last, close: last,
        volume: 0, timestamp: Date.now(), timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(bid, ask, asset.pipSize), source: 'MetaApi (MT5)', symbol, estimatedSpread: false
      });
      ResponseCache.set(cacheKey, data); return data;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      if (!state.apiKeys.metaapi || !state.metaapiAccountId) throw new Error('MetaApi no configurado (falta token o accountId)');
      const asset = ASSETS[symbol];
      const cacheKey = `ma_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const tfMap = { '5m': '5m', '15m': '15m', '1h': '1h' };
      const url = `${CONFIG.ENDPOINTS.METAAPI_MARKET_DATA}/users/current/accounts/${state.metaapiAccountId}/historical-market-data/symbols/${asset.symbols.metaapi}/timeframes/${tfMap[interval] || '15m'}/candles?limit=${limit}`;
      const res = await fetchWithTimeout(url, CONFIG.REQUEST_TIMEOUT, { headers: { 'auth-token': state.apiKeys.metaapi } }, 'metaapi');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const result = new OHLCVData(data.map(k => ({
        time: new Date(k.time).getTime(), open: k.open, high: k.high, low: k.low, close: k.close, volume: k.tickVolume || 0
      })));
      ResponseCache.set(cacheKey, result); return result;
    }
  },

  binanceSpot: {
    name: 'Binance Spot', requiresKey: false, supports: ['BTCUSD','ETHUSD'],
    async fetchQuote(symbol) {
      const asset = ASSETS[symbol];
      const cacheKey = `bs_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.BINANCE_SPOT}/ticker/24hr?symbol=${asset.symbols.binance}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const data = new MarketData({
        bid: parseFloat(d.bidPrice), ask: parseFloat(d.askPrice), last: parseFloat(d.lastPrice),
        open: parseFloat(d.openPrice), high: parseFloat(d.highPrice), low: parseFloat(d.lowPrice),
        close: parseFloat(d.prevClosePrice), volume: parseFloat(d.volume), timestamp: Date.now(),
        timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(parseFloat(d.bidPrice), parseFloat(d.askPrice), asset.pipSize),
        source: 'Binance Spot', symbol, estimatedSpread: false
      });
      ResponseCache.set(cacheKey, data); return data;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      const asset = ASSETS[symbol];
      const cacheKey = `bs_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const tfMap = { '5m': '5m', '15m': '15m', '1h': '1h' };
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.BINANCE_SPOT}/klines?symbol=${asset.symbols.binance}&interval=${tfMap[interval]||'15m'}&limit=${limit}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const result = new OHLCVData(data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) })));
      ResponseCache.set(cacheKey, result); return result;
    }
  },

  binanceFutures: {
    name: 'Binance Futures', requiresKey: false, supports: ['BTCUSD','ETHUSD'],
    async fetchQuote(symbol) {
      const asset = ASSETS[symbol];
      const cacheKey = `bf_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.BINANCE_FUTURES}/ticker/24hr?symbol=${asset.symbols.binance}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const data = new MarketData({
        bid: parseFloat(d.bidPrice), ask: parseFloat(d.askPrice), last: parseFloat(d.lastPrice),
        open: parseFloat(d.openPrice), high: parseFloat(d.highPrice), low: parseFloat(d.lowPrice),
        close: parseFloat(d.prevClosePrice), volume: parseFloat(d.volume), timestamp: Date.now(),
        timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(parseFloat(d.bidPrice), parseFloat(d.askPrice), asset.pipSize),
        source: 'Binance Futures', symbol, estimatedSpread: false
      });
      ResponseCache.set(cacheKey, data); return data;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      const asset = ASSETS[symbol];
      const cacheKey = `bf_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const tfMap = { '5m': '5m', '15m': '15m', '1h': '1h' };
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.BINANCE_FUTURES}/klines?symbol=${asset.symbols.binance}&interval=${tfMap[interval]||'15m'}&limit=${limit}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const result = new OHLCVData(data.map(k => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) })));
      ResponseCache.set(cacheKey, result); return result;
    }
  },

  // CryptoCompare se sacó del todo: su plan gratuito solo permite 100 consultas
  // por MES para este tipo de dato (histominute), no alcanza para uso real.

  exchangerate: {
    name: 'ExchangeRate-API', requiresKey: false, supports: ['EURUSD'],
    async fetchQuote(symbol) {
      const asset = ASSETS[symbol];
      const cacheKey = `er_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.EXCHANGERATE}/USD`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const rate = data.rates[asset.symbols.exchangerate];
      if (!rate) throw new Error('Rate not found');
      const price = 1 / rate;
      const marketData = new MarketData({
        bid: price * 0.9995, ask: price * 1.0005, last: price, open: price, high: price, low: price, close: price, volume: 0,
        timestamp: Date.now(), timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(price * 0.9995, price * 1.0005, asset.pipSize), source: 'ExchangeRate-API', symbol, estimatedSpread: true
      });
      ResponseCache.set(cacheKey, marketData); return marketData;
    }
  },

  twelveData: {
    name: 'Twelve Data', requiresKey: true, supports: ['BTCUSD','ETHUSD','EURUSD','XAUUSD'],
    async fetchQuote(symbol) {
      if (!state.apiKeys.twelveData) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `td_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const headers = new Headers(); headers.append('Authorization', `apikey ${state.apiKeys.twelveData}`);
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.TWELVEDATA}/quote?symbol=${asset.symbols.twelveData}`, CONFIG.REQUEST_TIMEOUT, { headers }, 'twelveData');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      if (d.status === 'error') throw new Error(d.message || 'Error de Twelve Data');
      const lastPrice = parseFloat(d.close);
      const bid = parseFloat(d.bid) || lastPrice, ask = parseFloat(d.ask) || lastPrice;
      const data = new MarketData({
        bid, ask, last: lastPrice, open: parseFloat(d.open), high: parseFloat(d.high),
        low: parseFloat(d.low), close: parseFloat(d.previous_close), volume: parseFloat(d.volume), timestamp: Date.now(),
        timeframe: '1d', marketStatus: d.is_market_open ? 'open' : 'closed',
        spread: calculateSpread(bid, ask, asset.pipSize), source: 'Twelve Data', symbol, estimatedSpread: !d.bid || !d.ask
      });
      ResponseCache.set(cacheKey, data); return data;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      if (!state.apiKeys.twelveData) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `td_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const tfMap = { '5m': '5min', '15m': '15min', '1h': '1h' };
      const headers = new Headers(); headers.append('Authorization', `apikey ${state.apiKeys.twelveData}`);
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.TWELVEDATA}/time_series?symbol=${asset.symbols.twelveData}&interval=${tfMap[interval]||'15min'}&outputsize=${limit}`, CONFIG.REQUEST_TIMEOUT, { headers }, 'twelveData');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.status === 'error') throw new Error(data.message || 'Error de Twelve Data');
      const result = new OHLCVData(data.values.reverse().map(k => ({ time: new Date(k.datetime).getTime(), open: parseFloat(k.open), high: parseFloat(k.high), low: parseFloat(k.low), close: parseFloat(k.close), volume: parseFloat(k.volume) })));
      ResponseCache.set(cacheKey, result); return result;
    }
  },

  finnhub: {
    name: 'Finnhub', requiresKey: true, supports: ['BTCUSD','ETHUSD','EURUSD','XAUUSD'],
    async fetchQuote(symbol) {
      if (!state.apiKeys.finnhub) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `fh_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.FINNHUB}/quote?symbol=${asset.symbols.finnhub}&token=${state.apiKeys.finnhub}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json(); if (d.error) throw new Error(d.error);
      const price = d.c; const bid = price * 0.9995; const ask = price * 1.0005;
      const data = new MarketData({
        bid, ask, last: price, open: d.o, high: d.h, low: d.l, close: d.pc, volume: d.v,
        timestamp: Date.now(), timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(bid, ask, asset.pipSize), source: 'Finnhub', symbol, estimatedSpread: true
      });
      ResponseCache.set(cacheKey, data); return data;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      if (!state.apiKeys.finnhub) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `fh_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const tfMap = { '5m': '5', '15m': '15', '1h': '60' };
      const now = Math.floor(Date.now() / 1000);
      const from = now - (limit * parseInt(tfMap[interval]||'15') * 60);
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.FINNHUB}/stock/candle?symbol=${asset.symbols.finnhub}&resolution=${tfMap[interval]||'15'}&from=${from}&to=${now}&token=${state.apiKeys.finnhub}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json(); if (data.s !== 'ok') throw new Error('Sin datos de velas');
      const result = new OHLCVData(data.t.map((t, i) => ({ time: t * 1000, open: data.o[i], high: data.h[i], low: data.l[i], close: data.c[i], volume: data.v[i] })));
      ResponseCache.set(cacheKey, result); return result;
    }
  },

  cryptocompare: {
    name: 'CryptoCompare', requiresKey: true, supports: ['BTCUSD','ETHUSD','XAUUSD','EURUSD'],
    async fetchQuote(symbol) {
      const asset = ASSETS[symbol];
      const fsym = asset.symbols.cryptocompare;
      const cacheKey = `cc_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const headers = { authorization: `Apikey ${state.apiKeys.cryptocompare}` };
      const res = await fetchCryptoCompare(`${CONFIG.ENDPOINTS.CRYPTOCOMPARE}/pricemultifull?fsyms=${fsym}&tsyms=USD`, headers);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.RAW || !data.RAW[fsym] || !data.RAW[fsym].USD) throw new Error(data.Message || 'Respuesta inválida de CryptoCompare');
      const d = data.RAW[fsym].USD;
      const marketData = new MarketData({
        bid: d.BID, ask: d.ASK, last: d.PRICE,
        open: d.OPEN24HOUR || d.PRICE, high: d.HIGH24HOUR, low: d.LOW24HOUR,
        close: d.PRICE, volume: d.VOLUME24HOURTO,
        timestamp: d.LASTUPDATE * 1000, timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(d.BID, d.ASK, asset.pipSize),
        source: 'CryptoCompare', symbol, estimatedSpread: false
      });
      ResponseCache.set(cacheKey, marketData); return marketData;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      const asset = ASSETS[symbol];
      const fsym = asset.symbols.cryptocompare;
      const cacheKey = `cc_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const tfMap = { '5m': '5', '15m': '15', '1h': '60' };
      const headers = { authorization: `Apikey ${state.apiKeys.cryptocompare}` };
      const res = await fetchCryptoCompare(
        `${CONFIG.ENDPOINTS.CRYPTOCOMPARE}/v2/histominute?fsym=${fsym}&tsym=USD&limit=${limit}&aggregate=${tfMap[interval]||'15'}`,
        headers
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.Response !== 'Success') throw new Error(data.Message);
      const result = new OHLCVData(data.Data.Data.map(k => ({
        time: k.time * 1000, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volumefrom
      })));
      ResponseCache.set(cacheKey, result); return result;
    }
  },

  alphaVantage: {
    name: 'Alpha Vantage', requiresKey: true, supports: ['BTCUSD','ETHUSD','EURUSD','XAUUSD'],
    async fetchQuote(symbol) {
      if (!state.apiKeys.alphaVantage) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `av_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
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
      // Alpha Vantage no manda "Error Message" cuando pega el límite diario (25/día en el
      // plan free) o cuando la función pedida es premium (CRYPTO_INTRADAY lo es) — manda
      // "Note" o "Information" con el aviso, y sin esto el error salía genérico.
      if (data['Note']) throw new Error('Límite diario alcanzado: ' + data['Note']);
      if (data['Information']) throw new Error(data['Information']);
      const d = data['Realtime Currency Exchange Rate']; if (!d) throw new Error('Respuesta inesperada de Alpha Vantage');
      const price = parseFloat(d['5. Exchange Rate']);
      const marketData = new MarketData({
        bid: price * 0.9995, ask: price * 1.0005, last: price, open: price, high: price, low: price, close: price, volume: 0,
        timestamp: Date.now(), timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(price * 0.9995, price * 1.0005, asset.pipSize), source: 'Alpha Vantage', symbol, estimatedSpread: true
      });
      ResponseCache.set(cacheKey, marketData); return marketData;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      if (!state.apiKeys.alphaVantage) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `av_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
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
      if (data['Note']) throw new Error('Límite diario alcanzado: ' + data['Note']);
      // CRYPTO_INTRADAY es una función premium de Alpha Vantage: con key free siempre
      // devuelve "Information" en vez de velas para BTC/ETH — nunca va a haber datos acá
      // para cripto en el plan gratuito, no es un fallo intermitente.
      if (data['Information']) throw new Error(data['Information']);
      const key = Object.keys(data).find(k => k.includes('Time Series')); if (!key) throw new Error('Sin datos históricos');
      const result = new OHLCVData(Object.entries(data[key]).slice(0, limit).reverse().map(([time, vals]) => ({
        time: new Date(time).getTime(), open: parseFloat(vals['1. open']), high: parseFloat(vals['2. high']),
        low: parseFloat(vals['3. low']), close: parseFloat(vals['4. close']), volume: parseFloat(vals['5. volume'] || 0)
      })));
      ResponseCache.set(cacheKey, result); return result;
    }
  },

  fmp: {
    name: 'Financial Modeling Prep', requiresKey: true, supports: ['BTCUSD','ETHUSD','EURUSD','XAUUSD'],
    async fetchQuote(symbol) {
      if (!state.apiKeys.fmp) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `fmp_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.FMP}/quote?symbol=${asset.symbols.fmp}&apikey=${state.apiKeys.fmp}`, CONFIG.REQUEST_TIMEOUT, {}, 'fmp');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json(); if (data['Error Message']) throw new Error(data['Error Message']);
      const d = data[0]; if (!d) throw new Error('Sin datos');
      const price = d.price; const bid = price * 0.9995; const ask = price * 1.0005;
      const marketData = new MarketData({
        bid, ask, last: price, open: d.open, high: d.dayHigh, low: d.dayLow, close: d.previousClose, volume: d.volume,
        timestamp: Date.now(), timeframe: '1d', marketStatus: d.isMarketOpen ? 'open' : 'closed',
        spread: calculateSpread(bid, ask, asset.pipSize), source: 'FMP', symbol, estimatedSpread: true
      });
      ResponseCache.set(cacheKey, marketData); return marketData;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      if (!state.apiKeys.fmp) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `fmp_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.FMP}/historical-chart/${interval === '5m' ? '5min' : interval === '15m' ? '15min' : '1hour'}?symbol=${asset.symbols.fmp}&apikey=${state.apiKeys.fmp}`, CONFIG.REQUEST_TIMEOUT, {}, 'fmp');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json(); if (data['Error Message']) throw new Error(data['Error Message']);
      const result = new OHLCVData(data.slice(0, limit).reverse().map(k => ({ time: new Date(k.date).getTime(), open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })));
      ResponseCache.set(cacheKey, result); return result;
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

    const readyProviders = eligible.filter(p => !isProviderInCooldown(p));
    const providersToTry = readyProviders.length > 0 ? readyProviders : eligible;

    for (const providerName of providersToTry) {
      const adapter = ProviderAdapters[providerName];
      addLog(adapter.name, 'INTENTO', symbol);
      try {
        const data = await adapter.fetchQuote(symbol);
        if (!data.isValid) throw new Error('Datos inválidos');
        state.providers[providerName] = 'ok';
        state.providerStats[providerName] = { lastSuccess: Date.now(), successCount: (state.providerStats[providerName]?.successCount || 0) + 1 };
        addLog(adapter.name, 'ÉXITO', symbol);
        state.currentProvider = providerName;
        return data;
      } catch (error) {
        state.providers[providerName] = 'fail';
        state.providerStats[providerName] = {
          lastSuccess: state.providerStats[providerName]?.lastSuccess || null,
          lastError: Date.now(), errorCount: (state.providerStats[providerName]?.errorCount || 0) + 1, lastErrorMsg: error.message
        };
        markProviderCooldown(providerName, error.message);
        addLog(adapter.name, 'FALLO: ' + error.message, symbol);
        console.warn(`Provider ${providerName} falló para ${symbol}:`, error.message);
        await sleep(1500);
      }
    }

    const detailMessages = providersToTry.map((name) => {
      const stats = state.providerStats[name]; return `${name}: ${stats?.lastErrorMsg || 'falló'}`;
    }).join('; ');
    throw new Error(`Todos los proveedores fallaron: ${detailMessages}`);
  },

  async getOHLCV(symbol, tf, limit = 100, forceRefresh = false) {
    const asset = ASSETS[symbol];
    if (!asset) return new OHLCVData([]);
    if (!isMarketOpenForAsset(symbol)) return state.klineHistory[symbol] || new OHLCVData([]);

    const providerList = asset.providerPriority || CONFIG.PROVIDER_PRIORITY;
    const eligible = providerList.filter(providerName => {
      const adapter = ProviderAdapters[providerName];
      return adapter && adapter.fetchOHLCV && adapter.supports.includes(symbol) && !(adapter.requiresKey && !state.apiKeys[providerName]);
    });

    if (eligible.length > 0) {
      const readyProviders = eligible.filter(p => !isProviderInCooldown(p));
      const providersToTry = readyProviders.length > 0 ? readyProviders : eligible;

      for (const providerName of providersToTry) {
        try {
          const data = await ProviderAdapters[providerName].fetchOHLCV(symbol, tf, limit);
          if (!data.isValid) throw new Error('Datos insuficientes');
          state.klineHistory[symbol] = data; return data;
        } catch (error) {
          markProviderCooldown(providerName, error.message);
          console.warn(`OHLCV ${providerName} falló:`, error.message);
          await sleep(1500);
        }
      }
      if (state.klineHistory[symbol] && state.klineHistory[symbol].candles.length > 0) return state.klineHistory[symbol];
      throw new Error(`No se pudieron obtener velas históricas`);
    }

    if (state.klineHistory[symbol] && state.klineHistory[symbol].candles.length > 0) return state.klineHistory[symbol];
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

function detectMarketRegime(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 'unknown';
  const slice = candles.slice(-(period + 1));
  const netMove = Math.abs(slice[slice.length - 1].close - slice[0].close);
  let volatilitySum = 0;
  for (let i = 1; i < slice.length; i++) volatilitySum += Math.abs(slice[i].close - slice[i - 1].close);
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
    if (lowerLows && last.close > lastLH.price) { bullish = true; details.push('CHoCH alcista'); }
    const higherHighs = sh[2].price > sh[1].price && sh[1].price > sh[0].price;
    const lastHL = sl[sl.length - 1];
    if (higherHighs && last.close < lastHL.price) { bearish = true; details.push('CHoCH bajista'); }
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
    if (c3.low > c1.high && last.close > c3.low) { bullish = true; bullZone = { low: c1.high, high: c3.low }; details.push('FVG alcista'); }
    if (c3.high < c1.low && last.close < c3.high) { bearish = true; bearZone = { low: c3.high, high: c1.low }; details.push('FVG bajista'); }
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
      bullishOB = true; bullZone = { low: Math.min(prev2.open, prev2.close), high: Math.max(prev2.open, prev2.close) }; details.push('Order Block alcista');
    }
    if (impulsoDown && prev3.close > prev3.open && prev2.close < prev2.open) {
      bearishOB = true; bearZone = { low: Math.min(prev2.open, prev2.close), high: Math.max(prev2.open, prev2.close) }; details.push('Order Block bajista');
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
    if (last.low < lastSL.price && last.low < prevSL.price && last.close > lastSL.price) { bullish = true; details.push('Barrida de liquidez (mínimos)'); }
    if (last.high > lastSH.price && last.high > prevSH.price && last.close < lastSH.price) { bearish = true; details.push('Barrida de liquidez (máximos)'); }
    return { bullish, bearish, score: (bullish || bearish) ? 15 : 0, details };
  }

  static detectVPattern(candles, atr, lookback = 14) {
    const empty = { bullish: false, bearish: false, score: 0, details: [] };
    if (!candles || candles.length < lookback + 1 || !atr) return empty;
    const window = candles.slice(-lookback);
    const last = window[window.length - 1];
    let troughIdx = 0, peakIdx = 0;
    for (let i = 1; i < window.length; i++) { if (window[i].low < window[troughIdx].low) troughIdx = i; if (window[i].high > window[peakIdx].high) peakIdx = i; }
    const minLegBars = 2, maxLegBars = 6, steepMultiplier = 1.8;
    let bullish = false, bearish = false;
    const details = [];
    const downBars = troughIdx;
    const upBars = window.length - 1 - troughIdx;
    if (downBars >= minLegBars && downBars <= maxLegBars && upBars >= minLegBars && upBars <= maxLegBars) {
      const startHigh = window[0].high, troughLow = window[troughIdx].low;
      const downMove = startHigh - troughLow, upMove = last.close - troughLow;
      const symmetric = upMove >= downMove * 0.5;
      if (downMove >= atr * steepMultiplier && upMove >= atr * steepMultiplier && symmetric && last.close > last.open) { bullish = true; details.push('Patrón V (reversión en piso)'); }
    }
    const upBarsToPeak = peakIdx;
    const downBarsFromPeak = window.length - 1 - peakIdx;
    if (upBarsToPeak >= minLegBars && upBarsToPeak <= maxLegBars && downBarsFromPeak >= minLegBars && downBarsFromPeak <= maxLegBars) {
      const startLow = window[0].low, peakHigh = window[peakIdx].high;
      const upMove = peakHigh - startLow, downMove = peakHigh - last.close;
      const symmetric = downMove >= upMove * 0.5;
      if (upMove >= atr * steepMultiplier && downMove >= atr * steepMultiplier && symmetric && last.close < last.open) { bearish = true; details.push('Patrón V invertida (reversión en techo)'); }
    }
    return { bullish, bearish, score: (bullish || bearish) ? 15 : 0, details };
  }

  static calculatePivotPoints(candles) {
    if (!candles || candles.length < 10) return null;
    const byDay = {};
    candles.forEach(c => { const day = new Date(c.time).toISOString().slice(0, 10); (byDay[day] = byDay[day] || []).push(c); });
    const days = Object.keys(byDay).sort();
    const todayStr = new Date().toISOString().slice(0, 10);
    const completedDays = days.filter(d => d !== todayStr);
    let refCandles;
    if (completedDays.length > 0) refCandles = byDay[completedDays[completedDays.length - 1]];
    else { const half = Math.floor(candles.length / 2); refCandles = candles.slice(0, Math.max(half, 10)); }
    const high = Math.max(...refCandles.map(c => c.high));
    const low = Math.min(...refCandles.map(c => c.low));
    const close = refCandles[refCandles.length - 1].close;
    const pivot = (high + low + close) / 3;
    return { pivot, r1: 2 * pivot - low, s1: 2 * pivot - high, r2: pivot + (high - low), s2: pivot - (high - low) };
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

  static calculateWMA(values, period) {
    if (!values || values.length < period) return null;
    const slice = values.slice(-period);
    let weightedSum = 0, weightTotal = 0;
    for (let i = 0; i < slice.length; i++) { const weight = i + 1; weightedSum += slice[i] * weight; weightTotal += weight; }
    return weightedSum / weightTotal;
  }

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

  static percentileNearestRank(values, percentile) {
    if (!values || !values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((percentile / 100) * sorted.length);
    const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
    return sorted[idx];
  }

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
    const trueRanges = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]; const midband = hmaSeries[i];
      if (i > 0) {
        const prevClose = candles[i - 1].close;
        trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
      }
      const atrWindow = trueRanges.slice(-atrLength);
      const atr = atrWindow.length ? atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length : null;
      const candleDirection = c.close > c.open ? 1 : -1;
      const candleBody = Math.abs(c.close - c.open);
      if (candleDirection < 0) { if (bullishMoveBuild > 0) { bullishMoves.unshift(bullishMoveBuild); if (bullishMoves.length > sampleMemory) bullishMoves.pop(); } bullishMoveBuild = 0; }
      else { bullishMoveBuild += candleBody; }
      if (candleDirection > 0) { if (bearishMoveBuild > 0) { bearishMoves.unshift(bearishMoveBuild); if (bearishMoves.length > sampleMemory) bearishMoves.pop(); } bearishMoveBuild = 0; }
      else { bearishMoveBuild += candleBody; }
      lastBullishSignal = false; lastBearishSignal = false;
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
      if (bullishSignal) { trailDirection = 1; lastSignalDirection = 1; outsideCount = 0; const bullishStartDistance = Math.max(midband - lowerTrailSource, atr * trailDistanceMultiplier); trailValue = Math.min(midband - bullishStartDistance, c.low); }
      else if (bearishSignal) { trailDirection = -1; lastSignalDirection = -1; outsideCount = 0; const bearishStartDistance = Math.max(upperTrailSource - midband, atr * trailDistanceMultiplier); trailValue = Math.max(midband + bearishStartDistance, c.high); }
      else if (trailDirection === 1) { trailValue = Math.max(trailValue, lowerTrailSource); outsideCount = c.low < trailValue ? outsideCount + 1 : 0; if (outsideCount >= invalidationBars) { trailDirection = 0; trailValue = null; outsideCount = 0; } }
      else if (trailDirection === -1) { trailValue = Math.min(trailValue, upperTrailSource); outsideCount = c.high > trailValue ? outsideCount + 1 : 0; if (outsideCount >= invalidationBars) { trailDirection = 0; trailValue = null; outsideCount = 0; } }
      lastBullishSignal = bullishSignal; lastBearishSignal = bearishSignal;
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
    return (utcHour >= 7 && utcHour < 10) || (utcHour >= 12 && utcHour < 15);
  }

  static getNYTimeParts(ms) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false
    }).formatToParts(new Date(ms));
    return {
      weekday: parts.find(p => p.type === 'weekday').value,
      hour: parseInt(parts.find(p => p.type === 'hour').value, 10) % 24,
      minute: parseInt(parts.find(p => p.type === 'minute').value, 10)
    };
  }

  static isNYKillZoneWindow(nowMs = Date.now()) {
    const { weekday, hour, minute } = this.getNYTimeParts(nowMs);
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    const minutesNow = hour * 60 + minute;
    return minutesNow >= (9 * 60 + 30) && minutesNow < (13 * 60 + 30);
  }

  static detectNYKillZoneSweep(candles, regime) {
    const result = { bullish: false, bearish: false };
    if (!this.isNYKillZoneWindow()) return result;
    if (regime === 'ranging') return result;
    if (!candles || candles.length < 5) return result;

    const last = candles[candles.length - 1];
    const lastNY = this.getNYTimeParts(last.time);
    if (lastNY.hour * 60 + lastNY.minute < 9 * 60 + 45) return result;

    let openIdx = -1;
    for (let i = candles.length - 1; i >= 0 && i >= candles.length - 20; i--) {
      const p = this.getNYTimeParts(candles[i].time);
      if (p.hour === 9 && p.minute >= 30 && p.minute < 45) { openIdx = i; break; }
    }
    if (openIdx === -1 || openIdx >= candles.length - 1) return result;

    const openCandle = candles[openIdx];
    const sessionCandles = candles.slice(openIdx);
    if (sessionCandles.length < 2) return result;

    const bias = openCandle.close > openCandle.open ? 'bull' : (openCandle.close < openCandle.open ? 'bear' : null);
    if (!bias) return result;

    const prior = candles[candles.length - 2];
    const between = sessionCandles.slice(1, -1);

    if (bias === 'bull') {
      const sweptLow = between.some(c => c.low < openCandle.low) || last.low < openCandle.low;
      const strongBull = last.close > last.open && last.close > prior.high;
      if (sweptLow && strongBull) result.bullish = true;
    } else {
      const sweptHigh = between.some(c => c.high > openCandle.high) || last.high > openCandle.high;
      const strongBear = last.close < last.open && last.close < prior.low;
      if (sweptHigh && strongBear) result.bearish = true;
    }
    return result;
  }

  static checkVolumeConfirmation(candles, lookback = 20, multiplier = 1.2) {
    if (!candles || candles.length < lookback + 1) return { confirmed: true, available: false, score: 0, ratio: null };
    const last = candles[candles.length - 1];
    const prevCandles = candles.slice(-(lookback + 1), -1);
    const avgVolume = prevCandles.reduce((sum, c) => sum + (c.volume || 0), 0) / prevCandles.length;
    if (!avgVolume) return { confirmed: true, available: false, score: 0, ratio: null };
    const ratio = last.volume / avgVolume;
    const confirmed = ratio >= multiplier;
    return { confirmed, available: true, score: confirmed ? 10 : 0, ratio };
  }

  static checkConfirmationCandle(candles, direction, atr) {
    if (!direction || !candles || candles.length < 1) return { confirmed: false, bodyRatio: 0 };
    const last = candles[candles.length - 1];
    const body = Math.abs(last.close - last.open);
    const minBody = (atr || 0) * 0.3;
    const aligned = direction === 'long' ? last.close > last.open : last.close < last.open;
    return { confirmed: aligned && body >= minBody, bodyRatio: atr ? +(body / atr).toFixed(2) : 0 };
  }

  static checkMitigation(candles, direction, ob, fvg, atr) {
    const zone = direction === 'long' ? (ob.bullZone || fvg.bullZone) : (ob.bearZone || fvg.bearZone);
    if (!zone) return { required: false, confirmed: true };
    const last = candles[candles.length - 1];
    const tolerance = (atr || 0) * 0.3;
    return { required: true, confirmed: last.close >= zone.low - tolerance && last.close <= zone.high + tolerance };
  }

  static detectHTFTrend(htfCandles) {
    if (!htfCandles || htfCandles.length < 20) return null;
    return this.detectTrend(htfCandles);
  }

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
    const oteLongZone = { low: low + range * 0.618, high: low + range * 0.79 };
    const oteShortZone = { low: low + range * 0.21, high: low + range * 0.382 };
    return { high, low, equilibrium, zone, oteLongZone, oteShortZone, inOteLong: last.close >= oteLongZone.low && last.close <= oteLongZone.high, inOteShort: last.close >= oteShortZone.low && last.close <= oteShortZone.high };
  }

  static analyze(candles, strictMode = false, assetType = 'forex', htfCandles = null, confidenceThreshold = CONFIG.CONFIDENCE_THRESHOLD, patternStats = {}) {
    if (!candles || candles.length < 20) return { valid: false, reason: 'Datos históricos insuficientes (se necesitan al menos 20 velas).' };
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
    const regime = detectMarketRegime(candles);
    const nyKZ = this.detectNYKillZoneSweep(candles, regime);

    const STRATEGIES = [
      { key: 'choch', label: 'CHoCH (cambio de carácter)', base: 82, bullish: choch.bullish, bearish: choch.bearish },
      { key: 'nykz', label: 'Kill Zone NY (apertura + barrida)', base: 80, bullish: nyKZ.bullish, bearish: nyKZ.bearish },
      { key: 'sweep', label: 'Barrida de liquidez', base: 78, bullish: sweep.bullish, bearish: sweep.bearish },
      { key: 'bos', label: 'BOS (ruptura de estructura)', base: 76, bullish: bos.bullish, bearish: bos.bearish },
      { key: 'reversal', label: 'Bandas de Reversión (AlgoAlpha)', base: 75, bullish: reversal.bullish, bearish: reversal.bearish },
      { key: 'ob', label: 'Order Block', base: 74, bullish: ob.bullishOB, bearish: ob.bearishOB },
      { key: 'vpattern', label: 'Patrón V', base: 70, bullish: vPattern.bullish, bearish: vPattern.bearish },
      { key: 'fvg', label: 'FVG (Fair Value Gap)', base: 68, bullish: fvg.bullish, bearish: fvg.bearish }
    ];

    const bullHits = STRATEGIES.filter(s => s.bullish);
    const bearHits = STRATEGIES.filter(s => s.bearish);

    function evalSide(hits) {
      if (hits.length === 0) return { confidence: 0, hits: [] };
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

    const pivotReinforces = !!(direction && ((direction === 'long' && pivotSig.bullish) || (direction === 'short' && pivotSig.bearish)));
    if (pivotReinforces) confidence = Math.min(100, confidence + 4);
    const pivotLevel = pivotReinforces ? pivotSig.level : null;

    const killZoneApplies = !!(direction && killZone && assetType !== 'crypto');
    if (killZoneApplies) confidence = Math.min(100, confidence + 6);

    const oteBonusApplies = !!(direction && premiumDiscount && ((direction === 'long' && premiumDiscount.inOteLong) || (direction === 'short' && premiumDiscount.inOteShort)));
    if (oteBonusApplies) confidence = Math.min(100, confidence + 8);

    const isConfluence = activeHits.length > 1;
    const strategyLabels = activeHits.map(s => s.label);
    const strategyKeys = activeHits.map(s => s.key);

    const patternAdj = direction ? this.getPatternAdjustment(strategyKeys, patternStats) : 0;
    if (patternAdj) confidence = Math.max(0, Math.min(100, confidence + patternAdj));

    const filteredByConfidence = !!(direction && confidence < confidenceThreshold);
    if (filteredByConfidence) direction = null;

    const filteredByVolume = !!(direction && volumeCheck.available && !volumeCheck.confirmed);
    if (filteredByVolume) direction = null;

    const confirmCandle = this.checkConfirmationCandle(candles, direction, atr);
    const filteredByCandle = !!(direction && !confirmCandle.confirmed);
    if (filteredByCandle) direction = null;

    const mitigation = strictMode ? this.checkMitigation(candles, direction, ob, fvg, atr) : { required: false, confirmed: true };
    const filteredByMitigation = !!(direction && mitigation.required && !mitigation.confirmed);
    if (filteredByMitigation) direction = null;

    const filteredByPremiumDiscount = !!(direction && premiumDiscount && ((direction === 'long' && premiumDiscount.zone === 'premium') || (direction === 'short' && premiumDiscount.zone === 'discount')));
    if (filteredByPremiumDiscount) direction = null;

    const filteredByHTF = !!(direction && htfTrend && htfTrend.direction !== 'neutral' && ((direction === 'long' && htfTrend.direction === 'bearish') || (direction === 'short' && htfTrend.direction === 'bullish')));
    if (filteredByHTF) direction = null;

    const details = direction ? (isConfluence ? [`Confluencia de ${activeHits.length} estrategias: ${strategyLabels.join(' + ')}${pivotReinforces ? ' + Pivot' : ''}${killZoneApplies ? ' + Kill Zone' : ''}`] : [`Señal por estrategia individual: ${strategyLabels[0]}${pivotReinforces ? ' (+ Pivot)' : ''}${killZoneApplies ? ' (+ Kill Zone activa)' : ''}`]) : [];

    return {
      valid: true, direction, confidence, atr, trend, killZone, isConfluence, strategyLabels, strategyKeys,
      regime, pivotLevel, pivots, filteredByConfidence, filteredByVolume, filteredByCandle,
      filteredByMitigation, filteredByHTF, htfTrendDirection: htfTrend ? htfTrend.direction : null,
      filteredByPremiumDiscount, premiumDiscountZone: premiumDiscount ? premiumDiscount.zone : null,
      volumeRatio: volumeCheck.ratio, volumeAvailable: volumeCheck.available, confidenceThreshold, patternAdj, strictMode,
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

  static getPatternAdjustment(keys, patternStats) {
    const cfg = CONFIG.AUTO_TUNE;
    if (!keys || !keys.length || !patternStats) return 0;
    const adjustments = keys.map(key => {
      const stat = patternStats[key]; if (!stat) return 0;
      const total = (stat.wins || 0) + (stat.losses || 0); if (total < cfg.PATTERN_MIN_SAMPLE) return 0;
      const winRate = stat.wins / total;
      const raw = (winRate - 0.5) * (cfg.PATTERN_MAX_BONUS / 0.5);
      return Math.max(-cfg.PATTERN_MAX_BONUS, Math.min(cfg.PATTERN_MAX_BONUS, raw));
    });
    return adjustments.reduce((a, b) => a + b, 0) / adjustments.length;
  }
}

const SignalEngine = {
  build(symbol, quote, analysis) {
    const asset = ASSETS[symbol];
    if (!analysis.valid) return { type: 'no-data', reason: analysis.reason };
    if (!analysis.direction) return { type: 'no-signal', analysis };
    const entry = quote.last;
    const atr = analysis.atr || entry * 0.005;
    const risk = atr * 1.5;
    const isLong = analysis.direction === 'long';
    const sl = isLong ? entry - risk : entry + risk;
    const tp1 = isLong ? entry + risk * 2 : entry - risk * 2;
    const tp2 = isLong ? entry + risk * 3 : entry - risk * 3;
    const slPips = toPips(sl, entry, asset);
    const tp1Pips = toPips(tp1, entry, asset);
    const tp2Pips = toPips(tp2, entry, asset);
    return {
      type: analysis.direction, symbol, asset, entry, sl, tp1, tp2, slPips, tp1Pips, tp2Pips,
      rr1: '1:2', rr2: '1:3', confidence: analysis.confidence, trend: analysis.trend.direction,
      killZone: analysis.killZone, isConfluence: analysis.isConfluence, strategyLabels: analysis.strategyLabels,
      strategyKeys: analysis.strategyKeys, regime: analysis.regime, patternAdj: analysis.patternAdj,
      pivotLevel: analysis.pivotLevel, details: analysis.details.length ? analysis.details : ['Patrón técnico detectado'],
      components: analysis.components, timestamp: Date.now(), decimals: asset.decimals
    };
  }
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const BacktestEngine = {
  async fetchCandles(symbol, interval) {
    const asset = ASSETS[symbol];
    // Nota: Binance se sacó por completo de acá. Devuelve HTTP 451 SIEMPRE desde los
    // servidores de Render (bloqueo geográfico permanente de Binance, no depende de
    // rate limit ni de nada que podamos arreglar) — mantenerlo como primer intento solo
    // hacía perder hasta 8s por corrida antes de caer a TwelveData. Se va directo a
    // TwelveData para BTC/USD y ETH/USD también.
    // CryptoCompare se sacó del todo: su plan gratuito solo permite 100 consultas
    // por MES para este tipo de dato, no alcanza para uso real.
    return this.fetchCandlesTwelveData(symbol, interval);
  },

  async fetchCandlesTwelveData(symbol, interval) {
    if (!state.apiKeys.twelveData) return null;
    const asset = ASSETS[symbol];
    const tfMap = { '15m': '15min', '1h': '1h' };
    const headers = { 'Authorization': `apikey ${state.apiKeys.twelveData}` };
    const url = `${CONFIG.ENDPOINTS.TWELVEDATA}/time_series?symbol=${asset.symbols.twelveData}&interval=${tfMap[interval] || '15min'}&outputsize=${CONFIG.BACKTEST.TWELVEDATA_CANDLE_LIMIT}`;
    const res = await fetchWithTimeout(url, 10000, { headers }, 'twelveData');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.status === 'error' || !data.values) throw new Error(data.message || 'Sin datos históricos');
    return data.values.slice().reverse().map(v => ({
      time: new Date(v.datetime).getTime(), open: parseFloat(v.open), high: parseFloat(v.high),
      low: parseFloat(v.low), close: parseFloat(v.close), volume: v.volume ? parseFloat(v.volume) : 0
    }));
  },

  async simulate(candles, assetType) {
    const cfg = CONFIG.BACKTEST;
    const events = [];
    let lastSignalIndex = -9999;
    let lastDirection = null;
    for (let i = cfg.MIN_LOOKBACK; i < candles.length - 1; i++) {
      if (i % cfg.YIELD_EVERY === 0) await sleep(0);
      const windowStart = Math.max(0, i - cfg.WINDOW_SIZE + 1);
      const window = candles.slice(windowStart, i + 1);
      const analysis = SMCEngine.analyze(window, false, assetType, null, 0, {});
      if (!analysis.valid || !analysis.direction) continue;
      if (lastDirection && analysis.direction !== lastDirection && (i - lastSignalIndex) < cfg.COOLDOWN_CANDLES) continue;
      const entryCandle = candles[i + 1]; if (!entryCandle) break;
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
        if (hitSL) { result = 'loss'; break; }
        if (hitTP) { result = 'win'; break; }
      }
      if (result) {
        events.push({ index: i, direction: analysis.direction, confidence: analysis.confidence, strategyKeys: analysis.strategyKeys, regime: analysis.regime, result });
        lastSignalIndex = i; lastDirection = analysis.direction;
      }
    }
    return events;
  },

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
    const cap = CONFIG.BACKTEST.SEED_CAP;
    Object.keys(stats).forEach(key => {
      const s = stats[key]; const total = s.wins + s.losses;
      if (total > cap) { const factor = cap / total; s.wins = Math.round(s.wins * factor); s.losses = cap - s.wins; }
    });
    return stats;
  },

  // Igual que simulate(), pero para las 5 estrategias independientes de custom-strategies.js
  // en vez de SMCEngine. No usan `confidence` ni `regime`, así que no pasan por
  // calibrateThreshold() — cada una solo suma gana/pierde por separado (aggregateCustomStats).
  // htfCandles se pasa null a propósito: en vivo (refreshAsset) sí hay HTF real, pero acá
  // solo se descarga un timeframe por corrida (fetchCandles), así que Supply and Demand
  // corre sin su filtro de tendencia mayor — igual que documenta custom-strategies.js cuando
  // no se le pasa htfCandles.
  async simulateCustom(candles, symbol, asset) {
    const cfg = CONFIG.BACKTEST;
    const events = [];
    const lastSignalIndexByStrategy = {};
    for (let i = cfg.MIN_LOOKBACK; i < candles.length - 1; i++) {
      if (i % cfg.YIELD_EVERY === 0) await sleep(0);
      const windowStart = Math.max(0, i - cfg.WINDOW_SIZE + 1);
      const window = candles.slice(windowStart, i + 1);
      let signals;
      try { signals = CustomStrategies.evaluateAll(window, symbol, asset, null); }
      catch (e) { continue; }
      for (const sig of signals) {
        const lastIdx = lastSignalIndexByStrategy[sig.strategy] ?? -9999;
        if (i - lastIdx < cfg.COOLDOWN_CANDLES) continue;
        const entry = sig.entry, sl = sig.sl, tp1 = sig.tp1;
        if (entry == null || sl == null || tp1 == null) continue;
        const isLong = sig.direction === 'long';
        let result = null;
        const horizon = Math.min(candles.length, i + 1 + cfg.MAX_HOLD_CANDLES);
        for (let j = i + 1; j < horizon; j++) {
          const c = candles[j];
          const hitSL = isLong ? c.low <= sl : c.high >= sl;
          const hitTP = isLong ? c.high >= tp1 : c.low <= tp1;
          if (hitSL) { result = 'loss'; break; }
          if (hitTP) { result = 'win'; break; }
        }
        if (result) {
          events.push({ index: i, strategy: sig.strategy, direction: sig.direction, result });
          lastSignalIndexByStrategy[sig.strategy] = i;
        }
      }
    }
    return events;
  },

  aggregateCustomStats(events) {
    const stats = {};
    events.forEach(e => {
      if (!stats[e.strategy]) stats[e.strategy] = { wins: 0, losses: 0 };
      if (e.result === 'win') stats[e.strategy].wins++; else stats[e.strategy].losses++;
    });
    Object.keys(stats).forEach(key => {
      const s = stats[key];
      const total = s.wins + s.losses;
      s.sampleSize = total;
      s.winRate = total ? s.wins / total : 0;
    });
    return stats;
  },

  async runSymbol(symbol) {
    const asset = ASSETS[symbol];
    let allEvents = [];
    let allCustomEvents = [];
    let candlesAnalyzed = 0;
    for (const tf of CONFIG.BACKTEST.TIMEFRAMES) {
      try {
        const candles = await this.fetchCandles(symbol, tf);
        if (!candles || !candles.length) continue;
        candlesAnalyzed += candles.length;
        const events = await this.simulate(candles, asset.type);
        allEvents = allEvents.concat(events);
        const customEvents = await this.simulateCustom(candles, symbol, asset);
        allCustomEvents = allCustomEvents.concat(customEvents);
      } catch (e) {
        console.warn(`Backtest: no se pudo traer historial de ${symbol} en ${tf}:`, e.message);
      }
      // Espacio entre cada pedido de historial (símbolo x temporalidad) para no saturar
      // el límite de consultas por minuto de TwelveData/CryptoCompare en el plan gratuito.
      await sleep(6000);
    }
    if (!allEvents.length && !allCustomEvents.length) return null;
    const { threshold, stats } = this.calibrateThreshold(allEvents);
    const patternStats = this.aggregatePatternStats(allEvents);
    const customStats = this.aggregateCustomStats(allCustomEvents);
    const wins = allEvents.filter(e => e.result === 'win').length;
    const regimeCalibration = {};
    ['trending', 'ranging'].forEach(regime => {
      const regimeEvents = allEvents.filter(e => e.regime === regime);
      if (!regimeEvents.length) return;
      const r = this.calibrateThreshold(regimeEvents);
      if (r.stats) regimeCalibration[regime] = { threshold: r.threshold, sampleSize: regimeEvents.length, winRate: r.stats.winRate };
    });
    return {
      symbol, candlesAnalyzed,
      totalSignals: allEvents.length, winRate: allEvents.length ? wins / allEvents.length : 0,
      calibratedThreshold: threshold, calibratedStats: stats, regimeCalibration, patternStats,
      customStats
    };
  },

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
        await sleep(6000); // espacio entre activos, mismo motivo que arriba
      }
      if (Object.keys(results).length) {
        const combinedPatternStats = {};
        Object.values(results).forEach(r => {
          Object.entries(r.patternStats).forEach(([key, s]) => {
            if (!combinedPatternStats[key]) combinedPatternStats[key] = { wins: 0, losses: 0 };
            combinedPatternStats[key].wins += s.wins; combinedPatternStats[key].losses += s.losses;
          });
        });
        state.backtestPatternStats = combinedPatternStats;
        localStorage.setItem('pt_backtest_pattern_stats', JSON.stringify(combinedPatternStats));

        // Igual que arriba pero para las 5 estrategias independientes: se suman gana/pierde
        // de los 4 símbolos x 2 timeframes en una sola tabla por estrategia.
        const combinedCustomStats = {};
        Object.values(results).forEach(r => {
          Object.entries(r.customStats || {}).forEach(([key, s]) => {
            if (!combinedCustomStats[key]) combinedCustomStats[key] = { wins: 0, losses: 0 };
            combinedCustomStats[key].wins += s.wins; combinedCustomStats[key].losses += s.losses;
          });
        });
        Object.keys(combinedCustomStats).forEach(key => {
          const s = combinedCustomStats[key];
          const total = s.wins + s.losses;
          s.sampleSize = total;
          s.winRate = total ? s.wins / total : 0;
        });
        state.backtestCustomStats = combinedCustomStats;
        localStorage.setItem('pt_backtest_custom_stats', JSON.stringify(combinedCustomStats));

        const autoTune = {};
        Object.entries(results).forEach(([symbol, r]) => {
          autoTune[symbol] = { threshold: r.calibratedThreshold, sampleSize: r.totalSignals, winRate: r.winRate, candlesAnalyzed: r.candlesAnalyzed };
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

function renderBacktestStatus() {}

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

function checkSpreadAnomaly(symbol, quote) {
  if (!quote || quote.spread === null || quote.spread === undefined || quote.estimatedSpread) return { anomalous: false, ratio: null };
  const history = state.spreadHistory[symbol] || [];
  history.push(quote.spread);
  if (history.length > 20) history.shift();
  state.spreadHistory[symbol] = history;
  try { localStorage.setItem('pt_spread_history', JSON.stringify(state.spreadHistory)); } catch (e) {}
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
    name: asset.name, decimals: asset.decimals, last: quote.last, change: pctDiff(quote.last, quote.open),
    bid: quote.bid || null, ask: quote.ask || null, spread: quote.spread !== undefined ? quote.spread : null,
    estimatedSpread: !!quote.estimatedSpread, timestamp: quote.timestamp, source: quote.source
  };
}
function renderTradingHoursBar() {}
function assetFeedSkeleton() { return ''; }
function renderAssetsFeedSkeleton() {}
function renderAssetHoursPill() {}
function renderMarketBanner() {}
function renderApiError(symbol, message) { if (message) console.warn(`[${symbol}] ${message}`); }
function setLoading() {}
function renderSignal(symbol, signalDisplay) { state.lastDisplay = state.lastDisplay || {}; state.lastDisplay[symbol] = signalDisplay; }
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
    strategyKeys: signal.strategyKeys || [], rMultiple: null, regime: signal.regime || 'unknown',
    source: signal.source || 'smc'
  };
  state.signalHistory.unshift(entry);
  if (state.signalHistory.length > CONFIG.HISTORY_LIMIT) state.signalHistory.pop();
  localStorage.setItem('pt_v4_signals', JSON.stringify(state.signalHistory));
}

function checkHistoryOutcomes(symbol, currentPrice, candles) {
  let changed = false;
  const resolvedEntries = [];
  state.signalHistory.forEach(h => {
    if (h.symbol !== symbol || h.result !== 'pending') return;
    const isLong = h.type === 'long';
    const rWin = (h.tp1Pips && h.slPips) ? +(h.tp1Pips / h.slPips).toFixed(2) : 2;
    let outcome = null;
    const relevantCandles = (candles || []).filter(c => c.time >= h.timestamp);
    if (relevantCandles.length) {
      for (const c of relevantCandles) {
        const hitSL = isLong ? c.low <= h.sl : c.high >= h.sl;
        const hitTP = isLong ? c.high >= h.tp1 : c.low <= h.tp1;
        if (hitSL) { outcome = 'loss'; break; }
        if (hitTP) { outcome = 'win'; break; }
      }
    } else {
      if (isLong && currentPrice >= h.tp1) outcome = 'win';
      else if (isLong && currentPrice <= h.sl) outcome = 'loss';
      else if (!isLong && currentPrice <= h.tp1) outcome = 'win';
      else if (!isLong && currentPrice >= h.sl) outcome = 'loss';
    }
    if (outcome) {
      h.result = outcome; h.rMultiple = outcome === 'win' ? rWin : -1; changed = true; resolvedEntries.push(h);
    }
  });
  if (changed) {
    localStorage.setItem('pt_v4_signals', JSON.stringify(state.signalHistory));
    resolvedEntries.forEach(updatePatternStats);
    runAutoTune(symbol);
  }
}

function updatePatternStats(entry) {
  if (!entry.strategyKeys || !entry.strategyKeys.length) return;
  entry.strategyKeys.forEach(key => {
    if (!state.patternStats[key]) state.patternStats[key] = { wins: 0, losses: 0 };
    if (entry.result === 'win') state.patternStats[key].wins++;
    else if (entry.result === 'loss') state.patternStats[key].losses++;
  });
  localStorage.setItem('pt_pattern_stats', JSON.stringify(state.patternStats));
}

function runAutoTuneForKey(key, closedEntries) {
  const cfg = CONFIG.AUTO_TUNE;
  if (!state.autoTuneStats[key]) state.autoTuneStats[key] = { sampleSize: 0, lastWinRate: null, lastExpectancy: null };
  const stats = state.autoTuneStats[key];
  stats.sampleSize = closedEntries.length;
  if (closedEntries.length < cfg.minSampleSize) return;
  const recent = closedEntries.slice(0, cfg.windowSize);
  const wins = recent.filter(h => h.result === 'win').length;
  const winRate = wins / recent.length;
  const rawExpectancy = recent.reduce((sum, h) => sum + (h.rMultiple != null ? h.rMultiple : (h.result === 'win' ? 2 : -1)), 0) / recent.length;
  const shrinkageK = 15;
  const confidenceWeight = recent.length / (recent.length + shrinkageK);
  const expectancy = confidenceWeight * rawExpectancy;
  stats.lastWinRate = winRate; stats.lastExpectancy = expectancy; stats.rawExpectancy = +rawExpectancy.toFixed(2); stats.confidenceWeight = +confidenceWeight.toFixed(2);
  const currentThreshold = state.autoConfidenceThreshold[key] || CONFIG.CONFIDENCE_THRESHOLD;
  let newThreshold = currentThreshold;
  if (expectancy < cfg.targetExpectancyLow) newThreshold = Math.min(cfg.maxThreshold, currentThreshold + cfg.step);
  else if (expectancy > cfg.targetExpectancyHigh) newThreshold = Math.max(cfg.minThreshold, currentThreshold - cfg.step);
  if (newThreshold !== currentThreshold) state.autoConfidenceThreshold[key] = newThreshold;
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

function renderAutoTuneStatus() {}
function localDayKey(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

function notifyNewSignal(signal) {
  const asset = ASSETS[signal.symbol];
  const title = `${signal.type === 'long' ? '🟢 LONG' : '🔴 SHORT'} ${asset ? asset.name : signal.symbol}${signal.source && signal.source !== 'smc' ? ' · ' + signal.strategyLabels[0] : ''}`;
  const body = `Entrada ${fmt(signal.entry, signal.decimals)} · SL ${fmt(signal.sl, signal.decimals)} · TP1 ${fmt(signal.tp1, signal.decimals)} · Confianza ${signal.confidence}%`;
  sendPushToAll({ title, body, symbol: signal.symbol, signal }).catch(err => console.error('Error enviando push:', err.message));
}

function toggleSound() {}
function toggleStrictMode() { state.strictMode = !state.strictMode; }

function resolveActiveSignal(symbol, quote, analysis) {
  if (!analysis.valid) { delete state.activeSignals[symbol]; return { type: 'no-data', reason: analysis.reason }; }
  if (!analysis.direction) { delete state.activeSignals[symbol]; return { type: 'no-signal', analysis }; }
  const existing = state.activeSignals[symbol];
  const isNewDirection = !existing || existing.type !== analysis.direction;
  const lastAt = state.lastSignalAt[symbol] || 0;
  const cooldownRemainingMs = CONFIG.SIGNAL_COOLDOWN_MS - (Date.now() - lastAt);
  const inCooldown = isNewDirection && cooldownRemainingMs > 0;
  if (isNewDirection && !inCooldown) {
    const frozen = SignalEngine.build(symbol, quote, analysis);
    frozen.source = 'smc';
    frozen.detectedAt = Date.now();
    state.activeSignals[symbol] = frozen;
    state.lastSignalAt[symbol] = frozen.detectedAt;
    pushSignalHistory(frozen);
    notifyNewSignal(frozen);
  }
  if (!state.activeSignals[symbol]) return { type: 'no-signal', analysis, cooldownMinutesLeft: inCooldown ? Math.ceil(cooldownRemainingMs / 60000) : null };
  const frozen = state.activeSignals[symbol];
  const isLong = frozen.type === 'long';
  const hitTP = isLong ? quote.last >= frozen.tp1 : quote.last <= frozen.tp1;
  const hitSL = isLong ? quote.last <= frozen.sl : quote.last >= frozen.sl;
  const result = { type: frozen.type, frozen, currentPrice: quote.last, hitTP, hitSL, isNewDirection: isNewDirection && !inCooldown };
  if (hitTP || hitSL) delete state.activeSignals[symbol];
  return result;
}

// ---------------------------------------------------------
// Resolución de señales de las 3 estrategias independientes
// (Kill Zone NY, Pivots Breakout & Reversal, Price Action+RSI+EMA)
// Cada una tiene su propio cooldown por símbolo+estrategia, y NO
// pisa ni se mezcla con las señales SMC de resolveActiveSignal().
// ---------------------------------------------------------
function resolveCustomSignal(symbol, quote, customSig, asset) {
  const key = `${symbol}_${customSig.strategy}`;
  const existing = state.activeCustomSignals[key];
  const isNewDirection = !existing || existing.type !== customSig.direction;
  const lastAt = state.lastCustomSignalAt[key] || 0;
  const cooldownRemainingMs = CONFIG.SIGNAL_COOLDOWN_MS - (Date.now() - lastAt);
  const inCooldown = isNewDirection && cooldownRemainingMs > 0;

  if (isNewDirection && !inCooldown) {
    const entry = customSig.entry || quote.last;
    const sl = customSig.sl;
    const tp1 = customSig.tp1;
    const tp2 = customSig.tp2 || customSig.tp1;
    const slPips = toPips(sl, entry, asset);
    const tp1Pips = toPips(tp1, entry, asset);
    const tp2Pips = toPips(tp2, entry, asset);
    const frozen = {
      type: customSig.direction, symbol, asset, entry, sl, tp1, tp2, slPips, tp1Pips, tp2Pips,
      rr1: '1:2', rr2: tp2 !== tp1 ? '1:3' : '1:2', confidence: 100,
      strategyLabels: [customSig.label], strategyKeys: [customSig.strategy],
      details: customSig.details, source: customSig.strategy, regime: 'n/a',
      timestamp: Date.now(), decimals: asset.decimals, detectedAt: Date.now()
    };
    state.activeCustomSignals[key] = frozen;
    state.lastCustomSignalAt[key] = frozen.detectedAt;
    pushSignalHistory(frozen);
    notifyNewSignal(frozen);
  }

  const frozen = state.activeCustomSignals[key];
  if (!frozen) return null;
  const isLong = frozen.type === 'long';
  const hitTP = isLong ? quote.last >= frozen.tp1 : quote.last <= frozen.tp1;
  const hitSL = isLong ? quote.last <= frozen.sl : quote.last >= frozen.sl;
  if (hitTP || hitSL) delete state.activeCustomSignals[key];
  return { type: frozen.type, frozen, currentPrice: quote.last, hitTP, hitSL };
}

async function refreshAsset(symbol, forceRefresh = false) {
  const asset = ASSETS[symbol];
  renderMarketBanner(symbol); renderAssetHoursPill(symbol); renderApiError(symbol, null);
  if (!isMarketOpenForAsset(symbol)) { renderSignal(symbol, { type: 'market-closed' }); return; }
  try {
    const [quote, ohlcv] = await Promise.all([
      MarketDataProvider.getQuote(symbol, forceRefresh),
      MarketDataProvider.getOHLCV(symbol, state.currentTF, 100, forceRefresh).catch(() => state.klineHistory[symbol] || new OHLCVData([]))
    ]);
    updatePriceUI(symbol, quote, asset);
    const htfTF = CONFIG.HTF_MAP[state.currentTF] || null;
    let htfCandles = null;
    if (htfTF) {
      try { const htfOhlcv = await MarketDataProvider.getOHLCV(symbol, htfTF, 60, forceRefresh); htfCandles = htfOhlcv.candles; }
      catch (e) { htfCandles = null; }
    }
    const regimeForThreshold = detectMarketRegime(ohlcv.candles);
    const analysis = SMCEngine.analyze(ohlcv.candles, state.strictMode, asset.type, htfCandles, getThresholdForSymbol(symbol, regimeForThreshold), getEffectivePatternStats());

    if (analysis.filteredByConfidence) addLog(quote.source, `Señal bloqueada: confianza insuficiente (umbral ${analysis.confidenceThreshold})`, symbol);
    if (analysis.filteredByVolume) addLog(quote.source, `Señal bloqueada: volumen no confirma (ratio ${analysis.volumeRatio ? analysis.volumeRatio.toFixed(2) : 'n/d'}x, se requiere 1.2x)`, symbol);
    if (analysis.filteredByCandle) addLog(quote.source, 'Señal bloqueada: vela de confirmación no cumplida', symbol);
    if (analysis.filteredByMitigation) addLog(quote.source, 'Señal bloqueada: mitigación de OB/FVG no confirmada (Modo Estricto)', symbol);
    if (analysis.filteredByPremiumDiscount) addLog(quote.source, `Señal bloqueada: filtro Premium/Discount (zona: ${analysis.premiumDiscountZone})`, symbol);
    if (analysis.filteredByHTF) addLog(quote.source, `Señal bloqueada: tendencia HTF contraria (${analysis.htfTrendDirection})`, symbol);

    const spreadCheck = checkSpreadAnomaly(symbol, quote);
    if (spreadCheck.anomalous && analysis.direction) {
      addLog(quote.source, `Señal bloqueada por spread anómalo (${spreadCheck.ratio.toFixed(1)}x el promedio)`, symbol);
      analysis.direction = null; analysis.filteredBySpread = true; analysis.spreadRatio = spreadCheck.ratio;
    }

    const display = resolveActiveSignal(symbol, quote, analysis);
    if (display.cooldownMinutesLeft) addLog(quote.source, `Cambio de dirección bloqueado por cooldown (${display.cooldownMinutesLeft} min restantes)`, symbol);
    renderSignal(symbol, display);
    checkHistoryOutcomes(symbol, quote.last, ohlcv.candles);

    // --- Estrategias independientes (Kill Zone NY, Pivots B&R, Price Action+RSI+EMA) ---
    // Corren en paralelo, no pasan por evalSide() ni por los filtros SMC de arriba.
    try {
      const customSignals = CustomStrategies.evaluateAll(ohlcv.candles, symbol, asset, htfCandles);
      customSignals.forEach(sig => {
        const customDisplay = resolveCustomSignal(symbol, quote, sig, asset);
        if (customDisplay) {
          addLog(quote.source, `[${sig.label}] señal ${sig.direction === 'long' ? 'LONG' : 'SHORT'} independiente`, symbol);
        }
      });
    } catch (e) {
      console.warn(`Estrategias independientes fallaron para ${symbol}:`, e.message);
    }
  } catch (error) {
    if (error.message === 'MERCADO_CERRADO') renderSignal(symbol, { type: 'market-closed' });
    else {
      renderApiError(symbol, error.message || 'No se pudo obtener información de ningún proveedor. Revisa tu conexión o las claves de API en Ajustes.');
      renderSignal(symbol, { type: 'no-data', reason: 'Todos los proveedores de datos fallaron para este activo.' });
    }
  }
}

async function refreshAllData(forceRefresh = false) {
  renderTradingHoursBar();
  if (forceRefresh) setLoading(true, 'Consultando proveedores de datos...');
  try {
    for (const symbol of Object.keys(ASSETS)) {
      await refreshAsset(symbol, forceRefresh);
      await sleep(8000); // ↑ delay entre activos aumentado a 8s (antes 4s)
    }
  } finally {
    if (forceRefresh) setLoading(false);
  }
}

async function requestWakeLock() {}

// ---------------------------------------------------------
// Scheduler autoajustable: reemplaza al setInterval fijo de server.js.
// Corre refreshAllData() y programa la siguiente pasada según la hora:
// cada 15 min normalmente, cada 1 min dentro de la ventana Kill Zone NY.
// Llamar UNA sola vez desde server.js con: engine.startAutoRefreshLoop();
// (y sacar de ahí cualquier setInterval(refreshAllData, ...) que hubiera).
// ---------------------------------------------------------
let autoRefreshTimer = null;

async function autoRefreshTick() {
  try {
    await refreshAllData(false);
  } catch (e) {
    console.warn('autoRefreshTick: error en refreshAllData', e.message);
  } finally {
    const delay = getDynamicRefreshIntervalMs();
    addLog('scheduler', `Próximo refresco en ${Math.round(delay / 1000)}s (${isArgKillZoneWindow() ? 'Kill Zone NY activa' : 'horario normal'})`, 'ALL');
    autoRefreshTimer = setTimeout(autoRefreshTick, delay);
  }
}

function startAutoRefreshLoop() {
  if (autoRefreshTimer) return; // ya está corriendo, no duplicar
  autoRefreshTick();
}

function stopAutoRefreshLoop() {
  if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; }
}

module.exports = {
  state, CONFIG, ASSETS, refreshAllData, refreshAsset, BacktestEngine,
  startAutoRefreshLoop, stopAutoRefreshLoop, getDynamicRefreshIntervalMs, isArgKillZoneWindow
};
