/* Motor de aprendizaje continuo: registro de senales, resolucion contra el precio real,
   buckets bayesianos por segmento, probabilidad hibrida (modelo logistico + buckets)
   y backtest historico para sembrar el record. */

import {
  fetchCandles, fetchHistory, evaluate, evaluateAll, extractFeatures, segmentKeys,
  btcBiasSeries, btcBiasAt, STRATEGY_KEYS,
} from "./signalCore.js";
import { loadModel, saveModel, train, trainBatch, predict, topFactors, resetModel } from "./model.js";
import {
  harvestShadowTrades, trainFromHarvest, brainTotals,
  getPatternBrain, setPatternBrain, reloadPatternBrain,
} from "./patternTracker.js";
import { resetBrain, brainState } from "./patternBrain.js";
import { subCat } from "./categories.js";

const K_SIGNALS = "cb_signals_v1";
const K_BUCKETS = "cb_buckets_v1";
const K_BTSAMPLE = "cb_btsample_v1";
const K_BTMETA = "cb_btmeta_v1";
const K_PATBRAIN = "cb_pattern_model_v1";

const MAX_LIVE = 500;        // tope de senales en vivo guardadas
const MAX_BTSAMPLE = 1500;   // muestra de backtest para tabla, curva y R medio filtrado
const EXPIRY_CANDLES = 192; // 48h en velas de 15m
const DEDUPE_MS = 3 * 3600 * 1000; // no repetir misma senal (simbolo+dir+modo) en 3h

const hasStorage = typeof localStorage !== "undefined";
const load = (k, fb) => {
  if (!hasStorage) return fb;
  try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; }
};
const save = (k, v) => {
  if (hasStorage) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* lleno */ } }
};

let _model = null;
export const getModel = () => (_model ??= loadModel());

/* ---------- Buckets bayesianos ---------- */
export const getBuckets = () => load(K_BUCKETS, {});
const saveBuckets = (b) => save(K_BUCKETS, b);

export function addToBuckets(buckets, segKeys, win) {
  for (const k of segKeys) {
    if (!buckets[k]) buckets[k] = { w: 0, l: 0 };
    if (win) buckets[k].w++; else buckets[k].l++;
  }
  return buckets;
}

export const laplace = (w, l) => (w + 1) / (w + l + 2);

/* ---------- Probabilidad hibrida ---------- */
// Devuelve null si la senal no tiene direccion.
export function probability(sig, symbol, ts = Date.now()) {
  if (!sig?.dir) return null;
  const sc = subCat(symbol);
  const x = extractFeatures(sig, sc, ts);
  const keys = segmentKeys(sig, sc);
  const buckets = getBuckets();
  const m = getModel();

  let num = 0, den = 0;
  const segs = [];
  for (const k of keys) {
    const b = buckets[k];
    if (!b) continue;
    const n = b.w + b.l;
    if (!n) continue;
    const rate = laplace(b.w, b.l);
    segs.push({ key: k, n, rate });
    num += rate * n; den += n;
  }
  const pBuckets = den > 0 ? num / den : 0.5;
  const g = buckets.global;
  const nGlobal = g ? g.w + g.l : 0;

  const pModel = predict(m, x);
  // El modelo pesa mas a medida que ha visto muestras; los buckets sostienen el arranque.
  const alpha = Math.min(0.7, m.seen / 400);
  const p = alpha * pModel + (1 - alpha) * pBuckets;

  return {
    p, pModel, pBuckets,
    n: nGlobal,
    insuficiente: nGlobal < 20,
    divergente: nGlobal >= 20 && Math.abs(pModel - pBuckets) > 0.2,
    segs,
    factores: topFactors(m, x),
  };
}

/* ---------- Registro de senales en vivo ---------- */
export const getSignals = () => load(K_SIGNALS, []);
const saveSignals = (s) => save(K_SIGNALS, s);

