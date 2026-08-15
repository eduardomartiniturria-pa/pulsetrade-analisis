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
// - Se integran las 7 estrategias INDEPENDIENTES de custom-strategies.js: Kill Zone
//   Apertura NY (9:30 AM), Pivots Breakout & Reversal, Price Action + RSI + EMA,
//   Supply and Demand, EMA Cross Scalping, Divergencia RSI y Bollinger Squeeze
//   Breakout. Corren en paralelo a las estrategias SMC (CHoCH, BOS, OB, FVG, Sweep,
//   etc), NO pasan por evalSide() ni por los filtros globales de confluencia/
//   premium-discount/HTF, y emiten su propia señal con su propio SL/TP cuando
//   cumplen TODAS sus condiciones. (Ver custom-strategies.js para el detalle de
//   cada una — el conteo se corrigió acá porque los comentarios anteriores decían
//   "3" y "5" en distintos lugares, ninguno actualizado desde que se agregaron las
//   últimas estrategias.)
//
// FIX (timezone Kill Zone NY / velas corridas de horario):
// - Las peticiones a Twelve Data (/time_series) para OHLCV no llevaban el parámetro
//   `timezone=UTC`. Sin ese parámetro, Twelve Data devuelve `datetime` en la zona
//   horaria de la plaza del activo (para XAUUSD, hora de Nueva York), como una cadena
//   sin sufijo `Z` (ej. "2026-08-11 09:30:00"). Al hacer `new Date(k.datetime)` sobre
//   esa cadena en un proceso corriendo en UTC (como en Render), JS la interpretaba
//   como si YA fuera UTC — desfasando cada vela ~4-5hs (según DST) respecto al
//   instante real. detectNYOpenKillZone() volvía a convertir ese timestamp corrupto a
//   hora NY con Intl.DateTimeFormat, aplicando el offset una segunda vez sobre un dato
//   ya corrido — resultado: la ventana 9:30-9:45 NY caía en otro horario del día,
//   generando señales de Kill Zone de madrugada en hora Argentina.
// - Se agregó `&timezone=UTC` a las dos URLs de Twelve Data que arman velas
//   (ProviderAdapters.twelveData.fetchOHLCV y BacktestEngine.fetchCandlesTwelveData),
//   así `datetime` viene ya en UTC real y no hay doble conversión.
//
// FIX v4.3 (señales custom congeladas en el feed + badge TP2 distinto, sesión 12/8):
// - BUG: para las 7 estrategias independientes, state.lastCustomDisplay (lo que expone
//   /api/state y pinta el panel) solo se actualizaba mientras la señal seguía en
//   state.activeCustomSignals. Al resolverse (tocar SL o TP1) se borraba de
//   activeCustomSignals, y como refreshActiveCustomSignalsDisplay() solo recorre esa
//   lista, nadie volvía a tocar lastCustomDisplay — quedaba congelado (badge, precio,
//   flecha) para siempre, hasta la próxima señal nueva de esa estrategia+activo. SMC no
//   tenía este problema (renderSignal() se llama en cada ciclo sin importar el resultado).
// - FIX: nueva función evaluateCustomSignalOutcome() centraliza el chequeo de
//   SL/TP1/TP2, y al cerrar una señal marca su key en
//   state.pendingCustomDisplayReset — en el siguiente ciclo,
//   refreshActiveCustomSignalsDisplay() usa esa marca para resetear el display a
//   "no-signal", así el badge resuelto se ve un ciclo completo y después se limpia solo.
// - Se agrega además soporte real de TP2: antes hitTP solo comparaba contra tp1. Ahora,
//   si la estrategia define tp2, la señal sigue activa tras tocar TP1 (badge "TP1
//   alcanzado") hasta que también toque TP2 (badge "TP2 alcanzado") o SL. Si no hay tp2
//   definido, se cierra igual que antes al tocar TP1. Mismo campo hitTP2 agregado
//   también a la resolución de señales SMC (resolveActiveSignal) para que el badge se
//   comporte igual en las 8 estrategias.
//
// FIX v4.4 (Backtest reintentando en cada redeploy pese al 429 de Twelve Data, sesión 13/8):
// - DIAGNÓSTICO (con evidencia de logs de Render): en 3 arranques distintos del proceso,
//   los 8 pedidos del Backtest (4 símbolos x 2 timeframes) a Twelve Data fallaban SIEMPRE
//   con HTTP 429 — confirmado por búsqueda que el plan gratis de Twelve Data es 8
//   créditos/minuto, cupo que se resetea recién al minuto calendario siguiente (no de
//   forma progresiva). fetchCandlesTwelveData no tenía ninguna de las protecciones que sí
//   usa el path en vivo (MarketDataProvider): no chequeaba isProviderInCooldown antes de
//   pedir, y el catch de runSymbol no llamaba a markProviderCooldown — así que, aunque el
//   primer pedido ya pegara 429, los 7 restantes se mandaban igual, cada 6s, todos
//   condenados a fallar. Además, pt_backtest_last_run (el timestamp que frena reintentos
//   dentro de las 24hs) solo se grababa si la corrida conseguía al menos un evento — con
//   los 8 pedidos fallando, results quedaba vacío y ese timestamp nunca se actualizaba, así
//   que el gating de 24hs nunca frenaba nada: cada redeploy volvía a intentarlo 2 minutos
//   después de arrancar (ver setTimeout en server.js) y volvía a fallar igual, sin límite.
// - FIX: runSymbol ahora corta el loop de timeframes/símbolos apenas isProviderInCooldown
//   detecta a twelveData en cooldown (activado por markProviderCooldown en el catch, que ya
//   sabe interpretar "HTTP 429" → 10 min de cooldown, reutilizando el mismo mecanismo del
//   path en vivo). runAll corta también el loop de símbolos restante bajo la misma
//   condición. Se agrega además pt_backtest_last_attempt, que se graba SIEMPRE que se
//   decide correr (haya éxito o no) apenas arranca la corrida — y un nuevo
//   CONFIG.BACKTEST.RETRY_INTERVAL_MS (1h) que frena reintentos sin `force` si el último
//   intento fue reciente, sin esperar las 24hs completas de RERUN_INTERVAL_MS (pensadas
//   para corridas exitosas, no para esto). Verificado con test funcional simulando 429
//   constante: antes salían 8 pedidos por corrida fallida y se repetía en cada redeploy;
//   después sale 1 pedido, corta, y el siguiente intento sin force queda bloqueado por
//   RETRY_INTERVAL_MS. Camino exitoso (Twelve Data respondiendo bien) verificado sin
//   cambios de comportamiento: 8 pedidos, pt_backtest_last_run se graba, 24hs se respetan.
//
// FIX v4.5 (chequeo de cuota diaria antes de disparar el backtest, sesión 13/8):
// - Confirmado con el dashboard real de Twelve Data (825/800 créditos usados ese día,
//   minutely average 4/8 y maximum 6/8 — nunca cerca del límite por minuto) que la causa
//   de fondo del 429 era la cuota DIARIA agotada, no un pico puntual por minuto.
// - runSymbol ya cortaba la corrida por cooldown apenas llegaba el primer 429 (fix v4.4),
//   pero ese primer pedido siempre se disparaba igual, aunque el propio contador
//   (RequestTracker) ya supiera que la cuota diaria estaba en 0 — el path en vivo
//   (MarketDataProvider) sí evita eso desde antes. Se agregó el mismo chequeo
//   (RequestTracker.getUsage('twelveData')) antes de intentar cada timeframe: si la
//   cuota diaria ya está agotada, corta sin gastar ni ese último crédito en un pedido
//   sin ninguna chance de éxito.
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
  // Ventana máxima que una señal puede quedar 'pending' sin resolverse. checkHistoryOutcomes()
  // solo revisa contra las últimas ~100 velas fetcheadas en cada ciclo (ver refreshAsset,
  // MarketDataProvider.getOHLCV(symbol, state.currentTF, 100, ...)) — con TF de 15min eso es
  // apenas ~25hs de ventana. Una señal más vieja que esta ventana, si el precio cruzó su SL/TP
  // en algún momento fuera de esa franja y luego se movió de nuevo dentro del rango, nunca
  // vuelve a aparecer en los datos que se comparan y queda 'pending' para siempre — es lo que
  // se veía como señales "en curso" desde el sábado. Pasado este umbral sin poder confirmar
  // resultado con los datos disponibles, se marca 'expired' en vez de dejarla eternamente
  // pendiente (no cuenta como win ni loss en las estadísticas por estrategia).
  SIGNAL_EXPIRATION_MS: 72 * 60 * 60 * 1000,
  // Excepción al umbral de arriba: ema_cross_scalping y ny_open_kill_zone son estrategias
  // pensadas para movimientos rápidos (scalping / ventana de apertura NY 9:30-9:45). El
  // setup que justificó la entrada deja de ser válido mucho antes de las 72hs del umbral
  // general, aunque el precio técnicamente no haya tocado SL ni TP todavía. Con 4hs alcanza
  // de sobra para lo que estas dos estrategias buscan capturar; el resto de las estrategias
  // (SMC, swing) sigue usando SIGNAL_EXPIRATION_MS sin cambios. Clave = h.source /
  // strategyKeys[0] (ver custom-strategies.js, campo `strategy` de cada resultado).
  SIGNAL_EXPIRATION_MS_BY_STRATEGY: {
    ema_cross_scalping: 4 * 60 * 60 * 1000,
    ny_open_kill_zone: 4 * 60 * 60 * 1000
  },
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
    // FIX (429 en cada redeploy): antes, pt_backtest_last_run solo se grababa cuando la
    // corrida conseguía al menos un evento (resultados no vacíos). Si Twelve Data pegaba
    // 429 en los 8 pedidos (4 símbolos x 2 timeframes) — como pasaba siempre que la corrida
    // coincidía con el cupo de 8 créditos/minuto ya consumido por el refresco en vivo —
    // `results` quedaba vacío, el timestamp nunca se actualizaba, y el chequeo de 24hs de
    // arriba nunca frenaba nada: cada redeploy volvía a intentarlo desde cero 2 minutos
    // después de arrancar, y volvía a fallar igual. Ahora se distingue "se intentó correr"
    // (pt_backtest_last_attempt, se graba SIEMPRE que se decide correr, haya éxito o no) de
    // "corrió con éxito" (pt_backtest_last_run, sigue igual que antes). Si el último intento
    // fue hace menos de RETRY_INTERVAL_MS, no se reintenta — evita la cascada de redeploys
    // seguidos reintentando cada vez. Es más corto que RERUN_INTERVAL_MS a propósito: una
    // falla por rate limit suele ser transitoria (el cupo de Twelve Data se resetea cada
    // minuto), así que 1h alcanza para no seguir chocando con el mismo 429 sin esperar un
    // día entero para el próximo intento real.
    RETRY_INTERVAL_MS: 60 * 60 * 1000,
    SEED_CAP: 40,
    YIELD_EVERY: 40
  },
  // CryptoCompare (min-api.cryptocompare.com / CoinDesk Data) discontinuó su nivel gratis
  // el 21 de mayo de 2026 — con o sin API key, ahora corta con "rate limit / upgrade your
  // account" siempre. Se reemplazó por CoinGecko (coingecko, 10.000 pedidos/mes gratis) como
  // respaldo de cripto en BTCUSD/ETHUSD. EUR/USD y XAU/USD no son cripto, así que no aplica.
  PROVIDER_PRIORITY: ['exchangerate', 'twelveData', 'alphaVantage'],
  ENDPOINTS: {
    BINANCE_SPOT: 'https://api.binance.com/api/v3',
    BINANCE_FUTURES: 'https://fapi.binance.com/fapi/v1',
    COINGECKO: 'https://api.coingecko.com/api/v3',
    // api.exchangerate-api.com/v4/latest quedó discontinuado por el proveedor; la URL
    // vigente es open.er-api.com/v6/latest, con el mismo formato de respuesta (rates: {...}).
    EXCHANGERATE: 'https://open.er-api.com/v6/latest',
    TWELVEDATA: 'https://api.twelvedata.com',
    FINNHUB: 'https://finnhub.io/api/v1',
    ALPHAVANTAGE: 'https://www.alphavantage.co/query',
    FMP: 'https://financialmodelingprep.com/stable'
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
    // binanceSpot se sacó de la prioridad en vivo: desde Render devuelve HTTP 451 SIEMPRE
    // (bloqueo geográfico permanente de Binance, mismo motivo por el que BacktestEngine.
    // fetchCandles más abajo ya lo saca del todo para el backtest). Dejarlo primero acá
    // solo hacía perder un intento fallido + ~1.5s cada vez que salía del cooldown de 30min
    // antes de caer a CoinGecko. El adaptador binanceSpot queda definido por si se despliega
    // fuera de Render alguna vez.
    providerPriority: ['coingecko', 'twelveData', 'alphaVantage']
  },
  ETHUSD: {
    name: 'ETH/USD', market: 'crypto', type: 'crypto',
    symbols: { twelveData: 'ETH/USD', finnhub: 'BINANCE:ETHUSDT', alphaVantage: 'ETH', fmp: 'ETHUSD', binance: 'ETHUSDT', coingecko: 'ethereum' },
    decimals: 2, pipSize: 1, is24h: true, timezone: 'UTC',
    openHour: 0, closeHour: 24, openDays: [0,1,2,3,4,5,6],
    // Mismo motivo que BTCUSD: binanceSpot siempre da 451 desde Render, se saca de la
    // prioridad en vivo.
    providerPriority: ['coingecko', 'twelveData', 'alphaVantage']
  },
  EURUSD: {
    name: 'EUR/USD', market: 'forex', type: 'forex',
    symbols: { twelveData: 'EUR/USD', finnhub: 'OANDA:EUR_USD', alphaVantage: 'EURUSD', fmp: 'EURUSD', exchangerate: 'EUR' },
    decimals: 5, pipSize: 0.0001, is24h: false, timezone: 'UTC',
    // CoinGecko no cubre forex (EUR/USD no es cripto), por eso no aparece en esta lista.
    providerPriority: ['exchangerate', 'twelveData', 'alphaVantage']
  },
  XAUUSD: {
    name: 'XAU/USD (Oro)', market: 'forex', type: 'commodity',
    symbols: { twelveData: 'XAU/USD', finnhub: 'OANDA:XAU_USD', alphaVantage: 'XAU', fmp: 'GCUSD' },
    decimals: 2, pipSize: 0.1, is24h: false, timezone: 'UTC',
    // CoinGecko no cubre commodities (oro no es cripto), por eso no aparece en esta lista.
    providerPriority: ['twelveData', 'fmp', 'alphaVantage']
  }
};

