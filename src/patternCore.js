/* Motor de PATRONES CHARTISTAS (puerto del indicador auto_pattern_detector_v6.pine).

   Detecta 16 figuras a partir de pivotes confirmados sobre velas CERRADAS y, para cada una,
   calcula entrada, stop estructural y 3 take-profits por ATR. Cada figura pasa por un
   embudo de validaciones: tamano minimo, ancho razonable, contencion real del precio entre
   las rectas, volumen, R:R neto de costes, tendencia y latencia desde la ruptura.

   Diferencia deliberada con el .pine: alli la entrada se toma en el OPEN de la vela de
   ruptura, lo que en la practica es imposible (la ruptura se conoce cuando la vela ya
   corre). Aqui la entrada es el open de la vela SIGUIENTE, que es como resuelve el backtest
   del resto de la app (tracker.js) y no adelanta informacion. */

import { ema, rsi, sma, atr } from "./signalCore.js";

/* ---------- Configuracion por defecto (equivale a los inputs del .pine) ---------- */
export const DEFAULT_CFG = {
  // pivotes
  lbLeft: 10, lbRight: 10, maxPivots: 40,
  // geometria
  symTol: 0.10, lvlTol: 0.03, minSizePct: 0.005, minAtrMult: 1.0,
  minPatWidth: 8, maxPatWidth: 120, containmentOn: true, containTol: 0.15,
  // ruptura
  useAtrBrk: true, breakAtr: 1.0, breakPct: 0.003, reqCloseBrk: false,
  reqBodyBrk: false, brkConfirmBars: 1, scanBars: 60,
  // filtros
  reqVol: false, volMult: 1.0, volLen: 20,
  reqRR: true, minRR: 1.0, commissionPct: 0.0005, slippagePct: 0.0002,
  trendFilter: false, trendLen: 200,
  maxLatency: 8,       // latencia para OPERAR (estricta)
  harvestLatency: 200, // latencia para APRENDER (amplia): un setup viejo sigue siendo dato valido
  // objetivos
  tp1Atr: 1.5, tp2Atr: 3.0, tp3Atr: 4.5, stopBuffer: 0.5,
  // multiplicadores efectivos (los inyecta el cerebro; si faltan, se usan los fijos)
  tpMult: null, slAtr: null,
  // contexto smart money
  smcOn: true, smcLook: 20,
  // que figuras buscar
  show: {
    hs: true, dt: true, tt: true, cup: true,
    flag: true, pennant: true, wedge: true, triangle: true, rect: true,
  },
};

/* ---------- Utilidades numericas ---------- */
const rollingMax = (arr, len) => {
  const out = new Array(arr.length).fill(null);
  for (let i = len - 1; i < arr.length; i++) {
    let m = -Infinity;
    for (let j = i - len + 1; j <= i; j++) if (arr[j] > m) m = arr[j];
    out[i] = m;
  }
  return out;
};
const rollingMin = (arr, len) => {
  const out = new Array(arr.length).fill(null);
  for (let i = len - 1; i < arr.length; i++) {
    let m = Infinity;
    for (let j = i - len + 1; j <= i; j++) if (arr[j] < m) m = arr[j];
    out[i] = m;
  }
  return out;
};

/* ---------- Contexto: todo lo que se precomputa una sola vez ---------- */
// `bm` (opcional): { align: [], vol: [] } con el regimen del benchmark alineado por indice.
// Es lo que hace comparable el aprendizaje entre simbolos distintos.
export function buildContext(candles, cfg = {}, bm = null) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const n = candles.length;
  const highs = candles.map((k) => k.high);
  const lows = candles.map((k) => k.low);
  const closes = candles.map((k) => k.close);
  const opens = candles.map((k) => k.open);
  const vols = candles.map((k) => k.volume);

  const atrArr = atr(highs, lows, closes, 14);
  const emaArr = ema(closes, c.trendLen);
  const rsiArr = rsi(closes, 14);
  const volSma = sma(vols, Math.min(c.volLen, Math.max(2, n - 1)));
  const atrBase = sma(atrArr.map((v) => v ?? 0), 100);

  // Efficiency Ratio de Kaufman: 1 = tendencia limpia, 0 = puro ruido lateral.
  const kamaEr = new Array(n).fill(0);
  for (let i = 20; i < n; i++) {
    const chg = Math.abs(closes[i] - closes[i - 20]);
    let vol = 0;
    for (let j = i - 19; j <= i; j++) vol += Math.abs(closes[j] - closes[j - 1]);
    kamaEr[i] = vol > 0 ? chg / vol : 0;
  }

  // Smart Money: barrido de liquidez (perfora el extremo previo y CIERRA de vuelta dentro)
  // y posicion del cierre en el rango reciente (0 = discount, 1 = premium).
  const L = c.smcLook;
  const priorLow = rollingMin(lows, L);
  const priorHigh = rollingMax(highs, L);
  const rngHi = rollingMax(highs, L * 2);
  const rngLo = rollingMin(lows, L * 2);
  const smcPos = new Array(n).fill(0.5);
  const sweepBias = new Array(n).fill(0);
  let lastSweepLow = -1e9, lastSweepHigh = -1e9;
  for (let i = 1; i < n; i++) {
    const pl = priorLow[i - 1], ph = priorHigh[i - 1];
    if (pl != null && lows[i] < pl && closes[i] > pl) lastSweepLow = i;
    if (ph != null && highs[i] > ph && closes[i] < ph) lastSweepHigh = i;
    sweepBias[i] = i - lastSweepLow <= L ? 1 : i - lastSweepHigh <= L ? -1 : 0;
    if (rngHi[i] != null && rngLo[i] != null && rngHi[i] > rngLo[i]) {
      smcPos[i] = (closes[i] - rngLo[i]) / (rngHi[i] - rngLo[i]);
    }
  }

  return {
    cfg: c, candles, n, highs, lows, closes, opens, vols,
    atr: atrArr, ema: emaArr, rsi: rsiArr, volSma, atrBase, kamaEr,
    smcPos, sweepBias, bm,
  };
}