// Registra una senal accionable. Devuelve el registro o null si es duplicada.
export function recordSignal(sig, symbol, live, ts = Date.now()) {
  if (!sig?.dir || !sig.entry || !sig.stop || !sig.tps?.length) return null;
  const signals = getSignals();
  const dup = signals.find(
    (s) => s.symbol === symbol && s.dir === sig.dir && s.modo === sig.modo &&
      ts - s.ts < DEDUPE_MS
  );
  if (dup) return null;
  const sc = subCat(symbol);
  const rec = {
    id: `${symbol}-${ts}`,
    ts, symbol, subcat: sc,
    dir: sig.dir, modo: sig.modo, confidence: sig.confidence,
    tf: sig.tf ?? "15m", maxLev: sig.maxLev ?? null,
    entry: sig.entry, stop: sig.stop,
    tps: sig.tps.map((t) => ({ pct: t.pct, price: t.price, r: t.r })),
    x: extractFeatures(sig, sc, ts),
    segKeys: segmentKeys(sig, sc),
    outcome: "open", r: null, detail: null,
    taken: false, source: "live",
  };
  signals.push(rec);
  if (signals.length > MAX_LIVE) signals.splice(0, signals.length - MAX_LIVE);
  saveSignals(signals);
  return rec;
}

export function markTaken(id, taken = true) {
  const signals = getSignals();
  const s = signals.find((x) => x.id === id);
  if (s) { s.taken = taken; saveSignals(signals); }
}

// Guarda TU operacion real sobre una senal: entrada, margen, apalancamiento y,
// opcionalmente, TU stop y TUS take profit (si en el exchange pusiste otros niveles).
// Con esto el Record calcula tu PnL real con TUS niveles, no con los sugeridos.
export function saveMyOp(id, { entry, margin, lev, stop, tps }) {
  const signals = getSignals();
  const s = signals.find((x) => x.id === id);
  if (!s) return false;
  s.taken = true;
  s.myEntry = entry;
  s.myMargin = margin;
  s.myLev = lev;
  const validStop = stop > 0 && (s.dir === "long" ? stop < entry : stop > entry);
  s.myStop = validStop ? stop : null;
  if (validStop && Array.isArray(tps)) {
    const risk = Math.abs(entry - stop);
    const pcts = [40, 35, 25];
    const clean = tps.filter((p) => p > 0 && (s.dir === "long" ? p > entry : p < entry));
    s.myTps = clean.length === 3
      ? clean.map((p, i) => ({
          pct: pcts[i],
          price: p,
          r: (s.dir === "long" ? p - entry : entry - p) / risk,
        }))
      : null;
  } else {
    s.myTps = null;
  }
  saveSignals(signals);
  return true;
}

// Niveles efectivos de la operacion del usuario: los suyos si los guardo, si no los de la senal.
export const myLevels = (s) => ({
  entry: s.myEntry > 0 ? s.myEntry : s.entry,
  stop: s.myStop > 0 ? s.myStop : s.stop,
  tps: s.myTps?.length ? s.myTps : s.tps,
});

/* ---------- Resolucion de resultados ---------- */
// Camina velas de 15m posteriores a la senal. Criterio conservador: si una vela
// toca stop y TP a la vez, se asume stop primero. Tras TP1 el stop pasa a break-even.
// Devuelve {outcome, r, detail, closedAt} o null si sigue abierta.
export function resolveOutcome(rec, candles, maxCandles = EXPIRY_CANDLES) {
  const { dir, entry, stop, tps } = rec;
  const isLong = dir === "long";
  const risk = Math.abs(entry - stop);
  if (!risk) return null;
  let curStop = stop;
  let filled = 0;
  let rAcum = 0;
  const w = tps.map((t) => t.pct / 100);
  const lim = Math.min(candles.length, maxCandles);

  for (let i = 0; i < lim; i++) {
    const c = candles[i];
    if (isLong ? c.low <= curStop : c.high >= curStop) {
      const stopR = isLong ? (curStop - entry) / risk : (entry - curStop) / risk;
      const remaining = 1 - w.slice(0, filled).reduce((a, b) => a + b, 0);
      rAcum += remaining * stopR;
      return {
        outcome: rAcum > 0 ? "win" : "loss", r: rAcum, closedAt: c.time,
        detail: filled > 0 ? `BE tras TP${filled}` : "stop",
      };
    }
    while (filled < tps.length && (isLong ? c.high >= tps[filled].price : c.low <= tps[filled].price)) {
      rAcum += w[filled] * tps[filled].r;
      filled++;
      if (filled === 1) curStop = entry; // break-even
    }
    if (filled === tps.length) {
      return { outcome: "win", r: rAcum, closedAt: c.time, detail: "TP3" };
    }
  }

  if (candles.length >= maxCandles) {
    const lastC = candles[maxCandles - 1];
    const remaining = 1 - w.slice(0, filled).reduce((a, b) => a + b, 0);
    const drift = isLong ? (lastC.close - entry) / risk : (entry - lastC.close) / risk;
    const r = rAcum + remaining * drift;
    return { outcome: "expired", r, closedAt: lastC.time, detail: "48h sin stop ni TP3" };
  }
  return null; // aun abierta
}

