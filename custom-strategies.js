// ============================================================
// ESTRATEGIAS INDEPENDIENTES - PulseTrade PRO v4.8 (CORREGIDO)
// ============================================================
// Estas 8 estrategias (Kill Zone Apertura NY, Pivots Breakout & Reversal,
// Price Action + RSI + EMA, Supply and Demand, EMA Cross Scalping,
// Divergencia RSI, Bollinger Squeeze, ETH VWAP Trend Scalp) son el único
// motor de señales del engine — no pasan por ningún filtro global de
// confluencia (premium/discount, HTF trend, etc). Cada una se evalúa por
// sí sola, con su propia gestión de riesgo, tal como fueron definidas.
// (Sesión 19/8: se sacaron EUR London Pullback VWAP y XAU VWAP Reversion
// Scalp por usar datos de volumen simulados/estimados en OTC — decisión
// del usuario de operar solo con datos reales. El motor SMC se eliminó
// por completo de engine.js el mismo día — v4.5, ver changelog en el
// encabezado de ese archivo — así que estas 8 ya no comparten ciclo con
// ningún análisis SMC: son la única fuente de señales.)
//
// Cómo se integra en engine.js (dentro de refreshAsset(), en cada ciclo):
//   const CustomStrategies = require('./custom-strategies');
//   const customSignals = CustomStrategies.evaluateAll(ohlcv.candles, symbol, asset, htfOhlcv?.candles);
//   customSignals.forEach(sig => resolveCustomSignal(symbol, quote, sig, asset));
// (resolveCustomSignal vive en engine.js, no en este archivo)
//
// NOTA: htfCandles es opcional, pero si no se pasa, "Supply and Demand"
// pierde el filtro de tendencia mayor (EMA20/EMA50 en HTF) y arma sus
// zonas con el mismo timeframe de entrada. Pasarlo siempre que se pueda.
// ============================================================

// ---------------------------------------------------------
// CORRECCIONES APLICADAS EN ESTA VERSIÓN (ver changelog al final)
// ---------------------------------------------------------

// ---------------------------------------------------------
// INDICADORES BASE (RSI, MACD, SMA, EMA) - no existían en engine.js
// ---------------------------------------------------------

function calculateSMASeries(candles, period) {
  const closes = candles.map(c => c.close);
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    out[i] = sum / period;
  }
  return out;
}

// CORREGIDO: antes existía una copia idéntica de esta función llamada
// calculateEMASeriesFromIndex0. Se unificó en una sola, usada tanto para
// EMA20/EMA50/EMA9/EMA21 como para el cálculo interno del MACD.
function calculateEMASeries(candles, period) {
  const closes = candles.map(c => c.close);
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function calculateRSISeries(candles, period = 14) {
  const closes = candles.map(c => c.close);
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}

// MACD estándar (12,26,9): línea MACD, línea señal, histograma
function calculateMACDSeries(candles, fast = 12, slow = 26, signalPeriod = 9) {
  const n = candles.length;
  const emaFastFull = calculateEMASeries(candles, fast);
  const emaSlowFull = calculateEMASeries(candles, slow);
  const macdLine = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (emaFastFull[i] !== null && emaSlowFull[i] !== null) macdLine[i] = emaFastFull[i] - emaSlowFull[i];
  }
  // señal = EMA9 de la línea MACD (solo sobre los valores no-null)
  const macdValues = [];
  const macdIndexMap = [];
  macdLine.forEach((v, i) => { if (v !== null) { macdValues.push(v); macdIndexMap.push(i); } });
  const signalLine = new Array(n).fill(null);
  if (macdValues.length >= signalPeriod) {
    const k = 2 / (signalPeriod + 1);
    let ema = macdValues.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
    signalLine[macdIndexMap[signalPeriod - 1]] = ema;
    for (let i = signalPeriod; i < macdValues.length; i++) {
      ema = macdValues[i] * k + ema * (1 - k);
      signalLine[macdIndexMap[i]] = ema;
    }
  }
  const histogram = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (macdLine[i] !== null && signalLine[i] !== null) histogram[i] = macdLine[i] - signalLine[i];
  }
  return { macdLine, signalLine, histogram };
}

// ---------------------------------------------------------
// Utilidades de tiempo (hora real de Nueva York, con DST automático)
// ---------------------------------------------------------
// Se usa el timezone real 'America/New_York' en vez de un offset fijo
// (ej. "ARG = NY + 1h"), porque ese offset cambia con el horario de
// verano de EE.UU. (EDT/EST) y un valor fijo queda mal la mitad del año.

function getNYTimeParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t).value;
  return {
    weekday: get('weekday'),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10)
  };
}

// ---------------------------------------------------------
// Utilidades de tiempo (hora real de Londres, con DST automático)
// ---------------------------------------------------------

// v4.9 (27/8): ver justificación completa junto al uso, en evaluateAll().
// Debe coincidir manualmente con si 'eth_vwap_scalp' está en
// engine.js:CONFIG.ENABLED_STRATEGIES — no hay lectura cruzada entre archivos.
const ETH_VWAP_SCALP_ENABLED = false;

// v4.10 (29/8): ESTRATEGIA NUEVA — ver detectEthMomentumBreakout() más abajo.
// Debe coincidir manualmente con si 'eth_momentum_breakout' está en
// engine.js:CONFIG.ENABLED_STRATEGIES — no hay lectura cruzada entre archivos.
const ETH_MOMENTUM_BREAKOUT_ENABLED = true;

function getLondonTimeParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/London', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t).value;
  return {
    weekday: get('weekday'),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10)
  };
}

// Ventanas de sesión estándar (hora de Londres). Definidas acá para que
// las tres estrategias VWAP compartan el mismo criterio de sesión.
//   - Londres: 08:00-16:30 hora de Londres.
//   - Apertura NY: 13:30-16:00 hora de Londres (= 8:30-11:00 NY aprox, ya
//     incluye el solape con Londres).
//   - Solape Londres-NY: 13:00-16:00 hora de Londres.
function isLondonSession(ms) {
  const p = getLondonTimeParts(ms);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const m = p.hour * 60 + p.minute;
  return m >= 8 * 60 && m <= 16 * 60 + 30;
}
function isLondonNYOverlap(ms) {
  const p = getLondonTimeParts(ms);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const m = p.hour * 60 + p.minute;
  return m >= 13 * 60 && m <= 16 * 60;
}
function isNYOpenWindow(ms) {
  const p = getLondonTimeParts(ms);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const m = p.hour * 60 + p.minute;
  return m >= 13 * 60 + 30 && m <= 16 * 60;
}

// ---------------------------------------------------------
// VWAP intradía con bandas de desvío estándar
// ---------------------------------------------------------
// Se reinicia cada día de trading (día calendario en hora de Nueva York,
// mismo criterio que ya usa Kill Zone NY, para que todas las estrategias
// del archivo compartan el mismo corte de "día").
//
// LIMITACIÓN CONOCIDA: EURUSD y XAUUSD son instrumentos OTC/forex — no
// existe un volumen de mercado centralizado real para ellos, y según el
// proveedor de datos activo (ver ASSETS.EURUSD/XAUUSD.providerPriority en
// engine.js) el campo `volume` puede venir en 0 o no ser confiable. Si el
// volumen acumulado del día da 0, esta función cae automáticamente a un
// promedio simple del precio típico (equivalente a un VWAP sin ponderar)
// en vez de dividir por cero, y lo deja registrado con console.warn para
// poder verificarlo en los logs de producción.
// CORRECCIÓN (27/8): el comentario original acá decía que ETHUSD sí tenía
// volumen real "vía Binance/CoinGecko". Confirmado con engine.js que es
// falso en producción: Binance da 451 desde Render (nunca se usa), y el
// providerPriority de ETHUSD prioriza CoinGecko, cuyo fetchOHLCV (basado en
// /market_chart) hardcodea volume:0 en cada vela — nunca trae volumen real.
// Por eso ETHUSD cae al mismo fallback que EURUSD/XAUUSD. Ver ETH_VWAP_SCALP_ENABLED
// más abajo: por este motivo la estrategia que depende de esto quedó deshabilitada.
function calculateVWAPSeries(candles) {
  const n = candles.length;
  const vwap = new Array(n).fill(null);
  const upperBand = new Array(n).fill(null);
  const lowerBand = new Array(n).fill(null);
  let dateKey = null;
  let cumPV = 0, cumVol = 0, cumTP = 0, count = 0, cumSqDiffPV = 0;
  let usedVolumeFallback = false;

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const dk = getNYTimeParts(c.time).dateKey;
    if (dk !== dateKey) {
      // Nuevo día de trading: reiniciar acumuladores
      dateKey = dk;
      cumPV = 0; cumVol = 0; cumTP = 0; count = 0; cumSqDiffPV = 0;
    }
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 0;
    cumVol += vol;
    cumPV += typicalPrice * vol;
    cumTP += typicalPrice;
    count++;

    let vwapNow;
    if (cumVol > 0) {
      vwapNow = cumPV / cumVol;
    } else {
      // Fallback: sin volumen confiable, promedio simple del precio típico
      usedVolumeFallback = true;
      vwapNow = cumTP / count;
    }
    vwap[i] = vwapNow;

    // Desvío estándar acumulado del día respecto al VWAP (para las bandas)
    const diff = typicalPrice - vwapNow;
    cumSqDiffPV += (cumVol > 0 ? (diff * diff * vol) : (diff * diff));
    const variance = cumVol > 0 ? (cumSqDiffPV / cumVol) : (cumSqDiffPV / count);
    const std = Math.sqrt(Math.max(0, variance));
    upperBand[i] = vwapNow + 2 * std;
    lowerBand[i] = vwapNow - 2 * std;
  }

  if (usedVolumeFallback) {
    console.warn('[custom-strategies] VWAP calculado sin volumen confiable (fallback a precio típico promedio) — revisar proveedor de datos para este símbolo.');
  }

  return { vwap, upperBand, lowerBand };
}

