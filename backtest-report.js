'use strict';
// ============================================================
// PulseTrade - backtest-report.js v1 (6/11)
// ============================================================
// Backtest EN R de las estrategias activas, corrido DENTRO de la app con las velas que baja Twelve Data
// (no hay que descargar nada a mano). Publica el resultado en /api/state -> diagnostics.backtestReport.
//
// Que hace:
//  - Corre CustomStrategies.evaluateAll() vela por vela, con la misma ventana (150 velas M15) y el mismo
//    contexto H1 que usa el motor en vivo (solo velas H1 ya cerradas: sin mirar el futuro).
//  - Aplica los mismos filtros del motor: estrategias habilitadas, deshabilitadas por simbolo, confianza
//    minima, compuerta de costo (spread / stop), ensanche x1.5 del SL del oro y buffer de confirmacion del TP.
//  - Una sola posicion abierta por estrategia y simbolo (igual que la app), con el vencimiento propio de
//    cada estrategia.
//  - Resultado en R NETO de spread (se descuenta una vez por operacion, como en vivo).
//  - Tres modelos de salida por operacion: "registered" (como paga la app: TP2 si existe, si no TP1),
//    "oneR" (todo en +1R) y "tp1" (todo en TP1).
//  - Dos variantes del codigo para comparar sobre los MISMOS datos: "actual" (flags tal como estan) y
//    "previo" (kill_zone_ny con entrada a mercado y session_breakout_vwap con TP1 1.5R / TP2 2R).
//  - Corte temporal 60/40: primeras 60% de las operaciones (donde se pudo ajustar) contra el 40% final.
//
// Supuestos y limites (quedan escritos tambien en el reporte):
//  - Si en la misma vela se tocan SL y TP, se cuenta el SL (lo conservador).
//  - Entrada = precio de la señal (cierre de la vela) + spread estimado; sin slippage.
//  - No simula el tope diario de perdida, el tope de exposicion USD, la probation ni las noticias.
//  - US500 se corre sobre SPY escalado por priceMultiplier, como el motor en vivo.
// ============================================================

const MIN_LOOKBACK = 60;
const WINDOW_SIZE = 150;
const CHUNK = 200;           // ventanas por tanda sincronica (despues se cede el control al motor en vivo)

function round(x, d = 2) { return (x == null || !isFinite(x)) ? null : +x.toFixed(d); }

function summarize(list) {
  const n = list.length;
  if (!n) return { n: 0 };
  let wins = 0, losses = 0, expired = 0, sum = 0, gw = 0, gl = 0;
  list.forEach(o => {
    sum += o.r;
    if (o.res === 'win') wins++; else if (o.res === 'loss') losses++; else expired++;
    if (o.r > 0) gw += o.r; else gl += -o.r;
  });
  return {
    n, wins, losses, expired,
    winRatePct: round(wins / n * 100, 0),
    avgR: round(sum / n), totalR: round(sum),
    profitFactor: gl > 0 ? round(gw / gl) : null
  };
}

// Silencia TODA la salida de consola durante una tanda. Es seguro hacerlo porque la tanda es sincronica: mientras
// dura no puede correr ningun otro codigo del motor en vivo, asi que todo lo que se imprime viene de evaluateAll()
// (miles de lineas de "descartada por confianza", "bloqueado por filtro H1", etc.). Se restaura siempre (finally).
function quiet(fn) {
  const origLog = console.log, origWarn = console.warn, origInfo = console.info;
  console.log = console.warn = console.info = () => {};
  try { return fn(); } finally { console.log = origLog; console.warn = origWarn; console.info = origInfo; }
}