// Warm-up: solo se exige la EMA larga cuando el filtro de tendencia esta encendido.
// Atarlo siempre a trendLen desperdiciaria 200 velas de las 300 que trae la ventana viva
// y el detector casi nunca encontraria nada.
export const warmupBars = (cfg) =>
  Math.max(cfg.trendFilter ? cfg.trendLen : 60, (cfg.lbLeft + cfg.lbRight) * 4, 40);

/* ---------- Pivotes ----------
   Equivalente a ta.pivothigh/ta.pivotlow: un pivote en `i` solo se CONFIRMA `right` velas
   despues, asi que nunca se usa antes de existir (sin repintado). */
export function collectPivots(ctx) {
  const { highs, lows, n, cfg } = ctx;
  const { lbLeft: L, lbRight: R } = cfg;
  const hs = [], ls = [];
  for (let i = L; i < n - R; i++) {
    let isH = true, isL = true;
    for (let j = i - L; j <= i + R; j++) {
      if (j === i) continue;
      if (highs[j] >= highs[i]) isH = false;
      if (lows[j] <= lows[i]) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) hs.push({ p: highs[i], i, confirm: i + R });
    if (isL) ls.push({ p: lows[i], i, confirm: i + R });
  }
  return { highs: hs, lows: ls };
}

// Pivotes disponibles en la barra `bar`, MAS RECIENTES PRIMERO (como el unshift del .pine).
// `drop` descarta los N mas recientes: es la "rotacion de pivotes" que permite cosechar
// combinaciones mas antiguas para entrenar.
export function pivotsAt(all, bar, maxKeep = 40, drop = 0) {
  const take = (arr) => {
    const out = [];
    for (let k = arr.length - 1; k >= 0 && out.length < maxKeep + drop; k--) {
      if (arr[k].confirm <= bar) out.push(arr[k]);
    }
    return out.slice(drop);
  };
  return { highs: take(all.highs), lows: take(all.lows) };
}

/* ---------- Helpers geometricos ---------- */
const project = (x1, y1, x2, y2, tx) => (x2 === x1 ? y1 : y1 + ((y2 - y1) / (x2 - x1)) * (tx - x1));

// abs() en el promedio: funciona tambien con valores negativos (pendientes de flags alcistas).
const isNear = (a, b, tol) => Math.abs(a - b) <= Math.abs((a + b) / 2) * tol;

const neckAtBreak = (nlI, nlP, nrI, nrP, bIdx) => {
  if (nlI == null && nrI == null) return null;
  if (nlI == null) return nrP;
  if (nrI == null) return nlP;
  return nlI === nrI ? nlP : project(nlI, nlP, nrI, nrP, bIdx);
};

function validWidth(cfg, i0, i1) {
  const w = Math.abs((i1 ?? 0) - (i0 ?? 0));
  return w >= cfg.minPatWidth && w <= cfg.maxPatWidth;
}

// Contencion: el precio debe haber estado REALMENTE dentro de las dos rectas.
// Sin esta prueba se dibujan dos rectas arbitrarias y se las llama "triangulo".
function contained(ctx, u, l) {
  const { cfg, highs, lows } = ctx;
  if (!cfg.containmentOn || !u || !l) return true;
  const i0 = Math.max(Math.min(u[0], l[0]), 0);
  const i1 = Math.max(u[2], l[2]);
  if (i1 - i0 < cfg.minPatWidth) return false;
  let breaches = 0, checked = 0;
  for (let bi = i0; bi <= i1; bi++) {
    if (bi < 0 || bi >= highs.length) continue;
    const pu = project(u[0], u[1], u[2], u[3], bi);
    const pl = project(l[0], l[1], l[2], l[3], bi);
    if (pu == null || pl == null || pu <= pl) continue;
    const tol = (pu - pl) * cfg.containTol;
    checked++;
    if (highs[bi] > pu + tol || lows[bi] < pl - tol) breaches++;
  }
  // Se admite hasta un 20% de velas fuera; mas que eso no es un patron.
  return checked >= cfg.minPatWidth && breaches <= checked * 0.20;
}