// ---------------------------------------------------------
// Sesgo direccional en H1 (EMA20/EMA50), reutilizado por las estrategias
// VWAP que requieren contexto de tendencia mayor antes de operar en M5/M15
// ---------------------------------------------------------
function getH1Bias(htfCandles) {
  if (!htfCandles || htfCandles.length < 50) return { bias: 'no_trade', reason: 'HTF insuficiente (menos de 50 velas H1)' };
  const ema20 = calculateEMASeries(htfCandles, 20);
  const ema50 = calculateEMASeries(htfCandles, 50);
  const i = htfCandles.length - 1;
  const price = htfCandles[i].close;
  const e20 = ema20[i], e50 = ema50[i];
  if (e20 === null || e50 === null) return { bias: 'no_trade', reason: 'EMA H1 no calculable aún' };
  if (price > e20 && price > e50 && e20 > e50) return { bias: 'long', reason: `H1 alcista: precio ${price.toFixed(5)} > EMA20 (${e20.toFixed(5)}) > EMA50 (${e50.toFixed(5)})` };
  if (price < e20 && price < e50 && e20 < e50) return { bias: 'short', reason: `H1 bajista: precio ${price.toFixed(5)} < EMA20 (${e20.toFixed(5)}) < EMA50 (${e50.toFixed(5)})` };
  return { bias: 'no_trade', reason: 'H1 lateral o EMAs cruzadas sin dirección clara' };
}

// ---------------------------------------------------------
// ESTRATEGIA 1: KILL ZONE APERTURA DE NUEVA YORK (9:30 AM real)
// ---------------------------------------------------------
// Implementación fiel al método de la infografía. Sin agregados propios
// (nada de Silver Bullet, MACD, Order Blocks ni FVG acá):
//   1. Vela de referencia: 9:30-9:45 hora de Nueva York (una sola, TF 15m,
//      o el rango agregado de esas velas si el TF es menor a 15m).
//   2. Confirmación: la PRIMERA vela después de las 9:45 que CIERRA por
//      encima del máximo (compra) o por debajo del mínimo (venta) de la
//      vela de referencia.
//   3. Entrada: en el cierre de esa misma vela de confirmación.
//   4. Stop Loss: del otro lado del rango de referencia (mínimo para
//      compra, máximo para venta).
//   5. Take Profit: mínimo 1.5R, ideal 2R (tp1 = 1.5R, tp2 = 2R).
//   6. Si no hay ruptura confirmada -> no hay señal (cubre el escenario
//      de mercado lateral sin necesidad de ningún filtro adicional).
//   7. Si la ruptura ya ocurrió en una vela anterior, no se repite la
//      señal (solo dispara en la vela exacta de la confirmación).
// Gestión de riesgo sugerida por la infografía (no está en el código,
// es decisión de tamaño de posición): 0.5%-1% del capital por operación.

function detectNYOpenKillZone(candles) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null, tp2: null, mode: null };
  if (!candles || candles.length < 5) return result;

  const last = candles[candles.length - 1];
  const lastNY = getNYTimeParts(last.time);
  if (lastNY.weekday === 'Sat' || lastNY.weekday === 'Sun') return result;

  const openMin = 9 * 60 + 30;   // 9:30 NY
  const refEndMin = 9 * 60 + 45; // 9:45 NY
  const nowMin = lastNY.hour * 60 + lastNY.minute;
  if (nowMin < refEndMin) return result; // la vela de referencia todavía no cerró

  // Ubicar las velas del mismo día que caen dentro de 9:30-9:45 NY
  let windowStartIdx = -1, windowEndIdx = -1;
  for (let i = candles.length - 1; i >= 0 && i >= candles.length - 200; i--) {
    const p = getNYTimeParts(candles[i].time);
    if (p.dateKey !== lastNY.dateKey) break; // se salió del día de hoy
    const m = p.hour * 60 + p.minute;
    if (m >= openMin && m < refEndMin) {
      if (windowEndIdx === -1) windowEndIdx = i;
      windowStartIdx = i;
    } else if (m < openMin) {
      break; // ya pasamos la apertura, no hay más velas de referencia que buscar
    }
  }
  if (windowStartIdx === -1 || windowEndIdx === -1) return result;

  // La primera vela de la ventana debe ser justo la de las 9:30 (no una
  // posterior por datos faltantes), para no calcular un rango incompleto.
  const firstWindowNY = getNYTimeParts(candles[windowStartIdx].time);
  if (firstWindowNY.hour * 60 + firstWindowNY.minute !== openMin) return result;

  const windowCandles = candles.slice(windowStartIdx, windowEndIdx + 1);
  const rangeHigh = Math.max(...windowCandles.map(c => c.high));
  const rangeLow = Math.min(...windowCandles.map(c => c.low));

  // Velas posteriores a la ventana de referencia, mismo día -> zona de confirmación
  const confirmCandles = candles.slice(windowEndIdx + 1).filter(c => getNYTimeParts(c.time).dateKey === lastNY.dateKey);
  if (!confirmCandles.length) return result;

  // Primera vela que cierra fuera del rango
  let breakoutCandle = null, direction = null;
  for (const c of confirmCandles) {
    if (c.close > rangeHigh) { breakoutCandle = c; direction = 'bull'; break; }
    if (c.close < rangeLow) { breakoutCandle = c; direction = 'bear'; break; }
  }
  if (!breakoutCandle) return result; // sin ruptura confirmada todavía (mercado lateral)
  if (breakoutCandle !== last) return result; // la ruptura ya pasó antes, no repetir señal

  const entry = last.close;
  if (direction === 'bull') {
    result.bullish = true;
    result.sl = rangeLow;
    result.details.push('Ruptura confirmada del máximo de la vela 9:30-9:45 NY');
  } else {
    result.bearish = true;
    result.sl = rangeHigh;
    result.details.push('Ruptura confirmada del mínimo de la vela 9:30-9:45 NY');
  }
  result.entry = entry;
  result.mode = 'breakout_confirmation';
  const risk = Math.abs(entry - result.sl);
  result.tp1 = result.bullish ? entry + risk * 1.5 : entry - risk * 1.5; // objetivo mínimo 1.5R
  result.tp2 = result.bullish ? entry + risk * 2 : entry - risk * 2;     // objetivo ideal 2R

  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 2: PIVOTS BREAKOUT & REVERSAL
// ---------------------------------------------------------
// Parámetros:
//   - PH (pivot high): máximo de la vela > máximo de las 4 anteriores y > máximo de las 2 siguientes
//   - PL (pivot low): mínimo de la vela < mínimo de las 4 anteriores y < mínimo de las 2 siguientes
//   - Sin restricción horaria. Timeframe recomendado: 15m
//   - Modalidad A (Ruptura): cruce de SMA5/SMA10 (o alineación ya vigente) + MACD a favor
//   - Modalidad B (Reversión): barrida del pivote + divergencia de MACD contra el precio
//   - SL = 1.5% del nivel de pivote roto
//   - TP1 = riesgo x2 (RR 1:2 fijo)

function findStrictPivotHighs(candles) {
  const pivots = [];
  for (let i = 4; i < candles.length - 2; i++) {
    const c = candles[i];
    let ok = true;
    for (let j = 1; j <= 4; j++) if (candles[i - j].high >= c.high) ok = false;
    for (let j = 1; j <= 2; j++) if (candles[i + j].high >= c.high) ok = false;
    if (ok) pivots.push({ index: i, price: c.high });
  }
  return pivots;
}

function findStrictPivotLows(candles) {
  const pivots = [];
  for (let i = 4; i < candles.length - 2; i++) {
    const c = candles[i];
    let ok = true;
    for (let j = 1; j <= 4; j++) if (candles[i - j].low <= c.low) ok = false;
    for (let j = 1; j <= 2; j++) if (candles[i + j].low <= c.low) ok = false;
    if (ok) pivots.push({ index: i, price: c.low });
  }
  return pivots;
}

function detectPivotsBreakoutReversal(candles) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null, mode: null };
  // v4.7: se sube el mínimo de 10 a 20 velas porque ahora el SL se ancla en ATR14
  // (ver más abajo) — calculateATR necesita al menos period+1=15 velas para no
  // devolver null; 20 deja margen para que además los pivotes estrictos (que ya
  // consumen las primeras 4 y últimas 2 velas del set) tengan datos reales atrás.
  if (!candles || candles.length < 20) return result;

  const PH = findStrictPivotHighs(candles);
  const PL = findStrictPivotLows(candles);
  if (!PH.length || !PL.length) return result;
  const lastPH = PH[PH.length - 1];
  const lastPL = PL[PL.length - 1];

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const sma5 = calculateSMASeries(candles, 5);
  const sma10 = calculateSMASeries(candles, 10);
  const { macdLine } = calculateMACDSeries(candles);

  const i = candles.length - 1;
  const sma5Now = sma5[i], sma5Prev = sma5[i - 1], sma10Now = sma10[i], sma10Prev = sma10[i - 1];
  const macdNow = macdLine[i], macdPrev = macdLine[i - 1];

  const smaCrossUp = sma5Prev !== null && sma10Prev !== null && sma5Now !== null && sma10Now !== null &&
    sma5Prev <= sma10Prev && sma5Now > sma10Now;
  const smaCrossDown = sma5Prev !== null && sma10Prev !== null && sma5Now !== null && sma10Now !== null &&
    sma5Prev >= sma10Prev && sma5Now < sma10Now;
  const smaAboveNow = sma5Now !== null && sma10Now !== null && sma5Now > sma10Now;
  const smaBelowNow = sma5Now !== null && sma10Now !== null && sma5Now < sma10Now;

  const macdPositive = macdNow !== null && macdNow > 0;
  const macdNegative = macdNow !== null && macdNow < 0;
  const macdCrossUp = macdPrev !== null && macdNow !== null && macdPrev <= 0 && macdNow > 0;
  const macdCrossDown = macdPrev !== null && macdNow !== null && macdPrev >= 0 && macdNow < 0;

  // --- Modalidad A: Ruptura (a favor) ---
  if (prev.close <= lastPH.price && last.close > lastPH.price &&
      (smaCrossUp || smaAboveNow) && (macdPositive || macdCrossUp)) {
    result.bullish = true; result.mode = 'breakout'; result.entry = last.close;
    result.details.push(`Ruptura alcista de PH (${lastPH.price.toFixed(2)})`);
  } else if (prev.close >= lastPL.price && last.close < lastPL.price &&
      (smaCrossDown || smaBelowNow) && (macdNegative || macdCrossDown)) {
    result.bearish = true; result.mode = 'breakout'; result.entry = last.close;
    result.details.push(`Ruptura bajista de PL (${lastPL.price.toFixed(2)})`);
  }

  // --- Modalidad B: Reversión (falsa ruptura + divergencia MACD) ---
  if (!result.bullish && !result.bearish) {
    // Barrida bajista de PL con cierre por encima + divergencia alcista MACD
    if (last.low < lastPL.price && last.close > lastPL.price) {
      const priorLow = PL.length >= 2 ? PL[PL.length - 2] : null;
      if (priorLow) {
        const priceLL = last.low < priorLow.price; // mínimo más bajo en precio
        const macdAtPrior = macdLine[priorLow.index];
        const macdHL = macdAtPrior !== null && macdNow !== null && macdNow > macdAtPrior; // MACD mínimo más alto
        if (priceLL && macdHL) {
          result.bullish = true; result.mode = 'reversal'; result.entry = last.close;
          result.details.push('Reversión alcista: barrida de PL + divergencia alcista MACD');
        }
      }
    }
    // Barrida alcista de PH con cierre por debajo + divergencia bajista MACD
    if (!result.bullish && last.high > lastPH.price && last.close < lastPH.price) {
      const priorHigh = PH.length >= 2 ? PH[PH.length - 2] : null;
      if (priorHigh) {
        const priceHH = last.high > priorHigh.price; // máximo más alto en precio
        const macdAtPrior = macdLine[priorHigh.index];
        const macdLH = macdAtPrior !== null && macdNow !== null && macdNow < macdAtPrior; // MACD máximo más bajo
        if (priceHH && macdLH) {
          result.bearish = true; result.mode = 'reversal'; result.entry = last.close;
          result.details.push('Reversión bajista: barrida de PH + divergencia bajista MACD');
        }
      }
    }
  }

  if (result.bullish || result.bearish) {
    const entry = result.entry;
    const refLevel = result.bullish ? lastPL.price : lastPH.price;
    // v4.7 (auditoría Etapa 2): antes el colchón del SL era 1.5% FIJO del precio,
    // sin importar el activo. Un 1.5% en EURUSD (baja volatilidad intradía) es un
    // colchón enorme relativo a su rango real; el mismo 1.5% en BTCUSD/XAUUSD puede
    // ser angosto un día de alta volatilidad y disparar el stop por ruido normal.
    // Se reemplaza por un colchón de 0.5x ATR14 sobre el nivel estructural roto
    // (el pivote), que sí se adapta a la volatilidad real y reciente de cada activo.
    // Se conserva el 0.985/1.015 como fallback SOLO si por algún motivo no hay ATR
    // calculable (candles insuficientes), para no romper la señal en ese caso raro.
    const atr = calculateATR(candles);
    const sl = atr
      ? (result.bullish ? refLevel - atr * 0.5 : refLevel + atr * 0.5)
      : (result.bullish ? refLevel * 0.985 : refLevel * 1.015);
    const risk = Math.abs(entry - sl);
    result.sl = sl;
    result.tp1 = result.bullish ? entry + risk * 2 : entry - risk * 2; // RR 1:2 fijo
    if (atr) result.details.push(`SL ajustado por volatilidad (0.5x ATR14 = ${(atr * 0.5).toFixed(5)}) desde el nivel de pivote`);
  }

  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 3: PRICE ACTION + RSI + EMA (Bullish/Bearish Momentum)
