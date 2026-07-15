/* Motor de aprendizaje continuo: registro de senales, resolucion contra el precio real,
   buckets bayesianos por segmento, probabilidad hibrida (modelo logistico + buckets)
   y backtest historico para sembrar el record. */

import {
  fetchCandles, fetchHistory, evaluate, extractFeatures, segmentKeys,
  btcBiasSeries, btcBiasAt,
} from "./signalCore.js";
import { loadModel, saveModel, train, trainBatch, predict, topFactors, resetModel } from "./model.js";
import { subCat } from "./categories.js";

const K_SIGNALS = "cb_signals_v1";
const K_BUCKETS = "cb_buckets_v1";
const K_BTSAMPLE = "cb_btsample_v1";
const K_BTMETA = "cb_btmeta_v1";

const MAX_LIVE = 500;       // tope de senales en vivo guardadas
const MAX_BTSAMPLE = 300;   // muestra de backtest para la tabla
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
      const candles = await fetchCandles(s.symbol, "15m", Math.min(1000, EXPIRY_CANDLES + 10), {
        startTime: s.ts,
      });
      const res = resolveOutcome(s, candles);
      if (res) {
        Object.assign(s, { outcome: res.outcome, r: res.r, detail: res.detail, closedAt: res.closedAt });
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
  return {
    rows,
    live: {
      n: live.length,
      wins: liveWins,
      winRate: live.length ? liveWins / live.length : 0,
      avgR: live.length ? liveR / live.length : 0,
    },
    openCount: getSignals().filter((s) => s.outcome === "open").length,
    btMeta: getBtMeta(),
    modelSeen: getModel().seen,
  };
}

/* ---------- Backtest (siembra del historico) ---------- */
const H15 = 900000, H1 = 3600000, H4 = 14400000;

// Genera senales sobre historico y las resuelve. Solo computa; no toca storage.
// `step` = cada cuantas velas de 15m se evalua (4 = cada hora).
export function backtestSymbol(sym, c15, c1h, c4h, strategy, ind, riskMode, opts = {}) {
  const { btcSeries = null, step = 4 } = opts;
  const out = [];
  let j1 = -1, j4 = -1;
  let blockLong = -1, blockShort = -1;

  for (let i = 300; i < c15.length - 2; i += step) {
    const decisionTime = c15[i + 1].time;
    while (j1 + 1 < c1h.length && c1h[j1 + 1].time + H1 <= decisionTime) j1++;
    while (j4 + 1 < c4h.length && c4h[j4 + 1].time + H4 <= decisionTime) j4++;
    if (j1 < 250 || j4 < 210) continue; // suficiente historia para EMA200

    const w15 = c15.slice(Math.max(0, i - 299), i + 2); // ultima = "en formacion" (se descarta)
    const w1 = c1h.slice(Math.max(0, j1 - 299), j1 + 1); w1.push(c1h[j1]);
    const w4 = c4h.slice(Math.max(0, j4 - 299), j4 + 1); w4.push(c4h[j4]);
    const live = c15[i + 1].open;

    let sig;
    try {
      const evalOpts = btcSeries ? { btcBias: btcBiasAt(btcSeries, decisionTime) } : {};
      sig = evaluate(w15, w1, w4, live, strategy, ind, riskMode, evalOpts);
    } catch { continue; }
    if (!sig.dir) continue;
    if (sig.dir === "long" && i <= blockLong) continue;
    if (sig.dir === "short" && i <= blockShort) continue;

    const rec = {
      ts: decisionTime, symbol: sym, dir: sig.dir, modo: sig.modo,
      confidence: sig.confidence, entry: sig.entry, stop: sig.stop, tps: sig.tps,
    };
    const res = resolveOutcome(rec, c15.slice(i + 1));
    if (!res) continue; // final del historico sin resolver

    if (sig.dir === "long") blockLong = i + 16; else blockShort = i + 16;
    const sc = subCat(sym);
    out.push({
      ...rec, subcat: sc,
      x: extractFeatures(sig, sc, decisionTime),
      segKeys: segmentKeys(sig, sc),
      outcome: res.outcome, r: res.r, detail: res.detail, closedAt: res.closedAt,
      source: "backtest",
    });
  }
  return out;
}