const isValidSize = (ctx, height, bar) =>
  height > Math.max(ctx.closes[bar] * ctx.cfg.minSizePct, (ctx.atr[bar] ?? 0) * ctx.cfg.minAtrMult);

/* ---------- Ruptura ----------
   Busca la ruptura MAS ANTIGUA dentro de la ventana de escaneo: la primera vez que el
   precio realmente salio de la figura, no la ultima. */
function findBreakIdx(ctx, x1, y1, x2, y2, isUp, bar) {
  const { cfg, atr: A, closes, opens, highs, lows } = ctx;
  const scan = Math.max(cfg.scanBars, cfg.lbRight) + 10;
  for (let off = scan; off >= 1; off--) {
    const b = bar - off;
    if (b < 1) continue;
    const proj = project(x1, y1, x2, y2, b);
    if (proj == null) continue;
    const margin = cfg.useAtrBrk ? (A[b] ?? 0) * cfg.breakAtr : proj * cfg.breakPct;
    const up = proj + margin, dn = proj - margin;
    const val = cfg.reqCloseBrk ? closes[b] : isUp ? highs[b] : lows[b];
    let broken = isUp ? val > up : val < dn;
    if (cfg.reqBodyBrk && broken) {
      broken = isUp ? opens[b] > up && closes[b] > up : opens[b] < dn && closes[b] < dn;
    }
    if (!broken) continue;
    let confirmed = true;
    for (let k = 1; k < cfg.brkConfirmBars; k++) {
      const ci = b + k;
      if (ci > bar) { confirmed = false; break; }
      const pk = project(x1, y1, x2, y2, ci);
      const mk = cfg.useAtrBrk ? (A[ci] ?? 0) * cfg.breakAtr : pk * cfg.breakPct;
      if (isUp ? closes[ci] <= pk + mk : closes[ci] >= pk - mk) { confirmed = false; break; }
    }
    if (confirmed) return b;
  }
  return null;
}

// Entrada realista: open de la vela SIGUIENTE a la ruptura.
const entryAt = (ctx, bIdx) =>
  bIdx != null && bIdx + 1 < ctx.n ? ctx.opens[bIdx + 1] : null;

/* ---------- Objetivos y stop ---------- */
function targets(ctx, entry, isBull, bIdx) {
  if (entry == null || bIdx == null) return [null, null, null];
  const { cfg } = ctx;
  const a = ctx.atr[bIdx] ?? ctx.atr[ctx.n - 1] ?? 0;
  const [m1, m2, m3] = cfg.tpMult ?? [cfg.tp1Atr, cfg.tp2Atr, cfg.tp3Atr];
  const s = isBull ? 1 : -1;
  return [entry + s * a * m1, entry + s * a * m2, entry + s * a * m3];
}

// SL aprendido: percentil alto del MAE de los GANADORES. Traduccion: "cuanto suele ir en
// contra un trade que despues funciona". Colocar el stop debajo de eso evita que te saquen
// de operaciones buenas. Si no hay evidencia, stop estructural anclado al patron.
function stopFor(ctx, anchor, isBull, entry, bIdx) {
  const { cfg } = ctx;
  const a = ctx.atr[bIdx ?? ctx.n - 1] ?? 0;
  if (cfg.slAtr != null && entry != null) return isBull ? entry - a * cfg.slAtr : entry + a * cfg.slAtr;
  if (anchor == null) return null;
  return isBull ? anchor - a * cfg.stopBuffer : anchor + a * cfg.stopBuffer;
}

/* ---------- Validacion de volumen y R:R neto de costes ---------- */
function validateTrade(ctx, bIdx, entry, stop, tp2) {
  const { cfg } = ctx;
  if (bIdx == null || entry == null || stop == null || tp2 == null) return false;
  if (cfg.reqVol) {
    const s = ctx.volSma[bIdx];
    if (s != null && ctx.vols[bIdx] <= s * cfg.volMult) return false;
  }
  if (cfg.reqRR) {
    const cost = entry * (cfg.commissionPct * 2 + cfg.slippagePct);
    const risk = Math.abs(entry - stop);
    const reward = Math.max(0, Math.abs(tp2 - entry) - cost);
    if (risk <= 0 || reward / risk < cfg.minRR) return false;
  }
  return true;
}

/* ---------- Constructor de resultado ---------- */
function mk(name, isBullish, o) {
  return {
    detected: true, name, isBullish,
    entry: o.entry, stop: o.stop, tp1: o.tps[0], tp2: o.tps[1], tp3: o.tps[2],
    startIdx: o.startIdx, breakoutIdx: o.breakoutIdx,
    fill: o.fill ?? null, lines: o.lines ?? null,
  };
}

// Prepara entrada/stop/TPs/validez de una figura candidata en un solo paso.
function setup(ctx, { bIdx, isBull, anchor }) {
  const entry = entryAt(ctx, bIdx);
  const tpsTmp = targets(ctx, entry, isBull, bIdx);
  const stop = stopFor(ctx, anchor, isBull, entry, bIdx);
  const ok = entry != null && stop != null && validateTrade(ctx, bIdx, entry, stop, tpsTmp[1]);
  return { entry, stop, tps: tpsTmp, ok, breakoutIdx: bIdx };
}