// ---------------------------------------------------------
// Parámetros:
//   - EMA20, EMA50 (alineación de tendencia), RSI14
//   - Zona S/R: swing points de las últimas 40 velas
//   - Compra: EMA20>EMA50 + retest de EMA50 + retest de SOPORTE + RSI<=40 + vela alcista
//   - Venta:  EMA20<EMA50 + retest de EMA50 + retest de RESISTENCIA + RSI>=60 + vela bajista
//   - Filtro opcional de volumen (vela de entrada > promedio de 20)
//   - TP1 = riesgo x2 (RR 1:2) / TP2 = próxima zona S/R visible
//   - Salida alternativa por RSI: 60 (compra) / 40 (venta)

function findBrokenSRZones(candles, lookback = 40) {
  // Zonas simples: swing highs/lows recientes del rango analizado.
  const zones = [];
  const window = candles.slice(-lookback);
  for (let i = 2; i < window.length - 2; i++) {
    const c = window[i];
    const isSwingHigh = c.high > window[i - 1].high && c.high > window[i - 2].high && c.high > window[i + 1].high && c.high > window[i + 2].high;
    const isSwingLow = c.low < window[i - 1].low && c.low < window[i - 2].low && c.low < window[i + 1].low && c.low < window[i + 2].low;
    if (isSwingHigh) zones.push({ price: c.high, type: 'resistance' });
    if (isSwingLow) zones.push({ price: c.low, type: 'support' });
  }
  return zones;
}

function detectPriceActionRsiEma(candles) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null, tp2: null };
  if (!candles || candles.length < 60) return result;

  const ema20 = calculateEMASeries(candles, 20);
  const ema50 = calculateEMASeries(candles, 50);
  const rsi = calculateRSISeries(candles, 14);

  const i = candles.length - 1;
  const last = candles[i];
  const e20 = ema20[i], e50 = ema50[i], rsiNow = rsi[i];
  if (e20 === null || e50 === null || rsiNow === null) return result;

  const zones = findBrokenSRZones(candles);
  const tolerance = (Math.max(...candles.slice(-20).map(c => c.high)) - Math.min(...candles.slice(-20).map(c => c.low))) * 0.01;

  // Volumen: vela de entrada vs promedio de últimas 20
  const vols = candles.slice(-21, -1).map(c => c.volume || 0);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const volOk = !avgVol || (last.volume || 0) > avgVol;

  // --- Lado BUY ---
  // CORREGIDO: antes se pedía una zona 'resistance' para comprar. Estaba
  // invertido: para un setup de compra hay que buscar confluencia con
  // SOPORTE, no con resistencia (comprar justo debajo de una resistencia
  // sin romper no tiene sentido dentro de la lógica de price action que
  // describe la propia estrategia).
  const bullEmaAligned = e20 > e50;
  const touchedEma50Bull = last.low <= e50 + tolerance || (last.open <= e50 + tolerance && last.close >= e50 - tolerance);
  const supportZoneBuy = zones.find(z => z.type === 'support' && Math.abs(last.close - z.price) <= tolerance * 3);
  const rsiOversold = rsiNow <= 40;

  if (bullEmaAligned && touchedEma50Bull && supportZoneBuy && rsiOversold && last.close > last.open && volOk) {
    result.bullish = true;
    result.entry = last.close;
    result.sl = last.low;
    result.details.push(`Momentum alcista: EMA20>EMA50, retest EMA50 y soporte (${supportZoneBuy.price.toFixed(2)}), RSI ${rsiNow.toFixed(1)} (<=40)`);
  }

  // --- Lado SELL (espejo) ---
  // CORREGIDO: antes se pedía una zona 'support' para vender, también
  // invertido respecto al lado BUY. Ahora pide RESISTENCIA para vender.
  const bearEmaAligned = e20 < e50;
  const touchedEma50Bear = last.high >= e50 - tolerance || (last.open >= e50 - tolerance && last.close <= e50 + tolerance);
  const resistanceZoneSell = zones.find(z => z.type === 'resistance' && Math.abs(last.close - z.price) <= tolerance * 3);
  const rsiOverbought = rsiNow >= 60;

  if (!result.bullish && bearEmaAligned && touchedEma50Bear && resistanceZoneSell && rsiOverbought && last.close < last.open && volOk) {
    result.bearish = true;
    result.entry = last.close;
    result.sl = last.high;
    result.details.push(`Momentum bajista: EMA20<EMA50, retest EMA50 y resistencia (${resistanceZoneSell.price.toFixed(2)}), RSI ${rsiNow.toFixed(1)} (>=60)`);
  }

  if (result.bullish || result.bearish) {
    const risk = Math.abs(result.entry - result.sl);
    result.tp1 = result.bullish ? result.entry + risk * 2 : result.entry - risk * 2; // Opción A: RR 1:2
    // Opción C como TP2: siguiente resistencia/soporte visible
    const nextLevel = result.bullish
      ? zones.filter(z => z.type === 'resistance' && z.price > result.entry).sort((a, b) => a.price - b.price)[0]
      : zones.filter(z => z.type === 'support' && z.price < result.entry).sort((a, b) => b.price - a.price)[0];
    result.tp2 = nextLevel ? nextLevel.price : result.tp1;
    result.rsiExitLevel = result.bullish ? 60 : 40; // Opción B: salir cuando RSI llegue a 60/40
  }

  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 4: SUPPLY AND DEMAND (Oferta y Demanda)
// ---------------------------------------------------------
// Parámetros:
//   - Timeframe principal (HTF): H1/H4 -> se usa htfCandles (pedirlos en engine.js)
//   - Timeframe de entrada: M15/M5 -> se usa `candles` (el timeframe activo del motor)
//   - Zona = vela base (cuerpo chico) antes de un impulso >= 1.5x ATR
//   - "Fresca" = 0-1 toques posteriores a su formación (más de eso se descarta)
//   - Confirmación de entrada: pin bar o engulfing en la zona, a favor de la
//     tendencia mayor (EMA20 vs EMA50 en HTF)
//   - SL detrás de la zona (+/- 0.2 ATR) / TP en la zona opuesta más cercana
//   - Filtro duro: se descarta la señal si el RR resultante es menor a 1:2

function findImpulseZones(candles, atr) {
  const zones = [];
  if (!candles || candles.length < 10 || !atr) return zones;
  for (let i = 2; i < candles.length - 1; i++) {
    const base = candles[i];
    const impulse = candles[i + 1];
    const baseBody = Math.abs(base.close - base.open);
    const impulseBody = Math.abs(impulse.close - impulse.open);
    if (impulseBody < atr * 1.5) continue; // no hubo impulso real
    if (baseBody > impulseBody * 0.5) continue; // la "base" no es lo bastante chica

    const zoneLow = Math.min(base.open, base.close, base.low);
    const zoneHigh = Math.max(base.open, base.close, base.high);

    if (impulse.close > impulse.open) {
      // impulso alcista -> la base queda como zona de DEMANDA
      zones.push({ type: 'demand', low: zoneLow, high: zoneHigh, formedAt: i, touches: 0 });
    } else if (impulse.close < impulse.open) {
      // impulso bajista -> la base queda como zona de OFERTA
      zones.push({ type: 'supply', low: zoneLow, high: zoneHigh, formedAt: i, touches: 0 });
    }
  }

  zones.forEach(zone => {
    for (let j = zone.formedAt + 2; j < candles.length; j++) {
      const c = candles[j];
      const touchedZone = c.low <= zone.high && c.high >= zone.low;
      if (touchedZone) zone.touches++;
    }
  });

  return zones.filter(z => z.touches <= 1);
}