// Simula UNA operacion hacia adelante. Devuelve null si no hay velas futuras, o {blocked} si la bloquea la
// compuerta de costo.
function simulateTrade(sig, candles, i, ctx) {
  let entry = sig.entry, sl = sig.sl, tp1 = sig.tp1;
  let tp2 = (sig.tp2 !== undefined && sig.tp2 !== null) ? sig.tp2 : null;
  if (entry == null || sl == null || tp1 == null) return null;
  const isLong = sig.direction === 'long';

  // Mismo ensanche que engine.js (v4.6.2): SL x1.5 en oro, TPs recalculados con el mismo RR.
  if (ctx.symbol === 'XAUUSD') {
    const risk0 = Math.abs(entry - sl);
    if (risk0 > 0) {
      const rr1 = Math.abs(tp1 - entry) / risk0;
      const rr2 = tp2 !== null ? Math.abs(tp2 - entry) / risk0 : null;
      const newRisk = risk0 * 1.5;
      sl = isLong ? entry - newRisk : entry + newRisk;
      tp1 = isLong ? entry + newRisk * rr1 : entry - newRisk * rr1;
      if (rr2 !== null) tp2 = isLong ? entry + newRisk * rr2 : entry - newRisk * rr2;
    }
  }
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;

  const costPrice = ctx.spreadPips * ctx.pipSize;
  const costR = costPrice / risk;
  if (ctx.costGateMax != null && costR > ctx.costGateMax) return { blocked: 'costGate' };

  const lastIdx = Math.min(candles.length - 1, i + ctx.expiryCandles);
  if (i + 1 > lastIdx) return null;

  const dir = isLong ? 1 : -1;
  const regR = Math.abs((tp2 !== null ? tp2 : tp1) - entry) / risk;
  const tp1R = Math.abs(tp1 - entry) / risk;
  const buf = ctx.tpBufferPrice || 0;

  const runModel = targetR => {
    const target = entry + dir * risk * targetR;
    for (let j = i + 1; j <= lastIdx; j++) {
      const c = candles[j];
      const slHit = isLong ? c.low <= sl : c.high >= sl;
      const tpHit = isLong ? c.high >= target + buf : c.low <= target - buf;
      if (slHit) return { r: -1 - costR, res: 'loss', idx: j };      // SL primero si toca ambos (conservador)
      if (tpHit) return { r: targetR - costR, res: 'win', idx: j };
    }
    const c = candles[lastIdx];
    return { r: dir * (c.close - entry) / risk - costR, res: 'expired', idx: lastIdx };
  };

  return {
    time: candles[i].time, symbol: ctx.symbol, strategy: sig.strategy, direction: sig.direction,
    riskPips: round(risk / ctx.pipSize, 1), costR: round(costR, 3),
    models: { registered: runModel(regR), oneR: runModel(1), tp1: runModel(tp1R) }
  };
}

function pack(arr) {
  return {
    registered: summarize(arr.map(t => t.models.registered)),
    oneR: summarize(arr.map(t => t.models.oneR)),
    tp1: summarize(arr.map(t => t.models.tp1)),
    reached1RPct: arr.length ? round(arr.filter(t => t.models.oneR.res === 'win').length / arr.length * 100, 0) : null
  };
}

function aggregate(trades) {
  const byStrat = {};
  trades.forEach(t => { (byStrat[t.strategy] = byStrat[t.strategy] || []).push(t); });
  const out = {};
  Object.keys(byStrat).forEach(s => {
    const ts = byStrat[s].slice().sort((a, b) => a.time - b.time);
    const cut = Math.floor(ts.length * 0.6);
    const bySymbol = {};
    ts.forEach(t => { (bySymbol[t.symbol] = bySymbol[t.symbol] || []).push(t); });
    const sym = {};
    Object.keys(bySymbol).forEach(k => { sym[k] = pack(bySymbol[k]); });
    out[s] = {
      all: pack(ts),
      first60pct: ts.length >= 10 ? pack(ts.slice(0, cut)) : null,
      last40pct: ts.length >= 10 ? pack(ts.slice(cut)) : null,
      bySymbol: sym
    };
  });
  return out;
}

