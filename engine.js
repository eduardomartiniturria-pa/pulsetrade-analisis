// ============================================================
// PULSE TRADE v4.8.1 - MOTOR DE SEÑALES PROFESIONAL
// ============================================================
// Cambios v4.8.1 (20/9, ETAPA 0 de la auditoría — SOLO instrumentación, SIN cambios de lógica):
// Ninguna señal, compuerta, umbral ni cálculo cambia. Se agrega state.diagnostics (expuesto en
// /api/state -> diagnostics) para confirmar con datos reales, sin depender de logs de Render:
//  (a) candleAge[symbol]: antigüedad de la última vela del TF base en cada ciclo y si está
//      "en formación" (edad < timeframe). Confirma o descarta la hipótesis C2 (la última vela
//      llega abierta y se evalúa como cerrada). Incluye contadores acumulados desde el arranque.
//  (b) quote[symbol]: proveedor, bid, ask, spread y si es estimado. costGate[symbol]: última
//      evaluación real de la compuerta de costo (spread usado, stop, % del stop). Confirma C4.
//  (c) providerUsage: cupo diario efectivo y uso del día por proveedor (TWELVEDATA_DAILY_LIMIT
//      leído del entorno). Confirma A8.
// ============================================================
// ============================================================
// PULSE TRADE v4.8.0 - MOTOR DE SEÑALES PROFESIONAL
// ============================================================
// Cambios v4.8.0 (20/9, "ordenar": activos XAUUSD/EURUSD/US500/GBPUSD, sin crypto):
// - ASSETS: se sacan BTCUSD/ETHUSD; se agregan US500 (Twelve Data 'SPX', requiere plan
//   Grow) y GBPUSD. Se retiran del código los adapters okx/binance/coingecko y el chequeo
//   rápido de precio crypto. BACKTEST.SYMBOLS, spreads estimados, buffers de TP y
//   DISABLED_STRATEGIES_BY_SYMBOL alineados a los 4 activos.
// - HORARIOS POR INSTRUMENTO (getMarketStatus): cierre semanal, pausa diaria, feriados y
//   DST de Exness por perfil (forex/oro/índice). Cerrado => sin pedidos de datos. Tramos de
//   bloqueo (15 min antes de una pausa, 30 después de reabrir, rollover forex) y feed sin
//   velas nuevas => se sigue trackeando SL/TP pero NO se emiten señales nuevas. Estado
//   por activo expuesto en /api/state (marketStatus). US500: horario ESTIMADO, verificar.
// - MODO SOMBRA (CONFIG.SHADOW_MODE) para US500 y GBPUSD: sin muestra LIVE suficiente se
//   registran sin push, con riskWeight 0 y fuera del Daily Risk Guard. Rompe el círculo
//   "sin muestra no opera / sin operar no hay muestra" del Motor de Rentabilidad V1.
// - Estrategias: whitelist = kill_zone_ny, supply_demand, session_breakout_vwap. Las dos
//   de crypto quedan apagadas (flags sincronizados, ver assertStrategyFlagsSync).
// - FIX AlphaVantage: todo símbolo que no fuera EURUSD se mapeaba a 'XAU' (GBPUSD habría
//   traído el precio del oro). Ahora la divisa sale del símbolo.
// - Un error de "símbolo no incluido en tu plan" bloquea solo proveedor+símbolo (6h), no
//   el proveedor entero (ver markProviderCooldown).
// - Twelve Data: límite diario configurable (TWELVEDATA_DAILY_LIMIT=none tras plan Grow).
// - News: GBPUSD suma noticias de GBP al score contextual (NEWS_CURRENCIES_BY_SYMBOL).
// - retireRemovedSymbols(): operaciones 'pending' de BTC/ETH pasan a 'expired' (0R, sin
//   impacto en estadísticas) para no quedar "en curso" para siempre.
// ============================================================
// ============================================================
// PULSE TRADE v4.7.9 - MOTOR DE SEÑALES PROFESIONAL
// ============================================================
// Cambios v4.7.9 (18/9, auditoría completa a pedido de Soy — "revisa todo completo"):
// - Circuit breaker AGREGADO (state.autoDisabledStrategiesAggregate): bug confirmado
//   y ya anotado el 28/8, seguía sin corregir. Al arrancar el proceso solo se
//   reaplicaban las desactivaciones automáticas INDIVIDUALES sobre
//   CONFIG.DISABLED_STRATEGIES_BY_SYMBOL, nunca las agregadas — así que tras
//   cualquier redeploy de Render (CONFIG vuelve a sus valores fijos), una estrategia
//   apagada por el breaker agregado volvía a operar en los 4 símbolos sin aviso,
//   mientras /api/state seguía mostrando la desactivación como vigente. Corregido en
//   dos puntos: el bloque de reaplicación al arrancar (ahora también recorre
//   autoDisabledStrategiesAggregate) y applyRetroactiveCircuitBreaker() (ahora también
//   evalúa consecutiveLossesAggregate contra el umbral vigente). Se extrajo
//   disableAggregateByCircuitBreaker() para que la lógica de apagado no esté
//   duplicada entre el disparo en vivo (checkCircuitBreakerAggregate) y el
//   retroactivo — mismo patrón que ya existía para el breaker individual.
// - Ver también custom-strategies.js v4.13 (mismo día): fix de SL sin colchón y sin
//   piso de RR en el Modo B de session_breakout_vwap.
// ============================================================
// PULSE TRADE v4.7.8 - MOTOR DE SEÑALES PROFESIONAL
// ============================================================
// Cambios v4.7.8 (16/9, hallazgo real: "app sin emitir señales desde el 14/9"):
// - CONFIG.CONFIDENCE_THRESHOLD bajado de 70 a 65. Causa raíz confirmada con datos
//   reales de /api/state: el umbral por symbol+estrategia (vigente desde el 11/9)
//   cae a este fallback fijo hasta juntar 10 operaciones reales cerradas bajo su
//   key actual — y ninguna combinación de kill_zone_ny (renombrada el 30/8) llegó
//   nunca a esas 10, porque casi todas sus señales rondan 55-65% de confianza,
//   por debajo del fallback viejo de 70. Sin operaciones reales, nunca se junta
//   la muestra que permitiría a auto-tune bajar el umbral — círculo cerrado. El
//   fallback (70) además era más estricto que AUTO_TUNE.minThreshold (65, el piso
//   más bajo que el propio sistema se permite), una inconsistencia en sí misma.
// ============================================================
// PULSE TRADE v4.7.7 - MOTOR DE SEÑALES PROFESIONAL
// ============================================================
// Cambios v4.7.7 (16/9, plan de rentabilidad — ver respaldo consolidado del mismo día):
// - ENABLED_STRATEGIES: sacadas pivots_breakout_reversal, bollinger_squeeze,
//   ema_cross_scalping — eliminadas del código en custom-strategies.js (no solo
//   desactivadas). Evidencia: -9.75R, -1.85R y -3.27R respectivamente en el período
//   27/8-14/9, sin tesis de mercado real. DISABLED_STRATEGIES_BY_SYMBOL y
//   SIGNAL_EXPIRATION_MS_BY_STRATEGY limpiados de referencias a las 3.
// - CIRCUIT_BREAKER: umbral fijo (3, 14/9) reemplazado por dos niveles según calidad
//   histórica real de cada combinación (getCircuitBreakerThreshold): >=15 operaciones
//   + expectancy positiva -> tolera 5 pérdidas seguidas; cualquier otra combinación
//   -> se apaga a la 2ª. Corrige el efecto colateral confirmado del 14/9 (apagó
//   kill_zone_ny en XAUUSD, la mejor estrategia del sistema, con solo 3 pérdidas).
//   applyRetroactiveCircuitBreaker() y seedStrategyStatsFromBacktest() ahora
//   comparten la lógica de apagado vía disableCombinationByCircuitBreaker().
// - seedStrategyStatsFromBacktest(): fix del bug real encontrado en la auditoría —
//   una combinación seeded con 0 ganadas nunca tocaba consecutiveLosses (caso real:
//   session_false_breakout en EURUSD, 0G/6P, nunca vista por el Circuit Breaker).
//   Ahora, cuando wins===0 y losses>0, la racha es exactamente losses (no hay
//   ganada que la corte) y se evalúa contra el circuit breaker al momento del seed.
// - STRATEGY_RISK_WEIGHT: fix de bug real — tenía la key vieja 'ny_open_kill_zone'
//   en vez de 'kill_zone_ny' (renombrada 30/8), así que el multiplicador 1.5x de la
//   mejor estrategia del sistema nunca se aplicaba desde que se implementó (15/9).
// - NUEVO: modo probation/sombra (CONFIG.PROBATION, CONFIG.PROBATION_STRATEGIES,
//   checkProbationGraduation()) — cualquier estrategia que se agregue de ahora en
//   más y se ponga en PROBATION_STRATEGIES corre sin notificar por push hasta
//   juntar 20 señales resueltas (entre los 4 símbolos) con R neto positivo.
// - session_false_breakout restringida a BTCUSD/ETHUSD en custom-strategies.js (sin
//   cambios acá, ya viene filtrada por symbol desde evaluateAll()).
// Cambios v4.7.6 (11/9, auto-tune por symbol+estrategia):
// - Causa raíz confirmada leyendo el código real: runAutoTune(symbol) calculaba
//   un único umbral de confianza por símbolo, mezclando en una sola expectancy
//   el historial cerrado de TODAS las estrategias de ese símbolo. Caso real
//   detectado con /api/state en producción: ny_open_kill_zone en BTCUSD
//   (+11.17R, la mejor combinación de toda la app) compartía el mismo umbral
//   adaptativo que pivots_breakout_reversal en BTCUSD (-4.29R, ya desactivada
//   por Circuit Breaker) — una estrategia mala podía frenar arriba el umbral y
//   bloquear señales válidas de la buena, o viceversa.
// - runAutoTune() ahora agrupa por symbol+estrategia (misma key que ya usan
//   activeCustomSignals/lastCustomSignalAt) antes de llamar a
//   runAutoTuneForKey(); resolveCustomSignal() lee el umbral con esa misma key
//   nueva en vez de state.autoConfidenceThreshold[symbol]. resetAutoTune()
//   ajustado para vaciar el objeto completo (antes solo repoblaba por symbol,
//   dejando huérfanas las keys nuevas symbol_estrategia).
// - Efecto colateral esperado, no es un bug: cada key nueva junta su propia
//   muestra más despacio que antes (ya no comparte volumen con otras
//   estrategias del mismo símbolo), así que puede tardar más en alcanzar
//   AUTO_TUNE.minSampleSize (10) la primera vez que corre para una combinación.
// - Pendiente fuera de este archivo: si server.js expone autoTune.threshold en
//   /api/state asumiendo claves por symbol (como en el respaldo del 11/9 antes
//   de este fix), va a mostrar ahora claves symbol_estrategia — revisar ese
//   archivo si el front/estado público rompe algo con el formato nuevo.
// Cambios v4.7.5 (27/8, Etapa 3 — cierre del hallazgo HTF "insuficiente 60/90"):
// - Causa raíz confirmada leyendo el código (no solo el log): getOHLCV() cacheaba
//   en state.klineHistory[symbol], una sola clave por símbolo sin distinguir
//   timeframe. El pedido HTF (1h, 60 velas) pisaba la caché que acababa de dejar
//   el pedido de TF base (15m, ~90-100 velas) en el mismo ciclo. Riesgo real (no
//   solo ruido de log): si los proveedores fallaban al pedir TF, el fallback podía
//   devolver velas de 1h creyendo que eran de 15m (contaminaba evaluateAll()); y
//   quickPriceCheck() (BTC/ETH) podía escanear SL/TP intrabar contra velas de 1h
//   en vez de 15m, con rango de precio por vela ~4x más ancho. Caché separada
//   ahora por symbol+tf (state.klineHistory[symbol][tf]) en los 4 puntos que la
//   leían/escribían (getOHLCV x3, refreshAsset fallback, quickPriceCheck).
// - Efecto colateral del warning en sí (log "OHLCV insuficiente...60, mínimo 90"):
//   confirmado que era además comparación equivocada — OHLCV_STRATEGY_MIN_CANDLES=90
//   es el piso de bollinger_squeeze en TF base, se aplicaba también al pedido HTF
//   (limit=60) sin distinguir. Ahora el piso de 90 solo aplica cuando el pedido es
//   de TF base (limit >= 90); para HTF se compara contra lo efectivamente pedido.
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
  // Mínimo real de velas 15m que exige la estrategia activa más demandante
  // (bollinger_squeeze, candles.length >= 90 — confirmado en auditoría de
  // custom-strategies.js del 25/8, Etapa 1). No confundir con el `limit=100`
  // que se pide a los proveedores: 100 es un techo de pedido, no un piso
  // funcional. Re-verificar si custom-strategies.js cambió desde esa fecha.
  OHLCV_STRATEGY_MIN_CANDLES: 90,
  // FIX (16/9, hallazgo real: "no emite señales desde el 14/9"): este fallback se
  // usa cuando una combinación symbol+estrategia todavía no junta las
  // AUTO_TUNE.minSampleSize (10) operaciones reales cerradas bajo su key actual —
  // pasa con cualquier estrategia recién renombrada (kill_zone_ny desde el 30/8) o
  // recién reactivada. Antes era 70, MÁS ESTRICTO que AUTO_TUNE.minThreshold (65,
  // el piso más bajo al que el propio sistema se autoriza a bajar el umbral).
  // Efecto confirmado con datos reales de /api/state del 16/9: señales de
  // kill_zone_ny detectadas con 55-65% de confianza quedaban SIEMPRE por debajo
  // de 70 → nunca se tomaba una operación real bajo la key nueva → nunca se
  // juntaban las 10 muestras necesarias para que autoTune pudiera bajar el
  // umbral → círculo cerrado, silencio total (coincide con el corte real de
  // señales calculado desde los timestamps del historial, ~14/9). Bajado a 65
  // para que el fallback nunca sea más estricto que el propio mínimo del sistema.
  CONFIDENCE_THRESHOLD: 65,
  SIGNAL_COOLDOWN_MS: 15 * 60 * 1000,
  SIGNAL_EXPIRATION_MS: 72 * 60 * 60 * 1000,
  SIGNAL_EXPIRATION_MS_BY_STRATEGY: {
    kill_zone_ny: 4 * 60 * 60 * 1000
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
  // (20/9) Retirado CRYPTO_QUICK_CHECK_INTERVAL_MS: el chequeo rápido de precio era solo
  // para BTC/ETH, que salieron de la app.
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
    EURUSD: 1.5,  // pipSize 0.0001 -> ~1.5 pips
    GBPUSD: 2.0,  // pipSize 0.0001 -> ~2 pips (ESTIMADO 20/9 — ajustalo con el spread real de tu cuenta)
    XAUUSD: 3.5,  // pipSize 0.1 -> ~0.35 en precio
    US500: 6      // pipSize 0.1 -> ~0.6 puntos de índice (ESTIMADO 20/9 — ajustalo con el spread real)
  },
  // NUEVO (30/8): checkHistoryOutcomes marca "win" apenas la mecha (high/low) de
  // una vela del proveedor de datos (Twelve Data/FMP/AlphaVantage) toca TP1/TP2.
  // Caso real detectado: XAUUSD marcó "win" en la app sin que el broker del
  // usuario (Exness) mostrara ese mismo mínimo — cada feed tiene su propia mecha,
  // sobre todo en Oro. Este buffer exige que el precio vaya ESE TANTO MÁS ALLÁ del
  // TP (en pips, mismas unidades que ESTIMATED_SPREAD_PIPS_BY_SYMBOL) antes de
  // confirmar el toque — un margen de tolerancia a la diferencia entre feeds, no
  // una garantía de que va a coincidir siempre con Exness. Por ahora solo XAUUSD
  // (activo donde se reportó el caso); los demás símbolos quedan en 0 (sin
  // cambio de comportamiento) hasta que haya evidencia de que lo necesitan.
  TP_CONFIRMATION_BUFFER_PIPS_BY_SYMBOL: {
    EURUSD: 0,
    GBPUSD: 0,
    XAUUSD: 15, // pipSize 0.1 -> 1.5 en precio
    US500: 0
  },
  HTF_MAP: { '5m': '1h', '15m': '1h' },
  // FIX (09/9): edad máxima para usar el fallback de state.lastQuote en refreshAsset.
  // Pasado este límite, un quote cacheado se considera demasiado viejo para operar
  // sobre él y el ciclo cae a 'no-data' en vez de mostrar un precio "vivo" desactualizado.
  QUOTE_CACHE_MAX_AGE_MS: 20 * 60 * 1000, // 20 min
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
    SYMBOLS: ['XAUUSD', 'EURUSD', 'US500', 'GBPUSD'],
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
    EXCHANGERATE: 'https://open.er-api.com/v6/latest',
    TWELVEDATA: 'https://api.twelvedata.com',
    FINNHUB: 'https://finnhub.io/api/v1',
    ALPHAVANTAGE: 'https://www.alphavantage.co/query',
    FMP: 'https://financialmodelingprep.com/stable'
  },
  // v4.6: LISTA BLANCA - Solo estas estrategias están permitidas para operar
  // FIX (16/9, plan de rentabilidad): sacadas pivots_breakout_reversal,
  // bollinger_squeeze, ema_cross_scalping — eliminadas del código en
  // custom-strategies.js (no solo desactivadas), ver respaldo del 16/9.
  // (20/9) Con crypto fuera de la app quedan 3 activas. eth_momentum_breakout (solo ETHUSD) y
  // session_false_breakout (solo BTC/ETH) siguen en custom-strategies.js pero APAGADAS: sus
  // flags en ese archivo pasaron a false, y assertStrategyFlagsSync() exige que coincidan
  // con esta lista. Para reactivar una, cambiar los DOS lados.
  ENABLED_STRATEGIES: [
    'kill_zone_ny',          // los 4 activos
    'supply_demand',         // los 4 activos
    'session_breakout_vwap'  // EURUSD/XAUUSD/GBPUSD — ver SESSION_BREAKOUT_VWAP_SYMBOLS en custom-strategies.js
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
    // FIX (16/9, plan de rentabilidad): el umbral fijo de 3 (14/9) se reemplaza por dos
    // niveles según la calidad histórica real de cada combinación symbol+estrategia
    // (ver getCircuitBreakerThreshold()). Motivo confirmado con datos reales de
    // /api_state del 16/9: ese umbral fijo apagó a kill_zone_ny en XAUUSD (la mejor
    // estrategia del sistema, +4.47R históricos) con solo 3 pérdidas seguidas — el
    // mismo trato que a una estrategia sin ningún historial. Ahora una combinación con
    // historial real (>=qualifiedMinSample operaciones cerradas) y expectancy positiva
    // (avgR > 0) tolera qualifiedThreshold pérdidas seguidas antes de apagarse;
    // cualquier otra (nueva, sin validar, o con expectancy negativa) se apaga con
    // defaultThreshold. El breaker agregado (across símbolos) se deja con umbral fijo:
    // ya es una segunda capa de seguridad más amplia, pensada para rachas repartidas
    // entre los 4 activos, no para una sola combinación con historial propio.
    qualifiedMinSample: 15,
    qualifiedThreshold: 5,
    defaultThreshold: 2,
    consecutiveLossThresholdAggregate: 8
  },
  // FIX (auditoría 18/9 v2, bug confirmado con /api/state real): 'kill_zone_ny' es un
  // rename de 'ny_open_kill_zone' (30/8), pero el rename nunca migró
  // state.strategyStatsBySymbol/consecutiveLosses/autoDisabledStrategies de la key
  // vieja a la nueva. Resultado verificado en producción: el historial que justifica
  // qualifiedMinSample/STRATEGY_RISK_WEIGHT arriba ("+4.47R en XAUUSD", "+11.17R en
  // BTCUSD") vive TODO bajo 'ny_open_kill_zone' — la key nueva que realmente recibe
  // señales hoy tiene 0-3 operaciones por símbolo. getCircuitBreakerThreshold() nunca
  // puede calificar para qualifiedThreshold (necesita total>=15 bajo la key nueva), así
  // que la estrategia insignia del sistema opera hoy con el umbral más estricto
  // (defaultThreshold=2) pese a tener semanas de historial real bajo el nombre viejo.
  // migrateRenamedStrategyKeys() (ver más abajo) fusiona ambas keys al arrancar.
  // Formato: { keyNueva: keyVieja }. Agregar acá cualquier rename futuro de estrategia.
  RENAMED_STRATEGY_KEYS: {
    kill_zone_ny: 'ny_open_kill_zone'
  },
  // NUEVO (auditoría 18/9 v2, plan de rentabilidad — gestión de riesgo, nunca
  // implementada pese a estar especificada desde antes: "máx. 3 señales/sesión, pausa
  // tras 2 stops seguidos, corte tras 3 stops o -2%/día"). Se apoya en
  // closed_signals:YYYY-MM-DD (ya lo escribe appendClosedSignal en cada cierre real,
  // no hacía falta ningún storage nuevo). Dos capas:
  // - perSymbol: protege contra un solo activo/feed roto (ej. velas sintéticas de un
  //   proveedor de respaldo) sin frenar los otros 3 que van bien.
  // - global: protege contra una racha correlacionada entre los 4 activos a la vez
  //   (evento macro), que es exactamente el hueco que señalaba el circuit breaker
  //   agregado (ese mira rachas por ESTRATEGIA cruzando símbolos, no pérdida total del
  //   día cruzando TODO). Unidad: R (no equity), coherente con el resto del sistema.
  DAILY_RISK_GUARD: {
    enabled: true,
    maxSignalsPerSessionPerSymbol: 3,
    pauseAfterConsecutiveStopsPerSymbol: 2,
    dailyLossCapRPerSymbol: -2,
    dailyLossCapRGlobal: -3
  },
  // NUEVO (auditoría 20/9 v2): compuerta de costo. Estaba documentada en
  // PulseTrade_PRO_Estrategias_y_Parametros.md como implementada desde el 20/9
  // ("se descarta la señal si el spread estimado supera el 25% del stop"), pero
  // nunca se escribió en el código — ni acá ni en custom-strategies.js (evaluateAll
  // no recibe spread como parámetro, así que tampoco pudo haberse hecho del lado de
  // las estrategias). Motivo real, documentado en el .md con datos de producción:
  // EURUSD con stops de 2-4 pips perdía -1.33R a -1.75R en vez de -1R por el costo
  // del spread relativo al stop. Un gate dinámico (spread/stop) en vez de un piso
  // fijo de pips por símbolo: con ESTIMATED_SPREAD_PIPS_BY_SYMBOL.EURUSD=1.5 y este
  // umbral de 0.25, ya exige de facto un stop >=6 pips en EURUSD — sin mantener un
  // segundo número (piso fijo) que pueda desincronizarse del real, y reacciona solo
  // si el spread se ensancha puntualmente (rollover, noticia, feed débil), que es
  // justo cuando más protege. Se evalúa en resolveCustomSignal() con quote.spread
  // (ya viene en pips, real o estimado según el proveedor) y slPips.
  QUALITY_GATES: {
    enabled: true,
    maxSpreadPctOfStop: 0.25
  },
  // NUEVO (15/9, auditoría — "diworsification"): con 7-10 estrategias corriendo con
  // peso parejo, la ganancia real de las 2-3 que sí tienen edge (sobre todo
  // ny_open_kill_zone) se diluye con el resto, que empata o resta. Esto NO cambia el
  // tamaño de posición solo — no hay money management automático en este motor, es
  // un multiplicador SUGERIDO que viaja con cada señal (frozen.riskWeight en
  // resolveCustomSignal) para que Soy decida el tamaño real al operar. 1 = tamaño
  // normal. Valores según edge observado en strategyStatsBySymbol al 15/9: subido en
  // lo que más aporta, bajado en lo que empata o resta. Estrategia sin entrada acá =
  // 1 por default.
  // FIX (16/9, hallazgo de auditoría): esta tabla tenía la key vieja 'ny_open_kill_zone'
  // (renombrada a 'kill_zone_ny' el 30/8, ver custom-strategies.js). Como
  // resolveCustomSignal() busca CONFIG.STRATEGY_RISK_WEIGHT[customSig.strategy] y
  // customSig.strategy siempre llega como 'kill_zone_ny', la key vieja nunca hizo
  // match — el multiplicador 1.5x para la mejor estrategia del sistema nunca se
  // aplicó en ningún push ni en frozen.riskWeight desde que se implementó (15/9).
  // Corregido acá. Se sacan además las entradas de las 3 estrategias eliminadas del
  // código el 16/9 (bollinger_squeeze, ema_cross_scalping, pivots_breakout_reversal).
  STRATEGY_RISK_WEIGHT: {
    kill_zone_ny: 1.5,
    session_false_breakout: 1.3,
    session_breakout_vwap: 0.5
  },
  // v4.9 (sección 13, 27/8): piso mínimo de computeContextualScore() para que una señal
  // se muestre — decidido por el usuario en 55%, no propuesto por el motor. Antes el
  // score era puramente informativo (se mostraba pero no filtraba nada). Se pasa como
  // 7º parámetro a CustomStrategies.evaluateAll(); ese mismo valor se usa como default
  // interno si algún día se llama sin pasarlo.
  MIN_CONFIDENCE_SCORE: 55,
  // FIX (16/9, plan de rentabilidad): sacadas las entradas de ema_cross_scalping,
  // bollinger_squeeze y pivots_breakout_reversal — quedaron redundantes porque esas 3
  // ya no están en ENABLED_STRATEGIES ni existen como funciones en
  // custom-strategies.js (eliminadas del código, no solo desactivadas). 'smc' se deja
  // como estaba: ya era redundante desde que el motor SMC se sacó de engine.js en
  // agosto, no se tocó por no ser parte de esta sesión.
  DISABLED_STRATEGIES_BY_SYMBOL: {
    XAUUSD: ['smc'],
    EURUSD: ['smc'],
    US500: ['smc'],
    GBPUSD: ['smc']
  },
  // NUEVO (20/9): MODO SOMBRA para activos nuevos. Con el Motor de Rentabilidad V1, una
  // combinación símbolo+estrategia sin operaciones LIVE solo puede operar si su confianza
  // técnica es >=80% (probation) — casi nunca ocurre, y sin operaciones nunca junta la
  // muestra que la habilitaría (círculo cerrado). En modo sombra, mientras la combinación
  // tenga menos de PROFITABILITY_ENGINE_V1.minLiveSample operaciones LIVE, la señal se
  // registra y se trackea hasta SL/TP igual que una real (cuenta para stats LIVE, circuit
  // breaker de la combinación y auto-tune) pero SIN notificación push y con riskWeight 0 (= no operar con
  // dinero). No cuenta para el Daily Risk Guard ni para el circuit breaker AGREGADO (sí para el
  // de la propia combinación). Al llegar a minLiveSample, el Motor de
  // Rentabilidad decide con las reglas de siempre (expectancy > 0 => opera normal).
  // FIX (auditoría vía /api/state real, post-deploy 20/9): XAUUSD/EURUSD habían quedado
  // AFUERA de esta lista bajo la premisa de que ya tenían muestra LIVE "sembrada" desde
  // el historial real (XAUUSD kill_zone_ny 9G/11P +3.45R, ver .md). Esa siembra NUNCA se
  // implementó — state.liveStrategyStatsBySymbol arranca vacío por diseño (ver el
  // comentario en su inicialización más abajo: "no hay forma de reconstruir el historial
  // LIVE puro hacia atrás sin volver a mezclar seed y live") y /api/state en producción
  // lo confirma: {} para los 4 símbolos. Resultado real verificado: XAUUSD_kill_zone_ny
  // —la única estrategia con edge comprobado del sistema— estaba en el mismo círculo
  // cerrado que este modo sombra existe para romper, pero sin la válvula de escape que sí
  // tenían US500/GBPUSD. Se corrige agregando los 4 símbolos: sin esto no hay forma de que
  // ninguna combinación vuelva a operar con dinero real sin que una señal puntual toque
  // >=80% de confianza (kill_zone_ny ronda 55-70%, ver CONFIDENCE_THRESHOLD arriba).
  SHADOW_MODE: {
    enabled: true,
    symbols: ['XAUUSD', 'EURUSD', 'US500', 'GBPUSD']
  },
  // NUEVO (16/9, plan de rentabilidad, punto 5): modo probation/sombra para
  // estrategias nuevas — corren y guardan historial normalmente, pero sin
  // notificación push (ver resolveCustomSignal) hasta acumular minSampleToGraduate
  // señales resueltas (sumadas entre los 4 símbolos) con expectancy neta positiva
  // (ver checkProbationGraduation). Al graduarse, se avisa por push una sola vez y
  // de ahí en más notifica como cualquier otra estrategia. Para poner una estrategia
  // nueva en probation, agregar su key acá — no hay nada en probation hoy porque las
  // 5 activas ya tienen historial validado.
  PROBATION: {
    minSampleToGraduate: 20
  },
  PROBATION_STRATEGIES: [],
  // NUEVO (18/9, Motor de Rentabilidad V1 — pedido explícito de Soy): capa de decisión
  // adicional delante de la creación de señales, distinta de CIRCUIT_BREAKER (que corta
  // por RACHA de pérdidas consecutivas, sin mirar expectancy) y de DAILY_RISK_GUARD (que
  // corta por tope de R DIARIO, no por historial de la combinación). Esta capa exige
  // evidencia estadística LIVE (nunca datos importados del backtest, ver
  // updateLiveProfitabilityStats/state.liveStrategyStatsBySymbol) antes de dejar operar
  // una combinación símbolo+estrategia. useSeededForBlock y excludeExpired del prompt
  // original NO se copiaron como config: la fuente de datos (liveStrategyStatsBySymbol)
  // ya excluye seeded por construcción (nunca lo alimenta el backtest, solo
  // checkHistoryOutcomes) y ya excluye expired por construcción (solo cuenta
  // result 'win'/'loss', igual que updateStrategyStatsBySymbol) — dejar esos dos
  // parámetros hubiera sido configuración decorativa que nunca se lee.
  PROFITABILITY_ENGINE_V1: {
    enabled: true,
    minLiveSample: 12,
    robustLiveSample: 20,
    minExpectancyR: 0.00,
    robustMinExpectancyR: 0.10,
    recentWindow: 8,
    maxRecentLosses: 5,
    probationMinConfidence: 80,
    probationRiskMultiplier: 0.50
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
  // (20/9) Activos de la app: XAUUSD, EURUSD, US500, GBPUSD. BTCUSD/ETHUSD salieron.
  // scheduleProfile enlaza con SCHEDULE_PROFILES (horarios Exness por instrumento, más abajo).
  XAUUSD: {
    name: 'XAU/USD (Oro)', market: 'forex', type: 'commodity',
    symbols: { twelveData: 'XAU/USD', finnhub: 'OANDA:XAU_USD', alphaVantage: 'XAU', fmp: 'GCUSD' },
    decimals: 2, pipSize: 0.1, is24h: false, timezone: 'UTC', scheduleProfile: 'gold',
    providerPriority: ['twelveData', 'fmp', 'alphaVantage']
  },
  EURUSD: {
    name: 'EUR/USD', market: 'forex', type: 'forex',
    symbols: { twelveData: 'EUR/USD', finnhub: 'OANDA:EUR_USD', alphaVantage: 'EURUSD', fmp: 'EURUSD', exchangerate: 'EUR' },
    decimals: 5, pipSize: 0.0001, is24h: false, timezone: 'UTC', scheduleProfile: 'forex',
    // v4.6.3: exchangerate (open.er-api.com) pasado a último recurso — su tasa se
    // actualiza 1x/día, no sirve como fuente primaria para seguimiento de SL/TP en vivo.
    // Ver detección de congelamiento en ProviderAdapters.exchangerate.fetchQuote.
    providerPriority: ['twelveData', 'alphaVantage', 'exchangerate']
  },
  US500: {
    // NUEVO (20/9). Índice S&P 500. Twelve Data lo publica como 'SPX' y en el plan gratis NO
    // está incluido (los índices arrancan en el plan Grow). Sin otro proveedor confiable para
    // velas de índice, providerPriority queda solo en twelveData a propósito: si el plan no
    // lo cubre, el activo muestra 'no-data' sin afectar a los demás (ver bloqueo por símbolo
    // en markProviderCooldown). pipSize 0.1 => 1 punto de índice = 10 "pips" (mismas unidades
    // que ya usa XAUUSD). El precio de Exness (US500) puede diferir unos puntos del índice SPX
    // (CFD sobre futuros): mismo tipo de desfase conocido que tenía BTC/ETH vs Exness.
    name: 'US500 (S&P 500)', market: 'index', type: 'index',
    symbols: { twelveData: 'SPX' },
    decimals: 2, pipSize: 0.1, is24h: false, timezone: 'UTC', scheduleProfile: 'index',
    providerPriority: ['twelveData']
  },
  GBPUSD: {
    // NUEVO (20/9).
    name: 'GBP/USD', market: 'forex', type: 'forex',
    symbols: { twelveData: 'GBP/USD', finnhub: 'OANDA:GBP_USD', alphaVantage: 'GBPUSD', fmp: 'GBPUSD', exchangerate: 'GBP' },
    decimals: 5, pipSize: 0.0001, is24h: false, timezone: 'UTC', scheduleProfile: 'forex',
    providerPriority: ['twelveData', 'alphaVantage', 'exchangerate']
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
  // NUEVO (18/9, Motor de Rentabilidad V1): a propósito SEPARADO de strategyStatsBySymbol.
  // strategyStatsBySymbol mezcla para siempre datos seed (backtest) con datos live en el
  // mismo wins/losses/totalR — una vez mezclados no se pueden separar (ver
  // seedStrategyStatsFromBacktest). Este objeto nuevo solo lo alimenta
  // updateLiveProfitabilityStats(), llamada únicamente desde checkHistoryOutcomes sobre
  // cierres reales — nunca desde el backtest — así que es 100% LIVE por construcción,
  // sin necesitar ningún flag "seeded" para filtrar. También guarda recentResults (últimas
  // operaciones, ver PROFITABILITY_ENGINE_V1.recentWindow) porque signalHistory está
  // limitado a HISTORY_LIMIT=50 GLOBAL (compartido entre 4 símbolos x ~5-8 estrategias) y
  // no alcanza para sostener una ventana propia por combinación. Arranca vacío en este
  // deploy — no hay forma de reconstruir el historial LIVE puro hacia atrás sin volver a
  // mezclar seed y live.
  liveStrategyStatsBySymbol: (() => { try { return JSON.parse(localStorage.getItem('pt_live_strategy_stats_by_symbol') || '{}'); } catch (e) { return {}; } })(),
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
  // NUEVO (16/9): estrategias que ya salieron de modo probation (ver
  // CONFIG.PROBATION_STRATEGIES) y volvieron a notificar por push normalmente.
  probationGraduated: (() => { try { return JSON.parse(localStorage.getItem('pt_probation_graduated') || '{}'); } catch (e) { return {}; } })(),
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
  // FIX (18/9, auditoría completa — bug confirmado, el mismo anotado el 28/8 y todavía
  // sin corregir): este bloque reaplicaba las desactivaciones automáticas INDIVIDUALES
  // (state.autoDisabledStrategies) sobre CONFIG.DISABLED_STRATEGIES_BY_SYMBOL al
  // arrancar, pero no existía el equivalente para las AGREGADAS
  // (state.autoDisabledStrategiesAggregate) — la misma razón de ser (CONFIG vive en
  // memoria y se resetea en cada redeploy de Render). Si el circuit breaker agregado
  // se disparaba y después había un redeploy, la estrategia volvía a operar en los 4
  // símbolos sin aviso, mientras /api/state seguía mostrando la desactivación agregada
  // como vigente — falsa sensación de seguridad. Corregido acá con el mismo patrón.
  Object.values(state.autoDisabledStrategiesAggregate || {}).forEach(({ key }) => {
    if (!key) return;
    Object.keys(ASSETS || {}).forEach(symbol => {
      if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol]) CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol] = [];
      if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].includes(key)) {
        CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].push(key);
      }
    });
  });
})();

