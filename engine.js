// ============================================================
// PULSE TRADE v4.7.4 - MOTOR DE SEÑALES PROFESIONAL
// ============================================================
// Cambios v4.7.4 (25/8, Etapa 3 — cierre del hallazgo 5/7.3):
// - Causa raíz confirmada con los datos reales de CONFIG (no con más logs): a 1min
//   de intervalo, Kill Zone NY (180min) por sí sola necesitaba hasta 1080 llamadas
//   de twelveData solo entre EURUSD y XAUUSD (3 llamadas/ciclo -quote+OHLCV TF+OHLCV
//   HTF- x 2 símbolos x 180 ciclos), sumado a ~504/día del resto de la jornada a
//   15min — superaba el cupo de 800/día dentro de la propia ventana de Kill Zone,
//   sin llegar a la tarde. killZoneIntervalMs pasó de 60s a 4min (45 ciclos en la
//   ventana, ~774 llamadas/día totales, con margen). alphaVantage (25/día) sigue
//   siendo un punto débil aparte: cualquier fallo puntual de twelveData lo agota
//   casi de inmediato como fallback — no resuelto por este cambio, queda para otra
//   etapa si se repite.
// Cambios v4.7.3 (25/8, Etapa 3 — scoring contextual):
// - refreshAsset() ahora pasa state.strategyStatsBySymbol[symbol] como symbolStats
//   (5º parámetro nuevo) a CustomStrategies.evaluateAll(), para que el score
//   contextual de cada señal pueda considerar el historial reciente real.
// - resolveCustomSignal(): confidence ya no se hardcodea en null — usa el score
//   que ahora calcula computeContextualScore() en custom-strategies.js.
//   Informativo por decisión explícita del usuario, no filtra ninguna señal.
// Cambios v4.7.2 (25/8, Etapa 3 — hallazgo de logs de producción):
// - Visibilidad de exclusión por cupo diario (7.3): cuando un proveedor queda
//   afuera de eligible en getQuote/getOHLCV por agotar su cupo (PROVIDER_DAILY_LIMITS),
//   ahora se loguea explícitamente (logQuotaExcluded) y queda en
//   state.providerQuotaExclusions, expuesto por /api/state. Antes desaparecía en
//   silencio de la lista — se detectó así el caso de EURUSD atrapado 2+ horas con
//   solo exchangerate (congelado) disponible, sin poder confirmar si twelveData
//   y/o alphaVantage estaban excluidos por cupo o por otra causa.
// Cambios v4.7.1 (25/8, auditoría Etapa 3):
// - CONFIG.PROVIDER_PRIORITY (fallback global): orden corregido, exchangerate al
//   final. Código muerto en la práctica (los 4 activos actuales definen su propio
//   providerPriority), corregido para no heredar un orden malo si se agrega un
//   5º activo sin especificarlo.
// - Cabecera de versión actualizada: no reflejaba el fix ATR v4.7 ni los fixes del
//   25/8 (quickPriceCheck, visibilidad H1) que ya estaban en el código.
// Cambios v4.7 (Etapa 3, auditoría de cierre de operaciones):
// - checkHistoryOutcomes y evaluateCustomSignalOutcome: para estrategias con TP2 real
//   (ny_open_kill_zone, bollinger_squeeze), ya no cierran la señal en 'win' apenas toca
//   TP1 — siguen hasta TP2 o SL. TP1 queda solo como marca informativa (tp1HitAt).
// - SL adaptado a volatilidad con ATR14 en pivots_breakout_reversal y ema_cross_scalping
//   (antes % fijo del precio), con fallback automático al % fijo si faltan velas.
// - Circuit Breaker: auto-desactiva una estrategia en un activo tras 5 pérdidas
//   consecutivas (CONFIG.CIRCUIT_BREAKER), complementa a DISABLED_STRATEGIES_BY_SYMBOL.
// Cambios v4.6.4:
// - fmp: detección de congelamiento (mismo patrón que exchangerate v4.6.3), por
//   símbolo, ante el freeze de ~30min visto en XAUUSD cuando fmp era el proveedor activo.
// - CoinGecko OHLCV: reemplazado /coins/{id}/ohlc (granularidad fija de CoinGecko,
//   topeaba en 48 velas/día sin importar qué se pidiera) por /market_chart, agregado
//   en velas de 15m/1h genuinas por bucket de tiempo — mismo timeframe que ya
//   esperaban las estrategias, sin alterar sus condiciones de entrada.
// Cambios v4.6.3:
// - EURUSD: exchangerate (open.er-api.com) pasado de proveedor primario a último
//   recurso — su tasa se actualiza 1x/día y quedaba "congelada" horas seguidas,
//   bloqueando el cierre por SL/TP de señales activas en EURUSD.
// - Adapter exchangerate: detección de congelamiento (mismo valor >15min) que
//   rechaza la data en vez de darla por buena, incluso como último recurso.
// Cambios v4.6.2:
// - Ajuste de holgura dinámica para XAUUSD: amplía el SL un 50% y recalcula 
//   los TPs para mantener el mismo ratio Riesgo:Beneficio (RR), evitando 
//   que las mechas del oro barren stops fijos.
// - Filtro de estrategias por rendimiento real (ENABLED_STRATEGIES / DISABLED_STRATEGIES_BY_SYMBOL).
// - Desactivadas: rsi_divergence, price_action_rsi_ema, ema_cross_scalping (solo en ETHUSD), smc.
// - Agregada métrica avgR (R-multiple promedio) a estadísticas en vivo y backtest.
// - Limpieza total y definitiva de errores de sintaxis/espacios rotos.
// ============================================================
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
  SIGNAL_EXPIRATION_MS: 72 * 60 * 60 * 1000,
  SIGNAL_EXPIRATION_MS_BY_STRATEGY: {
    ema_cross_scalping: 4 * 60 * 60 * 1000,
    ny_open_kill_zone: 4 * 60 * 60 * 1000
  },
  // FIX (7.3, sesión 25/8, cierre): killZoneIntervalMs pasó de 60s a 4min. Con datos
  // reales de CONFIG (cupo twelveData 800/día, 3 llamadas por ciclo por símbolo
  // -quote+OHLCV TF+OHLCV HTF-, EURUSD y XAUUSD con twelveData como proveedor #1):
  // fuera de Kill Zone ya se gastan ~504 llamadas/día (84 ciclos x 3 x 2 símbolos).
  // A 1min, Kill Zone (180min) sumaba 1080 llamadas más -> agotaba el cupo dentro
  // de la propia ventana, sin llegar a la tarde (caso real EURUSD 25/8). A 4min,
  // Kill Zone suma 270 llamadas (45 ciclos x 6) -> total ~774/día, con margen.
  DYNAMIC_REFRESH: {
    normalIntervalMs: 15 * 60 * 1000,
    killZoneIntervalMs: 4 * 60 * 1000
  },
  // FIX (7.1, sesión 25/8, "medida intermedia" — integrar MetaApi.cloud queda en pausa):
  // se detectó un caso donde Exness cerró una operación por SL mientras PulseTrade
  // seguía la señal como activa, con el ciclo normal de 15min entre chequeos. No es un
  // proveedor de precio nuevo (eso sigue en pausa), es acortar la ventana de detección
  // de SL/TP para BTC/ETH específicamente: son los dos activos 24/7 sin ventana de
  // mercado cerrado, y los de mayor volatilidad intrabar de los 4. Corre por separado
  // del ciclo principal (que sigue generando señales nuevas cada 15min/1min): solo pide
  // el precio actual (1 llamada liviana a getQuote, no OHLCV/HTF completo) y revisa
  // checkHistoryOutcomes contra ese precio — no genera señales nuevas, solo achica la
  // demora en detectar que una señal ya tocó SL o TP.
  CRYPTO_QUICK_CHECK_INTERVAL_MS: 5 * 60 * 1000,
  // NUEVO (Etapa 3 real — auditoría de filtros de señal, Punto 6): antes ningún costo
  // de spread se restaba de los resultados. checkHistoryOutcomes calculaba rMultiple
  // "en limpio" (solo distancia de precio a SL/TP1/TP2), así que los winrates y R
  // acumulados en las stats (patternStats, strategyStatsBySymbol, autoTune) venían
  // mejor de lo que serían operando de verdad, sin descontar lo que cobra el bróker
  // en cada entrada/salida. Estos valores son ESTIMADOS (spread típico retail por
  // activo, en las mismas unidades "pips" que ya usa toPips()/h.slPips) — ajustalos
  // con el spread real que veas en tu cuenta de Exness si difiere. El costo se
  // descuenta UNA vez por operación cerrada (se asume que se paga en la entrada,
  // no se duplica en la salida).
  ESTIMATED_SPREAD_PIPS_BY_SYMBOL: {
    BTCUSD: 20,   // pipSize 1 -> ~$20 de spread típico
    ETHUSD: 1.5,  // pipSize 1 -> ~$1.5
    EURUSD: 1.5,  // pipSize 0.0001 -> ~1.5 pips
    XAUUSD: 3.5   // pipSize 0.1 -> ~0.35 en precio
  },
  HTF_MAP: { '5m': '1h', '15m': '1h' },
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
    RETRY_INTERVAL_MS: 60 * 60 * 1000,
    SEED_CAP: 40,
    YIELD_EVERY: 40
  },
  // Fallback usado solo si un activo no define su propio providerPriority (hoy los
  // 4 activos actuales sí lo definen, así que este array no se usa en la práctica).
  // Orden corregido el 25/8 (mismo criterio que EURUSD desde v4.6.3): exchangerate
  // (open.er-api.com) al final por actualizar su tasa 1x/día, no como primario.
  PROVIDER_PRIORITY: ['twelveData', 'alphaVantage', 'exchangerate'],
  ENDPOINTS: {
    BINANCE_SPOT: 'https://api.binance.com/api/v3',
    BINANCE_FUTURES: 'https://fapi.binance.com/fapi/v1',
    COINGECKO: 'https://api.coingecko.com/api/v3',
    EXCHANGERATE: 'https://open.er-api.com/v6/latest',
    TWELVEDATA: 'https://api.twelvedata.com',
    FINNHUB: 'https://finnhub.io/api/v1',
    ALPHAVANTAGE: 'https://www.alphavantage.co/query',
    FMP: 'https://financialmodelingprep.com/stable'
  },
  // v4.6: LISTA BLANCA - Solo estas estrategias están permitidas para operar
  ENABLED_STRATEGIES: [
    'ny_open_kill_zone',
    'pivots_breakout_reversal',
    'bollinger_squeeze',
    'supply_demand',
    'ema_cross_scalping'
  ],
  // v4.6: LISTA NEGRA POR ACTIVO - Desactiva estrategias específicas que fallan en un activo
  // v4.7: CIRCUIT BREAKER - auto-desactiva una estrategia en un activo tras N pérdidas
  // consecutivas, sin esperar a que Soy sume tablas de WhatsApp a mano. Se guarda en
  // Supabase (state.consecutiveLosses) para sobrevivir reinicios, igual que
  // activeCustomSignals. No reemplaza DISABLED_STRATEGIES_BY_SYMBOL (que sigue siendo
  // la lista manual "para siempre"), la complementa con desactivaciones automáticas
  // temporales que Soy revisa y decide si mantener.
  CIRCUIT_BREAKER: {
    enabled: true,
    consecutiveLossThreshold: 5,
    // v4.9 (sección 14, 27/8): umbral del breaker agregado por estrategia (suma los 4
    // símbolos) — 8, el doble del umbral por símbolo. Ver razonamiento completo junto a
    // checkCircuitBreakerAggregate().
    consecutiveLossThresholdAggregate: 8
  },
  // v4.9 (sección 13, 27/8): piso mínimo de computeContextualScore() para que una señal
  // se muestre — decidido por el usuario en 55%, no propuesto por el motor. Antes el
  // score era puramente informativo (se mostraba pero no filtraba nada). Se pasa como
  // 7º parámetro a CustomStrategies.evaluateAll(); ese mismo valor se usa como default
  // interno si algún día se llama sin pasarlo.
  MIN_CONFIDENCE_SCORE: 55,
  DISABLED_STRATEGIES_BY_SYMBOL: {
    ETHUSD: ['ema_cross_scalping', 'smc'],
    // ema_cross_scalping: 25% winrate (4 op, 1G/3P) del 12/8 al 23/8. Desactivada.
    BTCUSD: ['smc', 'ema_cross_scalping'],
    // bollinger_squeeze: 33.3% winrate (12 op, 4G/8P) del 12/8 al 23/8. Desactivada.
    XAUUSD: ['smc', 'bollinger_squeeze'],
    EURUSD: ['smc']
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
    symbols: { twelveData: 'BTC/USD', finnhub: 'BINANCE:BTCUSDT', alphaVantage: 'BTC', fmp: 'BTCUSD', binance: 'BTCUSDT', coingecko: 'bitcoin' },
    decimals: 2, pipSize: 1, is24h: true, timezone: 'UTC',
    openHour: 0, closeHour: 24, openDays: [0,1,2,3,4,5,6],
    providerPriority: ['coingecko', 'twelveData', 'alphaVantage']
  },
  ETHUSD: {
    name: 'ETH/USD', market: 'crypto', type: 'crypto',
    symbols: { twelveData: 'ETH/USD', finnhub: 'BINANCE:ETHUSDT', alphaVantage: 'ETH', fmp: 'ETHUSD', binance: 'ETHUSDT', coingecko: 'ethereum' },
    decimals: 2, pipSize: 1, is24h: true, timezone: 'UTC',
    openHour: 0, closeHour: 24, openDays: [0,1,2,3,4,5,6],
    providerPriority: ['coingecko', 'twelveData', 'alphaVantage']
  },
  EURUSD: {
    name: 'EUR/USD', market: 'forex', type: 'forex',
    symbols: { twelveData: 'EUR/USD', finnhub: 'OANDA:EUR_USD', alphaVantage: 'EURUSD', fmp: 'EURUSD', exchangerate: 'EUR' },
    decimals: 5, pipSize: 0.0001, is24h: false, timezone: 'UTC',
    // v4.6.3: exchangerate (open.er-api.com) pasado a último recurso — su tasa se
    // actualiza 1x/día, no sirve como fuente primaria para seguimiento de SL/TP en vivo.
    // Ver detección de congelamiento en ProviderAdapters.exchangerate.fetchQuote.
    providerPriority: ['twelveData', 'alphaVantage', 'exchangerate']
  },
  XAUUSD: {
    name: 'XAU/USD (Oro)', market: 'forex', type: 'commodity',
    symbols: { twelveData: 'XAU/USD', finnhub: 'OANDA:XAU_USD', alphaVantage: 'XAU', fmp: 'GCUSD' },
    decimals: 2, pipSize: 0.1, is24h: false, timezone: 'UTC',
    providerPriority: ['twelveData', 'fmp', 'alphaVantage']
  }
};