/* ═══════════════════ DETECTORES ═══════════════════ */

function detectHS(ctx, pv, bar) {
  const { cfg } = ctx;
  const out = [];
  const PH = pv.highs, PL = pv.lows;
  if (cfg.show.hs && PH.length >= 3 && PL.length >= 2) {
    const [rs, head, ls] = PH, [nr, nl] = PL;
    if (rs.i > nr.i && nr.i > head.i && head.i > nl.i && nl.i > ls.i &&
        head.p > rs.p && head.p > ls.p && isNear(ls.p, rs.p, cfg.symTol)) {
      const b = findBreakIdx(ctx, nl.i, nl.p, nr.i, nr.p, false, bar);
      const height = head.p - (nr.p + nl.p) / 2;
      if (b != null && isValidSize(ctx, height, bar)) {
        const s = setup(ctx, { bIdx: b, isBull: false, anchor: rs.p });
        const nk = neckAtBreak(nl.i, nl.p, nr.i, nr.p, b);
        if (s.ok) out.push(mk("Head & Shoulders", false, {
          ...s, startIdx: ls.i,
          fill: { u: [ls.i, head.p, b, nk], l: [nl.i, nl.p, b, nk] },
          lines: { l: [nl.i, nl.p, b, nk] },
        }));
      }
    }
  }
  if (cfg.show.hs && PL.length >= 3 && PH.length >= 2) {
    const [rs, head, ls] = PL, [nr, nl] = PH;
    if (rs.i > nr.i && nr.i > head.i && head.i > nl.i && nl.i > ls.i &&
        head.p < rs.p && head.p < ls.p && isNear(ls.p, rs.p, cfg.symTol)) {
      const b = findBreakIdx(ctx, nl.i, nl.p, nr.i, nr.p, true, bar);
      const height = (nr.p + nl.p) / 2 - head.p;
      if (b != null && isValidSize(ctx, height, bar)) {
        const s = setup(ctx, { bIdx: b, isBull: true, anchor: rs.p });
        const nk = neckAtBreak(nl.i, nl.p, nr.i, nr.p, b);
        if (s.ok) out.push(mk("Inv Head & Shoulders", true, {
          ...s, startIdx: ls.i,
          fill: { u: [nl.i, nl.p, b, nk], l: [ls.i, head.p, b, nk] },
          lines: { u: [nl.i, nl.p, b, nk] },
        }));
      }
    }
  }
  return out;
}

function detectDouble(ctx, pv, bar) {
  const { cfg } = ctx;
  const out = [];
  const PH = pv.highs, PL = pv.lows;
  if (cfg.show.dt && PH.length >= 2 && PL.length >= 1) {
    const [p1, p2] = PH, mid = PL[0];
    if (p1.i > mid.i && mid.i > p2.i && isNear(p1.p, p2.p, cfg.lvlTol)) {
      const avgTop = (p1.p + p2.p) / 2;
      const b = findBreakIdx(ctx, mid.i, mid.p, bar, mid.p, false, bar);
      if (b != null && isValidSize(ctx, avgTop - mid.p, bar)) {
        const s = setup(ctx, { bIdx: b, isBull: false, anchor: Math.max(p1.p, p2.p) });
        if (s.ok) out.push(mk("Double Top", false, {
          ...s, startIdx: p2.i,
          fill: { u: [p2.i, avgTop, b, avgTop], l: [mid.i, mid.p, b, mid.p] },
          lines: { l: [mid.i, mid.p, b, mid.p] },
        }));
      }
    }
  }
  if (cfg.show.dt && PL.length >= 2 && PH.length >= 1) {
    const [p1, p2] = PL, mid = PH[0];
    if (p1.i > mid.i && mid.i > p2.i && isNear(p1.p, p2.p, cfg.lvlTol)) {
      const avgBot = (p1.p + p2.p) / 2;
      const b = findBreakIdx(ctx, mid.i, mid.p, bar, mid.p, true, bar);
      if (b != null && isValidSize(ctx, mid.p - avgBot, bar)) {
        const s = setup(ctx, { bIdx: b, isBull: true, anchor: Math.min(p1.p, p2.p) });
        if (s.ok) out.push(mk("Double Bottom", true, {
          ...s, startIdx: p2.i,
          fill: { u: [mid.i, mid.p, b, mid.p], l: [p2.i, avgBot, b, avgBot] },
          lines: { u: [mid.i, mid.p, b, mid.p] },
        }));
      }
    }
  }
  return out;
}