// Aplica un resultado al aprendizaje (buckets + modelo) y lo persiste.
function learnFrom(rec, res, buckets, model, weight = 1) {
  const win = res.r > 0 ? 1 : 0;
  addToBuckets(buckets, rec.segKeys, win);
  train(model, rec.x, win, weight);
}

// Resuelve las senales en vivo abiertas contra el precio real.
export async function resolveOpenSignals() {
  const signals = getSignals();
  const open = signals.filter((s) => s.outcome === "open");
  if (!open.length) return { resolved: 0, open: 0 };
  const buckets = getBuckets();
  const model = getModel();
  let resolved = 0;
  for (const s of open) {
    try {
      const candles = await fetchCandles(s.symbol, s.tf ?? "15m", Math.min(1000, EXPIRY_CANDLES + 10), {
        startTime: s.ts,
      });
      const res = resolveOutcome(s, candles);
      if (res) {
        Object.assign(s, { outcome: res.outcome, r: res.r, detail: res.detail, closedAt: res.closedAt });
        // Si el usuario guardo SU operacion, resolvemos tambien con SUS niveles reales.
        if (s.myEntry > 0 && s.myMargin > 0 && s.myLev > 0) {
          const lv = myLevels(s);
          const mine = resolveOutcome({ dir: s.dir, ...lv }, candles);
          if (mine) {
            s.rMine = mine.r;
            const riskPct = Math.abs(lv.entry - lv.stop) / lv.entry;
            s.pnlUsdt = s.myMargin * s.myLev * riskPct * mine.r;
          }
        }
        learnFrom(s, res, buckets, model, 1);
        resolved++;
      }
    } catch { /* red caida: se reintenta en la proxima */ }
  }
  if (resolved) {
    saveSignals(signals);
    saveBuckets(buckets);
    saveModel(model);
  }
  return { resolved, open: open.length - resolved };
}

/* ---------- Estadisticas ---------- */
export const getBtMeta = () => load(K_BTMETA, null);
export const getBtSample = () => load(K_BTSAMPLE, []);

export function stats() {
  const buckets = getBuckets();
  const rows = Object.entries(buckets)
    .map(([key, b]) => ({ key, n: b.w + b.l, winRate: b.w + b.l ? b.w / (b.w + b.l) : 0 }))
    .sort((a, b) => b.n - a.n);
  const live = getSignals().filter((s) => s.outcome !== "open");
  const liveWins = live.filter((s) => s.r > 0).length;
  const liveR = live.reduce((a, s) => a + (s.r ?? 0), 0);

  // TUS operaciones (las que guardaste con entrada/margen/apalancamiento reales)
  const ops = getSignals().filter((s) => s.myEntry > 0);
  const opsClosed = ops.filter((s) => s.outcome !== "open");
  const slip = (s) => ((s.dir === "long" ? s.myEntry - s.entry : s.entry - s.myEntry) / s.entry) * 100;
  const misOps = {
    n: ops.length,
    abiertas: ops.length - opsClosed.length,
    wins: opsClosed.filter((s) => (s.rMine ?? s.r) > 0).length,
    pnl: opsClosed.reduce((a, s) => a + (s.pnlUsdt ?? 0), 0),
    slipProm: ops.length ? ops.reduce((a, s) => a + slip(s), 0) / ops.length : 0,
    sobreApalancadas: ops.filter((s) => s.maxLev != null && s.myLev > s.maxLev).length,
    enMemes: ops.filter((s) => s.subcat === "memes").length,
  };

  return {
    rows,
    live: {
      n: live.length,
      wins: liveWins,
      winRate: live.length ? liveWins / live.length : 0,
      avgR: live.length ? liveR / live.length : 0,
    },
    misOps,
    openCount: getSignals().filter((s) => s.outcome === "open").length,
    btMeta: getBtMeta(),
    modelSeen: getModel().seen,
    patternBrain: patternBrainStats(),
  };
}

