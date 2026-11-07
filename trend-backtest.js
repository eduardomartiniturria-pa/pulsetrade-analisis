'use strict';
// ============================================================
// PULSE TRADE - trend-backtest.js v2 (7/11) - BACKTEST Y TABLERO DE TENDENCIA EN VELAS DIARIAS
// ============================================================
// SOLO MEDICION Y AVISO. No genera señales de la app, no toca estrategias ni nada que opere en vivo.
// v2: ademas del backtest, runBoard() calcula el TABLERO DIARIO de tendencia (niveles, stop sugerido y eventos de
// entrada/salida/stop del sistema 55/20 de solo compras) para operarlo a mano en MT5 desde el celular.
// Motivo: la evidencia externa (seguimiento de tendencia en horizontes largos, donde el costo pesa poco)
// es lo unico con respaldo de decadas. Antes de escribir una estrategia en vivo se prueba aca con ~20 años
// de velas diarias (5000 velas por activo de Twelve Data: 4 pedidos en total, una sola vez al dia como maximo).
//
// Sistema probado (clasico de canal de Donchian, sin parametros optimizados):
//  - Entrada: el cierre diario supera el maximo de las ultimas N velas (largo) o pierde el minimo (corto). Entra al ABRIR del dia siguiente.
//  - Stop inicial: 2.5 x ATR(20) desde la entrada (intradiario; si abre con gap mas alla del stop, sale a la apertura).
//  - Salida: el cierre rompe el minimo (largo) / maximo (corto) de las ultimas M velas. Sale al ABRIR del dia siguiente.
//  - Una sola posicion por activo; vuelve a entrar solo con una nueva ruptura estando fuera.
// Variantes (pocas, a proposito, para no ajustar al ruido): 55/20 y 20/10, solo largos y largos+cortos.
//
// Como leer el resultado (criterio fijado ANTES de ver datos):
//  una variante es candidata solo si en AMBOS tramos (primer 60% y ultimo 40% del tiempo) el R promedio neto del grupo
//  foco (XAUUSD + US500) es > 0, con al menos 40 operaciones y profit factor > 1.2. Con 4 variantes x 4 activos hay 16
//  combinaciones: alguna dara bien por azar. Se compara siempre contra comprar-y-mantener y contra tiempoEnMercadoPct.

const MIN_BARS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

const VARIANTS = [
  { key: 'donchian_55_20_largos', entryN: 55, exitN: 20, longOnly: true, description: 'Canal 55/20, solo compras.' },
  { key: 'donchian_55_20_largos_y_cortos', entryN: 55, exitN: 20, longOnly: false, description: 'Canal 55/20, compras y ventas.' },
  { key: 'donchian_20_10_largos', entryN: 20, exitN: 10, longOnly: true, description: 'Canal 20/10 (mas rapido), solo compras.' },
  { key: 'donchian_20_10_largos_y_cortos', entryN: 20, exitN: 10, longOnly: false, description: 'Canal 20/10 (mas rapido), compras y ventas.' }
];
const ATR_N = 20;
const STOP_ATR = 2.5;
const FOCUS_SYMBOLS = ['XAUUSD', 'US500'];
const CRYPTO_SYMBOLS = ['BTCUSD', 'ETHUSD'];

function atrSeries(c, n) {
  const out = new Array(c.length).fill(null);
  if (c.length <= n) return out;
  const tr = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  }
  let sum = 0;
  for (let i = 1; i <= n; i++) sum += tr[i];
  let a = sum / n;
  out[n] = a;
  for (let i = n + 1; i < c.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; } // Wilder / RMA
  return out;
}

function highestHigh(c, from, to) { let h = -Infinity; for (let i = from; i <= to; i++) if (c[i].high > h) h = c[i].high; return h; }
function lowestLow(c, from, to) { let l = Infinity; for (let i = from; i <= to; i++) if (c[i].low < l) l = c[i].low; return l; }

