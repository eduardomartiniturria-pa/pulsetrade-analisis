// ============================================================
// ESTRATEGIAS INDEPENDIENTES - PulseTrade PRO v4
// ============================================================
// Estas 3 estrategias NO pasan por SMCEngine.evalSide() ni por los
// filtros globales de confluencia (premium/discount, HTF trend, etc).
// Cada una se evalúa por sí sola, con su propia gestión de riesgo,
// tal como fueron definidas. Corren en paralelo a las estrategias SMC
// existentes (CHoCH, BOS, OB, FVG, Sweep, etc), sin mezclarse con ellas.
//
// Cómo integrar en engine.js:
//   const CustomStrategies = require('./custom-strategies');
//   ... dentro de refreshAsset(), después de calcular `analysis`:
//   const customSignals = CustomStrategies.evaluateAll(ohlcv.candles, symbol, asset);
//   customSignals.forEach(sig => resolveCustomSignal(symbol, sig, quote));
// (ver función resolveCustomSignal de ejemplo al final de este archivo)
// ============================================================

// ---------------------------------------------------------
// INDICADORES BASE (RSI, MACD, SMA) - no existían en engine.js
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
  const emaFastFull = calculateEMASeriesFromIndex0(candles, fast);
  const emaSlowFull = calculateEMASeriesFromIndex0(candles, slow);
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

// EMA calculada desde el índice 0 (necesaria para alinear MACD con velas exactas)
function calculateEMASeriesFromIndex0(candles, period) {
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

// ---------------------------------------------------------
// Utilidades de tiempo (hora Argentina, sin DST: UTC-3 fijo)
// ---------------------------------------------------------

function getArgTimeParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(new Date(ms));
  return {
    weekday: parts.find(p => p.type === 'weekday').value,
    hour: parseInt(parts.find(p => p.type === 'hour').value, 10) % 24,
    minute: parseInt(parts.find(p => p.type === 'minute').value, 10)
  };
}

function minutesOfDay(hour, minute) { return hour * 60 + minute; }

// ---------------------------------------------------------
// ESTRATEGIA 1: ZONA DE CAZA (Kill Zone NY, hora Argentina)
// ---------------------------------------------------------
// Rango completo 10:30-13:30 ARG. Bala de plata 11:00-12:00 ARG.
// PA = apertura de la vela de 10:30. T/P = máx/mín entre 10:30 y 11:00.
// Requiere velas de 15m (o menor) para poder ubicar la vela de 10:30 exacta.