export async function runBacktest({ symbols, strategy, ind, riskMode, days = 90, onProgress }) {
  const buckets = getBuckets();
  const model = getModel();
  const allSamples = [];
  const sampleRows = [];
  let totalSignals = 0, totalWins = 0, sumR = 0;
  const now = Date.now();
  // Muestreo adaptativo: periodos largos evaluan con paso mayor para no congelar el telefono.
  const step = days <= 90 ? 4 : days <= 180 ? 6 : 8;

  // La META necesita la historia de BTC 4h para su filtro de sesgo.
  let btcSeries = null;
  if (strategy === "meta") {
    try {
      const btc4h = await fetchHistory("BTCUSDT", "4h", now - days * 86400000 - 310 * H4);
      btcSeries = btcBiasSeries(btc4h);
    } catch { /* sin BTC: la META correra sin ese filtro y lo advierte */ }
  }

  for (let si = 0; si < symbols.length; si++) {
    const sym = symbols[si];
    onProgress?.({ sym, done: si, total: symbols.length, fase: "descargando" });
    let c15, c1h, c4h;
    try {
      const start = now - days * 86400000;
      [c15, c1h, c4h] = await Promise.all([
        fetchHistory(sym, "15m", start - 310 * H15),
        fetchHistory(sym, "1h", start - 310 * H1),
        fetchHistory(sym, "4h", start - 310 * H4),
      ]);
    } catch { continue; }
    if (!c15?.length || c15.length < 600) continue;

    onProgress?.({ sym, done: si, total: symbols.length, fase: "evaluando" });
    await new Promise((r) => setTimeout(r, 0)); // cede el hilo a la UI
    const recs = backtestSymbol(sym, c15, c1h, c4h, strategy, ind, riskMode, { btcSeries, step });

    for (const rec of recs) {
      const win = rec.r > 0 ? 1 : 0;
      addToBuckets(buckets, rec.segKeys, win);
      const ageDays = (now - rec.ts) / 86400000;
      // Peso por recencia relativo al periodo: lo viejo ensena menos, pero nunca menos de 0.3.
      allSamples.push({ x: rec.x, y: win, weight: Math.max(0.3, 1 - ageDays / (days * 2)) });
      sampleRows.push({
        ts: rec.ts, symbol: rec.symbol, dir: rec.dir, modo: rec.modo,
        confidence: rec.confidence, outcome: rec.outcome, r: rec.r,
        detail: rec.detail, source: "backtest",
      });
      totalSignals++; totalWins += win; sumR += rec.r;
    }
    await new Promise((r) => setTimeout(r, 200)); // respiro para la API y la UI
  }

  trainBatch(model, allSamples, 3);
  saveModel(model);
  saveBuckets(buckets);
  sampleRows.sort((a, b) => b.ts - a.ts);
  save(K_BTSAMPLE, sampleRows.slice(0, MAX_BTSAMPLE));
  const meta = {
    ranAt: now, days, strategy, riskMode,
    symbols: symbols.length, signals: totalSignals,
    wins: totalWins, winRate: totalSignals ? totalWins / totalSignals : 0,
    avgR: totalSignals ? sumR / totalSignals : 0,
  };
  save(K_BTMETA, meta);
  onProgress?.({ sym: null, done: symbols.length, total: symbols.length, fase: "listo" });
  return meta;
}

/* ---------- Mantenimiento ---------- */
export function exportJSON() {
  return JSON.stringify({
    signals: getSignals(), buckets: getBuckets(), model: getModel(),
    btSample: getBtSample(), btMeta: getBtMeta(), v: 1,
  });
}

export function importJSON(text) {
  const d = JSON.parse(text);
  if (d.signals) save(K_SIGNALS, d.signals);
  if (d.buckets) save(K_BUCKETS, d.buckets);
  if (d.model) { save("cb_model_v1", d.model); _model = null; }
  if (d.btSample) save(K_BTSAMPLE, d.btSample);
  if (d.btMeta) save(K_BTMETA, d.btMeta);
}

export function clearAll() {
  if (!hasStorage) return;
  [K_SIGNALS, K_BUCKETS, K_BTSAMPLE, K_BTMETA].forEach((k) => localStorage.removeItem(k));
  _model = resetModel();
}