async function runVariant(variant, symbolsData, deps) {
  const trades = [];
  const blocked = {};
  const cfg = deps.config;
  for (const symbol of Object.keys(symbolsData)) {
    const { m15, h1 } = symbolsData[symbol];
    const asset = deps.assets[symbol];
    const disabled = (deps.disabledBySymbol && deps.disabledBySymbol[symbol]) || [];
    const ctxBase = {
      symbol, pipSize: asset.pipSize || 0.0001,
      spreadPips: (cfg.spreadPips && cfg.spreadPips[symbol]) || 0,
      tpBufferPrice: ((cfg.tpBufferPips && cfg.tpBufferPips[symbol]) || 0) * (asset.pipSize || 0.0001),
      costGateMax: cfg.costGateMax
    };
    const busy = {};
    let h1Ptr = 0;
    for (let start = MIN_LOOKBACK; start < m15.length - 1; start += CHUNK) {
      const end = Math.min(start + CHUNK, m15.length - 1);
      deps.withFlags(variant.flags, () => quiet(() => {
        for (let i = start; i < end; i++) {
          const tEnd = m15[i].time + 15 * 60 * 1000;
          while (h1Ptr < h1.length && h1[h1Ptr].time + 3600 * 1000 <= tEnd) h1Ptr++;
          const htf = h1.slice(Math.max(0, h1Ptr - 100), h1Ptr);
          const win = m15.slice(Math.max(0, i - WINDOW_SIZE + 1), i + 1);
          let sigs;
          try { sigs = deps.evaluateAll(win, symbol, asset, htf, null, null, cfg.minConfidence); } catch (e) { continue; }
          for (const sig of sigs) {
            if (!deps.enabled.includes(sig.strategy)) continue;
            if (disabled.includes(sig.strategy)) continue;
            if ((sig.confidence || 0) < cfg.confThreshold) continue;
            if (busy[sig.strategy] != null && i <= busy[sig.strategy]) continue;
            const expMs = (cfg.expirationMs && cfg.expirationMs[sig.strategy]) || cfg.defaultExpirationMs;
            const t = simulateTrade(sig, m15, i, Object.assign({}, ctxBase, { expiryCandles: Math.max(1, Math.round(expMs / (15 * 60 * 1000))) }));
            if (!t) continue;
            if (t.blocked) { blocked[sig.strategy] = (blocked[sig.strategy] || 0) + 1; continue; }
            trades.push(t);
            busy[sig.strategy] = t.models.registered.idx;
          }
        }
      }));
      await deps.yieldFn();
    }
  }
  return { byStrategy: aggregate(trades), blockedByCostGate: blocked, totalTrades: trades.length };
}

async function run(deps) {
  const report = {
    version: 1, status: 'corriendo', generatedAt: Date.now(), engineVersion: deps.engineVersion || null,
    data: {}, notes: [],
    assumptions: [
      'Si en la misma vela se tocan SL y TP se cuenta el SL (conservador).',
      'Entrada = cierre de la vela de la señal; spread estimado descontado una vez por operacion; sin slippage.',
      'Una posicion abierta por estrategia y simbolo; vencimiento propio de cada estrategia.',
      'No simula tope diario de perdida, tope de exposicion USD, probation, ni noticias.',
      'Incluye ensanche x1.5 del SL del oro, buffer de confirmacion del TP y compuerta de costo, como el motor en vivo.',
      'winRatePct cuenta las vencidas como no ganadas. avgR y totalR son netos de spread.',
      'Con menos de ~30 operaciones por estrategia el resultado es orientativo, no concluyente.'
    ]
  };
  const symbolsData = {};
  for (const symbol of deps.symbols) {
    if (deps.shouldAbort && deps.shouldAbort()) { report.status = 'abortado'; return report; }
    try {
      deps.progress(`descargando ${symbol} M15`);
      const m15 = await deps.fetchM15(symbol);
      deps.progress(`descargando ${symbol} H1`);
      const h1 = await deps.fetchH1(symbol);
      if (!m15 || m15.length < MIN_LOOKBACK + 50 || !h1 || h1.length < 60) { report.notes.push(`${symbol}: datos insuficientes, se omite`); continue; }
      symbolsData[symbol] = { m15, h1 };
      report.data[symbol] = {
        m15Bars: m15.length, h1Bars: h1.length,
        from: new Date(m15[0].time).toISOString().slice(0, 10), to: new Date(m15[m15.length - 1].time).toISOString().slice(0, 10)
      };
    } catch (e) {
      report.notes.push(`${symbol}: error al descargar (${e.message})`);
    }
  }
  if (!Object.keys(symbolsData).length) { report.status = 'sin datos'; return report; }

  report.variants = {};
  for (const variant of deps.variants) {
    deps.progress(`simulando variante ${variant.name}`);
    report.variants[variant.name] = Object.assign({ descripcion: variant.description }, await runVariant(variant, symbolsData, deps));
  }
  report.status = 'ok';
  report.finishedAt = Date.now();
  return report;
}

module.exports = { run, _simulateTrade: simulateTrade, _summarize: summarize, _aggregate: aggregate };
