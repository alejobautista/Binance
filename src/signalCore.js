/* Motor de senales puro (sin React): indicadores, estructura, niveles y evaluacion.
   Reutilizado por la UI, el Top 3 del escaner y el backtest. */

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
  }));
}

// Descarga historico encadenando peticiones de 1000 velas desde startTime hasta hoy.
export async function fetchHistory(sym, interval, startTime) {
  const out = [];
  let cursor = startTime;
  for (let guard = 0; guard < 40; guard++) {
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

  return {
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
      invalidation: `Cierre 15m bajo ${fmt(stop)} anula el setup.`,
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
    invalidation: `Cierre 15m sobre ${fmt(stop)} anula el setup.`,
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
    invalidation = `Ultimo evento: ${lastEv.type} en ${fmt(lastEv.level)} hace ${age} velas de 15m - ya no es accionable. Esperar un nuevo BOS o CHoCH.`;
  } else if (lastEv.dir === "up") {
    const isBos = lastEv.type.startsWith("BOS");
    if (isBos && st1h.trend === -1 && strict) {
      blockedDir = "long";
      invalidation = `BOS alcista en 15m (hace ${age} velas) pero la estructura 1h sigue bajista: ruptura contra la tendencia mayor. Mejor esperar CHoCH tambien en 1h.`;
    } else {
      if (isBos && st1h.trend === -1) warnings.push("Advertencia: BOS alcista contra la estructura bajista de 1h.");
      signal = "LARGO"; dir = "long";
      confidence = isBos ? (st1h.trend === 1 ? "ALTA" : "MEDIA") : (st1h.trend === -1 ? "BAJA" : "MEDIA");
    }
  } else {
    const isBos = lastEv.type.startsWith("BOS");
    if (isBos && st1h.trend === 1 && strict) {
      blockedDir = "short";
      invalidation = `BOS bajista en 15m (hace ${age} velas) pero la estructura 1h sigue alcista: ruptura contra la tendencia mayor. Mejor esperar CHoCH tambien en 1h.`;
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

/* ---------- EVALUACION UNIFICADA ---------- */
// Corre la estrategia activa sobre velas ya descargadas. `c15/c1h/c4h` incluyen
// la vela en formacion; se analiza sobre velas cerradas y `live` es el ultimo precio.
export function evaluate(c15, c1h, c4h, live, strategy, ind, riskMode) {
  const closed = (arr) => arr.slice(0, -1);
  const c15c = closed(c15), c1hc = closed(c1h);
  const t15 = analyzeTF(c15c);
  const t1h = analyzeTF(c1hc);
  const t4h = analyzeTF(closed(c4h));
  const sig = strategy === "estructura"
    ? buildStructureSignal(c15c, t15, c1hc, t1h, live, riskMode)
    : buildIndicatorSignal(t15, t1h, t4h, live, ind, riskMode);
  return { tf15: t15, tf1h: t1h, tf4h: t4h, ...sig };
}

/* ---------- FEATURES PARA EL MOTOR DE PROBABILIDAD ---------- */
export const SUBCAT_KEYS = ["memes", "defi", "l1", "l2", "ia", "gaming", "exchange", "otras"];

export const FEATURE_NAMES = [
  "sesgo", // bias
  "estrategia:estructura", "dir:corto",
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
  x.push(sig.modo === "estructura" ? 1 : 0);
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
  return [
    "global",
    `estrategia:${sig.modo}`,
    `estrategia:${sig.modo}|dir:${d}`,
    `conf:${sig.confidence}`,
    `subcat:${subcat}`,
  ];
}
