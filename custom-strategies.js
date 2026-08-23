// ============================================================
// ESTRATEGIAS INDEPENDIENTES - PulseTrade PRO v4.6.2
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

function calculateMACDSeries(candles, fast = 12, slow = 26, signalPeriod = 9) {
  const n = candles.length;
  const emaFastFull = calculateEMASeries(candles, fast);
  const emaSlowFull = calculateEMASeries(candles, slow);
  const macdLine = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (emaFastFull[i] !== null && emaSlowFull[i] !== null) macdLine[i] = emaFastFull[i] - emaSlowFull[i];
  }
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
      usedVolumeFallback = true;
      vwapNow = cumTP / count;
    }
    vwap[i] = vwapNow;
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
function detectNYOpenKillZone(candles) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null, tp2: null, mode: null };
  if (!candles || candles.length < 5) return result;
  const last = candles[candles.length - 1];
  const lastNY = getNYTimeParts(last.time);
  if (lastNY.weekday === 'Sat' || lastNY.weekday === 'Sun') return result;
  const openMin = 9 * 60 + 30;
  const refEndMin = 9 * 60 + 45;
  const nowMin = lastNY.hour * 60 + lastNY.minute;
  if (nowMin < refEndMin) return result;
  let windowStartIdx = -1, windowEndIdx = -1;
  for (let i = candles.length - 1; i >= 0 && i >= candles.length - 200; i--) {
    const p = getNYTimeParts(candles[i].time);
    if (p.dateKey !== lastNY.dateKey) break;
    const m = p.hour * 60 + p.minute;
    if (m >= openMin && m < refEndMin) {
      if (windowEndIdx === -1) windowEndIdx = i;
      windowStartIdx = i;
    } else if (m < openMin) {
      break;
    }
  }
  if (windowStartIdx === -1 || windowEndIdx === -1) return result;
  const firstWindowNY = getNYTimeParts(candles[windowStartIdx].time);
  if (firstWindowNY.hour * 60 + firstWindowNY.minute !== openMin) return result;
  const windowCandles = candles.slice(windowStartIdx, windowEndIdx + 1);
  const rangeHigh = Math.max(...windowCandles.map(c => c.high));
  const rangeLow = Math.min(...windowCandles.map(c => c.low));
  const confirmCandles = candles.slice(windowEndIdx + 1).filter(c => getNYTimeParts(c.time).dateKey === lastNY.dateKey);
  if (!confirmCandles.length) return result;
  let breakoutCandle = null, direction = null;
  for (const c of confirmCandles) {
    if (c.close > rangeHigh) { breakoutCandle = c; direction = 'bull'; break; }
    if (c.close < rangeLow) { breakoutCandle = c; direction = 'bear'; break; }
  }
  if (!breakoutCandle) return result;
  if (breakoutCandle !== last) return result;
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
  result.tp1 = result.bullish ? entry + risk * 1.5 : entry - risk * 1.5;
  result.tp2 = result.bullish ? entry + risk * 2 : entry - risk * 2;
  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 2: PIVOTS BREAKOUT & REVERSAL