let state = {
  currentTF: '15m',
  lastPrice: null, prevPrice: null, klineHistory: {},
  signalHistory: (() => { try { return JSON.parse(localStorage.getItem('pt_v4_signals') || '[]'); } catch (e) { return []; } })(),
  providers: {}, providerStats: {}, currentProvider: null, autoRefresh: null,
  lastFetchTime: null, currentData: null, logs: [],
  activeCustomSignals: (() => { try { return JSON.parse(localStorage.getItem('pt_active_custom_signals') || '{}'); } catch (e) { return {}; } })(),
  lastCustomSignalAt: (() => { try { return JSON.parse(localStorage.getItem('pt_last_custom_signal_at') || '{}'); } catch (e) { return {}; } })(),
  autoConfidenceThreshold: (() => {
    try { const v2 = JSON.parse(localStorage.getItem('pt_auto_threshold_v2') || 'null'); if (v2 && typeof v2 === 'object') return v2; } catch (e) {}
    const legacy = parseFloat(localStorage.getItem('pt_auto_threshold'));
    const seed = !isNaN(legacy) ? legacy : CONFIG.CONFIDENCE_THRESHOLD;
    const obj = {}; Object.keys(ASSETS).forEach(sym => { obj[sym] = seed; }); return obj;
  })(),
  autoTuneStats: (() => { try { return JSON.parse(localStorage.getItem('pt_auto_stats_v2') || '{}'); } catch (e) { return {}; } })(),
  patternStats: (() => { try { return JSON.parse(localStorage.getItem('pt_pattern_stats') || '{}'); } catch (e) { return {}; } })(),
  strategyStatsBySymbol: (() => { try { return JSON.parse(localStorage.getItem('pt_strategy_stats_by_symbol') || '{}'); } catch (e) { return {}; } })(),
  // v4.7: contador de pérdidas consecutivas por "SYMBOL_strategyKey" (se resetea a 0 en cada
  // ganada) y lista de combinaciones que el circuit breaker apagó solo. Separado a propósito
  // de DISABLED_STRATEGIES_BY_SYMBOL (que es la lista manual fija en CONFIG) para no pisar
  // decisiones tomadas a mano por Soy ni perder el motivo de cada apagado automático.
  consecutiveLosses: (() => { try { return JSON.parse(localStorage.getItem('pt_consecutive_losses') || '{}'); } catch (e) { return {}; } })(),
  autoDisabledStrategies: (() => { try { return JSON.parse(localStorage.getItem('pt_auto_disabled_strategies') || '{}'); } catch (e) { return {}; } })(),
  // v4.9 (sección 14, 27/8): circuit breaker agregado por estrategia sola (suma los 4
  // símbolos). El breaker original (arriba) es por combinación símbolo+estrategia — una
  // racha mala repartida entre BTC/ETH/EUR/XAU nunca concentra 5 seguidas en ninguna
  // combinación individual y por eso nunca se disparó en la racha del 24-26/8 (confirmado
  // con datos reales de /api/state: máximo visto fue 4, ninguna combinación llegó a 5,
  // pese a que ny_open_kill_zone sumaba 7 pérdidas repartidas entre los 4 activos). Esta
  // capa cubre ese caso: cuenta pérdidas seguidas de una estrategia sin importar el
  // símbolo, resetea con cualquier ganada de esa estrategia en cualquier símbolo.
  consecutiveLossesAggregate: (() => { try { return JSON.parse(localStorage.getItem('pt_consecutive_losses_aggregate') || '{}'); } catch (e) { return {}; } })(),
  autoDisabledStrategiesAggregate: (() => { try { return JSON.parse(localStorage.getItem('pt_auto_disabled_strategies_aggregate') || '{}'); } catch (e) { return {}; } })(),
  backtestCustomStats: (() => { try { return JSON.parse(localStorage.getItem('pt_backtest_custom_stats') || '{}'); } catch (e) { return {}; } })(),
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
  refreshPaused: false, wakeLock: null
};

