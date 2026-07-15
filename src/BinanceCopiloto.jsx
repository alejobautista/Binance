import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { fetchJson, fetchCandles, fetchDepth, analyzeDepth, fmt, fmtQ, evaluate, evaluateAll, analyzeTF, STRATEGIES } from "./signalCore.js";
import { STABLES, assetCat, CAT_LABELS, SUBCAT_LABELS, subCat } from "./categories.js";
import {
  recordSignal, markTaken, getSignals, probability, resolveOpenSignals,
  stats as trackerStats, runBacktest, exportJSON, importJSON, clearAll, getBtSample,
} from "./tracker.js";
import { CandleChart, EquityCurve } from "./Chart.jsx";

/* ---------- UI helpers ---------- */
const C = {
  bg: "#0a0e17", panel: "#111827", panel2: "#0d1420", border: "#1f2937",
  text: "#e5e7eb", dim: "#6b7280", green: "#00d4aa", red: "#ff4d6d", amber: "#fbbf24", accent: "#3b82f6",
};

const HELP = {
  senal: "La senal sale de la estrategia activa. INDICADORES: cada indicador encendido vota alcista, bajista o neutro mirando la ultima vela cerrada de 15m; se necesita mayoria (2/3 de los activos) en la misma direccion. ESTRUCTURA: se opera el ultimo BOS o CHoCH reciente. Despues pasan los filtros de riesgo (sesgo 4h/1h, sobreextension, recorrido libre): si uno falla en modo ESTRICTO la senal se bloquea y aqui se dice cual fue. La confianza resume cuan unanime fue el voto y cuantas advertencias quedaron.",
  prob: "Mide como les fue a senales PARECIDAS a esta en el pasado (misma estrategia, direccion, confianza, categoria de la moneda...). Combina dos calculos: un modelo de aprendizaje continuo que se ajusta con cada resultado nuevo, y el conteo real de ganadas/perdidas por segmento. n = cuantas senales respaldan el numero; con pocas muestras el numero vale poco. Las flechas muestran que factores suben o bajan la probabilidad de ESTA senal.",
  nucleo: "Como vota cada indicador sobre la ultima vela CERRADA de 15m: EMAs 9/21 = direccion de corto plazo (cruce alcista/bajista confirmado al cierre). RSI = fuerza; >55 alcista, <45 bajista, y en extremos frena: >70 bloquea largos (perseguir sobrecompra), <30 bloquea cortos. MACD = momentum (linea vs senal). Bollinger = posicion vs banda media, y en las bandas exteriores avisa sobreextension. La entrada requiere mayoria de votos en una direccion.",
  contexto: "Informacion que ayuda a leer la situacion pero NO vota: el volumen valida rupturas (una ruptura sin volumen es sospechosa de trampa) y el soporte/resistencia son los extremos de las ultimas 30 velas, que el motor usa para colocar el stop y medir el recorrido libre.",
  pivotes: "Un pivote es un maximo o minimo local que se confirma 3 velas despues de formarse (por eso no repinta). Se etiqueta comparando con el pivote anterior del mismo tipo: HH = maximo mas alto y HL = minimo mas alto (estructura alcista); LH = maximo mas bajo y LL = minimo mas bajo (estructura bajista). 'Roto' = el precio ya cerro mas alla de ese nivel.",
  eventos: "BOS (Break of Structure) = el cierre rompe el ultimo swing A FAVOR de la tendencia: continuacion. CHoCH (Change of Character) = rompe EN CONTRA (ej.: venia bajista con LH/LL y cierra sobre el ultimo LH): posible giro. Solo se opera si el evento es reciente (menos de 12 velas) y, en estricto, si la estructura de 1h no lo contradice. El stop va al otro lado del swing vigente.",
  tabla: "La misma foto en tres marcos temporales: 4h y 1h definen el sesgo mayor (en estricto no se opera contra el), 15m da el gatillo de entrada. EMA en verde = el precio esta por encima (alcista). ATR = cuanto se mueve una vela tipica; con el se coloca el stop y se detecta sobreextension.",
  niveles: "El stop va donde la senal queda invalidada: 1.8 ATR o el soporte/swing (lo que quede mas lejos), nunca un numero magico. Los TP son escalonados (40% a 1R, 35% a 1.8R, 25% a 3R): aseguras ganancia y dejas correr el resto; tras TP1 el stop sube a break-even y la operacion ya no puede perder. Recorrido libre = espacio hasta el proximo obstaculo estructural; si es <1.5R el premio no justifica el riesgo. Apalancamiento maximo seguro = el mayor que deja la liquidacion MAS ALLA del stop.",
  tamano: "Regla de oro de gestion de riesgo: arriesgar solo 1-2% del capital por operacion. El tamano sale de ahi: riesgo maximo en USDT dividido por la distancia al stop. Asi, 5 perdidas seguidas cuestan menos del 10% de la cuenta y sigues operando.",
  mipos: "Si entraste con otro precio, otro monto u otro apalancamiento (o ya estabas dentro cuando salio la senal), escribelo aqui: se recalculan TUS ratios reales - cuanto pierdes si toca el stop, cuanto ganas en cada TP, tu R/B ponderado y donde queda TU liquidacion. El plan sugerido no cambia: esto compara tu ejecucion contra el plan.",
  chart: "Ultimas ~96 velas cerradas de 15m. Lineas: EMA9 (amarilla), EMA21 (azul), EMA50 (gris). Letras verdes/rojas = pivotes HH/HL (alcistas) y LH/LL (bajistas). Lineas punteadas = tu setup: IN entrada, SL stop, TP1-3 objetivos. Franjas translucidas = muros del libro de ordenes. Barras de abajo = volumen, coloreado por quien ejecuto mas (verde = compradores agresivos, rojo = vendedores).",
  flujo: "A diferencia del libro (ordenes en espera, cancelables), esto es volumen YA EJECUTADO: que porcentaje de lo negociado fue comprado con ordenes de mercado (agresores). Mas del 55% sostenido = presion compradora real; menos del 45% = vendedora. No se puede fingir porque son operaciones cerradas.",
  posiciones: "Tus senales marcadas con LA TOME que siguen abiertas. Muestra el precio actual contra la entrada registrada, el avance en R (1R = la distancia de tu stop) y te avisa cuando toca mover el stop a break-even. Los datos se resuelven definitivamente con VERIFICAR RESULTADOS.",
  curva: "Cada punto es una senal resuelta, en orden temporal; la altura es la suma de R ganados/perdidos hasta ahi. Una curva que sube de forma sostenida = el motor tiene ventaja; una que baja o va plana = no la tiene (y la probabilidad te lo reflejara). La linea ambar es la muestra del backtest; la verde, senales en vivo.",
  ichimoku: "Sistema japones completo (Hosoda, 1969). Entrada por TRIPLE confirmacion: precio fuera de la nube (Kumo) + cruce Tenkan/Kijun a favor + Chikou libre del precio de hace 26 velas; los cruces DENTRO de la nube se ignoran siempre. El stop va en la Kijun-sen o al otro lado de la nube. Fuerte en tendencias limpias, casi inutil en rangos. Evidencia mixta: 53.7% de aciertos en forex vs 10% en un test de acciones - depende del activo, valida con el backtest.",
  keltner: "Reversion a la media: tras un extremo (banda Keltner de 3.9 ATR sobre EMA50) se espera el resorte de vuelta al centro. Entrada: extremo tocado + re-entrada confirmada sobre/bajo la banda 2.7 + CCI cruzando ±40. Solo apta cuando NO hay tendencia fuerte: con ADX ≥30 se bloquea (en estricto), porque comprar cada toque de banda en una tendencia es ponerse delante de un tren.",
  donchian: "Sistema Turtle (Dennis/Eckhardt, 1983): comprar fuerza, vender debilidad. Entrada: CIERRE fuera del canal de 55 velas + ADX>25 + DMI a favor; volumen >150% de la media da conviccion. Stop inicial: 2 ATR (2N). Advertencia honesta: historicamente acierta solo 35-40% de las veces - gana porque los aciertos son 3-5 veces mas grandes que las perdidas, no por acertar mucho. Exige estomago para rachas perdedoras.",
  supertrend: "Confluencia de tres sistemas de Wilder/volatilidad: SuperTrend (10, 3.0) da direccion, ADX/DMI da fuerza (>25) y el Parabolic SAR acompana como trailing. Regla de oro: ADX<20 = sistema APAGADO (el 60% de los flips del SAR en rango pierden). El stop usa la linea SuperTrend/SAR, que se mueve con el precio.",
  avwap: "Flujo de dinero institucional (Brian Shannon): el VWAP anclado al minimo/maximo del swing muestra quien controla desde ese evento; CMF>+0.05 confirma acumulacion real y el MFI evita comprar sobrecompra de flujo. Filosofia: comprar fuerza DESPUES del retroceso, no perseguir extension (>2.5 ATR del ancla = advertencia). Dos cierres contra el AVWAP invalidan la tesis.",
  senales: "Cada vez que escaneas, la app corre las 8 estrategias sobre los pares con mas volumen del filtro activo. Aqui aparece cada senal con la ESTRATEGIA que la pidio y su probabilidad historica. Todas se registran automaticamente en el Record y se verifican contra el precio real aunque tu no las operes - asi el motor aprende que estrategia funciona en que mercado.",
  meta: "Estrategia disenada con TU record real (9,241 senales analizadas). Corre las otras 7 y solo deja pasar lo que sobrevive a 5 filtros que atacan fugas medidas: (1) BTC bajista en 4h veta largos en alts (el 15/07 seis largos de memes cayeron juntos por esto) y BTC alcista veta cortos; (2) descarta la confianza ALTA-unanime de indicadores, que historicamente acierta solo 42% porque llega tarde; (3) exige probabilidad historica >=55% con n>=30 - el motor de aprendizaje actua de portero; (4) los cortos ademas exigen estructura 1h bajista (los cortos sueltos promedian -0.21R); (5) en el escaner, maximo 2 senales meta por direccion en memecoins. Cuando dice SIN OPERAR con candidatas descartadas, eso ES la estrategia funcionando.",
};

