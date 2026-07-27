/* Resolucion de trades de patron y COSECHA de muestras (shadow trades).

   Dos ideas que multiplican lo que el cerebro puede aprender:

   1. Shadow trades: el grafico solo muestra UNA figura, pero el detector encuentra muchas
      mas en cada barra. Todas se registran en silencio y se resuelven contra el precio real.
      No se dibujan ni generan alertas: solo alimentan el modelo.

   2. Latencia doble: para OPERAR la latencia debe ser baja (una ruptura de hace 30 velas ya
      no es operable), pero para APRENDER un setup viejo sigue siendo un dato perfectamente
      valido. Separar ambos umbrales es lo que llena el modelo de muestras.

   3. Rotacion de pivotes: los detectores leen siempre los 2-3 pivotes mas recientes.
      Descartando temporalmente los mas nuevos y volviendo a ejecutar, se exploran
      combinaciones mas antiguas y se cosechan muchas mas figuras historicas. */

import {
  buildContext, collectPivots, detectAt, buildFeatures, warmupBars, DEFAULT_CFG,
} from "./patternCore.js";
import {
  loadBrain, saveBrain, predict, trainBatch, recordExcursion, recomputeAdaptive,
  effectiveTPs,
} from "./patternBrain.js";

const EXPIRY_BARS = 100;   // time stop: un trade que no resuelve en 100 velas expira

let _brain = null;
export const getPatternBrain = () => (_brain ??= loadBrain());
export const setPatternBrain = (b) => { _brain = b; saveBrain(b); };
export const reloadPatternBrain = () => { _brain = null; return getPatternBrain(); };

/* ---------- Resolucion de un trade de patron ----------
   Camina las velas posteriores a la entrada y devuelve el desenlace junto con MFE/MAE
   (excursiones maxima favorable y adversa, en unidades de ATR: comparables entre simbolos).
   Criterio conservador: si una vela toca SL y TP1 a la vez, cuenta como perdida.
   Tras TP1 el stop pasa a breakeven. */
export const TP_WEIGHTS = [0.40, 0.35, 0.25]; // reparto de la posicion, igual que el resto de la app

export function resolvePatternTrade(ctx, r, opts = {}) {
  const { expiry = EXPIRY_BARS, beAfterTP1 = true } = opts;
  const { highs, lows, n } = ctx;
  const start = r.breakoutIdx + 1;         // la entrada ocurre en el open de esta vela
  const atr0 = Math.max(ctx.atr[r.breakoutIdx] ?? 0, 1e-9);
  if (start >= n || r.entry == null || r.stop == null) return null;

  const isBull = r.isBullish;
  const risk = Math.abs(r.entry - r.stop);
  if (!risk) return null;

  const tps = [r.tp1, r.tp2, r.tp3];
  const rMult = tps.map((t) => Math.abs(t - r.entry) / risk); // cada TP en multiplos de R
  let stop = r.stop, filled = 0, rAcum = 0, mfe = 0, mae = 0;
  const last = Math.min(n - 1, start + expiry);

  const close = (outcome, detail, i) => ({
    win: rAcum > 0 ? 1 : 0, outcome, detail, r: rAcum,
    mfe, mae, bars: i - start, closedIdx: i,
  });

  for (let i = start; i <= last; i++) {
    const fav = isBull ? (highs[i] - r.entry) / atr0 : (r.entry - lows[i]) / atr0;
    const adv = isBull ? (r.entry - lows[i]) / atr0 : (highs[i] - r.entry) / atr0;
    mfe = Math.max(mfe, fav);
    mae = Math.max(mae, adv);

    // Conservador: si una vela toca stop y TP a la vez, se asume el stop primero.
    if (isBull ? lows[i] <= stop : highs[i] >= stop) {
      const stopR = (isBull ? stop - r.entry : r.entry - stop) / risk;
      const remaining = 1 - TP_WEIGHTS.slice(0, filled).reduce((a, b) => a + b, 0);
      rAcum += remaining * stopR;
      return close(rAcum > 0 ? "win" : "loss", filled > 0 ? `BE tras TP${filled}` : "stop", i);
    }
    while (filled < 3 && (isBull ? highs[i] >= tps[filled] : lows[i] <= tps[filled])) {
      rAcum += TP_WEIGHTS[filled] * rMult[filled];
      filled++;
      if (filled === 1 && beAfterTP1) stop = r.entry; // breakeven tras el primer objetivo
    }
    if (filled === 3) return close("win", "TP3", i);
  }

  if (last >= n - 1 && last - start < expiry) return null; // sigue abierta: fin del historico
  // Expirar tambien es informacion: se liquida lo que quede al cierre de la ultima vela.
  const px = ctx.closes[last];
  const drift = (isBull ? px - r.entry : r.entry - px) / risk;
  rAcum += (1 - TP_WEIGHTS.slice(0, filled).reduce((a, b) => a + b, 0)) * drift;
  return close(filled > 0 ? "win" : "expired", `expiro tras ${filled} TP`, last);
}