// FIX (Etapa 3, sesión 25/8): antes, cuando el Circuit Breaker apagaba una combinación
// symbol+strategy por pérdidas consecutivas, la agregaba solo en memoria a
// CONFIG.DISABLED_STRATEGIES_BY_SYMBOL (que es lo que realmente filtra qué señales se
// generan en refreshAsset) y guardaba el registro en state.autoDisabledStrategies (esto
// sí persistido en Supabase, a propósito, para no mezclarlo con las desactivaciones
// manuales). El problema: CONFIG es un objeto en memoria que se resetea a sus valores
// fijos en cada arranque del proceso, así que en cada redeploy (Render manda SIGTERM y
// levanta un proceso nuevo) la desactivación automática se "olvidaba" y la estrategia
// volvía a generar señales en ese activo, aunque state.autoDisabledStrategies siguiera
// recordando (y el panel siguiera mostrando) que había sido auto-apagada. Ahora, apenas
// arranca el proceso, se vuelve a aplicar sobre CONFIG.DISABLED_STRATEGIES_BY_SYMBOL
// cada combinación que sigue registrada en autoDisabledStrategies, sin tocar ni duplicar
// las entradas manuales que ya estuvieran ahí.
(() => {
  Object.values(state.autoDisabledStrategies || {}).forEach(({ symbol, key }) => {
    if (!symbol || !key) return;
    if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol]) CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol] = [];
    if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].includes(key)) {
      CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].push(key);
    }
  });
})();

function getNow() { return new Date(); }

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

// FIX (7.3, sesión 25/8): antes, cuando un proveedor quedaba afuera de `eligible`
// en getQuote/getOHLCV por haber agotado su cupo diario (PROVIDER_DAILY_LIMITS),
// simplemente desaparecía de la lista sin dejar rastro — la única pista indirecta
// era que el mensaje final de error mencionara solo a los proveedores restantes
// (ver caso EURUSD/exchangerate en logs del 25/8, sin ninguna mención de
// twelveData/alphaVantage). Misma clase de falla silenciosa que el filtro H1 (7.2).
// Ahora se deja un log explícito y se guarda en state.providerQuotaExclusions,
// expuesto por /api/state, para poder confirmar con certeza qué proveedor se agotó
// y a qué hora, sin tener que inferirlo.
function logQuotaExcluded(providerName, symbol, usage) {
  console.warn(`[cupo] ${providerName} excluido para ${symbol}: cupo diario agotado (${usage.used}/${usage.limit})`);
  addLog(providerName, `CUPO AGOTADO (${usage.used}/${usage.limit})`, symbol);
  state.providerQuotaExclusions = state.providerQuotaExclusions || {};
  state.providerQuotaExclusions[providerName] = { used: usage.used, limit: usage.limit, lastSymbol: symbol, at: Date.now() };
}