// FIX (1/9): state.autoConfidenceThreshold se calculaba en runAutoTune() desde hace
// tiempo pero nunca se leía en ningún lado (ver FIX 31/8 en resolveCustomSignal, que
// recién lo conectó). Mientras estuvo desconectado, escaló sin ningún control hasta
// CONFIG.AUTO_TUNE.maxThreshold (90) en los 4 símbolos a la vez — un valor que nunca
// fue validado contra operaciones reales, se acumuló en el vacío. No representa una
// decisión informada del sistema operando: es ruido de un gate que corrió ciego.
// Reset único a CONFIG.CONFIDENCE_THRESHOLD (70) la primera vez que corre este código
// tras el deploy — no toca autoTuneStats (winRate/expectancy siguen siendo datos
// válidos, no se pierden), solo el umbral. Se marca con una key de una sola vez para
// no resetear en cada redeploy futuro y dejar que vuelva a evolucionar desde acá con
// el gate ya realmente conectado.
// FIX (09/9): segundo reset manual. Tras el fix de rawExpectancy en runAutoTuneForKey,
// los umbrales (76/70/74/76) quedaron sin cambios durante ~19h porque ninguna señal
// cruzaba el umbral para convertirse en trade real -> cero cierres nuevos -> el
// auto-tune no tenía datos frescos para bajarlos (loop cerrado: umbral alto bloquea
// las señales que generarían la evidencia para bajar el umbral). Se fuerza el reset
// a CONFIG.CONFIDENCE_THRESHOLD (70) una vez más para romper el estancamiento; no
// toca autoTuneStats (winRate/expectancy previos se conservan), solo el umbral.
// Nueva key de guardia (v2) para que corra una sola vez más sin repetirse en
// redeploys futuros.
if (!localStorage.getItem('pt_threshold_reset_v2')) {
  const resetThreshold = {};
  Object.keys(ASSETS).forEach(sym => { resetThreshold[sym] = CONFIG.CONFIDENCE_THRESHOLD; });
  state.autoConfidenceThreshold = resetThreshold;
  localStorage.setItem('pt_auto_threshold_v2', JSON.stringify(resetThreshold));
  localStorage.setItem('pt_threshold_reset_v2', 'true');
} else if (!localStorage.getItem('pt_threshold_reset_v1')) {
  const resetThreshold = {};
  Object.keys(ASSETS).forEach(sym => { resetThreshold[sym] = CONFIG.CONFIDENCE_THRESHOLD; });
  state.autoConfidenceThreshold = resetThreshold;
  localStorage.setItem('pt_auto_threshold_v2', JSON.stringify(resetThreshold));
  localStorage.setItem('pt_threshold_reset_v1', 'true');
}

