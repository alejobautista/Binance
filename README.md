# Copiloto Binance v2

Herramienta de análisis técnico para pares USDT de Binance Spot. Calcula señales sobre velas **cerradas** (sin repintado) usando la API pública de Binance — no requiere API key.

## Funcionalidades

- **Escáner de mercado**: filtra pares USDT por volumen 24h, detecta oportunidades de momentum y reversión, y muestra el top 40 por volumen.
- **Dos estrategias seleccionables**:
  - **Indicadores**: confluencia de EMAs 9/21, RSI 14, MACD y Bandas de Bollinger — cada indicador se puede activar o desactivar individualmente.
  - **Estructura (BOS/CHoCH)**: detección de pivotes HH/HL/LH/LL sobre velas cerradas, con eventos BOS (rompimiento a favor de tendencia) y CHoCH+/− (cambio de carácter). La estructura de 1h actúa como filtro de sesgo.
- **Análisis multi-timeframe** (15m / 1h / 4h) con sesgo de timeframes mayores y contexto de BTC.
- **Estrategia PATRONES con cerebro dedicado** (`src/pattern*.js`): detecta 16 figuras chartistas (hombro-cabeza-hombro, dobles y triples techos/suelos, taza con asa, banderas, banderines, cuñas, triángulos, rectángulos) sobre pivotes confirmados, y calcula entrada, stop estructural y 3 take-profits por ATR. Cada figura pasa por validaciones de tamaño, ancho, **contención real del precio entre las rectas**, volumen, R:R neto de costes y latencia desde la ruptura.
  - **Cerebro propio, aislado del modelo general**: una neurona sigmoide (regresión logística online) con **estandarización Welford**, L2, **compensación de desbalance win/loss** y métricas de calidad (log-loss vs. la tasa base, Brier, convergencia). Solo filtra señales tras 40 trades resueltos; antes, su `p(win)` sería ~50% para todo.
  - **Cosecha (shadow trades)**: el backtest no evalúa ventana a ventana sino que detecta **todas** las figuras del histórico —incluidas las que no se dibujan— y las resuelve contra el precio real. Con rotación de pivotes explora además combinaciones más antiguas. Es lo que llena el modelo de muestras.
  - **TP/SL adaptativos**: los objetivos salen de percentiles del MFE real y el stop del MAE de los ganadores ("cuánto suele ir en contra un trade que después funciona"), mezclados con los valores fijos por encogimiento bayesiano.
  - **Canal federado**: exporta/importa los pesos (W/MEAN/SD/TPSL). Como las features son adimensionales o están normalizadas por ATR, un modelo entrenado en un símbolo sirve en otro. Formato compatible con el indicador de TradingView en `pine/`.
- **Motor de aprendizaje continuo**: cada señal se registra automáticamente y se verifica contra el precio real (stop, TPs escalonados con break-even, expiración a 48h). La probabilidad de cada señal nueva sale de un modelo híbrido: regresión logística online (se actualiza con cada resultado) + win-rates bayesianos por segmento. Backtest de 90 días para sembrar el historial. Todo vive en `localStorage` del dispositivo, con export/import JSON.
- **Top 3 señales reales** en el escáner: corre el motor completo sobre los candidatos del filtro activo y rankea por probabilidad histórica.
- **Filtros por tipo de activo y subcategoría cripto**: memes, DeFi, L1, L2, IA, gaming, exchange.
- **Gestión de riesgo**: zona de entrada, stop-loss por ATR, take-profits escalonados (1R/1.8R/3R), apalancamiento máximo seguro y cálculo de tamaño de posición según capital y % de riesgo.

## Cómo correrlo

```bash
npm install
npm run dev
```

Abre http://localhost:5173 en el navegador.

Para generar el build de producción:

```bash
npm run build
npm run preview
```

## Indicador de TradingView

`pine/auto_pattern_detector.pine` es el detector de patrones original (Pine v6), del que salió la
estrategia PATRONES de la app. Ambos comparten el mismo diseño de cerebro y el mismo formato de
pesos, así que los modelos se pueden intercambiar entre TradingView y el Copiloto.

## Notas

- Usa `api.binance.com` con fallback automático al mirror `data-api.binance.vision` (útil ante restricciones regionales).
- Las señales se calculan sobre velas cerradas; el precio en vivo puede diferir del último cierre.
- Los patrones chartistas son **poco frecuentes por diseño**: en pruebas, solo ~1,7% de las velas
  tiene una figura con ruptura lo bastante reciente para operarse. Que PATRONES diga "SIN OPERAR"
  la mayor parte del tiempo en un símbolo suelto es el comportamiento esperado; el escáner, que
  evalúa decenas de pares, es donde rinde.
- **Herramienta de gestión de riesgo, no recomendación de inversión.** La mayoría de traders minoristas de cripto pierde dinero.