function getProviderCooldownMs(errorMessage) {
  const msg = (errorMessage || '').toLowerCase();
  if (msg.includes('premium endpoint') || msg.includes('premium plan') || msg.includes('unlock all premium')) {
    return 24 * 60 * 60 * 1000;
  }
  if (msg.includes('requests per day') || msg.includes('per day') || msg.includes('daily rate limit')) {
    return 12 * 60 * 60 * 1000;
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('spreading out') || msg.includes('too many requests')) {
    return 10 * 60 * 1000;
  }
  if (msg.includes('401')) return 24 * 60 * 60 * 1000;
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

// v4.8: NewsCalendar — insumo interno para computeContextualScore() (custom-strategies.js).
// A pedido explícito de Soy: la noticia NO se muestra en la UI ni en la señal como campo
// nuevo, solo ajusta el score contextual que ya existe (mismo mecanismo que el historial
// reciente de la estrategia). Fuente: feed público de ForexFactory, sin cuenta ni API key
// (se descartó Finnhub — /calendar/economic confirmado fuera del tier gratis, ver
// respaldo de sesión). Cache propio de 30min (no el CACHE_TTL de 30s de ResponseCache,
// que es para cotizaciones — un calendario semanal no cambia de un ciclo al siguiente).
const NewsCalendar = {
  FEED_URL: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  CACHE_MS: 30 * 60 * 1000,
  // FIX (27/8): backoff tras fallo. Antes, un 429 no actualizaba _cacheAt, así que
  // el próximo ciclo (y el siguiente símbolo del MISMO ciclo, ver getNearbyHighImpact
  // llamado 1x por símbolo) volvía a intentar el fetch de inmediato — eso generaba
  // ráfagas de 4 fetches en segundos contra el feed público, perpetuando el 429.
  // Confirmado en logs de producción del 27/8 (ráfagas de 4 fallos en <30s por ciclo).
  BACKOFF_MS: 10 * 60 * 1000,
  _cache: null,
  _cacheAt: 0,

  async getEvents() {
    if (this._cache && (Date.now() - this._cacheAt) < this.CACHE_MS) return this._cache;
    try {
      const res = await fetchWithTimeout(this.FEED_URL, CONFIG.REQUEST_TIMEOUT, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulseTradePRO/1.0; +https://pulsetrade-analisis.onrender.com)' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Respuesta inesperada del calendario económico');
      this._cache = data;
      this._cacheAt = Date.now();
      return data;
    } catch (error) {
      console.warn('[NewsCalendar] fallo al traer calendario económico:', error.message);
      // Si falla, se sigue usando el cache viejo si existe (mejor un calendario un poco
      // desactualizado que dejar de scorear por completo), o array vacío si nunca hubo éxito.
      // FIX: se marca _cacheAt igual en el fallo, con un backoff corto (10min) en vez de
      // dejarlo "vencido" — esto corta el bucle de reintentos inmediatos que generaba el 429.
      this._cacheAt = Date.now() - this.CACHE_MS + this.BACKOFF_MS;
      return this._cache || [];
    }
  },

  // Devuelve el evento de mayor impacto dentro de ±windowMinutes del momento actual,
  // filtrado por moneda (USD afecta a los 4 activos de esta app). null si no hay ninguno.
  async getNearbyHighImpact(currency = 'USD', windowMinutes = 60) {
    const events = await this.getEvents();
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    let closest = null;
    let closestDist = Infinity;
    for (const ev of events) {
      if (!ev || ev.country !== currency) continue;
      if ((ev.impact || '').toLowerCase() !== 'high') continue;
      const ts = Date.parse(ev.date);
      if (isNaN(ts)) continue;
      const dist = Math.abs(ts - now);
      if (dist <= windowMs && dist < closestDist) {
        closest = { title: ev.title, currency: ev.country, timestamp: ts, minutesAway: Math.round((ts - now) / 60000) };
        closestDist = dist;
      }
    }
    return closest;
  }
};

const ProviderAdapters = {
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
  exchangerate: {
    name: 'ExchangeRate-API', requiresKey: false, supports: ['EURUSD'],
    // v4.6.3: open.er-api.com actualiza su tasa 1x/día. Como ahora es último recurso,
    // igual puede quedar "vivo" horas con el mismo valor si twelveData y alphaVantage
    // fallan. Se guarda el último valor+hora vistos (en memoria del proceso) y si el
    // valor no cambió en más de STALE_AFTER_MS, se rechaza en vez de darlo por bueno —
    // mejor sin señal de precio que con un precio de hace 24hs para cerrar SL/TP.
    _lastRate: null,
    _lastRateAt: null,
    STALE_AFTER_MS: 15 * 60 * 1000,
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
      const now = Date.now();
      if (this._lastRate === rate) {
        if (this._lastRateAt && (now - this._lastRateAt) > this.STALE_AFTER_MS) {
          throw new Error(`Tasa congelada: mismo valor desde hace ${Math.round((now - this._lastRateAt) / 60000)}min (open.er-api actualiza 1x/día)`);
        }
      } else {
        this._lastRate = rate;
        this._lastRateAt = now;
      }
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
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.TWELVEDATA}/time_series?symbol=${asset.symbols.twelveData}&interval=${tfMap[interval]||'15min'}&outputsize=${limit}&timezone=UTC`, CONFIG.REQUEST_TIMEOUT, { headers }, 'twelveData');
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
  coingecko: {
    name: 'CoinGecko', requiresKey: false, supports: ['BTCUSD','ETHUSD'],
    async fetchQuote(symbol) {
      const asset = ASSETS[symbol];
      const id = asset.symbols.coingecko;
      const cacheKey = `cg_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const headers = state.apiKeys.coingecko ? { 'x-cg-demo-api-key': state.apiKeys.coingecko } : {};
      const url = `${CONFIG.ENDPOINTS.COINGECKO}/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_last_updated_at=true`;
      const res = await fetchWithTimeout(url, CONFIG.REQUEST_TIMEOUT, { headers }, 'coingecko');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const d = data[id]; if (!d || d.usd == null) throw new Error('Respuesta inesperada de CoinGecko');
      const price = d.usd;
      const estBid = price * 0.9995, estAsk = price * 1.0005;
      const marketData = new MarketData({
        bid: estBid, ask: estAsk, last: price,
        open: price, high: price, low: price, close: price, volume: d.usd_24h_vol || 0,
        timestamp: (d.last_updated_at || Date.now() / 1000) * 1000, timeframe: '1d', marketStatus: 'open',
        spread: calculateSpread(estBid, estAsk, asset.pipSize),
        source: 'CoinGecko', symbol, estimatedSpread: true
      });
      ResponseCache.set(cacheKey, marketData); return marketData;
    },
    async fetchOHLCV(symbol, interval, limit = 100) {
      const asset = ASSETS[symbol];
      const id = asset.symbols.coingecko;
      const cacheKey = `cg_ohlcv_${symbol}_${interval}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const headers = state.apiKeys.coingecko ? { 'x-cg-demo-api-key': state.apiKeys.coingecko } : {};
      // v4.6.4: el endpoint /coins/{id}/ohlc tiene granularidad FIJA que decide CoinGecko
      // según 'days' (30min con days=1, 4h con days=3-30) — nunca da velas de 15m reales
      // sin importar qué pidamos, por eso siempre topeaba en 48 velas/día. Se cambia a
      // /market_chart, que devuelve precios a intervalos finos (~5min en days=1), y se
      // agregan acá en velas de 15m/1h GENUINAS por bucket de tiempo — mismo timeframe
      // que las estrategias esperan, no un timeframe distinto disfrazado.
      const days = (interval === '1h') ? '14' : '1';
      const url = `${CONFIG.ENDPOINTS.COINGECKO}/coins/${id}/market_chart?vs_currency=usd&days=${days}`;
      const res = await fetchWithTimeout(url, CONFIG.REQUEST_TIMEOUT, { headers }, 'coingecko');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.prices || !Array.isArray(data.prices) || !data.prices.length) throw new Error('Sin datos históricos de CoinGecko');
      const bucketMs = (interval === '1h') ? 60 * 60 * 1000 : 15 * 60 * 1000;
      const buckets = new Map();
      for (const [t, price] of data.prices) {
        const bucketKey = Math.floor(t / bucketMs) * bucketMs;
        let b = buckets.get(bucketKey);
        if (!b) { b = { time: bucketKey, open: price, high: price, low: price, close: price, volume: 0 }; buckets.set(bucketKey, b); }
        else { b.high = Math.max(b.high, price); b.low = Math.min(b.low, price); b.close = price; }
      }
      const candles = Array.from(buckets.values()).sort((a, b) => a.time - b.time);
      // Descartamos la última vela si todavía no cerró (bucket en curso) para no mezclar
      // una vela a medio formar con las cerradas — mismo criterio que usarían las demás fuentes.
      if (candles.length && (Date.now() - candles[candles.length - 1].time) < bucketMs) candles.pop();
      const result = new OHLCVData(candles.slice(-limit));
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
    // v4.6.4: detección de congelamiento genérica, mismo patrón que exchangerate.
    // Se vio en logs (24/8) que XAUUSD quedó con quote.last idéntico ~30min cuando
    // fmp era el proveedor activo (twelveData agotado). Por símbolo porque fmp sirve
    // los 4 activos, no uno solo como exchangerate.
    _lastQuotes: {},
    STALE_AFTER_MS: 20 * 60 * 1000,
    async fetchQuote(symbol) {
      if (!state.apiKeys.fmp) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `fmp_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      const res = await fetchWithTimeout(`${CONFIG.ENDPOINTS.FMP}/quote?symbol=${asset.symbols.fmp}&apikey=${state.apiKeys.fmp}`, CONFIG.REQUEST_TIMEOUT, {}, 'fmp');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json(); if (data['Error Message']) throw new Error(data['Error Message']);
      const d = data[0]; if (!d) throw new Error('Sin datos');
      const price = d.price;
      const now = Date.now();
      const last = this._lastQuotes[symbol];
      if (last && last.price === price) {
        if (now - last.at > this.STALE_AFTER_MS) {
          throw new Error(`Precio congelado: mismo valor desde hace ${Math.round((now - last.at) / 60000)}min (FMP)`);
        }
      } else {
        this._lastQuotes[symbol] = { price, at: now };
      }
      const bid = price * 0.9995; const ask = price * 1.0005;
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
      const usage = RequestTracker.getUsage(providerName);
      if (usage.limit && usage.used >= usage.limit) { logQuotaExcluded(providerName, symbol, usage); return false; }
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
      if (!adapter || !adapter.fetchOHLCV || !adapter.supports.includes(symbol)) return false;
      if (adapter.requiresKey && !state.apiKeys[providerName]) return false;
      const usage = RequestTracker.getUsage(providerName);
      if (usage.limit && usage.used >= usage.limit) { logQuotaExcluded(providerName, symbol, usage); return false; }
      return true;
    });
    if (eligible.length > 0) {
      const readyProviders = eligible.filter(p => !isProviderInCooldown(p));
      const providersToTry = readyProviders.length > 0 ? readyProviders : eligible;
      for (const providerName of providersToTry) {
        try {
          const data = await ProviderAdapters[providerName].fetchOHLCV(symbol, tf, limit);
          if (!data.isValid) throw new Error('Datos insuficientes');
          if (data.candles.length < limit) {
            console.warn(`OHLCV ${providerName} ÉXITO pero incompleto: ${symbol} ${tf} — pidió ${limit}, recibió ${data.candles.length}`);
          }
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const BacktestEngine = {
  async fetchCandles(symbol, interval) {
    return this.fetchCandlesTwelveData(symbol, interval);
  },
  async fetchCandlesTwelveData(symbol, interval) {
    if (!state.apiKeys.twelveData) return null;
    const asset = ASSETS[symbol];
    const tfMap = { '15m': '15min', '1h': '1h' };
    const headers = { 'Authorization': `apikey ${state.apiKeys.twelveData}` };
    const url = `${CONFIG.ENDPOINTS.TWELVEDATA}/time_series?symbol=${asset.symbols.twelveData}&interval=${tfMap[interval] || '15min'}&outputsize=${CONFIG.BACKTEST.TWELVEDATA_CANDLE_LIMIT}&timezone=UTC`;
    const res = await fetchWithTimeout(url, 10000, { headers }, 'twelveData');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.status === 'error' || !data.values) throw new Error(data.message || 'Sin datos históricos');
    return data.values.slice().reverse().map(v => ({
      time: new Date(v.datetime).getTime(), open: parseFloat(v.open), high: parseFloat(v.high),
      low: parseFloat(v.low), close: parseFloat(v.close), volume: v.volume ? parseFloat(v.volume) : 0
    }));
  },
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
      
      const disabledForSymbol = CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol] || [];
      const filteredSignals = signals.filter(sig => {
        if (!CONFIG.ENABLED_STRATEGIES.includes(sig.strategy)) return false;
        if (disabledForSymbol.includes(sig.strategy)) return false;
        return true;
      });

      for (const sig of filteredSignals) {
        const lastIdx = lastSignalIndexByStrategy[sig.strategy] ?? -9999;
        if (i - lastIdx < cfg.COOLDOWN_CANDLES) continue;
        const entry = sig.entry, sl = sig.sl, tp1 = sig.tp1;
        const tp2 = (sig.tp2 !== undefined && sig.tp2 !== null) ? sig.tp2 : null;
        if (entry == null || sl == null || tp1 == null) continue;
        const isLong = sig.direction === 'long';
        let result = null;
        let finalTarget = tp1; // el nivel que efectivamente cierra la operación
        let tp1AlreadyHit = false;
        const horizon = Math.min(candles.length, i + 1 + cfg.MAX_HOLD_CANDLES);
        // v4.7 (Etapa 3 — consistencia con evaluateCustomSignalOutcome/checkHistoryOutcomes):
        // antes el backtest cerraba en 'win' apenas tocaba TP1, ignorando tp2 aunque la
        // estrategia lo definiera (ny_open_kill_zone, bollinger_squeeze) — sembraba stats
        // de arranque más optimistas de la cuenta pero con el R equivocado (el de TP1, no
        // el de TP2). Ahora, si hay tp2, sigue escaneando después de tocar TP1 esperando
        // TP2 o SL, igual que en producción. Si se acaba el horizonte de MAX_HOLD_CANDLES
        // con TP1 ya tocado (sin SL ni TP2), se cuenta como ganada al R de TP1 — el mismo
        // criterio que la expiración en checkHistoryOutcomes.
        for (let j = i + 1; j < horizon; j++) {
          const c = candles[j];
          const hitSL = isLong ? c.low <= sl : c.high >= sl;
          const hitTP1 = isLong ? c.high >= tp1 : c.low <= tp1;
          const hitTP2 = tp2 != null && (isLong ? c.high >= tp2 : c.low <= tp2);
          if (hitSL) { result = 'loss'; break; }
          if (tp2 != null) {
            if (hitTP2) { result = 'win'; finalTarget = tp2; break; }
            if (hitTP1) tp1AlreadyHit = true;
          } else if (hitTP1) {
            result = 'win'; finalTarget = tp1; break;
          }
        }
        if (!result && tp2 != null && tp1AlreadyHit) {
          result = 'win'; finalTarget = tp1; // se acabó el horizonte con TP1 ya tocado
        }
        if (result) {
          const risk = Math.abs(entry - sl);
          const reward = Math.abs(finalTarget - entry);
          const rMultiple = result === 'win' ? (risk > 0 ? +(reward / risk).toFixed(2) : 2) : -1;
          events.push({ index: i, strategy: sig.strategy, direction: sig.direction, result, rMultiple });
          lastSignalIndexByStrategy[sig.strategy] = i;
        }
      }
    }
    return events;
  },
  aggregateCustomStats(events) {
    const stats = {};
    events.forEach(e => {
      if (!stats[e.strategy]) stats[e.strategy] = { wins: 0, losses: 0, totalR: 0 };
      if (e.result === 'win') stats[e.strategy].wins++; else stats[e.strategy].losses++;
      stats[e.strategy].totalR += (e.rMultiple != null ? e.rMultiple : (e.result === 'win' ? 2 : -1));
    });
    Object.keys(stats).forEach(key => {
      const s = stats[key];
      const total = s.wins + s.losses;
      s.sampleSize = total;
      s.winRate = total ? +(s.wins / total).toFixed(2) : 0;
      s.totalR = +s.totalR.toFixed(2);
      s.avgR = total ? +(s.totalR / total).toFixed(2) : 0; // v4.6.1: R-multiple promedio
    });
    return stats;
  },
  async runSymbol(symbol) {
    const asset = ASSETS[symbol];
    let allCustomEvents = [];
    let candlesAnalyzed = 0;
    for (const tf of CONFIG.BACKTEST.TIMEFRAMES) {
      const twelveDataUsage = RequestTracker.getUsage('twelveData');
      if (twelveDataUsage.limit && twelveDataUsage.used >= twelveDataUsage.limit) {
        console.warn(`Backtest: cupo diario de twelveData agotado (${twelveDataUsage.used}/${twelveDataUsage.limit}), se corta ${symbol} en ${tf}`);
        break;
      }
      if (isProviderInCooldown('twelveData')) {
        console.warn(`Backtest: twelveData en cooldown, se corta ${symbol} en ${tf}`);
        break;
      }
      try {
        const candles = await this.fetchCandles(symbol, tf);
        if (!candles || !candles.length) continue;
        candlesAnalyzed += candles.length;
        const customEvents = await this.simulateCustom(candles, symbol, asset);
        allCustomEvents = allCustomEvents.concat(customEvents);
      } catch (e) {
        console.warn(`Backtest: no se pudo traer historial de ${symbol} en ${tf}:`, e.message);
        markProviderCooldown('twelveData', e.message);
      }
      await sleep(6000);
    }
    if (!allCustomEvents.length) return null;
    const customStats = this.aggregateCustomStats(allCustomEvents);
    return { symbol, candlesAnalyzed, customStats };
  },
  async runAll(force = false) {
    if (state.backtestRunning) return;
    const cfg = CONFIG.BACKTEST;
    const lastRun = parseInt(localStorage.getItem('pt_backtest_last_run') || '0', 10);
    const lastAttempt = parseInt(localStorage.getItem('pt_backtest_last_attempt') || '0', 10);
    if (!force && Date.now() - lastRun < cfg.RERUN_INTERVAL_MS) { renderBacktestStatus(); return; }
    if (!force && Date.now() - lastAttempt < cfg.RETRY_INTERVAL_MS) { renderBacktestStatus(); return; }
    state.backtestRunning = true;
    localStorage.setItem('pt_backtest_last_attempt', String(Date.now()));
    renderBacktestStatus();
    const results = {};
    try {
      for (const symbol of cfg.SYMBOLS) {
        const r = await this.runSymbol(symbol);
        if (r) results[symbol] = r;
        if (isProviderInCooldown('twelveData')) {
          console.warn('Backtest: twelveData en cooldown, se corta la corrida completa');
          break;
        }
        await sleep(6000);
      }
      if (Object.keys(results).length) {
        seedStrategyStatsFromBacktest(results);
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

function renderCustomSignal(symbol, strategyKey, display) {
  state.lastCustomDisplay = state.lastCustomDisplay || {};
  state.lastCustomDisplay[symbol] = state.lastCustomDisplay[symbol] || {};
  state.lastCustomDisplay[symbol][strategyKey] = display || { type: 'no-signal' };
}
function renderConfidence() {}

function pushSignalHistory(signal) {
  if (signal.type !== 'long' && signal.type !== 'short') return;
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

function updatePatternStats(entry) {
  if (!entry.strategyKeys || !entry.strategyKeys.length) return;
  entry.strategyKeys.forEach(key => {
    if (!state.patternStats[key]) state.patternStats[key] = { wins: 0, losses: 0 };
    if (entry.result === 'win') state.patternStats[key].wins++;
    else if (entry.result === 'loss') state.patternStats[key].losses++;
  });
  localStorage.setItem('pt_pattern_stats', JSON.stringify(state.patternStats));
}

function updateStrategyStatsBySymbol(entry) {
  if (entry.result !== 'win' && entry.result !== 'loss') return;
  const symbol = entry.symbol, key = entry.source || 'smc';
  if (!symbol || !key) return;
  state.strategyStatsBySymbol[symbol] = state.strategyStatsBySymbol[symbol] || {};
  if (!state.strategyStatsBySymbol[symbol][key]) {
    state.strategyStatsBySymbol[symbol][key] = { wins: 0, losses: 0, totalR: 0, avgR: 0 };
  }
  const stats = state.strategyStatsBySymbol[symbol][key];
  if (entry.result === 'win') stats.wins++;
  else stats.losses++;
  const r = entry.rMultiple != null ? entry.rMultiple : (entry.result === 'win' ? 2 : -1);
  stats.totalR = +((stats.totalR || 0) + r).toFixed(2);
  
  const totalOps = stats.wins + stats.losses;
  stats.avgR = totalOps > 0 ? +(stats.totalR / totalOps).toFixed(2) : 0; // v4.6.1: Recalcular R promedio
  
  localStorage.setItem('pt_strategy_stats_by_symbol', JSON.stringify(state.strategyStatsBySymbol));

  checkCircuitBreaker(symbol, key, entry.result);
  checkCircuitBreakerAggregate(key, entry.result);
}

// v4.9 (sección 14, 27/8): breaker agregado — pérdidas seguidas de una estrategia sin
// importar el símbolo. Umbral 8 (no 5, el mismo que el breaker por símbolo): con 4 activos
// en juego, una racha diluida entre todos tarda más en acumularse que una concentrada en
// uno solo, así que el umbral agregado tiene que ser más alto para no dispararse por
// varianza normal entre símbolos independientes — 8 es el doble del umbral por símbolo,
// coherente con "la mitad de las combinaciones fallando seguido" como piso razonable de
// alarma real. Apaga la estrategia en los 4 símbolos a la vez (agrega la key a
// DISABLED_STRATEGIES_BY_SYMBOL de cada uno de SYMBOLS), separado del registro del breaker
// por símbolo para poder diferenciar en el push y en autoDisabledStrategiesAggregate cuál
// disparó.
function checkCircuitBreakerAggregate(key, result) {
  if (!CONFIG.CIRCUIT_BREAKER || !CONFIG.CIRCUIT_BREAKER.enabled) return;
  if (result === 'win') {
    if (state.consecutiveLossesAggregate[key]) { state.consecutiveLossesAggregate[key] = 0; }
    return;
  }
  if (result !== 'loss') return;

  state.consecutiveLossesAggregate[key] = (state.consecutiveLossesAggregate[key] || 0) + 1;
  localStorage.setItem('pt_consecutive_losses_aggregate', JSON.stringify(state.consecutiveLossesAggregate));

  const threshold = CONFIG.CIRCUIT_BREAKER.consecutiveLossThresholdAggregate || (CONFIG.CIRCUIT_BREAKER.consecutiveLossThreshold * 2);
  if (state.consecutiveLossesAggregate[key] < threshold) return;
  if (state.autoDisabledStrategiesAggregate[key]) return; // ya estaba apagada, no repetir aviso

  Object.keys(ASSETS || {}).forEach(symbol => {
    if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol]) CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol] = [];
    if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].includes(key)) {
      CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].push(key);
    }
  });
  state.autoDisabledStrategiesAggregate[key] = { key, disabledAt: Date.now(), lossStreak: state.consecutiveLossesAggregate[key] };
  localStorage.setItem('pt_auto_disabled_strategies_aggregate', JSON.stringify(state.autoDisabledStrategiesAggregate));

  const title = '🛑 Circuit breaker AGREGADO: estrategia pausada en todos los activos';
  const body = `${key} se auto-desactivó en los 4 activos tras ${state.consecutiveLossesAggregate[key]} pérdidas seguidas repartidas entre símbolos. Revisala cuando puedas.`;
  console.log(`[CIRCUIT BREAKER AGREGADO] ${key} auto-desactivada en todos los símbolos tras ${state.consecutiveLossesAggregate[key]} pérdidas consecutivas`);
  sendPushToAll({ title, body, signal: { strategy: key, autoDisabled: true, aggregate: true } }).catch(err => console.error('Error enviando push de circuit breaker agregado:', err.message));
}

