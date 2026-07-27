/* Cerebro DEDICADO a la estrategia de patrones (aislado de model.js).

   Es una neurona sigmoide (regresion logistica online): p = sigmoid(W·z), donde z es
   el vector de features ESTANDARIZADO. Frente al model.js compartido, este cerebro anade:
     - Estandarizacion online por Welford (media/varianza corrientes) -> cada feature entra
       en z-score. Sin esto, features de escalas dispares comparten un LR fijo y converge mal.
     - Regularizacion L2 que NO penaliza el bias.
     - Ponderacion de clase para el desbalance win/loss (muchos "expired" son perdidas).
     - Metricas de calidad: log-loss y Brier suavizados + norma del cambio de pesos (convergencia).
     - Prior Beta(2,2) por patron: con pocos trades tira a 0.5; con muchos, al win-rate real.
     - TP/SL adaptativos por cuantiles de MFE/MAE (en unidades de ATR).
     - Serializacion federada (CSV) compatible con el agregador FedAvg del script .pine.

   Se mantiene 1 sola capa a proposito: con pocas muestras + L2, una logistica bien calibrada
   generaliza mejor que un MLP, que sobreajustaria el ruido del mercado. */

// N_FEAT incluye el bias en la posicion 0. Mismo layout que f_build_feats del .pine:
// 0 bias · 1 latencia · 2 log(volRatio) · 3 tendencia(ATR) · 4 log(altura/ATR) ·
// 5 altura/riesgo · 6 duracion · 7 RSI dir · 8 efficiency ratio · 9 regimen vol ·
// 10 prior Beta patron · 11 alineacion benchmark · 12 vol benchmark · 13 barrido SMC ·
// 14 premium/discount SMC.
export const N_FEAT = 15;
export const FEATURE_NAMES = [
  "bias", "latencia", "volumen", "tendencia", "altura", "altura/riesgo", "duracion",
  "rsi", "eficiencia", "regimen vol", "prior patron", "benchmark", "vol benchmark",
  "barrido liq.", "premium/disc.",
];

const KEY = "cb_pattern_model_v1";
const LR = 0.03;          // tasa de aprendizaje (igual que ml_lr del .pine)
const L2 = 0.002;         // regularizacion L2 (igual que ml_l2)
const MEM_CAP = 400;      // muestras retenidas de MFE/MAE (el mercado cambia)
const ADAPT_MIN_N = 20;   // muestras minimas antes de adaptar TP/SL
const CLAMP_SIGMA = 4.0;  // recorte de z-score contra outliers

const hasStorage = typeof localStorage !== "undefined";
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function createBrain(dim = N_FEAT) {
  return {
    w: new Array(dim).fill(0),      // pesos
    mean: new Array(dim).fill(0),   // media corriente (Welford)
    m2: new Array(dim).fill(0),     // suma de cuadrados de desvios (Welford)
    nNorm: 0,                       // observaciones del normalizador
    nTrained: 0,                    // trades usados para entrenar
    logloss: 0, brier: 0, dwEMA: 0, // metricas suavizadas
    mfe: [], maeWin: [],            // memorias empiricas (unidades ATR)
    adaptTP1: null, adaptTP2: null, adaptTP3: null, adaptSL: null,
    nImport: 0,                     // muestras del modelo federado importado
  };
}

export function loadBrain() {
  if (hasStorage) {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const m = JSON.parse(raw);
        if (Array.isArray(m.w) && m.w.length === N_FEAT) return { ...createBrain(), ...m };
      }
    } catch { /* corrupto: se recrea */ }
  }
  return createBrain();
}

export function saveBrain(m) {
  if (hasStorage) {
    try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* storage lleno */ }
  }
}

export function resetBrain() {
  const m = createBrain();
  saveBrain(m);
  return m;
}