function detectTriple(ctx, pv, bar) {
  const { cfg } = ctx;
  const out = [];
  const PH = pv.highs, PL = pv.lows;
  if (cfg.show.tt && PH.length >= 3 && PL.length >= 2) {
    const [h1, h2, h3] = PH, [l1, l2] = PL;
    if (h1.i > l1.i && l1.i > h2.i && h2.i > l2.i && l2.i > h3.i &&
        isNear(h1.p, h2.p, cfg.lvlTol) && isNear(h2.p, h3.p, cfg.lvlTol)) {
      const neck = Math.min(l1.p, l2.p);
      const top = Math.max(h1.p, h2.p, h3.p);
      const b = findBreakIdx(ctx, l2.i, l2.p, l1.i, l1.p, false, bar);
      if (b != null && isValidSize(ctx, top - neck, bar)) {
        const s = setup(ctx, { bIdx: b, isBull: false, anchor: top });
        const nk = neckAtBreak(l2.i, l2.p, l1.i, l1.p, b);
        if (s.ok) out.push(mk("Triple Top", false, {
          ...s, startIdx: h3.i,
          fill: { u: [h3.i, top, b, top], l: [l2.i, neck, b, nk] },
          lines: { l: [l2.i, neck, b, nk] },
        }));
      }
    }
  }
  if (cfg.show.tt && PL.length >= 3 && PH.length >= 2) {
    const [l1, l2, l3] = PL, [h1, h2] = PH;
    if (l1.i > h1.i && h1.i > l2.i && l2.i > h2.i && h2.i > l3.i &&
        isNear(l1.p, l2.p, cfg.lvlTol) && isNear(l2.p, l3.p, cfg.lvlTol)) {
      const neck = Math.max(h1.p, h2.p);
      const bot = Math.min(l1.p, l2.p, l3.p);
      const b = findBreakIdx(ctx, h2.i, neck, h1.i, neck, true, bar);
      if (b != null && isValidSize(ctx, neck - bot, bar)) {
        const s = setup(ctx, { bIdx: b, isBull: true, anchor: bot });
        if (s.ok) out.push(mk("Triple Bottom", true, {
          ...s, startIdx: l3.i,
          fill: { u: [h2.i, neck, b, neck], l: [l3.i, bot, b, bot] },
          lines: { u: [h2.i, neck, b, neck] },
        }));
      }
    }
  }
  return out;
}

// Cup & Handle con validacion real de forma: profundidad de taza, retroceso del asa y
// proporcion de duraciones. Sin esto, cualquier zigzag pasa por taza.
function detectCup(ctx, pv, bar) {
  const { cfg } = ctx;
  const out = [];
  const PH = pv.highs, PL = pv.lows;
  if (!cfg.show.cup || PH.length < 2 || PL.length < 2) return out;

  const [hRim, hLeft] = PH, [lHandle, lBot] = PL;
  if (lHandle.i > hRim.i && hRim.i > lBot.i && lBot.i > hLeft.i &&
      isNear(hRim.p, hLeft.p, cfg.symTol) && lHandle.p > lBot.p && lHandle.p < hRim.p) {
    const cupH = hRim.p - lBot.p;
    const depth = hRim.p > 0 ? cupH / hRim.p : 0;
    const retr = cupH > 0 ? (hRim.p - lHandle.p) / cupH : 1;
    const b = findBreakIdx(ctx, hRim.i, hRim.p, bar, hRim.p, true, bar);
    const cupDur = hRim.i - hLeft.i, hdlDur = b != null ? b - hRim.i : -1;
    const shape = depth >= 0.03 && depth <= 0.50 && retr <= 0.50 &&
      hdlDur > 0 && cupDur > 0 && hdlDur <= cupDur;
    if (b != null && shape && isValidSize(ctx, cupH, bar)) {
      const s = setup(ctx, { bIdx: b, isBull: true, anchor: lHandle.p });
      const nk = neckAtBreak(hLeft.i, hLeft.p, hRim.i, hRim.p, b);
      if (s.ok) out.push(mk("Cup & Handle", true, {
        ...s, startIdx: hLeft.i,
        fill: { u: [hLeft.i, hLeft.p, b, nk], l: [hLeft.i, lBot.p, b, lHandle.p] },
        lines: { u: [hLeft.i, hRim.p, b, nk] },
      }));
    }
  }

  const [lRim, lLeft] = PL, [hHandle, hTop] = PH;
  if (hHandle.i > lRim.i && lRim.i > hTop.i && hTop.i > lLeft.i &&
      isNear(lRim.p, lLeft.p, cfg.symTol) && hHandle.p < hTop.p && hHandle.p > lRim.p) {
    const cupH = hTop.p - lRim.p;
    const depth = hTop.p > 0 ? cupH / hTop.p : 0;
    const retr = cupH > 0 ? (hHandle.p - lRim.p) / cupH : 1;
    const b = findBreakIdx(ctx, lRim.i, lRim.p, bar, lRim.p, false, bar);
    const cupDur = lRim.i - lLeft.i, hdlDur = b != null ? b - lRim.i : -1;
    const shape = depth >= 0.03 && depth <= 0.50 && retr <= 0.50 &&
      hdlDur > 0 && cupDur > 0 && hdlDur <= cupDur;
    if (b != null && shape && isValidSize(ctx, cupH, bar)) {
      const s = setup(ctx, { bIdx: b, isBull: false, anchor: hHandle.p });
      const nk = neckAtBreak(lLeft.i, lLeft.p, lRim.i, lRim.p, b);
      if (s.ok) out.push(mk("Inv Cup & Handle", false, {
        ...s, startIdx: lLeft.i,
        fill: { u: [lLeft.i, hTop.p, b, hHandle.p], l: [lLeft.i, lLeft.p, b, nk] },
        lines: { l: [lLeft.i, lRim.p, b, nk] },
      }));
    }
  }
  return out;
}