function Help({ k }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen((o) => !o)} style={{
        background: open ? C.accent : "transparent", border: `1px solid ${open ? C.accent : C.border}`,
        color: open ? "#fff" : C.dim, borderRadius: 8, padding: "0 7px", marginLeft: 8,
        cursor: "pointer", fontSize: 10, fontFamily: "inherit", lineHeight: "15px", verticalAlign: "middle",
      }}>{open ? "cerrar" : "¿?"}</button>
      {open && (
        <div style={{
          marginTop: 8, padding: 10, background: C.panel2,
          border: `1px dashed ${C.border}`, borderRadius: 4,
          color: "#9aa4b2", fontSize: 11, lineHeight: 1.6, fontWeight: 400,
          letterSpacing: "normal", textTransform: "none", whiteSpace: "normal",
        }}>{HELP[k]}</div>
      )}
    </>
  );
}

const Dot = ({ d }) => (
  <span style={{
    display: "inline-block", width: 7, height: 7, borderRadius: 2, marginRight: 8, flexShrink: 0,
    background: d === "up" ? "#00d4aa" : d === "down" ? "#ff4d6d" : "#4a5568",
  }} />
);

const trendTxt = (t) => (t === 1 ? "ALCISTA" : t === -1 ? "BAJISTA" : "SIN DEFINIR");
const CONF_RANK = { ALTA: 3, MEDIA: 2, BAJA: 1 };

const FACTOR_LABELS = {
  sesgo: "sesgo 4h/1h", "dir:corto": "direccion corto",
  "conf:alta": "confianza alta", "conf:baja": "confianza baja", rsi: "nivel de RSI",
  volumen: "volumen relativo", extension: "extension vs EMA21", "evento:bos": "evento BOS",
  "evento:choch": "evento CHoCH", advertencias: "advertencias activas",
  "hora:sin": "hora del dia", "hora:cos": "hora del dia",
};
const factorLabel = (name) =>
  FACTOR_LABELS[name] ??
  (name.startsWith("subcat:") ? `categoria ${name.slice(7)}`
    : name.startsWith("estrategia:") ? `estrategia ${name.slice(11)}` : name);