// Simula un sistema sobre velas diarias CERRADAS ordenadas de mas vieja a mas nueva.
function simulate(c, params, spreadPrice) {
  const atr = atrSeries(c, ATR_N);
  const warm = Math.max(params.entryN, ATR_N) + 1;
  const trades = [];
  let pos = null, pendEntry = null, pendExit = false;
  const close = (p, price, idx, reason) => {
    const rGross = p.dir * (price - p.entry) / p.risk;
    const rNet = rGross - (spreadPrice / p.risk);
    trades.push({
      entryTime: c[p.entryIdx].time, exitTime: c[idx].time, dir: p.dir, rNet: +rNet.toFixed(3),
      holdDays: Math.max(1, (c[idx].time - c[p.entryIdx].time) / DAY_MS), reason
    });
  };
  for (let t = warm; t < c.length; t++) {
    const bar = c[t];
    if (pos && pendExit) { close(pos, bar.open, t, 'canal'); pos = null; pendExit = false; }
    if (!pos && pendEntry) {
      const risk = STOP_ATR * pendEntry.atr;
      pos = { dir: pendEntry.dir, entry: bar.open, risk, stop: pendEntry.dir > 0 ? bar.open - risk : bar.open + risk, entryIdx: t };
      pendEntry = null;
    }
    if (pos) {
      if (pos.dir > 0 && bar.low <= pos.stop) { close(pos, bar.open < pos.stop ? bar.open : pos.stop, t, 'stop'); pos = null; pendExit = false; }
      else if (pos.dir < 0 && bar.high >= pos.stop) { close(pos, bar.open > pos.stop ? bar.open : pos.stop, t, 'stop'); pos = null; pendExit = false; }
    }
    if (pos) {
      if (pos.dir > 0 && bar.close < lowestLow(c, t - params.exitN, t - 1)) pendExit = true;
      else if (pos.dir < 0 && bar.close > highestHigh(c, t - params.exitN, t - 1)) pendExit = true;
    } else if (!pendEntry && atr[t] != null) {
      if (bar.close > highestHigh(c, t - params.entryN, t - 1)) pendEntry = { dir: 1, atr: atr[t] };
      else if (!params.longOnly && bar.close < lowestLow(c, t - params.entryN, t - 1)) pendEntry = { dir: -1, atr: atr[t] };
    }
  }
  return {
    trades, openAtEnd: pos ? 1 : 0,
    openPos: pos ? { dir: pos.dir, entry: pos.entry, stop: pos.stop, risk: pos.risk, entryTime: c[pos.entryIdx].time } : null,
    pendEntry, pendExit
  };
}

function stats(trades, totalDays) {
  if (!trades.length) return { n: 0 };
  const sorted = trades.slice().sort((a, b) => a.exitTime - b.exitTime);
  let wins = 0, sumPos = 0, sumNeg = 0, total = 0, peak = 0, dd = 0, cum = 0, hold = 0, best = -Infinity, worst = Infinity;
  sorted.forEach(t => {
    const r = t.rNet;
    if (r > 0) { wins++; sumPos += r; } else sumNeg += r;
    total += r; cum += r; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum;
    hold += t.holdDays; if (r > best) best = r; if (r < worst) worst = r;
  });
  const n = sorted.length;
  return {
    n, wins, losses: n - wins, winRatePct: Math.round((wins / n) * 100),
    avgR: +(total / n).toFixed(3), totalR: +total.toFixed(2),
    profitFactor: sumNeg < 0 ? +(sumPos / Math.abs(sumNeg)).toFixed(2) : null,
    maxDrawdownR: +dd.toFixed(2), avgHoldDays: +(hold / n).toFixed(1),
    bestR: +best.toFixed(2), worstR: +worst.toFixed(2),
    timeInMarketPct: totalDays ? Math.round((hold / totalDays) * 100) : null
  };
}

function byYear(trades) {
  const o = {};
  trades.forEach(t => {
    const y = new Date(t.exitTime).getUTCFullYear();
    if (!o[y]) o[y] = { n: 0, totalR: 0 };
    o[y].n++; o[y].totalR = +(o[y].totalR + t.rNet).toFixed(2);
  });
  return o;
}

function splitTrades(trades, cutoff) {
  return { first60pct: trades.filter(t => t.entryTime < cutoff), last40pct: trades.filter(t => t.entryTime >= cutoff) };
}

function pack(trades, totalDays, cutoff) {
  const sp = splitTrades(trades, cutoff);
  return { all: stats(trades, totalDays), first60pct: stats(sp.first60pct, null), last40pct: stats(sp.last40pct, null) };
}