function detectKillZoneNY(candles, opts = {}) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null, tp2: null, mode: null, silverBullet: false };
  if (!candles || candles.length < 20) return result;

  const last = candles[candles.length - 1];
  const lastArg = getArgTimeParts(last.time);
  if (lastArg.weekday === 'Sat' || lastArg.weekday === 'Sun') return result;

  const nowMin = minutesOfDay(lastArg.hour, lastArg.minute);
  const rangeStart = 10 * 60 + 30, rangeEnd = 13 * 60 + 30;
  const silverStart = 11 * 60, silverEnd = 12 * 60;
  if (nowMin < rangeStart || nowMin >= rangeEnd) return result; // fuera de horario, no aplica

  // Ubicar la vela de apertura (10:30) dentro del historial reciente
  let openIdx = -1;
  for (let i = candles.length - 1; i >= 0 && i >= candles.length - 60; i--) {
    const p = getArgTimeParts(candles[i].time);
    if (p.hour === 10 && p.minute >= 30 && p.minute < 45) { openIdx = i; break; }
  }
  if (openIdx === -1 || openIdx >= candles.length - 1) return result;

  const PA = candles[openIdx].open;

  // Techo (T) y Piso (P): máx/mín entre 10:30 y 11:00
  let windowEndIdx = openIdx;
  for (let i = openIdx; i < candles.length; i++) {
    const p = getArgTimeParts(candles[i].time);
    const m = minutesOfDay(p.hour, p.minute);
    if (m >= silverStart) break;
    windowEndIdx = i;
  }
  const kzWindow = candles.slice(openIdx, windowEndIdx + 1);
  if (!kzWindow.length) return result;
  const T = Math.max(...kzWindow.map(c => c.high));
  const P = Math.min(...kzWindow.map(c => c.low));

  const { macdLine, signalLine } = calculateMACDSeries(candles);
  const macdNow = macdLine[candles.length - 1];
  const signalNow = signalLine[candles.length - 1];
  const macdBullOk = macdNow !== null && signalNow !== null && macdNow > signalNow;
  const macdBearOk = macdNow !== null && signalNow !== null && macdNow < signalNow;

  const isSilverBullet = nowMin >= silverStart && nowMin < silverEnd;

  // --- Modalidad 1: Ruptura + Retroceso ---
  if (candles.length >= 2) {
    const prev = candles[candles.length - 2];
    // BUY: cierre de una vela por encima de T, y la siguiente toca T con la mecha (retroceso)
    if (prev.close > T && last.low <= T && last.close > T && macdBullOk) {
      result.bullish = true; result.mode = 'breakout_retest'; result.entry = T;
      result.details.push('Ruptura+Retroceso en Techo (Kill Zone NY)');
    }
    // SELL: cierre de una vela por debajo de P, y la siguiente toca P con la mecha
    if (prev.close < P && last.high >= P && last.close < P && macdBearOk) {
      result.bearish = true; result.mode = 'breakout_retest'; result.entry = P;
      result.details.push('Ruptura+Retroceso en Piso (Kill Zone NY)');
    }
  }

  // --- Modalidad 2: Continuación de tendencia (OB simplificado + FVG dentro de la zona) ---
  if (!result.bullish && !result.bearish && candles.length >= 5) {
    const zoneCandles = candles.slice(openIdx);
    if (zoneCandles.length >= 4) {
      const highs = zoneCandles.map(c => c.high), lows = zoneCandles.map(c => c.low);
      const risingLows = lows.length >= 3 && lows[lows.length - 1] > lows[lows.length - 3];
      const fallingHighs = highs.length >= 3 && highs[highs.length - 1] < highs[highs.length - 3];

      const c1 = candles[candles.length - 4], c3 = candles[candles.length - 2];
      const fvgBull = c3.low > c1.high && last.close > c3.low;
      const fvgBear = c3.high < c1.low && last.close < c3.high;

      const prev2 = candles[candles.length - 3], prev1 = candles[candles.length - 2];
      const obBull = prev2.close < prev2.open && prev1.close > prev1.open && last.close > prev1.high;
      const obBear = prev2.close > prev2.open && prev1.close < prev1.open && last.close < prev1.low;

      if (risingLows && (fvgBull || obBull)) {
        result.bullish = true; result.mode = 'trend_continuation'; result.entry = last.close;
        result.details.push(`Continuación alcista en Kill Zone NY (${obBull ? 'Order Block' : 'FVG'})`);
      } else if (fallingHighs && (fvgBear || obBear)) {
        result.bearish = true; result.mode = 'trend_continuation'; result.entry = last.close;
        result.details.push(`Continuación bajista en Kill Zone NY (${obBear ? 'Order Block' : 'FVG'})`);
      }
    }
  }

  if (result.bullish || result.bearish) {
    result.silverBullet = isSilverBullet;
    const entry = result.entry || last.close;
    // Gestión de riesgo: SL detrás del último pivote visible, o 1.5% si no hay pivote claro
    const pivotSL = result.bullish ? P : T;
    const hasPivot = result.mode === 'breakout_retest';
    const sl = hasPivot ? pivotSL : (result.bullish ? entry * 0.985 : entry * 1.015);
    const risk = Math.abs(entry - sl);
    result.entry = entry; result.sl = sl;
    result.tp1 = result.bullish ? entry + risk * 2 : entry - risk * 2; // RR 1:2
    result.tp2 = result.bullish ? entry + risk * 3 : entry - risk * 3; // liquidez visible aproximada 1:3
    if (isSilverBullet) result.details.push('Dentro de Bala de Plata (11:00-12:00 ARG, prioridad máxima)');
  }

  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 2: PIVOTS BREAKOUT & REVERSAL