// ---------------------------------------------------------
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
  const smaCrossUp = sma5Prev !== null && sma10Prev !== null && sma5Now !== null && sma10Now !== null && sma5Prev <= sma10Prev && sma5Now > sma10Now;
  const smaCrossDown = sma5Prev !== null && sma10Prev !== null && sma5Now !== null && sma10Now !== null && sma5Prev >= sma10Prev && sma5Now < sma10Now;
  const smaAboveNow = sma5Now !== null && sma10Now !== null && sma5Now > sma10Now;
  const smaBelowNow = sma5Now !== null && sma10Now !== null && sma5Now < sma10Now;
  const macdPositive = macdNow !== null && macdNow > 0;
  const macdNegative = macdNow !== null && macdNow < 0;
  const macdCrossUp = macdPrev !== null && macdNow !== null && macdPrev <= 0 && macdNow > 0;
  const macdCrossDown = macdPrev !== null && macdNow !== null && macdPrev >= 0 && macdNow < 0;
  if (prev.close <= lastPH.price && last.close > lastPH.price && (smaCrossUp || smaAboveNow) && (macdPositive || macdCrossUp)) {
    result.bullish = true; result.mode = 'breakout'; result.entry = last.close;
    result.details.push(`Ruptura alcista de PH (${lastPH.price.toFixed(2)})`);
  } else if (prev.close >= lastPL.price && last.close < lastPL.price && (smaCrossDown || smaBelowNow) && (macdNegative || macdCrossDown)) {
    result.bearish = true; result.mode = 'breakout'; result.entry = last.close;
    result.details.push(`Ruptura bajista de PL (${lastPL.price.toFixed(2)})`);
  }
  if (!result.bullish && !result.bearish) {
    if (last.low < lastPL.price && last.close > lastPL.price) {
      const priorLow = PL.length >= 2 ? PL[PL.length - 2] : null;
      if (priorLow) {
        const priceLL = last.low < priorLow.price;
        const macdAtPrior = macdLine[priorLow.index];
        const macdHL = macdAtPrior !== null && macdNow !== null && macdNow > macdAtPrior;
        if (priceLL && macdHL) {
          result.bullish = true; result.mode = 'reversal'; result.entry = last.close;
          result.details.push('Reversión alcista: barrida de PL + divergencia alcista MACD');
        }
      }
    }
    if (!result.bullish && last.high > lastPH.price && last.close < lastPH.price) {
      const priorHigh = PH.length >= 2 ? PH[PH.length - 2] : null;
      if (priorHigh) {
        const priceHH = last.high > priorHigh.price;
        const macdAtPrior = macdLine[priorHigh.index];
        const macdLH = macdAtPrior !== null && macdNow !== null && macdNow < macdAtPrior;
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
    const sl = result.bullish ? refLevel * 0.985 : refLevel * 1.015;
    const risk = Math.abs(entry - sl);
    result.sl = sl;
    result.tp1 = result.bullish ? entry + risk * 2 : entry - risk * 2;
  }
  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 3: PRICE ACTION + RSI + EMA
// ---------------------------------------------------------
function findBrokenSRZones(candles, lookback = 40) {
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
  const vols = candles.slice(-21, -1).map(c => c.volume || 0);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const volOk = !avgVol || (last.volume || 0) > avgVol;
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
    result.tp1 = result.bullish ? result.entry + risk * 2 : result.entry - risk * 2;
    const nextLevel = result.bullish
      ? zones.filter(z => z.type === 'resistance' && z.price > result.entry).sort((a, b) => a.price - b.price)[0]
      : zones.filter(z => z.type === 'support' && z.price < result.entry).sort((a, b) => b.price - a.price)[0];
    result.tp2 = nextLevel ? nextLevel.price : result.tp1;
    result.rsiExitLevel = result.bullish ? 60 : 40;
  }
  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 4: SUPPLY AND DEMAND
// ---------------------------------------------------------
function findImpulseZones(candles, atr) {
  const zones = [];
  if (!candles || candles.length < 10 || !atr) return zones;
  for (let i = 2; i < candles.length - 1; i++) {
    const base = candles[i];
    const impulse = candles[i + 1];
    const baseBody = Math.abs(base.close - base.open);
    const impulseBody = Math.abs(impulse.close - impulse.open);
    if (impulseBody < atr * 1.5) continue;
    if (baseBody > impulseBody * 0.5) continue;
    const zoneLow = Math.min(base.open, base.close, base.low);
    const zoneHigh = Math.max(base.open, base.close, base.high);
    if (impulse.close > impulse.open) {
      zones.push({ type: 'demand', low: zoneLow, high: zoneHigh, formedAt: i, touches: 0 });
    } else if (impulse.close < impulse.open) {
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
    return last.close > last.open && prev.close < prev.open && last.close >= prev.open && last.open <= prev.close;
  }
  return last.close < last.open && prev.close > prev.open && last.open >= prev.close && last.close <= prev.open;
}

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
  const atr = calculateATR(candles);
  if (!atr) return result;
  const zoneSource = (htfCandles && htfCandles.length >= 15) ? htfCandles : candles;
  const zoneAtr = (zoneSource === candles) ? atr : calculateATR(zoneSource);
  if (!zoneAtr) return result;
  const zones = findImpulseZones(zoneSource, zoneAtr);
  if (!zones.length) return result;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  let htfTrend = 'neutral';
  if (htfCandles && htfCandles.length >= 50) {
    const ema20 = calculateEMASeries(htfCandles, 20);
    const ema50 = calculateEMASeries(htfCandles, 50);
    const i = htfCandles.length - 1;
    if (ema20[i] !== null && ema50[i] !== null) htfTrend = ema20[i] > ema50[i] ? 'bullish' : (ema20[i] < ema50[i] ? 'bearish' : 'neutral');
  } else if (htfCandles && htfCandles.length > 0) {
    console.warn(`[supply_demand] htfCandles insuficiente (${htfCandles.length} velas, se necesitan >=50) — filtro de tendencia mayor desactivado`);
  }
  const demandZones = zones.filter(z => z.type === 'demand').sort((a, b) => b.high - a.high);
  const supplyZones = zones.filter(z => z.type === 'supply').sort((a, b) => a.low - b.low);
  const priceInZone = (zone) => last.low <= zone.high && last.high >= zone.low;
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
          result.bullish = false;
        }
      }
    }
  }
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
            result.bearish = false;
          }
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 5: EMA CROSS SCALPING
// ---------------------------------------------------------
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
  if (crossUp && rsiNow > 50 && macdNow > signalNow && htfTrend === 'up') {
    result.bullish = true;
    result.entry = last.close;
    result.sl = result.entry * (1 - 0.01);
    result.tp1 = result.entry * (1 + 0.02);
    result.details.push(`Cruce EMA9>EMA21 + RSI ${rsiNow.toFixed(1)} (>50) + MACD alcista + tendencia HTF alcista`);
  } else if (crossDown && rsiNow < 50 && macdNow < signalNow && htfTrend === 'down') {
    result.bearish = true;
    result.entry = last.close;
    result.sl = result.entry * (1 + 0.01);
    result.tp1 = result.entry * (1 - 0.02);
    result.details.push(`Cruce EMA9<EMA21 + RSI ${rsiNow.toFixed(1)} (<50) + MACD bajista + tendencia HTF bajista`);
  }
  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 6: DIVERGENCIA RSI
