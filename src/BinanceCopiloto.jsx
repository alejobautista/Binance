import React, { useState, useEffect, useMemo, useCallback } from "react";

const BASES = [
  "https://api.binance.com/api/v3",
  "https://data-api.binance.vision/api/v3",
];

async function fetchJson(path) {
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

const fmt = (n) => {
  if (n == null || isNaN(n)) return "-";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
};

/* ---------- INDICADORES ---------- */
const ema = (data, period) => {
  if (!data || data.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(data.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  out[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) out[i] = data[i] * k + out[i - 1] * (1 - k);
  return out;
};

const sma = (data, period) => {
  const out = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += data[j];
    out[i] = s / period;
  }
  return out;
};

const rsi = (closes, period = 14) => {
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

const macd = (closes, fast = 12, slow = 26, sig = 9) => {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const valid = line.filter((v) => v != null);
  const sl = ema(valid, sig);
  const offset = line.length - valid.length;
  const signal = new Array(line.length).fill(null);
  sl.forEach((v, i) => { if (v != null) signal[i + offset] = v; });
  return { line, signal };
};

const atr = (highs, lows, closes, period = 14) => {
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

const obv = (closes, volumes) => {
  const out = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) out.push(out[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) out.push(out[i - 1] - volumes[i]);
    else out.push(out[i - 1]);
  }
  return out;
};

const stochRsi = (closes, rsiP = 14, stochP = 14, kP = 3, dP = 3) => {
  const r = rsi(closes, rsiP);
  const raw = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (r[i] == null) continue;
    const win = [];
    for (let j = Math.max(0, i - stochP + 1); j <= i; j++) if (r[j] != null) win.push(r[j]);
    if (win.length < stochP) continue;
    const mn = Math.min(...win), mx = Math.max(...win);
    raw[i] = mx === mn ? 50 : ((r[i] - mn) / (mx - mn)) * 100;
  }
  const avg = (arr, i, n) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) if (arr[j] != null) { s += arr[j]; c++; }
    return c === n ? s / c : null;
  };
  const kLine = raw.map((v, i) => (v == null ? null : avg(raw, i, kP)));
  const dLine = kLine.map((v, i) => (v == null ? null : avg(kLine, i, dP)));
  return { k: kLine, d: dLine };
};

const bollinger = (closes, period = 20, mult = 2) => {
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

const swingLevels = (highs, lows, lookback = 60) => {
  const hi = Math.max(...highs.slice(-lookback));
  const lo = Math.min(...lows.slice(-lookback));
  const range = hi - lo;
  return {
    hi, lo,
    fib: {
      "0.236": hi - range * 0.236,
      "0.382": hi - range * 0.382,
      "0.5": hi - range * 0.5,
      "0.618": hi - range * 0.618,
      "0.786": hi - range * 0.786,
    },
  };
};

const last = (arr) => {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
};

/* ---------- ANALISIS POR TIMEFRAME ---------- */
function analyzeTF(candles) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume);
  const n = closes.length;

  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const r = rsi(closes, 14), m = macd(closes), a = atr(highs, lows, closes, 14);
  const o = obv(closes, vols), sr = stochRsi(closes), bb = bollinger(closes);

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
    obvSlope: o.length > 10 ? o[o.length - 1] - o[o.length - 10] : 0,
    stochK: last(sr.k), stochD: last(sr.d),
    bbUpper: last(bb.upper), bbLower: last(bb.lower), bbWidth: last(bb.width),
    volRatio: volAvg > 0 ? vols[n - 1] / volAvg : 1,
    swing: swingLevels(highs, lows),
    support: Math.min(...srLows),
    resistance: Math.max(...srHighs),
  };
}

