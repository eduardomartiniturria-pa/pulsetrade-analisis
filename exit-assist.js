// ============================================================
// EXIT-ASSIST v1 (27/10/2026) — asistente de salida para PulseTrade
// ============================================================
// SOLO MEDICION Y AVISO. No cambia entradas, SL/TP, umbrales, stats, circuit breaker ni el R
// que registra la app (sigue pagando TP2). Respeta la regla "no tocar parametros hasta 100
// operaciones reales por combinacion".
//
// Motivo: la operacion manual del 27/10 (XAUUSD) se corto por lectura de velas en el agotamiento
// del impulso. Esto lo traduce a dos cosas medibles:
//  1) QUE HABRIA PASADO con break-even + trailing (quinta cuenta, al lado de rIfTP1, rHalfTP1 y
//     rIf1R de engine.js). Se guarda en cada cierre: rTrail (R neto de spread) y trailExit.
//  2) AVISO DE AGOTAMIENTO sobre operaciones abiertas en ganancia: h.exitHint (y el mismo dato
//     espejado en state.activeCustomSignals[...].exitHint). No cierra nada: el usuario opera a mano.
//
// Reglas del trailing simulado (conservadoras):
//  - Stop inicial = SL original. Objetivo = TP2 si la estrategia lo define, si no TP1.
//  - Cuando una vela CERRADA llega a +breakevenAtR a favor, el stop pasa a la entrada.
//  - Desde ahi, tras cada vela cerrada el stop sigue su minimo (long) / maximo (short) menos un
//    colchon (trailBufferR x riesgo). Nunca retrocede.
//  - Dentro de una misma vela, si toca el stop y el objetivo se asume el stop primero.
//  - El stop nuevo rige desde la vela SIGUIENTE (no se usa informacion de la misma vela).
//
// Aviso de agotamiento (vela cerrada, operacion en ganancia >= hintMinR):
//  - mecha en contra >= wickPct del rango de la vela, o
//  - vela de reversion que cierra mas alla de la mitad del cuerpo de la vela anterior (que iba a favor).
// ============================================================

const CFG = {
  enabled: true,
  strategies: ['kill_zone_ny'],   // solo estrategias de sesion; supply_demand y session_breakout_vwap quedan afuera
  breakevenAtR: 1,
  trailBufferR: 0.1,
  wickPct: 0.5,
  hintMinR: 0.5,
  tfMs: 15 * 60 * 1000
};

function applies(h) {
  return CFG.enabled && h && CFG.strategies.includes(h.source || (h.strategyKeys && h.strategyKeys[0]));
}

// Simula break-even + trailing sobre velas ya posteriores a la entrada.
// ctx: { isLong, entry, sl, riskDist, targetLevel, rTarget }
// Devuelve { rGross, exit } con exit en 'sl' | 'be' | 'trail' | 'tp', o null si no salio en las velas dadas.
function simulateTrail(candles, ctx) {
  const { isLong, entry, sl, riskDist, targetLevel, rTarget } = ctx;
  if (!(riskDist > 0) || !candles || !candles.length) return null;
  let stop = sl, armed = false;
  const buffer = CFG.trailBufferR * riskDist;
  for (const c of candles) {
    const hitStop = isLong ? c.low <= stop : c.high >= stop;
    const hitTarget = isLong ? c.high >= targetLevel : c.low <= targetLevel;
    if (hitStop) {
      const r = (isLong ? stop - entry : entry - stop) / riskDist;
      const exit = !armed ? 'sl' : (Math.abs(stop - entry) < 1e-9 ? 'be' : 'trail');
      return { rGross: +r.toFixed(2), exit };
    }
    if (hitTarget) return { rGross: rTarget, exit: 'tp' };
    const fav = (isLong ? c.high - entry : entry - c.low) / riskDist;
    if (!armed && fav >= CFG.breakevenAtR) { armed = true; stop = isLong ? Math.max(stop, entry) : Math.min(stop, entry); }
    if (armed) {
      const cand = isLong ? c.low - buffer : c.high + buffer;
      stop = isLong ? Math.max(stop, entry, cand) : Math.min(stop, entry, cand);
    }
  }
  return null;
}