function getNow() { return new Date(); }

// FIX (30/8): antes esta función calculaba la ventana en hora Argentina fija
// (10:30-13:30 ARG), asumiendo un offset ARG=NY+1h que solo es correcto
// mientras rige EDT (horario de verano de EE.UU., marzo-noviembre). Argentina
// no tiene horario de verano, así que en temporada EST (noviembre-marzo) el
// offset real pasa a ser 2h y la ventana se corría una hora, dejando de cubrir
// bien 9:30-12:30 NY justo en esos meses. Mismo bug que ya se había corregido
// en custom-strategies.js (ver getNYTimeParts) — acá se aplica el mismo
// criterio: calcular directamente en America/New_York en vez de un offset fijo.
// Renombrada de isArgKillZoneWindow a isKillZoneWindow porque ya no depende
// de hora Argentina.
function isKillZoneWindow(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(new Date(nowMs));
  const weekday = parts.find(p => p.type === 'weekday').value;
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
  const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const minutesNow = hour * 60 + minute;
  return minutesNow >= (9 * 60 + 30) && minutesNow < (12 * 60 + 30);
}

function getDynamicRefreshIntervalMs() {
  return isKillZoneWindow() ? CONFIG.DYNAMIC_REFRESH.killZoneIntervalMs : CONFIG.DYNAMIC_REFRESH.normalIntervalMs;
}

function saveAutoTuneState() {
  localStorage.setItem('pt_auto_threshold_v2', JSON.stringify(state.autoConfidenceThreshold));
  localStorage.setItem('pt_auto_stats_v2', JSON.stringify(state.autoTuneStats));
}

function resetAutoTune() {
  // FIX (11/9): las keys de autoConfidenceThreshold pasaron de ser por symbol
  // a ser por symbol+estrategia (ver runAutoTune/resolveCustomSignal). Repoblar
  // solo por symbol acá dejaba huérfanas las keys symbol_estrategia viejas con
  // su valor anterior, sin resetear. Ahora se vacía todo el objeto: cualquier
  // lookup que no encuentre su key cae a CONFIG.CONFIDENCE_THRESHOLD por el
  // fallback ya existente en resolveCustomSignal/runAutoTuneForKey.
  const obj = {};
  state.autoConfidenceThreshold = obj; state.autoTuneStats = {}; state.patternStats = {};
  localStorage.setItem('pt_auto_threshold_v2', JSON.stringify(obj));
  localStorage.setItem('pt_auto_stats_v2', JSON.stringify({}));
  localStorage.setItem('pt_pattern_stats', JSON.stringify({}));
  renderAutoTuneStatus();
  Object.keys(ASSETS).forEach(sym => renderAutoTuneStatus(sym));
  refreshAllData(true);
  BacktestEngine.runAll(true);
}

// (20/9) Twelve Data: el plan gratis tiene 800 créditos/día; el plan Grow no tiene tope diario
// (sí 55 llamadas/min). Tras pasar a Grow, definir en Render la variable de entorno
// TWELVEDATA_DAILY_LIMIT=none para sacar el freno interno. Sin variable = 800 (como antes).
const TD_LIMIT_ENV = process.env.TWELVEDATA_DAILY_LIMIT;
const TWELVEDATA_DAILY_LIMIT = (TD_LIMIT_ENV === undefined || TD_LIMIT_ENV === '') ? 800
  : (String(TD_LIMIT_ENV).toLowerCase() === 'none' ? null : (parseInt(TD_LIMIT_ENV, 10) || 800));
const PROVIDER_DAILY_LIMITS = { twelveData: TWELVEDATA_DAILY_LIMIT, finnhub: null, alphaVantage: 25, fmp: 250 };

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

// ============================================================
// HORARIOS DE MERCADO POR INSTRUMENTO (NUEVO 20/9)
// ============================================================
// Exness publica horarios propios por instrumento (servidores en UTC+0) y con horario de
// verano de EE.UU.: "verano" = 2º domingo de marzo -> 1º domingo de noviembre. Este módulo
// deriva de esa regla los tramos en que cada activo NO cotiza (cierre semanal, pausa diaria,
// feriados) y los tramos en que cotiza pero conviene NO emitir señales nuevas (minutos
// previos a una pausa/cierre, reapertura reciente, rollover con spreads anchos).
//   - open=false            -> no se piden datos ni se evalúa nada (como antes con MERCADO_CERRADO)
//   - open=true, signalsAllowed=false -> se sigue trackeando SL/TP de señales en curso, pero
//                              NO se generan señales nuevas.
// FUENTES / CONFIANZA de cada perfil (tiempos de verano UTC; en invierno todo corre +1h):
//   forex (EURUSD, GBPUSD): OFICIAL Exness — Dom 21:05 a Vie 20:59. Rollover Lun-Jue 21:00
//        (1-2h de spreads anchos, ver Help Center "Instrument trading hours"): bloquea señales.
//   gold  (XAUUSD): Exness + fuentes terceras coincidentes — apertura Dom 22:05, cierre Vie
//        20:58, pausa diaria 20:58-22:01 (el oro cierra durante el rollover forex).
//   index (US500): ESTIMADO, CONSERVADO. No se pudo leer la tabla oficial por instrumento
//        (es un widget dinámico del Help Center). Se asume apertura Dom 21:55, cierre Vie
//        19:59 y pausa diaria 20:00-22:00 (cubre cierre del cash y reapertura de futuros).
//        Verificar en https://get.exness.help/hc/en-us/articles/4405235684498-Instrument-trading-hours
//        y ajustar SCHEDULE_PROFILES.index si difiere. Aunque este perfil se equivoque, la
//        capa de "feed sin velas nuevas" (SCHEDULE_CONFIG.feedStaleMultiplier) bloquea igual.
const SCHEDULE_CONFIG = {
  preCloseBlockMin: 15,      // sin señales nuevas en los N min previos a una pausa/cierre
  postOpenBlockMin: 30,      // ni en los N min posteriores a reabrir (liquidez fina, spreads anchos)
  feedStaleMultiplier: 3     // sin velas nuevas por más de N x timeframe => feed pausado o caído
};
const SCHEDULE_PROFILES = {
  forex: {
    label: 'Forex', estimated: false,
    weekOpen: { h: 21, m: 5 }, weekClose: { h: 20, m: 59 },
    dailyBreaks: [],
    rollover: { h: 21, m: 0, durMin: 65 }
  },
  gold: {
    label: 'Oro', estimated: false,
    weekOpen: { h: 22, m: 5 }, weekClose: { h: 20, m: 58 },
    dailyBreaks: [{ h: 20, m: 58, durMin: 63 }],
    rollover: null
  },
  index: {
    label: 'Índice', estimated: true,
    weekOpen: { h: 21, m: 55 }, weekClose: { h: 19, m: 59 },
    dailyBreaks: [{ h: 20, m: 0, durMin: 120 }],
    rollover: null
  }
};
// Feriados con cierre total (fechas UTC 'YYYY-MM-DD'), de la lista publicada por Exness para
// 2026-2027. Exness avisa por email el horario exacto de cada feriado por instrumento: los
// feriados con horario reducido (no cierre total) se bloquean acá por conservador solo si
// se agregan. Actualizar cada año.
const HOLIDAY_CLOSURES = {
  ALL: ['2026-12-25', '2027-01-01'],
  US500: ['2026-11-26']   // Thanksgiving (EE.UU.)
};
const SCHEDULE_PHASE_LABEL = { weekend: 'cierre semanal del mercado', daily_break: 'pausa diaria', holiday: 'feriado', rollover: 'rollover diario' };
const SCHEDULE_PHASE_WITH_ARTICLE = { weekend: 'el cierre semanal del mercado', daily_break: 'la pausa diaria', holiday: 'el feriado', rollover: 'el rollover diario' };