let state = {
  currentTF: '15m',
  lastPrice: null, prevPrice: null, klineHistory: {},
  signalHistory: (() => { try { return JSON.parse(localStorage.getItem('pt_v4_signals') || '[]'); } catch (e) { return []; } })(),
  providers: {}, providerStats: {}, currentProvider: null, autoRefresh: null,
  lastFetchTime: null, currentData: null, logs: [],
  activeSignals: (() => { try { return JSON.parse(localStorage.getItem('pt_active_signals') || '{}'); } catch (e) { return {}; } })(),
  lastSignalAt: (() => { try { return JSON.parse(localStorage.getItem('pt_last_signal_at') || '{}'); } catch (e) { return {}; } })(),
  // FIX (duplicados por reinicio): antes, activeCustomSignals/lastCustomSignalAt vivían
  // solo en memoria — cualquier reinicio del proceso (redeploy, o el plan free de Render
  // reiniciando el servicio) los reseteaba a {} sin avisar. Si el patrón que había
  // disparado una señal seguía vigente en el próximo ciclo (la misma vela de ruptura
  // todavía dentro de la ventana de análisis), el motor la volvía a tratar como "señal
  // nueva" — resultado: la misma señal (mismo entry/SL/TP) quedaba duplicada en el
  // historial. Confirmado con evidencia real: BTCUSD y ETHUSD (Pivots Breakout &
  // Reversal) duplicados exactos, 74 segundos apartados, coincidiendo con un reinicio.
  // Ahora se persisten igual que signalHistory, así sobreviven a un reinicio.
  activeCustomSignals: (() => { try { return JSON.parse(localStorage.getItem('pt_active_custom_signals') || '{}'); } catch (e) { return {}; } })(),
  lastCustomSignalAt: (() => { try { return JSON.parse(localStorage.getItem('pt_last_custom_signal_at') || '{}'); } catch (e) { return {}; } })(),
  spreadHistory: (() => { try { return JSON.parse(localStorage.getItem('pt_spread_history') || '{}'); } catch (e) { return {}; } })(),
  autoConfidenceThreshold: (() => {
    try { const v2 = JSON.parse(localStorage.getItem('pt_auto_threshold_v2') || 'null'); if (v2 && typeof v2 === 'object') return v2; } catch (e) {}
    const legacy = parseFloat(localStorage.getItem('pt_auto_threshold'));
    const seed = !isNaN(legacy) ? legacy : CONFIG.CONFIDENCE_THRESHOLD;
    const obj = {}; Object.keys(ASSETS).forEach(sym => { obj[sym] = seed; }); return obj;
  })(),
  autoTuneStats: (() => { try { return JSON.parse(localStorage.getItem('pt_auto_stats_v2') || '{}'); } catch (e) { return {}; } })(),
  patternStats: (() => { try { return JSON.parse(localStorage.getItem('pt_pattern_stats') || '{}'); } catch (e) { return {}; } })(),
  // Ganadas/perdidas + R-multiple acumulado (totalR) por símbolo + estrategia (las 8:
  // 'smc' y las 7 keys de custom-strategies.js), para comparar qué estrategia rinde
  // mejor en qué activo — no solo por % de aciertos, sino por cuánto rinde en relación
  // al riesgo (R promedio = totalR / (wins+losses)).
  // Separado de patternStats a propósito: patternStats agrupa por tipo de patrón interno
  // de SMC (choch/bos/ob/...) mezclando los 4 símbolos, y alimenta el auto-tune de
  // confianza — no sirve para esta comparación y no se toca. Se arranca (seedStrategyStatsFromBacktest)
  // con los resultados del backtest y después se suma cada señal en vivo que se resuelve
  // (ver checkHistoryOutcomes/updateStrategyStatsBySymbol).
  strategyStatsBySymbol: (() => { try { return JSON.parse(localStorage.getItem('pt_strategy_stats_by_symbol') || '{}'); } catch (e) { return {}; } })(),
  backtestPatternStats: (() => { try { return JSON.parse(localStorage.getItem('pt_backtest_pattern_stats') || '{}'); } catch (e) { return {}; } })(),
  backtestAutoTune: (() => { try { return JSON.parse(localStorage.getItem('pt_backtest_autotune') || '{}'); } catch (e) { return {}; } })(),
  // Estadísticas de backtest de las 7 estrategias independientes (custom-strategies.js).
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
    fmp: localStorage.getItem('pt_api_fmp') || null
  },
  refreshPaused: false, wakeLock: null
};