// Estado del cerebro dedicado de patrones (para su panel en la UI).
export function patternBrainStats() {
  const b = getPatternBrain();
  const t = brainTotals(b);
  const st = brainState(b, t.wins, t.losses);
  return {
    n: st.n, pasos: b.nTrained, ready: st.ready, wins: t.wins, losses: t.losses,
    winRate: t.wins + t.losses ? t.wins / (t.wins + t.losses) : null,
    estado: st.label, edge: st.edge, logloss: b.logloss, baseline: st.base,
    brier: b.brier, dw: b.dwEMA,
    tp: [b.adaptTP1, b.adaptTP2, b.adaptTP3], sl: b.adaptSL,
    nMfe: b.mfe.length, nMae: b.maeWin.length,
    porPatron: Object.entries(b.patternStats ?? {})
      .map(([name, s]) => ({ name, w: s.w, l: s.l, n: s.w + s.l, wr: s.w + s.l ? s.w / (s.w + s.l) : 0 }))
      .sort((a, b2) => b2.n - a.n),
  };
}

/* ---------- Backtest (siembra del historico) ---------- */
const H4 = 14400000;

// Genera senales sobre historico y las resuelve. Solo computa; no toca storage.
// `strategies` puede ser una clave o una lista: con lista, las velas se evaluan
// UNA vez por ventana y todas las estrategias comparten los analisis TF.
// Async: cede el hilo periodicamente para no congelar la UI.
export async function backtestSymbol(sym, c15, c1h, c4h, strategies, ind, riskMode, opts = {}) {
  const list = Array.isArray(strategies) ? strategies : [strategies];
  const { btcSeries = null, step = 4, msMedio = 3600000, msMayor = 14400000, tfLabel = "15m" } = opts;
  const out = [];
  let j1 = -1, j4 = -1, sinceYield = 0;
  const blockL = {}, blockS = {}; // cooldown de dedupe por estrategia

  for (let i = 300; i < c15.length - 2; i += step) {
    if (++sinceYield >= 40) {
      sinceYield = 0;
      await new Promise((r) => setTimeout(r, 0)); // respira: UI viva durante el computo
    }
    const decisionTime = c15[i + 1].time;
    while (j1 + 1 < c1h.length && c1h[j1 + 1].time + msMedio <= decisionTime) j1++;
    while (j4 + 1 < c4h.length && c4h[j4 + 1].time + msMayor <= decisionTime) j4++;
    if (j1 < 250 || j4 < 210) continue; // suficiente historia para EMA200

    const w15 = c15.slice(Math.max(0, i - 299), i + 2); // ultima = "en formacion" (se descarta)
    const w1 = c1h.slice(Math.max(0, j1 - 299), j1 + 1); w1.push(c1h[j1]);
    const w4 = c4h.slice(Math.max(0, j4 - 299), j4 + 1); w4.push(c4h[j4]);
    const live = c15[i + 1].open;

    let sigs;
    try {
      const evalOpts = {
        tfLabel, skip: STRATEGY_KEYS.filter((k) => !list.includes(k)),
        ...(btcSeries ? { btcBias: btcBiasAt(btcSeries, decisionTime) } : {}),
      };
      sigs = list.length === 1
        ? [{ strategy: list[0], sig: evaluate(w15, w1, w4, live, list[0], ind, riskMode, evalOpts) }]
        : evaluateAll(w15, w1, w4, live, ind, riskMode, evalOpts).filter((r) => list.includes(r.strategy));
    } catch { continue; }

    for (const { strategy: st, sig } of sigs) {
      if (!sig.dir) continue;
      if (sig.dir === "long" && i <= (blockL[st] ?? -1)) continue;
      if (sig.dir === "short" && i <= (blockS[st] ?? -1)) continue;

      const rec = {
        ts: decisionTime, symbol: sym, dir: sig.dir, modo: sig.modo, tf: tfLabel,
        confidence: sig.confidence, entry: sig.entry, stop: sig.stop, tps: sig.tps,
      };
      const res = resolveOutcome(rec, c15.slice(i + 1));
      if (!res) continue; // final del historico sin resolver

      if (sig.dir === "long") blockL[st] = i + 16; else blockS[st] = i + 16;
      const sc = subCat(sym);
      out.push({
        ...rec, subcat: sc,
        x: extractFeatures(sig, sc, decisionTime),
        segKeys: segmentKeys(sig, sc),
        outcome: res.outcome, r: res.r, detail: res.detail, closedAt: res.closedAt,
        source: "backtest",
      });
    }
  }
  return out;
}