function nthSundayUTC(year, month, n) {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return Date.UTC(year, month, 1 + ((7 - firstDow) % 7) + (n - 1) * 7);
}
function isExnessSummer(ms) {
  const y = new Date(ms).getUTCFullYear();
  return ms >= nthSundayUTC(y, 2, 2) && ms < nthSundayUTC(y, 10, 1);
}
function isScheduleHoliday(symbol, dateKey) {
  return (HOLIDAY_CLOSURES.ALL || []).includes(dateKey) || (HOLIDAY_CLOSURES[symbol] || []).includes(dateKey);
}
function getScheduleIntervals(profile, symbol, nowMs) {
  const MIN = 60000, DAY = 86400000;
  const closed = [], blackouts = [];
  const nd = new Date(nowMs);
  const base = Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth(), nd.getUTCDate());
  for (let off = -9; off <= 9; off++) {
    const dayMs = base + off * DAY;
    const dow = new Date(dayMs).getUTCDay();
    const shift = isExnessSummer(dayMs) ? 0 : 60;
    const at = (hm, addMin = 0) => dayMs + (hm.h * 60 + hm.m + shift + addMin) * MIN;
    if (dow === 5) {
      const sunMs = dayMs + 2 * DAY;
      const sunShift = isExnessSummer(sunMs) ? 0 : 60;
      closed.push({ start: at(profile.weekClose), end: sunMs + (profile.weekOpen.h * 60 + profile.weekOpen.m + sunShift) * MIN, type: 'weekend' });
    }
    if (dow >= 1 && dow <= 4) {
      profile.dailyBreaks.forEach(b => closed.push({ start: at(b), end: at(b, b.durMin), type: 'daily_break' }));
      if (profile.rollover) blackouts.push({ start: at(profile.rollover), end: at(profile.rollover, profile.rollover.durMin), type: 'rollover' });
    }
    if (isScheduleHoliday(symbol, new Date(dayMs).toISOString().slice(0, 10))) closed.push({ start: dayMs, end: dayMs + DAY, type: 'holiday' });
  }
  return { closed, blackouts };
}
function getMarketStatus(symbol, nowMs = Date.now()) {
  const asset = ASSETS[symbol];
  const profile = asset && SCHEDULE_PROFILES[asset.scheduleProfile];
  if (!profile) return { symbol, open: true, signalsAllowed: true, phase: 'no_schedule', reason: null, resumesAtUtc: null, estimated: false };
  const MIN = 60000;
  const { closed, blackouts } = getScheduleIntervals(profile, symbol, nowMs);
  const iso = ms => new Date(ms).toISOString();
  const current = closed.filter(iv => nowMs >= iv.start && nowMs < iv.end).sort((a, b) => b.end - a.end)[0];
  if (current) {
    let end = current.end, grew = true;
    while (grew) { grew = false; for (const iv of closed) { if (iv.start <= end && iv.end > end) { end = iv.end; grew = true; } } }
    return { symbol, open: false, signalsAllowed: false, phase: current.type,
      reason: `${SCHEDULE_PHASE_LABEL[current.type]} — reabre ${iso(end).slice(0, 16).replace('T', ' ')} UTC`,
      resumesAtUtc: iso(end), estimated: !!profile.estimated };
  }
  let block = null;
  for (const iv of closed) {
    if (nowMs >= iv.start - SCHEDULE_CONFIG.preCloseBlockMin * MIN && nowMs < iv.start) {
      block = { reason: `faltan ${Math.ceil((iv.start - nowMs) / MIN)} min para ${SCHEDULE_PHASE_WITH_ARTICLE[iv.type]}`, until: iv.start };
    } else if (nowMs >= iv.end && nowMs < iv.end + SCHEDULE_CONFIG.postOpenBlockMin * MIN) {
      block = { reason: `reapertura reciente (tras ${SCHEDULE_PHASE_WITH_ARTICLE[iv.type]}) — liquidez fina`, until: iv.end + SCHEDULE_CONFIG.postOpenBlockMin * MIN };
    }
  }
  for (const iv of blackouts) {
    if (nowMs >= iv.start && nowMs < iv.end) block = { reason: 'rollover diario — spreads anchos', until: iv.end };
  }
  return { symbol, open: true, signalsAllowed: !block, phase: block ? 'signal_block' : 'open',
    reason: block ? block.reason : null, resumesAtUtc: block ? iso(block.until) : null, estimated: !!profile.estimated };
}
function isMarketOpenForAsset(symbol) { return getMarketStatus(symbol).open; }
// Capa de respaldo, independiente de la tabla de horarios: si el feed no trae velas nuevas
// hace más de N x timeframe estando "abierto" según el calendario (feriado no listado, pausa
// no prevista, proveedor caído o sirviendo caché viejo), no se generan señales nuevas.
function getFeedStatus(candles, tf) {
  const tfMin = ({ '5m': 5, '15m': 15, '1h': 60 })[tf] || 15;
  const last = candles && candles.length ? candles[candles.length - 1] : null;
  const ageMin = last ? (Date.now() - last.time) / 60000 : Infinity;
  const stale = ageMin > tfMin * SCHEDULE_CONFIG.feedStaleMultiplier;
  return { stale, ageMin: Number.isFinite(ageMin) ? Math.round(ageMin) : null, tfMin };
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

// NUEVO (20/9): un error de "este símbolo no está incluido en tu plan / no existe" (caso
// típico: US500 en el plan gratis de Twelve Data) NO debe poner en cooldown al proveedor
// entero — dejaría sin datos a los otros 3 activos. Se bloquea solo esa combinación
// proveedor+símbolo por SYMBOL_BLOCK_MS. Los errores de cupo/límite siguen siendo
// cooldown de proveedor completo, como siempre.
const SYMBOL_BLOCK_MS = 6 * 60 * 60 * 1000;
function isSymbolAccessError(errorMessage) {
  const msg = (errorMessage || '').toLowerCase();
  if (/per day|requests per|api credits|rate limit|429|too many requests|spreading out/.test(msg)) return false;
  return /available starting|upgrade|grow|venture|pro plan|premium|your plan|symbol.*(not found|invalid|missing)|figi/.test(msg);
}
function isProviderSymbolBlocked(providerName, symbol) {
  const until = state.providerSymbolBlockedUntil && state.providerSymbolBlockedUntil[`${providerName}:${symbol}`];
  return !!until && Date.now() < until;
}
function markProviderCooldown(providerName, errorMessage, symbol = null) {
  if (symbol && isSymbolAccessError(errorMessage)) {
    state.providerSymbolBlockedUntil = state.providerSymbolBlockedUntil || {};
    state.providerSymbolBlockedUntil[`${providerName}:${symbol}`] = Date.now() + SYMBOL_BLOCK_MS;
    console.warn(`[proveedor] ${providerName} no sirve ${symbol} (${errorMessage}) — bloqueado solo para ese símbolo por ${SYMBOL_BLOCK_MS / 3600000}h; el resto de los activos sigue normal`);
    return;
  }
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
// NUEVO (20/9): divisas cuyas noticias de alto impacto afectan el score de cada activo.
// GBPUSD suma GBP (decisiones del BoE, IPC UK). EURUSD/XAUUSD/US500 quedan solo en USD, como antes.
const NEWS_CURRENCIES_BY_SYMBOL = { XAUUSD: ['USD'], EURUSD: ['USD'], US500: ['USD'], GBPUSD: ['USD', 'GBP'] };
const NewsCalendar = {
  FEED_URL: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  CACHE_MS: 30 * 60 * 1000,
  // FIX (27/8): backoff tras fallo. Antes, un 429 no actualizaba _cacheAt, así que
  // el próximo ciclo (y el siguiente símbolo del MISMO ciclo, ver getNearbyHighImpact
  // llamado 1x por símbolo) volvía a intentar el fetch de inmediato — eso generaba
  // ráfagas de 4 fetches en segundos contra el feed público, perpetuando el 429.
  // Confirmado en logs de producción del 27/8 (ráfagas de 4 fallos en <30s por ciclo).
  // AJUSTE (28/8): subido de 10min a 8h. El fix del 27/8 solo bajó la frecuencia de
  // reintentos, no resolvió el 429 — faireconomy.media rechaza de forma sostenida la
  // IP de Render (0 llamadas exitosas en 4hs de logs revisados).
  // FIX (2/9): el bloqueo era específicamente a la IP de Render, no al feed en sí.
  // Se agrega un proxy público (allorigins) como primer intento: el pedido sale con
  // otra IP y evita el 429 sin costo. Si el proxy también falla, se reintenta directo
  // como respaldo (por si algún día se levanta el bloqueo o el proxy está caído).
  // Con esto activo, el fallo pasa a ser más esporádico que sostenido — se baja el
  // backoff de 8h a 30min (igual al CACHE_MS) para no tardar tanto en recuperarse de
  // un corte transitorio del proxy. Si vuelve a fallar de forma sostenida, revisar
  // logs antes de subirlo de nuevo — no asumir que es el mismo bloqueo de antes.
  PROXY_URL: 'https://api.allorigins.win/raw?url=',
  BACKOFF_MS: 30 * 60 * 1000,
  _cache: null,
  _cacheAt: 0,

  async _fetchJson(url) {
    const res = await fetchWithTimeout(url, CONFIG.REQUEST_TIMEOUT, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulseTradePRO/1.0; +https://pulsetrade-analisis.onrender.com)' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Respuesta inesperada del calendario económico');
    return data;
  },

  async getEvents() {
    if (this._cache && (Date.now() - this._cacheAt) < this.CACHE_MS) return this._cache;
    try {
      const data = await this._fetchJson(this.PROXY_URL + encodeURIComponent(this.FEED_URL));
      this._cache = data;
      this._cacheAt = Date.now();
      return data;
    } catch (proxyError) {
      console.warn('[NewsCalendar] fallo vía proxy, reintentando directo:', proxyError.message);
      try {
        const data = await this._fetchJson(this.FEED_URL);
        this._cache = data;
        this._cacheAt = Date.now();
        return data;
      } catch (directError) {
        console.warn('[NewsCalendar] fallo al traer calendario económico (proxy y directo):', directError.message);
        // Si falla, se sigue usando el cache viejo si existe (mejor un calendario un poco
        // desactualizado que dejar de scorear por completo), o array vacío si nunca hubo éxito.
        // Se marca _cacheAt igual en el fallo, con backoff, para no reintentar de inmediato
        // y evitar ráfagas (ver FIX 27/8 más arriba).
        this._cacheAt = Date.now() - this.CACHE_MS + this.BACKOFF_MS;
        return this._cache || [];
      }
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
    const currencies = Array.isArray(currency) ? currency : [currency]; // (20/9) acepta lista
    for (const ev of events) {
      if (!ev || !currencies.includes(ev.country)) continue;
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
  // (20/9) Retirados los adapters okx, binanceSpot, binanceFutures y coingecko: solo servían
  // a BTCUSD/ETHUSD, que salieron de la app.
  exchangerate: {
    name: 'ExchangeRate-API', requiresKey: false, supports: ['EURUSD','GBPUSD'],
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
    name: 'Twelve Data', requiresKey: true, supports: ['XAUUSD','EURUSD','US500','GBPUSD'],
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
    name: 'Finnhub', requiresKey: true, supports: ['XAUUSD','EURUSD','GBPUSD'],
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
  alphaVantage: {
    name: 'Alpha Vantage', requiresKey: true, supports: ['XAUUSD','EURUSD','GBPUSD'],
    async fetchQuote(symbol) {
      if (!state.apiKeys.alphaVantage) throw new Error('API key no configurada');
      const asset = ASSETS[symbol];
      const cacheKey = `av_quote_${symbol}`;
      const cached = ResponseCache.get(cacheKey); if (cached) return cached;
      // FIX (20/9): antes todo lo que no fuera EURUSD se mapeaba a 'XAU' — con GBPUSD habría
      // traído el precio del ORO como si fuera libra. Ahora la divisa base sale del propio símbolo.
      const fromCurr = asset.symbols.alphaVantage === 'XAU' ? 'XAU' : asset.symbols.alphaVantage.slice(0, 3);
      const url = `${CONFIG.ENDPOINTS.ALPHAVANTAGE}?function=CURRENCY_EXCHANGE_RATE&from_currency=${fromCurr}&to_currency=USD&apikey=${state.apiKeys.alphaVantage}`;
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
      const fromSym = asset.symbols.alphaVantage === 'XAU' ? 'XAU' : asset.symbols.alphaVantage.slice(0, 3); // FIX (20/9): ver fetchQuote
      const url = `${CONFIG.ENDPOINTS.ALPHAVANTAGE}?function=FX_INTRADAY&from_symbol=${fromSym}&to_symbol=USD&interval=${tfMap[interval]||'15min'}&apikey=${state.apiKeys.alphaVantage}`;
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
    name: 'Financial Modeling Prep', requiresKey: true, supports: ['XAUUSD','EURUSD','GBPUSD'],
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
      if (isProviderSymbolBlocked(providerName, symbol)) return false;
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
        // FIX (09/9): se cachea el último quote exitoso por símbolo para que un
        // fallo puntual de getQuote (ej. cooldown/rate-limit transitorio) no tire
        // todo el ciclo de refreshAsset a 'no-data' — mismo patrón que ya usa
        // getOHLCV con su fallback a state.klineHistory. Ver uso en refreshAsset.
        state.lastQuote = state.lastQuote || {};
        state.lastQuote[symbol] = data;
        return data;
      } catch (error) {
        state.providers[providerName] = 'fail';
        state.providerStats[providerName] = {
          lastSuccess: state.providerStats[providerName]?.lastSuccess || null,
          lastError: Date.now(), errorCount: (state.providerStats[providerName]?.errorCount || 0) + 1, lastErrorMsg: error.message
        };
        markProviderCooldown(providerName, error.message, symbol);
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
    // FIX (Etapa 3, hallazgo cache klineHistory): antes la caché se guardaba en
    // state.klineHistory[symbol], una sola clave por símbolo sin distinguir timeframe.
    // Como getOHLCV se llama tanto para el TF base (15m, ~90-100 velas) como para el
    // HTF (1h, 60 velas) dentro del mismo ciclo de refreshAsset(), la llamada HTF
    // pisaba lo que acababa de guardar la llamada TF. Efecto real: si en el ciclo
    // siguiente los proveedores fallaban al pedir TF, el fallback devolvía las velas
    // de 1h del ciclo anterior creyendo que eran de 15m (contaminando evaluateAll());
    // y quickPriceCheck() (BTC/ETH) podía terminar escaneando SL/TP intrabar contra
    // velas de 1h en vez de 15m, con rango de precio por vela ~4x más ancho. Ahora la
    // caché queda separada por símbolo+timeframe: state.klineHistory[symbol][tf].
    if (!isMarketOpenForAsset(symbol)) {
      return (state.klineHistory[symbol] && state.klineHistory[symbol][tf]) || new OHLCVData([]);
    }
    const providerList = asset.providerPriority || CONFIG.PROVIDER_PRIORITY;
    const eligible = providerList.filter(providerName => {
      const adapter = ProviderAdapters[providerName];
      if (!adapter || !adapter.fetchOHLCV || !adapter.supports.includes(symbol)) return false;
      if (adapter.requiresKey && !state.apiKeys[providerName]) return false;
      if (isProviderSymbolBlocked(providerName, symbol)) return false;
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
          // FIX (Etapa 3, mismo hallazgo): OHLCV_STRATEGY_MIN_CANDLES=90 es el piso
          // pensado solo para el TF base 15m (bollinger_squeeze). Antes se comparaba
          // sin distinguir, así que el pedido HTF (1h, limit=60) siempre disparaba el
          // warning de "insuficiente" aunque 60 sea lo esperado y suficiente para el
          // filtro de tendencia HTF. Ahora el piso de 90 solo se evalúa cuando el
          // pedido es igual o mayor a ese límite (o sea, el TF base); para pedidos
          // más chicos (HTF) se compara contra lo efectivamente pedido (limit).
          const isBaseTFRequest = limit >= CONFIG.OHLCV_STRATEGY_MIN_CANDLES;
          const effectiveMin = isBaseTFRequest ? CONFIG.OHLCV_STRATEGY_MIN_CANDLES : limit;
          if (data.candles.length < effectiveMin) {
            // Caso real de riesgo: por debajo de esto, la estrategia que hizo este
            // pedido (bollinger_squeeze en TF base, o el filtro de tendencia HTF de
            // quien pidió HTF) no tiene suficientes velas para evaluar.
            console.warn(`OHLCV ${providerName} INSUFICIENTE para estrategias: ${symbol} ${tf} — recibió ${data.candles.length}, mínimo requerido ${effectiveMin}`);
          } else if (data.candles.length < limit) {
            // Proveedor devolvió menos velas de las pedidas (pero más que el mínimo
            // requerido): no afecta a ninguna estrategia activa.
            console.info(`OHLCV ${providerName} ${symbol} ${tf} — recibió ${data.candles.length}/${limit} (techo del proveedor, dentro de lo requerido)`);
          }
          if (!state.klineHistory[symbol]) state.klineHistory[symbol] = {};
          state.klineHistory[symbol][tf] = data;
          return data;
        } catch (error) {
          markProviderCooldown(providerName, error.message, symbol);
          console.warn(`OHLCV ${providerName} falló:`, error.message);
          await sleep(1500);
        }
      }
      if (state.klineHistory[symbol] && state.klineHistory[symbol][tf] && state.klineHistory[symbol][tf].candles.length > 0) {
        return state.klineHistory[symbol][tf];
      }
      throw new Error(`No se pudieron obtener velas históricas`);
    }
    if (state.klineHistory[symbol] && state.klineHistory[symbol][tf] && state.klineHistory[symbol][tf].candles.length > 0) {
      return state.klineHistory[symbol][tf];
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
      if (isProviderSymbolBlocked('twelveData', symbol)) {
        console.warn(`Backtest: twelveData no sirve ${symbol} (bloqueado por símbolo), se omite`);
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
        markProviderCooldown('twelveData', e.message, symbol);
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

 // NUEVO (20/9): antes, con el mercado cerrado, refreshAsset solo tocaba state.lastDisplay (que
// el panel no lee) y las tarjetas quedaban con lo último que hubiera. Ahora cada estrategia
// habilitada para el símbolo, SIN trade abierto, muestra el motivo real del bloqueo
// (pausa diaria, cierre semanal, feriado...). Un trade abierto conserva su tarjeta.
function markMarketClosedDisplays(symbol, reason) {
  const disabled = CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol] || [];
  CONFIG.ENABLED_STRATEGIES.forEach(strategyKey => {
    if (disabled.includes(strategyKey)) return;
    if (state.activeCustomSignals[`${symbol}_${strategyKey}`]) return;
    renderCustomSignal(symbol, strategyKey, { type: 'market-closed', reason });
  });
}
function clearMarketClosedDisplays(symbol) {
  const bucket = state.lastCustomDisplay && state.lastCustomDisplay[symbol];
  if (!bucket) return;
  Object.keys(bucket).forEach(k => { if (bucket[k] && bucket[k].type === 'market-closed') bucket[k] = { type: 'no-signal' }; });
}

function pushSignalHistory(signal) {
  if (signal.type !== 'long' && signal.type !== 'short') return;
  const entry = {
    id: Date.now(), symbol: signal.symbol, name: signal.asset.name, type: signal.type,
    entry: signal.entry, sl: signal.sl, tp1: signal.tp1, tp2: signal.tp2,
    slPips: signal.slPips, tp1Pips: signal.tp1Pips, tp2Pips: signal.tp2Pips,
    decimals: signal.decimals, confidence: signal.confidence, result: 'pending', timestamp: signal.timestamp,
    strategyKeys: signal.strategyKeys || [], rMultiple: null, regime: signal.regime || 'unknown',
    // FIX (15/9, auditoría): antes el fallback era 'smc', mezclando en las estadísticas
    // señales viejas sin campo source (de antes de trackear por estrategia) con la
    // estrategia real 'smc'. Ahora usan su propio bucket, separable en cualquier reporte.
    source: signal.source || 'legacy_untagged',
    // NUEVO (auditoría 18/9 v2, punto A1): ver nota en resolveCustomSignal/frozen.
    provider: signal.provider || 'unknown', estimatedSpread: !!signal.estimatedSpread,
      // NUEVO (18/9, Motor de Rentabilidad V1): "no ocultar el motivo al usuario" —
    // riskWeight faltaba acá desde antes (solo vivía en frozen/push), lo agrego ahora
    // porque es necesario para ver el efecto real de probationRiskMultiplier en el
    // historial. profitabilityMode/Reason/Sample/ExpectancyR solo tienen valor real
    // cuando profitabilityMode==='probation'; en 'ok' documentan que pasó el gate.
    riskWeight: signal.riskWeight != null ? signal.riskWeight : 1,
    shadow: !!signal.shadow, // NUEVO (20/9): modo sombra (sin push, no cuenta para el Daily Risk Guard)
    profitabilityMode: signal.profitabilityMode || 'ok',
    profitabilityReason: signal.profitabilityReason || null,
    profitabilitySample: signal.profitabilitySample != null ? signal.profitabilitySample : null,
    profitabilityExpectancyR: signal.profitabilityExpectancyR != null ? signal.profitabilityExpectancyR : null
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
  const symbol = entry.symbol, key = entry.source || 'legacy_untagged'; // FIX (15/9, auditoría): ver nota en pushSignalHistory
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
  // (20/9) una operación en modo sombra NO alimenta el breaker agregado (cruza símbolos): sus
  // pérdidas simuladas no deben apagar la estrategia en los activos con dinero real. El breaker
  // por combinación símbolo+estrategia SÍ la cuenta (mismas reglas que una señal real).
  if (!entry.shadow) checkCircuitBreakerAggregate(key, entry.result);
  checkProbationGraduation(key);
}

// NUEVO (18/9, Motor de Rentabilidad V1): mismo criterio de entrada que
// updateStrategyStatsBySymbol (misma llamada, mismo entry) pero escribe en
// state.liveStrategyStatsBySymbol, nunca tocado por el backtest — ver nota en el
// objeto de estado. Solo cuenta 'win'/'loss' (EXPIRED y PENDING quedan afuera por el
// mismo guard que ya usa updateStrategyStatsBySymbol).
function updateLiveProfitabilityStats(entry) {
  if (entry.result !== 'win' && entry.result !== 'loss') return;
  const symbol = entry.symbol, key = entry.source || 'legacy_untagged';
  if (!symbol || !key) return;
  state.liveStrategyStatsBySymbol[symbol] = state.liveStrategyStatsBySymbol[symbol] || {};
  if (!state.liveStrategyStatsBySymbol[symbol][key]) {
    state.liveStrategyStatsBySymbol[symbol][key] = { wins: 0, losses: 0, totalR: 0, avgR: 0, recentResults: [] };
  }
  const stats = state.liveStrategyStatsBySymbol[symbol][key];
  if (entry.result === 'win') stats.wins++; else stats.losses++;
  const r = entry.rMultiple != null ? entry.rMultiple : (entry.result === 'win' ? 2 : -1);
  stats.totalR = +((stats.totalR || 0) + r).toFixed(2);
  const totalOps = stats.wins + stats.losses;
  stats.avgR = totalOps > 0 ? +(stats.totalR / totalOps).toFixed(2) : 0;
  // Más reciente primero, igual que signalHistory (unshift). Se guarda algo más que
  // recentWindow (mínimo 8) por si en el futuro se sube el número en config sin tener
  // que esperar a acumular de nuevo.
  stats.recentResults.unshift({ result: entry.result, rMultiple: r, timestamp: entry.timestamp });
  const keepWindow = Math.max((CONFIG.PROFITABILITY_ENGINE_V1 && CONFIG.PROFITABILITY_ENGINE_V1.recentWindow) || 8, 8);
  if (stats.recentResults.length > keepWindow) stats.recentResults.length = keepWindow;
  localStorage.setItem('pt_live_strategy_stats_by_symbol', JSON.stringify(state.liveStrategyStatsBySymbol));
}

function getLiveProfitabilityStats(symbol, strategyKey) {
  const bucket = state.liveStrategyStatsBySymbol[symbol] && state.liveStrategyStatsBySymbol[symbol][strategyKey];
  return bucket || { wins: 0, losses: 0, totalR: 0, avgR: 0, recentResults: [] };
}

// NUEVO (18/9, Motor de Rentabilidad V1): reglas A-E del plan de rentabilidad, en el
// mismo orden lógico salvo D (deterioro reciente), que se chequea PRIMERO a propósito —
// pedido explícito del plan: "no permitir que un historial antiguo positivo oculte un
// deterioro reciente". Eso incluye no dejar pasar a PROBATION (regla A) una combinación
// que viene con 5+ pérdidas en sus últimas 8 operaciones reales, aunque tenga muestra
// chica y confianza técnica alta.
function evaluateProfitability(symbol, strategyKey, confidence) {
  const cfg = CONFIG.PROFITABILITY_ENGINE_V1;
  if (!cfg || !cfg.enabled) return { decision: 'TRADE', mode: 'DISABLED', sample: null, expectancyR: null, winRate: null, recentLosses: null, reason: 'Motor de Rentabilidad deshabilitado' };

  const stats = getLiveProfitabilityStats(symbol, strategyKey);
  const sample = stats.wins + stats.losses;
  const winRate = sample > 0 ? +((stats.wins / sample) * 100).toFixed(1) : null;
  const expectancyR = sample > 0 ? stats.avgR : null;

  const recentSlice = stats.recentResults.slice(0, cfg.recentWindow);
  const recentLosses = recentSlice.filter(r => r.result === 'loss').length;
  const base = { sample, expectancyR, winRate, recentLosses };

  // D. Deterioro reciente
  if (recentSlice.length >= cfg.recentWindow && recentLosses >= cfg.maxRecentLosses) {
    return { decision: 'NO_TRADE', mode: 'RECENT_DETERIORATION', ...base,
      reason: `${recentLosses} de las últimas ${recentSlice.length} operaciones LIVE fueron pérdidas (umbral ${cfg.maxRecentLosses})` };
  }

  // S. MODO SOMBRA (20/9): activos nuevos (CONFIG.SHADOW_MODE.symbols) con muestra LIVE
  // insuficiente — se registran y trackean sin push ni riesgo real, para poder juntar la
  // muestra que la regla A exigiría de otro modo (círculo cerrado). Va después de D a
  // propósito: un deterioro reciente sigue cortando incluso en sombra.
  const shadowCfg = CONFIG.SHADOW_MODE;
  if (shadowCfg && shadowCfg.enabled && (shadowCfg.symbols || []).includes(symbol) && sample < cfg.minLiveSample) {
    return { decision: 'SHADOW', mode: 'SHADOW_SAMPLE', ...base,
      reason: `modo sombra: ${sample}/${cfg.minLiveSample} operaciones LIVE — se registra sin push ni riesgo real hasta juntar muestra` };
  }

  // A. Muestra LIVE insuficiente
  if (sample < cfg.minLiveSample) {
    if (confidence != null && confidence >= cfg.probationMinConfidence) {
      return { decision: 'PROBATION', mode: 'INSUFFICIENT_SAMPLE', ...base, riskMultiplier: cfg.probationRiskMultiplier,
        reason: `muestra LIVE insuficiente (${sample}/${cfg.minLiveSample}) — confianza técnica ${confidence}% >= ${cfg.probationMinConfidence}%, opera con riesgo reducido x${cfg.probationRiskMultiplier}` };
    }
    return { decision: 'NO_TRADE', mode: 'INSUFFICIENT_SAMPLE', ...base,
      reason: `muestra LIVE insuficiente (${sample}/${cfg.minLiveSample}) y confianza técnica ${confidence != null ? confidence + '%' : 'n/d'} < ${cfg.probationMinConfidence}% requerido para probation` };
  }

  // B. Expectativa LIVE no positiva
  if (expectancyR <= cfg.minExpectancyR) {
    return { decision: 'NO_TRADE', mode: 'NEGATIVE_EXPECTANCY', ...base,
      reason: `expectancy LIVE ${expectancyR}R <= ${cfg.minExpectancyR}R (${sample} operaciones)` };
  }

  // C. Expectativa débil en muestra robusta
  if (sample >= cfg.robustLiveSample && expectancyR < cfg.robustMinExpectancyR) {
    return { decision: 'NO_TRADE', mode: 'WEAK_ROBUST_EXPECTANCY', ...base,
      reason: `expectancy LIVE ${expectancyR}R < ${cfg.robustMinExpectancyR}R exigido con muestra robusta (${sample} operaciones)` };
  }

  // E. TRADE
  return { decision: 'TRADE', mode: 'OK', ...base,
    reason: `expectancy LIVE ${expectancyR}R con ${sample} operaciones, sin deterioro reciente` };
}

// NUEVO (auditoría 18/9 v2): fusiona el historial de una key vieja de estrategia
// (renombrada en CONFIG.RENAMED_STRATEGY_KEYS) dentro de la key nueva, una sola vez,
// en strategyStatsBySymbol + consecutiveLosses + autoDisabledStrategies. Sin esto,
// getCircuitBreakerThreshold() nunca ve el historial real de una estrategia renombrada
// (ver nota en CONFIG.RENAMED_STRATEGY_KEYS). Idempotente: si la key vieja ya no existe
// en algún symbol (ya migrada, o nunca tuvo datos ahí), no hace nada para ese symbol.
function migrateRenamedStrategyKeys() {
  const renames = CONFIG.RENAMED_STRATEGY_KEYS || {};
  Object.entries(renames).forEach(([newKey, oldKey]) => {
    Object.keys(state.strategyStatsBySymbol || {}).forEach(symbol => {
      const bucket = state.strategyStatsBySymbol[symbol];
      const oldStats = bucket && bucket[oldKey];
      if (!oldStats) return; // ya migrada o sin datos viejos en este símbolo

      const newStats = bucket[newKey] || { wins: 0, losses: 0, totalR: 0, avgR: 0 };
      newStats.wins = (newStats.wins || 0) + (oldStats.wins || 0);
      newStats.losses = (newStats.losses || 0) + (oldStats.losses || 0);
      newStats.totalR = +(((newStats.totalR || 0) + (oldStats.totalR || 0)).toFixed(2));
      const totalOps = newStats.wins + newStats.losses;
      newStats.avgR = totalOps > 0 ? +(newStats.totalR / totalOps).toFixed(2) : 0;
      bucket[newKey] = newStats;
      delete bucket[oldKey];

      // consecutiveLosses: conserva la racha activa más relevante (la key nueva es la
      // que sigue recibiendo señales reales hoy; si la vieja tenía una racha mayor sin
      // haber sido desactivada, es la más conservadora — nos quedamos con el máximo).
      const oldCkey = `${symbol}_${oldKey}`, newCkey = `${symbol}_${newKey}`;
      if (state.consecutiveLosses[oldCkey] != null) {
        state.consecutiveLosses[newCkey] = Math.max(state.consecutiveLosses[newCkey] || 0, state.consecutiveLosses[oldCkey]);
        delete state.consecutiveLosses[oldCkey];
      }
      // Si la key vieja ya estaba auto-desactivada para este símbolo, la desactivación
      // aplica igual bajo la key nueva (es la misma estrategia, solo cambió el nombre).
      if (state.autoDisabledStrategies[oldCkey] && !state.autoDisabledStrategies[newCkey]) {
        state.autoDisabledStrategies[newCkey] = { ...state.autoDisabledStrategies[oldCkey], key: newKey };
      }
      delete state.autoDisabledStrategies[oldCkey];

      console.log(`[MIGRATE] ${symbol}: fusionadas stats de '${oldKey}' -> '${newKey}' (${oldStats.wins}W/${oldStats.losses}L, ${oldStats.totalR}R)`);
    });

    // FIX (20/9): la migración de arriba cubre strategyStatsBySymbol/consecutiveLosses/
    // autoDisabledStrategies (por símbolo+estrategia), pero nunca tocaba el breaker
    // AGREGADO (across símbolos) — confirmado con /api/state real: 'ny_open_kill_zone'
    // y 'kill_zone_ny' coexistían como keys separadas en consecutiveLossesAggregate.
    // Mismo criterio que arriba: nos quedamos con el máximo de la racha activa.
    if (state.consecutiveLossesAggregate[oldKey] != null) {
      state.consecutiveLossesAggregate[newKey] = Math.max(
        state.consecutiveLossesAggregate[newKey] || 0,
        state.consecutiveLossesAggregate[oldKey]
      );
      delete state.consecutiveLossesAggregate[oldKey];
      console.log(`[MIGRATE] aggregate: fusionada racha de '${oldKey}' -> '${newKey}'`);
    }
    if (state.autoDisabledStrategiesAggregate[oldKey] && !state.autoDisabledStrategiesAggregate[newKey]) {
      state.autoDisabledStrategiesAggregate[newKey] = { ...state.autoDisabledStrategiesAggregate[oldKey], key: newKey };
    }
    delete state.autoDisabledStrategiesAggregate[oldKey];
  });
  localStorage.setItem('pt_strategy_stats_by_symbol', JSON.stringify(state.strategyStatsBySymbol));
  localStorage.setItem('pt_consecutive_losses', JSON.stringify(state.consecutiveLosses));
  localStorage.setItem('pt_auto_disabled_strategies', JSON.stringify(state.autoDisabledStrategies));
  localStorage.setItem('pt_consecutive_losses_aggregate', JSON.stringify(state.consecutiveLossesAggregate));
  localStorage.setItem('pt_auto_disabled_strategies_aggregate', JSON.stringify(state.autoDisabledStrategiesAggregate));
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
// NUEVO (18/9, auditoría completa): centraliza el efecto de "apagar la combinación
// agregada" (agregarla a DISABLED_STRATEGIES_BY_SYMBOL en los 4 símbolos, registrarla
// en autoDisabledStrategiesAggregate, avisar por push) para que lo disparen por igual
// una pérdida real en vivo (checkCircuitBreakerAggregate) y el chequeo retroactivo al
// arrancar (applyRetroactiveCircuitBreaker) — mismo patrón ya usado para el breaker
// individual (ver disableCombinationByCircuitBreaker). extra.retroactive evita el push
// cuando es solo aplicar al arrancar una regla vigente sobre estado ya conocido.
function disableAggregateByCircuitBreaker(key, streak, extra = {}) {
  if (state.autoDisabledStrategiesAggregate[key]) return; // ya estaba apagada, no repetir aviso

  Object.keys(ASSETS || {}).forEach(symbol => {
    if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol]) CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol] = [];
    if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].includes(key)) {
      CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].push(key);
    }
  });
  state.autoDisabledStrategiesAggregate[key] = { key, disabledAt: Date.now(), lossStreak: streak, ...extra };
  localStorage.setItem('pt_auto_disabled_strategies_aggregate', JSON.stringify(state.autoDisabledStrategiesAggregate));

  const tag = extra.retroactive ? ' - RETROACTIVO' : '';
  console.log(`[CIRCUIT BREAKER AGREGADO${tag}] ${key} auto-desactivada en todos los símbolos tras racha de ${streak}`);

  if (extra.retroactive) return; // aplicar regla vigente sobre estado ya conocido, sin spamear push

  const title = '🛑 Circuit breaker AGREGADO: estrategia pausada en todos los activos';
  const body = `${key} se auto-desactivó en los 4 activos tras ${streak} pérdidas seguidas repartidas entre símbolos. Revisala cuando puedas.`;
  sendPushToAll({ title, body, signal: { strategy: key, autoDisabled: true, aggregate: true } }).catch(err => console.error('Error enviando push de circuit breaker agregado:', err.message));
}

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
  disableAggregateByCircuitBreaker(key, state.consecutiveLossesAggregate[key]);
}

// NUEVO (16/9, plan de rentabilidad, punto 4): umbral escalonado por calidad
// histórica real de la combinación symbol+estrategia, en vez de un número fijo para
// todas. Lee state.strategyStatsBySymbol[symbol][key] (incluye seeded + operaciones
// reales en vivo, ya mezclados ahí desde antes). Sin historial o con expectancy no
// positiva -> defaultThreshold (estricto). Con historial real y expectancy positiva
// -> qualifiedThreshold (más tolerante, para no apagar una estrategia buena por una
// racha normal de varianza).
function getCircuitBreakerThreshold(symbol, key) {
  const cb = CONFIG.CIRCUIT_BREAKER;
  const stats = state.strategyStatsBySymbol[symbol] && state.strategyStatsBySymbol[symbol][key];
  if (stats) {
    const total = (stats.wins || 0) + (stats.losses || 0);
    const avgR = stats.avgR != null ? stats.avgR : (total > 0 ? (stats.totalR || 0) / total : 0);
    if (total >= cb.qualifiedMinSample && avgR > 0) return cb.qualifiedThreshold;
  }
  return cb.defaultThreshold;
}

// NUEVO (16/9): centraliza el efecto de "apagar la combinación" (agregarla a
// DISABLED_STRATEGIES_BY_SYMBOL, registrarla en autoDisabledStrategies, avisar por
// push) para que lo disparen por igual una pérdida real en vivo (checkCircuitBreaker),
// el seed inicial de datos históricos (seedStrategyStatsFromBacktest, ver fix del
// punto 3 del plan) y el chequeo retroactivo al arrancar (applyRetroactiveCircuitBreaker),
// sin triplicar la misma lógica. extra.seeded / extra.retroactive ajustan el mensaje y
// si corresponde mandar push (retroactive no manda, igual que el comportamiento
// original: es solo aplicar al arrancar una regla vigente sobre estado ya conocido).
function disableCombinationByCircuitBreaker(symbol, key, streak, extra = {}) {
  const ckey = `${symbol}_${key}`;
  if (state.autoDisabledStrategies[ckey]) return; // ya estaba apagada, no repetir aviso

  if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol]) CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol] = [];
  if (!CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].includes(key)) {
    CONFIG.DISABLED_STRATEGIES_BY_SYMBOL[symbol].push(key);
  }
  state.autoDisabledStrategies[ckey] = { symbol, key, disabledAt: Date.now(), lossStreak: streak, ...extra };
  localStorage.setItem('pt_auto_disabled_strategies', JSON.stringify(state.autoDisabledStrategies));

  const tag = extra.seeded ? ' - SEED' : (extra.retroactive ? ' - RETROACTIVO' : '');
  console.log(`[CIRCUIT BREAKER${tag}] ${ckey} auto-desactivada tras racha de ${streak}`);

  if (extra.retroactive) return; // aplicar regla vigente sobre estado ya conocido, sin spamear push

  const title = '🛑 Circuit breaker: estrategia pausada';
  const body = extra.seeded
    ? `${key} en ${symbol} arrancó pausada: su historial importado tiene ${streak} pérdidas seguidas sin ninguna ganada. Revisala cuando puedas.`
    : `${key} en ${symbol} se auto-desactivó tras ${streak} pérdidas seguidas. Revisala cuando puedas.`;
  sendPushToAll({ title, body, symbol, signal: { strategy: key, autoDisabled: true } }).catch(err => console.error('Error enviando push de circuit breaker:', err.message));
}

// v4.7: si una combinación symbol+strategy encadena su umbral vigente
// (getCircuitBreakerThreshold) de pérdidas seguidas, se apaga sola (sin esperar a que
// Soy sume tablas a mano) y avisa por push. Una ganada en el medio resetea el
// contador a 0 — es "pérdidas SEGUIDAS", no acumuladas.
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

  const threshold = getCircuitBreakerThreshold(symbol, key);
  if (state.consecutiveLosses[ckey] < threshold) return;
  disableCombinationByCircuitBreaker(symbol, key, state.consecutiveLosses[ckey]);
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
        // FIX (16/9, plan de rentabilidad, punto 3): un combo seeded con 0 ganadas y
        // N perdidas tiene una racha de pérdidas consecutivas conocida con certeza
        // (=N, no hay ninguna ganada en el medio que la corte), aunque no tengamos el
        // orden cronológico real de cada operación importada. Antes esto nunca tocaba
        // consecutiveLosses ni pasaba por el Circuit Breaker — quedaba corriendo en
        // vivo con 0% winrate real hasta que Soy lo notara a mano (caso real
        // detectado en el respaldo del 16/9: session_false_breakout en EURUSD,
        // 0G/6P). Con wins>0 no se puede saber el orden real de lo importado, así que
        // esos combos se dejan sin tocar acá — igual quedan protegidos por el
        // circuit breaker normal desde la primera pérdida real en vivo.
        if (CONFIG.CIRCUIT_BREAKER && CONFIG.CIRCUIT_BREAKER.enabled && s.wins === 0 && s.losses > 0) {
          const ckey = `${symbol}_${key}`;
          state.consecutiveLosses[ckey] = s.losses;
          const threshold = getCircuitBreakerThreshold(symbol, key);
          if (s.losses >= threshold) disableCombinationByCircuitBreaker(symbol, key, s.losses, { seeded: true });
        }
      }
    });
  });
  localStorage.setItem('pt_strategy_stats_by_symbol', JSON.stringify(state.strategyStatsBySymbol));
  localStorage.setItem('pt_consecutive_losses', JSON.stringify(state.consecutiveLosses));
}

