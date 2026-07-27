/* Puente entre el motor de patrones y la forma de senal que consume la app.

   Nota sobre la ENTRADA. En la cosecha historica (aprendizaje) la entrada es el open de la
   vela siguiente a la ruptura: es lo que realmente habrias pagado. Pero una senal EN VIVO
   se emite cuando la ruptura ya ocurrio hace N velas, asi que fingir esa entrada seria
   mentir sobre el precio disponible. Aqui la entrada en vivo es el precio actual, el stop
   sigue siendo el nivel estructural del patron y los TP se recalculan por ATR desde la
   entrada real. La latencia se reporta como advertencia. */

import { buildLevels, fmt } from "./signalCore.js";
import { buildContext, collectPivots, detectAt, warmupBars, DEFAULT_CFG } from "./patternCore.js";
import { getPatternBrain, brainTuning, scorePattern, brainTotals } from "./patternTracker.js";
import { topFactors, brainState } from "./patternBrain.js";

const TP_SPLIT = [40, 35, 25]; // reparto de la posicion entre TP1/TP2/TP3

export function buildPatternSignal(c15, tf15, tf1h, tf4h, live, riskMode, opts = {}) {
  const strict = riskMode !== "flexible";
  const A = tf15.atr || live * 0.01;
  const extATR = tf15.atr ? (live - tf15.ema21) / tf15.atr : 0;
  const bias =
    tf4h.ema50 && tf4h.ema200
      ? tf4h.close > tf4h.ema50 && tf4h.ema50 > tf4h.ema200 ? "ALCISTA"
        : tf4h.close < tf4h.ema50 && tf4h.ema50 < tf4h.ema200 ? "BAJISTA" : "RANGO"
      : "RANGO";

  const brain = getPatternBrain();
  const tot = brainTotals(brain);
  const st = brainState(brain, tot.wins, tot.losses);

  const empty = (core, invalidation, extra = {}) => ({
    modo: "patrones", tipo: "chartista", bias, signal: "SIN OPERAR", dir: null, confidence: "-",
    core, contexto: [], bull: 0, bear: 0, warnings: [], blockedDir: null, riskMode,
    entry: null, zone: null, stop: null, tps: [], roomR: null, ceiling: null, maxLev: null,
    invalidation, atrVal: A, extATR,
    brain: { n: st.n, pasos: brain.nTrained, estado: st.label, edge: st.edge, logloss: brain.logloss, baseline: st.base },
    ...extra,
  });

  // La deteccion necesita historia: pivotes + EMA de tendencia + ventana de escaneo.
  const cfg = { ...DEFAULT_CFG, ...(opts.patternCfg ?? {}), ...brainTuning(brain) };
  if (!c15 || c15.length < warmupBars(cfg) + 40) {
    return empty([], "Historia insuficiente para el detector de patrones.");
  }

  let ctx, pivots, found;
  try {
    ctx = buildContext(c15, cfg, null);
    pivots = collectPivots(ctx);
    found = detectAt(ctx, pivots, ctx.n - 1);
  } catch {
    return empty([], "El detector de patrones no pudo evaluar estas velas.");
  }

  const core = [];
  if (!found.length) {
    core.push({ n: "Figuras", v: "ninguna figura valida en la ventana analizada", d: "flat" });
    return empty(core, "Sin patron chartista confirmado. El detector no inventa figuras: espera una ruptura real.");
  }

  // La operable es la de mayor prioridad que ademas llega a tiempo.
  const fresh = found.filter((r) => r.latency <= cfg.maxLatency);
  core.push({
    n: "Figuras detectadas",
    v: found.map((r) => `${r.name} ${r.isBullish ? "↑" : "↓"} (⏳${r.latency}b)`).join(" · "),
    d: "flat",
  });

  if (!fresh.length) {
    const r0 = found[0];
    return empty(
      core,
      `La figura mas reciente (${r0.name}) rompio hace ${r0.latency} velas, por encima del maximo de ${cfg.maxLatency}. El movimiento ya ocurrio: perseguirlo es entrar tarde.`,
      { pattern: r0 }
    );
  }

  const r = fresh[0];
  const dir = r.isBullish ? "long" : "short";
  const warnings = [];

  // p(win) del cerebro dedicado, con las features de ESTA figura.
  const { p: pwin, x } = scorePattern(brain, ctx, r);
  const factores = topFactors(brain, x);
  const ready = st.ready;

  core.push({
    n: "Figura operable",
    v: `${r.name} ${r.isBullish ? "alcista" : "bajista"} · ruptura hace ${r.latency} vela(s) · ancho ${r.breakoutIdx - r.startIdx} velas`,
    d: r.isBullish ? "up" : "down",
  });
  core.push({
    n: "Ruptura",
    v: `Nivel roto en la vela ${r.breakoutIdx} de la ventana; entrada historica ${fmt(r.entry)}, precio ahora ${fmt(live)}`,
    d: "flat",
  });
  core.push({
    n: "🧠 Cerebro de patrones",
    v: ready
      ? `p(win) ${(pwin * 100).toFixed(0)}% · ${st.label} · ${st.n} trades aprendidos`
      : `sin datos suficientes (${st.n}/40 trades) — corre el backtest de patrones`,
    d: ready ? (pwin >= 0.55 ? "up" : pwin <= 0.45 ? "down" : "flat") : "flat",
  });

  // El stop es el nivel ESTRUCTURAL del patron; la entrada, el precio real de ahora.
  let stopPrice = r.stop;
  const badStop = dir === "long" ? stopPrice >= live : stopPrice <= live;
  if (badStop) {
    // El precio ya cruzo el stop estructural: se reancla por ATR para no invertir el riesgo.
    stopPrice = dir === "long" ? live - 1.5 * A : live + 1.5 * A;
    warnings.push(`El stop estructural del patron quedo del lado equivocado del precio actual; se reancla a 1.5 ATR (${fmt(stopPrice)}).`);
  }

  if (r.latency >= Math.ceil(cfg.maxLatency / 2)) {
    warnings.push(`La ruptura fue hace ${r.latency} velas: parte del recorrido ya ocurrio y tu entrada es peor que la teorica.`);
  }

  // Portero del cerebro: solo actua cuando ya vio suficientes trades resueltos.
  let blockedDir = null;
  if (ready && opts.patternGate !== false && pwin < (opts.patternMinP ?? 0.45)) {
    const msg = `El cerebro estima p(win) ${(pwin * 100).toFixed(0)}%, bajo el minimo de ${((opts.patternMinP ?? 0.45) * 100).toFixed(0)}%. Con ${st.n} trades aprendidos, esta clase de figura no paga.`;
    if (strict) return empty(core, msg, { pattern: r, pwin, factores, blockedDir: dir });
    warnings.push(msg);
  }

  if (dir === "long" && extATR > 3) {
    const msg = `Sobreextendido: ${extATR.toFixed(1)} ATR sobre la EMA21. Perseguir la ruptura aqui es entrar tarde.`;
    if (strict) return empty(core, msg, { pattern: r, pwin, factores, blockedDir: "long" });
    warnings.push(msg);
  }
  if (dir === "short" && extATR < -3) {
    const msg = `Sobreextendido a la baja: ${Math.abs(extATR).toFixed(1)} ATR bajo la EMA21. Lo sano es esperar el rebote.`;
    if (strict) return empty(core, msg, { pattern: r, pwin, factores, blockedDir: "short" });
    warnings.push(msg);
  }

  // buildLevels aporta zona, techo/piso estructural, apalancamiento maximo e invalidacion.
  const levels = buildLevels(dir, live, A, stopPrice, tf15, tf1h, strict);
  if (levels.blocked) {
    return empty(core, levels.reason, { pattern: r, pwin, factores, blockedDir: dir });
  }
  if (levels.warning) warnings.push(levels.warning);

  // Los TP salen del ATR (multiplicadores del cerebro), no de multiplos fijos de R.
  const [m1, m2, m3] = cfg.tpMult ?? [cfg.tp1Atr, cfg.tp2Atr, cfg.tp3Atr];
  const risk = Math.abs(live - stopPrice);
  const s = dir === "long" ? 1 : -1;
  const tps = [m1, m2, m3].map((m, i) => {
    const price = live + s * A * m;
    return { pct: TP_SPLIT[i], price, r: risk > 0 ? Math.abs(price - live) / risk : 0 };
  });

  const rr2 = tps[1].r;
  core.push({
    n: "Objetivos (×ATR)",
    v: `TP1 ${m1.toFixed(1)} · TP2 ${m2.toFixed(1)} · TP3 ${m3.toFixed(1)} — R:R vs TP2 = ${rr2.toFixed(2)}${brain.adaptTP1 != null ? " (adaptados por MFE real)" : " (fijos: aun sin evidencia)"}`,
    d: rr2 >= 1.5 ? "up" : "flat",
  });
  if (brain.adaptSL != null) {
    core.push({ n: "SL adaptativo", v: `${brain.adaptSL.toFixed(2)} ×ATR, del MAE de los ganadores`, d: "flat" });
  }

  if (rr2 < 1) {
    const msg = `R:R vs TP2 de solo ${rr2.toFixed(2)}: el stop estructural quedo demasiado lejos del precio actual para que la figura pague.`;
    if (strict) return empty(core, msg, { pattern: r, pwin, factores, blockedDir: dir });
    warnings.push(msg);
  }

  let confidence = "MEDIA";
  if (ready) confidence = pwin >= 0.6 ? "ALTA" : pwin >= 0.5 ? "MEDIA" : "BAJA";
  else confidence = r.latency <= 2 ? "MEDIA" : "BAJA";
  const biasAligned = (dir === "long" && bias === "ALCISTA") || (dir === "short" && bias === "BAJISTA");
  if (!biasAligned && bias !== "RANGO") {
    warnings.push(`La figura va contra el sesgo mayor (${bias}) de 4h/1h.`);
  } else if (biasAligned && confidence === "MEDIA" && ready && pwin >= 0.55) {
    confidence = "ALTA";
  }
  if (warnings.length >= 2) confidence = "BAJA";
  else if (warnings.length === 1 && confidence === "ALTA") confidence = "MEDIA";

  return {
    modo: "patrones", tipo: "chartista", bias,
    signal: dir === "long" ? "LARGO" : "CORTO", dir, confidence,
    core, contexto: [], bull: 0, bear: 0, warnings, blockedDir, riskMode,
    entry: live, zone: levels.zone, stop: stopPrice, tps,
    roomR: levels.roomR ?? null, ceiling: levels.ceiling ?? null, maxLev: levels.maxLev ?? null,
    invalidation: `Cierre ${dir === "long" ? "bajo" : "sobre"} ${fmt(stopPrice)} anula la figura (${r.name}).`,
    atrVal: A, extATR,
    pattern: r, pwin, factores,
    brain: { n: st.n, pasos: brain.nTrained, estado: st.label, edge: st.edge, logloss: brain.logloss, baseline: st.base },
  };
}