function isPinBar(candle, direction) {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  if (direction === 'bull') return lowerWick >= range * 0.55 && body <= range * 0.35;
  return upperWick >= range * 0.55 && body <= range * 0.35;
}

function isEngulfing(prev, last, direction) {
  if (direction === 'bull') {
    return last.close > last.open && prev.close < prev.open &&
      last.close >= prev.open && last.open <= prev.close;
  }
  return last.close < last.open && prev.close > prev.open &&
    last.open >= prev.close && last.close <= prev.open;
}

// CORREGIDO: antes era promedio simple de las últimas `period` True Range.
// Ahora es Wilder/RMA real (igual a TradingView/MT4/MT5): semilla = promedio
// simple de los primeros `period` TR, y de ahí en adelante suavizado
// exponencial atr = (atr*(period-1) + TR) / period.
function calculateATR(candleSet, period = 14) {
  if (!candleSet || candleSet.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candleSet.length; i++) {
    const h = candleSet[i].high, l = candleSet[i].low, pc = candleSet[i - 1].close;
    trueRanges.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trueRanges.length < period) return null;
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

function detectSupplyDemand(candles, htfCandles) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null };
  if (!candles || candles.length < 15) return result;

  // ATR del timeframe de entrada (M15/M5): se usa para el colchón del SL, que es
  // relativo al precio actual, no a la formación de la zona.
  const atr = calculateATR(candles);
  if (!atr) return result;

  // CORREGIDO: antes se usaba el ATR de entrada también para calificar qué cuenta
  // como "impulso" en findImpulseZones, aunque la zona se busque en htfCandles
  // (H1/H4). Un ATR de M15 es mucho más chico que uno de H1, así que casi
  // cualquier vela de H1 superaba el umbral de 1.5x y calificaba como impulso,
  // inflando la cantidad de zonas detectadas. Ahora el ATR usado para detectar
  // impulsos se calcula sobre el mismo set de velas donde se buscan las zonas.
  const zoneSource = (htfCandles && htfCandles.length >= 15) ? htfCandles : candles;
  const zoneAtr = (zoneSource === candles) ? atr : calculateATR(zoneSource);
  if (!zoneAtr) return result;
  const zones = findImpulseZones(zoneSource, zoneAtr);
  if (!zones.length) return result;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  let htfTrend = 'neutral';
  let htfFilterNote = null;
  if (htfCandles && htfCandles.length >= 50) {
    const ema20 = calculateEMASeries(htfCandles, 20);
    const ema50 = calculateEMASeries(htfCandles, 50);
    const i = htfCandles.length - 1;
    if (ema20[i] !== null && ema50[i] !== null) htfTrend = ema20[i] > ema50[i] ? 'bullish' : (ema20[i] < ema50[i] ? 'bearish' : 'neutral');
  } else if (htfCandles && htfCandles.length > 0) {
    // FIX (7.2, sesión 25/8): antes esto caía en 'neutral' en silencio (solo quedaba un
    // console.warn en logs de Render, invisible desde el panel). Ahora, si la señal
    // termina confirmando de todas formas, el aviso se agrega a result.details para que
    // se vea en la tarjeta de la señal en la app — no hay que ir a buscarlo a los logs.
    htfFilterNote = `⚠️ Filtro de tendencia H1 desactivado (${htfCandles.length}/50 velas H1 recibidas)`;
    console.warn(`[supply_demand] htfCandles insuficiente (${htfCandles.length} velas, se necesitan >=50) — filtro de tendencia mayor desactivado`);
  } else if (!htfCandles) {
    // FIX (7.2): antes este caso (sin ningún dato HTF, ni siquiera insuficiente) no
    // generaba ni siquiera el console.warn de arriba — era el más silencioso de los tres.
    htfFilterNote = '⚠️ Sin datos HTF (H1) disponibles — filtro de tendencia mayor desactivado';
    console.warn(`[supply_demand] sin htfCandles — filtro de tendencia mayor desactivado`);
  }

  const demandZones = zones.filter(z => z.type === 'demand').sort((a, b) => b.high - a.high);
  const supplyZones = zones.filter(z => z.type === 'supply').sort((a, b) => a.low - b.low);

  const priceInZone = (zone) => last.low <= zone.high && last.high >= zone.low;

  // --- Lado COMPRA: precio en zona de demanda + confirmación alcista ---
  const demandHit = demandZones.find(z => priceInZone(z));
  if (demandHit && htfTrend !== 'bearish') {
    const confirm = isPinBar(last, 'bull') || isEngulfing(prev, last, 'bull');
    if (confirm && last.close > last.open) {
      const oppositeSupply = supplyZones.find(z => z.low > last.close);
      if (oppositeSupply) {
        result.bullish = true;
        result.entry = last.close;
        result.sl = demandHit.low - atr * 0.2;
        result.tp1 = oppositeSupply.low;
        const risk = result.entry - result.sl;
        const reward = result.tp1 - result.entry;
        if (risk > 0 && reward / risk >= 2) {
          result.details.push(`Rebote alcista en demanda fresca (${demandHit.touches} toque previo), TP en oferta siguiente`);
          if (htfFilterNote) result.details.push(htfFilterNote);
        } else {
          result.bullish = false; // no cumple RR mínima 1:2
        }
      }
    }
  }

  // --- Lado VENTA: precio en zona de oferta + confirmación bajista ---
  if (!result.bullish) {
    const supplyHit = supplyZones.find(z => priceInZone(z));
    if (supplyHit && htfTrend !== 'bullish') {
      const confirm = isPinBar(last, 'bear') || isEngulfing(prev, last, 'bear');
      if (confirm && last.close < last.open) {
        const oppositeDemand = demandZones.find(z => z.high < last.close);
        if (oppositeDemand) {
          result.bearish = true;
          result.entry = last.close;
          result.sl = supplyHit.high + atr * 0.2;
          result.tp1 = oppositeDemand.high;
          const risk = result.sl - result.entry;
          const reward = result.entry - result.tp1;
          if (risk > 0 && reward / risk >= 2) {
            result.details.push(`Rechazo bajista en oferta fresca (${supplyHit.touches} toque previo), TP en demanda siguiente`);
            if (htfFilterNote) result.details.push(htfFilterNote);
          } else {
            result.bearish = false; // no cumple RR mínima 1:2
          }
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 5: EMA CROSS SCALPING (EMA9/EMA21 + RSI + MACD + tendencia HTF)
// ---------------------------------------------------------
// Nota: la infografía de origen promociona "90% win rate" — eso es marketing
// de plantilla, no un resultado verificable. Se implementa la lógica tal
// cual el Pine Script (cruce + filtros RSI/MACD + TP 2% / SL 1% fijos).
// Parámetros: EMA9, EMA21, RSI14 (>50 compra / <50 venta), MACD(12,26,9)
// SL = 1x ATR14 / TP1 = 2x ATR14 (RR 1:2) — ver fix v4.7 más abajo.
// Fallback a 1%/2% fijo del precio SOLO si el ATR no es calculable ese ciclo.
//
// FIX (auditoría de estrategias, sesión 14/8): un cruce de EMA en aislamiento
// es un indicador rezagado — backtests cuantitativos publicados lo ubican
// cerca de 47-51% de winrate (cruce 50/200 EMA: 51%, PF 1.31; golden cross
// diario: 49%), contra 61-64% de las entradas por order block del framework
// SMC en el mismo dataset — prácticamente una moneda al aire una vez
// descontado el spread. Apilar más indicadores rezagados (ya tenía RSI+MACD)
// no corrige eso. Lo que sí tiene soporte es exigir que el cruce vaya a
// favor de la tendencia del timeframe mayor (HTF): ahí deja de ser "cruce
// de EMA como señal" y pasa a ser "cruce de EMA como confirmación de
// entrada dentro de una tendencia ya establecida", que es el uso de medias
// móviles con evidencia real detrás. Downgrade de disparador independiente
// a filtro de confluencia: si no hay htfCandles disponibles (falla el fetch,
// activo sin HTF_MAP), la estrategia queda desactivada ese ciclo — antes
// prefería una señal sin confirmar a ninguna señal, ahora es al revés.

// Devuelve 'up', 'down' o null (datos insuficientes) según la pendiente de
// la EMA50 del timeframe mayor. Se usa como filtro de confluencia para
// estrategias basadas en indicadores rezagados, que solo tienen buen
// respaldo cuando confirman una tendencia ya establecida, no cuando
// disparan en aislamiento.
function getHtfTrendDirection(htfCandles) {
  if (!htfCandles || htfCandles.length < 55) return null;
  const emaHtf = calculateEMASeries(htfCandles, 50);
  const i = htfCandles.length - 1;
  const now = emaHtf[i], back = emaHtf[i - 5];
  if (now === null || back === null) return null;
  if (now > back) return 'up';
  if (now < back) return 'down';
  return null;
}

function detectEmaCrossScalping(candles, htfCandles = null) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null };
  if (!candles || candles.length < 30) return result;

  const emaFast = calculateEMASeries(candles, 9);
  const emaSlow = calculateEMASeries(candles, 21);
  const rsi = calculateRSISeries(candles, 14);
  const { macdLine, signalLine } = calculateMACDSeries(candles, 12, 26, 9);

  const i = candles.length - 1;
  const fastNow = emaFast[i], fastPrev = emaFast[i - 1];
  const slowNow = emaSlow[i], slowPrev = emaSlow[i - 1];
  const rsiNow = rsi[i];
  const macdNow = macdLine[i], signalNow = signalLine[i];

  if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null || rsiNow === null || macdNow === null || signalNow === null) return result;

  const htfTrend = getHtfTrendDirection(htfCandles);
  if (htfTrend === null) {
    result.details.push('Sin datos de tendencia HTF disponibles — señal omitida (requiere confluencia)');
    return result;
  }

  const crossUp = fastPrev <= slowPrev && fastNow > slowNow;
  const crossDown = fastPrev >= slowPrev && fastNow < slowNow;

  const last = candles[i];

  // v4.7 (auditoría Etapa 2): el 1%/2% fijo venía literal del Pine Script original
  // (nota arriba: "90% win rate" de marketing, no verificable). Un % fijo del precio
  // no distingue XAUUSD en día de noticias de EURUSD en rango asiático. Se reemplaza
  // por ATR14 del propio timeframe de entrada (M15), manteniendo la misma RR 1:2 que
  // ya tenía. Fallback al 1%/2% original únicamente si el ATR no es calculable.
  const atrScalp = calculateATR(candles);

  if (crossUp && rsiNow > 50 && macdNow > signalNow && htfTrend === 'up') {
    result.bullish = true;
    result.entry = last.close;
    if (atrScalp) {
      result.sl = result.entry - atrScalp;
      result.tp1 = result.entry + atrScalp * 2;
    } else {
      result.sl = result.entry * (1 - 0.01);  // fallback: 1% SL si no hay ATR
      result.tp1 = result.entry * (1 + 0.02); // fallback: 2% TP, RR 1:2
    }
    result.details.push(`Cruce EMA9>EMA21 + RSI ${rsiNow.toFixed(1)} (>50) + MACD alcista + tendencia HTF alcista${atrScalp ? ' (SL/TP por ATR14)' : ''}`);
  } else if (crossDown && rsiNow < 50 && macdNow < signalNow && htfTrend === 'down') {
    result.bearish = true;
    result.entry = last.close;
    if (atrScalp) {
      result.sl = result.entry + atrScalp;
      result.tp1 = result.entry - atrScalp * 2;
    } else {
      result.sl = result.entry * (1 + 0.01);
      result.tp1 = result.entry * (1 - 0.02);
    }
    result.details.push(`Cruce EMA9<EMA21 + RSI ${rsiNow.toFixed(1)} (<50) + MACD bajista + tendencia HTF bajista${atrScalp ? ' (SL/TP por ATR14)' : ''}`);
  }

  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 6: DIVERGENCIA RSI
// ---------------------------------------------------------
// Parámetros:
//   - RSI14 sobre los pivots estrictos de precio (findStrictPivotHighs/Lows,
//     ya usados por Pivots Breakout & Reversal) — a diferencia de esa
//     estrategia, acá la divergencia se mide contra RSI (no MACD) y no
//     requiere una barrida/falsa ruptura previa: es una señal independiente.
//   - Divergencia alcista: precio hace mínimo más bajo (PL actual < PL previo)
//     mientras el RSI hace mínimo más alto en esos mismos puntos.
//   - Divergencia bajista: precio hace máximo más alto (PH actual > PH previo)
//     mientras el RSI hace máximo más bajo en esos mismos puntos.
//   - Confirmación de entrada: el RSI tiene que cruzar de vuelta el nivel
//     30 (divergencia alcista) o 70 (divergencia bajista) en la vela actual,
//     con una vela de precio a favor (verde para alcista, roja para bajista).
//     Sin esa confirmación, la divergencia queda "abierta" y no dispara nada.
//   - SL: por debajo/encima del extremo de precio del pivot actual (con
//     colchón de 0.5%). TP1 = riesgo x2 (RR 1:2). TP2 = riesgo x3.
//
// FIX (auditoría de estrategias, sesión 14/8): la divergencia RSI sola tiene
// evidencia floja como disparador independiente — se vuelve mucho más
// confiable cuando el pivot de precio donde se mide la divergencia ocurre en
// un nivel realmente estirado, no en cualquier mínimo/máximo local menor. Se
// agrega como filtro de confluencia obligatorio que el precio en ESE pivot
// haya tocado o superado la banda de Bollinger (SMA20 +/- 2 desvíos)
// correspondiente — "divergencia + nivel estadísticamente extendido", no
// divergencia sola. Downgrade de disparador independiente a señal que exige
// confluencia con otro indicador antes de emitirse.

function detectRsiDivergence(candles) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null, tp2: null };
  if (!candles || candles.length < 60) return result;

  const rsi = calculateRSISeries(candles, 14);
  const { upper: bbUpper, lower: bbLower } = calculateBollingerSeries(candles, 20, 2);
  const i = candles.length - 1;
  const last = candles[i];
  const rsiNow = rsi[i], rsiPrev = rsi[i - 1];
  if (rsiNow === null || rsiPrev === null) return result;

  const PH = findStrictPivotHighs(candles);
  const PL = findStrictPivotLows(candles);

  // --- Divergencia alcista: precio LL, RSI HL, confirmación cruzando 30 al alza ---
  if (PL.length >= 2) {
    const lastPL = PL[PL.length - 1];
    const priorPL = PL[PL.length - 2];
    const rsiAtLast = rsi[lastPL.index];
    const rsiAtPrior = rsi[priorPL.index];
    const bbLowerAtPivot = bbLower[lastPL.index];
    const touchedLowerBand = bbLowerAtPivot !== null && lastPL.price <= bbLowerAtPivot;
    if (rsiAtLast !== null && rsiAtPrior !== null && touchedLowerBand) {
      const priceLL = lastPL.price < priorPL.price;
      const rsiHL = rsiAtLast > rsiAtPrior;
      const rsiCrossUp30 = rsiPrev <= 30 && rsiNow > 30;
      if (priceLL && rsiHL && rsiCrossUp30 && last.close > last.open) {
        result.bullish = true;
        result.entry = last.close;
        result.sl = Math.min(lastPL.price, last.low) * 0.995;
        result.details.push(`Divergencia alcista RSI en banda inferior de Bollinger: precio LL (${lastPL.price.toFixed(2)}) vs RSI HL (${rsiAtPrior.toFixed(1)}→${rsiAtLast.toFixed(1)}), confirmación cruzando 30`);
      }
    }
  }

  // --- Divergencia bajista: precio HH, RSI LH, confirmación cruzando 70 a la baja ---
  if (!result.bullish && PH.length >= 2) {
    const lastPH = PH[PH.length - 1];
    const priorPH = PH[PH.length - 2];
    const rsiAtLast = rsi[lastPH.index];
    const rsiAtPrior = rsi[priorPH.index];
    const bbUpperAtPivot = bbUpper[lastPH.index];
    const touchedUpperBand = bbUpperAtPivot !== null && lastPH.price >= bbUpperAtPivot;
    if (rsiAtLast !== null && rsiAtPrior !== null && touchedUpperBand) {
      const priceHH = lastPH.price > priorPH.price;
      const rsiLH = rsiAtLast < rsiAtPrior;
      const rsiCrossDown70 = rsiPrev >= 70 && rsiNow < 70;
      if (priceHH && rsiLH && rsiCrossDown70 && last.close < last.open) {
        result.bearish = true;
        result.entry = last.close;
        result.sl = Math.max(lastPH.price, last.high) * 1.005;
        result.details.push(`Divergencia bajista RSI en banda superior de Bollinger: precio HH (${lastPH.price.toFixed(2)}) vs RSI LH (${rsiAtPrior.toFixed(1)}→${rsiAtLast.toFixed(1)}), confirmación cruzando 70`);
      }
    }
  }

  if (result.bullish || result.bearish) {
    const risk = Math.abs(result.entry - result.sl);
    result.tp1 = result.bullish ? result.entry + risk * 2 : result.entry - risk * 2; // RR 1:2
    result.tp2 = result.bullish ? result.entry + risk * 3 : result.entry - risk * 3; // RR 1:3
  }

  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 7: BOLLINGER SQUEEZE BREAKOUT
// ---------------------------------------------------------
// Parámetros:
//   - Bandas de Bollinger: SMA20 +/- 2 desvíos estándar.
//   - "Squeeze" = el ancho de banda (bandwidth = (upper-lower)/sma) tocó,
//     en alguna de las últimas 5 velas, un valor dentro del 20% más bajo
//     de los últimos 60 anchos de banda — es decir, volatilidad
//     comprimida de forma inusual para ese activo en ese período.
//   - Ruptura: la vela actual cierra por fuera de la banda (arriba de la
//     superior para alcista, abajo de la inferior para bajista) mientras
//     que la vela anterior cerraba todavía adentro — señal de arranque
//     recién confirmado, no de un movimiento ya extendido.
//   - SL: banda media (SMA20). TP1 = riesgo x2 (RR 1:2). TP2 = riesgo x3.

function calculateBollingerSeries(candles, period = 20, mult = 2) {
  const closes = candles.map(c => c.close);
  const n = closes.length;
  const sma = calculateSMASeries(candles, period);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const bandwidth = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    if (sma[i] === null) continue;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - sma[i];
      sumSq += d * d;
    }
    const std = Math.sqrt(sumSq / period);
    upper[i] = sma[i] + mult * std;
    lower[i] = sma[i] - mult * std;
    bandwidth[i] = sma[i] ? (upper[i] - lower[i]) / sma[i] : null;
  }
  return { sma, upper, lower, bandwidth };
}