// NUEVO (16/9, plan de rentabilidad, punto 5): si key está en
// CONFIG.PROBATION_STRATEGIES y todavía no se graduó, revisa si ya juntó
// CONFIG.PROBATION.minSampleToGraduate señales resueltas (sumadas entre los 4
// símbolos) con R neto positivo. Si es así, se marca como graduada (deja de estar
// silenciada en resolveCustomSignal) y se avisa una sola vez por push.
function checkProbationGraduation(key) {
  if (!CONFIG.PROBATION_STRATEGIES.includes(key)) return;
  if (state.probationGraduated[key]) return;
  let totalWins = 0, totalLosses = 0, totalR = 0;
  Object.values(state.strategyStatsBySymbol).forEach(bySymbol => {
    const s = bySymbol[key];
    if (s) { totalWins += s.wins || 0; totalLosses += s.losses || 0; totalR += s.totalR || 0; }
  });
  const total = totalWins + totalLosses;
  if (total < CONFIG.PROBATION.minSampleToGraduate) return;
  if (totalR <= 0) return; // ya tiene muestra pero expectancy todavía no es positiva, sigue en probation

  state.probationGraduated[key] = true;
  localStorage.setItem('pt_probation_graduated', JSON.stringify(state.probationGraduated));
  console.log(`[PROBATION] ${key} graduada tras ${total} señales resueltas (${totalR.toFixed(2)}R) — vuelve a notificar por push`);
  sendPushToAll({
    title: '✅ Estrategia graduada de probation',
    body: `${key} acumuló ${total} señales resueltas entre los 4 activos con expectancy positiva (${totalR.toFixed(2)}R) — ya manda notificaciones push normales.`,
    signal: { strategy: key, probationGraduated: true }
  }).catch(err => console.error('Error enviando push de graduación de probation:', err.message));
}