/* ---------- Normalizador online (Welford) ---------- */
function normUpdate(m, x) {
  m.nNorm += 1;
  const n = m.nNorm;
  for (let i = 1; i < N_FEAT; i++) { // el bias (0) no se estandariza
    const v = x[i] ?? 0;
    const d = v - m.mean[i];
    m.mean[i] += d / n;
    m.m2[i] += d * (v - m.mean[i]);
  }
}

// z-score con clamp a +-CLAMP_SIGMA. Devuelve un vector nuevo (no muta x).
export function standardize(m, x) {
  const z = new Array(N_FEAT).fill(0);
  z[0] = 1.0;
  const n = m.nNorm;
  for (let i = 1; i < N_FEAT; i++) {
    const sd = n > 1 ? Math.sqrt(m.m2[i] / (n - 1)) : 0;
    const v = sd > 1e-10 ? ((x[i] ?? 0) - m.mean[i]) / sd : 0;
    z[i] = Math.max(-CLAMP_SIGMA, Math.min(CLAMP_SIGMA, v));
  }
  return z;
}

/* ---------- Forward pass ---------- */
export function predict(m, x) {
  const z = standardize(m, x);
  let acc = 0;
  for (let i = 0; i < N_FEAT; i++) acc += m.w[i] * z[i];
  return sigmoid(acc);
}

/* ---------- Backward pass (log-loss) ----------
   outcome: 1 = gano, 0 = perdio. classW pondera la clase minoritaria; weight es la recencia.
   Se llama SOLO al resolverse el trade, con las features congeladas en la entrada. */
export function train(m, x, outcome, weight = 1, classW = 1) {
  normUpdate(m, x);
  const z = standardize(m, x);
  let acc = 0;
  for (let i = 0; i < N_FEAT; i++) acc += m.w[i] * z[i];
  const p = sigmoid(acc);
  const err = (outcome - p) * weight * classW;
  let dnorm = 0;
  for (let i = 0; i < N_FEAT; i++) {
    const g = err * z[i] - (i === 0 ? 0 : L2 * m.w[i]); // L2 no aplica al bias
    const dw = LR * g;
    m.w[i] += dw;
    dnorm += dw * dw;
  }
  m.dwEMA = m.dwEMA * 0.9 + Math.sqrt(dnorm) * 0.1;
  m.nTrained += 1;
  const pc = Math.max(1e-6, Math.min(1 - 1e-6, p));
  const ll = -(outcome * Math.log(pc) + (1 - outcome) * Math.log(1 - pc));
  const br = (outcome - p) ** 2;
  const a = 0.05;
  const first = m.nTrained <= 1;
  m.logloss = first ? ll : m.logloss * (1 - a) + ll * a;
  m.brier = first ? br : m.brier * (1 - a) + br * a;
  return m;
}

// Entrena varias pasadas barajadas sobre un lote (siembra del backtest). Determinista.
// Cada muestra: { x, y, weight? }. Compensa el desbalance win/loss automaticamente.
export function trainBatch(m, samples, epochs = 3) {
  if (!samples.length) return m;
  const wins = samples.reduce((a, s) => a + (s.y > 0 ? 1 : 0), 0);
  const losses = samples.length - wins;
  // Peso de clase: sube la clase minoritaria hasta equilibrar (acotado para no desbocar).
  const wWin = wins > 0 ? Math.min(4, losses / wins) : 1;
  const wLoss = losses > 0 ? Math.min(4, wins / losses) : 1;
  const balW = (y) => (y > 0 ? Math.max(1, wWin) : Math.max(1, wLoss));
  for (let e = 0; e < epochs; e++) {
    const idx = samples.map((_, i) => i);
    let seed = 1234 + e;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    for (const i of idx) train(m, samples[i].x, samples[i].y, samples[i].weight ?? 1, balW(samples[i].y));
  }
  return m;
}