/* ---------- Cosecha historica ----------
   Recorre el historico, detecta TODAS las figuras validas y las resuelve. Devuelve las
   muestras de entrenamiento y las estadisticas por patron. Async: cede el hilo
   periodicamente para no congelar la UI (mismo criterio que backtestSymbol en tracker.js). */
export async function harvestShadowTrades(candles, cfg = {}, opts = {}) {
  const {
    step = 3,              // cada cuantas velas se re-escanea
    harvestDepth = 3,      // niveles de rotacion de pivotes
    bm = null,             // regimen del benchmark
    onYield = null,
  } = opts;

  const c = { ...DEFAULT_CFG, ...cfg };
  const ctx = buildContext(candles, c, bm);
  const pivots = collectPivots(ctx);
  const warm = warmupBars(c);

  const samples = [];
  const stats = {};        // { patron: {w,l} } — alimenta el prior Beta
  const rows = [];         // detalle para la UI
  const seen = new Set();  // clave unica por breakout+patron: no registrar dos veces lo mismo
  let sinceYield = 0;

  for (let bar = warm; bar < ctx.n - 2; bar += step) {
    if (++sinceYield >= 40) {
      sinceYield = 0;
      await new Promise((r) => setTimeout(r, 0));
      onYield?.(bar / ctx.n);
    }
    for (let drop = 0; drop <= harvestDepth; drop++) {
      const found = detectAt(ctx, pivots, bar, drop);
      for (const r of found) {
        // Latencia de COSECHA (amplia), no la de operacion (estricta).
        if (r.latency > c.harvestLatency) continue;
        const key = `${r.breakoutIdx}|${r.name}|${r.isBullish ? 1 : 0}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const res = resolvePatternTrade(ctx, r);
        if (!res) continue;

        // El vector se congela con el estado del prior ANTES de este trade: si se usara el
        // prior ya actualizado, la feature contendria el resultado que intenta predecir.
        const x = buildFeatures(ctx, r, stats);
        samples.push({ x, y: res.win, mfe: res.mfe, mae: res.mae, name: r.name });

        stats[r.name] ??= { w: 0, l: 0 };
        if (res.win) stats[r.name].w++; else stats[r.name].l++;

        rows.push({
          ts: candles[r.breakoutIdx + 1]?.time ?? candles[r.breakoutIdx]?.time ?? null,
          name: r.name, dir: r.isBullish ? "long" : "short",
          outcome: res.outcome, detail: res.detail, r: res.r,
          latency: r.latency, mfe: res.mfe, mae: res.mae, bars: res.bars,
        });
      }
    }
  }
  return { samples, stats, rows, scanned: ctx.n };
}

/* ---------- Entrenamiento del cerebro con la cosecha ---------- */
// Siembra el cerebro dedicado. Devuelve un resumen para la UI.
export function trainFromHarvest(brain, harvest, opts = {}) {
  const { epochs = 3, adaptCfg = {} } = opts;
  const { samples, stats } = harvest;
  if (!samples.length) return { trained: 0, wins: 0, losses: 0 };

  for (const s of samples) recordExcursion(brain, { mfe: s.mfe, mae: s.mae, win: s.y > 0 });
  trainBatch(brain, samples, epochs);
  recomputeAdaptive(brain, adaptCfg);

  // Acumula las estadisticas por patron para el prior Beta de futuras evaluaciones.
  brain.patternStats ??= {};
  for (const [name, s] of Object.entries(stats)) {
    brain.patternStats[name] ??= { w: 0, l: 0 };
    brain.patternStats[name].w += s.w;
    brain.patternStats[name].l += s.l;
  }

  const wins = samples.reduce((a, s) => a + (s.y > 0 ? 1 : 0), 0);
  return { trained: samples.length, wins, losses: samples.length - wins };
}

// Win/loss agregados del cerebro (para el baseline de log-loss y el panel de la UI).
export function brainTotals(brain) {
  let w = 0, l = 0;
  for (const s of Object.values(brain.patternStats ?? {})) { w += s.w; l += s.l; }
  return { wins: w, losses: l };
}

/* ---------- Evaluacion en vivo ---------- */
// Multiplicadores ATR efectivos del cerebro (fijos hasta que hay evidencia suficiente).
export function brainTuning(brain, cfg = DEFAULT_CFG) {
  const tpMult = effectiveTPs(brain, cfg.tp1Atr, cfg.tp2Atr, cfg.tp3Atr);
  return { tpMult, slAtr: brain.adaptSL ?? null };
}

// p(win) que el cerebro asigna a una figura ya detectada.
export function scorePattern(brain, ctx, r) {
  const x = buildFeatures(ctx, r, brain.patternStats ?? {});
  return { p: predict(brain, x), x };
}
