// Clasificacion de activos en Binance spot. Todas las listas son editables:
// agrega o quita simbolos segun lo que Binance liste.

export const STABLES = new Set([
  "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "USDPUSDT", "DAIUSDT",
  "EURUSDT", "AEURUSDT", "EURIUSDT", "XUSDUSDT",
]);

export const COMMODITIES = new Set(["PAXGUSDT"]); // Pax Gold (oro tokenizado)
export const STOCK_TOKENS = new Set([]); // Binance retiro los stock tokens del spot; vacio por ahora

export const assetCat = (sym) =>
  COMMODITIES.has(sym) ? "commodities" : STOCK_TOKENS.has(sym) ? "acciones" : "cripto";

export const CAT_LABELS = [
  ["todos", "TODOS"], ["cripto", "CRIPTO"],
  ["commodities", "MATERIAS PRIMAS"], ["acciones", "ACCIONES"],
];

/* ---------- Subcategorias de cripto ---------- */
const SUBCAT_SETS = {
  memes: new Set([
    "DOGEUSDT", "SHIBUSDT", "PEPEUSDT", "WIFUSDT", "BONKUSDT", "FLOKIUSDT",
    "MEMEUSDT", "BOMEUSDT", "PENGUUSDT", "TRUMPUSDT", "BABYDOGEUSDT",
    "TURBOUSDT", "NEIROUSDT", "MOGUSDT", "BRETTUSDT", "POPCATUSDT",
    "PNUTUSDT", "ACTUSDT", "MEWUSDT", "DOGSUSDT", "CATUSDT", "1000SATSUSDT",
  ]),
  defi: new Set([
    "UNIUSDT", "AAVEUSDT", "LDOUSDT", "CRVUSDT", "MKRUSDT", "SKYUSDT",
    "PENDLEUSDT", "COMPUSDT", "SUSHIUSDT", "1INCHUSDT", "SNXUSDT",
    "DYDXUSDT", "GMXUSDT", "JTOUSDT", "JUPUSDT", "RAYUSDT", "CAKEUSDT",
    "RUNEUSDT", "KAVAUSDT", "INJUSDT", "ENAUSDT", "ETHFIUSDT", "MORPHOUSDT",
    "ONDOUSDT", "AEROUSDT", "HYPEUSDT",
  ]),
  l1: new Set([
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT",
    "NEARUSDT", "SUIUSDT", "TONUSDT", "APTUSDT", "TRXUSDT", "ATOMUSDT",
    "XRPUSDT", "LTCUSDT", "BCHUSDT", "XLMUSDT", "ALGOUSDT", "HBARUSDT",
    "ICPUSDT", "ETCUSDT", "FILUSDT", "VETUSDT", "EGLDUSDT", "FLOWUSDT",
    "SEIUSDT", "KASUSDT", "XTZUSDT", "MINAUSDT", "CELOUSDT", "SUSDT",
    "BERAUSDT", "IPUSDT",
  ]),
  l2: new Set([
    "ARBUSDT", "OPUSDT", "POLUSDT", "MATICUSDT", "STRKUSDT", "IMXUSDT",
    "MNTUSDT", "ZKUSDT", "METISUSDT", "MANTAUSDT", "BLASTUSDT", "TAIKOUSDT",
    "SCRUSDT", "LINEAUSDT", "ZROUSDT", "STXUSDT",
  ]),
  ia: new Set([
    "FETUSDT", "RENDERUSDT", "TAOUSDT", "GRTUSDT", "THETAUSDT", "AKTUSDT",
    "ARKMUSDT", "WLDUSDT", "IOUSDT", "AIUSDT", "NFPUSDT", "PHBUSDT",
    "VIRTUALUSDT", "AIXBTUSDT", "KAITOUSDT",
  ]),
  gaming: new Set([
    "SANDUSDT", "MANAUSDT", "AXSUSDT", "GALAUSDT", "ENJUSDT", "APEUSDT",
    "IMXUSDT", "RONUSDT", "PIXELUSDT", "PORTALUSDT", "YGGUSDT", "ILVUSDT",
    "MAGICUSDT", "NOTUSDT", "HMSTRUSDT", "XAIUSDT", "BIGTIMEUSDT",
  ]),
  exchange: new Set([
    "BNBUSDT", "OKBUSDT", "CROUSDT", "KCSUSDT", "GTUSDT", "BGBUSDT",
  ]),
};

export const SUBCAT_LABELS = [
  ["todas", "TODAS"], ["memes", "MEMES"], ["defi", "DEFI"], ["l1", "L1"],
  ["l2", "L2"], ["ia", "IA"], ["gaming", "GAMING"], ["exchange", "EXCHANGE"],
  ["otras", "OTRAS"],
];

// Orden de prioridad cuando un simbolo aparece en varias listas (p.ej. IMX en l2 y gaming).
const SUBCAT_PRIORITY = ["memes", "defi", "l2", "ia", "gaming", "exchange", "l1"];

export const subCat = (sym) => {
  for (const k of SUBCAT_PRIORITY) if (SUBCAT_SETS[k].has(sym)) return k;
  return "otras";
};