// Geometria comun de las figuras de dos rectas (flags, cunas, triangulos).
function twoLineGeometry(h1, h2, l1, l2, b) {
  const sb = Math.min(h2.i, l2.i);
  const us = project(h2.i, h2.p, h1.i, h1.p, sb), ub = project(h2.i, h2.p, h1.i, h1.p, b);
  const ls = project(l2.i, l2.p, l1.i, l1.p, sb), lb = project(l2.i, l2.p, l1.i, l1.p, b);
  return {
    startIdx: sb,
    fill: { u: [sb, us, b, ub], l: [sb, ls, b, lb] },
    lines: { u: [sb, us, b, ub], l: [sb, ls, b, lb] },
  };
}

// Banderas y banderines. El asta se valida por DESPLAZAMIENTO CON SIGNO (no por rango):
// una bandera alcista exige un asta que realmente subio.
function detectFlagPennant(ctx, pv, bar) {
  const { cfg } = ctx;
  const out = [];
  if (pv.highs.length < 2 || pv.lows.length < 2) return out;
  const [h1, h2] = pv.highs, [l1, l2] = pv.lows;
  const A = ctx.atr[bar] ?? 0;
  if (!A) return out;

  const start = Math.min(h2.i, l2.i);
  const poleLen = Math.max(1, Math.min(200, bar - start + 1));
  const poleFrom = Math.max(0, bar - poleLen);
  const poleDir = ctx.closes[bar] - ctx.closes[poleFrom];
  const poleUp = poleDir > A * 3, poleDn = poleDir < -A * 3;

  const su = h1.i === h2.i ? 0 : (h1.p - h2.p) / Math.max(1, h1.i - h2.i);
  const sl = l1.i === l2.i ? 0 : (l1.p - l2.p) / Math.max(1, l1.i - l2.i);
  // Pendientes normalizadas por ATR -> el criterio es portable entre temporalidades.
  const parallel = isNear(su / A, sl / A, 0.2);

  if (poleUp && su < 0 && sl < 0) {
    const b = findBreakIdx(ctx, h2.i, h2.p, h1.i, h1.p, true, bar);
    if (b != null && ((parallel && cfg.show.flag) || (!parallel && cfg.show.pennant))) {
      const lowBrk = project(l2.i, l2.p, l1.i, l1.p, b);
      const s = setup(ctx, { bIdx: b, isBull: true, anchor: lowBrk });
      if (s.ok) out.push(mk(parallel ? "Bullish Flag" : "Bullish Pennant", true,
        { ...s, ...twoLineGeometry(h1, h2, l1, l2, b) }));
    }
  } else if (poleDn && su > 0 && sl > 0) {
    const b = findBreakIdx(ctx, l2.i, l2.p, l1.i, l1.p, false, bar);
    if (b != null && ((parallel && cfg.show.flag) || (!parallel && cfg.show.pennant))) {
      const upBrk = project(h2.i, h2.p, h1.i, h1.p, b);
      const s = setup(ctx, { bIdx: b, isBull: false, anchor: upBrk });
      if (s.ok) out.push(mk(parallel ? "Bearish Flag" : "Bearish Pennant", false,
        { ...s, ...twoLineGeometry(h1, h2, l1, l2, b) }));
    }
  }
  return out;
}

function detectWedge(ctx, pv, bar) {
  const { cfg } = ctx;
  const out = [];
  if (!cfg.show.wedge || pv.highs.length < 2 || pv.lows.length < 2) return out;
  const [h1, h2] = pv.highs, [l1, l2] = pv.lows;
  const su = h1.i === h2.i ? 0 : (h1.p - h2.p) / Math.max(1, h1.i - h2.i);
  const sl = l1.i === l2.i ? 0 : (l1.p - l2.p) / Math.max(1, l1.i - l2.i);
  const heightNow = project(h2.i, h2.p, h1.i, h1.p, bar) - project(l2.i, l2.p, l1.i, l1.p, bar);
  if (heightNow <= 0) return out;

  // Cuna descendente: ambas rectas bajan y la inferior baja MAS -> convergen. Sesgo alcista.
  if (su < 0 && sl < 0 && sl < su) {
    const b = findBreakIdx(ctx, h2.i, h2.p, h1.i, h1.p, true, bar);
    if (b != null) {
      const s = setup(ctx, { bIdx: b, isBull: true, anchor: project(l2.i, l2.p, l1.i, l1.p, b) });
      if (s.ok) out.push(mk("Falling Wedge", true, { ...s, ...twoLineGeometry(h1, h2, l1, l2, b) }));
    }
  } else if (su > 0 && sl > 0 && sl > su) {
    const b = findBreakIdx(ctx, l2.i, l2.p, l1.i, l1.p, false, bar);
    if (b != null) {
      const s = setup(ctx, { bIdx: b, isBull: false, anchor: project(h2.i, h2.p, h1.i, h1.p, b) });
      if (s.ok) out.push(mk("Rising Wedge", false, { ...s, ...twoLineGeometry(h1, h2, l1, l2, b) }));
    }
  }
  return out;
}