function getNow() { return new Date(); }

// Ventana Kill Zone NY en hora Argentina (10:30-13:30), usada SOLO para decidir la
// frecuencia de refresco del scheduler (más rápido durante la apertura de NY). Es un
// cálculo aparte e independiente de CustomStrategies.detectNYOpenKillZone() (la
// estrategia que genera la señal en sí, sobre las velas 9:30-9:45 en hora real de
// Nueva York con DST) — esta función de acá usa un offset fijo Argentina/NY a
// propósito, solo para dar una ventana más ancha de refresco rápido, no para detectar
// la señal. Si algún día se vuelve más estricta la lógica de scheduling, conviene
// migrarla también a America/New_York real para no depender del offset fijo.
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

// Orden exacto de fallback para decidir qué umbral de confianza usar (de más específico
// y confiable a más genérico), sin tocar la lógica de abajo:
//   1º. Si se pasa un régimen (trending/ranging) y el auto-tune EN VIVO ya tiene muestra
//       suficiente para ese símbolo+régimen (sampleSize >= minSampleSize), se usa ese
//       umbral — es el más afinado posible, calibrado con operaciones reales de ESE
//       símbolo en ESE tipo de mercado.
//   2º. Si hay régimen pero el en vivo todavía no tiene muestra suficiente, se usa el
//       umbral calibrado por el BACKTEST para ese símbolo+régimen (si existe).
//   3º. Si no hay régimen (o ninguna de las dos anteriores devolvió nada), se mira el
//       auto-tune EN VIVO general del símbolo (sin distinguir régimen): si tiene muestra
//       suficiente, se salta directo al paso 5 (se usa el umbral ya guardado para el
//       símbolo, que es justamente el que ese auto-tune en vivo fue ajustando).
//   4º. Si el en vivo general tampoco tiene muestra suficiente, se prueba el umbral
//       calibrado por el BACKTEST general del símbolo (sin régimen).
//   5º. Si nada de lo anterior aplicó, cae al umbral guardado en
//       state.autoConfidenceThreshold[symbol] (el último valor conocido, en vivo o no) o,
//       en último caso, al default fijo CONFIG.CONFIDENCE_THRESHOLD (70).
// En criollo: primero se confía en lo más reciente y específico (en vivo por régimen),
// después en el backtest por régimen, después en lo en vivo general, después en el
// backtest general, y solo si no hay nada de nada, en el número fijo de config.
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
  // Endpoint que directamente no existe en el plan gratis (ej: Alpha Vantage
  // "This is a premium endpoint") — reintentar antes no sirve de nada, nunca
  // va a funcionar con esta key. Cooldown largo (24h) en vez de reintentar
  // cada ciclo para siempre.
  if (msg.includes('premium endpoint') || msg.includes('premium plan') || msg.includes('unlock all premium')) {
    return 24 * 60 * 60 * 1000;
  }
  // Cupo diario agotado (ej: Alpha Vantage "25 requests per day", "rate limit is 25").
  // No se resetea en minutos, se resetea al otro día — cooldown de 12h en vez de 10min.
  if (msg.includes('requests per day') || msg.includes('per day') || msg.includes('daily rate limit')) {
    return 12 * 60 * 60 * 1000;
  }
  // Rate limit genérico / burst (429, u otras variantes de texto que usan
  // algunos proveedores sin devolver el código HTTP explícito).
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('spreading out') || msg.includes('too many requests')) {
    return 10 * 60 * 1000;
  }
  // Key inválida o vencida (ej: CoinGecko con la key rota) — nada que un reintento en
  // el próximo ciclo (15 min) vaya a solucionar. Cooldown largo, igual que "premium
  // endpoint": se resetea solo apenas el proveedor vuelva a responder 200.
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
    // FIX: se agrega &timezone=UTC. Sin este parámetro, Twelve Data devuelve `datetime`
    // en la hora local de la plaza del activo (para XAUUSD, hora de Nueva York), como
    // cadena sin sufijo `Z`. `new Date(k.datetime)` en un proceso corriendo en UTC (Render)
    // interpretaba esa cadena como si ya fuera UTC, desfasando cada vela varias horas y
    // rompiendo la ventana 9:30-9:45 NY de detectNYOpenKillZone() en custom-strategies.js.
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

  // CoinGecko reemplaza a CryptoCompare como respaldo de cripto: CoinDesk (dueño de
  // CryptoCompare desde 2024) discontinuó el nivel gratis de esa API el 21 de mayo de 2026 —
  // por eso pegaba "rate limit / upgrade your account" siempre, no era un problema de ráfaga.
  // CoinGecko Demo (gratis, con key) sigue dando 10.000 pedidos/mes.
  // Nota sobre velas: el endpoint /ohlc gratuito no deja elegir el intervalo (15m/1h) como los
  // demás proveedores — la granularidad depende de "days" y CoinGecko la fija sola (con days=1
  // da velas de 30 min). Se usa como aproximación aceptable solo para este proveedor de
  // respaldo; los proveedores de arriba en la prioridad sí respetan el timeframe exacto.
  coingecko: {
    // requiresKey: false a propósito — sin COINGECKO_API_KEY igual funciona con el nivel
    // público de CoinGecko (más limitado en rate, pero gratis y sin registro). Antes esto
    // decía requiresKey: true y ADEMÁS mandaba el header 'x-cg-demo-api-key' con el valor
    // null cuando no había key configurada — CoinGecko devuelve 401 ante ese header
    // literalmente "null", así que sin key el proveedor fallaba siempre en vez de degradar
    // al nivel público como dice el README.
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
      const estBid = price * 0.9995, estAsk = price * 1.0005; // CoinGecko no da bid/ask, se estima igual que Alpha Vantage
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
      // CORREGIDO (13/8, ronda 2 — revierte el fix de la ronda 1): "days=2" NO es un valor
      // válido para este endpoint — CoinGecko devolvía HTTP 400 en producción (confirmado en
      // logs de Render), no 200 con más velas. El parámetro "days" solo acepta un conjunto fijo
      // de valores (1, 7, 14, 30, 90, 180, 365, max), no cualquier entero — la tabla de
      // auto-granularidad de la doc describe el RANGO "1-2 días: 30 min" pero eso no implica que
      // "2" en sí sea un valor aceptado.
      // Fix real: distinguir el pedido normal del pedido HTF por el "interval" recibido.
      // CONFIG.HTF_MAP solo mapea a '1h' (nunca a otro valor), así que interval === '1h' identifica
      // sin ambigüedad el pedido de velas HTF (el que usa detectSupplyDemand para su filtro de
      // tendencia mayor, que necesita >=50 velas). Para ese caso se usa days=14 (válido), que cae
      // en el rango de auto-granularidad 3-30 días -> velas de 4h, entregando ~84 velas. Para el
      // pedido normal (interval === '15m', el timeframe base) se mantiene days=1 (válido, 30 min,
      // ~48 velas), que ya alcanzaba de sobra el mínimo de 20 que pide SMCEngine.analyze.
      const days = (interval === '1h') ? '14' : '1';
      const url = `${CONFIG.ENDPOINTS.COINGECKO}/coins/${id}/ohlc?vs_currency=usd&days=${days}`;
      const res = await fetchWithTimeout(url, CONFIG.REQUEST_TIMEOUT, { headers }, 'coingecko');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data) || !data.length) throw new Error('Sin datos históricos de CoinGecko');
      const result = new OHLCVData(data.slice(-limit).map(([t, o, h, l, c]) => ({
        time: t, open: o, high: h, low: l, close: c, volume: 0
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
      const usage = RequestTracker.getUsage(providerName);
      if (usage.limit && usage.used >= usage.limit) return false; // cupo diario ya agotado, no tiene sentido intentar
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
      if (usage.limit && usage.used >= usage.limit) return false; // cupo diario ya agotado, no tiene sentido intentar
      return true;
    });

    if (eligible.length > 0) {
      const readyProviders = eligible.filter(p => !isProviderInCooldown(p));
      const providersToTry = readyProviders.length > 0 ? readyProviders : eligible;

      for (const providerName of providersToTry) {
        try {
          const data = await ProviderAdapters[providerName].fetchOHLCV(symbol, tf, limit);
          if (!data.isValid) throw new Error('Datos insuficientes');
          // DIAGNÓSTICO (Punto D, sesión 12/8): antes, un fetch exitoso no dejaba ningún
          // rastro en el log — solo se veían los FALLO. Eso hacía imposible saber qué
          // proveedor entregó las velas cuando detectSupplyDemand se quejaba de HTF
          // insuficiente (ej. "48 velas, se necesitan >=50"), porque no había forma de ver
          // si ese proveedor devolvió de por sí menos velas de las pedidas en `limit`.
          // Esta línea es solo instrumentación (no cambia ningún comportamiento): loguea
          // proveedor + symbol + timeframe + velas pedidas vs. recibidas, únicamente
          // cuando hay diferencia entre lo pedido y lo recibido.
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

  // CORREGIDO: antes era promedio simple de las últimas `period` True Range.
  // Ahora es Wilder/RMA real (igual a TradingView/MT4/MT5): semilla = promedio
  // simple de los primeros `period` TR, y de ahí en adelante suavizado
  // exponencial atr = (atr*(period-1) + TR) / period. Mismo cambio aplicado
  // en custom-strategies.js para que las 7 estrategias independientes y el
  // motor SMC calculen el mismo ATR.
  static calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high, low = candles[i].low, prevClose = candles[i - 1].close;
      trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    if (trueRanges.length < period) return null;
    let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trueRanges.length; i++) {
      atr = (atr * (period - 1) + trueRanges[i]) / period;
    }
    return atr;
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
    // CryptoCompare no es opción acá: CoinDesk discontinuó su nivel gratis en mayo 2026.
    // CoinGecko (el nuevo respaldo en vivo) tampoco sirve para esto: su /ohlc gratuito no
    // deja pedir cientos de velas con el detalle que necesita el backtest.
    return this.fetchCandlesTwelveData(symbol, interval);
  },

  // FIX: se agrega &timezone=UTC, mismo motivo que en ProviderAdapters.twelveData.fetchOHLCV
  // — sin este parámetro, `datetime` viene en hora local de la plaza (NY para XAUUSD) sin
  // sufijo `Z`, y `new Date(v.datetime)` en un proceso en UTC lo interpreta mal, corriendo
  // cada vela del backtest varias horas.
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
        // rMultiple exacto, no aproximado: tp1 se arma siempre como entry ± risk*2 (arriba),
        // así que una señal ganadora vale matemáticamente 2R y una perdedora -1R, sin
        // excepción — no depende de estimar nada.
        events.push({ index: i, direction: analysis.direction, confidence: analysis.confidence, strategyKeys: analysis.strategyKeys, regime: analysis.regime, result, rMultiple: result === 'win' ? 2 : -1 });
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

  // Igual que simulate(), pero para las 7 estrategias independientes de custom-strategies.js
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
          // A diferencia de SMC (siempre 2R fijo), acá el RR sí cambia entre estrategias
          // (algunas usan 1:2, otras 1:3, otras niveles variables de SL/TP) — con
          // entry/sl/tp1 ya disponibles en este mismo loop, se calcula el R real de la
          // señal en vez de asumir un valor fijo.
          const risk = Math.abs(entry - sl);
          const reward = Math.abs(tp1 - entry);
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
      // e.rMultiple ya viene calculado en simulateCustom (real, no aproximado); por las dudas
      // se cae al mismo criterio de siempre (2R win / -1R loss) si algún evento no lo trae.
      stats[e.strategy].totalR += (e.rMultiple != null ? e.rMultiple : (e.result === 'win' ? 2 : -1));
    });
    Object.keys(stats).forEach(key => {
      const s = stats[key];
      const total = s.wins + s.losses;
      s.sampleSize = total;
      s.winRate = total ? s.wins / total : 0;
      s.totalR = +s.totalR.toFixed(2);
    });
    return stats;
  },

  async runSymbol(symbol) {
    const asset = ASSETS[symbol];
    let allEvents = [];
    let allCustomEvents = [];
    let candlesAnalyzed = 0;
    for (const tf of CONFIG.BACKTEST.TIMEFRAMES) {
      // FIX (cuota diaria agotada, complemento al fix de 429 en cascada de más abajo):
      // el path en vivo (MarketDataProvider.getQuote/getOHLCV) ya chequea
      // RequestTracker.getUsage antes de intentar un proveedor con cupo diario agotado
      // y salta directo al siguiente — el backtest no tenía ese mismo chequeo y siempre
      // disparaba al menos 1 pedido real a Twelve Data aunque el contador propio ya
      // supiera que la cuota del día estaba en 0 (confirmado con el dashboard real de
      // Twelve Data: 825/800 créditos usados). No es un problema grave por sí solo — el
      // fix de cooldown de abajo ya corta el resto de la corrida con ese único 429 — pero
      // es cupo gastado sin ninguna chance de éxito, evitable de antemano igual que en
      // vivo. Se usa el mismo criterio (usage.limit && usage.used >= usage.limit) que
      // MarketDataProvider, sin duplicar la lógica de PROVIDER_DAILY_LIMITS.
      const twelveDataUsage = RequestTracker.getUsage('twelveData');
      if (twelveDataUsage.limit && twelveDataUsage.used >= twelveDataUsage.limit) {
        console.warn(`Backtest: cupo diario de twelveData agotado (${twelveDataUsage.used}/${twelveDataUsage.limit}), se corta ${symbol} en ${tf} (y los timeframes/símbolos restantes de esta corrida)`);
        break;
      }
      // FIX (429 en cascada): antes, un 429 de Twelve Data en el primer pedido de la
      // corrida no frenaba nada — se seguían mandando los pedidos restantes (hasta 8 por
      // corrida completa: 4 símbolos x 2 timeframes) exactamente igual, cada 6s, todos
      // condenados a fallar por el mismo motivo: Twelve Data resetea su cupo de 8
      // créditos/minuto recién al minuto calendario siguiente, no de forma progresiva.
      // Ahora, si twelveData ya quedó en cooldown (por un 429 de este mismo run, o por el
      // refresco en vivo que también usa Twelve Data y corre en paralelo), se corta acá:
      // ni este timeframe ni los que faltan van a conseguir datos hasta que se levante el
      // cooldown, así que seguir intentando solo gasta cupo diario en pedidos sin chance.
      if (isProviderInCooldown('twelveData')) {
        console.warn(`Backtest: twelveData en cooldown, se corta ${symbol} en ${tf} (y los timeframes/símbolos restantes de esta corrida)`);
        break;
      }
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
        // FIX: antes este catch no aplicaba ningún cooldown — fetchCandlesTwelveData no
        // pasaba por el mismo mecanismo que ya usa el path en vivo (MarketDataProvider).
        // markProviderCooldown ya sabe interpretar "HTTP 429" (10 min de cooldown); para
        // cualquier otro tipo de error (ej. timeout puntual) getProviderCooldownMs
        // devuelve null y esta llamada no hace nada.
        markProviderCooldown('twelveData', e.message);
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
    // Igual que en aggregateCustomStats: rMultiple ya viene exacto desde simulate() (2R/-1R
    // por construcción de SMC), se suma directo en vez de volver a asumirlo acá.
    const totalR = +allEvents.reduce((sum, e) => sum + (e.rMultiple != null ? e.rMultiple : (e.result === 'win' ? 2 : -1)), 0).toFixed(2);
    const regimeCalibration = {};
    ['trending', 'ranging'].forEach(regime => {
      const regimeEvents = allEvents.filter(e => e.regime === regime);
      if (!regimeEvents.length) return;
      const r = this.calibrateThreshold(regimeEvents);
      if (r.stats) regimeCalibration[regime] = { threshold: r.threshold, sampleSize: regimeEvents.length, winRate: r.stats.winRate };
    });
    return {
      symbol, candlesAnalyzed,
      totalSignals: allEvents.length, winRate: allEvents.length ? wins / allEvents.length : 0, totalR,
      calibratedThreshold: threshold, calibratedStats: stats, regimeCalibration, patternStats,
      customStats
    };
  },

  async runAll(force = false) {
    if (state.backtestRunning) return;
    const cfg = CONFIG.BACKTEST;
    const lastRun = parseInt(localStorage.getItem('pt_backtest_last_run') || '0', 10);
    // FIX: además del chequeo de 24hs sobre la última corrida EXITOSA (lastRun, sin
    // cambios), se agrega un segundo chequeo sobre el último INTENTO (haya tenido éxito o
    // no). Antes, si el backtest fallaba entero (0 resultados por 429 de Twelve Data),
    // pt_backtest_last_run nunca se grababa y este gating de arriba nunca frenaba nada —
    // cada redeploy volvía a intentarlo 2 minutos después de arrancar. Ver comentario de
    // RETRY_INTERVAL_MS en CONFIG.BACKTEST para el detalle completo.
    const lastAttempt = parseInt(localStorage.getItem('pt_backtest_last_attempt') || '0', 10);
    if (!force && Date.now() - lastRun < cfg.RERUN_INTERVAL_MS) { renderBacktestStatus(); return; }
    if (!force && Date.now() - lastAttempt < cfg.RETRY_INTERVAL_MS) { renderBacktestStatus(); return; }
    state.backtestRunning = true;
    // Se graba ACÁ (apenas se decide correr, antes de intentar nada) y no al final —
    // así, aunque el proceso se caiga a mitad de la corrida, el próximo arranque igual
    // respeta el RETRY_INTERVAL_MS en vez de reintentar de inmediato.
    localStorage.setItem('pt_backtest_last_attempt', String(Date.now()));
    renderBacktestStatus();
    const results = {};
    try {
      for (const symbol of cfg.SYMBOLS) {
        const r = await this.runSymbol(symbol);
        if (r) results[symbol] = r;
        // FIX: si twelveData quedó en cooldown durante este símbolo, todos los símbolos
        // restantes comparten el mismo proveedor y van a fallar exactamente igual hasta
        // que se levante — cortar acá ahorra cupo diario y tiempo de la corrida en vez de
        // barrer los símbolos que faltan solo para confirmar el mismo fallo de nuevo.
        if (isProviderInCooldown('twelveData')) {
          console.warn('Backtest: twelveData en cooldown, se corta la corrida completa (símbolos restantes sin procesar esta vez)');
          break;
        }
        await sleep(6000); // espacio entre activos, mismo motivo que arriba
      }
      if (Object.keys(results).length) {
        // Alimenta strategyStatsBySymbol con la base del backtest, símbolo por símbolo,
        // antes de que el resto de este bloque combine todo en un solo objeto agregado
        // (combinedPatternStats/combinedCustomStats) donde ya no se puede distinguir
        // el símbolo. Solo escribe si todavía no hay datos para ese símbolo+estrategia
        // (no pisa contadores ya acumulados con señales reales en vivo).
        seedStrategyStatsFromBacktest(results);

        const combinedPatternStats = {};
        Object.values(results).forEach(r => {
          Object.entries(r.patternStats).forEach(([key, s]) => {
            if (!combinedPatternStats[key]) combinedPatternStats[key] = { wins: 0, losses: 0 };
            combinedPatternStats[key].wins += s.wins; combinedPatternStats[key].losses += s.losses;
          });
        });
        state.backtestPatternStats = combinedPatternStats;
        localStorage.setItem('pt_backtest_pattern_stats', JSON.stringify(combinedPatternStats));

        // Igual que arriba pero para las 7 estrategias independientes: se suman gana/pierde
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

// Antes refreshAsset() calculaba las señales de las 7 estrategias independientes
// (resolveCustomSignal) y las notificaba por push, pero nunca las guardaba en ningún
// lado que el panel pudiera leer — quedaban invisibles salvo por la notificación
// puntual. Esto las deja en state.lastCustomDisplay[symbol][strategyKey], expuesto
// luego vía /api/state.customSignals.
function renderCustomSignal(symbol, strategyKey, display) {
  state.lastCustomDisplay = state.lastCustomDisplay || {};
  state.lastCustomDisplay[symbol] = state.lastCustomDisplay[symbol] || {};
  state.lastCustomDisplay[symbol][strategyKey] = display || { type: 'no-signal' };
}
function renderConfidence() {}
function pushSignalHistory(signal) {
  if (signal.type !== 'long' && signal.type !== 'short') return;
  // Antes había acá un chequeo que descartaba la señal si `state.signalHistory[0]`
  // (la ÚLTIMA entrada del historial COMPARTIDO entre las 8 fuentes: SMC + las 7
  // estrategias independientes) coincidía en símbolo+dirección y seguía "pending".
  // El problema: no distinguía de qué estrategia venía. Si, por ejemplo, ETHUSD LONG
  // de SMC quedaba pendiente como última entrada y después una estrategia independiente
  // (Bollinger Squeeze, Kill Zone NY, etc.) disparaba también ETHUSD LONG, esa señal
  // nueva se descartaba del historial — aunque notifyNewSignal() ya hubiera mandado la
  // notificación push. Resultado: llegaban avisos que después no aparecían en el panel.
  // No hace falta ningún dedup acá: resolveActiveSignal()/resolveCustomSignal() ya
  // garantizan que esta función solo se llama cuando isNewDirection && !inCooldown para
  // ESA fuente puntual (state.activeSignals / state.activeCustomSignals + cooldown por
  // symbol+estrategia), así que cualquier chequeo adicional acá es redundante y, como
  // se vio, termina bloqueando señales legítimas de otras estrategias.
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

// `entry.source` ya es exactamente la granularidad que se quiere: 'smc' para las
// señales de Smart Money Concepts (pushSignalHistory pone 'smc' por default cuando
// no viene otro source) y la key de la estrategia (ny_open_kill_zone, bollinger_squeeze,
// etc.) para las 7 independientes (resolveCustomSignal pone source: customSig.strategy).
function updateStrategyStatsBySymbol(entry) {
  if (entry.result !== 'win' && entry.result !== 'loss') return;
  const symbol = entry.symbol, key = entry.source || 'smc';
  if (!symbol || !key) return;
  state.strategyStatsBySymbol[symbol] = state.strategyStatsBySymbol[symbol] || {};
  if (!state.strategyStatsBySymbol[symbol][key]) state.strategyStatsBySymbol[symbol][key] = { wins: 0, losses: 0, totalR: 0 };
  const stats = state.strategyStatsBySymbol[symbol][key];
  if (entry.result === 'win') stats.wins++;
  else stats.losses++;
  // entry.rMultiple ya viene calculado en checkHistoryOutcomes: el R real de la señal
  // (tp1Pips/slPips) en victorias, -1 en pérdidas. Si no vino seteado, se cae al mismo
  // criterio de siempre (2R win / -1R loss) que ya usa runAutoTuneForKey más abajo.
  const r = entry.rMultiple != null ? entry.rMultiple : (entry.result === 'win' ? 2 : -1);
  stats.totalR = +((stats.totalR || 0) + r).toFixed(2);
  localStorage.setItem('pt_strategy_stats_by_symbol', JSON.stringify(state.strategyStatsBySymbol));
}

// Se corre una sola vez, la primera vez que arranca el servidor con esta feature
// (strategyStatsBySymbol vacío): toma los resultados ya calculados por símbolo (incluye
// wins/losses y totalR, el R-multiple acumulado) en el
// backtest más reciente (runAll ya los tiene en `results` antes de combinarlos, ver
// abajo) para no arrancar el contador de señales en vivo desde cero — el backtest corre
// sobre 1000 velas x 2 timeframes por símbolo, así que da una base estadística que en
// vivo tardaría meses en juntarse sola (Kill Zone NY, por ejemplo, dispara como mucho
// una vez por día hábil).
function seedStrategyStatsFromBacktest(resultsBySymbol) {
  Object.entries(resultsBySymbol).forEach(([symbol, r]) => {
    state.strategyStatsBySymbol[symbol] = state.strategyStatsBySymbol[symbol] || {};
    // SMC: r.winRate / r.totalSignals ya son el agregado del símbolo completo (los 8
    // subtipos de patrón de SMC juntos), que es el nivel al que el usuario piensa "SMC"
    // como una sola de las 8 estrategias.
    if (r.totalSignals && !state.strategyStatsBySymbol[symbol].smc) {
      const wins = Math.round(r.winRate * r.totalSignals);
      const losses = r.totalSignals - wins;
      // r.totalR ya viene exacto desde runSymbol (2R/-1R por construcción de SMC); si por
      // algún motivo faltara (backtest viejo persistido antes de este cambio), se aproxima
      // igual que en el resto del archivo.
      const totalR = r.totalR != null ? r.totalR : (wins * 2 - losses);
      state.strategyStatsBySymbol[symbol].smc = { wins, losses, totalR, seeded: true };
    }
    Object.entries(r.customStats || {}).forEach(([key, s]) => {
      if (!state.strategyStatsBySymbol[symbol][key]) {
        const totalR = s.totalR != null ? s.totalR : (s.wins * 2 - s.losses);
        state.strategyStatsBySymbol[symbol][key] = { wins: s.wins, losses: s.losses, totalR, seeded: true };
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
    // FIX (TP1 vs TP2 — resultado y R grabados no coincidían con el cierre real de la
    // señal en vivo): esta función solo comparaba contra `tp1`, así que en cuanto el
    // precio tocaba TP1 la entrada quedaba 'win' con rMultiple = tp1Pips/slPips — para
    // las estrategias que definen tp2 (Pivots Breakout & Reversal, EMA Cross Scalping,
    // RSI Divergence, Bollinger Squeeze), eso contradecía a evaluateCustomSignalOutcome()
    // (la que maneja el badge en vivo), que SÍ espera a tp2 antes de cerrar la señal
    // activa. El winrate grabado en closed_signals no cambia (tocar TP1 ya es ganar),
    // pero el R quedaba subestimado cada vez que el precio seguía hasta TP2 — y
    // runAutoTuneForKey() usa ese R (expectancy) para ajustar el umbral de confianza de
    // cada estrategia, así que venía decidiendo con una expectativa más baja que la real.
    // Ahora, si la señal define tp2, se espera a tp2 (o SL) para cerrar, igual que en
    // vivo; si no define tp2, se cierra en tp1 como antes.
    const hasTP2 = h.tp2 !== undefined && h.tp2 !== null;
    const rTP1 = (h.tp1Pips && h.slPips) ? +(h.tp1Pips / h.slPips).toFixed(2) : 2;
    const rTP2 = (hasTP2 && h.tp2Pips && h.slPips) ? +(h.tp2Pips / h.slPips).toFixed(2) : null;
    let outcome = null;
    let rHit = rTP1;
    const relevantCandles = (candles || []).filter(c => c.time >= h.timestamp);
    if (relevantCandles.length) {
      for (const c of relevantCandles) {
        const hitSL = isLong ? c.low <= h.sl : c.high >= h.sl;
        const hitTP1 = isLong ? c.high >= h.tp1 : c.low <= h.tp1;
        const hitTP2 = hasTP2 && (isLong ? c.high >= h.tp2 : c.low <= h.tp2);
        // SL corta la operación apenas se toca, tenga o no tp2 definido (misma
        // prioridad que ya usaba el código original).
        if (hitSL) { outcome = 'loss'; rHit = -1; break; }
        if (hasTP2) {
          if (hitTP2) { outcome = 'win'; rHit = rTP2; break; }
          // TP1 tocado pero tp2 sigue pendiente: no cierra todavía, se sigue vigilando
          // en las velas siguientes (sin `break`), igual que en vivo.
        } else if (hitTP1) {
          outcome = 'win'; rHit = rTP1; break;
        }
      }
    }
    // FIX previo (se mantiene): antes este chequeo contra currentPrice solo corría en el
    // `else` (cuando relevantCandles.length === 0), caso que casi nunca se da — con solo
    // que UNA vela reciente exista en el fetch (siempre hay alguna), el filtro por
    // timestamp entraba ahí y el fallback nunca se ejecutaba para señales viejas. Ahora
    // corre siempre que el loop de velas no resolvió nada, así una señal cuyo cruce de
    // SL/TP quedó fuera de la ventana de ~100 velas fetcheadas igual se resuelve si el
    // precio ACTUAL ya está más allá del nivel correspondiente (tp2 si hay, si no tp1).
    if (!outcome) {
      if (hasTP2) {
        if (isLong && currentPrice >= h.tp2) { outcome = 'win'; rHit = rTP2; }
        else if (!isLong && currentPrice <= h.tp2) { outcome = 'win'; rHit = rTP2; }
        else if (isLong && currentPrice <= h.sl) { outcome = 'loss'; rHit = -1; }
        else if (!isLong && currentPrice >= h.sl) { outcome = 'loss'; rHit = -1; }
      } else {
        if (isLong && currentPrice >= h.tp1) { outcome = 'win'; rHit = rTP1; }
        else if (isLong && currentPrice <= h.sl) { outcome = 'loss'; rHit = -1; }
        else if (!isLong && currentPrice <= h.tp1) { outcome = 'win'; rHit = rTP1; }
        else if (!isLong && currentPrice >= h.sl) { outcome = 'loss'; rHit = -1; }
      }
    }
    // Si sigue sin resolverse y ya pasó la ventana máxima (ver CONFIG.SIGNAL_EXPIRATION_MS),
    // el precio nunca volvió a cruzar SL/TP dentro de lo que podemos observar — no queda
    // 'pending' indefinidamente (aparecía como señales "en curso" de días atrás, sin sentido
    // operativo). Se marca 'expired': no cuenta como win/loss en stats (ver
    // updateStrategyStatsBySymbol/updatePatternStats, que solo suman win/loss).
    const expirationMs = (CONFIG.SIGNAL_EXPIRATION_MS_BY_STRATEGY && CONFIG.SIGNAL_EXPIRATION_MS_BY_STRATEGY[h.source]) || CONFIG.SIGNAL_EXPIRATION_MS;
    if (!outcome && (Date.now() - h.timestamp) > expirationMs) {
      outcome = 'expired'; rHit = 0;
    }
    if (outcome) {
      h.result = outcome; h.rMultiple = rHit; changed = true; resolvedEntries.push(h);
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

// ---------------------------------------------------------
// Historial navegable por día/semana/mes (solo lectura para el panel — no
// interviene en la lógica de trading ni en auto-tune, se agrega al costado).
// ---------------------------------------------------------
// pt_v4_signals (state.signalHistory) está recortado a CONFIG.HISTORY_LIMIT (50)
// entradas TOTALES entre las 8 estrategias — insuficiente para navegar semanas o
// meses. Acá se guarda cada señal ya resuelta (win/loss, no 'expired') en un key
// aparte POR DÍA (closed_signals:YYYY-MM-DD), sin límite de cantidad, así día/semana/
// mes se pueden reconstruir sin depender del recorte de 50. Arranca vacío desde el
// momento en que se despliega este cambio — decisión explícita del usuario, no se
// reconstruye retroactivo desde pt_v4_signals.
function appendClosedSignal(entry) {
  if (entry.result !== 'win' && entry.result !== 'loss') return; // igual que updatePatternStats/updateStrategyStatsBySymbol
  const dayKey = localDayKey(entry.timestamp);
  const storageKey = `closed_signals:${dayKey}`;
  let dayList;
  try { dayList = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch (e) { dayList = []; }
  dayList.push({
    symbol: entry.symbol, type: entry.type, source: entry.source || 'smc',
    result: entry.result, rMultiple: entry.rMultiple, timestamp: entry.timestamp
  });
  localStorage.setItem(storageKey, JSON.stringify(dayList));
  // Índice de qué días tienen datos — sin esto, el panel no tiene forma de saber
  // qué fechas mostrar en la lista cronológica sin adivinar o barrer keys a ciegas.
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
  const confPart = (signal.confidence !== null && signal.confidence !== undefined) ? ` · Confianza ${signal.confidence}%` : '';
  const body = `Entrada ${fmt(signal.entry, signal.decimals)} · SL ${fmt(signal.sl, signal.decimals)} · TP1 ${fmt(signal.tp1, signal.decimals)}${confPart}`;
  sendPushToAll({ title, body, symbol: signal.symbol, signal }).catch(err => console.error('Error enviando push:', err.message));
}

function toggleSound() {}
function toggleStrictMode() { state.strictMode = !state.strictMode; }

function resolveActiveSignal(symbol, quote, analysis) {
  if (!analysis.valid) { delete state.activeSignals[symbol]; return { type: 'no-data', reason: analysis.reason }; }
  if (!analysis.direction) { delete state.activeSignals[symbol]; return { type: 'no-signal', analysis, checkedAt: Date.now() }; }
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
    // Mismo fix que activeCustomSignals: persistir de inmediato para que un reinicio
    // no "olvide" que esta señal SMC ya estaba activa y la duplique en el historial.
    try { localStorage.setItem('pt_active_signals', JSON.stringify(state.activeSignals)); } catch (e) {}
    try { localStorage.setItem('pt_last_signal_at', JSON.stringify(state.lastSignalAt)); } catch (e) {}
    pushSignalHistory(frozen);
    notifyNewSignal(frozen);
  }
  if (!state.activeSignals[symbol]) return { type: 'no-signal', analysis, cooldownMinutesLeft: inCooldown ? Math.ceil(cooldownRemainingMs / 60000) : null, checkedAt: Date.now() };
  const frozen = state.activeSignals[symbol];
  const isLong = frozen.type === 'long';
  const hitTP = isLong ? quote.last >= frozen.tp1 : quote.last <= frozen.tp1;
  const hitSL = isLong ? quote.last <= frozen.sl : quote.last >= frozen.sl;
  // FIX (badge TP2 distinto, mismo pedido que en las señales custom): SMC ya se
  // autolimpia cada ciclo (no tenía el bug de congelamiento), pero seguía sin distinguir
  // TP2 de TP1 en el resultado — si el precio saltó directo a TP2 antes del próximo
  // refresco, igual se mostraba "TP1 alcanzado". Con este campo, el front-end puede
  // mostrar el badge correcto en el único ciclo en que esta señal queda expuesta.
  const hitTP2 = frozen.tp2 != null && (isLong ? quote.last >= frozen.tp2 : quote.last <= frozen.tp2);
  const result = { type: frozen.type, frozen, currentPrice: quote.last, hitTP, hitTP1: hitTP, hitTP2, hitSL, isNewDirection: isNewDirection && !inCooldown };
  if (hitTP || hitSL) {
    delete state.activeSignals[symbol];
    try { localStorage.setItem('pt_active_signals', JSON.stringify(state.activeSignals)); } catch (e) {}
  }
  return result;
}

// ---------------------------------------------------------
// Resolución de señales de las 7 estrategias independientes
// (Kill Zone NY, Pivots Breakout & Reversal, Price Action+RSI+EMA,
// Supply and Demand, EMA Cross Scalping, Divergencia RSI, Bollinger Squeeze)
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
    // Antes: `customSig.tp2 || customSig.tp1` — si la estrategia no definía TP2, se
    // mostraba el mismo valor que TP1 como si fueran dos niveles reales (confuso en el
    // panel). Ahora se deja `null` cuando no hay un TP2 real, y `fmt()`/`toPips()` en el
    // front-end ya saben mostrar "--" para null.
    const tp2 = (customSig.tp2 !== undefined && customSig.tp2 !== null) ? customSig.tp2 : null;
    const slPips = toPips(sl, entry, asset);
    const tp1Pips = toPips(tp1, entry, asset);
    const tp2Pips = toPips(tp2, entry, asset);
    // Antes: `rr1: '1:2'` y `rr2: '1:3'` fijos, sin importar la estrategia. Eso era
    // correcto para Pivots, EMA Cross, RSI Divergence y Bollinger (que sí usan esos
    // ratios exactos), pero mentía en Kill Zone NY (real: 1:1.5 y 1:2, no 1:2 y 1:3) y
    // en Price Action / Supply&Demand, donde TP1/TP2 son niveles estructurales
    // (próxima zona S/R u oferta/demanda opuesta), no un múltiplo fijo del riesgo —
    // ahí el RR real puede ser cualquier valor (2.3, 3.8, lo que sea). Ahora se calcula
    // el RR real a partir de entry/sl/tp en cada caso.
    const risk = Math.abs(entry - sl);
    const formatRR = tp => {
      if (tp === null || !risk) return null;
      const reward = Math.abs(tp - entry);
      const ratio = reward / risk;
      return `1:${ratio % 1 === 0 ? ratio.toFixed(0) : ratio.toFixed(1)}`;
    };
    const frozen = {
      type: customSig.direction, symbol, asset, entry, sl, tp1, tp2, slPips, tp1Pips, tp2Pips,
      // Antes: `confidence: 100` fijo. Estas estrategias no calculan un score de
      // confianza real (a diferencia de SMCEngine) — poner 100 fijo mentía sobre una
      // certeza que nunca se calculó. Se deja `null`: el panel y el historial ahora
      // muestran "estrategia independiente, sin score" en vez de un 100% falso.
      rr1: formatRR(tp1), rr2: formatRR(tp2), confidence: null,
      strategyLabels: [customSig.label], strategyKeys: [customSig.strategy],
      details: customSig.details, source: customSig.strategy, regime: 'n/a',
      timestamp: Date.now(), decimals: asset.decimals, detectedAt: Date.now(),
      // FIX (badge TP2 distinto): recuerda si TP1 ya se tocó en un ciclo anterior, para
      // no "deshacerlo" si el precio retrocede por debajo de TP1 antes de llegar a TP2.
      tp1HitAt: null
    };
    state.activeCustomSignals[key] = frozen;
    state.lastCustomSignalAt[key] = frozen.detectedAt;
    // Persistir de inmediato — así si el proceso se reinicia un segundo después de
    // detectar la señal, el próximo arranque sabe que ya está activa y no la duplica.
    try { localStorage.setItem('pt_active_custom_signals', JSON.stringify(state.activeCustomSignals)); } catch (e) {}
    try { localStorage.setItem('pt_last_custom_signal_at', JSON.stringify(state.lastCustomSignalAt)); } catch (e) {}
    pushSignalHistory(frozen);
    notifyNewSignal(frozen);
  }

  const frozen = state.activeCustomSignals[key];
  if (!frozen) return null;
  return evaluateCustomSignalOutcome(symbol, key, quote, frozen);
}

// FIX (bug: señales custom visibles en el feed mucho tiempo después de tocar SL/TP,
// con precio y flecha congelados — más el pedido de un badge "TP2 alcanzado" distinto):
//
// Antes, resolveCustomSignal() y refreshActiveCustomSignalsDisplay() repetían el mismo
// chequeo de hitTP/hitSL cada una por su lado, comparando solo contra tp1, y en cuanto
// se resolvía la señal la borraban de state.activeCustomSignals. El problema: una vez
// borrada de ahí, refreshActiveCustomSignalsDisplay() (que recorre justamente
// activeCustomSignals) dejaba de tocarla — así que renderCustomSignal() nunca se volvía
// a llamar para esa estrategia+activo, y state.lastCustomDisplay quedaba congelado con
// el último estado (badge, precio, flecha) para siempre, hasta la próxima señal nueva.
// SMC no tenía este problema porque renderSignal() se llama en cada ciclo sin importar
// el resultado — acá, en cambio, solo se llamaba mientras la señal seguía "activa".
//
// Fix en dos partes:
//  1. evaluateCustomSignalOutcome() ahora también compara contra tp2 (si la estrategia
//     define uno). Si toca TP1 pero hay TP2 sin tocar todavía, la señal sigue activa
//     (se ve el badge "TP1 alcanzado" pero se sigue vigilando) — recién se cierra al
//     tocar TP2, tocar SL, o tocar TP1 cuando no hay TP2 definido.
//  2. Al cerrarse una señal, además de borrarla de activeCustomSignals, se marca su key
//     en state.pendingCustomDisplayReset. En el PRÓXIMO ciclo (arranque de
//     refreshActiveCustomSignalsDisplay para ese símbolo), esa marca se usa para
//     resetear el display a "no-signal" — así el badge resuelto se ve durante un ciclo
//     completo (igual que en SMC) y después se limpia solo, en vez de quedar pegado.
function evaluateCustomSignalOutcome(symbol, key, quote, frozen) {
  const isLong = frozen.type === 'long';
  const hitSL = isLong ? quote.last <= frozen.sl : quote.last >= frozen.sl;
  const hitTP1Now = isLong ? quote.last >= frozen.tp1 : quote.last <= frozen.tp1;
  const hitTP2 = frozen.tp2 != null && (isLong ? quote.last >= frozen.tp2 : quote.last <= frozen.tp2);

  // Una vez tocado TP1, se recuerda (frozen.tp1HitAt) para no "deshacerlo" si el precio
  // retrocede por debajo de TP1 mientras se espera a TP2.
  if (hitTP1Now && !frozen.tp1HitAt) frozen.tp1HitAt = Date.now();
  const hitTP1 = hitTP1Now || !!frozen.tp1HitAt;

  // FIX (expiración corta de scalping no se aplicaba acá): CONFIG.SIGNAL_EXPIRATION_MS_BY_STRATEGY
  // (4hs para ema_cross_scalping/ny_open_kill_zone) se había agregado únicamente en
  // checkHistoryOutcomes(), que resuelve `state.signalHistory` — una estructura capada a
  // 50 entradas COMPARTIDAS entre las 4 símbolos y las 8 estrategias, usada para el
  // historial persistido y las estadísticas. Pero el display "en vivo" que ves en el
  // panel (y que decide si una estrategia puede volver a disparar) lee de
  // `state.activeCustomSignals`, una estructura APARTE que solo esta función
  // (evaluateCustomSignalOutcome) limpia — y nunca chequeaba antigüedad, solo SL/TP2/TP1.
  // Resultado confirmado con evidencia real: señales de EMA Cross Scalping en BTCUSD/ETHUSD
  // (mercado 24/7, sin excusa de fin de semana) seguían "activas" a las 8-12hs, muy por
  // encima del límite de 4hs, porque esta función nunca se enteraba de esa regla. Ahora
  // expira acá también, con el mismo criterio (umbral por `frozen.source`, cae al general
  // si no hay uno específico).
  const expirationMs = (CONFIG.SIGNAL_EXPIRATION_MS_BY_STRATEGY && CONFIG.SIGNAL_EXPIRATION_MS_BY_STRATEGY[frozen.source]) || CONFIG.SIGNAL_EXPIRATION_MS;
  const isExpired = !hitSL && !hitTP2 && !(hitTP1 && frozen.tp2 == null) && (Date.now() - frozen.timestamp) > expirationMs;

  const shouldClose = hitSL || hitTP2 || (hitTP1 && frozen.tp2 == null) || isExpired;
  if (shouldClose) {
    delete state.activeCustomSignals[key];
    try { localStorage.setItem('pt_active_custom_signals', JSON.stringify(state.activeCustomSignals)); } catch (e) {}
    state.pendingCustomDisplayReset = state.pendingCustomDisplayReset || {};
    state.pendingCustomDisplayReset[key] = true;
  }

  return { type: frozen.type, frozen, currentPrice: quote.last, hitTP: hitTP1, hitTP1, hitTP2, hitSL };
}

// Las estrategias independientes solo aparecen en el resultado de evaluateAll() en la
// vela exacta donde disparan (son patrones puntuales, no condiciones que se mantienen
// vela a vela). Sin esto, una señal activa dejaba de refrescarse (TP/SL, precio actual)
// en cuanto pasaba esa vela, y el panel quedaba mostrando un estado viejo hasta la
// próxima vez que la misma estrategia volviera a disparar. Esto revisa, en cada ciclo,
// todas las señales custom ya activas para el símbolo aunque evaluateAll no las haya
// devuelto esta vez.
function refreshActiveCustomSignalsDisplay(symbol, quote, skipStrategies = new Set()) {
  // Limpieza (ver evaluateCustomSignalOutcome): cualquier señal de este símbolo que se
  // haya cerrado en el ciclo ANTERIOR ya se mostró resuelta un ciclo completo — ahora se
  // resetea su display a "no-signal" para que no quede congelada para siempre.
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
    if (skipStrategies.has(frozen.strategyKeys[0])) return; // ya se renderizó arriba, en este mismo ciclo
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
      const firedThisCycle = new Set();
      customSignals.forEach(sig => {
        const customDisplay = resolveCustomSignal(symbol, quote, sig, asset);
        renderCustomSignal(symbol, sig.strategy, customDisplay);
        firedThisCycle.add(sig.strategy);
        if (customDisplay) {
          addLog(quote.source, `[${sig.label}] señal ${sig.direction === 'long' ? 'LONG' : 'SHORT'} independiente`, symbol);
        }
      });
      // Refresca (TP/SL, precio actual) las señales custom que ya estaban activas de
      // ciclos anteriores y que esta vuelta no volvieron a dispararse.
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