// Factores que mas suman/restan a la probabilidad de ESTA senal (el "por que").
export function topFactors(m, x, k = 3) {
  const z = standardize(m, x);
  return m.w
    .map((w, i) => ({ name: FEATURE_NAMES[i], v: w * z[i] }))
    .filter((c, i) => i !== 0 && Math.abs(c.v) > 0.02)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, k)
    .map((c) => ({ name: c.name, sube: c.v > 0, peso: c.v }));
}

/* ---------- Prior Beta(2,2) por patron ----------
   stats: { [pattern]: { w, l } }. Con pocos trades tira a 0.5, con muchos al win-rate real. */
export function betaPrior(stats, pattern) {
  const s = stats?.[pattern] ?? { w: 0, l: 0 };
  return (s.w + 2) / (s.w + s.l + 4);
}

/* ---------- Metricas de calidad ---------- */
// Baseline: log-loss de predecir siempre la tasa base. Si logloss < baseline, el modelo aporta.
export function baselineLogLoss(wins, losses) {
  const tot = wins + losses;
  if (!tot) return 0.6931; // -ln(0.5)
  const r = Math.max(0.02, Math.min(0.98, wins / tot));
  return -(r * Math.log(r) + (1 - r) * Math.log(1 - r));
}

// El umbral se mide en TRADES RESUELTOS distintos, no en pasos de gradiente: trainBatch
// hace varias epocas sobre el mismo lote, asi que nTrained sobreestima lo que el modelo
// realmente ha visto y abriria el filtro de p(win) demasiado pronto.
export function brainState(m, wins, losses, warmN = 40) {
  const base = baselineLogLoss(wins, losses);
  const n = wins + losses;
  if (n < warmN) return { label: `Aprendiendo (${n}/${warmN})`, edge: false, ready: false, base, n };
  const edge = m.logloss < base;
  return { label: edge ? "Con edge" : "Sin edge vs base", edge, ready: true, base, n };
}

/* ---------- TP/SL adaptativos ---------- */
// Cuantil empirico con interpolacion lineal sobre una copia ordenada.
export function quantile(arr, q) {
  const n = arr.length;
  if (!n) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (n - 1) * Math.max(0, Math.min(1, q / 100));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function pushCapped(arr, v) {
  arr.push(v);
  while (arr.length > MEM_CAP) arr.shift();
}

// Alimenta las memorias al resolverse un trade. mfe/mae en unidades de ATR; win marca ganador.
export function recordExcursion(m, { mfe, mae, win }) {
  if (mfe != null && isFinite(mfe)) pushCapped(m.mfe, mfe);
  if (win && mae != null && isFinite(mae)) pushCapped(m.maeWin, mae);
}

// Recalcula los multiplicadores adaptativos (percentiles de MFE / MAE de ganadores).
export function recomputeAdaptive(m, cfg = {}) {
  const { q1 = 50, q2 = 75, q3 = 90, slQ = 80, maxAtr = 10 } = cfg;
  const clamp = (v, lo) => Math.max(lo, Math.min(maxAtr, v));
  if (m.mfe.length >= ADAPT_MIN_N) {
    m.adaptTP1 = clamp(quantile(m.mfe, q1), 0.3);
    m.adaptTP2 = clamp(quantile(m.mfe, q2), 0.5);
    m.adaptTP3 = clamp(quantile(m.mfe, q3), 0.8);
    // Los TP deben quedar ordenados y separados.
    m.adaptTP2 = Math.max(m.adaptTP2, m.adaptTP1 * 1.2);
    m.adaptTP3 = Math.max(m.adaptTP3, m.adaptTP2 * 1.2);
  }
  if (m.maeWin.length >= ADAPT_MIN_N) {
    // +20% de margen: los ganadores rara vez excedieron esto antes de funcionar.
    m.adaptSL = clamp(quantile(m.maeWin, slQ) * 1.2, 0.3);
  }
  return m;
}

// Multiplicadores ATR efectivos: fijos al inicio, empiricos con evidencia (encogimiento bayesiano).
export function effectiveTPs(m, baseTP1, baseTP2, baseTP3) {
  if (m.adaptTP1 == null || m.mfe.length < ADAPT_MIN_N) return [baseTP1, baseTP2, baseTP3];
  const w = m.mfe.length / (m.mfe.length + ADAPT_MIN_N);
  let m1 = baseTP1 * (1 - w) + m.adaptTP1 * w;
  let m2 = baseTP2 * (1 - w) + m.adaptTP2 * w;
  let m3 = baseTP3 * (1 - w) + m.adaptTP3 * w;
  m2 = Math.max(m2, m1 * 1.2);
  m3 = Math.max(m3, m2 * 1.2);
  return [m1, m2, m3];
}

/* ---------- Serializacion federada (CSV, compatible con el agregador .pine) ---------- */
const arrToCsv = (a) => a.map((v) => (+v).toFixed(6).replace(/\.?0+$/, "")).join(",");
function csvToArr(src, n) {
  if (!src || !String(src).trim()) return null;
  const parts = String(src).replace(/\s/g, "").split(",");
  if (parts.length !== n) return null;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const v = parseFloat(parts[i]);
    if (!isFinite(v)) return null;
    out[i] = v;
  }
  return out;
}