/* ---------- MOTOR DE SENAL ---------- */
function buildSignal(tf15, tf1h, tf4h, live) {
  const core = [];
  let bull = 0, bear = 0;
  let allowLong = true, allowShort = true;
  let revFlag = false, momFlag = false;

  const tfScore = (t) =>
    t.ema50 && t.ema200
      ? t.close > t.ema50 && t.ema50 > t.ema200 ? 1
        : t.close < t.ema50 && t.ema50 < t.ema200 ? -1 : 0
      : 0;
  const biasScore = 2 * tfScore(tf4h) + tfScore(tf1h);
  const bias = biasScore >= 2 ? "ALCISTA" : biasScore <= -2 ? "BAJISTA" : "RANGO";

  if (tf15.ema9 > tf15.ema21 && tf15.close > tf15.ema21) {
    core.push({ n: "EMA 9/21", v: "Cruce alcista confirmado al cierre", d: "up" }); bull++;
  } else if (tf15.ema9 < tf15.ema21 && tf15.close < tf15.ema21) {
    core.push({ n: "EMA 9/21", v: "Cruce bajista confirmado al cierre", d: "down" }); bear++;
  } else {
    core.push({ n: "EMA 9/21", v: "Entrelazadas / sin definir", d: "flat" });
  }

  const R = tf15.rsi;
  if (R >= 70) {
    core.push({ n: "RSI 14", v: `${R.toFixed(1)} - sobrecompra (bloquea LARGOS)`, d: "down" });
    bear++; allowLong = false; revFlag = true;
  } else if (R <= 30) {
    core.push({ n: "RSI 14", v: `${R.toFixed(1)} - sobreventa (bloquea CORTOS)`, d: "up" });
    bull++; allowShort = false; revFlag = true;
  } else if (R > 55) {
    core.push({ n: "RSI 14", v: `${R.toFixed(1)} - momentum alcista`, d: "up" });
    bull++; momFlag = true;
  } else if (R < 45) {
    core.push({ n: "RSI 14", v: `${R.toFixed(1)} - momentum bajista`, d: "down" });
    bear++; momFlag = true;
  } else {
    core.push({ n: "RSI 14", v: `${R.toFixed(1)} - zona neutra 45-55, sin voto`, d: "flat" });
  }

  if (tf15.macdLine > tf15.macdSignal) {
    core.push({ n: "MACD", v: "Linea sobre senal", d: "up" }); bull++;
  } else {
    core.push({ n: "MACD", v: "Linea bajo senal", d: "down" }); bear++;
  }

  if (tf15.volRatio > 1.5) {
    if (tf15.candleDir > 0) {
      core.push({ n: "Volumen", v: `${tf15.volRatio.toFixed(2)}x en vela alcista - presion compradora`, d: "up" }); bull++;
    } else if (tf15.candleDir < 0) {
      core.push({ n: "Volumen", v: `${tf15.volRatio.toFixed(2)}x en vela bajista - presion vendedora`, d: "down" }); bear++;
    } else {
      core.push({ n: "Volumen", v: `${tf15.volRatio.toFixed(2)}x en doji - indeciso`, d: "flat" });
    }
  } else if (tf15.volRatio < 0.6) {
    core.push({ n: "Volumen", v: `${tf15.volRatio.toFixed(2)}x - seco; cualquier ruptura es sospechosa`, d: "flat" });
  } else {
    core.push({ n: "Volumen", v: `${tf15.volRatio.toFixed(2)}x la media - normal`, d: "flat" });
  }

  const sup = tf15.support, res = tf15.resistance;
  const distSup = ((live - sup) / live) * 100;
  const distRes = ((res - live) / live) * 100;
  if (live > res) {
    const withVol = tf15.volRatio > 1.2;
    core.push({
      n: "Estructura",
      v: `Ruptura de resistencia ${fmt(res)}${withVol ? " con volumen" : " SIN volumen (sospechosa)"}`,
      d: withVol ? "up" : "flat",
    });
    if (withVol) bull++;
    momFlag = true;
  } else if (live < sup) {
    const withVol = tf15.volRatio > 1.2;
    core.push({
      n: "Estructura",
      v: `Ruptura de soporte ${fmt(sup)}${withVol ? " con volumen" : " SIN volumen (sospechosa)"}`,
      d: withVol ? "down" : "flat",
    });
    if (withVol) bear++;
    momFlag = true;
  } else if (distSup < 1.2) {
    core.push({ n: "Estructura", v: `Sobre soporte ${fmt(sup)} (${distSup.toFixed(2)}%)`, d: "up" });
    bull++; revFlag = true;
  } else if (distRes < 1.2) {
    core.push({ n: "Estructura", v: `Bajo resistencia ${fmt(res)} (${distRes.toFixed(2)}%)`, d: "down" });
    bear++; revFlag = true;
  } else {
    core.push({ n: "Estructura", v: `Zona media (sop ${distSup.toFixed(1)}% / res ${distRes.toFixed(1)}%)`, d: "flat" });
  }

  const extra = [];
  let conf = 0;

  if (tf15.stochK != null && tf15.stochD != null) {
    if (tf15.stochK < 20 && tf15.stochK > tf15.stochD) {
      extra.push({ n: "StochRSI", v: "Cruce alcista en sobreventa", d: "up" });
      if (bull > bear) conf++;
    } else if (tf15.stochK > 80 && tf15.stochK < tf15.stochD) {
      extra.push({ n: "StochRSI", v: "Cruce bajista en sobrecompra", d: "down" });
      if (bear > bull) conf++;
    } else {
      extra.push({ n: "StochRSI", v: `K ${tf15.stochK.toFixed(1)} / D ${tf15.stochD.toFixed(1)} - neutro`, d: "flat" });
    }
  }

  if (tf15.obvSlope > 0) {
    extra.push({ n: "OBV", v: "Presion compradora acumulada", d: "up" });
    if (bull > bear) conf++; else conf--;
  } else if (tf15.obvSlope < 0) {
    extra.push({ n: "OBV", v: "Presion vendedora acumulada", d: "down" });
    if (bear > bull) conf++; else conf--;
  }

  if (tf15.bbUpper != null && tf15.bbLower != null) {
    if (tf15.close >= tf15.bbUpper) {
      extra.push({ n: "Bollinger", v: "Cierre sobre banda superior - sobreextension", d: "down" });
      if (bear > bull) conf++; else conf--;
    } else if (tf15.close <= tf15.bbLower) {
      extra.push({ n: "Bollinger", v: "Cierre bajo banda inferior - sobreextension", d: "up" });
      if (bull > bear) conf++; else conf--;
    } else if (tf15.bbWidth < 3) {
      extra.push({ n: "Bollinger", v: `Squeeze (${tf15.bbWidth.toFixed(1)}%) - expansion proxima`, d: "flat" });
    } else {
      extra.push({ n: "Bollinger", v: `Dentro de bandas (${tf15.bbWidth.toFixed(1)}%)`, d: "flat" });
    }
  }

  const fibNear = Object.entries(tf15.swing.fib).find(
    ([, lvl]) => Math.abs((live - lvl) / live) < 0.008
  );
  extra.push({
    n: "Fibonacci",
    v: fibNear
      ? `Cerca del ${fibNear[0]} (${fmt(fibNear[1])}) - swing 60 velas, verificar`
      : "Sin nivel Fib cercano (swing 60 velas)",
    d: "flat",
  });

  const net = bull - bear;
  let signal = "SIN OPERAR", dir = null;
  let invalidation = "";

  if (bull >= 3 && net >= 2 && bias !== "BAJISTA" && allowLong) {
    signal = "LARGO"; dir = "long";
  } else if (bear >= 3 && net <= -2 && bias !== "ALCISTA" && allowShort) {
    signal = "CORTO"; dir = "short";
  } else if (bull >= 3 && net >= 2 && !allowLong) {
    invalidation = "Confluencia alcista pero RSI en sobrecompra: entrar aqui es perseguir. Esperar retroceso.";
  } else if (bear >= 3 && net <= -2 && !allowShort) {
    invalidation = "Confluencia bajista pero RSI en sobreventa: vender la capitulacion es mal negocio. Esperar rebote.";
  }

  const extATR = tf15.atr ? (live - tf15.ema21) / tf15.atr : 0;
  if (dir === "long" && extATR > 3) {
    signal = "SIN OPERAR"; dir = null;
    invalidation = `Sobreextendido: ${extATR.toFixed(1)} ATR sobre la EMA21. El movimiento ya corrio; perseguirlo aqui es entrar tarde. Esperar retroceso hacia EMA9/21.`;
  }
  if (dir === "short" && extATR < -3) {
    signal = "SIN OPERAR"; dir = null;
    invalidation = `Sobreextendido a la baja: ${Math.abs(extATR).toFixed(1)} ATR bajo la EMA21. Esperar el rebote tecnico antes de vender.`;
  }

  const tipo = revFlag && momFlag ? "mixto" : revFlag ? "reversion" : momFlag ? "momentum" : "-";

  let confidence = "-";
  if (dir) {
    const base = Math.max(bull, bear) + conf;
    confidence = base >= 6 ? "ALTA" : base >= 4 ? "MEDIA" : "BAJA";
  }

  const A = tf15.atr || live * 0.01;
  let entry = null, zone = null, stop = null, tps = [], roomR = null, ceiling = null, maxLev = null;

  if (dir === "long") {
    entry = live;
    zone = [live - 0.4 * A, live];
    stop = Math.min(entry - 1.8 * A, sup * 0.998);
    const risk = entry - stop;
    ceiling = [tf15.resistance, tf1h.resistance]
      .filter((x) => x > entry * 1.001)
      .sort((a, b) => a - b)[0] ?? null;
    roomR = ceiling ? (ceiling - entry) / risk : null;
    if (roomR !== null && roomR < 1.5) {
      signal = "SIN OPERAR"; dir = null;
      invalidation = `Techo estructural en ${fmt(ceiling)} a solo ${roomR.toFixed(2)}R. No cumple el minimo 1:1.5 de recorrido libre.`;
      entry = null; zone = null; stop = null;
    } else {
      tps = [
        { pct: 40, price: entry + risk * 1.0, r: 1.0 },
        { pct: 35, price: entry + risk * 1.8, r: 1.8 },
        { pct: 25, price: entry + risk * 3.0, r: 3.0 },
      ];
      const stopPct = ((entry - stop) / entry) * 100;
      maxLev = Math.max(1, Math.min(10, Math.floor(100 / (stopPct * 1.6))));
      invalidation = `Cierre 15m bajo ${fmt(stop)} anula el setup.`;
    }
  } else if (dir === "short") {
    entry = live;
    zone = [live, live + 0.4 * A];
    stop = Math.max(entry + 1.8 * A, res * 1.002);
    const risk = stop - entry;
    ceiling = [tf15.support, tf1h.support]
      .filter((x) => x < entry * 0.999)
      .sort((a, b) => b - a)[0] ?? null;
    roomR = ceiling ? (entry - ceiling) / risk : null;
    if (roomR !== null && roomR < 1.5) {
      signal = "SIN OPERAR"; dir = null;
      invalidation = `Piso estructural en ${fmt(ceiling)} a solo ${roomR.toFixed(2)}R. No cumple el minimo 1:1.5 de recorrido libre.`;
      entry = null; zone = null; stop = null;
    } else {
      tps = [
        { pct: 40, price: entry - risk * 1.0, r: 1.0 },
        { pct: 35, price: entry - risk * 1.8, r: 1.8 },
        { pct: 25, price: entry - risk * 3.0, r: 3.0 },
      ];
      const stopPct = ((stop - entry) / entry) * 100;
      maxLev = Math.max(1, Math.min(10, Math.floor(100 / (stopPct * 1.6))));
      invalidation = `Cierre 15m sobre ${fmt(stop)} anula el setup.`;
    }
  }

  return {
    bias, signal, dir, tipo, confidence, core, extra, bull, bear,
    entry, zone, stop, tps, roomR, ceiling, maxLev, invalidation,
    atrVal: A, extATR,
  };
}