function detectBollingerSqueeze(candles) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null, tp2: null };
  if (!candles || candles.length < 90) return result;

  const { sma, upper, lower, bandwidth } = calculateBollingerSeries(candles, 20, 2);
  const i = candles.length - 1;
  const last = candles[i];
  const prev = candles[i - 1];
  if (upper[i] === null || lower[i] === null || upper[i - 1] === null || lower[i - 1] === null) return result;

  // Umbral de squeeze: percentil 20 de los últimos 60 anchos de banda válidos.
  const bwWindow = bandwidth.slice(Math.max(0, i - 59), i + 1).filter(v => v !== null);
  if (bwWindow.length < 30) return result;
  const sorted = [...bwWindow].sort((a, b) => a - b);
  const p20 = sorted[Math.floor(sorted.length * 0.2)];

  // ¿Hubo squeeze en alguna de las últimas 5 velas (sin contar la actual)?
  let squeezeSeen = false;
  for (let j = i - 5; j < i; j++) {
    if (bandwidth[j] !== null && bandwidth[j] <= p20) { squeezeSeen = true; break; }
  }
  if (!squeezeSeen) return result;

  const prevInside = prev.close <= upper[i - 1] && prev.close >= lower[i - 1];

  if (prevInside && last.close > upper[i]) {
    result.bullish = true;
    result.entry = last.close;
    result.sl = sma[i];
    result.details.push(`Squeeze + ruptura alcista de banda superior (ancho previo en percentil <=20%)`);
  } else if (prevInside && last.close < lower[i]) {
    result.bearish = true;
    result.entry = last.close;
    result.sl = sma[i];
    result.details.push(`Squeeze + ruptura bajista de banda inferior (ancho previo en percentil <=20%)`);
  }

  if (result.bullish || result.bearish) {
    const risk = Math.abs(result.entry - result.sl);
    result.tp1 = result.bullish ? result.entry + risk * 2 : result.entry - risk * 2; // RR 1:2
    result.tp2 = result.bullish ? result.entry + risk * 3 : result.entry - risk * 3; // RR 1:3
  }

  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 8: ETH VWAP TREND SCALP (id: eth_vwap_scalp) — solo ETHUSD