export default function BinanceCopiloto() {
  const [tab, setTab] = useState("scan");
  const [tickers, setTickers] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanTime, setScanTime] = useState(null);
  const [err, setErr] = useState(null);
  const [symbol, setSymbol] = useState("SOLUSDT");
  const [market, setMarket] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [capital, setCapital] = useState(1000);
  const [riskPct, setRiskPct] = useState(1);
  const [minVol, setMinVol] = useState(1000000);
  const [strategy, setStrategy] = useState("meta");
  const [ind, setInd] = useState({ emas: true, rsi: true, macd: true, boll: true });
  const [riskMode, setRiskMode] = useState("estricto");
  const [cat, setCat] = useState("todos");
  const [subcat, setSubcat] = useState("todas");

  // Top 3 con motor real
  const [top3Sig, setTop3Sig] = useState([]);
  const [top3Busy, setTop3Busy] = useState(false);
  const [top3Msg, setTop3Msg] = useState(null);
  const candleCache = useRef(new Map());

  // Motor de aprendizaje
  const [trackerTick, setTrackerTick] = useState(0);
  const [lastRec, setLastRec] = useState(null);
  const [btBusy, setBtBusy] = useState(false);
  const [btProg, setBtProg] = useState(null);
  const [verifyMsg, setVerifyMsg] = useState(null);
  const importRef = useRef(null);

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
            cat: assetCat(t.symbol),
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

  // Al abrir la app: resolver senales pendientes en segundo plano.
  useEffect(() => {
    resolveOpenSignals()
      .then((r) => { if (r.resolved) setTrackerTick((t) => t + 1); })
      .catch(() => {});
  }, []);

  const visibleTickers = useMemo(() => {
    let rows = cat === "todos" ? tickers : tickers.filter((t) => t.cat === cat);
    if (cat === "cripto" && subcat !== "todas") rows = rows.filter((t) => subCat(t.symbol) === subcat);
    return rows;
  }, [tickers, cat, subcat]);

  const getCandlesCached = useCallback(async (sym) => {
    const now = Date.now();
    const hit = candleCache.current.get(sym);
    if (hit && now - hit.ts < 5 * 60 * 1000) return hit.data;
    const [c15, c1h, c4h] = await Promise.all([
      fetchCandles(sym, "15m"), fetchCandles(sym, "1h"), fetchCandles(sym, "4h"),
    ]);
    const data = { c15, c1h, c4h };
    candleCache.current.set(sym, { ts: now, data });
    return data;
  }, []);

  // Corre TODAS las estrategias sobre los candidatos del filtro. Cada senal se
  // registra en el Record (con dedupe) para verificarse aunque no se ejecute.
  const [scanSignals, setScanSignals] = useState([]);
  const computeTop3 = useCallback(async () => {
    if (!visibleTickers.length) { setTop3Sig([]); setScanSignals([]); setTop3Msg(null); return; }
    setTop3Busy(true); setTop3Msg(null);
    try {
      // Sesgo de BTC una sola vez para el filtro de la META.
      let scanBtcBias = null;
      try {
        const btc = await getCandlesCached("BTCUSDT");
        const b = analyzeTF(btc.c4h.slice(0, -1));
        scanBtcBias = b.ema50 && b.ema200
          ? b.close > b.ema50 && b.ema50 > b.ema200 ? 1
            : b.close < b.ema50 && b.ema50 < b.ema200 ? -1 : 0
          : null;
      } catch { /* sin BTC esta vez */ }

      const candidates = [...visibleTickers].sort((a, b) => b.quoteVol - a.quoteVol).slice(0, 12);
      const results = [];
      for (let i = 0; i < candidates.length; i += 4) {
        const batch = candidates.slice(i, i + 4);
        const settled = await Promise.allSettled(batch.map(async (t) => {
          const { c15, c1h, c4h } = await getCandlesCached(t.symbol);
          const live = c15[c15.length - 1].close;
          const opts = { btcBias: scanBtcBias, probFn: (s) => probability(s, t.symbol) };
          const rows = [];
          for (const { strategy: st, sig } of evaluateAll(c15, c1h, c4h, live, ind, riskMode, opts)) {
            if (!sig.dir) continue;
            rows.push({ symbol: t.symbol, live, strategy: st, sig, prob: probability(sig, t.symbol) });
          }
          return rows;
        }));
        settled.forEach((s) => { if (s.status === "fulfilled" && s.value) results.push(...s.value); });
      }
      results.sort((a, b) =>
        ((b.prob?.p ?? 0.5) - (a.prob?.p ?? 0.5)) ||
        ((CONF_RANK[b.sig.confidence] ?? 0) - (CONF_RANK[a.sig.confidence] ?? 0))
      );
      // Filtro 5 de la META: maximo 2 senales meta por direccion en memecoins
      // (el 15/07 seis largos de memes a la vez eran la misma apuesta repetida).
      const memeCount = { long: 0, short: 0 };
      const kept = results.filter((r) => {
        if (r.strategy !== "meta" || subCat(r.symbol) !== "memes") return true;
        if (memeCount[r.sig.dir] >= 2) return false;
        memeCount[r.sig.dir]++;
        return true;
      });
      let recorded = 0;
      for (const r of kept) {
        if (recordSignal(r.sig, r.symbol, r.live)) recorded++;
      }
      setScanSignals(kept);
      setTop3Sig(kept.slice(0, 3));
      if (recorded) setTrackerTick((t) => t + 1);
      if (!results.length) {
        setTop3Msg(`Ninguna de las 7 estrategias tiene senal activa en esta categoria ahora mismo. ${riskMode === "estricto" ? "Prueba el filtro FLEXIBLE para ver setups con advertencias." : "Esperar tambien es una posicion."}`);
      }
    } catch (e) {
      setTop3Msg(`No se pudo evaluar las senales: ${e.message}`);
    }
    setTop3Busy(false);
  }, [visibleTickers, ind, riskMode, getCandlesCached]);

  // Recalcula el Top 3 al cambiar filtros/estrategia (con debounce).
  useEffect(() => {
    if (tab !== "scan" || !visibleTickers.length) return;
    const t = setTimeout(computeTop3, 400);
    return () => clearTimeout(t);
  }, [computeTop3, tab]);

  const analyze = async (sym) => {
    setAnalyzing(true); setErr(null);
    try {
      const s = sym.toUpperCase().replace(/[/_]/g, "");
      const [c15, c1h, c4h, cBtc, depth] = await Promise.all([
        fetchCandles(s, "15m"), fetchCandles(s, "1h"), fetchCandles(s, "4h"),
        fetchCandles("BTCUSDT", "4h", 250),
        fetchDepth(s).catch(() => null), // el libro es opcional: si falla, se analiza sin el
      ]);
      setMarket({
        symbol: s, time: new Date(), live: c15[c15.length - 1].close,
        c15, c1h, c4h, cBtc, depth, depthTime: depth ? new Date() : null,
      });
      setTab("analyze");
    } catch (e) {
      setErr(`Error al analizar: ${e.message}`);
    }
    setAnalyzing(false);
  };

  // Grafico EN VIVO: cada 20s se traen las ultimas velas de 15m y se funden con las
  // existentes (la vela en formacion se actualiza; al cerrar, la senal se recalcula sola).
  const [liveMode, setLiveMode] = useState(true);
  useEffect(() => {
    if (tab !== "analyze" || !market?.symbol || !liveMode) return;
    const sym = market.symbol;
    const id = setInterval(async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const fresh = await fetchCandles(sym, "15m", 3);
        setMarket((m) => {
          if (!m || m.symbol !== sym) return m;
          const c15 = [...m.c15];
          for (const nc of fresh) {
            const idx = c15.findIndex((c) => c.time === nc.time);
            if (idx >= 0) c15[idx] = nc;
            else if (nc.time > c15[c15.length - 1].time) c15.push(nc);
          }
          return { ...m, c15, live: c15[c15.length - 1].close, time: new Date() };
        });
      } catch { /* sin red esta vez; se reintenta */ }
    }, 20000);
    return () => clearInterval(id);
  }, [tab, market?.symbol, liveMode]);

  const [depthBusy, setDepthBusy] = useState(false);
  const refreshDepth = async () => {
    if (!market || depthBusy) return;
    setDepthBusy(true);
    try {
      const depth = await fetchDepth(market.symbol);
      setMarket((m) => (m ? { ...m, depth, depthTime: new Date() } : m));
    } catch { /* siguiente intento manual */ }
    setDepthBusy(false);
  };

  // Sesgo de BTC en 4h (filtro 1 de la META).
  const btcBiasNum = useMemo(() => {
    if (!market?.cBtc?.length) return null;
    const b = analyzeTF(market.cBtc.slice(0, -1));
    return b.ema50 && b.ema200
      ? b.close > b.ema50 && b.ema50 > b.ema200 ? 1
        : b.close < b.ema50 && b.ema50 < b.ema200 ? -1 : 0
      : null;
  }, [market]);

  // La senal se recalcula al instante al cambiar estrategia/indicadores/filtro.
  const analysis = useMemo(() => {
    if (!market) return null;
    const opts = { btcBias: btcBiasNum, probFn: (s) => probability(s, market.symbol) };
    const sig = evaluate(market.c15, market.c1h, market.c4h, market.live, strategy, ind, riskMode, opts);
    return { symbol: market.symbol, time: market.time, live: market.live, ...sig };
  }, [market, strategy, ind, riskMode, btcBiasNum]);

  const prob = useMemo(
    () => (analysis?.dir && market ? probability(analysis, market.symbol, market.time.getTime()) : null),
    [analysis, market, trackerTick]
  );

  // Registro automatico de cada senal accionable (con dedupe en el tracker).
  useEffect(() => {
    if (!analysis?.dir || !market) { setLastRec(null); return; }
    recordSignal(analysis, market.symbol, market.live, market.time.getTime());
    const mine = [...getSignals()].reverse().find(
      (s) => s.symbol === market.symbol && s.dir === analysis.dir && s.modo === analysis.modo
    );
    setLastRec(mine ? { id: mine.id, taken: mine.taken } : null);
  }, [analysis, market]);

  const depthInfo = useMemo(
    () => (market?.depth ? analyzeDepth(market.depth.bids, market.depth.asks, market.live) : null),
    [market]
  );

  // Cruce del libro con el setup activo: muros dentro del recorrido o protegiendo el stop.
  const wallNotes = useMemo(() => {
    if (!depthInfo || !analysis?.dir || !analysis.tps?.length) return [];
    const notes = [];
    const tpMax = analysis.tps[analysis.tps.length - 1].price;
    if (analysis.dir === "long") {
      const enFrente = depthInfo.sellWalls.filter((w) => w.price > analysis.entry && w.price < tpMax);
      if (enFrente.length) {
        notes.push({ mala: true, t: `Muro de VENTA de ${fmtQ(enFrente[0].quote)} USDT en ${fmt(enFrente[0].price)} dentro del recorrido a tus TP - puede frenar el movimiento; considera tomar ganancia delante del muro.` });
      }
      const colchon = depthInfo.buyWalls.find((w) => w.price < analysis.entry && w.price > analysis.stop);
      if (colchon) {
        notes.push({ mala: false, t: `Muro de COMPRA de ${fmtQ(colchon.quote)} USDT en ${fmt(colchon.price)} entre tu entrada y tu stop - colchon de liquidez a favor.` });
      }
    } else {
      const enFrente = depthInfo.buyWalls.filter((w) => w.price < analysis.entry && w.price > tpMax);
      if (enFrente.length) {
        notes.push({ mala: true, t: `Muro de COMPRA de ${fmtQ(enFrente[0].quote)} USDT en ${fmt(enFrente[0].price)} dentro del recorrido a tus TP - puede frenar la caida; considera tomar ganancia delante del muro.` });
      }
      const colchon = depthInfo.sellWalls.find((w) => w.price > analysis.entry && w.price < analysis.stop);
      if (colchon) {
        notes.push({ mala: false, t: `Muro de VENTA de ${fmtQ(colchon.quote)} USDT en ${fmt(colchon.price)} entre tu entrada y tu stop - colchon de liquidez a favor.` });
      }
    }
    return notes;
  }, [depthInfo, analysis]);

  const btcCtx = useMemo(() => {
    if (!market) return null;
    const btc = analyzeTF(market.cBtc.slice(0, -1));
    const bias =
      btc.close > btc.ema50 && btc.ema50 > btc.ema200 ? "ALCISTA"
        : btc.close < btc.ema50 && btc.ema50 < btc.ema200 ? "BAJISTA" : "RANGO";
    return { bias, price: btc.close, rsi: btc.rsi };
  }, [market]);

  // MI POSICION: la operacion real del usuario (entrada, margen y apalancamiento propios).
  const [myEntry, setMyEntry] = useState("");
  const [myMargin, setMyMargin] = useState("");
  const [myLev, setMyLev] = useState("");

  // Prellenar con la sugerencia cuando aparece una senal nueva (otro par/direccion/estrategia).
  useEffect(() => {
    if (analysis?.dir && analysis.entry) {
      setMyEntry(String(analysis.entry));
      setMyLev(String(analysis.maxLev ?? 1));
    }
  }, [analysis?.symbol, analysis?.dir, analysis?.modo]);

  const myPos = useMemo(() => {
    if (!analysis?.dir || !analysis.stop || !analysis.tps?.length) return null;
    const e = parseFloat(myEntry), m = parseFloat(myMargin), L = parseFloat(myLev);
    if (!(e > 0) || !(m > 0) || !(L > 0)) return null;
    const isLong = analysis.dir === "long";
    const size = m * L;
    const riskPct = isLong ? (e - analysis.stop) / e : (analysis.stop - e) / e;
    if (riskPct <= 0) return { invalid: true };
    const tps = analysis.tps.map((tp) => {
      const gainPct = isLong ? (tp.price - e) / e : (e - tp.price) / e;
      return { ...tp, rReal: gainPct / riskPct, pnl: size * gainPct * (tp.pct / 100) };
    });
    const liqPrice = isLong ? e * (1 - 1 / L) : e * (1 + 1 / L);
    return {
      size, coins: size / e, riskPct,
      riskUsdt: size * riskPct,
      tps,
      pnlTotal: tps.reduce((a, t) => a + t.pnl, 0),
      weightedR: tps.reduce((a, t) => a + (t.pct / 100) * t.rReal, 0),
      liqPrice,
      liqSafe: isLong ? liqPrice < analysis.stop : liqPrice > analysis.stop,
      slipPct: ((isLong ? e - analysis.entry : analysis.entry - e) / analysis.entry) * 100,
    };
  }, [analysis, myEntry, myMargin, myLev]);

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

  /* ---------- Acciones del Record ---------- */
  const doVerify = async () => {
    setVerifyMsg("Verificando senales abiertas...");
    try {
      const r = await resolveOpenSignals();
      setVerifyMsg(r.resolved ? `${r.resolved} senal(es) resueltas; ${r.open} siguen abiertas.` : `Sin cambios: ${r.open} senal(es) siguen abiertas.`);
      setTrackerTick((t) => t + 1);
    } catch (e) {
      setVerifyMsg(`Error al verificar: ${e.message}`);
    }
  };

  const [btDays, setBtDays] = useState(90);
  const doBacktest = async () => {
    if (btBusy) return;
    setBtBusy(true);
    setBtProg({ done: 0, total: 1, sym: "", fase: "preparando" });
    try {
      let syms = [...tickers].sort((a, b) => b.quoteVol - a.quoteVol).slice(0, 20).map((t) => t.symbol);
      if (!syms.length) syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
      await runBacktest({ symbols: syms, strategy, ind, riskMode, days: btDays, onProgress: setBtProg });
      setTrackerTick((t) => t + 1);
    } catch (e) {
      setErr(`El backtest fallo: ${e.message}`);
    }
    setBtBusy(false);
  };

  const doExport = () => {
    const blob = new Blob([exportJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `copiloto-record-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { importJSON(reader.result); setTrackerTick((t) => t + 1); setVerifyMsg("Record importado."); }
      catch { setVerifyMsg("Archivo invalido."); }
    };
    reader.readAsText(f);
    e.target.value = "";
  };

  const doClear = () => {
    if (window.confirm("¿Borrar TODO el record (senales, estadisticas y modelo)? Esta accion no se puede deshacer.")) {
      clearAll();
      setTrackerTick((t) => t + 1);
      setVerifyMsg("Record borrado.");
    }
  };

  const recStats = useMemo(() => trackerStats(), [trackerTick, tab]);
  const recordRows = useMemo(() => {
    const live = getSignals().map((s) => ({ ...s }));
    const bt = getBtSample();
    return [...live, ...bt].sort((a, b) => b.ts - a.ts).slice(0, 120);
  }, [trackerTick, tab]);

  // Posiciones vivas: senales marcadas "la tome" que siguen abiertas.
  const openTaken = useMemo(
    () => getSignals().filter((s) => s.taken && s.outcome === "open"),
    [trackerTick, tab]
  );
  const [posPx, setPosPx] = useState({});
  const [posBusy, setPosBusy] = useState(false);
  const refreshPositions = useCallback(async () => {
    const syms = [...new Set(openTaken.map((s) => s.symbol))];
    if (!syms.length || posBusy) return;
    setPosBusy(true);
    const out = {};
    for (const sym of syms) {
      try {
        const d = await fetchJson(`/ticker/price?symbol=${sym}`);
        out[sym] = parseFloat(d.price);
      } catch { /* sin precio esta vez */ }
    }
    setPosPx(out);
    setPosBusy(false);
  }, [openTaken, posBusy]);

  useEffect(() => {
    if (tab === "record" && openTaken.length) refreshPositions();
  }, [tab, openTaken.length]);

  // Curva de R acumulado (cada punto = una senal resuelta, en orden temporal).
  const curves = useMemo(() => {
    const cum = (arr) => { let c = 0; return arr.map((s) => (c += s.r ?? 0)); };
    const live = getSignals().filter((s) => s.outcome !== "open" && s.r != null).sort((a, b) => a.ts - b.ts);
    const bt = getBtSample().filter((s) => s.r != null).sort((a, b) => a.ts - b.ts);
    const series = [];
    if (bt.length >= 2) series.push({ label: "backtest (muestra)", color: "#fbbf24", points: cum(bt) });
    if (live.length >= 2) series.push({ label: "en vivo", color: "#00d4aa", points: cum(live) });
    return series;
  }, [trackerTick, tab]);

  /* ---------- Estilos ---------- */
  const sigColor = analysis?.signal === "LARGO" ? C.green : analysis?.signal === "CORTO" ? C.red : C.dim;
  const inputS = {
    background: C.panel2, border: `1px solid ${C.border}`, color: C.text,
    padding: "7px 10px", borderRadius: 4, fontFamily: "inherit", fontSize: 12, boxSizing: "border-box",
  };
  const chipS = (active, color) => ({
    background: active ? (color === "amber" ? "#2d2000" : "#0d2620") : "transparent",
    color: active ? (color === "amber" ? C.amber : C.green) : C.dim,
    border: `1px solid ${active ? (color === "amber" ? C.amber : C.green) : C.border}`,
    padding: "5px 12px", borderRadius: 4, cursor: "pointer",
    fontSize: 11, fontWeight: 700, fontFamily: "inherit",
  });
  const btnS = (bg, fg) => ({
    background: bg, color: fg, border: "none", padding: "8px 16px", borderRadius: 4,
    cursor: "pointer", fontWeight: 700, fontSize: 12, fontFamily: "inherit",
  });
  const labelColor = (l) =>
    l === "HH" || l === "HL" ? C.green : l === "LH" || l === "LL" ? C.red : C.dim;
  const outcomeColor = (o, r) =>
    o === "open" ? C.dim : (r ?? 0) > 0 ? C.green : o === "expired" ? C.amber : C.red;

  const INDICATOR_TOGGLES = [
    ["emas", "EMAs"], ["rsi", "RSI"], ["macd", "MACD"], ["boll", "Bollinger"],
  ];

  const probLine = prob && (
    <span>
      {(prob.p * 100).toFixed(0)}%
      {prob.insuficiente ? " · muestra insuficiente" : ` · n=${prob.n}`}
    </span>
  );

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
            COPILOTO <span style={{ color: C.amber }}>BINANCE</span> <span style={{ color: C.dim, fontSize: 11 }}>v4</span>
          </div>
          <div style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>
            velas cerradas · sin repintado · aprende de su propio record
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {[["scan", "Escaner"], ["analyze", "Analisis"], ["record", "Record"]].map(([k, l]) => (
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

      {/* ============ ESCANER ============ */}
      {tab === "scan" && (
        <>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: 16, flexWrap: "wrap" }}>
            <div>
              <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>VOLUMEN MINIMO 24H (USDT)</div>
              <input type="number" value={minVol} onChange={(e) => setMinVol(+e.target.value)} style={{ ...inputS, width: 150 }} />
            </div>
            <button onClick={scan} disabled={scanning} style={{
              ...btnS(scanning ? C.border : C.green, scanning ? C.dim : "#00201a"),
              cursor: scanning ? "wait" : "pointer",
            }}>
              {scanning ? "ESCANEANDO..." : "ESCANEAR MERCADO"}
            </button>
            {scanTime && (
              <div style={{ color: C.dim, fontSize: 11 }}>
                {visibleTickers.length} pares · {scanTime.toLocaleTimeString("es-CO")}
              </div>
            )}
          </div>

          <div style={{
            display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center",
            background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 4, padding: "10px 12px",
          }}>
            <span style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em" }}>TIPO DE ACTIVO:</span>
            {CAT_LABELS.map(([k, l]) => (
              <button key={k} onClick={() => { setCat(k); if (k !== "cripto") setSubcat("todas"); }} style={chipS(cat === k, "amber")}>{l}</button>
            ))}
          </div>

          {cat === "cripto" && (
            <div style={{
              display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center",
              background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 4, padding: "10px 12px",
            }}>
              <span style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em" }}>SUBCATEGORIA:</span>
              {SUBCAT_LABELS.map(([k, l]) => (
                <button key={k} onClick={() => setSubcat(k)} style={chipS(subcat === k, "green")}>{l}</button>
              ))}
            </div>
          )}

          <div style={{
            display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center",
            background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 4, padding: "10px 12px",
          }}>
            <span style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em" }}>ESTRATEGIA (para Analisis; el escaner corre TODAS):</span>
            {STRATEGIES.map(([k, l]) => (
              <button key={k} onClick={() => setStrategy(k)} style={chipS(strategy === k, "amber")}>{l}</button>
            ))}
            {strategy === "indicadores" && INDICATOR_TOGGLES.map(([k, l]) => (
              <button key={k} onClick={() => setInd((p) => ({ ...p, [k]: !p[k] }))} style={chipS(ind[k], "green")}>
                {ind[k] ? "✓ " : ""}{l}
              </button>
            ))}
            <span style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em", marginLeft: 8 }}>FILTRO:</span>
            {[["estricto", "ESTRICTO"], ["flexible", "FLEXIBLE"]].map(([k, l]) => (
              <button key={k} onClick={() => setRiskMode(k)} style={chipS(riskMode === k, k === "estricto" ? "green" : "amber")}>{l}</button>
            ))}
          </div>

          {tickers.length > 0 && visibleTickers.length === 0 && (
            <div style={{
              color: C.dim, padding: 24, textAlign: "center",
              border: `1px dashed ${C.border}`, borderRadius: 4, marginBottom: 16, fontSize: 12, lineHeight: 1.6,
            }}>
              {cat === "acciones"
                ? "Binance retiro los stock tokens (acciones tokenizadas) del mercado spot, asi que hoy no hay pares de acciones disponibles. Si los vuelve a listar, se agregan a la lista STOCK_TOKENS del codigo."
                : cat === "commodities"
                  ? "Sin pares de materias primas que superen el volumen minimo. El principal es PAXG (oro tokenizado); prueba bajando el filtro de volumen."
                  : "Sin pares en esta categoria/subcategoria con el filtro de volumen actual."}
            </div>
          )}

          {visibleTickers.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <div style={{ color: C.amber, fontSize: 11, letterSpacing: "0.1em" }}>
                  TOP 3 SENALES - las 7 estrategias corren sobre tus filtros<Help k="senales" />
                </div>
                <button onClick={computeTop3} disabled={top3Busy} style={{
                  background: "transparent", border: `1px solid ${C.accent}`, color: C.accent,
                  padding: "4px 10px", borderRadius: 3, cursor: "pointer", fontSize: 10, fontFamily: "inherit",
                }}>
                  {top3Busy ? "EVALUANDO..." : "RECALCULAR"}
                </button>
              </div>

              {top3Busy && !top3Sig.length && (
                <div style={{ color: C.dim, padding: 20, textAlign: "center", border: `1px dashed ${C.border}`, borderRadius: 4, marginBottom: 24, fontSize: 12 }}>
                  Corriendo las 7 estrategias sobre los candidatos de esta categoria...
                </div>
              )}

              {!top3Busy && top3Msg && (
                <div style={{ color: C.dim, padding: 20, textAlign: "center", border: `1px dashed ${C.border}`, borderRadius: 4, marginBottom: 24, fontSize: 12, lineHeight: 1.6 }}>
                  {top3Msg}
                </div>
              )}

              {top3Sig.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))", gap: 12, marginBottom: 14 }}>
                  {top3Sig.map((t, ti) => (
                    <div key={`${t.symbol}-${t.strategy}-${ti}`} style={{
                      background: C.panel, border: `1px solid ${C.border}`,
                      borderLeft: `3px solid ${t.sig.dir === "long" ? C.green : C.red}`, borderRadius: 4, padding: 14,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{t.symbol}</span>
                        <span style={{ fontWeight: 700, color: t.sig.dir === "long" ? C.green : C.red }}>
                          {t.sig.signal}
                        </span>
                      </div>
                      <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.08em", marginBottom: 6, textTransform: "uppercase" }}>
                        pedida por: {t.strategy}
                      </div>
                      <div style={{ fontSize: 18, marginBottom: 6 }}>{fmt(t.live)}</div>
                      <div style={{ fontSize: 12, marginBottom: 4 }}>
                        <span style={{ color: C.amber }}>
                          Prob: {t.prob ? `${(t.prob.p * 100).toFixed(0)}%` : "-"}
                        </span>
                        <span style={{ color: C.dim }}>
                          {t.prob ? (t.prob.insuficiente ? " (muestra insuficiente)" : ` (n=${t.prob.n})`) : ""}
                        </span>
                      </div>
                      <div style={{ color: C.dim, fontSize: 11 }}>Confianza: {t.sig.confidence} · {t.sig.tipo}</div>
                      <div style={{ color: C.dim, fontSize: 11 }}>Entrada ~{fmt(t.sig.entry)} · Stop {fmt(t.sig.stop)}</div>
                      {t.sig.warnings?.length > 0 && (
                        <div style={{ color: C.amber, fontSize: 10, marginTop: 4 }}>⚠ {t.sig.warnings.length} advertencia(s)</div>
                      )}
                      <button onClick={() => { setStrategy(t.strategy); setSymbol(t.symbol); analyze(t.symbol); }} disabled={analyzing} style={{
                        background: "transparent", border: `1px solid ${C.accent}`, color: C.accent, marginTop: 10,
                        padding: "6px 12px", borderRadius: 3, cursor: "pointer", fontSize: 11, width: "100%", fontFamily: "inherit",
                      }}>
                        VER ANALISIS COMPLETO
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {scanSignals.length > 0 && (
                <>
                  <div style={{ color: C.dim, fontSize: 11, letterSpacing: "0.1em", marginBottom: 8 }}>
                    TODAS LAS SENALES DETECTADAS ({scanSignals.length}) - registradas en el Record automaticamente
                  </div>
                  <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, overflow: "auto", maxHeight: 320, marginBottom: 24 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: C.panel2 }}>
                          {["PAR", "ESTRATEGIA", "DIR", "CONF", "PROB", "ENTRADA", ""].map((h) => (
                            <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: C.dim, fontSize: 10, fontWeight: 500, position: "sticky", top: 0, background: C.panel2 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {scanSignals.map((t, i) => (
                          <tr key={`${t.symbol}-${t.strategy}-${i}`} style={{ borderTop: `1px solid ${C.border}` }}>
                            <td style={{ padding: "7px 12px", fontWeight: 600 }}>{t.symbol}</td>
                            <td style={{ padding: "7px 12px", color: C.amber, fontSize: 11, textTransform: "uppercase" }}>{t.strategy}</td>
                            <td style={{ padding: "7px 12px", color: t.sig.dir === "long" ? C.green : C.red }}>
                              {t.sig.dir === "long" ? "LARGO" : "CORTO"}
                            </td>
                            <td style={{ padding: "7px 12px", color: C.dim }}>{t.sig.confidence}</td>
                            <td style={{ padding: "7px 12px", color: C.amber }}>
                              {t.prob ? `${(t.prob.p * 100).toFixed(0)}%` : "-"}
                              <span style={{ color: C.dim, fontSize: 10 }}>{t.prob && !t.prob.insuficiente ? ` n=${t.prob.n}` : " n<20"}</span>
                            </td>
                            <td style={{ padding: "7px 12px" }}>{fmt(t.sig.entry)}</td>
                            <td style={{ padding: "7px 12px" }}>
                              <button onClick={() => { setStrategy(t.strategy); setSymbol(t.symbol); analyze(t.symbol); }} style={{
                                background: "transparent", border: "none", color: C.accent,
                                cursor: "pointer", fontSize: 11, fontFamily: "inherit", padding: 0,
                              }}>ver</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

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
                    {[...visibleTickers].sort((a, b) => b.quoteVol - a.quoteVol).slice(0, 40).map((t) => (
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

      {/* ============ ANALISIS ============ */}
      {tab === "analyze" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && analyze(symbol)}
              placeholder="SOLUSDT"
              style={{ ...inputS, width: 160, fontSize: 13, padding: "8px 12px" }}
            />
            <button onClick={() => analyze(symbol)} disabled={analyzing} style={{
              ...btnS(analyzing ? C.border : C.accent, "#fff"), cursor: analyzing ? "wait" : "pointer",
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

          <div style={{
            display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center",
            background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 4, padding: "10px 12px",
          }}>
            <span style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em" }}>ESTRATEGIA:</span>
            {STRATEGIES.map(([k, l]) => (
              <button key={k} onClick={() => setStrategy(k)} style={chipS(strategy === k, "amber")}>{l}</button>
            ))}
            {strategy === "indicadores" && (
              <>
                <span style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em", marginLeft: 8 }}>USAR:</span>
                {INDICATOR_TOGGLES.map(([k, l]) => (
                  <button key={k} onClick={() => setInd((p) => ({ ...p, [k]: !p[k] }))} style={chipS(ind[k], "green")}>
                    {ind[k] ? "✓ " : ""}{l}
                  </button>
                ))}
              </>
            )}
            <span style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em", marginLeft: 8 }}>FILTRO DE RIESGO:</span>
            {[["estricto", "ESTRICTO"], ["flexible", "FLEXIBLE"]].map(([k, l]) => (
              <button key={k} onClick={() => setRiskMode(k)} style={chipS(riskMode === k, k === "estricto" ? "green" : "amber")}>{l}</button>
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
                      Binance spot · {analysis.time.toLocaleTimeString("es-CO")} (Bogota) · {subCat(analysis.symbol)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 24, fontWeight: 700, color: sigColor }}>{analysis.signal}</div>
                    {analysis.blockedDir && (
                      <div style={{ color: C.amber, fontSize: 11, marginTop: 2 }}>
                        senal {analysis.blockedDir === "long" ? "ALCISTA" : "BAJISTA"} bloqueada por filtro de riesgo
                      </div>
                    )}
                    <div style={{ color: C.dim, fontSize: 11, marginTop: 4 }}>
                      Estrategia: {analysis.modo} · Confianza: {analysis.confidence}
                    </div>
                    {analysis.modo === "indicadores" ? (
                      <>
                        <div style={{ color: C.dim, fontSize: 11 }}>Sesgo 4h/1h (EMAs): {analysis.bias}</div>
                        <div style={{ color: C.dim, fontSize: 11 }}>
                          Votos: {analysis.bull} alcistas / {analysis.bear} bajistas (de {analysis.nEnabled}, min {analysis.needed})
                        </div>
                      </>
                    ) : analysis.modo === "estructura" ? (
                      <>
                        <div style={{ color: C.dim, fontSize: 11 }}>Estructura 1h: {analysis.bias}</div>
                        <div style={{ color: C.dim, fontSize: 11 }}>
                          Estructura 15m: {trendTxt(analysis.structure.trend)}
                          {analysis.lastEvent ? ` · ${analysis.lastEvent.type} hace ${analysis.lastEvent.age} velas` : ""}
                        </div>
                      </>
                    ) : analysis.modo === "meta" ? (
                      <>
                        <div style={{ color: C.dim, fontSize: 11 }}>
                          BTC 4h: {btcBiasNum === 1 ? "ALCISTA" : btcBiasNum === -1 ? "BAJISTA" : btcBiasNum === 0 ? "RANGO" : "sin dato"} · sesgo par: {analysis.bias}
                        </div>
                        {analysis.dir && (
                          <div style={{ color: C.dim, fontSize: 11 }}>
                            Fuente: {analysis.metaFuente} · consenso: {analysis.metaConsenso}
                            {analysis.metaProb ? ` · prob ${(analysis.metaProb.p * 100).toFixed(0)}% (n=${analysis.metaProb.n})` : ""}
                          </div>
                        )}
                      </>
                    ) : (
                      <div style={{ color: C.dim, fontSize: 11 }}>Sesgo 4h/1h (EMAs): {analysis.bias} · tipo: {analysis.tipo}</div>
                    )}
                  </div>
                </div>
                <div style={{ marginTop: 10, fontSize: 10 }}><Help k="senal" /></div>
              </div>

              {market && (
                <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                    <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.1em" }}>
                      GRAFICO 15m - pivotes y niveles<Help k="chart" />
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ color: C.dim, fontSize: 10 }}>
                        {market.time.toLocaleTimeString("es-CO")}
                      </span>
                      <button onClick={() => setLiveMode((v) => !v)} style={{
                        background: liveMode ? "#0d2620" : "transparent",
                        color: liveMode ? C.green : C.dim,
                        border: `1px solid ${liveMode ? C.green : C.border}`,
                        padding: "3px 10px", borderRadius: 3, cursor: "pointer", fontSize: 10, fontFamily: "inherit",
                      }}>
                        {liveMode ? "● EN VIVO (20s)" : "○ PAUSADO"}
                      </button>
                    </div>
                  </div>
                  <CandleChart candles={market.c15} sig={analysis} depthInfo={depthInfo} />
                  <div style={{ color: C.dim, fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>
                    <span style={{ color: C.amber }}>—</span> EMA9 · <span style={{ color: C.accent }}>—</span> EMA21 ·{" "}
                    <span style={{ color: "#9aa4b2" }}>—</span> EMA50 · punteadas: IN/SL/TP · franjas: muros del libro ·
                    volumen verde/rojo segun quien ejecuto mas.
                  </div>
                </div>
              )}

              {analysis.tf15.delta10 != null && (
                <div style={{
                  background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 4,
                  padding: "10px 14px", marginBottom: 14, fontSize: 12, color: C.dim,
                }}>
                  <span style={{ color: C.amber }}>FLUJO EJECUTADO</span>
                  <Help k="flujo" />
                  {" "}· ultima vela:{" "}
                  <span style={{ color: analysis.tf15.deltaLast >= 0.55 ? C.green : analysis.tf15.deltaLast <= 0.45 ? C.red : C.text }}>
                    {(analysis.tf15.deltaLast * 100).toFixed(0)}% compra
                  </span>
                  {" "}· ultimas 10 velas:{" "}
                  <span style={{ color: analysis.tf15.delta10 >= 0.55 ? C.green : analysis.tf15.delta10 <= 0.45 ? C.red : C.text }}>
                    {(analysis.tf15.delta10 * 100).toFixed(0)}% compra
                  </span>
                  {" "}— {analysis.tf15.delta10 >= 0.55 ? "los compradores estan ejecutando de verdad." : analysis.tf15.delta10 <= 0.45 ? "los vendedores estan ejecutando de verdad." : "flujo equilibrado."}
                </div>
              )}

              {analysis.dir && prob && (
                <div style={{
                  background: C.panel, border: `1px solid ${C.border}`, borderLeft: `4px solid ${C.amber}`,
                  borderRadius: 4, padding: 14, marginBottom: 14,
                }}>
                  <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.1em", marginBottom: 8 }}>
                    PROBABILIDAD HISTORICA (motor de aprendizaje)<Help k="prob" />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                    <div>
                      <span style={{ fontSize: 24, fontWeight: 700, color: prob.p >= 0.55 ? C.green : prob.p <= 0.45 ? C.red : C.text }}>
                        {probLine}
                      </span>
                      <div style={{ color: C.dim, fontSize: 11, marginTop: 4 }}>
                        modelo: {(prob.pModel * 100).toFixed(0)}% · segmentos: {(prob.pBuckets * 100).toFixed(0)}%
                        {prob.divergente ? " · DIVERGEN: tomar el rango, no el numero" : ""}
                      </div>
                      {prob.factores?.length > 0 && (
                        <div style={{ color: C.dim, fontSize: 11, marginTop: 4 }}>
                          {prob.factores.map((f, i) => (
                            <span key={i} style={{ marginRight: 10, color: f.sube ? C.green : C.red }}>
                              {f.sube ? "▲" : "▼"} {factorLabel(f.name)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {lastRec && (
                      <button onClick={() => { markTaken(lastRec.id, !lastRec.taken); setLastRec({ ...lastRec, taken: !lastRec.taken }); }} style={{
                        background: lastRec.taken ? "#0d2620" : "transparent",
                        color: lastRec.taken ? C.green : C.dim,
                        border: `1px solid ${lastRec.taken ? C.green : C.border}`,
                        padding: "8px 14px", borderRadius: 4, cursor: "pointer", fontSize: 11, fontFamily: "inherit",
                      }}>
                        {lastRec.taken ? "✓ LA TOME" : "MARCAR: LA TOME"}
                      </button>
                    )}
                  </div>
                  {prob.insuficiente && (
                    <div style={{ color: C.amber, fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
                      Aun hay pocas muestras para confiar en este numero. Corre el backtest de 90 dias en la pestana Record para sembrar el historial.
                    </div>
                  )}
                </div>
              )}

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

              {depthInfo && (
                <div style={{
                  background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4,
                  padding: 14, marginBottom: 14,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                    <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.1em" }}>
                      LIBRO DE ORDENES - mapa de liquidez EN VIVO (no vota en la senal)
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {market?.depthTime && (
                        <span style={{ color: C.dim, fontSize: 10 }}>
                          {market.depthTime.toLocaleTimeString("es-CO")}
                        </span>
                      )}
                      <button onClick={refreshDepth} disabled={depthBusy} style={{
                        background: "transparent", border: `1px solid ${C.accent}`, color: C.accent,
                        padding: "3px 10px", borderRadius: 3, cursor: "pointer", fontSize: 10, fontFamily: "inherit",
                      }}>
                        {depthBusy ? "..." : "REFRESCAR"}
                      </button>
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: C.green }}>
                        Compra ±2%: {fmtQ(depthInfo.nearBid)} USDT ({(depthInfo.imbalance * 100).toFixed(0)}%)
                      </span>
                      <span style={{ color: C.red }}>
                        Venta ±2%: {fmtQ(depthInfo.nearAsk)} USDT ({((1 - depthInfo.imbalance) * 100).toFixed(0)}%)
                      </span>
                    </div>
                    <div style={{ height: 8, background: C.border, borderRadius: 4, overflow: "hidden", display: "flex" }}>
                      <div style={{ width: `${depthInfo.imbalance * 100}%`, background: C.green }} />
                      <div style={{ flex: 1, background: C.red }} />
                    </div>
                    <div style={{ color: C.dim, fontSize: 10, marginTop: 4 }}>
                      {depthInfo.imbalance > 0.6
                        ? "Domina la liquidez compradora cercana (posible soporte)."
                        : depthInfo.imbalance < 0.4
                          ? "Domina la liquidez vendedora cercana (posible techo)."
                          : "Liquidez equilibrada cerca del precio."}
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 12 }}>
                    <div>
                      <div style={{ color: C.green, fontSize: 10, letterSpacing: "0.1em", marginBottom: 6 }}>
                        MUROS DE COMPRA (donde se acumula la demanda)
                      </div>
                      {depthInfo.buyWalls.map((w, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12, borderTop: i ? `1px solid ${C.border}` : "none" }}>
                          <span>{fmt(w.price)}</span>
                          <span style={{ color: C.green, fontWeight: 600 }}>{fmtQ(w.quote)}</span>
                          <span style={{ color: C.dim, fontSize: 11 }}>{w.distPct.toFixed(2)}%</span>
                        </div>
                      ))}
                      {!depthInfo.buyWalls.length && <div style={{ color: C.dim, fontSize: 11 }}>Sin muros relevantes en ±5%.</div>}
                    </div>
                    <div>
                      <div style={{ color: C.red, fontSize: 10, letterSpacing: "0.1em", marginBottom: 6 }}>
                        MUROS DE VENTA (donde se acumula la oferta)
                      </div>
                      {depthInfo.sellWalls.map((w, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12, borderTop: i ? `1px solid ${C.border}` : "none" }}>
                          <span>{fmt(w.price)}</span>
                          <span style={{ color: C.red, fontWeight: 600 }}>{fmtQ(w.quote)}</span>
                          <span style={{ color: C.dim, fontSize: 11 }}>+{w.distPct.toFixed(2)}%</span>
                        </div>
                      ))}
                      {!depthInfo.sellWalls.length && <div style={{ color: C.dim, fontSize: 11 }}>Sin muros relevantes en ±5%.</div>}
                    </div>
                  </div>

                  {wallNotes.length > 0 && (
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
                      {wallNotes.map((n, i) => (
                        <div key={i} style={{ fontSize: 11, lineHeight: 1.5, color: n.mala ? "#ffe9a8" : "#7fe8d0", marginBottom: 4 }}>
                          {n.mala ? "⚠" : "✓"} {n.t}
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ marginTop: 10, fontSize: 10, color: C.dim, lineHeight: 1.5 }}>
                    Ordenes LIMITE en espera, no volumen ejecutado: los muros pueden retirarse en segundos
                    (spoofing). Por eso el libro informa pero NO vota en la senal. Muros = bins de ~0.2%
                    dentro de ±5% del precio; desequilibrio medido a ±2%.
                  </div>
                </div>
              )}

              {analysis.modo !== "estructura" ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14, marginBottom: 14 }}>
                  <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14 }}>
                    <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.1em", marginBottom: 10 }}>
                      {analysis.modo === "indicadores"
                        ? "INDICADORES ACTIVOS - 15m cerrado (deciden la entrada)"
                        : `CONDICIONES ${analysis.modo.toUpperCase()} - 15m cerrado`}
                      <Help k={analysis.modo === "indicadores" ? "nucleo" : analysis.modo} />
                    </div>
                    {analysis.core.length === 0 && (
                      <div style={{ color: C.dim, fontSize: 12 }}>
                        {analysis.modo === "indicadores" ? "Todos los indicadores estan apagados." : "Sin datos suficientes para esta estrategia."}
                      </div>
                    )}
                    {analysis.core.map((c, i) => (
                      <div key={i} style={{
                        display: "flex", alignItems: "center", padding: "6px 0",
                        borderTop: i ? `1px solid ${C.border}` : "none",
                      }}>
                        <Dot d={c.d} />
                        <span style={{ width: 100, color: C.dim, flexShrink: 0 }}>{c.n}</span>
                        <span style={{ fontSize: 12 }}>{c.v}</span>
                      </div>
                    ))}
                  </div>
                  {analysis.contexto.length > 0 && (
                    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14 }}>
                      <div style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em", marginBottom: 10 }}>
                        CONTEXTO (informativo, no vota)<Help k="contexto" />
                      </div>
                      {analysis.contexto.map((c, i) => (
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
                  )}
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14, marginBottom: 14 }}>
                  <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14 }}>
                    <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.1em", marginBottom: 10 }}>
                      PIVOTES 15m - confirmados 3 velas despues (sin repintado)<Help k="pivotes" />
                    </div>
                    {analysis.structure.seq.slice(-7).map((p, i) => (
                      <div key={i} style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0",
                        borderTop: i ? `1px solid ${C.border}` : "none", fontSize: 12,
                      }}>
                        <span style={{ color: labelColor(p.label), fontWeight: 700, width: 36 }}>{p.label}</span>
                        <span>{fmt(p.price)}</span>
                        <span style={{ color: C.dim, fontSize: 11 }}>
                          {new Date(p.time).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                          {p.broken ? " · roto" : ""}
                        </span>
                      </div>
                    ))}
                    {analysis.structure.seq.length === 0 && (
                      <div style={{ color: C.dim, fontSize: 12 }}>Sin pivotes confirmados aun.</div>
                    )}
                  </div>
                  <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14 }}>
                    <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.1em", marginBottom: 10 }}>
                      EVENTOS - BOS (continuacion) / CHoCH (giro)<Help k="eventos" />
                    </div>
                    {analysis.structure.events.slice(-5).reverse().map((ev, i) => (
                      <div key={i} style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0",
                        borderTop: i ? `1px solid ${C.border}` : "none", fontSize: 12,
                      }}>
                        <span style={{ color: ev.dir === "up" ? C.green : C.red, fontWeight: 700 }}>
                          {ev.type}
                        </span>
                        <span>{fmt(ev.level)}</span>
                        <span style={{ color: C.dim, fontSize: 11 }}>
                          {new Date(ev.time).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                          {" · hace "}{analysis.structure.n - 1 - ev.t}{" velas"}
                        </span>
                      </div>
                    ))}
                    {analysis.structure.events.length === 0 && (
                      <div style={{ color: C.dim, fontSize: 12 }}>Sin BOS ni CHoCH detectados.</div>
                    )}
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.dim, lineHeight: 1.6 }}>
                      Swing alto vigente: {analysis.structure.lastH ? `${fmt(analysis.structure.lastH.price)} (${analysis.structure.lastH.label}${analysis.structure.lastH.broken ? ", roto" : ""})` : "-"}
                      <br />
                      Swing bajo vigente: {analysis.structure.lastL ? `${fmt(analysis.structure.lastL.price)} (${analysis.structure.lastL.label}${analysis.structure.lastL.broken ? ", roto" : ""})` : "-"}
                    </div>
                  </div>
                </div>
              )}

              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, overflow: "auto", marginBottom: 14 }}>
                <div style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em", padding: "10px 12px 8px" }}>
                  MULTI-TIMEFRAME (4h/1h = sesgo · 15m = gatillo)<Help k="tabla" />
                </div>
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
                    <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.1em", marginBottom: 12 }}>NIVELES DEL SETUP<Help k="niveles" /></div>
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
                    <div style={{ color: C.amber, fontSize: 10, letterSpacing: "0.1em", marginBottom: 12 }}>TAMANO DE POSICION (sugerido)<Help k="tamano" /></div>
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

                  <div style={{ background: C.panel, border: `1px solid ${C.accent}`, borderRadius: 4, padding: 14 }}>
                    <div style={{ color: C.accent, fontSize: 10, letterSpacing: "0.1em", marginBottom: 12 }}>
                      MI POSICION REAL (ajustala a tu operacion)<Help k="mipos" />
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: "1 1 100px" }}>
                        <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>MI ENTRADA</div>
                        <input type="number" value={myEntry} onChange={(e) => setMyEntry(e.target.value)} style={{ ...inputS, width: "100%" }} />
                      </div>
                      <div style={{ flex: "1 1 100px" }}>
                        <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>MARGEN (USDT)</div>
                        <input type="number" value={myMargin} onChange={(e) => setMyMargin(e.target.value)} placeholder="ej. 100" style={{ ...inputS, width: "100%" }} />
                      </div>
                      <div style={{ flex: "1 1 80px" }}>
                        <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>APALANC. (x)</div>
                        <input type="number" value={myLev} onChange={(e) => setMyLev(e.target.value)} style={{ ...inputS, width: "100%" }} />
                      </div>
                    </div>

                    {!myPos && (
                      <div style={{ color: C.dim, fontSize: 12, lineHeight: 1.6 }}>
                        Escribe el margen con el que entraste (o vas a entrar) y se calculan TUS numeros.
                        Si ya estabas dentro de la posicion, cambia "MI ENTRADA" por tu precio real de compra.
                      </div>
                    )}

                    {myPos?.invalid && (
                      <div style={{
                        padding: 10, background: "#2d1215", border: `1px solid ${C.red}`,
                        borderRadius: 4, fontSize: 11, lineHeight: 1.5, color: "#ffb3c0",
                      }}>
                        Tu entrada queda del lado equivocado del stop ({fmt(analysis.stop)}): desde ese precio
                        el setup no aplica. Revisa el precio o espera un nuevo setup.
                      </div>
                    )}

                    {myPos && !myPos.invalid && (
                      <>
                        {[
                          ["Tamano de posicion", `${myPos.size.toFixed(2)} USDT`, C.text],
                          ["Cantidad", `${myPos.coins.toFixed(4)} ${analysis.symbol.replace("USDT", "")}`, C.text],
                          ["Si toca el stop", `-${myPos.riskUsdt.toFixed(2)} USDT (${(myPos.riskUsdt / (+myMargin) * 100).toFixed(0)}% de tu margen)`, C.red],
                          ...myPos.tps.map((t, i) => [
                            `TP${i + 1} (${t.pct}%)`,
                            `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} USDT · ${t.rReal.toFixed(2)}R real`,
                            t.pnl >= 0 ? C.green : C.red,
                          ]),
                          ["Si llena TP1-TP3", `${myPos.pnlTotal >= 0 ? "+" : ""}${myPos.pnlTotal.toFixed(2)} USDT`, myPos.pnlTotal >= 0 ? C.green : C.red],
                          ["R/B ponderado real", `1:${myPos.weightedR.toFixed(2)} (plan sugerido: 1:1.78)`, myPos.weightedR >= 1.5 ? C.green : C.amber],
                          ["Tu liquidacion aprox.", fmt(myPos.liqPrice), myPos.liqSafe ? C.green : C.red],
                          ["Apalanc. max. seguro", `${analysis.maxLev}x (tu: ${(+myLev).toFixed(0)}x)`, +myLev <= analysis.maxLev ? C.green : C.red],
                        ].map(([k, v, col], i) => (
                          <div key={i} style={{
                            display: "flex", justifyContent: "space-between", padding: "6px 0", gap: 10,
                            borderTop: i ? `1px solid ${C.border}` : "none", fontSize: 12,
                          }}>
                            <span style={{ color: C.dim, flexShrink: 0 }}>{k}</span>
                            <span style={{ color: col, fontWeight: 600, textAlign: "right" }}>{v}</span>
                          </div>
                        ))}

                        {!myPos.liqSafe && (
                          <div style={{
                            marginTop: 10, padding: 10, background: "#2d1215", border: `1px solid ${C.red}`,
                            borderRadius: 4, fontSize: 11, lineHeight: 1.5, color: "#ffb3c0",
                          }}>
                            PELIGRO: con {(+myLev).toFixed(0)}x tu liquidacion ({fmt(myPos.liqPrice)}) queda ANTES
                            del stop ({fmt(analysis.stop)}): perderias TODO el margen antes de que el stop te proteja.
                            Baja el apalancamiento a maximo {analysis.maxLev}x.
                          </div>
                        )}
                        {myPos.liqSafe && +myLev > analysis.maxLev && (
                          <div style={{ marginTop: 10, fontSize: 11, color: C.amber, lineHeight: 1.5 }}>
                            ⚠ Usas mas apalancamiento que el maximo seguro sugerido ({analysis.maxLev}x). La liquidacion
                            aun queda tras el stop, pero con poco margen para mechas y comisiones.
                          </div>
                        )}
                        {Math.abs(myPos.slipPct) > 0.3 && (
                          <div style={{ marginTop: 8, fontSize: 11, color: myPos.slipPct > 0 ? C.amber : C.green, lineHeight: 1.5 }}>
                            {myPos.slipPct > 0
                              ? `⚠ Tu entrada es ${myPos.slipPct.toFixed(2)}% peor que la sugerida (${fmt(analysis.entry)}): el stop te queda mas lejos y por eso tu R/B real baja.`
                              : `✓ Tu entrada es ${Math.abs(myPos.slipPct).toFixed(2)}% mejor que la sugerida: tu R/B real mejora.`}
                          </div>
                        )}
                        {myPos.riskUsdt > capital * 0.02 && (
                          <div style={{ marginTop: 8, fontSize: 11, color: C.amber, lineHeight: 1.5 }}>
                            ⚠ Este stop costaria {((myPos.riskUsdt / capital) * 100).toFixed(1)}% de tu capital
                            ({capital} USDT): por encima del 2% recomendado. Considera reducir margen o apalancamiento.
                          </div>
                        )}
                        <div style={{ marginTop: 8, fontSize: 11, color: C.amber, lineHeight: 1.5 }}>
                          Tras TP1: mueve tu stop a TU break-even ({fmt(parseFloat(myEntry))}).
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{
                  background: C.panel, border: `1px solid ${C.border}`,
                  borderLeft: `4px solid ${analysis.blockedDir ? C.amber : C.dim}`,
                  borderRadius: 4, padding: 18,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>
                    SIN OPERAR
                    {analysis.blockedDir && (
                      <span style={{ color: C.amber }}>
                        {" "}· senal {analysis.blockedDir === "long" ? "ALCISTA" : "BAJISTA"} bloqueada
                      </span>
                    )}
                  </div>
                  <div style={{ color: C.dim, fontSize: 12, lineHeight: 1.6 }}>
                    {analysis.invalidation ||
                      (analysis.modo === "indicadores"
                        ? `Sin confluencia suficiente: ${analysis.bull} alcistas / ${analysis.bear} bajistas de ${analysis.nEnabled} indicadores (se requieren ${analysis.needed} en la misma direccion). Esperar es una posicion valida.`
                        : "Sin evento de estructura accionable. Esperar es una posicion valida.")}
                  </div>
                  {analysis.blockedDir && analysis.riskMode === "estricto" && (
                    <div style={{ marginTop: 10, fontSize: 11, color: C.amber, lineHeight: 1.5 }}>
                      La senal existe pero un filtro de riesgo la freno. Si quieres ver igualmente los
                      niveles del setup (bajo tu criterio), cambia el FILTRO DE RIESGO a FLEXIBLE arriba.
                    </div>
                  )}
                </div>
              )}

              {analysis.dir && analysis.warnings?.length > 0 && (
                <div style={{
                  marginTop: 14, padding: 12, background: "#2d2000", border: `1px solid ${C.amber}`,
                  borderRadius: 4, fontSize: 12, color: "#ffe9a8", lineHeight: 1.6,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 6, color: C.amber }}>
                    ADVERTENCIAS (modo flexible - setup de menor calidad)
                  </div>
                  {analysis.warnings.map((w, i) => (
                    <div key={i} style={{ marginBottom: 4 }}>• {w}</div>
                  ))}
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
                Los pivotes de estructura se confirman 3 velas despues de formarse.
                La probabilidad historica describe el pasado del propio motor, no garantiza el futuro.
                Verifica precio, ATR, soportes y liquidacion en tu plataforma antes de ejecutar.
                Herramienta de gestion de riesgo, no recomendacion de inversion.
                La mayoria de traders minoristas de cripto pierde dinero.
              </div>
            </>
          )}
        </>
      )}

      {/* ============ RECORD ============ */}
      {tab === "record" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={doVerify} style={btnS(C.accent, "#fff")}>VERIFICAR RESULTADOS</button>
            <button onClick={doBacktest} disabled={btBusy} style={{
              ...btnS(btBusy ? C.border : C.amber, btBusy ? C.dim : "#2d2000"),
              cursor: btBusy ? "wait" : "pointer",
            }}>
              {btBusy ? "CORRIENDO BACKTEST..." : `BACKTEST ${btDays} DIAS`}
            </button>
            {[90, 180, 365].map((dd) => (
              <button key={dd} onClick={() => setBtDays(dd)} disabled={btBusy} style={chipS(btDays === dd, "amber")}>
                {dd === 365 ? "1 AÑO" : `${dd}D`}
              </button>
            ))}
            <button onClick={doExport} style={{ ...btnS("transparent", C.dim), border: `1px solid ${C.border}` }}>EXPORTAR</button>
            <button onClick={() => importRef.current?.click()} style={{ ...btnS("transparent", C.dim), border: `1px solid ${C.border}` }}>IMPORTAR</button>
            <input ref={importRef} type="file" accept="application/json" onChange={doImport} style={{ display: "none" }} />
            <button onClick={doClear} style={{ ...btnS("transparent", C.red), border: `1px solid ${C.red}` }}>BORRAR TODO</button>
          </div>

          {btBusy && btProg && (
            <div style={{
              background: C.panel, border: `1px solid ${C.amber}`, borderRadius: 4,
              padding: 14, marginBottom: 16, fontSize: 12,
            }}>
              <div style={{ color: C.amber, marginBottom: 8 }}>
                Backtest {btProg.fase}{btProg.sym ? `: ${btProg.sym}` : ""} ({btProg.done}/{btProg.total} pares)
              </div>
              <div style={{ height: 6, background: C.border, borderRadius: 3 }}>
                <div style={{
                  height: 6, borderRadius: 3, background: C.amber,
                  width: `${btProg.total ? (btProg.done / btProg.total) * 100 : 0}%`, transition: "width 0.3s",
                }} />
              </div>
              <div style={{ color: C.dim, fontSize: 11, marginTop: 8 }}>
                Descarga {btDays} dias de velas por par y corre la estrategia "{strategy}" con tus filtros actuales.
                {btDays <= 90 ? " Suele tardar 1-2 minutos." : btDays <= 180 ? " Suele tardar 3-6 minutos." : " Un año tarda 8-15 minutos (35,000 velas por par); dejalo con la pantalla encendida."}
                {" "}No cierres la pestana.
              </div>
            </div>
          )}

          {verifyMsg && !btBusy && (
            <div style={{ color: C.dim, fontSize: 12, marginBottom: 16 }}>{verifyMsg}</div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12, marginBottom: 16 }}>
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14 }}>
              <div style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em", marginBottom: 8 }}>SENALES EN VIVO</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>
                {recStats.live.n} <span style={{ fontSize: 12, color: C.dim }}>resueltas · {recStats.openCount} abiertas</span>
              </div>
              <div style={{ fontSize: 12, marginTop: 6 }}>
                Win rate: <span style={{ color: recStats.live.winRate >= 0.5 ? C.green : C.red }}>
                  {recStats.live.n ? `${(recStats.live.winRate * 100).toFixed(0)}%` : "-"}
                </span>
                {" · "}R medio: <span style={{ color: recStats.live.avgR >= 0 ? C.green : C.red }}>
                  {recStats.live.n ? recStats.live.avgR.toFixed(2) : "-"}
                </span>
              </div>
            </div>
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14 }}>
              <div style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em", marginBottom: 8 }}>BACKTEST (SIEMBRA)</div>
              {recStats.btMeta ? (
                <>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>
                    {recStats.btMeta.signals} <span style={{ fontSize: 12, color: C.dim }}>senales · {recStats.btMeta.days}d · {recStats.btMeta.strategy}</span>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    Win rate: <span style={{ color: recStats.btMeta.winRate >= 0.5 ? C.green : C.red }}>
                      {(recStats.btMeta.winRate * 100).toFixed(0)}%
                    </span>
                    {" · "}R medio: <span style={{ color: recStats.btMeta.avgR >= 0 ? C.green : C.red }}>
                      {recStats.btMeta.avgR.toFixed(2)}
                    </span>
                  </div>
                  <div style={{ color: C.dim, fontSize: 10, marginTop: 4 }}>
                    {new Date(recStats.btMeta.ranAt).toLocaleDateString("es-CO")}
                  </div>
                </>
              ) : (
                <div style={{ color: C.dim, fontSize: 12 }}>Sin backtest aun. Corre uno para sembrar probabilidades.</div>
              )}
            </div>
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14 }}>
              <div style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em", marginBottom: 8 }}>MODELO (aprendizaje continuo)</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>
                {recStats.modelSeen} <span style={{ fontSize: 12, color: C.dim }}>muestras vistas</span>
              </div>
              <div style={{ color: C.dim, fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
                Regresion logistica online: se actualiza con cada senal resuelta.
              </div>
            </div>
          </div>

          {openTaken.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <div style={{ color: C.amber, fontSize: 11, letterSpacing: "0.1em" }}>
                  MIS POSICIONES ABIERTAS ({openTaken.length})<Help k="posiciones" />
                </div>
                <button onClick={refreshPositions} disabled={posBusy} style={{
                  background: "transparent", border: `1px solid ${C.accent}`, color: C.accent,
                  padding: "4px 10px", borderRadius: 3, cursor: "pointer", fontSize: 10, fontFamily: "inherit",
                }}>
                  {posBusy ? "..." : "REFRESCAR PRECIOS"}
                </button>
              </div>
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, overflow: "auto", marginBottom: 16 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: C.panel2 }}>
                      {["PAR", "DIR", "ENTRADA", "AHORA", "AVANCE", "ESTADO"].map((h) => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: C.dim, fontSize: 10, fontWeight: 500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {openTaken.map((s) => {
                      const px = posPx[s.symbol];
                      const risk = Math.abs(s.entry - s.stop) || 1;
                      const adv = px != null ? (s.dir === "long" ? px - s.entry : s.entry - px) / risk : null;
                      const tp1 = s.tps?.[0]?.price;
                      const hitTp1 = px != null && tp1 != null && (s.dir === "long" ? px >= tp1 : px <= tp1);
                      const nearStop = adv != null && adv <= -0.7;
                      return (
                        <tr key={s.id} style={{ borderTop: `1px solid ${C.border}` }}>
                          <td style={{ padding: "7px 12px", fontWeight: 600 }}>{s.symbol}</td>
                          <td style={{ padding: "7px 12px", color: s.dir === "long" ? C.green : C.red }}>
                            {s.dir === "long" ? "LARGO" : "CORTO"}
                          </td>
                          <td style={{ padding: "7px 12px" }}>{fmt(s.entry)}</td>
                          <td style={{ padding: "7px 12px" }}>{px != null ? fmt(px) : "-"}</td>
                          <td style={{ padding: "7px 12px", color: adv == null ? C.dim : adv >= 0 ? C.green : C.red }}>
                            {adv != null ? `${adv >= 0 ? "+" : ""}${adv.toFixed(2)}R` : "-"}
                          </td>
                          <td style={{ padding: "7px 12px", fontSize: 11, color: hitTp1 ? C.green : nearStop ? C.red : C.dim }}>
                            {adv == null ? "sin precio"
                              : adv <= -1 ? "stop tocado? VERIFICAR RESULTADOS"
                              : hitTp1 ? `TP1 alcanzado: mueve stop a BE (${fmt(s.entry)})`
                              : nearStop ? `cerca del stop ${fmt(s.stop)}`
                              : `stop ${fmt(s.stop)} · TP1 ${fmt(tp1)}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {curves.length > 0 && (
            <>
              <div style={{ color: C.dim, fontSize: 11, letterSpacing: "0.1em", marginBottom: 10 }}>
                CURVA DE RESULTADOS - R ACUMULADO<Help k="curva" />
              </div>
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, padding: 14, marginBottom: 16 }}>
                <EquityCurve series={curves} />
                <div style={{ color: C.dim, fontSize: 10, marginTop: 6 }}>
                  {curves.map((c, i) => (
                    <span key={i} style={{ marginRight: 14 }}>
                      <span style={{ color: c.color }}>—</span> {c.label} ({c.points.length} senales, {c.points[c.points.length - 1] >= 0 ? "+" : ""}{c.points[c.points.length - 1].toFixed(1)}R)
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}

          {recStats.rows.length > 0 && (
            <>
              <div style={{ color: C.dim, fontSize: 11, letterSpacing: "0.1em", marginBottom: 10 }}>
                WIN RATE POR SEGMENTO (suavizado bayesiano)
              </div>
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, overflow: "auto", marginBottom: 16, maxHeight: 260 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: C.panel2 }}>
                      {["SEGMENTO", "MUESTRAS", "WIN RATE"].map((h) => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: C.dim, fontSize: 10, fontWeight: 500, position: "sticky", top: 0, background: C.panel2 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recStats.rows.map((r) => (
                      <tr key={r.key} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ padding: "7px 12px" }}>{r.key}</td>
                        <td style={{ padding: "7px 12px", color: C.dim }}>{r.n}</td>
                        <td style={{ padding: "7px 12px", color: r.winRate >= 0.5 ? C.green : C.red }}>
                          {(r.winRate * 100).toFixed(0)}%{r.n < 20 ? <span style={{ color: C.dim }}> (pocas muestras)</span> : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div style={{ color: C.dim, fontSize: 11, letterSpacing: "0.1em", marginBottom: 10 }}>
            SENALES RECIENTES (en vivo + muestra del backtest)
          </div>
          {recordRows.length === 0 ? (
            <div style={{ color: C.dim, padding: 30, textAlign: "center", border: `1px dashed ${C.border}`, borderRadius: 4, fontSize: 12, lineHeight: 1.6 }}>
              Aun no hay senales registradas. Cada senal LARGO/CORTO que la app genere en Analisis
              se guarda sola, y el backtest siembra el historico de 90 dias.
            </div>
          ) : (
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4, overflow: "auto", maxHeight: 420 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: C.panel2 }}>
                    {["FECHA", "PAR", "DIR", "ESTRATEGIA", "CONF", "RESULTADO", "R", "ORIGEN"].map((h) => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: C.dim, fontSize: 10, fontWeight: 500, position: "sticky", top: 0, background: C.panel2 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recordRows.map((s, i) => (
                    <tr key={s.id ?? `bt-${i}`} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={{ padding: "7px 12px", color: C.dim, whiteSpace: "nowrap" }}>
                        {new Date(s.ts).toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td style={{ padding: "7px 12px", fontWeight: 600 }}>{s.symbol}</td>
                      <td style={{ padding: "7px 12px", color: s.dir === "long" ? C.green : C.red }}>
                        {s.dir === "long" ? "LARGO" : "CORTO"}
                      </td>
                      <td style={{ padding: "7px 12px", color: C.dim }}>{s.modo}</td>
                      <td style={{ padding: "7px 12px", color: C.dim }}>{s.confidence}</td>
                      <td style={{ padding: "7px 12px", color: outcomeColor(s.outcome, s.r) }}>
                        {s.outcome === "open" ? "abierta" : s.outcome === "expired" ? "expirada" : s.outcome === "win" ? `gano (${s.detail})` : `perdio (${s.detail})`}
                      </td>
                      <td style={{ padding: "7px 12px", color: (s.r ?? 0) > 0 ? C.green : (s.r ?? 0) < 0 ? C.red : C.dim }}>
                        {s.r != null ? `${s.r >= 0 ? "+" : ""}${s.r.toFixed(2)}R` : "-"}
                      </td>
                      <td style={{ padding: "7px 12px", color: C.dim }}>
                        {s.source}{s.taken ? " · tomada" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{
            marginTop: 16, padding: 12, border: `1px dashed ${C.border}`, borderRadius: 4,
            fontSize: 11, color: C.dim, lineHeight: 1.6,
          }}>
            El record vive en ESTE dispositivo/navegador (usa EXPORTAR como respaldo).
            Resultados por regla fija: stop antes de TP1 = perdida (-1R); tras TP1 el stop pasa a
            break-even; tramos 40/35/25 a 1R/1.8R/3R; 48h sin resolver = expirada.
            El backtest no incluye comisiones, funding ni slippage: el win rate real sera algo menor.
            Rendimiento pasado no garantiza resultados futuros.
          </div>
        </>
      )}
    </div>
  );
}