// v4.7: si una combinación symbol+strategy encadena CIRCUIT_BREAKER.consecutiveLossThreshold
// pérdidas seguidas, se apaga sola (sin esperar a que Soy sume tablas a mano) y avisa por push.
// Una ganada en el medio resetea el contador a 0 — es "pérdidas SEGUIDAS", no acumuladas.
function checkCircuitBreaker(symbol, key, result) {
  if (!CONFIG.CIRCUIT_BREAKER || !CONFIG.CIRCUIT_BREAKER.enabled) return;
  const ckey = `${symbol}_${key}`;
  if (result === 'win') {
    if (state.consecutiveLosses[ckey]) { state.consecutiveLosses[ckey] = 0; }
    return;
  }
  if (result !== 'loss') return;

  state.consecutiveLosses[ckey] = (state.consecutiveLosses[ckey] || 0) + 1;
  localStorage.setItem('pt_consecutive_losses', JSON.stringify(state.consecutiveLosses));

  const threshold = CONFIG.CIRCUIT_BREAKER.consecutiveLossThreshold;
  if (state.consecutiveLosses[ckey] < threshold) return;
  if (state.autoDisabledStrategies[ckey]) return; // ya estaba apagada, no repetir aviso

  // Apaga la combinación agregándola a DISABLED_STRATEGIES_BY_SYMBOL en memoria (efecto
  // inmediato en el próximo ciclo, mismo chequeo que ya usa la lista manual) y la registra
  // en autoDisabledStrategies para diferenciarla de las apagadas a mano y poder listarlas.
  if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol]) CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol] = [];
  if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].includes(key)) {
    CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].push(key);
  }
  state.autoDisabledStrategies[ckey] = { symbol, key, disabledAt: Date.now(), lossStreak: state.consecutiveLosses[ckey] };
  localStorage.setItem('pt_auto_disabled_strategies', JSON.stringify(state.autoDisabledStrategies));

  const title = '🛑 Circuit breaker: estrategia pausada';
  const body = `${key} en ${symbol} se auto-desactivó tras ${state.consecutiveLosses[ckey]} pérdidas seguidas. Revisala cuando puedas.`;
  console.log(`[CIRCUIT BREAKER] ${ckey} auto-desactivada tras ${state.consecutiveLosses[ckey]} pérdidas consecutivas`);
  sendPushToAll({ title, body, symbol, signal: { strategy: key, autoDisabled: true } }).catch(err => console.error('Error enviando push de circuit breaker:', err.message));
}