function detectTriangles(ctx, pv, bar) {
  const { cfg } = ctx;
  const out = [];
  if (!cfg.show.triangle || pv.highs.length < 2 || pv.lows.length < 2) return out;
  const [h1, h2] = pv.highs, [l1, l2] = pv.lows;
  const A = ctx.atr[bar] ?? 0;
  if (!A) return out;
  const su = (h1.i === h2.i ? 0 : (h1.p - h2.p) / Math.max(1, h1.i - h2.i)) / A;
  const sl = (l1.i === l2.i ? 0 : (l1.p - l2.p) / Math.max(1, l1.i - l2.i)) / A;
  const FLAT = 0.03; // tolerancia de "plano" en ATR por barra (adimensional entre timeframes)

  const start = Math.min(h2.i, l2.i);
  const base = Math.abs(project(h2.i, h2.p, h1.i, h1.p, start) - project(l2.i, l2.p, l1.i, l1.p, start));
  const converging = project(h2.i, h2.p, h1.i, h1.p, bar) > project(l2.i, l2.p, l1.i, l1.p, bar);
  if (!converging || !isValidSize(ctx, base, bar)) return out;

  if ((su < 0 && sl > 0) || (Math.abs(su) < FLAT && sl > 0)) {
    const b = findBreakIdx(ctx, h2.i, h2.p, h1.i, h1.p, true, bar);
    if (b != null) {
      const s = setup(ctx, { bIdx: b, isBull: true, anchor: project(l2.i, l2.p, l1.i, l1.p, b) });
      if (s.ok) out.push(mk(Math.abs(su) < FLAT ? "Ascending Triangle" : "Symmetrical Triangle", true,
        { ...s, ...twoLineGeometry(h1, h2, l1, l2, b) }));
    }
  }
  if ((su < 0 && sl > 0) || (su < 0 && Math.abs(sl) < FLAT)) {
    const b = findBreakIdx(ctx, l2.i, l2.p, l1.i, l1.p, false, bar);
    if (b != null) {
      const s = setup(ctx, { bIdx: b, isBull: false, anchor: project(h2.i, h2.p, h1.i, h1.p, b) });
      if (s.ok) out.push(mk(Math.abs(sl) < FLAT ? "Descending Triangle" : "Symmetrical Triangle", false,
        { ...s, ...twoLineGeometry(h1, h2, l1, l2, b) }));
    }
  }
  return out;
}

function detectRectangles(ctx, pv, bar) {
  const { cfg } = ctx;
  const out = [];
  if (!cfg.show.rect || pv.highs.length < 2 || pv.lows.length < 2) return out;
  const [h1, h2] = pv.highs, [l1, l2] = pv.lows;
  const A = ctx.atr[bar] ?? 0;
  if (!A) return out;
  const su = (h1.i === h2.i ? 0 : (h1.p - h2.p) / Math.max(1, h1.i - h2.i)) / A;
  const sl = (l1.i === l2.i ? 0 : (l1.p - l2.p) / Math.max(1, l1.i - l2.i)) / A;
  if (Math.abs(su) >= 0.05 || Math.abs(sl) >= 0.05) return out; // debe ser plano

  const top = (h1.p + h2.p) / 2, bot = (l1.p + l2.p) / 2;
  const start = Math.min(h2.i, l2.i);
  if (!isValidSize(ctx, top - bot, bar)) return out;

  const bu = findBreakIdx(ctx, start, top, bar, top, true, bar);
  if (bu != null) {
    const s = setup(ctx, { bIdx: bu, isBull: true, anchor: bot });
    if (s.ok) out.push(mk("Rectangle", true, {
      ...s, startIdx: h2.i,
      fill: { u: [start, top, bu, top], l: [start, bot, bu, bot] },
      lines: { u: [start, top, bu, top], l: [start, bot, bu, bot] },
    }));
  }
  const bd = findBreakIdx(ctx, start, bot, bar, bot, false, bar);
  if (bd != null) {
    const s = setup(ctx, { bIdx: bd, isBull: false, anchor: top });
    if (s.ok) out.push(mk("Rectangle", false, {
      ...s, startIdx: h2.i,
      fill: { u: [start, top, bd, top], l: [start, bot, bd, bot] },
      lines: { u: [start, top, bd, top], l: [start, bot, bd, bot] },
    }));
  }
  return out;
}

/* ---------- Orquestador ----------
   Prioridad del patron MAS ESPECIFICO al MAS GENERAL: un H&S mal clasificado como
   "rectangulo" pierde toda su informacion. */