// ---------------------------------------------------------
// Requiere htfCandles (H1) para el sesgo direccional. Corre sobre `candles`
// tal cual se le pasan al motor (M15 en esta versión — ver nota de
// integración: se decidió no agregar un fetch de M5 nuevo para no gastar
// cuota extra de Twelve Data, reutilizando el mismo timeframe base que ya
// usan las otras 7 estrategias).
// SETUP 1 (reclaim de VWAP): H1 a favor, VWAP con pendiente a favor, pullback
//   reciente hacia VWAP, vela de rechazo (mecha) que cierra del lado correcto.
// SETUP 2 (breakout de rango con VWAP a favor): consolidación reciente +
//   ruptura con cuerpo real, VWAP alineado con el sesgo H1.
function detectEthVwapScalp(candles, htfCandles) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null, tp2: null, mode: null, reason: null };
  if (!candles || candles.length < 60) { result.reason = 'Velas insuficientes'; return result; }

  const h1 = getH1Bias(htfCandles);
  if (h1.bias === 'no_trade') { result.reason = h1.reason; return result; }

  const { vwap } = calculateVWAPSeries(candles);
  const i = candles.length - 1;
  const last = candles[i];
  if (vwap[i] === null || vwap[i - 5] === null) { result.reason = 'VWAP no calculable aún'; return result; }

  const vwapSlopeUp = vwap[i] > vwap[i - 5];
  const vwapSlopeDown = vwap[i] < vwap[i - 5];

  // FIX (sesión 19/8): isPinBar() solo reconoce el string 'bull' para el lado alcista
  // (cualquier otro valor, incluido 'bullish', cae en su rama else = mecha superior =
  // forma bajista). Estaba llamado como isPinBar(last, 'bullish')/isPinBar(last,
  // 'bearish') acá abajo: el lado LONG (SETUP 1) pedía por error el patrón de vela
  // BAJISTA para confirmar una entrada alcista, así que casi nunca calzaba con un
  // reclaim de VWAP real — el lado SHORT no tenía el problema (coincidía con la rama
  // else por casualidad), pero se normalizó también a 'bear' por consistencia.
  // --- SETUP 1: reclaim de VWAP ---
  if (h1.bias === 'long' && vwapSlopeUp) {
    const pulledBack = candles[i - 1].close < candles[i - 1].open && candles[i - 2].close < candles[i - 2].open;
    const rejection = isPinBar(last, 'bull') && last.close > vwap[i];
    if (pulledBack && rejection) {
      result.bullish = true; result.mode = 'vwap_reclaim';
      result.entry = last.close;
      result.sl = last.low;
      const risk = result.entry - result.sl;
      result.tp1 = result.entry + risk * 1;   // 1R, cerrar parcial + BE
      result.tp2 = result.entry + risk * 2.5;
      result.details.push(`Reclaim VWAP: ${h1.reason}; pullback + rechazo alcista sobre VWAP (${vwap[i].toFixed(2)})`);
    }
  } else if (h1.bias === 'short' && vwapSlopeDown) {
    const pulledBack = candles[i - 1].close > candles[i - 1].open && candles[i - 2].close > candles[i - 2].open;
    const rejection = isPinBar(last, 'bear') && last.close < vwap[i];
    if (pulledBack && rejection) {
      result.bearish = true; result.mode = 'vwap_reclaim';
      result.entry = last.close;
      result.sl = last.high;
      const risk = result.sl - result.entry;
      result.tp1 = result.entry - risk * 1;
      result.tp2 = result.entry - risk * 2.5;
      result.details.push(`Reclaim VWAP: ${h1.reason}; pullback + rechazo bajista bajo VWAP (${vwap[i].toFixed(2)})`);
    }
  }

  // --- SETUP 2: breakout de rango con VWAP a favor ---
  if (!result.bullish && !result.bearish) {
    const lookback = 8; // ventana de consolidación (proxy de 30-60min en M5)
    const window = candles.slice(i - lookback, i);
    const rangeHigh = Math.max(...window.map(c => c.high));
    const rangeLow = Math.min(...window.map(c => c.low));
    const rangeSize = rangeHigh - rangeLow;
    const bodyReal = Math.abs(last.close - last.open) > rangeSize * 0.5;

    if (h1.bias === 'long' && vwapSlopeUp && vwap[i] <= rangeHigh && bodyReal && last.close > rangeHigh) {
      result.bullish = true; result.mode = 'range_breakout';
      result.entry = last.close;
      result.sl = Math.min(rangeHigh, last.low);
      const risk = result.entry - result.sl;
      result.tp1 = result.entry + Math.max(rangeSize, risk * 1.5);
      result.tp2 = result.entry + Math.max(rangeSize * 1.5, risk * 2);
      result.details.push(`Ruptura de rango (${lookback} velas) a favor de H1 alcista, VWAP alineado`);
    } else if (h1.bias === 'short' && vwapSlopeDown && vwap[i] >= rangeLow && bodyReal && last.close < rangeLow) {
      result.bearish = true; result.mode = 'range_breakout';
      result.entry = last.close;
      result.sl = Math.max(rangeLow, last.high);
      const risk = result.sl - result.entry;
      result.tp1 = result.entry - Math.max(rangeSize, risk * 1.5);
      result.tp2 = result.entry - Math.max(rangeSize * 1.5, risk * 2);
      result.details.push(`Ruptura de rango (${lookback} velas) a favor de H1 bajista, VWAP alineado`);
    }
  }

  if (!result.bullish && !result.bearish && !result.reason) result.reason = 'Sin pullback/ruptura válida sobre VWAP en este ciclo';
  return result;
}

// ---------------------------------------------------------
// ELIMINADAS (sesión 19/8, decisión del usuario): EUR London Pullback VWAP
// y XAU VWAP Reversion Scalp. Ambas dependían de calculateVWAPSeries() en
// EURUSD/XAUUSD, instrumentos OTC sin volumen de mercado centralizado — el
// VWAP caía a un fallback de promedio de precio típico (dato estimado, no
// real). El usuario prefiere que la app solo opere con datos reales.
// CORRECCIÓN (27/8, ver comentario dentro de calculateVWAPSeries): la
// justificación original de que "se mantiene eth_vwap_scalp porque ETHUSD sí
// tiene volumen real" era falsa — CoinGecko (proveedor real de ETHUSD) da
// volume:0 hardcodeado en /market_chart. eth_vwap_scalp quedó apagada
// (ETH_VWAP_SCALP_ENABLED = false) por el mismo motivo que las otras dos.
// ---------------------------------------------------------

// ---------------------------------------------------------
// ESTRATEGIA 9: ETH MOMENTUM BREAKOUT — ATR (id: eth_momentum_breakout) — solo ETHUSD
// ---------------------------------------------------------
// Agregada 29/8 a pedido del usuario, tras revisar strategyStatsBySymbol real:
// en ETHUSD las dos peores estrategias (bollinger_squeeze -12.32R, pivots_
// breakout_reversal -5.40R) son ambas de tipo reversión/contra-tendencia; la
// única positiva (ny_open_kill_zone, +1.78R) es de tipo momentum/continuación.
// Esta estrategia sigue esa misma línea, evitando a propósito el problema de
// VWAP: no usa volumen en absoluto, solo precio (OHLC) + ATR, que sí son datos
// reales en los 4 activos.
// Corre sobre `candles` (M15, mismo timeframe base que las otras 7 — no se
// agrega ningún fetch nuevo para no gastar cuota extra) y usa htfCandles (H1)
// solo para el sesgo direccional vía getH1Bias(), igual que ema_cross_scalping.
// LÓGICA:
//   1. Consolidación: rango (máximo-mínimo) de las últimas 20 velas (sin
//      contar la actual) <= 1.5x ATR14 — es decir, rango angosto relativo a
//      la volatilidad reciente, no un valor fijo en precio.
//   2. Ruptura: la vela actual cierra por fuera de ese rango, con cuerpo real
//      (no solo mecha) de al menos 50% de su rango total — filtra rupturas
//      débiles.
//   3. Confirmación H1: getH1Bias() debe coincidir con la dirección de la
//      ruptura (long solo si H1 alcista, short solo si H1 bajista) — sin
//      esto, no dispara. Si no hay coincidencia, no es "señal débil": es
//      directamente descartada, igual que en ema_cross_scalping.
//   4. SL: extremo opuesto del rango de consolidación, con un colchón de
//      0.25x ATR14 (mismo criterio de holgura por volatilidad que ya usa
//      pivots_breakout_reversal, a otra escala).
//   5. TP1 = 1:2, TP2 = 1:3 (mismo esquema de RR que bollinger_squeeze).
function detectEthMomentumBreakout(candles, htfCandles) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null, tp2: null };
  if (!candles || candles.length < 40) return result;

  const atr = calculateATR(candles, 14);
  if (atr === null || atr <= 0) return result;

  const i = candles.length - 1;
  const last = candles[i];
  const lookback = 20;
  const window = candles.slice(Math.max(0, i - lookback), i); // sin incluir la vela actual
  if (window.length < lookback) return result;

  const rangeHigh = Math.max(...window.map(c => c.high));
  const rangeLow = Math.min(...window.map(c => c.low));
  const rangeSize = rangeHigh - rangeLow;
  if (rangeSize > atr * 1.5) return result; // no hubo consolidación real, sin señal

  const candleRange = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const hasRealBody = candleRange > 0 && (body / candleRange) >= 0.5;
  if (!hasRealBody) return result;

  const h1 = getH1Bias(htfCandles);

  if (last.close > rangeHigh && h1.bias === 'long') {
    result.bullish = true;
    result.entry = last.close;
    result.sl = rangeLow - atr * 0.25;
    result.details.push(`Ruptura alcista de consolidación (rango ${rangeSize.toFixed(2)} <= 1.5x ATR14) con cuerpo real, a favor de H1 (${h1.reason})`);
  } else if (last.close < rangeLow && h1.bias === 'short') {
    result.bearish = true;
    result.entry = last.close;
    result.sl = rangeHigh + atr * 0.25;
    result.details.push(`Ruptura bajista de consolidación (rango ${rangeSize.toFixed(2)} <= 1.5x ATR14) con cuerpo real, a favor de H1 (${h1.reason})`);
  } else if ((last.close > rangeHigh || last.close < rangeLow) && h1.bias === 'no_trade') {
    result.details.push(`Ruptura detectada pero sin sesgo H1 claro (${h1.reason}) — descartada`);
  }

  if (result.bullish || result.bearish) {
    const risk = Math.abs(result.entry - result.sl);
    result.tp1 = result.bullish ? result.entry + risk * 2 : result.entry - risk * 2; // RR 1:2
    result.tp2 = result.bullish ? result.entry + risk * 3 : result.entry - risk * 3; // RR 1:3
  }

  return result;
}