function seedStrategyStatsFromBacktest(resultsBySymbol) {
  Object.entries(resultsBySymbol).forEach(([symbol, r]) => {
    state.strategyStatsBySymbol[symbol] = state.strategyStatsBySymbol[symbol] || {};
    Object.entries(r.customStats || {}).forEach(([key, s]) => {
      if (!state.strategyStatsBySymbol[symbol][key]) {
        const totalR = s.totalR != null ? s.totalR : (s.wins * 2 - s.losses);
        const totalOps = s.wins + s.losses;
        state.strategyStatsBySymbol[symbol][key] = { 
          wins: s.wins, 
          losses: s.losses, 
          totalR, 
          avgR: totalOps > 0 ? +(totalR / totalOps).toFixed(2) : 0, // v4.6.1
          seeded: true 
        };
      }
    });
  });
  localStorage.setItem('pt_strategy_stats_by_symbol', JSON.stringify(state.strategyStatsBySymbol));
}

function checkHistoryOutcomes(symbol, currentPrice, candles) {
  let changed = false;
  const resolvedEntries = [];
  state.signalHistory.forEach(h => {
    if (h.symbol !== symbol || h.result !== 'pending') return;
    const isLong = h.type === 'long';
    const hasTp2 = h.tp2 != null;
    const rTP1 = (h.tp1Pips && h.slPips) ? +(h.tp1Pips / h.slPips).toFixed(2) : 2;
    const rTP2 = (hasTp2 && h.tp2Pips && h.slPips) ? +(h.tp2Pips / h.slPips).toFixed(2) : null;
    let outcome = null;
    let rHit = rTP1;
    let tp1AlreadyHit = false;
    const relevantCandles = (candles || []).filter(c => c.time >= h.timestamp);
    // v4.7 (Etapa 3 — auditoría de cierre de operaciones): antes esta función
    // cerraba en 'win' apenas la vela tocaba TP1, sin mirar h.tp2 para nada —
    // h.tp2/h.tp2Pips se guardaban en el historial pero no se usaban acá. Para
    // estrategias con TP2 real (ny_open_kill_zone, bollinger_squeeze) ahora se
    // sigue escaneando vela por vela después de tocar TP1: si el precio llega a
    // TP2 antes que al SL, gana con el R de TP2 (no el de TP1). Si el SL llega
    // primero (haya pasado o no por TP1 antes), se registra pérdida -1R — el
    // motor no simula mover el stop a breakeven tras TP1, así que no se inventa
    // ese comportamiento acá. TP1 solo queda registrado como marca informativa
    // (tp1AlreadyHit) para el caso de expiración con TP1 ya tocado (ver abajo).
    if (relevantCandles.length) {
      for (const c of relevantCandles) {
        const hitSL = isLong ? c.low <= h.sl : c.high >= h.sl;
        const hitTP1 = isLong ? c.high >= h.tp1 : c.low <= h.tp1;
        const hitTP2 = hasTp2 && (isLong ? c.high >= h.tp2 : c.low <= h.tp2);
        if (hitSL) { outcome = 'loss'; rHit = -1; break; }
        if (hasTp2) {
          if (hitTP2) { outcome = 'win'; rHit = rTP2; break; }
          if (hitTP1) tp1AlreadyHit = true; // sigue pendiente, esperando TP2 o SL
        } else if (hitTP1) {
          outcome = 'win'; rHit = rTP1; break;
        }
      }
    }
    if (!outcome) {
      if (isLong && currentPrice <= h.sl) { outcome = 'loss'; rHit = -1; }
      else if (!isLong && currentPrice >= h.sl) { outcome = 'loss'; rHit = -1; }
      else if (hasTp2) {
        if (isLong && currentPrice >= h.tp2) { outcome = 'win'; rHit = rTP2; }
        else if (!isLong && currentPrice <= h.tp2) { outcome = 'win'; rHit = rTP2; }
        else if (isLong && currentPrice >= h.tp1) { tp1AlreadyHit = true; }
        else if (!isLong && currentPrice <= h.tp1) { tp1AlreadyHit = true; }
      } else {
        if (isLong && currentPrice >= h.tp1) { outcome = 'win'; rHit = rTP1; }
        else if (!isLong && currentPrice <= h.tp1) { outcome = 'win'; rHit = rTP1; }
      }
    }
    const expirationMs = (CONFIG.SIGNAL_EXPIRATION_MS_BY_STRATEGY && CONFIG.SIGNAL_EXPIRATION_MS_BY_STRATEGY[h.source]) || CONFIG.SIGNAL_EXPIRATION_MS;
    if (!outcome && (Date.now() - h.timestamp) > expirationMs) {
      // Si expiró habiendo tocado TP1 en el camino (pero nunca SL ni TP2), se
      // registra como ganada al R real de TP1 en vez de 'expired'/0R — el precio
      // sí llegó a un objetivo real antes de que se acabara el tiempo.
      if (hasTp2 && tp1AlreadyHit) { outcome = 'win'; rHit = rTP1; }
      else { outcome = 'expired'; rHit = 0; }
    }
    if (outcome) {
      // NUEVO (Etapa 3 real, Punto 6 — spread/comisión): rHit hasta acá es el R "en
      // limpio" (solo distancia de precio). Se descuenta el costo estimado de spread
      // en unidades R (spreadPips / h.slPips = cuánto vale el spread relativo al
      // riesgo de ESA operación puntual — no es el mismo % en todas, depende de qué
      // tan ajustado estaba el SL). Se guarda también el bruto (grossRMultiple) sin
      // tocar, por si en algún momento se quiere comparar "en limpio" vs. real.
      const spreadPips = CONFIG.ESTIMATED_SPREAD_PIPS_BY_SYMBOL[symbol] || 0;
      const spreadCostR = h.slPips ? spreadPips / h.slPips : 0;
      h.result = outcome; h.grossRMultiple = rHit; h.rMultiple = +(rHit - spreadCostR).toFixed(2); changed = true; resolvedEntries.push(h);
    }
  });
  if (changed) {
    localStorage.setItem('pt_v4_signals', JSON.stringify(state.signalHistory));
    resolvedEntries.forEach(entry => { updatePatternStats(entry); updateStrategyStatsBySymbol(entry); appendClosedSignal(entry); });
    runAutoTune(symbol);
  }
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

function appendClosedSignal(entry) {
  if (entry.result !== 'win' && entry.result !== 'loss') return;
  const dayKey = localDayKey(entry.timestamp);
  const storageKey = `closed_signals:${dayKey}`;
  let dayList;
  try { dayList = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch (e) { dayList = []; }
  dayList.push({
    symbol: entry.symbol, type: entry.type, source: entry.source || 'smc',
    result: entry.result, rMultiple: entry.rMultiple, timestamp: entry.timestamp
  });
  localStorage.setItem(storageKey, JSON.stringify(dayList));
  let daysIndex;
  try { daysIndex = JSON.parse(localStorage.getItem('closed_signals_days') || '[]'); } catch (e) { daysIndex = []; }
  if (!daysIndex.includes(dayKey)) {
    daysIndex.push(dayKey);
    daysIndex.sort();
    localStorage.setItem('closed_signals_days', JSON.stringify(daysIndex));
  }
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
  const confPart = (signal.confidence !== null && signal.confidence !== undefined) ? `· Confianza ${signal.confidence}%` : '';
  const body = `Entrada ${fmt(signal.entry, signal.decimals)} · SL ${fmt(signal.sl, signal.decimals)} · TP1 ${fmt(signal.tp1, signal.decimals)}${confPart}`;
  sendPushToAll({ title, body, symbol: signal.symbol, signal }).catch(err => console.error('Error enviando push:', err.message));
}

function toggleSound() {}
function toggleStrictMode() { state.strictMode = !state.strictMode; }

function resolveCustomSignal(symbol, quote, customSig, asset) {
  const key = `${symbol}_${customSig.strategy}`;
  const existing = state.activeCustomSignals[key];
  const isNewDirection = !existing || existing.type !== customSig.direction;
  const lastAt = state.lastCustomSignalAt[key] || 0;
  const cooldownRemainingMs = CONFIG.SIGNAL_COOLDOWN_MS - (Date.now() - lastAt);
  const inCooldown = isNewDirection && cooldownRemainingMs > 0;
  
  if (isNewDirection && !inCooldown) {
    let entry = customSig.entry || quote.last;
    let sl = customSig.sl;
    let tp1 = customSig.tp1;
    let tp2 = (customSig.tp2 !== undefined && customSig.tp2 !== null) ? customSig.tp2 : null;

    // --- NUEVO v4.6.2: Ajuste de holgura para XAUUSD (Oro) ---
    // El oro sufre muchas mechas que barren stops fijos. Ampliamos el SL un 50% 
    // y recalculamos los TPs para mantener el mismo ratio Riesgo:Beneficio (RR) original.
    if (symbol === 'XAUUSD' && sl !== null && tp1 !== null) {
      const risk = Math.abs(entry - sl);
      const reward1 = Math.abs(tp1 - entry);
      const originalRR1 = risk > 0 ? (reward1 / risk) : 2; 
      
      const slBufferFactor = 1.5; // 50% más de holgura para el SL
      const newRisk = risk * slBufferFactor;
      
      const isLong = customSig.direction === 'long';
      if (isLong) {
        sl = entry - newRisk;
        tp1 = entry + (newRisk * originalRR1);
        if (tp2 !== null) {
          const originalRR2 = Math.abs(tp2 - entry) / risk;
          tp2 = entry + (newRisk * originalRR2);
        }
      } else {
        sl = entry + newRisk;
        tp1 = entry - (newRisk * originalRR1);
        if (tp2 !== null) {
          const originalRR2 = Math.abs(tp2 - entry) / risk;
          tp2 = entry - (newRisk * originalRR2);
        }
      }
    }

    const slPips = toPips(sl, entry, asset);
    const tp1Pips = toPips(tp1, entry, asset);
    const tp2Pips = toPips(tp2, entry, asset);
    
    const currentRisk = Math.abs(entry - sl);
    const formatRR = tp => {
      if (tp === null || !currentRisk) return null;
      const reward = Math.abs(tp - entry);
      const ratio = reward / currentRisk;
      return `1:${ratio % 1 === 0 ? ratio.toFixed(0) : ratio.toFixed(1)}`;
    };
    
    const frozen = {
      type: customSig.direction, symbol, asset, entry, sl, tp1, tp2, slPips, tp1Pips, tp2Pips,
      // v4.7.3: antes hardcodeado en null — las señales de las 8 estrategias nunca
      // traían confidence. Ahora viene calculado por computeContextualScore() dentro
      // de evaluateAll() (custom-strategies.js). Puramente informativo, ver nota ahí.
      rr1: formatRR(tp1), rr2: formatRR(tp2), confidence: (customSig.confidence != null ? customSig.confidence : null),
      strategyLabels: [customSig.label], strategyKeys: [customSig.strategy],
      details: customSig.details, source: customSig.strategy, regime: 'n/a',
      timestamp: Date.now(), decimals: asset.decimals, detectedAt: Date.now(),
      tp1HitAt: null
    };
    state.activeCustomSignals[key] = frozen;
    state.lastCustomSignalAt[key] = frozen.detectedAt;
    try { localStorage.setItem('pt_active_custom_signals', JSON.stringify(state.activeCustomSignals)); } catch (e) {}
    try { localStorage.setItem('pt_last_custom_signal_at', JSON.stringify(state.lastCustomSignalAt)); } catch (e) {}
    pushSignalHistory(frozen);
    notifyNewSignal(frozen);
  }
  const frozen = state.activeCustomSignals[key];
  if (!frozen) return null;
  return evaluateCustomSignalOutcome(symbol, key, quote, frozen);
}

function evaluateCustomSignalOutcome(symbol, key, quote, frozen) {
  const isLong = frozen.type === 'long';
  const hitSL = isLong ? quote.last <= frozen.sl : quote.last >= frozen.sl;
  const hitTP1Now = isLong ? quote.last >= frozen.tp1 : quote.last <= frozen.tp1;
  const hitTP2 = frozen.tp2 != null && (isLong ? quote.last >= frozen.tp2 : quote.last <= frozen.tp2);
  if (hitTP1Now && !frozen.tp1HitAt) frozen.tp1HitAt = Date.now();
  const hitTP1 = hitTP1Now || !!frozen.tp1HitAt;
  const expirationMs = (CONFIG.SIGNAL_EXPIRATION_MS_BY_STRATEGY && CONFIG.SIGNAL_EXPIRATION_MS_BY_STRATEGY[frozen.source]) || CONFIG.SIGNAL_EXPIRATION_MS;
  const ageMs = Date.now() - frozen.timestamp;
  // v4.7 (Etapa 3 — auditoría de cierre de operaciones): antes esta función cerraba
  // la señal apenas tocaba TP1, sin importar si la estrategia definía tp2. hitTP2
  // se calculaba pero nunca se usaba para nada. Para las estrategias con TP2 real
  // (ny_open_kill_zone, bollinger_squeeze), el "cierre" que determina si la señal
  // sigue activa ahora es hasTp2 ? hitTP2 : hitTP1 — TP1 solo actualiza el badge
  // (frozen.tp1HitAt, sin cambios) pero ya no da de baja la señal por sí solo.
  const hasTp2 = frozen.tp2 != null;
  const hitFinalTarget = hasTp2 ? hitTP2 : hitTP1;
  const isExpired = !hitSL && !hitFinalTarget && ageMs > expirationMs;
  const shouldClose = hitSL || hitFinalTarget || isExpired;
  if (shouldClose) {
    delete state.activeCustomSignals[key];
    try { localStorage.setItem('pt_active_custom_signals', JSON.stringify(state.activeCustomSignals)); } catch (e) {}
    state.pendingCustomDisplayReset = state.pendingCustomDisplayReset || {};
    state.pendingCustomDisplayReset[key] = true;
  }
  return { type: frozen.type, frozen, currentPrice: quote.last, hitTP: hitTP1, hitTP1, hitTP2, hitSL };
}

function refreshActiveCustomSignalsDisplay(symbol, quote, skipStrategies = new Set()) {
  if (state.pendingCustomDisplayReset) {
    Object.keys(state.pendingCustomDisplayReset).forEach(pendingKey => {
      if (!pendingKey.startsWith(symbol + '_')) return;
      const stratKey = pendingKey.slice(symbol.length + 1);
      if (state.lastCustomDisplay[symbol]) state.lastCustomDisplay[symbol][stratKey] = { type: 'no-signal' };
      delete state.pendingCustomDisplayReset[pendingKey];
    });
  }
  Object.keys(state.activeCustomSignals).forEach(key => {
    if (!key.startsWith(symbol + '_')) return;
    const frozen = state.activeCustomSignals[key];
    if (!frozen) return;
    if (skipStrategies.has(frozen.strategyKeys[0])) return;
    const display = evaluateCustomSignalOutcome(symbol, key, quote, frozen);
    renderCustomSignal(symbol, frozen.strategyKeys[0], display);
  });
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
    // FIX (7.2, sesión 25/8): antes la única forma de saber cuántas velas HTF llegan
    // realmente en producción era buscar a mano en los logs de Render — y en más de un
    // intento no se encontró nada (Punto D, sesiones previas). Ahora queda guardado en
    // state, expuesto por /api/state (campo htfDiagnostics), consultable en cualquier
    // momento sin depender de que el log siga vivo en la ventana de retención de Render.
    state.htfDiagnostics = state.htfDiagnostics || {};
    state.htfDiagnostics[symbol] = { tf: htfTF, count: htfCandles ? htfCandles.length : 0, at: Date.now() };
    checkHistoryOutcomes(symbol, quote.last, ohlcv.candles);
    
    try {
      // v4.7.3 (Etapa 3 — scoring contextual): se pasa el historial reciente
      // símbolo+estrategia como symbolStats, 5º parámetro nuevo de evaluateAll().
      // Cierra el pendiente ya anotado en el changelog de custom-strategies.js
      // (punto 8): la función es pura, no tiene acceso directo a Supabase/state.
      // v4.8: se agrega newsContext (6º parámetro) — evento de alto impacto en USD
      // dentro de ±60min, si lo hay. Uso exclusivo de computeContextualScore(): ajusta
      // el mismo score informativo que ya existe, no agrega campos nuevos a la señal
      // ni se muestra en la UI (decisión explícita de Soy).
      const newsContext = await NewsCalendar.getNearbyHighImpact('USD', 60);
      const rawSignals = CustomStrategies.evaluateAll(ohlcv.candles, symbol, asset, htfCandles, state.strategyStatsBySymbol[symbol] || null, newsContext, CONFIG.MIN_CONFIDENCE_SCORE);
      const disabledForSymbol = CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol] || [];
      const filteredSignals = rawSignals.filter(sig => {
        if (!CONFIG.ENABLED_STRATEGIES.includes(sig.strategy)) {
          console.log(`[v4.6] ${symbol}: Estrategia '${sig.strategy}' ignorada (no está en ENABLED_STRATEGIES)`);
          return false;
        }
        if (disabledForSymbol.includes(sig.strategy)) {
          console.log(`[v4.6] ${symbol}: Estrategia '${sig.strategy}' ignorada (desactivada para este activo)`);
          return false;
        }
        return true;
      });

      const firedThisCycle = new Set();
      filteredSignals.forEach(sig => {
        const customDisplay = resolveCustomSignal(symbol, quote, sig, asset);
        renderCustomSignal(symbol, sig.strategy, customDisplay);
        firedThisCycle.add(sig.strategy);
        if (customDisplay) {
          addLog(quote.source, `[${sig.label}] señal ${sig.direction === 'long' ? 'LONG' : 'SHORT'} independiente`, symbol);
        }
      });
      refreshActiveCustomSignalsDisplay(symbol, quote, firedThisCycle);
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
      await sleep(8000);
    }
  } finally {
    if (forceRefresh) setLoading(false);
  }
}