function reconcileStaleActiveCustomSignals(symbol) {
  // FIX (sesión hoy, complemento al de arriba): las 3 tarjetas encontradas
  // realmente rotas en producción (EURUSD bollinger_squeeze, XAUUSD
  // ema_cross_scalping, BTCUSD bollinger_squeeze) ya tienen result:"loss" en
  // signalHistory desde antes de este fix — checkHistoryOutcomes() nunca las
  // vuelve a mirar porque solo procesa entradas con result:"pending". Sin esta
  // pasada aparte quedarían rotas para siempre aunque el fix de arriba ya
  // funcione para los próximos cierres. Barre activeCustomSignals del symbol y
  // lo cruza contra CUALQUIER entrada ya resuelta de history (no solo pending),
  // usando el mismo criterio de match (symbol+strategyKey+timestamp exacto).
  Object.keys(state.activeCustomSignals).forEach(liveKey => {
    if (!liveKey.startsWith(symbol + '_')) return;
    const active = state.activeCustomSignals[liveKey];
    if (!active) return;
    const resolved = state.signalHistory.find(h =>
      h.symbol === symbol && h.timestamp === active.timestamp &&
      h.strategyKeys && h.strategyKeys[0] === active.strategyKeys[0] &&
      h.result !== 'pending'
    );
    if (resolved) {
      delete state.activeCustomSignals[liveKey];
      try { localStorage.setItem('pt_active_custom_signals', JSON.stringify(state.activeCustomSignals)); } catch (e) {}
      state.pendingCustomDisplayReset = state.pendingCustomDisplayReset || {};
      state.pendingCustomDisplayReset[liveKey] = true;
    }
  });
}

