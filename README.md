# Copiloto Binance v2

Herramienta de análisis técnico para pares USDT de Binance Spot. Calcula señales sobre velas **cerradas** (sin repintado) usando la API pública de Binance — no requiere API key.

## Funcionalidades

- **Escáner de mercado**: filtra pares USDT por volumen 24h, detecta oportunidades de momentum y reversión, y muestra el top 40 por volumen.
- **Análisis multi-timeframe** (15m / 1h / 4h): EMA 9/21/50/200, RSI 14, MACD, ATR, OBV, StochRSI, Bandas de Bollinger, niveles Fibonacci y soportes/resistencias.
- **Motor de señales**: confluencia de indicadores núcleo + confirmaciones extra, con sesgo de timeframes mayores y contexto de BTC.
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

## Notas

- Usa `api.binance.com` con fallback automático al mirror `data-api.binance.vision` (útil ante restricciones regionales).
- Las señales se calculan sobre velas cerradas; el precio en vivo puede diferir del último cierre.
- **Herramienta de gestión de riesgo, no recomendación de inversión.** La mayoría de traders minoristas de cripto pierde dinero.