/* ---------- UI ---------- */
const Dot = ({ d }) => (
  <span style={{
    display: "inline-block", width: 7, height: 7, borderRadius: 2, marginRight: 8, flexShrink: 0,
    background: d === "up" ? "#00d4aa" : d === "down" ? "#ff4d6d" : "#4a5568",
  }} />
);

const STABLES = new Set([
  "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "USDPUSDT", "DAIUSDT",
  "EURUSDT", "AEURUSDT", "EURIUSDT", "XUSDUSDT",
]);

export default function BinanceCopiloto() {
  const [tab, setTab] = useState("scan");
  const [tickers, setTickers] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanTime, setScanTime] = useState(null);
  const [err, setErr] = useState(null);
  const [symbol, setSymbol] = useState("SOLUSDT");
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [btcCtx, setBtcCtx] = useState(null);
  const [capital, setCapital] = useState(1000);
  const [riskPct, setRiskPct] = useState(1);
  const [minVol, setMinVol] = useState(1000000);

  const scan = useCallback(async () => {
    setScanning(true); setErr(null);
    try {
      const data = await fetchJson("/ticker/24hr");
      const rows = data
        .filter((t) =>
          t.symbol.endsWith("USDT") &&
          !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol) &&
          !STABLES.has(t.symbol)
        )
        .map((t) => {
          const high = parseFloat(t.highPrice), low = parseFloat(t.lowPrice), lastP = parseFloat(t.lastPrice);
          const range = high - low;
          return {
            symbol: t.symbol, price: lastP,
            change: parseFloat(t.priceChangePercent),
            quoteVol: parseFloat(t.quoteVolume), high, low,
            rangePos: range > 0 ? (lastP - low) / range : 0.5,
          };
        })
        .filter((t) => t.quoteVol >= minVol && t.price > 0);
      setTickers(rows); setScanTime(new Date());
    } catch (e) {
      setErr(`No se pudo leer Binance: ${e.message}. Si persiste, puede ser restriccion regional; el codigo ya intenta el mirror data-api.binance.vision.`);
    }
    setScanning(false);
  }, [minVol]);

  useEffect(() => { scan(); }, []);

  const top3 = useMemo(() => {
    if (!tickers.length) return [];
    const mom = [...tickers].filter((t) => Math.abs(t.change) > 3)
      .map((t) => ({ ...t, tipo: "momentum", dir: t.change > 0 ? "LARGO" : "CORTO", score: Math.abs(t.change) * Math.log10(t.quoteVol) }))
      .sort((a, b) => b.score - a.score).slice(0, 6);
    const rev = [...tickers].filter((t) => t.rangePos < 0.08 || t.rangePos > 0.92)
      .map((t) => ({ ...t, tipo: "reversion", dir: t.rangePos < 0.08 ? "LARGO" : "CORTO", score: Math.log10(t.quoteVol) * 2 }))
      .sort((a, b) => b.score - a.score).slice(0, 6);
    const seen = new Set();
    return [...mom, ...rev]
      .filter((t) => { if (seen.has(t.symbol)) return false; seen.add(t.symbol); return true; })
      .sort((a, b) => b.score - a.score).slice(0, 3);
  }, [tickers]);

  const fetchCandles = async (sym, interval, limit = 300) => {
    const raw = await fetchJson(`/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
    return raw.map((c) => ({
      time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5],
    }));
  };

  const analyze = async (sym) => {
    setAnalyzing(true); setErr(null); setAnalysis(null);
    try {
      const s = sym.toUpperCase().replace(/[/_]/g, "");
      const [c15, c1h, c4h, cBtc] = await Promise.all([
        fetchCandles(s, "15m"), fetchCandles(s, "1h"), fetchCandles(s, "4h"), fetchCandles("BTCUSDT", "4h", 250),
      ]);
      const live = c15[c15.length - 1].close;
      const closed = (arr) => arr.slice(0, -1);
      const t15 = analyzeTF(closed(c15));
      const t1h = analyzeTF(closed(c1h));
      const t4h = analyzeTF(closed(c4h));
      const btc = analyzeTF(closed(cBtc));

      const sig = buildSignal(t15, t1h, t4h, live);
      const btcBias =
        btc.close > btc.ema50 && btc.ema50 > btc.ema200 ? "ALCISTA"
          : btc.close < btc.ema50 && btc.ema50 < btc.ema200 ? "BAJISTA" : "RANGO";
      setBtcCtx({ bias: btcBias, price: btc.close, rsi: btc.rsi });
      setAnalysis({ symbol: s, time: new Date(), live, tf15: t15, tf1h: t1h, tf4h: t4h, ...sig });
      setTab("analyze");
    } catch (e) {
      setErr(`Error al analizar: ${e.message}`);
    }
    setAnalyzing(false);
  };

  const position = useMemo(() => {
    if (!analysis?.dir || !analysis.entry || !analysis.stop) return null;
    const riskUsdt = capital * (riskPct / 100);
    const distPct = Math.abs(analysis.entry - analysis.stop) / analysis.entry;
    const sizeUsdt = riskUsdt / distPct;
    const liqPct = 1 / (analysis.maxLev || 1);
    const liqPrice = analysis.dir === "long" ? analysis.entry * (1 - liqPct) : analysis.entry * (1 + liqPct);
    const liqSafe = analysis.dir === "long" ? liqPrice < analysis.stop : liqPrice > analysis.stop;
    return {
      riskUsdt, sizeUsdt,
      sizeCoin: sizeUsdt / analysis.entry,
      margin: sizeUsdt / (analysis.maxLev || 1),
      liqPrice, liqSafe,
    };
  }, [analysis, capital, riskPct]);

  const C = {
    bg: "#0a0e17", panel: "#111827", panel2: "#0d1420", border: "#1f2937",
    text: "#e5e7eb", dim: "#6b7280", green: "#00d4aa", red: "#ff4d6d", amber: "#fbbf24", accent: "#3b82f6",
  };
  const sigColor = analysis?.signal === "LARGO" ? C.green : analysis?.signal === "CORTO" ? C.red : C.dim;
  const inputS = {
    background: C.panel2, border: `1px solid ${C.border}`, color: C.text,
    padding: "7px 10px", borderRadius: 4, fontFamily: "inherit", fontSize: 12, boxSizing: "border-box",
  };

  return (
    <div style={{
      background: C.bg, color: C.text, minHeight: "100vh",
      fontFamily: "'JetBrains Mono','SF Mono',Menlo,Consolas,monospace", fontSize: 13, padding: 16,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        borderBottom: `1px solid ${C.border}`, paddingBottom: 12, marginBottom: 16, flexWrap: "wrap", gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            COPILOTO <span style={{ color: C.amber }}>BINANCE</span> <span style={{ color: C.dim, fontSize: 11 }}>v2</span>
          </div>
          <div style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>
            velas cerradas · sin repintado · spot publico
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {[["scan", "Escaner"], ["analyze", "Analisis"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              background: tab === k ? C.accent : "transparent", color: tab === k ? "#fff" : C.dim,
              border: `1px solid ${tab === k ? C.accent : C.border}`, padding: "6px 14px",
              borderRadius: 4, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
            }}>{l}</button>
          ))}
        </div>
      </div>

      {err && (
        <div style={{
          background: "#2d1215", border: `1px solid ${C.red}`, padding: 12,
          borderRadius: 4, marginBottom: 16, color: "#ffb3c0", fontSize: 12,
        }}>{err}</div>
      )}

      {tab === "scan" && (
        <>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: 16, flexWrap: "wrap" }}>
            <div>
              <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>VOLUMEN MINIMO 24H (USDT)</div>
              <input type="number" value={minVol} onChange={(e) => setMinVol(+e.target.value)} style={{ ...inputS, width: 150 }} />
            </div>
            <button onClick={scan} disabled={scanning} style={{
              background: scanning ? C.border : C.green, color: scanning ? C.dim : "#00201a",
              border: "none", padding: "8px 20px", borderRadius: 4,
              cursor: scanning ? "wait" : "pointer", fontWeight: 700, fontSize: 12, fontFamily: "inherit",
            }}>
              {scanning ? "ESCANEANDO..." : "ESCANEAR MERCADO"}
            </button>
            {scanTime && (
              <div style={{ color: C.dim, fontSize: 11 }}>
                {tickers.length} pares · {scanTime.toLocaleTimeString("es-CO")}
              </div>
            )}
          </div>

          {top3.length > 0 && (
            <>
              <div style={{ color: C.amber, fontSize: 11, letterSpacing: "0.1em", marginBottom: 10 }}>
                TOP 3 OPORTUNIDADES (preliminar - confirmar en Analisis)
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 12, marginBottom: 24 }}>
                {top3.map((t) => (
                  <div key={t.symbol} style={{
                    background: C.panel, border: `1px solid ${C.border}`,
                    borderLeft: `3px solid ${t.dir === "LARGO" ? C.green : C.red}`, borderRadius: 4, padding: 14,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{t.symbol}</span>
                      <span style={{ fontSize: 10, color: C.dim, textTransform: "uppercase" }}>{t.tipo}</span>
                    </div>
                    <div style={{ fontSize: 18, marginBottom: 6 }}>{fmt(t.price)}</div>
                    <div style={{ color: t.change > 0 ? C.green : C.red, marginBottom: 8 }}>
                      {t.change > 0 ? "+" : ""}{t.change.toFixed(2)}% 24h
                    </div>
                    <div style={{ color: C.dim, fontSize: 11 }}>Vol: {(t.quoteVol / 1e6).toFixed(1)}M USDT</div>
                    <div style={{ color: C.dim, fontSize: 11, marginBottom: 12 }}>Rango 24h: {(t.rangePos * 100).toFixed(0)}%</div>
                    <button onClick={() => { setSymbol(t.symbol); analyze(t.symbol); }} disabled={analyzing} style={{
                      background: "transparent", border: `1px solid ${C.accent}`, color: C.accent,
                      padding: "6px 12px", borderRadius: 3, cursor: "pointer", fontSize: 11, width: "100%", fontFamily: "inherit",
                    }}>
                      ANALIZAR
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {tickers.length > 0 && (
            <>
              <div style={{ color: C.dim, fontSize: 11, letterSpacing: "0.1em", marginBottom: 10 }}>
                MERCADO - TOP 40 POR VOLUMEN
              </div>
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, overflow: "auto", maxHeight: 400 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: C.panel2 }}>
                      {["PAR", "PRECIO", "24H %", "VOL (M)", "RANGO", ""].map((h) => (
                        <th key={h} style={{
                          padding: "8px 12px", textAlign: "left", color: C.dim,
                          fontSize: 10, fontWeight: 500, position: "sticky", top: 0, background: C.panel2,
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...tickers].sort((a, b) => b.quoteVol - a.quoteVol).slice(0, 40).map((t) => (
                      <tr key={t.symbol} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ padding: "7px 12px", fontWeight: 600 }}>{t.symbol}</td>
                        <td style={{ padding: "7px 12px" }}>{fmt(t.price)}</td>
                        <td style={{ padding: "7px 12px", color: t.change > 0 ? C.green : C.red }}>
                          {t.change > 0 ? "+" : ""}{t.change.toFixed(2)}%
                        </td>
                        <td style={{ padding: "7px 12px", color: C.dim }}>{(t.quoteVol / 1e6).toFixed(1)}</td>
                        <td style={{ padding: "7px 12px" }}>
                          <div style={{ width: 50, height: 4, background: C.border, borderRadius: 2, position: "relative" }}>
                            <div style={{
                              position: "absolute", left: `${Math.min(100, Math.max(0, t.rangePos * 100))}%`,
                              top: -2, width: 2, height: 8,
                              background: t.rangePos > 0.8 ? C.red : t.rangePos < 0.2 ? C.green : C.text,
                            }} />
                          </div>
                        </td>
                        <td style={{ padding: "7px 12px" }}>
                          <button onClick={() => { setSymbol(t.symbol); analyze(t.symbol); }} style={{
                            background: "transparent", border: "none", color: C.accent,
                            cursor: "pointer", fontSize: 11, fontFamily: "inherit", padding: 0,
                          }}>analizar</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {tab === "analyze" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && analyze(symbol)}
              placeholder="SOLUSDT"
              style={{ ...inputS, width: 160, fontSize: 13, padding: "8px 12px" }}
            />
            <button onClick={() => analyze(symbol)} disabled={analyzing} style={{
              background: analyzing ? C.border : C.accent, color: "#fff", border: "none",
              padding: "8px 20px", borderRadius: 4, cursor: analyzing ? "wait" : "pointer",
              fontWeight: 700, fontSize: 12, fontFamily: "inherit",
            }}>
              {analyzing ? "CALCULANDO..." : "ANALIZAR"}
            </button>
            {["SOLUSDT", "BNBUSDT", "XLMUSDT", "DOGEUSDT"].map((s) => (
              <button key={s} onClick={() => { setSymbol(s); analyze(s); }} style={{
                background: "transparent", border: `1px solid ${C.border}`, color: C.dim,
                padding: "8px 12px", borderRadius: 4, cursor: "pointer", fontSize: 11, fontFamily: "inherit",
              }}>{s.replace("USDT", "")}</button>
            ))}
          </div>

          {!analysis && !analyzing && (
            <div style={{ color: C.dim, padding: 40, textAlign: "center", border: `1px dashed ${C.border}`, borderRadius: 4 }}>
              Escribe un par o elige uno del escaner.
            </div>
          )}

          {analysis && (
            <>
              <div style={{
                background: C.panel, border: `1px solid ${C.border}`, borderLeft: `4px solid ${sigColor}`,
                borderRadius: 4, padding: 18, marginBottom: 14,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{analysis.symbol}</div>
                    <div style={{ fontSize: 26, marginTop: 4 }}>{fmt(analysis.live)}</div>
                    <div style={{ color: C.dim, fontSize: 11, marginTop: 4 }}>
                      en vivo · ultimo cierre 15m: {fmt(analysis.tf15.close)}
                    </div>
                    <div style={{ color: C.dim, fontSize: 11 }}>
                      Binance spot · {analysis.time.toLocaleTimeString("es-CO")} (Bogota)
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 24, fontWeight: 700, color: sigColor }}>{analysis.signal}</div>
                    <div style={{ color: C.dim, fontSize: 11, marginTop: 4 }}>
                      Tipo: {analysis.tipo} · Confianza: {analysis.confidence}
                    </div>
                    <div style={{ color: C.dim, fontSize: 11 }}>Sesgo 4h/1h: {analysis.bias}</div>
                    <div style={{ color: C.dim, fontSize: 11 }}>
                      Nucleo: {analysis.bull} alcistas / {analysis.bear} bajistas
                    </div>
                  </div>
                </div>
              </div>

              {btcCtx && (
                <div style={{
                  background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 4,
                  padding: "10px 14px", marginBottom: 14, fontSize: 12, color: C.dim,
                }}>
                  <span style={{ color: C.amber }}>BTC</span> · {fmt(btcCtx.price)} · sesgo 4h{" "}
                  <span style={{ color: btcCtx.bias === "ALCISTA" ? C.green : btcCtx.bias === "BAJISTA" ? C.red : C.text }}>
                    {btcCtx.bias}
                  </span>{" "}· RSI {btcCtx.rsi?.toFixed(1)} - si BTC se mueve fuerte, arrastra la altcoin.
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14, marginBottom: 14 }}>
                <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14 }}>
                  <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.1em", marginBottom: 10 }}>
                    NUCLEO - 15m cerrado (decide la entrada)
                  </div>
                  {analysis.core.map((c, i) => (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", padding: "6px 0",
                      borderTop: i ? `1px solid ${C.border}` : "none",
                    }}>
                      <Dot d={c.d} />
                      <span style={{ width: 90, color: C.dim, flexShrink: 0 }}>{c.n}</span>
                      <span style={{ fontSize: 12 }}>{c.v}</span>
                    </div>
                  ))}
                </div>
                <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14 }}>
                  <div style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em", marginBottom: 10 }}>
                    CONFIRMACION EXTRA (ajusta confianza)
                  </div>
                  {analysis.extra.map((c, i) => (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", padding: "6px 0",
                      borderTop: i ? `1px solid ${C.border}` : "none",
                    }}>
                      <Dot d={c.d} />
                      <span style={{ width: 90, color: C.dim, flexShrink: 0 }}>{c.n}</span>
                      <span style={{ fontSize: 12 }}>{c.v}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, overflow: "auto", marginBottom: 14 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: C.panel2 }}>
                      {["TF", "CIERRE", "EMA50", "EMA200", "RSI", "MACD", "ATR"].map((h) => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: C.dim, fontSize: 10, fontWeight: 500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[["4h", analysis.tf4h], ["1h", analysis.tf1h], ["15m", analysis.tf15]].map(([lbl, t]) => (
                      <tr key={lbl} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ padding: "7px 12px", fontWeight: 700, color: C.amber }}>{lbl}</td>
                        <td style={{ padding: "7px 12px" }}>{fmt(t.close)}</td>
                        <td style={{ padding: "7px 12px", color: t.close > t.ema50 ? C.green : C.red }}>{fmt(t.ema50)}</td>
                        <td style={{ padding: "7px 12px", color: t.close > t.ema200 ? C.green : C.red }}>{fmt(t.ema200)}</td>
                        <td style={{ padding: "7px 12px", color: t.rsi > 70 ? C.red : t.rsi < 30 ? C.green : C.text }}>
                          {t.rsi?.toFixed(1)}
                        </td>
                        <td style={{ padding: "7px 12px", color: t.macdLine > t.macdSignal ? C.green : C.red }}>
                          {t.macdLine > t.macdSignal ? "alcista" : "bajista"}
                        </td>
                        <td style={{ padding: "7px 12px", color: C.dim }}>{fmt(t.atr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {analysis.dir ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14 }}>
                  <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14 }}>
                    <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.1em", marginBottom: 12 }}>NIVELES DEL SETUP</div>
                    {[
                      ["Zona de entrada", `${fmt(analysis.zone[0])} - ${fmt(analysis.zone[1])}`, C.text],
                      ["Stop-loss", fmt(analysis.stop), C.red],
                      ["Distancia al stop", `${((Math.abs(analysis.entry - analysis.stop) / analysis.entry) * 100).toFixed(2)}%`, C.dim],
                      ["ATR 15m", `${fmt(analysis.atrVal)} (${((analysis.atrVal / analysis.entry) * 100).toFixed(2)}% del precio)`, C.dim],
                      ["Extension vs EMA21", `${analysis.extATR.toFixed(1)} ATR`, Math.abs(analysis.extATR) > 2 ? C.amber : C.dim],
                      ["Recorrido libre", analysis.roomR != null ? `${analysis.roomR.toFixed(1)}R hasta ${fmt(analysis.ceiling)}` : "sin estructura cercana en contra", analysis.roomR != null && analysis.roomR < 2.5 ? C.amber : C.green],
                      ["R/B escalonado", "1:1.78 ponderado (1R/1.8R/3R)", C.text],
                      ["Apalanc. max. seguro", `${analysis.maxLev}x (tope 10x)`, C.amber],
                    ].map(([k, v, col], i) => (
                      <div key={i} style={{
                        display: "flex", justifyContent: "space-between", padding: "7px 0", gap: 10,
                        borderTop: i ? `1px solid ${C.border}` : "none",
                      }}>
                        <span style={{ color: C.dim, flexShrink: 0 }}>{k}</span>
                        <span style={{ color: col, fontWeight: 600, textAlign: "right" }}>{v}</span>
                      </div>
                    ))}
                    <div style={{
                      marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}`,
                      color: C.dim, fontSize: 10, letterSpacing: "0.1em", marginBottom: 8,
                    }}>TAKE-PROFIT POR TRAMOS</div>
                    {analysis.tps.map((t, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 12 }}>
                        <span style={{ color: C.dim }}>TP{i + 1} - {t.pct}% ({t.r}R)</span>
                        <span style={{ color: C.green, fontWeight: 600 }}>{fmt(t.price)}</span>
                      </div>
                    ))}
                    <div style={{ marginTop: 10, fontSize: 11, color: C.amber, lineHeight: 1.5 }}>
                      Tras TP1: mueve el stop a break-even ({fmt(analysis.entry)}).
                    </div>
                  </div>

                  <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14 }}>
                    <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.1em", marginBottom: 12 }}>TAMANO DE POSICION</div>
                    <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>CAPITAL (USDT)</div>
                        <input type="number" value={capital} onChange={(e) => setCapital(+e.target.value)} style={{ ...inputS, width: "100%" }} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>RIESGO (%)</div>
                        <select value={riskPct} onChange={(e) => setRiskPct(+e.target.value)} style={{ ...inputS, width: "100%" }}>
                          <option value={1}>1%</option>
                          <option value={1.5}>1.5%</option>
                          <option value={2}>2%</option>
                        </select>
                      </div>
                    </div>
                    {position && (
                      <>
                        {[
                          ["Riesgo maximo", `${position.riskUsdt.toFixed(2)} USDT`, C.red],
                          ["Tamano de posicion", `${position.sizeUsdt.toFixed(2)} USDT`, C.text],
                          ["Cantidad", `${position.sizeCoin.toFixed(4)} ${analysis.symbol.replace("USDT", "")}`, C.text],
                          [`Margen a ${analysis.maxLev}x`, `${position.margin.toFixed(2)} USDT`, C.dim],
                          ["Liquidacion aprox.", fmt(position.liqPrice), position.liqSafe ? C.green : C.red],
                        ].map(([k, v, col], i) => (
                          <div key={i} style={{
                            display: "flex", justifyContent: "space-between", padding: "7px 0",
                            borderTop: i ? `1px solid ${C.border}` : "none",
                          }}>
                            <span style={{ color: C.dim }}>{k}</span>
                            <span style={{ color: col, fontWeight: 600 }}>{v}</span>
                          </div>
                        ))}
                        <div style={{
                          marginTop: 12, padding: 10,
                          background: position.liqSafe ? "#0d2620" : "#2d1215",
                          border: `1px solid ${position.liqSafe ? C.green : C.red}`, borderRadius: 4,
                          fontSize: 11, lineHeight: 1.5, color: position.liqSafe ? "#7fe8d0" : "#ffb3c0",
                        }}>
                          {position.liqSafe
                            ? `Liquidacion queda MAS ALLA del stop. El stop te saca antes. Perdida maxima aprox. ${position.riskUsdt.toFixed(2)} USDT.`
                            : `PELIGRO: la liquidacion quedaria ANTES del stop. Perderias el margen entero. Baja el apalancamiento.`}
                        </div>
                        <div style={{ marginTop: 8, fontSize: 10, color: C.dim, lineHeight: 1.5 }}>
                          Liquidacion aproximada - no incluye comisiones, funding ni margen de mantenimiento.
                          Usa el menor entre este apalancamiento y el limite de tu cuenta. Verifica en Binance.
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{
                  background: C.panel, border: `1px solid ${C.border}`, borderLeft: `4px solid ${C.dim}`,
                  borderRadius: 4, padding: 18,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>SIN OPERAR</div>
                  <div style={{ color: C.dim, fontSize: 12, lineHeight: 1.6 }}>
                    {analysis.invalidation ||
                      `Sin confluencia de al menos 3 senales del nucleo en la misma direccion (${analysis.bull} alcistas / ${analysis.bear} bajistas), o el sesgo mayor contradice el gatillo. Esperar es una posicion valida.`}
                  </div>
                </div>
              )}

              {analysis.dir && (
                <div style={{
                  marginTop: 14, padding: 12, background: C.panel2, border: `1px solid ${C.border}`,
                  borderRadius: 4, fontSize: 12, color: C.dim, lineHeight: 1.6,
                }}>
                  <span style={{ color: C.amber }}>Invalidacion:</span> {analysis.invalidation}
                </div>
              )}

              <div style={{
                marginTop: 16, padding: 12, border: `1px dashed ${C.border}`, borderRadius: 4,
                fontSize: 11, color: C.dim, lineHeight: 1.6,
              }}>
                Senales calculadas sobre velas CERRADAS (sin repintado); el precio en vivo puede diferir del ultimo cierre.
                Verifica precio, ATR, soportes y liquidacion en tu plataforma antes de ejecutar.
                Fibonacci usa el swing de las ultimas 60 velas - tu swing puede diferir.
                Herramienta de gestion de riesgo, no recomendacion de inversion.
                La mayoria de traders minoristas de cripto pierde dinero.
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