// Devuelve el estado del cerebro como objeto (para webhook/agregador o backup).
export function exportBrain(m) {
  const sd = new Array(N_FEAT).fill(0);
  const n = m.nNorm;
  for (let i = 0; i < N_FEAT; i++) sd[i] = n > 1 ? Math.sqrt(m.m2[i] / (n - 1)) : 0;
  return {
    type: "pattern_model_export",
    n_norm: m.nNorm, n_trained: m.nTrained,
    logloss: +m.logloss.toFixed(5), brier: +m.brier.toFixed(5),
    W: arrToCsv(m.w), MEAN: arrToCsv(m.mean), SD: arrToCsv(sd),
    TPSL: [m.adaptTP1, m.adaptTP2, m.adaptTP3, m.adaptSL]
      .map((v) => (v == null ? "" : (+v).toFixed(3))).join(","),
  };
}

// Importa pesos consolidados. Acepta el JSON de exportBrain o el CSV crudo de W/MEAN/SD.
// Reconstruye M2 desde SD y n: M2 = sd^2 * (n-1). Fail-safe: si algo no cuadra, no toca el modelo.
export function importBrain(m, payload, opts = {}) {
  let d = payload;
  if (typeof payload === "string") {
    try { d = JSON.parse(payload); } catch { return { ok: false, reason: "JSON invalido" }; }
  }
  const nImp = Math.max(1, opts.nImport ?? d.n_norm ?? d.n_trained ?? 1);
  const w = csvToArr(d.W, N_FEAT);
  const mu = csvToArr(d.MEAN, N_FEAT);
  const sd = csvToArr(d.SD, N_FEAT);
  if (!w || !mu || !sd) return { ok: false, reason: "W/MEAN/SD ausentes o de tamano incorrecto" };
  for (let i = 0; i < N_FEAT; i++) {
    m.w[i] = w[i];
    m.mean[i] = mu[i];
    m.m2[i] = sd[i] * sd[i] * Math.max(1, nImp - 1);
  }
  m.nNorm = nImp;
  m.nImport = nImp;
  // Modo "importado (solo inferir)" arranca el contador de entrenamiento en n_import
  // para que el gate de p(win) considere que el modelo ya vio muestras; "hibrido" en 0.
  m.nTrained = opts.keepTraining ? 0 : (d.n_trained ?? nImp);
  const tp = csvToArr(d.TPSL, 4);
  if (tp) { m.adaptTP1 = tp[0]; m.adaptTP2 = tp[1]; m.adaptTP3 = tp[2]; m.adaptSL = tp[3]; }
  return { ok: true };
}