function checkHistoryOutcomes(symbol, currentPrice, candles) {
  reconcileStaleActiveCustomSignals(symbol);
  let changed = false;
  const resolvedEntries = [];
  // NUEVO (30/8): ver TP_CONFIRMATION_BUFFER_PIPS_BY_SYMBOL en CONFIG — exige que
  // el precio vaya este tanto más allá de TP1/TP2 antes de confirmar el toque,
  // para amortiguar diferencias de mecha entre el feed de datos y el broker real
  // del usuario (Exness). No toca la lógica de SL: el objetivo es reducir falsos
  // "win", no ocultar pérdidas reales.
  const asset = ASSETS[symbol];
  const pipSize = (asset && asset.pipSize) || 1;
  const bufferPips = (CONFIG.TP_CONFIRMATION_BUFFER_PIPS_BY_SYMBOL && CONFIG.TP_CONFIRMATION_BUFFER_PIPS_BY_SYMBOL[symbol]) || 0;
  const tpBuffer = bufferPips * pipSize;
  state.signalHistory.forEach(h => {
    if (h.symbol !== symbol || h.result !== 'pending') return;
    const isLong = h.type === 'long';
    const hasTp2 = h.tp2 != null;
    const rTP1 = (h.tp1Pips && h.slPips) ? +(h.tp1Pips / h.slPips).toFixed(2) : 2;
    const rTP2 = (hasTp2 && h.tp2Pips && h.slPips) ? +(h.tp2Pips / h.slPips).toFixed(2) : null;
    const tp1Level = isLong ? h.tp1 + tpBuffer : h.tp1 - tpBuffer;
    const tp2Level = hasTp2 ? (isLong ? h.tp2 + tpBuffer : h.tp2 - tpBuffer) : null;
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
        const hitTP1 = isLong ? c.high >= tp1Level : c.low <= tp1Level;
        const hitTP2 = hasTp2 && (isLong ? c.high >= tp2Level : c.low <= tp2Level);
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
        if (isLong && currentPrice >= tp2Level) { outcome = 'win'; rHit = rTP2; }
        else if (!isLong && currentPrice <= tp2Level) { outcome = 'win'; rHit = rTP2; }
        else if (isLong && currentPrice >= tp1Level) { tp1AlreadyHit = true; }
        else if (!isLong && currentPrice <= tp1Level) { tp1AlreadyHit = true; }
      } else {
        if (isLong && currentPrice >= tp1Level) { outcome = 'win'; rHit = rTP1; }
        else if (!isLong && currentPrice <= tp1Level) { outcome = 'win'; rHit = rTP1; }
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
      // FIX (30/8): esta función resuelve el historial mirando la mecha (high/low)
      // de las velas del proveedor de datos, pero el widget en vivo
      // (activeCustomSignals / evaluateCustomSignalOutcome) solo mira quote.last
      // (el tick actual) y nunca se enteraba de esta resolución. Resultado real
      // detectado: una señal quedaba "win" en signalHistory mientras el widget en
      // vivo la seguía mostrando "abierta, sin tocar TP1" — dos estados
      // contradictorios para el mismo id. Se sincroniza acá: si hay una entrada
      // activa para este symbol+estrategia con el mismo timestamp (mismo id de
      // señal), se da de baja también del tracker en vivo.
      if (h.strategyKeys && h.strategyKeys[0]) {
        const liveKey = `${h.symbol}_${h.strategyKeys[0]}`;
        const activeEntry = state.activeCustomSignals[liveKey];
        if (activeEntry && activeEntry.timestamp === h.timestamp) {
          delete state.activeCustomSignals[liveKey];
          try { localStorage.setItem('pt_active_custom_signals', JSON.stringify(state.activeCustomSignals)); } catch (e) {}
       // FIX (sesión hoy): faltaba esta línea. Sin ella, activeCustomSignals
          // quedaba limpio pero state.lastCustomDisplay (lo que expone /api/state
          // como customSignals, la tarjeta en pantalla) nunca se enteraba del
          // cierre — evaluateCustomSignalOutcome() sí marca pendingCustomDisplayReset
          // cuando cierra por tick en vivo, pero este otro camino (cierre detectado
          // acá, por mecha de vela, vía checkHistoryOutcomes) no lo hacía. Resultado
          // confirmado con /api/state real: 3 tarjetas (EURUSD bollinger_squeeze,
          // XAUUSD ema_cross_scalping, BTCUSD bollinger_squeeze) con result:"loss"
          // en history pero seguían "abiertas" en pantalla indefinidamente, porque
          // al salir de activeCustomSignals el loop de refreshActiveCustomSignalsDisplay
  state.pendingCustomDisplayReset = state.pendingCustomDisplayReset || {};
          state.pendingCustomDisplayReset[liveKey] = true;
        }
      }
    }
  });
  if (changed) {
    localStorage.setItem('pt_v4_signals', JSON.stringify(state.signalHistory));
    resolvedEntries.forEach(entry => { updatePatternStats(entry); updateStrategyStatsBySymbol(entry); updateLiveProfitabilityStats(entry); appendClosedSignal(entry); });
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
  // FIX (09/9): antes se comparaba `expectancy` (rawExpectancy encogido por
  // confidenceWeight) contra targetExpectancyLow/High. Con confidenceWeight
  // ~0.46 en la muestra típica, alcanzar targetExpectancyLow=0.35 exigía un
  // rawExpectancy real de ~0.76R -> el umbral casi nunca podía bajar y subía
  // en casi todos los ciclos (ratchet unidireccional hacia maxThreshold).
  // Ahora se decide con rawExpectancy directo; confidenceWeight solo gatea
  // si hay muestra suficiente para confiar en la decisión (>=0.3, ~7+ trades
  // con shrinkageK=15). `expectancy` se sigue guardando en stats solo a fines
  // de diagnóstico/UI, ya no participa de la decisión.
  if (confidenceWeight >= 0.3) {
    if (rawExpectancy < cfg.targetExpectancyLow) newThreshold = Math.min(cfg.maxThreshold, currentThreshold + cfg.step);
    else if (rawExpectancy > cfg.targetExpectancyHigh) newThreshold = Math.max(cfg.minThreshold, currentThreshold - cfg.step);
  }
  if (newThreshold !== currentThreshold) state.autoConfidenceThreshold[key] = newThreshold;
}
// FIX (11/9): antes runAutoTune calculaba un único umbral por símbolo, mezclando
// el historial cerrado de TODAS las estrategias de ese símbolo en una sola
// expectancy. Efecto real detectado con datos de producción: ny_open_kill_zone
// en BTCUSD (+11.17R, la mejor combinación de toda la app) compartía el mismo
// umbral adaptativo que pivots_breakout_reversal en BTCUSD (-4.29R, ya
// desactivada por Circuit Breaker) — una estrategia mala podía frenar el umbral
// arriba y bloquear señales válidas de la buena, o viceversa. Ahora se agrupa
// por symbol+estrategia (misma key que ya usan activeCustomSignals/
// lastCustomSignalAt en resolveCustomSignal), así cada combinación se ajusta
// según su propio historial real. Efecto esperado: cada key individual junta
// su muestra más despacio que antes (ya no comparte volumen con otras
// estrategias del mismo símbolo), así que puede tardar más en alcanzar
// AUTO_TUNE.minSampleSize (10) por combinación nueva.
function runAutoTune(symbol) {
  const closedSymbolAll = state.signalHistory.filter(h => h.symbol === symbol && (h.result === 'win' || h.result === 'loss'));
  const strategiesInSymbol = new Set(closedSymbolAll.map(h => h.strategyKeys && h.strategyKeys[0]).filter(Boolean));
  strategiesInSymbol.forEach(strategy => {
    const closedForStrategy = closedSymbolAll.filter(h => h.strategyKeys && h.strategyKeys[0] === strategy);
    const key = `${symbol}_${strategy}`;
    runAutoTuneForKey(key, closedForStrategy);
    ['trending', 'ranging'].forEach(regime => {
      const closedRegime = closedForStrategy.filter(h => h.regime === regime);
      if (closedRegime.length) runAutoTuneForKey(key + '_' + regime, closedRegime);
    });
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
    symbol: entry.symbol, type: entry.type, source: entry.source || 'legacy_untagged', // FIX (15/9, auditoría)
    result: entry.result, rMultiple: entry.rMultiple, timestamp: entry.timestamp,
    // NUEVO (auditoría 18/9 v2, punto A1): ver nota en resolveCustomSignal/frozen.
    provider: entry.provider || 'unknown', estimatedSpread: !!entry.estimatedSpread,
    shadow: !!entry.shadow // NUEVO (20/9)
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
// NUEVO (auditoría 18/9 v2, plan de rentabilidad — gestión de riesgo): lee
// closed_signals:HOY (ya lo escribe appendClosedSignal en cada cierre real) y decide
// si una señal nueva para `symbol` debe bloquearse. No mira señales 'pending' — solo
// resultados ya cerrados (win/loss), igual que el resto del sistema de stats. Se llama
// desde resolveCustomSignal ANTES de crear una señal nueva, nunca después.
function getTodayClosedSignals() {
  const dayKey = localDayKey(Date.now());
  try { return JSON.parse(localStorage.getItem(`closed_signals:${dayKey}`) || '[]'); }
  catch (e) { return []; }
}
function countTrailingLosses(list) {
  // list ya viene en orden de cierre (appendClosedSignal hace push); contamos desde
  // el final (el cierre más reciente) hacia atrás, cortando en la primera 'win'.
  let streak = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].result === 'loss') streak++;
    else break; // 'win' corta la racha, igual que checkCircuitBreaker
  }
  return streak;
}
function checkDailyRiskGuard(symbol) {
  const guard = CONFIG.DAILY_RISK_GUARD;
  if (!guard || !guard.enabled) return { blocked: false };

  // (20/9) las operaciones en modo sombra no cuentan: no son dinero real, no deben frenar
  // (ni gastar el tope diario de) señales reales.
  const today = getTodayClosedSignals().filter(s => !s.shadow);
  const symbolToday = today.filter(s => s.symbol === symbol);

  const symbolSignalCount = symbolToday.length;
  if (symbolSignalCount >= guard.maxSignalsPerSessionPerSymbol) {
    return { blocked: true, reason: `máx. ${guard.maxSignalsPerSessionPerSymbol} señales/sesión alcanzado en ${symbol}` };
  }

  const symbolConsecLosses = countTrailingLosses(symbolToday);
  if (symbolConsecLosses >= guard.pauseAfterConsecutiveStopsPerSymbol) {
    return { blocked: true, reason: `${symbolConsecLosses} stops seguidos en ${symbol} hoy — pausado` };
  }

  const symbolR = symbolToday.reduce((sum, s) => sum + (s.rMultiple || 0), 0);
  if (symbolR <= guard.dailyLossCapRPerSymbol) {
    return { blocked: true, reason: `tope diario de ${guard.dailyLossCapRPerSymbol}R alcanzado en ${symbol} (${symbolR.toFixed(2)}R)` };
  }

  const globalR = today.reduce((sum, s) => sum + (s.rMultiple || 0), 0);
  if (globalR <= guard.dailyLossCapRGlobal) {
    return { blocked: true, reason: `tope diario GLOBAL de ${guard.dailyLossCapRGlobal}R alcanzado (${globalR.toFixed(2)}R, los 4 activos)` };
  }

  return { blocked: false };
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
  const title = `${signal.type === 'long' ? '🟢 LONG' : '🔴 SHORT'} ${asset ? asset.name : signal.symbol}${signal.source && signal.source !== 'legacy_untagged' ? ' · ' + signal.strategyLabels[0] : ''}`;
  const confPart = (signal.confidence !== null && signal.confidence !== undefined) ? `· Confianza ${signal.confidence}%` : '';
  // NUEVO (15/9): tamaño sugerido visible en el push cuando no es el default (1) — ver
  // CONFIG.STRATEGY_RISK_WEIGHT. Puramente informativo, no ajusta nada solo.
  const weightPart = (signal.riskWeight && signal.riskWeight !== 1) ? ` · Tamaño sugerido ${signal.riskWeight}x` : '';
  const body = `Entrada ${fmt(signal.entry, signal.decimals)} · SL ${fmt(signal.sl, signal.decimals)} · TP1 ${fmt(signal.tp1, signal.decimals)}${confPart}${weightPart}`;
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
  // FIX (31/8): CONFIG.AUTO_TUNE calcula state.autoConfidenceThreshold[symbol] hace
  // rato (sube hasta 90 si a la estrategia le viene yendo mal, baja hasta 65 si le
  // viene yendo bien) pero nunca se leía en ningún lado — se calculaba y quedaba
  // guardado sin frenar nada. Confirmado con las estadísticas reales (semana 24-30/8:
  // Kill Zone Apertura NY cayó de 66.7% a 11.8% winrate operando igual de seguido, sin
  // que nada la frenara). Acá se conecta: una señal detectada con confianza por debajo
  // del umbral adaptativo de su símbolo ya NO se cuenta como operación real — no se
  // guarda en signalHistory, no se trackea en activeCustomSignals, no dispara
  // notificación push. Sigue siendo visible (se manda a renderCustomSignal) para que no
  // desaparezca de la pantalla, pero marcada como informativa (belowConfidenceThreshold)
  // para diferenciarla de una operación tomada de verdad.
  // FIX (11/9): antes leía state.autoConfidenceThreshold[symbol] (un umbral
  // compartido por todas las estrategias del símbolo). Ahora lee por
  // symbol+estrategia, en línea con el cambio en runAutoTune. Si la combinación
  // todavía no tiene umbral propio calculado (pocas operaciones cerradas), cae
  // a CONFIG.CONFIDENCE_THRESHOLD igual que antes.
  const thresholdKey = `${symbol}_${customSig.strategy}`;
  const confidenceThreshold = state.autoConfidenceThreshold[thresholdKey] || CONFIG.CONFIDENCE_THRESHOLD;
  const meetsConfidenceThreshold = customSig.confidence == null || customSig.confidence >= confidenceThreshold;
  let belowThresholdDisplay = null;
  if (isNewDirection && !inCooldown && !meetsConfidenceThreshold) {
    belowThresholdDisplay = {
      type: customSig.direction, symbol, belowConfidenceThreshold: true,
      confidence: customSig.confidence, confidenceThreshold,
      strategyLabels: [customSig.label], strategyKeys: [customSig.strategy],
      detectedAt: Date.now()
    };
    addLog(quote.source, `[${customSig.label}] señal ${customSig.direction === 'long' ? 'LONG' : 'SHORT'} detectada pero confianza ${customSig.confidence}% < umbral ${confidenceThreshold}% — no se opera`, symbol);
  }
  // NUEVO (auditoría 18/9 v2, plan de rentabilidad — gestión de riesgo): mismo patrón
  // que el gate de confianza de arriba (belowThresholdDisplay) — una señal bloqueada
  // por la guardia de riesgo diario NO se cuenta como operación real (no se guarda en
  // signalHistory/activeCustomSignals, no dispara push), pero sí se manda a
  // renderCustomSignal para que no desaparezca de la pantalla, marcada como
  // informativa.
  let riskGuardBlockedDisplay = null;
  if (isNewDirection && !inCooldown && meetsConfidenceThreshold) {
    const guardCheck = checkDailyRiskGuard(symbol);
    if (guardCheck.blocked) {
      riskGuardBlockedDisplay = {
        type: customSig.direction, symbol, riskGuardBlocked: true, riskGuardReason: guardCheck.reason,
        confidence: customSig.confidence,
        strategyLabels: [customSig.label], strategyKeys: [customSig.strategy],
        detectedAt: Date.now()
      };
      addLog(quote.source, `[${customSig.label}] señal ${customSig.direction === 'long' ? 'LONG' : 'SHORT'} detectada pero bloqueada por guardia de riesgo diario: ${guardCheck.reason}`, symbol);
    }
  }
  // NUEVO (18/9, Motor de Rentabilidad V1): mismo patrón que los dos gates de arriba —
  // corre después del riesgo diario (más barato, corta primero lo obvio) y antes de
  // crear la señal. Nunca evalúa una combinación ya desactivada por CIRCUIT_BREAKER
  // (esas ni siquiera llegan acá, se filtran antes en evaluateAll) — es una capa
  // adicional, no un reemplazo.
  let profitabilityBlockedDisplay = null;
  let profitabilityDecision = null;
  if (isNewDirection && !inCooldown && meetsConfidenceThreshold && !riskGuardBlockedDisplay) {
    profitabilityDecision = evaluateProfitability(symbol, customSig.strategy, customSig.confidence);
    addLog(quote.source, `[${customSig.label}] Motor Rentabilidad: ${profitabilityDecision.decision}/${profitabilityDecision.mode} — ${profitabilityDecision.reason}`, symbol);
    if (profitabilityDecision.decision === 'NO_TRADE') {
      profitabilityBlockedDisplay = {
        type: customSig.direction, symbol, profitabilityBlocked: true,
        profitabilityMode: profitabilityDecision.mode, profitabilityReason: profitabilityDecision.reason,
        sample: profitabilityDecision.sample, expectancyR: profitabilityDecision.expectancyR,
        winRate: profitabilityDecision.winRate, recentLosses: profitabilityDecision.recentLosses,
        confidence: customSig.confidence,
        strategyLabels: [customSig.label], strategyKeys: [customSig.strategy],
        detectedAt: Date.now()
      };
    }
  }
  // NUEVO (auditoría 20/9 v2): compuerta de costo — ver CONFIG.QUALITY_GATES. A
  // diferencia de los tres gates de arriba, no puede evaluarse antes de este punto:
  // depende de slPips, que solo existe una vez calculados entry/sl (y, en XAUUSD,
  // después del ensanche de holgura del SL) más abajo. Se declara acá para que
  // quede disponible en el return final, mismo patrón que los demás.
  let costGateBlockedDisplay = null;
  if (isNewDirection && !inCooldown && meetsConfidenceThreshold && !riskGuardBlockedDisplay && !profitabilityBlockedDisplay) {
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

    // GATE 2b — compuerta de costo (ver CONFIG.QUALITY_GATES): descarta la señal si
    // el spread (real si el proveedor lo trae, estimado si no — quote.spread ya viene
    // en pips, ver calculateSpread) supera maxSpreadPctOfStop del stop en pips. Mismo
    // patrón que riskGuardBlockedDisplay/profitabilityBlockedDisplay: no se cuenta
    // como operación real (no entra a activeCustomSignals/signalHistory, no dispara
    // push), pero sí se manda a renderCustomSignal como informativa. En XAUUSD corre
    // ya con slPips post-ensanche (arriba), así que mide el riesgo real de la operación.
    const qGates = CONFIG.QUALITY_GATES;
    if (qGates && qGates.enabled && quote.spread != null && slPips) {
      const spreadPctOfStop = quote.spread / slPips;
      state.diagnostics = state.diagnostics || { candleAge: {}, quote: {}, costGate: {} }; // E0 (solo lectura)
      state.diagnostics.costGate[symbol] = { strategy: customSig.strategy, spreadUsedPips: +Number(quote.spread).toFixed(2), stopPips: +Number(slPips).toFixed(1), spreadPctOfStop: +(spreadPctOfStop * 100).toFixed(0), wouldBlock: spreadPctOfStop > qGates.maxSpreadPctOfStop, provider: quote.source || null, at: Date.now() };
      console.log(`[E0-costo] ${symbol} ${customSig.strategy}: spread ${Number(quote.spread).toFixed(2)} pips / stop ${Number(slPips).toFixed(1)} pips = ${(spreadPctOfStop * 100).toFixed(0)}% (limite ${(qGates.maxSpreadPctOfStop * 100).toFixed(0)}%, via ${quote.source})`);
      if (spreadPctOfStop > qGates.maxSpreadPctOfStop) {
        costGateBlockedDisplay = {
          type: customSig.direction, symbol, costGateBlocked: true,
          costGateReason: `spread ${quote.spread.toFixed(1)} pips = ${(spreadPctOfStop * 100).toFixed(0)}% del stop (${slPips.toFixed(1)} pips) — supera el ${(qGates.maxSpreadPctOfStop * 100).toFixed(0)}% permitido`,
          confidence: customSig.confidence,
          strategyLabels: [customSig.label], strategyKeys: [customSig.strategy],
          detectedAt: Date.now()
        };
        addLog(quote.source, `[${customSig.label}] señal ${customSig.direction === 'long' ? 'LONG' : 'SHORT'} detectada pero descartada por compuerta de costo: ${costGateBlockedDisplay.costGateReason}`, symbol);
      }
    }

    if (!costGateBlockedDisplay) {
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
      // NUEVO (18/9, Motor de Rentabilidad V1): si la decisión fue PROBATION, el
      // multiplicador de riesgo original (STRATEGY_RISK_WEIGHT) se reduce además por
      // probationRiskMultiplier — no lo reemplaza, se combinan (ej. 1.5x * 0.5 = 0.75x).
      // (20/9) en modo sombra el tamaño sugerido es 0 (no operar con dinero real).
      riskWeight: (profitabilityDecision && profitabilityDecision.decision === 'SHADOW') ? 0 :
        ((CONFIG.STRATEGY_RISK_WEIGHT && CONFIG.STRATEGY_RISK_WEIGHT[customSig.strategy]) || 1) *
        ((profitabilityDecision && profitabilityDecision.decision === 'PROBATION') ? profitabilityDecision.riskMultiplier : 1),
      shadow: !!(profitabilityDecision && profitabilityDecision.decision === 'SHADOW'),
      profitabilityMode: (profitabilityDecision && profitabilityDecision.decision === 'SHADOW') ? 'shadow' :
        ((profitabilityDecision && profitabilityDecision.decision === 'PROBATION') ? 'probation' : 'ok'),
      profitabilityReason: profitabilityDecision ? profitabilityDecision.reason : null,
      profitabilitySample: profitabilityDecision ? profitabilityDecision.sample : null,
      profitabilityExpectancyR: profitabilityDecision ? profitabilityDecision.expectancyR : null,
      details: customSig.details, source: customSig.strategy, regime: 'n/a',
      timestamp: Date.now(), decimals: asset.decimals, detectedAt: Date.now(),
      tp1HitAt: null,
      // NUEVO (auditoría 18/9 v2, plan de rentabilidad — punto A1): etiqueta la señal
      // con el proveedor y si su spread era real o sintético en el momento en que se
      // generó. Viaja a pushSignalHistory/appendClosedSignal para poder segmentar
      // "estadísticas reales" de "contaminadas" antes de confiar en ellas para circuit
      // breaker/auto-tune/riskWeight — hoy ninguna decisión distingue esto.
      provider: quote.source || 'unknown', estimatedSpread: !!quote.estimatedSpread
    };
    state.activeCustomSignals[key] = frozen;
    state.lastCustomSignalAt[key] = frozen.detectedAt;
    try { localStorage.setItem('pt_active_custom_signals', JSON.stringify(state.activeCustomSignals)); } catch (e) {}
    try { localStorage.setItem('pt_last_custom_signal_at', JSON.stringify(state.lastCustomSignalAt)); } catch (e) {}
    pushSignalHistory(frozen);
    // NUEVO (16/9, plan de rentabilidad, punto 5): estrategias en CONFIG.PROBATION_STRATEGIES
    // sin graduar corren igual (se guardan en history/activeCustomSignals, cuentan para
    // stats y circuit breaker) pero no mandan push — ver checkProbationGraduation().
    const inProbation = CONFIG.PROBATION_STRATEGIES.includes(customSig.strategy) && !state.probationGraduated[customSig.strategy];
    if (frozen.shadow) {
      addLog(quote.source, `[${customSig.label}] señal ${customSig.direction === 'long' ? 'LONG' : 'SHORT'} registrada en MODO SOMBRA (sin push, tamaño 0) — ${symbol} juntando muestra LIVE`, symbol);
    } else if (inProbation) {
      addLog(quote.source, `[${customSig.label}] señal ${customSig.direction === 'long' ? 'LONG' : 'SHORT'} registrada en modo probation (sin push) — estrategia nueva, esperando muestra mínima`, symbol);
    } else {
      notifyNewSignal(frozen);
    }
    } // cierre if (!costGateBlockedDisplay)
  }
  const frozen = state.activeCustomSignals[key];
  if (!frozen) return belowThresholdDisplay || riskGuardBlockedDisplay || profitabilityBlockedDisplay || costGateBlockedDisplay;
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
  // FIX (11/9): antes era "{ ...frozen, ... }", que desparramaba los campos de la
  // señal (type, entry, sl, tp1...) sueltos en el objeto de nivel superior. index.html
  // (renderStrategySlot, renderAllStrategyCards) espera esos datos anidados en una
  // propiedad "frozen" (const s = d.frozen; filter(s.d.frozen)) — como esa propiedad
  // nunca existía, la tarjeta nunca mostraba ninguna señal activa (activeSlots siempre
  // vacío), aunque la señal sí se guardara en activeCustomSignals/signalHistory (por
  // eso aparecía en el historial "en curso") y sí disparara el push (notifyNewSignal
  // usa el frozen original, no este valor de retorno).
  return { frozen, currentPrice: quote.last, hitTP: hitTP1, hitTP1, hitTP2, hitSL };
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
// ETAPA 0 (v4.8.1): instrumentación de diagnóstico. Solo LEE y guarda contadores en
// state.diagnostics; no toca señales ni decisiones.
function recordCandleAgeDiagnostic(symbol, candles, tf) {
  try {
    state.diagnostics = state.diagnostics || { candleAge: {}, quote: {}, costGate: {} };
    const tfMin = ({ '5m': 5, '15m': 15, '1h': 60 })[tf] || 15;
    const last = candles && candles.length ? candles[candles.length - 1] : null;
    if (!last) return;
    const ageMin = +(((Date.now() - last.time) / 60000)).toFixed(1);
    const inProgress = ageMin >= 0 && ageMin < tfMin;
    const prev = state.diagnostics.candleAge[symbol] || { cycles: 0, inProgressCycles: 0 };
    const rec = {
      tf, lastCandleOpenUtc: new Date(last.time).toISOString(), ageMin, inProgress,
      cycles: prev.cycles + 1, inProgressCycles: prev.inProgressCycles + (inProgress ? 1 : 0),
      at: Date.now()
    };
    rec.inProgressPct = +((rec.inProgressCycles / rec.cycles) * 100).toFixed(0);
    state.diagnostics.candleAge[symbol] = rec;
    console.log(`[E0-vela] ${symbol} ${tf}: ultima vela abierta ${rec.lastCandleOpenUtc}, edad ${ageMin} min, ${inProgress ? 'EN FORMACION' : 'cerrada'} (${rec.inProgressCycles}/${rec.cycles} ciclos en formacion)`);
  } catch (e) {}
}
function recordQuoteDiagnostic(symbol, quote) {
  try {
    state.diagnostics = state.diagnostics || { candleAge: {}, quote: {}, costGate: {} };
    const asset = ASSETS[symbol];
    const bidEqAsk = quote.bid != null && quote.ask != null && quote.bid === quote.ask;
    state.diagnostics.quote[symbol] = {
      source: quote.source || null, last: quote.last, bid: quote.bid, ask: quote.ask,
      spreadPips: quote.spread != null ? +Number(quote.spread).toFixed(2) : null,
      estimatedSpread: !!quote.estimatedSpread, bidEqualsAsk: bidEqAsk,
      estimatedTablePips: (CONFIG.ESTIMATED_SPREAD_PIPS_BY_SYMBOL && CONFIG.ESTIMATED_SPREAD_PIPS_BY_SYMBOL[symbol]) || null,
      pipSize: asset ? asset.pipSize : null, at: Date.now()
    };
    console.log(`[E0-quote] ${symbol} via ${quote.source}: spread usado por la compuerta = ${state.diagnostics.quote[symbol].spreadPips} pips (bid==ask: ${bidEqAsk}, estimado: ${!!quote.estimatedSpread}, tabla Exness: ${state.diagnostics.quote[symbol].estimatedTablePips})`);
  } catch (e) {}
}
function getDiagnostics() {
  const usage = {};
  Object.keys(PROVIDER_DAILY_LIMITS).forEach(p => { const u = RequestTracker.getUsage(p); usage[p] = { used: u.used, limit: u.limit }; });
  return {
    ...(state.diagnostics || { candleAge: {}, quote: {}, costGate: {} }),
    providerUsage: usage,
    env: { TWELVEDATA_DAILY_LIMIT: process.env.TWELVEDATA_DAILY_LIMIT === undefined ? '(sin definir -> 800 por defecto)' : process.env.TWELVEDATA_DAILY_LIMIT, twelveDataKeyPresent: !!(state.apiKeys && state.apiKeys.twelveData) },
    engineVersion: '4.8.1-E0',
    generatedAt: Date.now()
  };
}