// ---------------------------------------------------------
// SCORING CONTEXTUAL (v4.8, sesión 25/8 — Etapa 3)
// ---------------------------------------------------------
// Decisión explícita del usuario: arranca INFORMATIVO (se calcula y se muestra
// en la tarjeta/notificación), no filtra ni bloquea ninguna señal. Recién con
// datos reales de cuánto acierta el score se evalúa si conviene usarlo para
// filtrar — no tiene sentido apagar señales en base a un criterio sin validar.
//
// 4 factores, score 0-100 (base 50). Función pura: solo usa lo que ya recibe
// evaluateAll() más symbolStats (cierra el pendiente anotado en el punto 8 del
// changelog de este archivo — pasar el historial por símbolo+estrategia como
// parámetro nuevo, ya que esta función no tiene acceso directo a Supabase/state).
//   1. RR (reward/risk) de la señal.
//   2. Alineación con tendencia H1 (reutiliza getHtfTrendDirection).
//   3. Régimen de volatilidad: ATR actual vs ATR de referencia reciente (detecta
//      señales que nacen en medio de un pico de volatilidad tipo noticia).
//   4. Historial reciente de esa combinación símbolo+estrategia (wins/losses de
//      state.strategyStatsBySymbol, si hay al menos 5 operaciones cerradas).
function computeContextualScore({ direction, entry, sl, tp1, candles, htfCandles, strategyKey, symbolStats, newsContext }) {
  let score = 50;
  const details = [];

  if (entry != null && sl != null && tp1 != null) {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp1 - entry);
    if (risk > 0) {
      const rr = reward / risk;
      if (rr >= 2) { score += 10; details.push(`Score: RR favorable (1:${rr.toFixed(1)})`); }
      else if (rr < 1.5) { score -= 10; details.push(`Score: RR ajustado (1:${rr.toFixed(1)})`); }
    }
  }

  const htfTrend = getHtfTrendDirection(htfCandles);
  if (htfTrend) {
    const aligned = (direction === 'long' && htfTrend === 'up') || (direction === 'short' && htfTrend === 'down');
    if (aligned) { score += 15; details.push('Score: a favor de la tendencia H1'); }
    else { score -= 15; details.push('Score: en contra de la tendencia H1'); }
  }

  const atrNow = calculateATR(candles);
  if (atrNow && candles && candles.length >= 40) {
    const atrPrior = calculateATR(candles.slice(0, candles.length - 14));
    if (atrPrior) {
      const ratio = atrNow / atrPrior;
      if (ratio > 1.8) { score -= 10; details.push('Score: volatilidad muy por encima de lo reciente (posible noticia)'); }
      else if (ratio < 0.6) { score += 5; details.push('Score: volatilidad comprimida respecto a lo reciente'); }
    }
  }

  if (symbolStats && strategyKey && symbolStats[strategyKey]) {
    const s = symbolStats[strategyKey];
    const total = (s.wins || 0) + (s.losses || 0);
    if (total >= 5) {
      const wr = s.wins / total;
      if (wr >= 0.55) { score += 10; details.push(`Score: historial reciente favorable (${s.wins}G/${s.losses}P)`); }
      else if (wr <= 0.35) { score -= 15; details.push(`Score: historial reciente desfavorable (${s.wins}G/${s.losses}P)`); }
    }
  }

  // v4.8: newsContext = evento real de alto impacto (USD) dentro de ±60min, calculado
  // en engine.js (NewsCalendar, feed ForexFactory) y pasado acá vía evaluateAll(). A
  // diferencia del proxy de ATR de arriba ("posible noticia", ya inferido después del
  // hecho por el salto de volatilidad), esto es un dato real y puede anticiparse ANTES
  // de que el precio se mueva. Puramente informativo — mismo criterio que el resto del
  // score: ajusta, no filtra ni bloquea la señal (decisión explícita de Soy).
  if (newsContext) {
    const penalty = Math.abs(newsContext.minutesAway) <= 20 ? 20 : 10;
    score -= penalty;
    const when = newsContext.minutesAway >= 0
      ? `en ${newsContext.minutesAway}min`
      : `hace ${Math.abs(newsContext.minutesAway)}min`;
    details.push(`Score: noticia de alto impacto cerca (${newsContext.title}, ${when})`);
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), details };
}

// ---------------------------------------------------------
// EVALUACIÓN CONJUNTA (independiente, sin pasar por evalSide)
// ---------------------------------------------------------



// CORREGIDO: antes cada detectX() se llamaba directo. Si una explotaba
// (dato faltante, undefined.high, etc.), se perdían las señales de las 7
// estrategias de ese ciclo para ese símbolo, no solo la que falló. safeRun
// aísla cada llamada: si una tira excepción, se loguea y las otras 6 siguen.
function safeRun(strategyName, fn, ...args) {
  try {
    return fn(...args);
  } catch (err) {
    console.warn(`[custom-strategies] ${strategyName} falló, se omite este ciclo: ${err.message}`);
    return { bullish: false, bearish: false, details: [] };
  }
}

// Sección 13 (27/8): piso mínimo de confianza, decidido por el usuario en 55% —
// razonamiento: con 5-6 factores en computeContextualScore(), 50% (mitad de la escala)
// deja pasar señales con apenas mayoría simple a favor; 55% exige una mayoría algo más
// clara sin ser tan exigente como para dejar la app sin señales antes de tener datos
// reales del filtro en producción. Se puede pasar como parámetro desde engine.js
// (CONFIG.MIN_CONFIDENCE_SCORE) — este valor es solo el default si no se pasa nada.
const DEFAULT_MIN_CONFIDENCE_SCORE = 55;

function evaluateAll(candles, symbol, asset, htfCandles = null, symbolStats = null, newsContext = null, minConfidenceScore = null) {
  const signals = [];

  const kz = safeRun('ny_open_kill_zone', detectNYOpenKillZone, candles);
  if (kz.bullish || kz.bearish) {
    signals.push({
      strategy: 'ny_open_kill_zone', label: 'Kill Zone Apertura NY (9:30 AM)',
      direction: kz.bullish ? 'long' : 'short', entry: kz.entry, sl: kz.sl, tp1: kz.tp1, tp2: kz.tp2,
      details: kz.details, independent: true
    });
  }

  const piv = safeRun('pivots_breakout_reversal', detectPivotsBreakoutReversal, candles);
  if (piv.bullish || piv.bearish) {
    signals.push({
      strategy: 'pivots_breakout_reversal', label: 'Pivots Breakout & Reversal',
      direction: piv.bullish ? 'long' : 'short', entry: piv.entry, sl: piv.sl, tp1: piv.tp1,
      details: piv.details, mode: piv.mode, independent: true
    });
  }

  const pa = safeRun('price_action_rsi_ema', detectPriceActionRsiEma, candles);
  if (pa.bullish || pa.bearish) {
    signals.push({
      strategy: 'price_action_rsi_ema', label: 'Price Action + RSI + EMA',
      direction: pa.bullish ? 'long' : 'short', entry: pa.entry, sl: pa.sl, tp1: pa.tp1, tp2: pa.tp2,
      rsiExitLevel: pa.rsiExitLevel, details: pa.details, independent: true
    });
  }

  const sd = safeRun('supply_demand', detectSupplyDemand, candles, htfCandles);
  if (sd.bullish || sd.bearish) {
    signals.push({
      strategy: 'supply_demand', label: 'Supply and Demand',
      direction: sd.bullish ? 'long' : 'short', entry: sd.entry, sl: sd.sl, tp1: sd.tp1,
      details: sd.details, independent: true
    });
  }

  // FIX (auditoría de estrategias, sesión 14/8): ahora recibe htfCandles y exige
  // confluencia con la tendencia del timeframe mayor (ver detectEmaCrossScalping) —
  // sin eso, no dispara. Ya no es un disparador puramente independiente.
  const emaScalp = safeRun('ema_cross_scalping', detectEmaCrossScalping, candles, htfCandles);
  if (emaScalp.bullish || emaScalp.bearish) {
    signals.push({
      strategy: 'ema_cross_scalping', label: 'EMA Cross Scalping (RSI+MACD+HTF)',
      direction: emaScalp.bullish ? 'long' : 'short', entry: emaScalp.entry, sl: emaScalp.sl, tp1: emaScalp.tp1,
      details: emaScalp.details, independent: true
    });
  }

  const rsiDiv = safeRun('rsi_divergence', detectRsiDivergence, candles);
  if (rsiDiv.bullish || rsiDiv.bearish) {
    signals.push({
      strategy: 'rsi_divergence', label: 'Divergencia RSI',
      direction: rsiDiv.bullish ? 'long' : 'short', entry: rsiDiv.entry, sl: rsiDiv.sl, tp1: rsiDiv.tp1, tp2: rsiDiv.tp2,
      details: rsiDiv.details, independent: true
    });
  }

  const bbSqueeze = safeRun('bollinger_squeeze', detectBollingerSqueeze, candles);
  if (bbSqueeze.bullish || bbSqueeze.bearish) {
    signals.push({
      strategy: 'bollinger_squeeze', label: 'Bollinger Squeeze Breakout',
      direction: bbSqueeze.bullish ? 'long' : 'short', entry: bbSqueeze.entry, sl: bbSqueeze.sl, tp1: bbSqueeze.tp1, tp2: bbSqueeze.tp2,
      details: bbSqueeze.details, independent: true
    });
  }

  // Las siguientes tres son específicas de UN símbolo (a diferencia de las
  // 7 de arriba, que corren en los 4 activos): requieren htfCandles (H1) y/o
  // VWAP, y quedan filtradas por `symbol` acá mismo.
  // v4.9 (27/8): eth_vwap_scalp NO está en engine.js CONFIG.ENABLED_STRATEGIES
  // (whitelist real de 5) — su resultado siempre se descartaba después, pero
  // calculateVWAPSeries() se seguía ejecutando en cada ciclo para ETHUSD,
  // gastando cómputo y generando el warning "VWAP sin volumen confiable" en
  // logs de forma constante, sin ningún efecto en señales reales. Se corta acá,
  // en origen. IMPORTANTE: este flag debe reflejar manualmente si 'eth_vwap_scalp'
  // está en CONFIG.ENABLED_STRATEGIES de engine.js — no se leen entre sí.
  // Si se reincorpora eth_vwap_scalp a la whitelist, cambiar esto a true.
  if (ETH_VWAP_SCALP_ENABLED && symbol === 'ETHUSD') {
    const ethVwap = safeRun('eth_vwap_scalp', detectEthVwapScalp, candles, htfCandles);
    if (ethVwap.bullish || ethVwap.bearish) {
      signals.push({
        strategy: 'eth_vwap_scalp', label: 'ETH VWAP Trend Scalp',
        direction: ethVwap.bullish ? 'long' : 'short', entry: ethVwap.entry, sl: ethVwap.sl, tp1: ethVwap.tp1, tp2: ethVwap.tp2,
        details: ethVwap.details, mode: ethVwap.mode, independent: true
      });
    }
  }

  // v4.10 (29/8): ESTRATEGIA NUEVA — ver justificación completa junto a
  // detectEthMomentumBreakout() más arriba. Mismo patrón de filtro por
  // símbolo que eth_vwap_scalp.
  if (ETH_MOMENTUM_BREAKOUT_ENABLED && symbol === 'ETHUSD') {
    const ethMom = safeRun('eth_momentum_breakout', detectEthMomentumBreakout, candles, htfCandles);
    if (ethMom.bullish || ethMom.bearish) {
      signals.push({
        strategy: 'eth_momentum_breakout', label: 'ETH Momentum Breakout (ATR)',
        direction: ethMom.bullish ? 'long' : 'short', entry: ethMom.entry, sl: ethMom.sl, tp1: ethMom.tp1, tp2: ethMom.tp2,
        details: ethMom.details, independent: true
      });
    }
  }

  // Score contextual (sección 13, 27/8: pasó de informativo a filtro real — a pedido
  // explícito del usuario. Antes solo se mostraba, no descartaba nada). Se calcula acá,
  // en un solo lugar, para las señales que efectivamente dispararon este ciclo, en vez
  // de repetir la llamada dentro de cada detectX().
  signals.forEach(sig => {
    const { score, details: scoreDetails } = computeContextualScore({
      direction: sig.direction, entry: sig.entry, sl: sig.sl, tp1: sig.tp1,
      candles, htfCandles, strategyKey: sig.strategy, symbolStats, newsContext
    });
    sig.confidence = score;
    sig.details = (sig.details || []).concat(scoreDetails);
  });

  // Sección 13 (27/8): piso mínimo de confianza — decidido por el usuario, no
  // propuesto por el motor. Señal descartada acá NUNCA llega a resolveCustomSignal()
  // en engine.js (que es quien guarda historial, dispara push y marca cooldown) —
  // filtrar antes del return es lo que garantiza que una señal por debajo del piso
  // no deje rastro y no bloquee el cooldown de una señal mejor en el próximo ciclo.
  const minConfidence = (typeof minConfidenceScore === 'number') ? minConfidenceScore : DEFAULT_MIN_CONFIDENCE_SCORE;
  const passed = [];
  signals.forEach(sig => {
    if (sig.confidence < minConfidence) {
      console.log(`[CONFIANZA] ${sig.strategy} en ${symbol} descartada — confianza ${sig.confidence}% < piso ${minConfidence}%`);
    } else {
      passed.push(sig);
    }
  });

  return passed;
}