async function run(deps) {
  const report = {
    version: 1, status: 'ok', generatedAt: Date.now(), engineVersion: deps.engineVersion,
    data: {}, notes: [],
    assumptions: [
      'Señal al cierre de la vela diaria; entrada y salida por canal al ABRIR del dia siguiente. El stop es intradiario (con gap, sale a la apertura).',
      'Stop inicial 2.5 x ATR(20). Una posicion por activo, sin pirámide y sin reentradas hasta salir.',
      'Spread estimado descontado una vez por operacion; sin slippage y SIN swaps/financiamiento nocturno (en operaciones de semanas pueden restar de forma material).',
      'Velas diarias en UTC (corte 00:00 UTC), no el cierre de Exness. US500 usa SPY x multiplicador, sin ajuste por dividendos.',
      'R promedio es por operacion con riesgo igual. Con ~15-40 operaciones por activo en 20 años el resultado de un solo activo es orientativo: mirar el grupo foco (XAUUSD+US500) y los dos tramos.',
      'Criterio de lectura fijado antes de ver datos: candidata solo si en AMBOS tramos (60/40) el avgR del grupo foco es > 0, con n >= 40 y profit factor > 1.2. 4 variantes x 4 activos = 16 combinaciones: alguna sale bien por azar.',
      'Comparar siempre con buyAndHold y timeInMarketPct: en un activo que subio mucho, un sistema de solo compras se ve bien sin tener ventaja propia.'
    ],
    variants: {}
  };
  const series = {};
  const symbols = deps.symbols || [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    if (deps.shouldAbort && deps.shouldAbort()) throw new Error('abortado (proveedor en cooldown)');
    deps.progress && deps.progress(`bajando velas diarias ${sym} (${i + 1}/${symbols.length})`);
    let candles = null;
    try { candles = await deps.fetchD1(sym); } catch (e) { report.notes.push(`${sym}: ${e.message}`); }
    if (candles && candles.length) {
      const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
      candles = candles.filter(c => c.time < todayStart); // solo velas cerradas
    }
    if (!candles || candles.length < MIN_BARS) { report.notes.push(`${sym}: pocas velas diarias (${candles ? candles.length : 0}), se omite.`); continue; }
    series[sym] = candles;
    const first = candles[0], last = candles[candles.length - 1];
    report.data[sym] = {
      bars: candles.length, from: new Date(first.time).toISOString().slice(0, 10), to: new Date(last.time).toISOString().slice(0, 10),
      buyAndHoldPct: first.close ? +(((last.close / first.close) - 1) * 100).toFixed(1) : null
    };
    if (i < symbols.length - 1 && deps.sleep) await deps.sleep(12000); // 5 pedidos/min: deja cupo por minuto al motor en vivo
  }
  const spreadPrice = sym => {
    const a = deps.assets && deps.assets[sym];
    const pips = deps.spreadPips && deps.spreadPips[sym];
    return a && pips ? pips * (a.pipSize || 0) : 0;
  };
  for (const v of VARIANTS) {
    const out = { description: v.description, params: { entradaVelas: v.entryN, salidaVelas: v.exitN, stopATR: STOP_ATR, soloLargos: v.longOnly }, bySymbol: {} };
    const tradesBySym = {};
    for (const sym of Object.keys(series)) {
      const c = series[sym];
      const sim = simulate(c, { entryN: v.entryN, exitN: v.exitN, longOnly: v.longOnly }, spreadPrice(sym));
      tradesBySym[sym] = sim.trades;
      const cutoff = c[Math.floor(c.length * 0.6)].time;
      const totalDays = (c[c.length - 1].time - c[0].time) / DAY_MS;
      out.bySymbol[sym] = { ...pack(sim.trades, totalDays, cutoff), byYear: byYear(sim.trades), openAtEnd: sim.openAtEnd, cutoff: new Date(cutoff).toISOString().slice(0, 10) };
      if (deps.yieldFn) await deps.yieldFn();
    }
    const poolOf = syms => syms.filter(s => tradesBySym[s]).flatMap(s => tradesBySym[s]);
    // Corte comun 60/40 por fecha para el grupo (se usa el corte del activo mas corto para que ambos tramos tengan sentido).
    const cuts = Object.keys(series).map(s => series[s][Math.floor(series[s].length * 0.6)].time);
    const commonCut = cuts.length ? Math.max(...cuts) : 0;
    const poolFocus = poolOf(FOCUS_SYMBOLS), poolAll = poolOf(Object.keys(series));
    out.grupoFoco = { simbolos: FOCUS_SYMBOLS.filter(s => series[s]), corte: commonCut ? new Date(commonCut).toISOString().slice(0, 10) : null, ...pack(poolFocus, null, commonCut) };
    out.grupoCripto = { simbolos: CRYPTO_SYMBOLS.filter(s => series[s]), corte: commonCut ? new Date(commonCut).toISOString().slice(0, 10) : null, ...pack(poolOf(CRYPTO_SYMBOLS), null, commonCut) };
    out.todosLosActivos = { simbolos: Object.keys(series), corte: commonCut ? new Date(commonCut).toISOString().slice(0, 10) : null, ...pack(poolAll, null, commonCut) };
    report.variants[v.key] = out;
  }
  report.finishedAt = Date.now();
  return report;
}