export async function runBacktest({
  symbols, strategy, strategies = null, ind, riskMode, days = 90,
  tfs = null, tfsList = null, onProgress,
}) {
  const buckets = getBuckets();
  const model = getModel();
  const allSamples = [];
  const sampleRows = [];
  let totalSignals = 0, totalWins = 0, sumR = 0;
  const now = Date.now();

  const fullList = strategies ?? [strategy];
  // La estrategia de patrones NO pasa por el bucle generico: su backtest es una cosecha
  // (detecta TODAS las figuras del historico de una pasada) en vez de re-evaluar ventana
  // a ventana, que reconstruiria el contexto del detector miles de veces.
  const patternOn = fullList.includes("patrones");
  const stratList = fullList.filter((k) => k !== "patrones");
  const multi = stratList.length > 1;
  const DEFAULT_H = { gatillo: "15m", medio: "1h", mayor: "4h", msGatillo: 900000, msMedio: 3600000, msMayor: 14400000 };
  const hzList = tfsList ?? [tfs ?? DEFAULT_H];
  const total = hzList.length * symbols.length;
  let done = 0;

  // Cerebro dedicado de patrones: se siembra con la cosecha y se guarda al final.
  const patBrain = patternOn ? getPatternBrain() : null;
  let patTrained = 0;

  // La META necesita la historia de BTC 4h (una sola descarga sirve para todos los horizontes).
  let btcSeries = null;
  if (stratList.includes("meta")) {
    try {
      const btc4h = await fetchHistory("BTCUSDT", "4h", now - days * 86400000 - 310 * H4);
      btcSeries = btcBiasSeries(btc4h);
    } catch { /* sin BTC: la META correra sin ese filtro y lo advierte */ }
  }

  for (const H of hzList) {
    // El horizonte rapido (5m) genera 3x mas velas: se limita a 90 dias.
    const effDays = H.gatillo === "5m" ? Math.min(days, 90) : days;
    // Muestreo adaptativo; con todas las estrategias el paso sube para compensar el computo x8.
    const base = effDays <= 90 ? 4 : effDays <= 180 ? 6 : 8;
    const step = multi ? base + 2 : base;

    for (let si = 0; si < symbols.length; si++) {
      const sym = symbols[si];
      onProgress?.({ sym, done, total, fase: "descargando", tf: H.gatillo });
      let c15, c1h, c4h;
      try {
        const start = now - effDays * 86400000;
        [c15, c1h, c4h] = await Promise.all([
          fetchHistory(sym, H.gatillo, start - 310 * H.msGatillo),
          fetchHistory(sym, H.medio, start - 310 * H.msMedio),
          fetchHistory(sym, H.mayor, start - 310 * H.msMayor),
        ]);
      } catch { done++; continue; }
      if (!c15?.length || c15.length < 600) { done++; continue; }

      onProgress?.({ sym, done, total, fase: "evaluando", tf: H.gatillo });
      const recs = stratList.length
        ? await backtestSymbol(sym, c15, c1h, c4h, stratList, ind, riskMode, {
            btcSeries, step, msMedio: H.msMedio, msMayor: H.msMayor, tfLabel: H.gatillo,
          })
        : [];

      // ── Cosecha de patrones: una pasada sobre el mismo historico ya descargado.
      if (patternOn) {
        onProgress?.({ sym, done, total, fase: "cosechando patrones", tf: H.gatillo });
        try {
          const harvest = await harvestShadowTrades(c15, {}, { step: 3, harvestDepth: 3 });
          trainFromHarvest(patBrain, harvest);
          patTrained += harvest.samples.length;
          const sc = subCat(sym);
          for (const row of harvest.rows) {
            const win = row.r > 0 ? 1 : 0;
            addToBuckets(buckets, segmentKeys(
              { modo: "patrones", dir: row.dir, confidence: "-", tf: H.gatillo }, sc,
            ), win);
            sampleRows.push({
              ts: row.ts, symbol: sym, dir: row.dir, modo: "patrones", tf: H.gatillo,
              confidence: "-", outcome: row.outcome, r: row.r,
              detail: `${row.name} · ${row.detail}`, source: "backtest",
            });
            totalSignals++; totalWins += win; sumR += row.r;
          }
        } catch { /* simbolo sin datos suficientes para el detector */ }
      }

      for (const rec of recs) {
        const win = rec.r > 0 ? 1 : 0;
        addToBuckets(buckets, rec.segKeys, win);
        const ageDays = (now - rec.ts) / 86400000;
        // Peso por recencia relativo al periodo: lo viejo ensena menos, pero nunca menos de 0.3.
        allSamples.push({ x: rec.x, y: win, weight: Math.max(0.3, 1 - ageDays / (days * 2)) });
        sampleRows.push({
          ts: rec.ts, symbol: rec.symbol, dir: rec.dir, modo: rec.modo, tf: rec.tf,
          confidence: rec.confidence, outcome: rec.outcome, r: rec.r,
          detail: rec.detail, source: "backtest",
        });
        totalSignals++; totalWins += win; sumR += rec.r;
      }
      done++;
      await new Promise((r) => setTimeout(r, 200)); // respiro para la API y la UI
    }
  }

  trainBatch(model, allSamples, 3);
  saveModel(model);
  saveBuckets(buckets);
  if (patBrain) setPatternBrain(patBrain);
  sampleRows.sort((a, b) => b.ts - a.ts);
  save(K_BTSAMPLE, sampleRows.slice(0, MAX_BTSAMPLE));
  const meta = {
    ranAt: now, days, riskMode, patternSamples: patTrained,
    strategy: fullList.length > 1 ? `todas (${fullList.length})` : fullList[0],
    tf: hzList.map((h) => h.gatillo).join("+"),
    symbols: symbols.length, signals: totalSignals,
    wins: totalWins, winRate: totalSignals ? totalWins / totalSignals : 0,
    avgR: totalSignals ? sumR / totalSignals : 0,
  };
  save(K_BTMETA, meta);
  onProgress?.({ sym: null, done: total, total, fase: "listo" });
  return meta;
}

/* ---------- Mantenimiento ---------- */
export function exportJSON() {
  return JSON.stringify({
    signals: getSignals(), buckets: getBuckets(), model: getModel(),
    patternBrain: getPatternBrain(),
    btSample: getBtSample(), btMeta: getBtMeta(), v: 2,
  });
}

export function importJSON(text) {
  const d = JSON.parse(text);
  if (d.signals) save(K_SIGNALS, d.signals);
  if (d.buckets) save(K_BUCKETS, d.buckets);
  if (d.model) { save("cb_model_v1", d.model); _model = null; }
  if (d.patternBrain) { save(K_PATBRAIN, d.patternBrain); reloadPatternBrain(); }
  if (d.btSample) save(K_BTSAMPLE, d.btSample);
  if (d.btMeta) save(K_BTMETA, d.btMeta);
}

export function clearAll() {
  if (!hasStorage) return;
  [K_SIGNALS, K_BUCKETS, K_BTSAMPLE, K_BTMETA].forEach((k) => localStorage.removeItem(k));
  _model = resetModel();
  resetBrain();
  reloadPatternBrain();
}
