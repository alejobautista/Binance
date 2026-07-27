/* Motor de senales puro (sin React): indicadores, estructura, niveles y evaluacion.
   Reutilizado por la UI, el Top 3 del escaner y el backtest. */

// La estrategia de patrones vive en sus propios modulos (detector + cerebro dedicado).
// El ciclo de imports es intencional y seguro: patternCore solo usa los indicadores de
// este archivo DENTRO de funciones, nunca al evaluar el modulo.
import { buildPatternSignal } from "./patternSignal.js";

const BASES = [
  "https://api.binance.com/api/v3",
  "https://data-api.binance.vision/api/v3",
];

export async function fetchJson(path) {
  let lastErr;
  for (const b of BASES) {
    try {
      const res = await fetch(`${b}${path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function fetchCandles(sym, interval, limit = 300, opts = {}) {
  let extra = "";
  if (opts.startTime) extra += `&startTime=${opts.startTime}`;
  if (opts.endTime) extra += `&endTime=${opts.endTime}`;
  const raw = await fetchJson(`/klines?symbol=${sym}&interval=${interval}&limit=${limit}${extra}`);
  return raw.map((c) => ({
    time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5],
    takerBuy: c[9] != null ? +c[9] : null, // volumen EJECUTADO por compradores agresivos
  }));
}

// Descarga historico encadenando peticiones de 1000 velas desde startTime hasta hoy.
// El tope de 60 tandas cubre holgado un anio de velas de 15m (~35k + margen).
export async function fetchHistory(sym, interval, startTime) {
  const out = [];
  let cursor = startTime;
  for (let guard = 0; guard < 60; guard++) {
    const chunk = await fetchCandles(sym, interval, 1000, { startTime: cursor });
    if (!chunk.length) break;
    // evita duplicar la vela de empalme
    const startIdx = out.length && chunk[0].time <= out[out.length - 1].time ? 1 : 0;
    out.push(...chunk.slice(startIdx));
    if (chunk.length < 1000) break;
    cursor = chunk[chunk.length - 1].time + 1;
  }
  return out;
}

/* ---------- LIBRO DE ORDENES (liquidez) ---------- */
export async function fetchDepth(sym, limit = 1000) {
  const d = await fetchJson(`/depth?symbol=${sym}&limit=${limit}`);
  const toL = (r) => ({ price: +r[0], qty: +r[1] });
  return { bids: d.bids.map(toL), asks: d.asks.map(toL) };
}

// Agrupa el libro en "muros": bins de ~0.2% del precio dentro de ±5%,
// y mide el desequilibrio compra/venta en el rango cercano (±2%).
export function analyzeDepth(bids, asks, mid, opts = {}) {
  const { range = 0.05, near = 0.02, binPct = 0.002, topN = 4 } = opts;
  const walls = (levels, side) => {
    const bins = new Map();
    for (const { price, qty } of levels) {
      if (Math.abs(price - mid) / mid > range) continue;
      const key = Math.round(price / (mid * binPct));
      const b = bins.get(key) ?? { quote: 0, pxQ: 0 };
      b.quote += price * qty;
      b.pxQ += price * price * qty;
      bins.set(key, b);
    }
    const ranked = [...bins.values()]
      .map((b) => ({ price: b.pxQ / b.quote, quote: b.quote, side }))
      .sort((a, b) => b.quote - a.quote);
    const floor = ranked.length ? ranked[0].quote * 0.15 : 0; // descarta bins insignificantes
    return ranked
      .filter((w) => w.quote >= floor)
      .slice(0, topN)
      .map((w) => ({ ...w, distPct: ((w.price - mid) / mid) * 100 }))
      .sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));
  };
  const nearBid = bids.filter((l) => l.price >= mid * (1 - near)).reduce((a, l) => a + l.price * l.qty, 0);
  const nearAsk = asks.filter((l) => l.price <= mid * (1 + near)).reduce((a, l) => a + l.price * l.qty, 0);
  return {
    buyWalls: walls(bids, "buy"),
    sellWalls: walls(asks, "sell"),
    nearBid, nearAsk,
    imbalance: nearBid + nearAsk > 0 ? nearBid / (nearBid + nearAsk) : 0.5,
  };
}

/* ---------- HORIZONTES DE OPERACION ---------- */
// El motor es agnostico a la temporalidad: cambiar el horizonte cambia las velas
// que alimentan al mismo calculo (gatillo / media / mayor).
export const HORIZONS = {
  rapido: {
    key: "rapido", label: "RAPIDO", gatillo: "5m", medio: "15m", mayor: "1h",
    msGatillo: 300000, msMedio: 900000, msMayor: 3600000,
    horizonte: "30 minutos a 6 horas", pollMs: 10000,
  },
  intradia: {
    key: "intradia", label: "INTRADIA", gatillo: "15m", medio: "1h", mayor: "4h",
    msGatillo: 900000, msMedio: 3600000, msMayor: 14400000,
    horizonte: "2 a 24 horas", pollMs: 20000,
  },
  swing: {
    key: "swing", label: "SWING", gatillo: "1h", medio: "4h", mayor: "1d",
    msGatillo: 3600000, msMedio: 14400000, msMayor: 86400000,
    horizonte: "1 a 8 dias", pollMs: 60000,
  },
};
export const HORIZON_KEYS = ["rapido", "intradia", "swing"];

export const fmtQ = (q) =>
  q >= 1e6 ? `${(q / 1e6).toFixed(2)}M` : `${(q / 1e3).toFixed(0)}K`;

export const fmt = (n) => {
  if (n == null || isNaN(n)) return "-";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
};

/* ---------- INDICADORES ---------- */
export const ema = (data, period) => {
  if (!data || data.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(data.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  out[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) out[i] = data[i] * k + out[i - 1] * (1 - k);
  return out;
};

export const sma = (data, period) => {
  const out = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += data[j];
    out[i] = s / period;
  }
  return out;
};

export const rsi = (closes, period = 14) => {
  if (closes.length < period + 1) return [];
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
};

export const macd = (closes, fast = 12, slow = 26, sig = 9) => {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const valid = line.filter((v) => v != null);
  const sl = ema(valid, sig);
  const offset = line.length - valid.length;
  const signal = new Array(line.length).fill(null);
  sl.forEach((v, i) => { if (v != null) signal[i + offset] = v; });
  return { line, signal };
};

export const atr = (highs, lows, closes, period = 14) => {
  if (closes.length < period + 1) return [];
  const tr = [null];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const out = new Array(closes.length).fill(null);
  let s = 0;
  for (let i = 1; i <= period; i++) s += tr[i];
  out[period] = s / period;
  for (let i = period + 1; i < closes.length; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
};

export const bollinger = (closes, period = 20, mult = 2) => {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = ((upper[i] - lower[i]) / mid[i]) * 100;
  }
  return { mid, upper, lower, width };
};

export const last = (arr) => {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
};

/* ---------- INDICADORES DE LAS 5 ESTRATEGIAS ---------- */
// ADX/DMI de Wilder: fuerza y direccion de la tendencia.
export const adxDmi = (highs, lows, closes, period = 14) => {
  const n = closes.length;
  const plusDM = [0], minusDM = [0], tr = [0];
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const smooth = (arr) => {
    const out = new Array(n).fill(null);
    if (n <= period) return out;
    let s = 0;
    for (let i = 1; i <= period; i++) s += arr[i];
    out[period] = s;
    for (let i = period + 1; i < n; i++) out[i] = out[i - 1] - out[i - 1] / period + arr[i];
    return out;
  };
  const trS = smooth(tr), pS = smooth(plusDM), mS = smooth(minusDM);
  const pDI = new Array(n).fill(null), mDI = new Array(n).fill(null), dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (!trS[i]) continue;
    pDI[i] = (100 * pS[i]) / trS[i];
    mDI[i] = (100 * mS[i]) / trS[i];
    const s = pDI[i] + mDI[i];
    dx[i] = s ? (100 * Math.abs(pDI[i] - mDI[i])) / s : 0;
  }
  const adxArr = new Array(n).fill(null);
  const start = period * 2;
  if (n > start) {
    let s = 0;
    for (let i = period; i < start; i++) s += dx[i] ?? 0;
    adxArr[start - 1] = s / period;
    for (let i = start; i < n; i++) adxArr[i] = (adxArr[i - 1] * (period - 1) + (dx[i] ?? 0)) / period;
  }
  return { adx: adxArr, plusDI: pDI, minusDI: mDI };
};

export const cci = (highs, lows, closes, period = 14) => {
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < tp.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += tp[j];
    const m = s / period;
    let md = 0;
    for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - m);
    md /= period;
    out[i] = md ? (tp[i] - m) / (0.015 * md) : 0;
  }
  return out;
};

// Canal de Donchian de las N velas ANTERIORES (sin incluir la actual): ruptura limpia.
export const donchian = (highs, lows, period) => {
  const n = highs.length;
  const up = new Array(n).fill(null), lo = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    up[i] = Math.max(...highs.slice(i - period, i));
    lo[i] = Math.min(...lows.slice(i - period, i));
  }
  return { up, lo };
};

export const supertrend = (highs, lows, closes, period = 10, mult = 3) => {
  const a = atr(highs, lows, closes, period);
  const n = closes.length;
  const dir = new Array(n).fill(null), line = new Array(n).fill(null);
  let ub = null, lb = null, prevDir = 1;
  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    const mid = (highs[i] + lows[i]) / 2;
    let bu = mid + mult * a[i], bl = mid - mult * a[i];
    if (ub != null) {
      bu = bu < ub || closes[i - 1] > ub ? bu : ub;
      bl = bl > lb || closes[i - 1] < lb ? bl : lb;
    }
    let d = prevDir;
    if (prevDir === 1 && closes[i] < bl) d = -1;
    else if (prevDir === -1 && closes[i] > bu) d = 1;
    dir[i] = d;
    line[i] = d === 1 ? bl : bu;
    ub = bu; lb = bl; prevDir = d;
  }
  return { dir, line };
};

export const psar = (highs, lows, step = 0.02, maxStep = 0.2) => {
  const n = highs.length;
  const out = new Array(n).fill(null);
  if (n < 3) return out;
  let up = true, af = step, ep = highs[0], sar = lows[0];
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, lows[i - 1], i > 1 ? lows[i - 2] : lows[i - 1]);
      if (lows[i] < sar) { up = false; sar = ep; ep = lows[i]; af = step; }
      else if (highs[i] > ep) { ep = highs[i]; af = Math.min(maxStep, af + step); }
    } else {
      sar = Math.max(sar, highs[i - 1], i > 1 ? highs[i - 2] : highs[i - 1]);
      if (highs[i] > sar) { up = true; sar = ep; ep = highs[i]; af = step; }
      else if (lows[i] < ep) { ep = lows[i]; af = Math.min(maxStep, af + step); }
    }
    out[i] = { sar, up };
  }
  return out;
};

export const ichimoku = (highs, lows, closes) => {
  const n = closes.length;
  const mid = (p, i) =>
    i >= p - 1 ? (Math.max(...highs.slice(i - p + 1, i + 1)) + Math.min(...lows.slice(i - p + 1, i + 1))) / 2 : null;
  const tenkan = [], kijun = [], spanA = [], spanB = [];
  for (let i = 0; i < n; i++) {
    tenkan.push(mid(9, i));
    kijun.push(mid(26, i));
  }
  for (let i = 0; i < n; i++) {
    spanA.push(tenkan[i] != null && kijun[i] != null ? (tenkan[i] + kijun[i]) / 2 : null);
    spanB.push(mid(52, i));
  }
  return { tenkan, kijun, spanA, spanB }; // la nube ACTUAL en i son los spans calculados en i-26
};

export const cmf = (candles, period = 20) => {
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let mfv = 0, vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const c = candles[j];
      const range = c.high - c.low;
      const mult = range ? (c.close - c.low - (c.high - c.close)) / range : 0;
      mfv += mult * c.volume;
      vol += c.volume;
    }
    out[i] = vol ? mfv / vol : 0;
  }
  return out;
};

export const mfi = (highs, lows, closes, vols, period = 14) => {
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const mf = tp[j] * vols[j];
      if (tp[j] > tp[j - 1]) pos += mf;
      else if (tp[j] < tp[j - 1]) neg += mf;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
};

export const anchoredVWAP = (candles, anchorIdx) => {
  const out = new Array(candles.length).fill(null);
  let pv = 0, v = 0;
  for (let i = anchorIdx; i < candles.length; i++) {
    const c = candles[i];
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    v += c.volume;
    out[i] = v ? pv / v : null;
  }
  return out;
};

/* ---------- ANALISIS POR TIMEFRAME ---------- */
export function analyzeTF(candles) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume);
  const n = closes.length;

  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const r = rsi(closes, 14), m = macd(closes), a = atr(highs, lows, closes, 14);
  const bb = bollinger(closes);

  const volAvg = vols.slice(-21, -1).reduce((x, y) => x + y, 0) / 20;
  const lastCandle = candles[n - 1];
  const srLows = lows.slice(-33, -3);
  const srHighs = highs.slice(-33, -3);

  // Delta de volumen EJECUTADO: fraccion comprada por agresores (taker buy / total).
  let deltaLast = null, delta10 = null;
  if (lastCandle.takerBuy != null) {
    deltaLast = vols[n - 1] > 0 ? lastCandle.takerBuy / vols[n - 1] : 0.5;
    const last10 = candles.slice(-10);
    const v10 = last10.reduce((a, c) => a + c.volume, 0);
    const b10 = last10.reduce((a, c) => a + (c.takerBuy ?? c.volume / 2), 0);
    delta10 = v10 > 0 ? b10 / v10 : 0.5;
  }

  return {
    deltaLast, delta10,
    close: closes[n - 1],
    candleDir: lastCandle.close > lastCandle.open ? 1 : lastCandle.close < lastCandle.open ? -1 : 0,
    ema9: last(e9), ema21: last(e21), ema50: last(e50), ema200: last(e200),
    rsi: last(r), macdLine: last(m.line), macdSignal: last(m.signal),
    atr: last(a),
    bbUpper: last(bb.upper), bbLower: last(bb.lower), bbMid: last(bb.mid), bbWidth: last(bb.width),
    volRatio: volAvg > 0 ? vols[n - 1] / volAvg : 1,
    support: Math.min(...srLows),
    resistance: Math.max(...srHighs),
  };
}

/* ---------- MOTOR DE ESTRUCTURA (HH/HL/LH/LL + BOS/CHoCH) ---------- */
export function structureEngine(candles, left = 3, right = 3) {
  const n = candles.length;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);

  const rawPivots = [];
  for (let i = left; i < n - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (highs[j] >= highs[i]) isH = false;
      if (lows[j] <= lows[i]) isL = false;
    }
    if (isH) rawPivots.push({ i, price: highs[i], kind: "H", time: candles[i].time });
    if (isL) rawPivots.push({ i, price: lows[i], kind: "L", time: candles[i].time });
  }

  // Un pivote solo se confirma `right` velas despues de formarse (sin repintado).
  const byConfirm = new Map();
  rawPivots.forEach((p) => {
    const t = p.i + right;
    if (!byConfirm.has(t)) byConfirm.set(t, []);
    byConfirm.get(t).push(p);
  });

  let trend = 0; // 1 alcista, -1 bajista, 0 sin definir
  let prevH = null, prevL = null, lastH = null, lastL = null;
  const seq = [], events = [];
  const BULL = new Set(["HH", "HL"]), BEAR = new Set(["LH", "LL"]);

  for (let t = 0; t < n; t++) {
    for (const p of byConfirm.get(t) || []) {
      if (p.kind === "H") {
        const label = prevH ? (p.price > prevH.price ? "HH" : "LH") : "H";
        prevH = p;
        lastH = { ...p, label, broken: false };
        seq.push(lastH);
      } else {
        const label = prevL ? (p.price > prevL.price ? "HL" : "LL") : "L";
        prevL = p;
        lastL = { ...p, label, broken: false };
        seq.push(lastL);
      }
      // Sin tendencia definida aun: sembrarla cuando dos pivotes seguidos apuntan igual,
      // para que el primer rompimiento en contra cuente como CHoCH y no como BOS.
      if (trend === 0 && seq.length >= 2) {
        const a = seq[seq.length - 2].label, b = seq[seq.length - 1].label;
        if (BULL.has(a) && BULL.has(b)) trend = 1;
        else if (BEAR.has(a) && BEAR.has(b)) trend = -1;
      }
    }
    const c = closes[t];
    if (lastH && !lastH.broken && c > lastH.price) {
      lastH.broken = true;
      events.push({
        t, time: candles[t].time, level: lastH.price, dir: "up",
        type: trend === -1 ? "CHoCH+" : "BOS alcista",
      });
      trend = 1;
    }
    if (lastL && !lastL.broken && c < lastL.price) {
      lastL.broken = true;
      events.push({
        t, time: candles[t].time, level: lastL.price, dir: "down",
        type: trend === 1 ? "CHoCH-" : "BOS bajista",
      });
      trend = -1;
    }
  }

  return { seq, events, trend, lastH, lastL, n };
}

/* ---------- NIVELES / GESTION (compartido) ---------- */
export function buildLevels(dir, live, A, stopPrice, tf15, tf1h, strict) {
  const entry = live;
  if (dir === "long") {
    const stop = stopPrice;
    const risk = entry - stop;
    if (risk <= 0) return { blocked: true, reason: "Stop invalido: quedaria por encima del precio." };
    const ceiling = [tf15.resistance, tf1h.resistance]
      .filter((x) => x > entry * 1.001)
      .sort((a, b) => a - b)[0] ?? null;
    const roomR = ceiling ? (ceiling - entry) / risk : null;
    let warning = null;
    if (roomR !== null && roomR < 1.5) {
      const reason = `Techo estructural en ${fmt(ceiling)} a solo ${roomR.toFixed(2)}R. No cumple el minimo 1:1.5 de recorrido libre.`;
      if (strict) return { blocked: true, reason, roomR, ceiling };
      warning = reason;
    }
    const stopPct = ((entry - stop) / entry) * 100;
    return {
      entry, zone: [live - 0.4 * A, live], stop, roomR, ceiling, warning,
      tps: [
        { pct: 40, price: entry + risk * 1.0, r: 1.0 },
        { pct: 35, price: entry + risk * 1.8, r: 1.8 },
        { pct: 25, price: entry + risk * 3.0, r: 3.0 },
      ],
      maxLev: Math.max(1, Math.min(10, Math.floor(100 / (stopPct * 1.6)))),
      invalidation: `Cierre bajo ${fmt(stop)} (vela de gatillo) anula el setup.`,
    };
  }
  const stop = stopPrice;
  const risk = stop - entry;
  if (risk <= 0) return { blocked: true, reason: "Stop invalido: quedaria por debajo del precio." };
  const floor = [tf15.support, tf1h.support]
    .filter((x) => x < entry * 0.999)
    .sort((a, b) => b - a)[0] ?? null;
  const roomR = floor ? (entry - floor) / risk : null;
  let warning = null;
  if (roomR !== null && roomR < 1.5) {
    const reason = `Piso estructural en ${fmt(floor)} a solo ${roomR.toFixed(2)}R. No cumple el minimo 1:1.5 de recorrido libre.`;
    if (strict) return { blocked: true, reason, roomR, ceiling: floor };
    warning = reason;
  }
  const stopPct = ((stop - entry) / entry) * 100;
  return {
    entry, zone: [live, live + 0.4 * A], stop, roomR, ceiling: floor, warning,
    tps: [
      { pct: 40, price: entry - risk * 1.0, r: 1.0 },
      { pct: 35, price: entry - risk * 1.8, r: 1.8 },
      { pct: 25, price: entry - risk * 3.0, r: 3.0 },
    ],
    maxLev: Math.max(1, Math.min(10, Math.floor(100 / (stopPct * 1.6)))),
    invalidation: `Cierre sobre ${fmt(stop)} (vela de gatillo) anula el setup.`,
  };
}

/* ---------- ESTRATEGIA 1: INDICADORES (EMAs, RSI, MACD, Bollinger) ---------- */
export function buildIndicatorSignal(tf15, tf1h, tf4h, live, ind, riskMode) {
  const strict = riskMode !== "flexible";
  const core = [];
  const contexto = [];
  const warnings = [];
  let bull = 0, bear = 0;
  let allowLong = true, allowShort = true;

  const tfScore = (t) =>
    t.ema50 && t.ema200
      ? t.close > t.ema50 && t.ema50 > t.ema200 ? 1
        : t.close < t.ema50 && t.ema50 < t.ema200 ? -1 : 0
      : 0;
  const biasScore = 2 * tfScore(tf4h) + tfScore(tf1h);
  const bias = biasScore >= 2 ? "ALCISTA" : biasScore <= -2 ? "BAJISTA" : "RANGO";

  if (ind.emas) {
    if (tf15.ema9 > tf15.ema21 && tf15.close > tf15.ema21) {
      core.push({ n: "EMAs 9/21", v: "Cruce alcista confirmado al cierre", d: "up" }); bull++;
    } else if (tf15.ema9 < tf15.ema21 && tf15.close < tf15.ema21) {
      core.push({ n: "EMAs 9/21", v: "Cruce bajista confirmado al cierre", d: "down" }); bear++;
    } else {
      core.push({ n: "EMAs 9/21", v: "Entrelazadas / sin definir", d: "flat" });
    }
  }

  if (ind.rsi) {
    const R = tf15.rsi;
    if (R >= 70) {
      core.push({ n: "RSI 14", v: `${R.toFixed(1)} - sobrecompra (bloquea LARGOS)`, d: "down" });
      bear++; allowLong = false;
    } else if (R <= 30) {
      core.push({ n: "RSI 14", v: `${R.toFixed(1)} - sobreventa (bloquea CORTOS)`, d: "up" });
      bull++; allowShort = false;
    } else if (R > 55) {
      core.push({ n: "RSI 14", v: `${R.toFixed(1)} - momentum alcista`, d: "up" }); bull++;
    } else if (R < 45) {
      core.push({ n: "RSI 14", v: `${R.toFixed(1)} - momentum bajista`, d: "down" }); bear++;
    } else {
      core.push({ n: "RSI 14", v: `${R.toFixed(1)} - zona neutra 45-55, sin voto`, d: "flat" });
    }
  }

  if (ind.macd) {
    if (tf15.macdLine > tf15.macdSignal) {
      core.push({ n: "MACD", v: "Linea sobre senal", d: "up" }); bull++;
    } else {
      core.push({ n: "MACD", v: "Linea bajo senal", d: "down" }); bear++;
    }
  }

  if (ind.boll) {
    if (tf15.close >= tf15.bbUpper) {
      core.push({ n: "Bollinger", v: "Cierre sobre banda superior - sobreextension (frena LARGOS)", d: "down" });
      bear++; allowLong = false;
    } else if (tf15.close <= tf15.bbLower) {
      core.push({ n: "Bollinger", v: "Cierre bajo banda inferior - sobreextension (frena CORTOS)", d: "up" });
      bull++; allowShort = false;
    } else if (tf15.bbWidth < 3) {
      core.push({ n: "Bollinger", v: `Squeeze (${tf15.bbWidth.toFixed(1)}%) - expansion proxima, sin voto`, d: "flat" });
    } else if (tf15.close > tf15.bbMid) {
      core.push({ n: "Bollinger", v: "Sobre la banda media - sesgo alcista", d: "up" }); bull++;
    } else {
      core.push({ n: "Bollinger", v: "Bajo la banda media - sesgo bajista", d: "down" }); bear++;
    }
  }

  const nEnabled = ["emas", "rsi", "macd", "boll"].filter((k) => ind[k]).length;

  // Contexto informativo (no vota)
  if (tf15.volRatio > 1.5) {
    contexto.push({
      n: "Volumen",
      v: `${tf15.volRatio.toFixed(2)}x la media en vela ${tf15.candleDir > 0 ? "alcista" : tf15.candleDir < 0 ? "bajista" : "doji"}`,
      d: tf15.candleDir > 0 ? "up" : tf15.candleDir < 0 ? "down" : "flat",
    });
  } else if (tf15.volRatio < 0.6) {
    contexto.push({ n: "Volumen", v: `${tf15.volRatio.toFixed(2)}x - seco; cualquier ruptura es sospechosa`, d: "flat" });
  } else {
    contexto.push({ n: "Volumen", v: `${tf15.volRatio.toFixed(2)}x la media - normal`, d: "flat" });
  }
  if (tf15.delta10 != null) {
    const dL = tf15.deltaLast * 100, d10 = tf15.delta10 * 100;
    contexto.push({
      n: "Delta ejec.",
      v: `${dL.toFixed(0)}% compra ultima vela · ${d10.toFixed(0)}% en 10 velas (volumen ejecutado, no fingible)`,
      d: tf15.delta10 > 0.55 ? "up" : tf15.delta10 < 0.45 ? "down" : "flat",
    });
  }
  const distSup = ((live - tf15.support) / live) * 100;
  const distRes = ((tf15.resistance - live) / live) * 100;
  contexto.push({
    n: "Sop/Res",
    v: `Soporte ${fmt(tf15.support)} (${distSup.toFixed(1)}%) · Resistencia ${fmt(tf15.resistance)} (${distRes.toFixed(1)}%)`,
    d: "flat",
  });

  let signal = "SIN OPERAR", dir = null, invalidation = "", blockedDir = null;
  const needed = Math.max(1, Math.ceil((nEnabled * 2) / 3));

  if (nEnabled === 0) {
    invalidation = "Activa al menos un indicador para generar senales.";
  } else if (bull >= needed && bull > bear) {
    const razones = [];
    if (!allowLong) razones.push("hay sobrecompra/sobreextension (entrar aqui es perseguir)");
    if (bias === "BAJISTA") razones.push("el sesgo 4h/1h es BAJISTA (contra la tendencia mayor)");
    if (razones.length && strict) {
      blockedDir = "long";
      invalidation = `Confluencia alcista (${bull} de ${nEnabled} votos) pero ${razones.join(" y ")}.`;
    } else {
      razones.forEach((r) => warnings.push(`Advertencia: ${r}.`));
      signal = "LARGO"; dir = "long";
    }
  } else if (bear >= needed && bear > bull) {
    const razones = [];
    if (!allowShort) razones.push("hay sobreventa/sobreextension (vender la capitulacion es mal negocio)");
    if (bias === "ALCISTA") razones.push("el sesgo 4h/1h es ALCISTA (contra la tendencia mayor)");
    if (razones.length && strict) {
      blockedDir = "short";
      invalidation = `Confluencia bajista (${bear} de ${nEnabled} votos) pero ${razones.join(" y ")}.`;
    } else {
      razones.forEach((r) => warnings.push(`Advertencia: ${r}.`));
      signal = "CORTO"; dir = "short";
    }
  }

  const A = tf15.atr || live * 0.01;
  const extATR = tf15.atr ? (live - tf15.ema21) / tf15.atr : 0;
  if (dir === "long" && extATR > 3) {
    const msg = `Sobreextendido: ${extATR.toFixed(1)} ATR sobre la EMA21. El movimiento ya corrio; lo sano es esperar retroceso hacia EMA9/21.`;
    if (strict) { signal = "SIN OPERAR"; dir = null; blockedDir = "long"; invalidation = msg; }
    else warnings.push(msg);
  }
  if (dir === "short" && extATR < -3) {
    const msg = `Sobreextendido a la baja: ${Math.abs(extATR).toFixed(1)} ATR bajo la EMA21. Lo sano es esperar el rebote tecnico antes de vender.`;
    if (strict) { signal = "SIN OPERAR"; dir = null; blockedDir = "short"; invalidation = msg; }
    else warnings.push(msg);
  }

  let levels = {};
  if (dir === "long") {
    levels = buildLevels("long", live, A, Math.min(live - 1.8 * A, tf15.support * 0.998), tf15, tf1h, strict);
  } else if (dir === "short") {
    levels = buildLevels("short", live, A, Math.max(live + 1.8 * A, tf15.resistance * 1.002), tf15, tf1h, strict);
  }
  if (levels.blocked) {
    blockedDir = dir; signal = "SIN OPERAR"; dir = null;
    invalidation = levels.reason;
    levels = { roomR: levels.roomR, ceiling: levels.ceiling };
  } else if (levels.warning) {
    warnings.push(levels.warning);
  }

  let confidence = "-";
  if (dir) {
    const ratio = (dir === "long" ? bull : bear) / nEnabled;
    confidence = ratio >= 1 ? "ALTA" : ratio >= 0.75 ? "MEDIA" : "BAJA";
    if (warnings.length >= 2) confidence = "BAJA";
    else if (warnings.length === 1 && confidence === "ALTA") confidence = "MEDIA";
  }

  return {
    modo: "indicadores", bias, signal, dir, tipo: "confluencia", confidence,
    core, contexto, bull, bear, nEnabled, needed, warnings, blockedDir, riskMode,
    entry: levels.entry ?? null, zone: levels.zone ?? null, stop: levels.stop ?? null,
    tps: levels.tps ?? [], roomR: levels.roomR ?? null, ceiling: levels.ceiling ?? null,
    maxLev: levels.maxLev ?? null,
    invalidation: dir ? levels.invalidation : invalidation,
    atrVal: A, extATR,
  };
}

/* ---------- ESTRATEGIA 2: ESTRUCTURA (BOS / CHoCH) ---------- */
export function buildStructureSignal(c15, tf15, c1h, tf1h, live, riskMode) {
  const strict = riskMode !== "flexible";
  const st = structureEngine(c15);
  const st1h = structureEngine(c1h);
  const bias = st1h.trend === 1 ? "ALCISTA" : st1h.trend === -1 ? "BAJISTA" : "RANGO";
  const A = tf15.atr || live * 0.01;
  const extATR = tf15.atr ? (live - tf15.ema21) / tf15.atr : 0;
  const warnings = [];

  const lastEv = st.events.length ? st.events[st.events.length - 1] : null;
  const age = lastEv ? st.n - 1 - lastEv.t : null;
  const RECENT = 12; // ~3 horas en 15m

  let signal = "SIN OPERAR", dir = null, confidence = "-", invalidation = "", blockedDir = null;

  if (!lastEv) {
    invalidation = "Sin eventos de estructura (BOS/CHoCH) en las velas analizadas.";
  } else if (age > RECENT) {
    invalidation = `Ultimo evento: ${lastEv.type} en ${fmt(lastEv.level)} hace ${age} velas - ya no es accionable. Esperar un nuevo BOS o CHoCH.`;
  } else if (lastEv.dir === "up") {
    const isBos = lastEv.type.startsWith("BOS");
    if (isBos && st1h.trend === -1 && strict) {
      blockedDir = "long";
      invalidation = `BOS alcista en el gatillo (hace ${age} velas) pero la estructura media sigue bajista: ruptura contra la tendencia mayor. Mejor esperar CHoCH tambien alli.`;
    } else {
      if (isBos && st1h.trend === -1) warnings.push("Advertencia: BOS alcista contra la estructura bajista de 1h.");
      signal = "LARGO"; dir = "long";
      confidence = isBos ? (st1h.trend === 1 ? "ALTA" : "MEDIA") : (st1h.trend === -1 ? "BAJA" : "MEDIA");
    }
  } else {
    const isBos = lastEv.type.startsWith("BOS");
    if (isBos && st1h.trend === 1 && strict) {
      blockedDir = "short";
      invalidation = `BOS bajista en el gatillo (hace ${age} velas) pero la estructura media sigue alcista: ruptura contra la tendencia mayor. Mejor esperar CHoCH tambien alli.`;
    } else {
      if (isBos && st1h.trend === 1) warnings.push("Advertencia: BOS bajista contra la estructura alcista de 1h.");
      signal = "CORTO"; dir = "short";
      confidence = isBos ? (st1h.trend === -1 ? "ALTA" : "MEDIA") : (st1h.trend === 1 ? "BAJA" : "MEDIA");
    }
  }

  if (dir === "long" && extATR > 3) {
    const msg = `${lastEv.type} valido pero el precio esta ${extATR.toFixed(1)} ATR sobre la EMA21: perseguir la ruptura aqui es entrar tarde. Lo sano es esperar el retest del nivel ${fmt(lastEv.level)}.`;
    if (strict) { signal = "SIN OPERAR"; dir = null; confidence = "-"; blockedDir = "long"; invalidation = msg; }
    else warnings.push(msg);
  }
  if (dir === "short" && extATR < -3) {
    const msg = `${lastEv.type} valido pero el precio esta ${Math.abs(extATR).toFixed(1)} ATR bajo la EMA21. Lo sano es esperar el retest del nivel ${fmt(lastEv.level)}.`;
    if (strict) { signal = "SIN OPERAR"; dir = null; confidence = "-"; blockedDir = "short"; invalidation = msg; }
    else warnings.push(msg);
  }

  let levels = {};
  if (dir === "long") {
    const swingLow = st.lastL ? st.lastL.price : live - 1.8 * A;
    levels = buildLevels("long", live, A, Math.min(swingLow * 0.998, live - 0.8 * A), tf15, tf1h, strict);
  } else if (dir === "short") {
    const swingHigh = st.lastH ? st.lastH.price : live + 1.8 * A;
    levels = buildLevels("short", live, A, Math.max(swingHigh * 1.002, live + 0.8 * A), tf15, tf1h, strict);
  }
  if (levels.blocked) {
    blockedDir = dir; signal = "SIN OPERAR"; dir = null; confidence = "-";
    invalidation = levels.reason;
    levels = { roomR: levels.roomR, ceiling: levels.ceiling };
  } else if (levels.warning) {
    warnings.push(levels.warning);
  }

  if (dir && warnings.length) {
    if (warnings.length >= 2) confidence = "BAJA";
    else if (confidence === "ALTA") confidence = "MEDIA";
  }

  return {
    modo: "estructura", bias, signal, dir, tipo: "estructura", confidence,
    core: [], contexto: [], bull: 0, bear: 0, warnings, blockedDir, riskMode,
    structure: st, structure1h: st1h,
    lastEvent: lastEv ? { ...lastEv, age } : null,
    entry: levels.entry ?? null, zone: levels.zone ?? null, stop: levels.stop ?? null,
    tps: levels.tps ?? [], roomR: levels.roomR ?? null, ceiling: levels.ceiling ?? null,
    maxLev: levels.maxLev ?? null,
    invalidation: dir ? levels.invalidation : invalidation,
    atrVal: A, extATR,
  };
}

/* ---------- EMPAQUETADO COMUN (sobreextension + niveles + confianza) ---------- */
function packageSignal({
  modo, tipo, bias, dir, confidence, core, contexto = [], warnings = [],
  blockedDir = null, invalidation = "", tf15, tf1h, live, stopPrice, riskMode, extra = {},
}) {
  const strict = riskMode !== "flexible";
  const A = tf15.atr || live * 0.01;
  const extATR = tf15.atr ? (live - tf15.ema21) / tf15.atr : 0;

  if (dir === "long" && extATR > 3) {
    const msg = `Sobreextendido: ${extATR.toFixed(1)} ATR sobre la EMA21. Perseguir aqui es entrar tarde; lo sano es esperar retroceso.`;
    if (strict) { blockedDir = "long"; dir = null; confidence = "-"; invalidation = msg; }
    else warnings.push(msg);
  }
  if (dir === "short" && extATR < -3) {
    const msg = `Sobreextendido a la baja: ${Math.abs(extATR).toFixed(1)} ATR bajo la EMA21. Lo sano es esperar el rebote tecnico.`;
    if (strict) { blockedDir = "short"; dir = null; confidence = "-"; invalidation = msg; }
    else warnings.push(msg);
  }

  let levels = {};
  if (dir && stopPrice != null) {
    levels = buildLevels(dir, live, A, stopPrice, tf15, tf1h, strict);
    if (levels.blocked) {
      blockedDir = dir; dir = null; confidence = "-";
      invalidation = levels.reason;
      levels = { roomR: levels.roomR, ceiling: levels.ceiling };
    } else if (levels.warning) {
      warnings.push(levels.warning);
    }
  } else if (dir) {
    dir = null; confidence = "-";
    invalidation = invalidation || "No se pudo calcular un stop valido para este setup.";
  }

  if (dir && warnings.length) {
    if (warnings.length >= 2) confidence = "BAJA";
    else if (confidence === "ALTA") confidence = "MEDIA";
  }

  return {
    modo, tipo, bias, signal: dir === "long" ? "LARGO" : dir === "short" ? "CORTO" : "SIN OPERAR",
    dir, confidence: dir ? confidence : "-",
    core, contexto, bull: 0, bear: 0, warnings, blockedDir, riskMode,
    entry: levels.entry ?? null, zone: levels.zone ?? null, stop: levels.stop ?? null,
    tps: levels.tps ?? [], roomR: levels.roomR ?? null, ceiling: levels.ceiling ?? null,
    maxLev: levels.maxLev ?? null,
    invalidation: dir ? levels.invalidation : invalidation,
    atrVal: A, extATR, ...extra,
  };
}

const emaBias = (tf1h, tf4h) => {
  const tfScore = (t) =>
    t.ema50 && t.ema200
      ? t.close > t.ema50 && t.ema50 > t.ema200 ? 1
        : t.close < t.ema50 && t.ema50 < t.ema200 ? -1 : 0
      : 0;
  const s = 2 * tfScore(tf4h) + tfScore(tf1h);
  return s >= 2 ? "ALCISTA" : s <= -2 ? "BAJISTA" : "RANGO";
};

/* ---------- ESTRATEGIA 3: ICHIMOKU KINKO HYO (tendencia) ---------- */
export function buildIchimokuSignal(c15, tf15, tf1h, tf4h, live, riskMode) {
  const highs = c15.map((c) => c.high), lows = c15.map((c) => c.low), closes = c15.map((c) => c.close);
  const n = closes.length;
  const base = { modo: "ichimoku", tipo: "tendencia", bias: emaBias(tf1h, tf4h), tf15, tf1h, live, riskMode };
  if (n < 80) {
    return packageSignal({ ...base, dir: null, core: [], invalidation: "Historia insuficiente para Ichimoku (se requieren 78+ velas)." });
  }
  const I = ichimoku(highs, lows, closes);
  const i = n - 1;
  const cloudA = I.spanA[i - 26], cloudB = I.spanB[i - 26]; // nube ACTUAL
  const core = [];
  if (cloudA == null || cloudB == null || I.tenkan[i] == null || I.kijun[i] == null) {
    return packageSignal({ ...base, dir: null, core, invalidation: "Ichimoku sin datos suficientes." });
  }
  const cloudTop = Math.max(cloudA, cloudB), cloudBot = Math.min(cloudA, cloudB);
  const px = closes[i];
  const aboveKumo = px > cloudTop, belowKumo = px < cloudBot;
  const tkBull = I.tenkan[i] > I.kijun[i];
  const chikouBull = px > closes[i - 26];
  const futureBull = I.spanA[i] > I.spanB[i];

  core.push({
    n: "Kumo",
    v: aboveKumo ? `Precio SOBRE la nube (${fmt(cloudBot)} - ${fmt(cloudTop)})`
      : belowKumo ? `Precio BAJO la nube (${fmt(cloudBot)} - ${fmt(cloudTop)})`
      : "Precio DENTRO de la nube - los cruces aqui se ignoran",
    d: aboveKumo ? "up" : belowKumo ? "down" : "flat",
  });
  core.push({ n: "Tenkan/Kijun", v: tkBull ? `Cruce TK alcista (${fmt(I.tenkan[i])} > ${fmt(I.kijun[i])})` : `Cruce TK bajista (${fmt(I.tenkan[i])} < ${fmt(I.kijun[i])})`, d: tkBull ? "up" : "down" });
  core.push({ n: "Chikou", v: chikouBull ? "Chikou sobre el precio de hace 26 velas" : "Chikou bajo el precio de hace 26 velas", d: chikouBull ? "up" : "down" });
  core.push({ n: "Nube futura", v: futureBull ? "Alcista (Span A > Span B): viento a favor de largos" : "Bajista (Span A < Span B): viento a favor de cortos", d: futureBull ? "up" : "down" });

  let dir = null, confidence = "-", invalidation = "", stopPrice = null;
  if (aboveKumo && tkBull && chikouBull) {
    dir = "long"; confidence = futureBull ? "ALTA" : "MEDIA";
    stopPrice = Math.min(I.kijun[i], cloudBot) * 0.999; // stop en Kijun o lado opuesto de la nube
  } else if (belowKumo && !tkBull && !chikouBull) {
    dir = "short"; confidence = !futureBull ? "ALTA" : "MEDIA";
    stopPrice = Math.max(I.kijun[i], cloudTop) * 1.001;
  } else {
    invalidation = "Sin triple confirmacion Ichimoku: se exige precio fuera del Kumo + cruce TK a favor + Chikou libre. Regla innegociable: dentro de la nube no se opera.";
  }
  return packageSignal({ ...base, dir, confidence, core, invalidation, stopPrice, extra: { ichimoku: { tenkan: I.tenkan[i], kijun: I.kijun[i], cloudTop, cloudBot } } });
}

/* ---------- ESTRATEGIA 4: KELTNER + CCI (reversion a la media) ---------- */
export function buildKeltnerSignal(c15, tf15, tf1h, tf4h, live, riskMode) {
  const strict = riskMode !== "flexible";
  const highs = c15.map((c) => c.high), lows = c15.map((c) => c.low), closes = c15.map((c) => c.close);
  const n = closes.length;
  const base = { modo: "keltner", tipo: "reversion", bias: emaBias(tf1h, tf4h), tf15, tf1h, live, riskMode };
  if (n < 70) return packageSignal({ ...base, dir: null, core: [], invalidation: "Historia insuficiente para Keltner 50." });

  const mid = ema(closes, 50);
  const a = atr(highs, lows, closes, 20);
  const i = n - 1;
  if (mid[i] == null || a[i] == null) return packageSignal({ ...base, dir: null, core: [], invalidation: "Keltner sin datos suficientes." });
  const lo39 = mid[i] - 3.9 * a[i], up39 = mid[i] + 3.9 * a[i];
  const lo27 = mid[i] - 2.7 * a[i], up27 = mid[i] + 2.7 * a[i];
  const cciArr = cci(highs, lows, closes, 14);
  const { adx } = adxDmi(highs, lows, closes, 14);
  const adxNow = last(adx);
  const core = [], warnings = [];

  // ¿hubo extremo reciente? (ultimas 8 velas tocaron la banda 3.9)
  let brokeLow = false, brokeHigh = false;
  for (let j = Math.max(0, i - 8); j <= i; j++) {
    if (mid[j] != null && a[j] != null) {
      if (lows[j] < mid[j] - 3.9 * a[j]) brokeLow = true;
      if (highs[j] > mid[j] + 3.9 * a[j]) brokeHigh = true;
    }
  }
  const px = closes[i];
  const reenterLong = brokeLow && px > lo27;
  const reenterShort = brokeHigh && px < up27;
  const cciUp = cciArr[i] != null && cciArr[i] > -40 && (cciArr[i - 1] ?? 0) <= -40;
  const cciDown = cciArr[i] != null && cciArr[i] < 40 && (cciArr[i - 1] ?? 0) >= 40;

  core.push({ n: "Banda 3.9", v: brokeLow ? "Extremo de sobreventa tocado (ultimas 8 velas)" : brokeHigh ? "Extremo de sobrecompra tocado (ultimas 8 velas)" : "Sin extremo reciente: no hay resorte que operar", d: brokeLow ? "up" : brokeHigh ? "down" : "flat" });
  core.push({ n: "Re-entrada 2.7", v: reenterLong ? `Cierre de vuelta sobre ${fmt(lo27)}` : reenterShort ? `Cierre de vuelta bajo ${fmt(up27)}` : "Sin re-entrada confirmada al canal", d: reenterLong ? "up" : reenterShort ? "down" : "flat" });
  core.push({ n: "CCI 14", v: cciArr[i] != null ? `${cciArr[i].toFixed(0)}${cciUp ? " - cruzo -40 al alza (gatillo largo)" : cciDown ? " - cruzo +40 a la baja (gatillo corto)" : " - sin cruce de gatillo"}` : "sin datos", d: cciUp ? "up" : cciDown ? "down" : "flat" });
  core.push({ n: "ADX regimen", v: adxNow != null ? `${adxNow.toFixed(0)} - ${adxNow < 25 ? "rango/tendencia debil: apto para reversion" : "TENDENCIA FUERTE: la reversion es peligrosa"}` : "sin datos", d: adxNow != null && adxNow < 25 ? "up" : "down" });

  let dir = null, confidence = "-", invalidation = "", blockedDir = null, stopPrice = null;
  if (reenterLong && cciUp) { dir = "long"; stopPrice = lo39 * 0.999; }
  else if (reenterShort && cciDown) { dir = "short"; stopPrice = up39 * 1.001; }
  else invalidation = "Sin setup de reversion: se exige extremo en la banda 3.9 + re-entrada sobre/bajo la 2.7 + cruce del CCI en ±40.";

  if (dir && adxNow != null && adxNow >= 30) {
    const msg = `ADX en ${adxNow.toFixed(0)}: hay tendencia fuerte y comprar/vender contra ella (reversion) es ir contra un tren en marcha.`;
    if (strict) { blockedDir = dir; dir = null; invalidation = msg; }
    else warnings.push(msg);
  }
  if (dir) confidence = adxNow != null && adxNow < 20 ? "ALTA" : "MEDIA";
  return packageSignal({ ...base, dir, confidence, core, warnings, blockedDir, invalidation, stopPrice });
}

/* ---------- ESTRATEGIA 5: DONCHIAN / TURTLE SYSTEM 2 + ADX (ruptura) ---------- */
export function buildDonchianSignal(c15, tf15, tf1h, tf4h, live, riskMode) {
  const strict = riskMode !== "flexible";
  const highs = c15.map((c) => c.high), lows = c15.map((c) => c.low), closes = c15.map((c) => c.close);
  const n = closes.length;
  const base = { modo: "donchian", tipo: "ruptura", bias: emaBias(tf1h, tf4h), tf15, tf1h, live, riskMode };
  if (n < 90) return packageSignal({ ...base, dir: null, core: [], invalidation: "Historia insuficiente para Donchian 55." });

  const d55 = donchian(highs, lows, 55);
  const d20 = donchian(highs, lows, 20);
  const { adx, plusDI, minusDI } = adxDmi(highs, lows, closes, 14);
  const i = n - 1;
  const adxNow = adx[i], pdi = plusDI[i], mdi = minusDI[i];
  const A = tf15.atr || live * 0.01;
  const core = [], warnings = [];

  const breakUp = d55.up[i] != null && closes[i] > d55.up[i];
  const breakDown = d55.lo[i] != null && closes[i] < d55.lo[i];
  const adxOk = adxNow != null && adxNow > 25;

  core.push({ n: "Donchian 55", v: breakUp ? `CIERRE sobre el maximo de 55 velas (${fmt(d55.up[i])})` : breakDown ? `CIERRE bajo el minimo de 55 velas (${fmt(d55.lo[i])})` : `Dentro del canal ${fmt(d55.lo[i])} - ${fmt(d55.up[i])}: sin ruptura`, d: breakUp ? "up" : breakDown ? "down" : "flat" });
  core.push({ n: "ADX 14", v: adxNow != null ? `${adxNow.toFixed(0)} - ${adxOk ? "tendencia real confirmada (>25)" : "sin tendencia suficiente (<25): ruptura sospechosa"}` : "sin datos", d: adxOk ? "up" : "flat" });
  core.push({ n: "DMI", v: pdi != null ? `+DI ${pdi.toFixed(0)} vs -DI ${mdi.toFixed(0)} - ${pdi > mdi ? "dominan compradores" : "dominan vendedores"}` : "sin datos", d: pdi > mdi ? "up" : "down" });
  core.push({ n: "Volumen", v: `${tf15.volRatio.toFixed(2)}x la media - ${tf15.volRatio > 1.5 ? "ruptura con conviccion" : "por debajo del 150% recomendado"}`, d: tf15.volRatio > 1.5 ? "up" : "flat" });

  let dir = null, confidence = "-", invalidation = "", blockedDir = null, stopPrice = null;
  if (breakUp) {
    if (adxOk && pdi > mdi) { dir = "long"; stopPrice = live - 2 * A; } // stop Turtle: 2N
    else {
      const msg = "Ruptura alcista de 55 pero sin filtro: se exige ADX>25 y +DI>-DI para confirmar tendencia real.";
      if (strict) { blockedDir = "long"; invalidation = msg; } else { dir = "long"; stopPrice = live - 2 * A; warnings.push(msg); }
    }
  } else if (breakDown) {
    if (adxOk && mdi > pdi) { dir = "short"; stopPrice = live + 2 * A; }
    else {
      const msg = "Ruptura bajista de 55 pero sin filtro: se exige ADX>25 y -DI>+DI.";
      if (strict) { blockedDir = "short"; invalidation = msg; } else { dir = "short"; stopPrice = live + 2 * A; warnings.push(msg); }
    }
  } else {
    invalidation = "Sin ruptura del canal de 55 velas. El sistema Turtle espera la ruptura; no anticipa.";
  }
  if (dir && tf15.volRatio < 1.5) warnings.push("Volumen de ruptura por debajo del 150% de la media: desconfiar (regla Turtle moderna).");
  if (dir) confidence = tf15.volRatio > 1.5 ? "ALTA" : "MEDIA";
  const trailing = dir === "long" ? d20.lo[i] : d20.up[i];
  return packageSignal({
    ...base, dir, confidence, core, warnings, blockedDir, invalidation, stopPrice,
    extra: { turtleTrail: trailing != null ? { nivel: trailing, texto: dir === "long" ? "salida Turtle: nuevo minimo de 20 velas" : "salida Turtle: nuevo maximo de 20 velas" } : null },
  });
}

/* ---------- ESTRATEGIA 6: SUPERTREND + ADX/DMI + PARABOLIC SAR (confluencia) ---------- */
export function buildSupertrendSignal(c15, tf15, tf1h, tf4h, live, riskMode) {
  const strict = riskMode !== "flexible";
  const highs = c15.map((c) => c.high), lows = c15.map((c) => c.low), closes = c15.map((c) => c.close);
  const n = closes.length;
  const base = { modo: "supertrend", tipo: "confluencia", bias: emaBias(tf1h, tf4h), tf15, tf1h, live, riskMode };
  if (n < 60) return packageSignal({ ...base, dir: null, core: [], invalidation: "Historia insuficiente para SuperTrend." });

  const st = supertrend(highs, lows, closes, 10, 3);
  const { adx, plusDI, minusDI } = adxDmi(highs, lows, closes, 14);
  const sar = psar(highs, lows, 0.02, 0.2);
  const i = n - 1;
  const stDir = st.dir[i], stLine = st.line[i];
  const adxNow = adx[i], pdi = plusDI[i], mdi = minusDI[i];
  const sarNow = sar[i];
  const core = [], warnings = [];

  let flipAge = null;
  for (let j = i; j > 0 && j > i - 40; j--) {
    if (st.dir[j] !== st.dir[j - 1]) { flipAge = i - j; break; }
  }
  const adxOk = adxNow != null && adxNow > 25;
  const sarBull = sarNow ? sarNow.up : null;

  core.push({ n: "SuperTrend", v: stDir === 1 ? `VERDE - linea en ${fmt(stLine)} bajo el precio${flipAge != null ? ` (viro hace ${flipAge} velas)` : ""}` : `ROJO - linea en ${fmt(stLine)} sobre el precio${flipAge != null ? ` (viro hace ${flipAge} velas)` : ""}`, d: stDir === 1 ? "up" : "down" });
  core.push({ n: "ADX 14", v: adxNow != null ? `${adxNow.toFixed(0)} - ${adxOk ? "tendencia con fuerza (>25)" : adxNow < 20 ? "SIN tendencia (<20): sistema apagado" : "fuerza dudosa (20-25)"}` : "sin datos", d: adxOk ? "up" : "flat" });
  core.push({ n: "DMI", v: pdi != null ? `+DI ${pdi.toFixed(0)} vs -DI ${mdi.toFixed(0)}` : "sin datos", d: pdi > mdi ? "up" : "down" });
  core.push({ n: "Parabolic SAR", v: sarBull == null ? "sin datos" : sarBull ? `Puntos BAJO el precio (${fmt(sarNow.sar)}) - a favor de largos` : `Puntos SOBRE el precio (${fmt(sarNow.sar)}) - a favor de cortos`, d: sarBull == null ? "flat" : sarBull ? "up" : "down" });

  let dir = null, confidence = "-", invalidation = "", blockedDir = null, stopPrice = null;
  if (adxNow != null && adxNow < 20) {
    invalidation = `ADX en ${adxNow.toFixed(0)} (<20): regla de oro del sistema - sin tendencia, se apaga y se espera.`;
  } else if (stDir === 1 && adxOk && pdi > mdi) {
    dir = "long"; stopPrice = Math.min(stLine, sarBull ? sarNow.sar : stLine) * 0.999;
  } else if (stDir === -1 && adxOk && mdi > pdi) {
    dir = "short"; stopPrice = Math.max(stLine, sarBull === false ? sarNow.sar : stLine) * 1.001;
  } else {
    invalidation = "Sin confluencia completa: se exige SuperTrend + ADX>25 + DMI apuntando en la misma direccion.";
  }
  if (dir) {
    const sarAgrees = dir === "long" ? sarBull === true : sarBull === false;
    confidence = sarAgrees ? "ALTA" : "MEDIA";
    if (!sarAgrees) warnings.push("El Parabolic SAR aun no acompana: confluencia incompleta, senal de menor calidad.");
    if (flipAge != null && flipAge > 12) warnings.push(`El SuperTrend viro hace ${flipAge} velas: tendencia madura, parte del movimiento ya paso.`);
  }
  return packageSignal({ ...base, dir, confidence, core, warnings, blockedDir, invalidation, stopPrice });
}

/* ---------- ESTRATEGIA 7: ANCHORED VWAP + CMF + MFI (flujo de dinero) ---------- */
export function buildAvwapSignal(c15, tf15, tf1h, tf4h, live, riskMode) {
  const highs = c15.map((c) => c.high), lows = c15.map((c) => c.low), closes = c15.map((c) => c.close);
  const vols = c15.map((c) => c.volume);
  const n = closes.length;
  const base = { modo: "avwap", tipo: "flujo", bias: emaBias(tf1h, tf4h), tf15, tf1h, live, riskMode };
  if (n < 110) return packageSignal({ ...base, dir: null, core: [], invalidation: "Historia insuficiente para AVWAP." });

  const look = 96;
  let loIdx = n - look, hiIdx = n - look;
  for (let j = n - look; j < n; j++) {
    if (lows[j] < lows[loIdx]) loIdx = j;
    if (highs[j] > highs[hiIdx]) hiIdx = j;
  }
  const avLow = anchoredVWAP(c15, loIdx);   // ancla en el minimo del swing (para largos)
  const avHigh = anchoredVWAP(c15, hiIdx);  // ancla en el maximo del swing (para cortos)
  const i = n - 1;
  const cmfArr = cmf(c15, 20);
  const mfiArr = mfi(highs, lows, closes, vols, 14);
  const cmfNow = cmfArr[i], mfiNow = mfiArr[i];
  const A = tf15.atr || live * 0.01;
  const core = [], warnings = [];

  const avL = avLow[i], avH = avHigh[i];
  const avLRising = avL != null && avLow[i - 8] != null && avL > avLow[i - 8];
  const avHFalling = avH != null && avHigh[i - 8] != null && avH < avHigh[i - 8];
  const px = closes[i];

  core.push({ n: "AVWAP (min)", v: avL != null ? `${fmt(avL)} anclado al minimo del swing - ${px > avL ? "compradores en control desde alli" : "precio por debajo: compradores perdiendo"}${avLRising ? ", ascendente" : ""}` : "sin datos", d: avL != null && px > avL ? "up" : "down" });
  core.push({ n: "AVWAP (max)", v: avH != null ? `${fmt(avH)} anclado al maximo del swing - ${px < avH ? "vendedores en control desde alli" : "precio por encima: vendedores perdiendo"}${avHFalling ? ", descendente" : ""}` : "sin datos", d: avH != null && px < avH ? "down" : "up" });
  core.push({ n: "CMF 20", v: cmfNow != null ? `${cmfNow.toFixed(3)} - ${cmfNow > 0.05 ? "acumulacion institucional (> +0.05)" : cmfNow < -0.05 ? "distribucion institucional (< -0.05)" : "zona neutra ±0.05, sin conviccion"}` : "sin datos", d: cmfNow > 0.05 ? "up" : cmfNow < -0.05 ? "down" : "flat" });
  core.push({ n: "MFI 14", v: mfiNow != null ? `${mfiNow.toFixed(0)} - ${mfiNow > 80 ? "sobrecompra de flujo" : mfiNow < 20 ? "sobreventa de flujo" : "zona media"}` : "sin datos", d: mfiNow > 80 ? "down" : mfiNow < 20 ? "up" : "flat" });

  let dir = null, confidence = "-", invalidation = "", stopPrice = null;
  const distL = avL != null ? (px - avL) / A : null;
  if (avL != null && px > avL && cmfNow != null && cmfNow > 0.05 && (mfiNow == null || mfiNow < 80)) {
    dir = "long";
    stopPrice = Math.min(avL - 0.6 * A, px - 0.8 * A); // bajo el AVWAP (aprox. regla de 2 cierres en contra)
    confidence = avLRising && cmfNow > 0.1 ? "ALTA" : "MEDIA";
    if (distL != null && distL > 2.5) warnings.push(`El precio esta ${distL.toFixed(1)} ATR sobre el AVWAP: Shannon compra el retroceso, no la extension.`);
  } else if (avH != null && px < avH && cmfNow != null && cmfNow < -0.05 && (mfiNow == null || mfiNow > 20)) {
    dir = "short";
    stopPrice = Math.max(avH + 0.6 * A, px + 0.8 * A);
    confidence = avHFalling && cmfNow < -0.1 ? "ALTA" : "MEDIA";
    const distH = (avH - px) / A;
    if (distH > 2.5) warnings.push(`El precio esta ${distH.toFixed(1)} ATR bajo el AVWAP: mejor esperar el rebote hacia el ancla.`);
  } else {
    invalidation = "Sin alineacion de flujo: se exige precio del lado correcto del AVWAP anclado al swing + CMF fuera de la zona neutra (±0.05) + MFI sin extremo en contra.";
  }
  return packageSignal({ ...base, dir, confidence, core, warnings, invalidation, stopPrice, extra: { avwap: { low: avL, high: avH } } });
}

/* ---------- SESGO DE BTC (para el filtro de la META) ---------- */
export function btcBiasSeries(c4h) {
  const closes = c4h.map((c) => c.close);
  const e50 = ema(closes, 50), e200 = ema(closes, 200);
  return c4h.map((c, i) => ({
    time: c.time,
    bias: e50[i] != null && e200[i] != null
      ? closes[i] > e50[i] && e50[i] > e200[i] ? 1
        : closes[i] < e50[i] && e50[i] < e200[i] ? -1 : 0
      : 0,
  }));
}

// Sesgo de la ultima vela de 4h CERRADA antes del instante t.
export function btcBiasAt(series, t) {
  let lo = 0, hi = series.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].time + 14400000 <= t) { ans = series[mid].bias; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/* ---------- ESTRATEGIA META FILTRADA ----------
   Combina las 7 estrategias y solo deja pasar senales que superan los filtros
   validados con el record real del usuario:
   1) filtro BTC (no alt-largos con BTC bajista 4h, ni cortos con BTC alcista);
   2) anti-persecucion (descarta la confianza ALTA-unanime de indicadores: 42% historico);
   3) probabilidad historica >= 55% con n >= 30 (cuando hay funcion de probabilidad);
   4) cortos con doble llave (ademas exigen estructura 1h bajista).
   El 5o filtro (max 2 memes por direccion) se aplica en el escaner, entre simbolos. */
const META_SUBS = ["indicadores", "estructura", "ichimoku", "keltner", "donchian", "supertrend", "avwap"];

export function buildMetaSignal(c15c, t15, c1hc, t1h, t4h, live, ind, riskMode, opts = {}) {
  const { btcBias = null, probFn = null } = opts;
  const bias = emaBias(t1h, t4h);
  const A = t15.atr || live * 0.01;
  const extATR = t15.atr ? (live - t15.ema21) / t15.atr : 0;
  const vacio = (core, invalidation, blockedDir = null) => ({
    modo: "meta", tipo: "meta-filtrada", bias, signal: "SIN OPERAR", dir: null, confidence: "-",
    core, contexto: [], bull: 0, bear: 0, warnings: [], blockedDir, riskMode,
    entry: null, zone: null, stop: null, tps: [], roomR: null, ceiling: null, maxLev: null,
    invalidation, atrVal: A, extATR,
  });

  const candidates = [];
  if (opts.candidates) {
    // Sub-senales ya calculadas por evaluateAll: no repetir el trabajo.
    candidates.push(...opts.candidates);
  } else {
    for (const st of META_SUBS) {
      try {
        const s = buildFor(st, c15c, t15, c1hc, t1h, t4h, live, ind, riskMode);
        if (s.dir) candidates.push({ st, sig: s });
      } catch { /* estrategia sin datos suficientes */ }
    }
  }

  const core = [];
  core.push({
    n: "Candidatas",
    v: candidates.length
      ? candidates.map((c) => `${c.st} ${c.sig.dir === "long" ? "↑" : "↓"}`).join(" · ")
      : "ninguna de las 7 estrategias emite senal ahora",
    d: "flat",
  });
  if (!candidates.length) {
    return vacio(core, "Ninguna estrategia base tiene senal activa. La META no inventa entradas: espera.");
  }

  const dropped = [];
  let pool = [];
  const st1hTrend = structureEngine(c1hc).trend;

  for (const c of candidates) {
    // 2) anti-persecucion: ALTA-unanime de indicadores demostro 42% de aciertos
    if (c.st === "indicadores" && c.sig.confidence === "ALTA") {
      dropped.push(`${c.st} (ALTA-unanime = perseguir: 42% historico)`);
      continue;
    }
    // 1) filtro BTC
    if (btcBias === -1 && c.sig.dir === "long") { dropped.push(`${c.st} largo (BTC bajista 4h arrastra las alts)`); continue; }
    if (btcBias === 1 && c.sig.dir === "short") { dropped.push(`${c.st} corto (BTC alcista 4h)`); continue; }
    // 4) cortos con doble llave
    if (c.sig.dir === "short" && st1hTrend !== -1) { dropped.push(`${c.st} corto (falta la 2a llave: estructura 1h no es bajista)`); continue; }
    // 3) probabilidad historica como portero
    let pr = null;
    if (probFn) {
      try { pr = probFn(c.sig); } catch { pr = null; }
      if (pr && pr.n >= 30 && pr.p < 0.55) { dropped.push(`${c.st} (probabilidad ${(pr.p * 100).toFixed(0)}% < 55% con n=${pr.n})`); continue; }
    }
    pool.push({ ...c, pr });
  }

  core.push({
    n: "Filtro BTC",
    v: btcBias == null ? "Sin dato de BTC: filtro no aplicado esta vez"
      : btcBias === 1 ? "BTC ALCISTA 4h: largos permitidos, cortos vetados"
      : btcBias === -1 ? "BTC BAJISTA 4h: cortos permitidos, largos vetados"
      : "BTC en rango: ambas direcciones permitidas",
    d: btcBias === 1 ? "up" : btcBias === -1 ? "down" : "flat",
  });
  core.push({
    n: "Descartes",
    v: dropped.length ? dropped.join(" · ") : "ninguna candidata descartada por los filtros",
    d: dropped.length ? "flat" : "up",
  });

  if (!pool.length) {
    const dirs = candidates.map((c) => c.sig.dir);
    const majority = dirs.filter((x) => x === "long").length >= dirs.length / 2 ? "long" : "short";
    return vacio(core, `Hubo ${candidates.length} candidata(s) pero ninguna paso los filtros. Eso ES la estrategia: los filtros existen porque esas senales pierden dinero en tu record.`, majority);
  }

  const CONF_ORD = { ALTA: 3, MEDIA: 2, BAJA: 1 };
  pool.sort((a, b) =>
    ((b.pr?.p ?? 0.5) - (a.pr?.p ?? 0.5)) ||
    ((CONF_ORD[b.sig.confidence] ?? 0) - (CONF_ORD[a.sig.confidence] ?? 0))
  );
  const winner = pool[0];
  const consenso = pool.filter((c) => c.sig.dir === winner.sig.dir).length;

  core.push({
    n: "Ganadora",
    v: `${winner.st} ${winner.sig.dir === "long" ? "LARGO" : "CORTO"}${winner.pr ? ` · prob ${(winner.pr.p * 100).toFixed(0)}% (n=${winner.pr.n})` : ""} · consenso: ${consenso} estrategia(s) en la misma direccion`,
    d: winner.sig.dir === "long" ? "up" : "down",
  });

  const warnings = [...(winner.sig.warnings ?? [])];
  if (winner.pr && winner.pr.n < 30) warnings.push(`Probabilidad con muestra insuficiente (n=${winner.pr.n}): el portero de probabilidad no pudo aplicarse. Corre el backtest para alimentarlo.`);
  if (btcBias == null) warnings.push("Sin dato de BTC: el filtro 1 no se aplico en esta evaluacion.");

  let confidence = "BAJA";
  if (consenso >= 2 && winner.pr && winner.pr.p >= 0.6 && winner.pr.n >= 30) confidence = "ALTA";
  else if (consenso >= 2 || (winner.pr && winner.pr.p >= 0.55 && winner.pr.n >= 30)) confidence = "MEDIA";

  return {
    ...winner.sig,
    modo: "meta", tipo: "meta-filtrada", bias, confidence,
    core, contexto: [], warnings, blockedDir: null, riskMode,
    metaFuente: winner.st, metaConsenso: consenso,
    metaProb: winner.pr ? { p: winner.pr.p, n: winner.pr.n } : null,
  };
}

/* ---------- EVALUACION UNIFICADA ---------- */
export const STRATEGIES = [
  ["meta", "META FILTRADA"],
  ["indicadores", "INDICADORES"],
  ["estructura", "ESTRUCTURA"],
  ["ichimoku", "ICHIMOKU"],
  ["keltner", "KELTNER+CCI"],
  ["donchian", "DONCHIAN 55"],
  ["supertrend", "SUPERTREND"],
  ["avwap", "AVWAP FLUJO"],
  ["patrones", "PATRONES 🧠"],
];
export const STRATEGY_KEYS = STRATEGIES.map(([k]) => k);

function buildFor(strategy, c15c, t15, c1hc, t1h, t4h, live, ind, riskMode, opts = {}) {
  switch (strategy) {
    case "meta": return buildMetaSignal(c15c, t15, c1hc, t1h, t4h, live, ind, riskMode, opts);
    case "estructura": return buildStructureSignal(c15c, t15, c1hc, t1h, live, riskMode);
    case "ichimoku": return buildIchimokuSignal(c15c, t15, t1h, t4h, live, riskMode);
    case "keltner": return buildKeltnerSignal(c15c, t15, t1h, t4h, live, riskMode);
    case "donchian": return buildDonchianSignal(c15c, t15, t1h, t4h, live, riskMode);
    case "supertrend": return buildSupertrendSignal(c15c, t15, t1h, t4h, live, riskMode);
    case "avwap": return buildAvwapSignal(c15c, t15, t1h, t4h, live, riskMode);
    case "patrones": return buildPatternSignal(c15c, t15, t1h, t4h, live, riskMode, opts);
    default: return buildIndicatorSignal(t15, t1h, t4h, live, ind, riskMode);
  }
}

// Corre la estrategia activa sobre velas ya descargadas. `c15/c1h/c4h` incluyen
// la vela en formacion; se analiza sobre velas cerradas y `live` es el ultimo precio.
// opts: { btcBias: -1|0|1|null, probFn: (sig)=>({p,n})|null } para la META.
export function evaluate(c15, c1h, c4h, live, strategy, ind, riskMode, opts = {}) {
  const closed = (arr) => arr.slice(0, -1);
  const c15c = closed(c15), c1hc = closed(c1h);
  const t15 = analyzeTF(c15c);
  const t1h = analyzeTF(c1hc);
  const t4h = analyzeTF(closed(c4h));
  const sig = buildFor(strategy, c15c, t15, c1hc, t1h, t4h, live, ind, riskMode, opts);
  return { tf15: t15, tf1h: t1h, tf4h: t4h, tf: opts.tfLabel ?? "15m", ...sig };
}

// Corre TODAS las estrategias sobre las mismas velas: los analisis TF se computan
// una sola vez y la META reutiliza las sub-senales en vez de recalcularlas.
export function evaluateAll(c15, c1h, c4h, live, ind, riskMode, opts = {}) {
  const closed = (arr) => arr.slice(0, -1);
  const c15c = closed(c15), c1hc = closed(c1h);
  const t15 = analyzeTF(c15c);
  const t1h = analyzeTF(c1hc);
  const t4h = analyzeTF(closed(c4h));
  const base = { tf15: t15, tf1h: t1h, tf4h: t4h, tf: opts.tfLabel ?? "15m" };
  const results = [];
  const candidates = [];
  // `skip` evita computar estrategias que el llamante va a descartar igual (el detector de
  // patrones es el mas caro: reconstruye su contexto entero en cada ventana).
  const skip = new Set(opts.skip ?? []);
  for (const k of STRATEGY_KEYS) {
    if (k === "meta" || skip.has(k)) continue;
    try {
      const s = buildFor(k, c15c, t15, c1hc, t1h, t4h, live, ind, riskMode, opts);
      results.push({ strategy: k, sig: { ...base, ...s } });
      if (s.dir) candidates.push({ st: k, sig: s });
    } catch { /* sin datos */ }
  }
  try {
    const m = buildMetaSignal(c15c, t15, c1hc, t1h, t4h, live, ind, riskMode, { ...opts, candidates });
    results.unshift({ strategy: "meta", sig: { ...base, ...m } });
  } catch { /* sin datos */ }
  return results;
}

/* ---------- FEATURES PARA EL MOTOR DE PROBABILIDAD ---------- */
export const SUBCAT_KEYS = ["memes", "defi", "l1", "l2", "ia", "gaming", "exchange", "otras"];

// Estrategias one-hot ("indicadores" es la base implicita: todas en 0).
const STRAT_FEATURES = ["estructura", "ichimoku", "keltner", "donchian", "supertrend", "avwap", "meta"];

export const FEATURE_NAMES = [
  "sesgo", // bias
  ...STRAT_FEATURES.map((k) => `estrategia:${k}`),
  "dir:corto",
  "conf:alta", "conf:baja",
  "rsi", "volumen", "extension",
  "evento:bos", "evento:choch",
  "advertencias",
  ...SUBCAT_KEYS.map((k) => `subcat:${k}`),
  "hora:sin", "hora:cos",
];

// Vector numerico (mismo orden que FEATURE_NAMES) a partir de una senal evaluada.
export function extractFeatures(sig, subcat, ts) {
  const x = [];
  const biasAligned =
    (sig.dir === "long" && sig.bias === "ALCISTA") || (sig.dir === "short" && sig.bias === "BAJISTA") ? 1
      : (sig.dir === "long" && sig.bias === "BAJISTA") || (sig.dir === "short" && sig.bias === "ALCISTA") ? -1 : 0;
  x.push(biasAligned);
  for (const k of STRAT_FEATURES) x.push(sig.modo === k ? 1 : 0);
  x.push(sig.dir === "short" ? 1 : 0);
  x.push(sig.confidence === "ALTA" ? 1 : 0);
  x.push(sig.confidence === "BAJA" ? 1 : 0);
  x.push(sig.tf15?.rsi != null ? (sig.tf15.rsi - 50) / 50 : 0);
  x.push(Math.min(3, sig.tf15?.volRatio ?? 1) - 1);
  x.push(Math.max(-4, Math.min(4, sig.extATR ?? 0)) / 4);
  const evType = sig.lastEvent?.type ?? "";
  x.push(evType.startsWith("BOS") ? 1 : 0);
  x.push(evType.startsWith("CHoCH") ? 1 : 0);
  x.push(Math.min(3, sig.warnings?.length ?? 0));
  for (const k of SUBCAT_KEYS) x.push(subcat === k ? 1 : 0);
  const hour = new Date(ts).getUTCHours();
  x.push(Math.sin((2 * Math.PI * hour) / 24));
  x.push(Math.cos((2 * Math.PI * hour) / 24));
  return x;
}

// Claves de segmento para los buckets bayesianos (el "por que" explicable).
export function segmentKeys(sig, subcat) {
  const d = sig.dir === "short" ? "corto" : "largo";
  const tf = sig.tf ?? "15m";
  return [
    "global",
    `estrategia:${sig.modo}`,
    `estrategia:${sig.modo}|dir:${d}`,
    `estrategia:${sig.modo}|tf:${tf}`,
    `estrategia:${sig.modo}|dir:${d}|tf:${tf}`,
    `conf:${sig.confidence}`,
    `subcat:${subcat}`,
    `tf:${tf}`,
  ];
}
