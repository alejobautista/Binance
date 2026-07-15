/* Regresion logistica con aprendizaje continuo (online SGD).
   Es la unidad basica de una red neuronal (una neurona con salida sigmoide):
   p = sigmoid(w·x + b). Se actualiza con cada senal resuelta. */

import { FEATURE_NAMES } from "./signalCore.js";

const KEY = "cb_model_v1";
const LR = 0.05;       // tasa de aprendizaje
const L2 = 0.001;      // regularizacion (evita pesos gigantes con pocos datos)

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

const hasStorage = typeof localStorage !== "undefined";

export function createModel(dim = FEATURE_NAMES.length) {
  return { w: new Array(dim).fill(0), b: 0, seen: 0 };
}

export function loadModel() {
  if (hasStorage) {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const m = JSON.parse(raw);
        if (Array.isArray(m.w) && m.w.length === FEATURE_NAMES.length) return m;
      }
    } catch { /* corrupto: se recrea */ }
  }
  return createModel();
}

export function saveModel(m) {
  if (hasStorage) {
    try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* storage lleno */ }
  }
}

export function predict(m, x) {
  let z = m.b;
  for (let i = 0; i < m.w.length; i++) z += m.w[i] * (x[i] ?? 0);
  return sigmoid(z);
}

// outcome: 1 = gano, 0 = perdio. weight: peso de la muestra (recencia).
export function train(m, x, outcome, weight = 1) {
  const p = predict(m, x);
  const g = (outcome - p) * weight;
  for (let i = 0; i < m.w.length; i++) {
    m.w[i] += LR * (g * (x[i] ?? 0) - L2 * m.w[i]);
  }
  m.b += LR * g;
  m.seen += 1;
  return m;
}

// Entrena varias pasadas barajadas sobre un lote (siembra del backtest).
export function trainBatch(m, samples, epochs = 3) {
  for (let e = 0; e < epochs; e++) {
    const idx = samples.map((_, i) => i);
    // Fisher-Yates con generador determinista simple (evita Math.random por reproducibilidad)
    let seed = 1234 + e;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    for (const i of idx) train(m, samples[i].x, samples[i].y, samples[i].weight ?? 1);
  }
  return m;
}

// Features que mas suman o restan a la probabilidad de ESTA senal (el "por que").
export function topFactors(m, x, k = 3) {
  const contrib = m.w
    .map((w, i) => ({ name: FEATURE_NAMES[i], v: w * (x[i] ?? 0) }))
    .filter((c) => Math.abs(c.v) > 0.02)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, k);
  return contrib.map((c) => ({ name: c.name, sube: c.v > 0, peso: c.v }));
}

export function resetModel() {
  const m = createModel();
  saveModel(m);
  return m;
}