async function refreshAsset(symbol, forceRefresh = false) {
  const asset = ASSETS[symbol];
  renderMarketBanner(symbol); renderAssetHoursPill(symbol); renderApiError(symbol, null);
  // NUEVO (20/9): horarios reales por instrumento (ver getMarketStatus). Cerrado => no se
  // piden datos. Abierto pero en tramo de bloqueo (previo/posterior a pausa, rollover) o con
  // feed sin velas nuevas => se sigue trackeando SL/TP pero NO se generan señales nuevas.
  const mkt = getMarketStatus(symbol);
  state.marketStatus = state.marketStatus || {};
  state.marketStatus[symbol] = mkt;
  if (!mkt.open) {
    markMarketClosedDisplays(symbol, mkt.reason);
    renderSignal(symbol, { type: 'market-closed', reason: mkt.reason });
    return;
  }
  clearMarketClosedDisplays(symbol);
  try {
    // FIX (09/9): getQuote ahora también cae a un fallback (último quote exitoso
    // cacheado en state.lastQuote) en vez de rechazar el Promise.all entero y
    // pisar el signal con 'no-data' cuando el fallo es puntual/transitorio. Si no
    // hay quote cacheado todavía para el símbolo, se re-lanza el error original
    // y el ciclo cae al catch de abajo como antes (comportamiento sin cambios
    // para el primer fallo en frío).
    const [quote, ohlcv] = await Promise.all([
      MarketDataProvider.getQuote(symbol, forceRefresh).catch(error => {
        const cached = state.lastQuote && state.lastQuote[symbol];
        const age = cached ? Date.now() - cached.timestamp : Infinity;
        if (cached && age <= CONFIG.QUOTE_CACHE_MAX_AGE_MS) { addLog('cache', `quote en vivo falló (${error.message}), usando último quote cacheado (${Math.round(age / 1000)}s)`, symbol); return cached; }
        throw error;
      }),
      MarketDataProvider.getOHLCV(symbol, state.currentTF, 100, forceRefresh).catch(() => (state.klineHistory[symbol] && state.klineHistory[symbol][state.currentTF]) || new OHLCVData([]))
    ]);
    updatePriceUI(symbol, quote, asset);
    recordQuoteDiagnostic(symbol, quote); // E0 (solo lectura)
    recordCandleAgeDiagnostic(symbol, ohlcv.candles, state.currentTF); // E0 (solo lectura)
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

    const feed = getFeedStatus(ohlcv.candles, state.currentTF);
    const signalBlockReason = !mkt.signalsAllowed ? mkt.reason
      : (feed.stale ? `feed sin velas nuevas hace ${feed.ageMin} min (posible pausa/feriado no listado o proveedor caído)` : null);
    state.marketStatus[symbol] = { ...mkt, feedStale: feed.stale, feedAgeMin: feed.ageMin, signalBlockReason };
    if (signalBlockReason) {
      addLog('schedule', `sin señales nuevas: ${signalBlockReason}`, symbol);
      refreshActiveCustomSignalsDisplay(symbol, quote, new Set());
      return;
    }

    try {
      // v4.7.3 (Etapa 3 — scoring contextual): se pasa el historial reciente
      // símbolo+estrategia como symbolStats, 5º parámetro nuevo de evaluateAll().
      // Cierra el pendiente ya anotado en el changelog de custom-strategies.js
      // (punto 8): la función es pura, no tiene acceso directo a Supabase/state.
      // v4.8: se agrega newsContext (6º parámetro) — evento de alto impacto en USD
      // dentro de ±60min, si lo hay. Uso exclusivo de computeContextualScore(): ajusta
      // el mismo score informativo que ya existe, no agrega campos nuevos a la señal
      // ni se muestra en la UI (decisión explícita de Soy).
       const newsContext = await NewsCalendar.getNearbyHighImpact(NEWS_CURRENCIES_BY_SYMBOL[symbol] || ['USD'], 60);
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
        if (customDisplay && !customDisplay.belowConfidenceThreshold) {
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
// (20/9) Retirado el chequeo liviano de precio para BTC/ETH (quickPriceCheck / cryptoQuickCheck*):
// era solo para crypto, que salió de la app.

let autoRefreshTimer = null;
async function autoRefreshTick() {
  try {
    await refreshAllData(false);
  } catch (e) {
    console.warn('autoRefreshTick: error en refreshAllData', e.message);
  } finally {
    const delay = getDynamicRefreshIntervalMs();
    addLog('scheduler', `Próximo refresco en ${Math.round(delay / 1000)}s (${isKillZoneWindow() ? 'Kill Zone NY activa' : 'horario normal'})`, 'ALL');
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

// FIX (15/9, auditoría): checkCircuitBreaker() solo corre cuando llega un resultado
// nuevo (push de una operación cerrada) — si se baja CONFIG.CIRCUIT_BREAKER.
// consecutiveLossThreshold (como pasó el 14/9, de 5 a 3), una racha que ya estaba en
// curso ANTES del cambio y ya iguala o supera el nuevo umbral queda "viva" hasta la
// próxima pérdida de esa misma combinación, en vez de cortarse apenas arranca el
// proceso con el umbral nuevo. Este chequeo corre una sola vez al cargar el módulo
// (require de engine.js) y aplica la regla vigente contra el estado ya guardado.
// FIX (16/9): threshold pasó a ser por combinación (getCircuitBreakerThreshold), ya
// no un único valor fijo para todas — se evalúa por ckey en vez de calcularlo una
// sola vez afuera del loop.
function applyRetroactiveCircuitBreaker() {
  if (!CONFIG.CIRCUIT_BREAKER || !CONFIG.CIRCUIT_BREAKER.enabled) return;

  // FIX (auditoría 18/9, bug confirmado con datos reales de /api/state: session_breakout_vwap
  // en XAUUSD, 0 wins/5 losses en strategyStatsBySymbol pero consecutiveLosses quedó en 1).
  // seedStrategyStatsFromBacktest() solo corrige consecutiveLosses para combos que NO existían
  // todavía en state.strategyStatsBySymbol al momento del seed (ver guard de la línea ~1709).
  // Una combinación que ya existía de antes del fix del 16/9 queda con el contador viejo para
  // siempre, y este chequeo retroactivo confiaba ciegamente en ese contador. Antes de leer
  // state.consecutiveLosses, lo recalculamos acá para cualquier combo con wins===0 && losses>0
  // que no esté ya desactivada — misma certeza que en el seed: sin ninguna ganada en el medio,
  // la racha es exactamente losses.
  Object.entries(state.strategyStatsBySymbol || {}).forEach(([symbol, stratsForSymbol]) => {
    Object.entries(stratsForSymbol || {}).forEach(([key, s]) => {
      const ckey = `${symbol}_${key}`;
      if (state.autoDisabledStrategies[ckey]) return; // ya estaba apagada, no repetir
      if (!s || s.wins !== 0 || !(s.losses > 0)) return;
      if (state.consecutiveLosses[ckey] === s.losses) return; // ya estaba correcto, no tocar
      state.consecutiveLosses[ckey] = s.losses;
    });
  });

  Object.keys(state.consecutiveLosses || {}).forEach(ckey => {
    const streak = state.consecutiveLosses[ckey];
    if (state.autoDisabledStrategies[ckey]) return; // ya estaba apagada, no repetir
    const sepIdx = ckey.indexOf('_');
    if (sepIdx < 0) return;
    const symbol = ckey.slice(0, sepIdx), key = ckey.slice(sepIdx + 1);
    const threshold = getCircuitBreakerThreshold(symbol, key);
    if (streak < threshold) return;
    disableCombinationByCircuitBreaker(symbol, key, streak, { retroactive: true });
  });

  localStorage.setItem('pt_consecutive_losses', JSON.stringify(state.consecutiveLosses));

  // FIX (18/9, auditoría completa): mismo chequeo retroactivo que arriba, pero para el
  // breaker AGREGADO — cubre el caso de una racha que ya cruzaba
  // consecutiveLossThresholdAggregate antes de que corriera este código (ej. estado
  // cargado de Supabase) y todavía no estaba registrada en
  // autoDisabledStrategiesAggregate. disableAggregateByCircuitBreaker ya filtra
  // internamente las combinaciones que ya estaban apagadas, así que no repite aviso.
  if (CONFIG.CIRCUIT_BREAKER && CONFIG.CIRCUIT_BREAKER.enabled) {
    const aggThreshold = CONFIG.CIRCUIT_BREAKER.consecutiveLossThresholdAggregate || (CONFIG.CIRCUIT_BREAKER.consecutiveLossThreshold * 2);
    Object.keys(state.consecutiveLossesAggregate || {}).forEach(key => {
      const streak = state.consecutiveLossesAggregate[key];
      if (streak < aggThreshold) return;
      disableAggregateByCircuitBreaker(key, streak, { retroactive: true });
    });
  }
}

// FIX (auditoría 18/9, riesgo estructural): ETH_VWAP_SCALP_ENABLED y
// ETH_MOMENTUM_BREAKOUT_ENABLED en custom-strategies.js se sincronizaban a mano contra
// CONFIG.ENABLED_STRATEGIES, sin lectura cruzada entre archivos (lo decía el propio
// comentario del código). Es la misma clase de error humano que ya causó el bug de
// STRATEGY_RISK_WEIGHT con la key vieja 'ny_open_kill_zone'. Esto lo corta al arrancar
// el proceso en vez de depender de que alguien se acuerde de tocar los dos lados.
function assertStrategyFlagsSync() {
  const checks = [
    { flag: 'ETH_VWAP_SCALP_ENABLED', key: 'eth_vwap_scalp', value: CustomStrategies.ETH_VWAP_SCALP_ENABLED },
    { flag: 'ETH_MOMENTUM_BREAKOUT_ENABLED', key: 'eth_momentum_breakout', value: CustomStrategies.ETH_MOMENTUM_BREAKOUT_ENABLED },
    // NUEVO (20/9): mismos flags para las demás estrategias apagadas, para no gastar cómputo
    // ni ensuciar logs con señales que la whitelist descarta igual.
    { flag: 'SESSION_FALSE_BREAKOUT_ENABLED', key: 'session_false_breakout', value: CustomStrategies.SESSION_FALSE_BREAKOUT_ENABLED },
    { flag: 'PRICE_ACTION_RSI_EMA_ENABLED', key: 'price_action_rsi_ema', value: CustomStrategies.PRICE_ACTION_RSI_EMA_ENABLED },
    { flag: 'RSI_DIVERGENCE_ENABLED', key: 'rsi_divergence', value: CustomStrategies.RSI_DIVERGENCE_ENABLED }
  ];
  checks.forEach(({ flag, key, value }) => {
    const inWhitelist = CONFIG.ENABLED_STRATEGIES.includes(key);
    if (value !== inWhitelist) {
      throw new Error(
        `[SYNC CHECK] custom-strategies.js:${flag}=${value} no coincide con ` +
        `engine.js:CONFIG.ENABLED_STRATEGIES.includes('${key}')=${inWhitelist}. ` +
        `Corregí los dos lados antes de arrancar.`
      );
    }
  });
}
// NUEVO (20/9): BTCUSD/ETHUSD salieron de ASSETS, así que checkHistoryOutcomes() ya no corre
// para ellos. Las operaciones que hubieran quedado 'pending' (y sus entradas en
// activeCustomSignals) se quedarían "en curso" para siempre. Se retiran una sola vez, al
// arrancar: result 'expired' con 0R — 'expired' NO cuenta para winrate/expectancy/circuit
// breaker (solo cuentan 'win'/'loss'), así que no toca ninguna estadística. El historial
// ya cerrado (ganadas/perdidas de BTC/ETH) se conserva intacto.
function retireRemovedSymbols() {
  let retired = 0;
  (state.signalHistory || []).forEach(h => {
    if (h && h.result === 'pending' && h.symbol && !ASSETS[h.symbol]) {
      h.result = 'expired'; h.rMultiple = 0; h.retiredReason = 'activo retirado de la app'; retired++;
    }
  });
  let activeRemoved = 0;
  Object.keys(state.activeCustomSignals || {}).forEach(k => {
    const sym = k.slice(0, k.indexOf('_'));
    if (sym && !ASSETS[sym]) { delete state.activeCustomSignals[k]; activeRemoved++; }
  });
  if (retired || activeRemoved) {
    try { localStorage.setItem('pt_v4_signals', JSON.stringify(state.signalHistory)); } catch (e) {}
    try { localStorage.setItem('pt_active_custom_signals', JSON.stringify(state.activeCustomSignals)); } catch (e) {}
    console.log(`[retiro de activos] ${retired} operaciones 'pending' y ${activeRemoved} señales activas de símbolos retirados marcadas como expiradas (0R, sin impacto en estadísticas)`);
  }
}
retireRemovedSymbols();
assertStrategyFlagsSync();
migrateRenamedStrategyKeys();
applyRetroactiveCircuitBreaker();

module.exports = {
  state, CONFIG, ASSETS, refreshAllData, refreshAsset, BacktestEngine,
  startAutoRefreshLoop, stopAutoRefreshLoop, getDynamicRefreshIntervalMs, isKillZoneWindow,
  getDiagnostics,
  getMarketStatus
};