// ---------------------------------------------------------
// PH: máximo de la vela > máximo de las 4 anteriores y > máximo de las 2 siguientes.
// PL: mínimo de la vela < mínimo de las 4 anteriores y < mínimo de las 2 siguientes.
// No tiene restricción horaria. Recomendado 15m.

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
  if (!candles || candles.length < 10) return result;

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
    const sl = result.bullish ? refLevel * 0.985 : refLevel * 1.015; // 1.5% del nivel roto
    const risk = Math.abs(entry - sl);
    result.sl = sl;
    result.tp1 = result.bullish ? entry + risk * 2 : entry - risk * 2; // RR 1:2 fijo
  }

  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 3: PRICE ACTION + RSI + EMA (Bullish/Bearish Momentum)
// ---------------------------------------------------------
// Requiere EMA20, EMA50, RSI14. Las 4 condiciones deben cumplirse TODAS.
// Filtro opcional de volumen (vela de entrada > promedio de 20).

function findBrokenSRZones(candles, lookback = 40) {
  // Zonas simples: swing highs/lows recientes que el precio ya rompió (retest)
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
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null, tp2: null, tp3: null };
  if (!candles || candles.length < 60) return result;

  const ema20 = calculateEMASeries(candles, 20);
  const ema50 = calculateEMASeries(candles, 50);
  const rsi = calculateRSISeries(candles, 14);

  const i = candles.length - 1;
  const last = candles[i];
  const prev = candles[i - 1];
  const e20 = ema20[i], e50 = ema50[i], rsiNow = rsi[i];
  if (e20 === null || e50 === null || rsiNow === null) return result;

  const zones = findBrokenSRZones(candles);
  const tolerance = (Math.max(...candles.slice(-20).map(c => c.high)) - Math.min(...candles.slice(-20).map(c => c.low))) * 0.01;

  // Volumen: vela de entrada vs promedio de últimas 20
  const vols = candles.slice(-21, -1).map(c => c.volume || 0);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const volOk = !avgVol || (last.volume || 0) > avgVol;

  // --- Lado BUY ---
  const bullEmaAligned = e20 > e50;
  const touchedEma50Bull = last.low <= e50 + tolerance || (last.open <= e50 + tolerance && last.close >= e50 - tolerance);
  const resistanceZone = zones.find(z => z.type === 'resistance' && Math.abs(last.close - z.price) <= tolerance * 3);
  const rsiOversold = rsiNow <= 40;
  const confirmBull = last.close > last.open && prev.close <= prev.open === false ? true : last.close > last.open;

  if (bullEmaAligned && touchedEma50Bull && resistanceZone && rsiOversold && last.close > last.open && volOk) {
    result.bullish = true;
    result.entry = last.close;
    result.sl = last.low;
    result.details.push(`Momentum alcista: EMA20>EMA50, retest EMA50 y S/R (${resistanceZone.price.toFixed(2)}), RSI ${rsiNow.toFixed(1)} (<=40)`);
  }

  // --- Lado SELL (espejo) ---
  const bearEmaAligned = e20 < e50;
  const touchedEma50Bear = last.high >= e50 - tolerance || (last.open >= e50 - tolerance && last.close <= e50 + tolerance);
  const supportZone = zones.find(z => z.type === 'support' && Math.abs(last.close - z.price) <= tolerance * 3);
  const rsiOverbought = rsiNow >= 60;

  if (!result.bullish && bearEmaAligned && touchedEma50Bear && supportZone && rsiOverbought && last.close < last.open && volOk) {
    result.bearish = true;
    result.entry = last.close;
    result.sl = last.high;
    result.details.push(`Momentum bajista: EMA20<EMA50, retest EMA50 y S/R (${supportZone.price.toFixed(2)}), RSI ${rsiNow.toFixed(1)} (>=60)`);
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
// Timeframe principal (HTF): H1/H4 -> se usa htfCandles (ya se piden en engine.js).
// Timeframe de entrada: M15/M5 -> se usa `candles` (el timeframe activo del motor).
// Zonas: base de una vela/grupo antes de un impulso fuerte (igual concepto que Order
// Block, pero acá se trackea CUÁNTAS VECES fue tocada la zona después de formada -
// "fresca" = 0-1 toques). Se descartan zonas ya muy tocadas.
// Confirmación de entrada: pin bar o engulfing en la zona, a favor de la tendencia mayor
// (EMA20 vs EMA50 en HTF). SL detrás de la zona, TP en la zona opuesta más cercana.

function findImpulseZones(candles, atr) {
  // Detecta zonas de oferta/demanda: una vela base (cuerpo chico) seguida de un
  // movimiento impulsivo (cuerpo grande, >= 1.5x ATR) en la dirección opuesta al lado
  // de la zona. La zona es el rango de la vela base.
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

  // Contar toques posteriores a la formación (cuántas veces el precio volvió a la zona
  // desde que se formó). "Fresca" = 0 o 1 toque. Más de eso, se descarta.
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

function detectSupplyDemand(candles, htfCandles) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null };
  if (!candles || candles.length < 15) return result;

  // ATR del timeframe de entrada, para dimensionar impulsos y definir zonas
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trueRanges.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr = trueRanges.length ? trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length) : null;
  if (!atr) return result;

  // Zonas detectadas en el timeframe HTF si está disponible (más confiables/"reales"),
  // si no, se cae al timeframe de entrada.
  const zoneSource = (htfCandles && htfCandles.length >= 15) ? htfCandles : candles;
  const zones = findImpulseZones(zoneSource, atr);
  if (!zones.length) return result;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // Filtro de tendencia mayor: EMA20 vs EMA50 en HTF (si hay datos suficientes)
  let htfTrend = 'neutral';
  if (htfCandles && htfCandles.length >= 50) {
    const ema20 = calculateEMASeries(htfCandles, 20);
    const ema50 = calculateEMASeries(htfCandles, 50);
    const i = htfCandles.length - 1;
    if (ema20[i] !== null && ema50[i] !== null) htfTrend = ema20[i] > ema50[i] ? 'bullish' : (ema20[i] < ema50[i] ? 'bearish' : 'neutral');
  }

  // Zona de demanda más cercana por debajo, zona de oferta más cercana por arriba
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
// EVALUACIÓN CONJUNTA (independiente, sin pasar por evalSide)
// ---------------------------------------------------------