module.exports = {
  evaluateAll,
  computeContextualScore,
  detectNYOpenKillZone,
  detectPivotsBreakoutReversal,
  detectPriceActionRsiEma,
  detectSupplyDemand,
  detectEmaCrossScalping,
  detectRsiDivergence,
  detectBollingerSqueeze,
  detectEthVwapScalp,
  detectEthMomentumBreakout,
  calculateRSISeries,
  calculateMACDSeries,
  calculateSMASeries,
  calculateEMASeries,
  calculateBollingerSeries,
  calculateVWAPSeries,
  getH1Bias
};

// ============================================================
// CHANGELOG DE ESTA REVISIÓN
// ============================================================
// 1. [Price Action + RSI + EMA] Se corrigió el filtro de zona invertido:
//    ahora COMPRA busca soporte y VENTA busca resistencia (antes era al revés).
// 2. [Price Action + RSI + EMA] Se eliminó la variable muerta `confirmBull`
//    que se calculaba pero nunca se usaba.
// 3. [Kill Zone NY — OBSOLETO, ver ítem 7] Este ítem describía la ventana
//    "10:30-11:00" de la versión anterior en hora Argentina. Quedó huérfano:
//    el ítem 7 de este mismo changelog reemplazó esa estrategia por
//    completo, y la ventana real ahora es 9:30-9:45 hora de Nueva York.
//    Se deja el texto original solo como referencia histórica de qué se
//    corrigió en su momento, no describe el código actual.
// 4. [Kill Zone NY — OBSOLETO, ver ítem 7] Mismo caso: mencionaba la vela
//    de apertura "(10:30)", también de la versión anterior. La vela de
//    apertura real ahora es 9:30 NY (ver detectNYOpenKillZone).
// 5. [Integración] El ejemplo de llamada a evaluateAll() ahora incluye el
//    parámetro htfCandles, necesario para que Supply and Demand aplique
//    el filtro de tendencia mayor.
// 6. [Indicadores] Se eliminó la función duplicada calculateEMASeriesFromIndex0,
//    unificada con calculateEMASeries (calculateMACDSeries ahora la reutiliza).
// 7. [Kill Zone] REEMPLAZADA por completo. La versión anterior ("Zona de
//    Caza") mezclaba esta idea con Silver Bullet de ICT, filtro MACD
//    obligatorio y una modalidad de continuación con Order Block/FVG que
//    no forman parte del método real de la infografía, además de usar un
//    offset fijo de Argentina que fallaba en horario de invierno de EE.UU.
//    Ahora detectNYOpenKillZone() implementa exactamente lo que muestra
//    la infografía: vela única 9:30-9:45 hora real de Nueva York, entrada
//    en la confirmación de ruptura (sin retest obligatorio), SL del otro
//    lado del rango, TP 1.5R-2R. Nada más.
// 8. [NUEVO] Se agregaron 3 estrategias específicas por símbolo, cada una
//    limitada a un solo activo dentro de evaluateAll() vía el parámetro
//    `symbol` (a diferencia de las demás, que corren en los 4 activos):
//    - eth_vwap_scalp (ETHUSD): reclaim de VWAP o breakout de rango, con
//      sesgo H1 (EMA20/EMA50) obligatorio. Usa htfCandles, ya disponible.
//    - eur_london_pullback_vwap (EURUSD): pullback a VWAP durante sesión
//      de Londres, con sesgo H1 y estructura de mercado (pivots).
//    - xau_vwap_reversion (XAUUSD): reversión tras extensión extrema desde
//      VWAP (barrida de banda + RSI(2) + confirmación EMA9/EMA21), con
//      filtro explícito de RR mínimo 1:1.5 (a diferencia de la mayoría de
//      las otras estrategias, acá si no se cumple se descarta la señal).
//    NOTA: esta entrega parte de la versión real subida a GitHub el 19/8
//    (que ya incluía los fixes de confluencia HTF en EMA Cross Scalping y
//    de banda de Bollinger en Divergencia RSI aplicados en otra sesión) —
//    esos dos fixes NO se tocaron, solo se agregaron las 3 estrategias
//    nuevas encima.
//    NOTA DE INTEGRACIÓN — decisiones tomadas explícitamente con el usuario:
//    (a) Las tres corren sobre el mismo timeframe base que ya se pasa a
//        evaluateAll() (M15 en producción), no se agregó un fetch nuevo de
//        M5 para no consumir cuota extra de Twelve Data.
//    (b) calculateVWAPSeries() usa volumen real cuando está disponible
//        (ETHUSD vía Binance/CoinGecko) y cae automáticamente a un promedio
//        de precio típico si el volumen acumulado del día da 0 (caso
//        esperable en EURUSD/XAUUSD, instrumentos OTC sin volumen de
//        mercado centralizado) — con console.warn para verificar en
//        producción cuál de los dos modos está usando cada símbolo.
//    PENDIENTE (no implementado en este archivo, requiere cambios en
//    engine.js): las reglas de gestión de riesgo por sesión/día que pedía
//    el usuario para estas 3 estrategias (máx. 3 señales por sesión, pausa
//    tras 2 stops seguidos, corte tras 3 stops o -2% acumulado en el día)
//    no se pueden calcular acá adentro — estas funciones son puras
//    (dependen solo de las velas recibidas) y no tienen acceso al
//    historial de señales cerradas del día. Esa info ya existe en Supabase
//    (`closed_signals:YYYY-MM-DD`, ver server.js), así que la forma de
//    implementarlo sería que engine.js calcule las estadísticas del día
//    para cada una de estas 3 estrategias antes de llamar a evaluateAll()
//    y se las pase como parámetro nuevo — no incluido en esta entrega.
// 9. [ELIMINADAS] (sesión 19/8) Se sacaron eur_london_pullback_vwap y
//    xau_vwap_reversion. Motivo: en EURUSD/XAUUSD (OTC, sin volumen real
//    centralizado) calculateVWAPSeries() caía al fallback de promedio de
//    precio típico — dato estimado, no volumen real de mercado. El usuario
//    decidió que la app solo opere con datos reales. Se mantiene
//    eth_vwap_scalp (ETHUSD sí tiene volumen real vía Binance/CoinGecko).
// 10. [NUEVO] (Etapa 3, sesión 25/8) Scoring contextual: cada señal que
//     dispara ahora trae confidence (0-100) calculado por
//     computeContextualScore(), en base a RR, alineación H1, régimen de
//     volatilidad (ATR actual vs reciente) e historial reciente
//     símbolo+estrategia. Decisión explícita del usuario: arranca
//     INFORMATIVO, no filtra ni bloquea ninguna señal — evaluar más
//     adelante, con datos reales, si conviene usarlo como filtro.
//     evaluateAll() ahora recibe symbolStats como 5º parámetro nuevo
//     (state.strategyStatsBySymbol[symbol], pasado desde engine.js) — cierra
//     el pendiente que ya estaba anotado en el punto 8 de este changelog.
// ============================================================