// Se llama al CERRAR una operacion en checkHistoryOutcomes.
// ctx: { isLong, riskDist, hasTp2, tp1Level, tp2Level, rTP1, rTP2, rHit, spreadCostR, closeCandleTime }
function annotateClosed(h, relevantCandles, ctx) {
  if (!applies(h) || !ctx || !(ctx.riskDist > 0)) return;
  const candles = (relevantCandles || []).filter(c => ctx.closeCandleTime == null || c.time <= ctx.closeCandleTime);
  const res = simulateTrail(candles, {
    isLong: ctx.isLong, entry: h.entry, sl: h.sl, riskDist: ctx.riskDist,
    targetLevel: ctx.hasTp2 ? ctx.tp2Level : ctx.tp1Level,
    rTarget: ctx.hasTp2 ? ctx.rTP2 : ctx.rTP1
  });
  const gross = res ? res.rGross : ctx.rHit; // sin salida simulada (vencida o cierre por precio): vale lo registrado
  h.rTrail = +(gross - (ctx.spreadCostR || 0)).toFixed(2);
  h.trailExit = res ? res.exit : 'none';
}

// Se llama sobre operaciones ABIERTAS en cada ciclo. Marca h.exitHint si la ultima vela cerrada
// muestra agotamiento y la operacion va en ganancia. state es el state del engine.
function checkExhaustion(h, relevantCandles, state, nowMs = Date.now()) {
  if (!applies(h) || !h.entry || !h.sl) return false;
  const riskDist = Math.abs(h.entry - h.sl);
  if (!(riskDist > 0) || !relevantCandles || relevantCandles.length < 2) return false;
  const closed = relevantCandles.filter(c => c.time + CFG.tfMs <= nowMs);
  if (closed.length < 2) return false;
  const c = closed[closed.length - 1], p = closed[closed.length - 2];
  if (h.exitHint && h.exitHint.at === c.time) return false;
  const isLong = h.type === 'long';
  const rNow = (isLong ? c.close - h.entry : h.entry - c.close) / riskDist;
  if (rNow < CFG.hintMinR) return false;
  const range = c.high - c.low;
  const adverseWick = isLong ? c.high - Math.max(c.open, c.close) : Math.min(c.open, c.close) - c.low;
  const wickCond = range > 0 && (adverseWick / range) >= CFG.wickPct;
  const prevMid = (p.open + p.close) / 2;
  const prevFav = isLong ? p.close > p.open : p.close < p.open;
  const revCond = prevFav && (isLong ? (c.close < prevMid && c.close < c.open) : (c.close > prevMid && c.close > c.open));
  if (!wickCond && !revCond) return false;
  h.exitHint = {
    at: c.time, detectedAt: nowMs, price: c.close, rNow: +rNow.toFixed(2),
    reason: wickCond ? `mecha en contra de ${(adverseWick / range * 100).toFixed(0)}% del rango de la vela` : 'vela de reversion bajo la mitad del cuerpo previo'
  };
  const liveKey = `${h.symbol}_${(h.strategyKeys && h.strategyKeys[0]) || h.source}`;
  const live = state && state.activeCustomSignals && state.activeCustomSignals[liveKey];
  if (live && live.timestamp === h.timestamp) live.exitHint = h.exitHint;
  console.log(`[exit-assist] ${liveKey}: posible agotamiento a ${c.close} (${h.exitHint.rNow}R a favor) — ${h.exitHint.reason}`);
  return true;
}

// Resumen para /api/state -> diagnostics.exitAssist. Solo operaciones reales cerradas que tienen rTrail.
// recordedR se suma sobre el MISMO subconjunto para que la comparacion sea justa.
function summarize(history) {
  const mk = () => ({ n: 0, recordedR: 0, trailR: 0, exits: { sl: 0, be: 0, trail: 0, tp: 0, none: 0 } });
  const out = { since: 'exit-assist v1', config: { ...CFG }, total: mk(), byStrategy: {} };
  (history || []).forEach(h => {
    if (!h || h.shadow || h.rTrail == null || h.rMultiple == null) return;
    if (h.result !== 'win' && h.result !== 'loss') return;
    const key = h.source || (h.strategyKeys && h.strategyKeys[0]) || 'desconocida';
    const s = out.byStrategy[key] || (out.byStrategy[key] = mk());
    [out.total, s].forEach(b => {
      b.n++; b.recordedR += h.rMultiple; b.trailR += h.rTrail;
      if (b.exits[h.trailExit] != null) b.exits[h.trailExit]++;
    });
  });
  const r2 = b => { b.recordedR = +b.recordedR.toFixed(2); b.trailR = +b.trailR.toFixed(2); };
  r2(out.total); Object.values(out.byStrategy).forEach(r2);
  return out;
}

module.exports = { CFG, simulateTrail, annotateClosed, checkExhaustion, summarize };