const PRIORITY = [
  "Head & Shoulders", "Inv Head & Shoulders",
  "Triple Top", "Triple Bottom",
  "Cup & Handle", "Inv Cup & Handle",
  "Double Top", "Double Bottom",
  "Falling Wedge", "Rising Wedge",
  "Ascending Triangle", "Descending Triangle", "Symmetrical Triangle",
  "Bullish Flag", "Bearish Flag", "Bullish Pennant", "Bearish Pennant",
  "Rectangle",
];
const rank = (name) => {
  const i = PRIORITY.indexOf(name);
  return i < 0 ? PRIORITY.length : i;
};

// Detecta TODAS las figuras validas en la barra `bar`. `drop` rota los pivotes para
// explorar combinaciones mas antiguas (cosecha de muestras).
export function detectAt(ctx, allPivots, bar, drop = 0) {
  const { cfg } = ctx;
  if (bar < warmupBars(cfg)) return [];
  const pv = pivotsAt(allPivots, bar, cfg.maxPivots, drop);
  if (pv.highs.length < 2 || pv.lows.length < 2) return [];

  const found = [
    ...detectHS(ctx, pv, bar),
    ...detectTriple(ctx, pv, bar),
    ...detectCup(ctx, pv, bar),
    ...detectDouble(ctx, pv, bar),
    ...detectWedge(ctx, pv, bar),
    ...detectTriangles(ctx, pv, bar),
    ...detectFlagPennant(ctx, pv, bar),
    ...detectRectangles(ctx, pv, bar),
  ];

  // Validacion geometrica global: descarta figuras absurdamente anchas/estrechas y
  // "triangulos" que en realidad son dos rectas por las que el precio nunca paso dentro.
  const valid = found.filter((r) => {
    if (!validWidth(cfg, r.startIdx, r.breakoutIdx)) return false;
    if (r.fill && !contained(ctx, r.fill.u, r.fill.l)) return false;
    if (cfg.trendFilter) {
      const e = ctx.ema[r.breakoutIdx];
      if (e != null) {
        const c = ctx.closes[r.breakoutIdx];
        if (r.isBullish ? c <= e : c >= e) return false;
      }
    }
    return true;
  });

  valid.forEach((r) => { r.latency = bar - r.breakoutIdx; });
  return valid.sort((a, b) => rank(a.name) - rank(b.name) || a.latency - b.latency);
}

// La figura operable en la barra `bar`: la de mayor prioridad que ademas llega a tiempo.
export function detectBest(ctx, allPivots, bar) {
  return detectAt(ctx, allPivots, bar).find((r) => r.latency <= ctx.cfg.maxLatency) ?? null;
}

/* ---------- Vector de features para el cerebro ----------
   TODO se lee en la barra del BREAKOUT: nunca con informacion posterior. Todas las
   features son adimensionales o estan normalizadas por ATR, asi que son portables
   entre simbolos y temporalidades (requisito del modelo federado). */
export function buildFeatures(ctx, r, patternStats = {}) {
  const b = r.breakoutIdx;
  const A = Math.max(ctx.atr[b] ?? 0, 1e-9);
  const dir = r.isBullish ? 1 : -1;
  const volr = ctx.volSma[b] > 0 ? ctx.vols[b] / ctx.volSma[b] : 1;
  const hgt = Math.abs((r.tp2 ?? 0) - (r.entry ?? 0));
  const risk = Math.max(Math.abs((r.entry ?? 0) - (r.stop ?? 0)), 1e-9);
  const dur = Math.max(1, b - r.startIdx);
  const st = patternStats[r.name] ?? { w: 0, l: 0 };

  const x = new Array(15).fill(0);
  x[0] = 1.0;
  x[1] = (r.latency ?? 0) / ctx.cfg.maxLatency;
  x[2] = Math.log(Math.max(0.05, volr));
  x[3] = dir * (ctx.closes[b] - (ctx.ema[b] ?? ctx.closes[b])) / A;
  x[4] = Math.log(1 + hgt / A);
  x[5] = Math.min(10, hgt / risk);
  x[6] = Math.min(4, dur / 50);
  x[7] = dir * ((ctx.rsi[b] ?? 50) - 50) / 50;
  x[8] = ctx.kamaEr[b] ?? 0;
  x[9] = ctx.atrBase[b] > 0 ? A / ctx.atrBase[b] : 1;
  x[10] = (st.w + 2) / (st.w + st.l + 4);                    // prior Beta(2,2) del patron
  x[11] = dir * Math.max(-6, Math.min(6, ctx.bm?.align?.[b] ?? 0));
  x[12] = Math.max(0.2, Math.min(4, ctx.bm?.vol?.[b] ?? 1));
  x[13] = ctx.cfg.smcOn ? dir * (ctx.sweepBias[b] ?? 0) : 0;
  x[14] = ctx.cfg.smcOn
    ? (r.isBullish ? 1 - (ctx.smcPos[b] ?? 0.5) : (ctx.smcPos[b] ?? 0.5))
    : 0.5;
  return x;
}