async function requestWakeLock() {}

// FIX (7.1, medida intermedia): chequeo liviano de precio para BTC/ETH, en paralelo al
// ciclo principal (ver CONFIG.CRYPTO_QUICK_CHECK_INTERVAL_MS). No evalúa estrategias ni
// genera señales nuevas — solo pide el precio actual y lo pasa a checkHistoryOutcomes
// para detectar más rápido si una señal ya en curso tocó SL o TP, usando las últimas
// velas ya cacheadas (state.klineHistory) en vez de pedir OHLCV/HTF de nuevo.
async function quickPriceCheck(symbol) {
  const asset = ASSETS[symbol];
  if (!asset || asset.type !== 'crypto') return;
  if (!isMarketOpenForAsset(symbol)) return;
  try {
    const quote = await MarketDataProvider.getQuote(symbol, false);
    updatePriceUI(symbol, quote, asset);
    const cachedCandles = (state.klineHistory[symbol] && state.klineHistory[symbol].candles) || [];
    checkHistoryOutcomes(symbol, quote.last, cachedCandles);
  } catch (e) {
    console.warn(`quickPriceCheck: fallo en ${symbol}:`, e.message);
  }
}

let cryptoQuickCheckTimer = null;
async function cryptoQuickCheckTick() {
  try {
    for (const symbol of Object.keys(ASSETS)) {
      if (ASSETS[symbol].type === 'crypto') await quickPriceCheck(symbol);
    }
  } finally {
    cryptoQuickCheckTimer = setTimeout(cryptoQuickCheckTick, CONFIG.CRYPTO_QUICK_CHECK_INTERVAL_MS);
  }
}

function startCryptoQuickCheckLoop() {
  if (cryptoQuickCheckTimer) return;
  cryptoQuickCheckTimer = setTimeout(cryptoQuickCheckTick, CONFIG.CRYPTO_QUICK_CHECK_INTERVAL_MS);
}

function stopCryptoQuickCheckLoop() {
  if (cryptoQuickCheckTimer) { clearTimeout(cryptoQuickCheckTimer); cryptoQuickCheckTimer = null; }
}

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
  if (autoRefreshTimer) return;
  autoRefreshTick();
}

function stopAutoRefreshLoop() {
  if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; }
}

module.exports = {
  state, CONFIG, ASSETS, refreshAllData, refreshAsset, BacktestEngine,
  startAutoRefreshLoop, stopAutoRefreshLoop, getDynamicRefreshIntervalMs, isArgKillZoneWindow,
  startCryptoQuickCheckLoop, stopCryptoQuickCheckLoop
};