function evaluateAll(candles, symbol, asset, htfCandles = null) {
  const signals = [];

  const kz = detectKillZoneNY(candles);
  if (kz.bullish || kz.bearish) {
    signals.push({
      strategy: 'kill_zone_ny', label: 'Zona de Caza (Kill Zone NY)',
      direction: kz.bullish ? 'long' : 'short', entry: kz.entry, sl: kz.sl, tp1: kz.tp1, tp2: kz.tp2,
      details: kz.details, silverBullet: kz.silverBullet, independent: true
    });
  }

  const piv = detectPivotsBreakoutReversal(candles);
  if (piv.bullish || piv.bearish) {
    signals.push({
      strategy: 'pivots_breakout_reversal', label: 'Pivots Breakout & Reversal',
      direction: piv.bullish ? 'long' : 'short', entry: piv.entry, sl: piv.sl, tp1: piv.tp1,
      details: piv.details, mode: piv.mode, independent: true
    });
  }

  const pa = detectPriceActionRsiEma(candles);
  if (pa.bullish || pa.bearish) {
    signals.push({
      strategy: 'price_action_rsi_ema', label: 'Price Action + RSI + EMA',
      direction: pa.bullish ? 'long' : 'short', entry: pa.entry, sl: pa.sl, tp1: pa.tp1, tp2: pa.tp2,
      rsiExitLevel: pa.rsiExitLevel, details: pa.details, independent: true
    });
  }

  const sd = detectSupplyDemand(candles, htfCandles);
  if (sd.bullish || sd.bearish) {
    signals.push({
      strategy: 'supply_demand', label: 'Supply and Demand',
      direction: sd.bullish ? 'long' : 'short', entry: sd.entry, sl: sd.sl, tp1: sd.tp1,
      details: sd.details, independent: true
    });
  }

  return signals;
}

module.exports = {
  evaluateAll,
  detectKillZoneNY,
  detectPivotsBreakoutReversal,
  detectPriceActionRsiEma,
  detectSupplyDemand,
  calculateRSISeries,
  calculateMACDSeries,
  calculateSMASeries
};
