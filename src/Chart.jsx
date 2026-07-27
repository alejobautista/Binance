import React, { useMemo } from "react";
import { ema, structureEngine, fmt, fmtQ } from "./signalCore.js";

const COL = {
  green: "#00d4aa", red: "#ff4d6d", amber: "#fbbf24", accent: "#3b82f6",
  violet: "#a78bfa", dim: "#6b7280", border: "#1f2937", text: "#e5e7eb",
};

/* Grafico de velas SVG: velas 15m cerradas + EMAs + pivotes + niveles del setup + muros
   + bitacora del usuario (ops abiertas con lineas fijas, cerradas con marcador de resultado). */
export function CandleChart({ candles, sig, depthInfo, ops }) {
  const model = useMemo(() => {
    if (!candles || candles.length < 30) return null;
    const N = 96;
    const data = candles.slice(-N);
    const off = candles.length - data.length;
    const closes = candles.map((c) => c.close);
    const emas = [
      { arr: ema(closes, 9), color: COL.amber },
      { arr: ema(closes, 21), color: COL.accent },
      { arr: ema(closes, 50), color: COL.dim },
    ];
    const st = structureEngine(candles);
    const pivots = st.seq.filter((p) => p.i >= off && p.label !== "H" && p.label !== "L");

    let lo = Math.min(...data.map((c) => c.low));
    let hi = Math.max(...data.map((c) => c.high));
    const range0 = hi - lo || 1;
    // incluir niveles del setup si no quedan absurdamente lejos
    const levels = [];
    if (sig?.dir && sig.entry != null) {
      levels.push({ p: sig.entry, label: "IN", color: COL.accent, dash: "" });
      levels.push({ p: sig.stop, label: "SL", color: COL.red, dash: "5,4" });
      (sig.tps ?? []).forEach((t, i) => levels.push({ p: t.price, label: `TP${i + 1}`, color: COL.green, dash: "5,4" }));
    }
    // bitacora: ops ABIERTAS del par se dibujan con lineas solidas que NO se mueven
    const opLevels = [];
    for (const op of ops ?? []) {
      if (op.outcome !== "open") continue;
      opLevels.push({ p: op.entry, label: "MI IN", color: COL.violet });
      opLevels.push({ p: op.stop, label: "MI SL", color: COL.red });
      (op.tps ?? []).forEach((t, i) => opLevels.push({ p: t.price, label: `MI TP${i + 1}`, color: COL.green }));
    }
    for (const l of [...levels, ...opLevels]) {
      if (l.p > hi && l.p < hi + range0 * 0.6) hi = l.p;
      if (l.p < lo && l.p > lo - range0 * 0.6) lo = l.p;
    }
    const pad = (hi - lo) * 0.05;
    hi += pad; lo -= pad;

    // ops CERRADAS: marcador en la vela donde se abrio (si cae en la ventana visible)
    const closedMarks = [];
    for (const op of ops ?? []) {
      if (op.outcome === "open" || op.r == null) continue;
      let idx = -1;
      for (let i = 0; i < data.length; i++) {
        if (op.ts >= data[i].time && (i === data.length - 1 || op.ts < data[i + 1].time)) { idx = i; break; }
      }
      if (idx < 0) continue;
      closedMarks.push({
        i: idx, dir: op.dir, price: op.entry, r: op.r,
        win: op.r > 0,
      });
    }

    const walls = depthInfo
      ? [...depthInfo.buyWalls.map((w) => ({ ...w, color: COL.green })),
         ...depthInfo.sellWalls.map((w) => ({ ...w, color: COL.red }))]
          .filter((w) => w.price > lo && w.price < hi)
      : [];

    // Geometria de la figura chartista: los indices vienen referidos a las velas CERRADAS
    // que analizo el detector, asi que se traducen a la ventana visible del grafico.
    // El detector corre sobre candles.slice(0,-1); la vela viva no desplaza los indices.
    let pattern = null;
    if (sig?.pattern?.lines || sig?.pattern?.fill) {
      const p = sig.pattern;
      const seg = (s) => (s ? { x1: s[0] - off, y1: s[1], x2: s[2] - off, y2: s[3] } : null);
      const segs = [seg(p.lines?.u), seg(p.lines?.l), seg(p.fill?.u), seg(p.fill?.l)]
        .filter((s) => s && s.x2 > 0 && s.x1 < data.length && s.y1 != null && s.y2 != null);
      // Deduplica: fill y lines suelen compartir la misma recta.
      const uniq = [];
      for (const s of segs) {
        if (!uniq.some((u) => Math.abs(u.x1 - s.x1) < 0.5 && Math.abs(u.y1 - s.y1) < 1e-9 &&
                              Math.abs(u.x2 - s.x2) < 0.5 && Math.abs(u.y2 - s.y2) < 1e-9)) uniq.push(s);
      }
      if (uniq.length) {
        pattern = {
          segs: uniq, name: p.name, bull: p.isBullish,
          brkX: p.breakoutIdx - off,
        };
      }
    }

    return { data, off, emas, pivots, lo, hi, levels, opLevels, closedMarks, walls, pattern };
  }, [candles, sig, depthInfo, ops]);

  if (!model) return null;
  const { data, off, emas, pivots, lo, hi, levels, opLevels, closedMarks, walls, pattern } = model;

  const W = 800, H = 320, VH = 42, PADT = 10, PADR = 74;
  const plotH = H - VH - PADT - 6;
  const X = (i) => ((i + 0.5) * (W - PADR)) / data.length;
  const Y = (p) => PADT + ((hi - p) / (hi - lo)) * plotH;
  const Yc = (p) => Math.max(PADT - 4, Math.min(PADT + plotH + 4, Y(p)));
  const bw = Math.max(2, ((W - PADR) / data.length) * 0.62);
  const maxVol = Math.max(...data.map((c) => c.volume)) || 1;

  const linePath = (arr) => {
    let d = "", pen = false;
    for (let i = 0; i < data.length; i++) {
      const v = arr[off + i];
      if (v == null) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Yc(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const ticks = [0, 1, 2, 3].map((k) => lo + ((hi - lo) * k) / 3);
  const tIdx = [0, Math.floor(data.length / 2), data.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {/* rejilla + escala de precio */}
      {ticks.map((p, i) => (
        <g key={i}>
          <line x1={0} x2={W - PADR} y1={Y(p)} y2={Y(p)} stroke={COL.border} strokeWidth="1" />
          <text x={W - PADR + 6} y={Y(p) + 3} fill={COL.dim} fontSize="11" fontFamily="inherit">{fmt(p)}</text>
        </g>
      ))}

      {/* muros del libro */}
      {walls.map((w, i) => (
        <g key={`w${i}`}>
          <line x1={0} x2={W - PADR} y1={Y(w.price)} y2={Y(w.price)} stroke={w.color} strokeWidth="4" opacity="0.18" />
          <text x={4} y={Y(w.price) - 3} fill={w.color} fontSize="10" opacity="0.9" fontFamily="inherit">
            muro {fmtQ(w.quote)}
          </text>
        </g>
      ))}

      {/* EMAs */}
      {emas.map((e, i) => (
        <path key={`e${i}`} d={linePath(e.arr)} fill="none" stroke={e.color} strokeWidth="1.4" opacity="0.85" />
      ))}

      {/* velas */}
      {data.map((c, i) => {
        const up = c.close >= c.open;
        const col = up ? COL.green : COL.red;
        const yO = Y(c.open), yC = Y(c.close);
        return (
          <g key={i}>
            <line x1={X(i)} x2={X(i)} y1={Y(c.high)} y2={Y(c.low)} stroke={col} strokeWidth="1" />
            <rect
              x={X(i) - bw / 2} y={Math.min(yO, yC)}
              width={bw} height={Math.max(1, Math.abs(yO - yC))}
              fill={col}
            />
          </g>
        );
      })}

      {/* pivotes HH/HL/LH/LL */}
      {pivots.map((p, i) => {
        const bull = p.label === "HH" || p.label === "HL";
        const isHigh = p.kind === "H";
        return (
          <text key={`p${i}`} x={X(p.i - off)} y={isHigh ? Y(p.price) - 6 : Y(p.price) + 14}
            fill={bull ? COL.green : COL.red} fontSize="10" fontWeight="700"
            textAnchor="middle" fontFamily="inherit">
            {p.label}
          </text>
        );
      })}

      {/* figura chartista detectada (rectas del patron + marca de la ruptura) */}
      {pattern && (
        <g>
          {pattern.segs.map((s, i) => (
            <line key={`pt${i}`}
              x1={X(Math.max(0, s.x1))} y1={Yc(s.y1)}
              x2={X(Math.min(data.length - 1, s.x2))} y2={Yc(s.y2)}
              stroke={pattern.bull ? COL.green : COL.red}
              strokeWidth="1.6" opacity="0.75" strokeDasharray="6,3" />
          ))}
          {pattern.brkX >= 0 && pattern.brkX < data.length && (
            <line x1={X(pattern.brkX)} x2={X(pattern.brkX)} y1={PADT} y2={PADT + plotH}
              stroke={COL.violet} strokeWidth="1" opacity="0.5" strokeDasharray="2,4" />
          )}
          <text x={X(Math.max(0, Math.min(data.length - 1, pattern.brkX)))} y={PADT + 12}
            fill={pattern.bull ? COL.green : COL.red} fontSize="10" fontWeight="700"
            textAnchor="end" fontFamily="inherit">
            {pattern.name}
          </text>
        </g>
      )}

      {/* niveles del setup */}
      {levels.map((l, i) => (
        <g key={`l${i}`}>
          <line x1={0} x2={W - PADR} y1={Y(l.p)} y2={Y(l.p)} stroke={l.color} strokeWidth="1.2"
            strokeDasharray={l.dash} opacity="0.9" />
          <text x={W - PADR + 6} y={Y(l.p) + 3} fill={l.color} fontSize="10" fontWeight="700" fontFamily="inherit">
            {l.label} {fmt(l.p)}
          </text>
        </g>
      ))}

      {/* bitacora: niveles FIJOS de tus operaciones abiertas (linea solida gruesa) */}
      {opLevels.map((l, i) => (
        <g key={`o${i}`}>
          <line x1={0} x2={W - PADR} y1={Y(l.p)} y2={Y(l.p)} stroke={l.color} strokeWidth="2" opacity="0.75" />
          <text x={4} y={Y(l.p) - 3} fill={l.color} fontSize="10" fontWeight="700" fontFamily="inherit">
            {l.label} {fmt(l.p)}
          </text>
        </g>
      ))}

      {/* bitacora: operaciones cerradas (marcador con resultado en la vela de entrada) */}
      {closedMarks.map((m, i) => {
        const col = m.win ? COL.green : COL.red;
        const y = Y(m.price);
        const pts = m.dir === "long"
          ? `${X(m.i) - 5},${y + 8} ${X(m.i) + 5},${y + 8} ${X(m.i)},${y}`
          : `${X(m.i) - 5},${y - 8} ${X(m.i) + 5},${y - 8} ${X(m.i)},${y}`;
        return (
          <g key={`cm${i}`}>
            <polygon points={pts} fill={col} opacity="0.95" />
            <text x={X(m.i)} y={m.dir === "long" ? y + 22 : y - 14} fill={col} fontSize="10"
              fontWeight="700" textAnchor="middle" fontFamily="inherit">
              {m.win ? "✓" : "✗"} {m.r >= 0 ? "+" : ""}{m.r.toFixed(1)}R
            </text>
          </g>
        );
      })}

      {/* volumen coloreado por delta ejecutado */}
      {data.map((c, i) => {
        const frac = c.takerBuy != null && c.volume > 0 ? c.takerBuy / c.volume : (c.close >= c.open ? 0.6 : 0.4);
        const h = (c.volume / maxVol) * VH;
        return (
          <rect key={`v${i}`} x={X(i) - bw / 2} y={H - 4 - h} width={bw} height={h}
            fill={frac >= 0.5 ? COL.green : COL.red} opacity="0.45" />
        );
      })}

      {/* etiquetas de tiempo */}
      {tIdx.map((i) => (
        <text key={`t${i}`} x={X(i)} y={H - VH - 12} fill={COL.dim} fontSize="10"
          textAnchor="middle" fontFamily="inherit">
          {new Date(data[i].time).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
        </text>
      ))}
    </svg>
  );
}

/* Curva de R acumulado: cada punto es una senal resuelta, en orden temporal. */
export function EquityCurve({ series }) {
  const model = useMemo(() => {
    const valid = (series ?? []).filter((s) => s.points.length >= 2);
    if (!valid.length) return null;
    let mn = 0, mx = 0;
    for (const s of valid) for (const v of s.points) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    if (mx - mn < 1) { mx += 1; mn -= 1; }
    const pad = (mx - mn) * 0.08;
    return { valid, lo: mn - pad, hi: mx + pad };
  }, [series]);

  if (!model) return null;
  const { valid, lo, hi } = model;
  const W = 800, H = 200, PADR = 50, PADT = 8;
  const Y = (v) => PADT + ((hi - v) / (hi - lo)) * (H - PADT * 2);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {[lo + (hi - lo) * 0.15, 0, hi - (hi - lo) * 0.15].map((v, i) => (
        <g key={i}>
          <line x1={0} x2={W - PADR} y1={Y(v)} y2={Y(v)} stroke={COL.border} strokeWidth="1"
            strokeDasharray={v === 0 ? "" : "3,4"} opacity={v === 0 ? 1 : 0.6} />
          <text x={W - PADR + 6} y={Y(v) + 3} fill={COL.dim} fontSize="11" fontFamily="inherit">
            {v >= 0 ? "+" : ""}{v.toFixed(1)}R
          </text>
        </g>
      ))}
      {valid.map((s, si) => {
        const X = (i) => (i / (s.points.length - 1)) * (W - PADR);
        const d = s.points.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
        return <path key={si} d={d} fill="none" stroke={s.color} strokeWidth="1.8" opacity="0.95" />;
      })}
    </svg>
  );
}