// ------------------------------------------------------------
// TABLERO DIARIO (sistema principal: canal 55/20, solo compras, stop 2.5 ATR)
// ------------------------------------------------------------
const BOARD_PARAMS = { entryN: 55, exitN: 20, longOnly: true };
function dateStr(t) { return new Date(t).toISOString().slice(0, 10); }

function boardFor(c, spreadPrice, decimals) {
  const n = c.length;
  const last = c[n - 1];
  const atr = atrSeries(c, ATR_N)[n - 1];
  const sim = simulate(c, BOARD_PARAMS, spreadPrice);
  const round = v => (v == null || !isFinite(v)) ? null : +v.toFixed(decimals != null ? decimals : 2);
  const levelEntrada = highestHigh(c, n - BOARD_PARAMS.entryN, n - 1); // el cierre de mañana debe superar este maximo de 55 dias
  const levelSalida = lowestLow(c, n - BOARD_PARAMS.exitN, n - 1);     // el cierre de mañana bajo este minimo de 20 dias => salir
  const stopSugerido = atr != null ? last.close - STOP_ATR * atr : null;
  const lastTrade = sim.trades.length ? sim.trades[sim.trades.length - 1] : null;
  let evento = null;
  if (sim.pendEntry) evento = 'ENTRADA';
  else if (sim.pendExit) evento = 'SALIDA';
  else if (lastTrade && lastTrade.exitTime === last.time && lastTrade.reason === 'stop') evento = 'STOP';
  return {
    fecha: dateStr(last.time), barTime: last.time, cierre: round(last.close), atr20: round(atr),
    entradaSiCierraSobre: round(levelEntrada), salidaSiCierraBajo: round(levelSalida),
    stopSugerido: round(stopSugerido), stopDistanciaPct: (atr != null && last.close) ? +((STOP_ATR * atr / last.close) * 100).toFixed(1) : null,
    estadoSistema: sim.openPos ? 'comprado' : 'fuera',
    posicionSistema: sim.openPos ? { desde: dateStr(sim.openPos.entryTime), entrada: round(sim.openPos.entry), stopInicial: round(sim.openPos.stop) } : null,
    evento
  };
}

async function runBoard(deps) {
  const board = { version: 1, generatedAt: Date.now(), engineVersion: deps.engineVersion, sistema: 'Canal 55/20, solo compras, stop 2.5 x ATR(20)', symbols: {}, notes: [] };
  const symbols = deps.symbols || [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    if (deps.shouldAbort && deps.shouldAbort()) throw new Error('abortado (proveedor en cooldown)');
    let candles = null;
    try { candles = await deps.fetchD1(sym); } catch (e) { board.notes.push(`${sym}: ${e.message}`); }
    if (candles && candles.length) {
      const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
      candles = candles.filter(c => c.time < todayStart); // solo velas cerradas
    }
    if (!candles || candles.length < 120) {
      board.notes.push(`${sym}: pocas velas diarias (${candles ? candles.length : 0}), se omite.`);
    } else {
      const a = deps.assets && deps.assets[sym];
      const pips = deps.spreadPips && deps.spreadPips[sym];
      const spreadPrice = a && pips ? pips * (a.pipSize || 0) : 0;
      board.symbols[sym] = boardFor(candles, spreadPrice, a ? a.decimals : 2);
    }
    if (i < symbols.length - 1 && deps.sleep) await deps.sleep(12000);
  }
  return board;
}

module.exports = { run, runBoard, boardFor, simulate, stats, VARIANTS };