// ---------------------------------------------------------
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
    result.tp1 = result.bullish ? result.entry + risk * 2 : result.entry - risk * 2;
    result.tp2 = result.bullish ? result.entry + risk * 3 : result.entry - risk * 3;
  }
  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 7: BOLLINGER SQUEEZE BREAKOUT
// ---------------------------------------------------------
function detectBollingerSqueeze(candles) {
  const result = { bullish: false, bearish: false, details: [], entry: null, sl: null, tp1: null, tp2: null };
  if (!candles || candles.length < 90) return result;
  const { sma, upper, lower, bandwidth } = calculateBollingerSeries(candles, 20, 2);
  const i = candles.length - 1;
  const last = candles[i];
  const prev = candles[i - 1];
  if (upper[i] === null || lower[i] === null || upper[i - 1] === null || lower[i - 1] === null) return result;
  const bwWindow = bandwidth.slice(Math.max(0, i - 59), i + 1).filter(v => v !== null);
  if (bwWindow.length < 30) return result;
  const sorted = [...bwWindow].sort((a, b) => a - b);
  const p20 = sorted[Math.floor(sorted.length * 0.2)];
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
    result.tp1 = result.bullish ? result.entry + risk * 2 : result.entry - risk * 2;
    result.tp2 = result.bullish ? result.entry + risk * 3 : result.entry - risk * 3;
  }
  return result;
}

// ---------------------------------------------------------
// ESTRATEGIA 8: ETH VWAP TREND SCALP
// ---------------------------------------------------------
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
  if (h1.bias === 'long' && vwapSlopeUp) {
    const pulledBack = candles[i - 1].close < candles[i - 1].open && candles[i - 2].close < candles[i - 2].open;
    const rejection = isPinBar(last, 'bull') && last.close > vwap[i];
    if (pulledBack && rejection) {
      result.bullish = true; result.mode = 'vwap_reclaim';
      result.entry = last.close;
      result.sl = last.low;
      const risk = result.entry - result.sl;
      result.tp1 = result.entry + risk * 1;
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
  if (!result.bullish && !result.bearish) {
    const lookback = 8;
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
// EVALUACIÓN CONJUNTA
// ---------------------------------------------------------
function safeRun(strategyName, fn, ...args) {
  try {
    return fn(...args);
  } catch (err) {
    console.warn(`[custom-strategies] ${strategyName} falló, se omite este ciclo: ${err.message}`);
    return { bullish: false, bearish: false, details: [] };
  }
}

function evaluateAll(candles, symbol, asset, htfCandles = null) {
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
  if (symbol === 'ETHUSD') {
    const ethVwap = safeRun('eth_vwap_scalp', detectEthVwapScalp, candles, htfCandles);
    if (ethVwap.bullish || ethVwap.bearish) {
      signals.push({
        strategy: 'eth_vwap_scalp', label: 'ETH VWAP Trend Scalp',
        direction: ethVwap.bullish ? 'long' : 'short', entry: ethVwap.entry, sl: ethVwap.sl, tp1: ethVwap.tp1, tp2: ethVwap.tp2,
        details: ethVwap.details, mode: ethVwap.mode, independent: true
      });
    }
  }
  return signals;
}

module.exports = {
  evaluateAll,
  detectNYOpenKillZone,
  detectPivotsBreakoutReversal,
  detectPriceActionRsiEma,
  detectSupplyDemand,
  detectEmaCrossScalping,
  detectRsiDivergence,
  detectBollingerSqueeze,
  detectEthVwapScalp,
  calculateRSISeries,
  calculateMACDSeries,
  calculateSMASeries,
  calculateEMASeries,
  calculateBollingerSeries,
  calculateVWAPSeries,
  getH1Bias
};
