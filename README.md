# PulseTrade PRO — backend (corre solo, sin celular abierto)

Servidor Node que corre el motor de señales en la nube, todo el día. Cuando detecta una señal
nueva, manda una notificación push al celular. Vos seguís operando manualmente en tu bróker
(MT5); la app solo te avisa. No ejecuta operaciones.

## Estado actual del sistema

- **Activos:** XAUUSD, EURUSD, US500 y GBPUSD. BTCUSD y ETHUSD salieron de la app el 20/9; su
  historial se conserva y sigue visible en el historial por período.
- **Estrategias activas** (`CONFIG.ENABLED_STRATEGIES` en `engine.js`): `kill_zone_ny`,
  `supply_demand` y `session_breakout_vwap`. El resto del código de estrategias sigue en
  `custom-strategies.js` pero apagado con flags. Si un flag no coincide con la lista, el
  proceso frena el arranque a propósito (`assertStrategyFlagsSync()`).
- **Modo sombra:** US500 y GBPUSD registran señales sin push hasta juntar 12 operaciones LIVE
  por estrategia (`CONFIG.SHADOW_MODE`, `PROFITABILITY_ENGINE_V1.minLiveSample`). El avance se
  ve en `/api/shadow`.
- **Sesión de consulta (forex y oro):** solo se piden datos de lunes a viernes, de 3:00 a
  17:00 hora de Nueva York (Londres + Nueva York), para cuidar el cupo de Twelve Data. US500
  se rige por su propio horario de la bolsa de Nueva York.
- **Horarios de mercado:** cada activo tiene su perfil (pausas diarias, cierre de fin de
  semana). Durante una pausa o cierre no se generan señales. El estado sale en
  `/api/state` → `marketStatus`.
- **Frecuencia de refresco:** un scheduler autoajustable (`startAutoRefreshLoop`) refresca cada
  15 min normalmente y cada 4 min dentro de la ventana Kill Zone NY (9:30–12:30 hora de
  Nueva York, 10:30–13:30 hora de Argentina). No hay un cron fijo. A los 2 minutos del arranque
  corre el backtest de calibración.

## Proveedores de datos

| Proveedor | Uso |
|---|---|
| Twelve Data (plan Grow) | Principal: cotizaciones y velas de los 4 activos. US500 se obtiene por proxy de SPY. |
| FMP | Solo cotizaciones (sus velas exigen un plan pago). |
| Finnhub | Solo cotizaciones (sus velas exigen un plan pago). |
| Alpha Vantage | Respaldo, 25 pedidos por día compartidos. |
| ExchangeRate-API | Último recurso para EURUSD y GBPUSD (tasa que se actualiza 1 vez por día, se descarta si queda congelada). |

Los proveedores de cripto (Binance, CoinGecko, OKX) se retiraron del código el 20/9.

**Plan Grow de Twelve Data:** el motor se autolimita a 800 pedidos por día salvo que definas la
variable `TWELVEDATA_DAILY_LIMIT=none` en Render. Con el plan Grow hay que definirla.

## Qué cambió vs. la versión HTML original

- El historial y el auto-aprendizaje ya no viven en el `localStorage` del celular: viven en el
  servidor, en Supabase.
- Las señales llegan por notificación push, no hace falta tener la app abierta.
- Las API keys se cargan una sola vez en el servidor (variables de entorno), no en cada celular.

## 1. Generar las claves VAPID (notificaciones push)

```bash
npm install
npx web-push generate-vapid-keys
```

Copiá las dos claves a `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` (en tu `.env` o en Render).

## 2. Configurar las variables de entorno

Copiá `.env.example` a `.env` si lo tenés, o cargá las variables directo en Render (ver la
lista completa en `ESTRUCTURA_Y_DEPLOY.md`). Mínimo para que funcione:

- `DATABASE_URL` (Supabase), para que historial y suscripciones persistan.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT`.
- `TWELVEDATA_API_KEY` (plan Grow). Sin Twelve Data no hay datos suficientes para los 4 activos.
- `FMP_API_KEY`, `FINNHUB_API_KEY` y `ALPHAVANTAGE_API_KEY` como respaldo de cotizaciones.

## 3. Probar en local

```bash
npm install
npm start
```

Abrí `http://localhost:3000` en la compu o en el celular (misma red), tocá "Activar
notificaciones" y dejalo correr.

## 4. Desplegar (Render.com)

1. Subí esta carpeta a un repositorio de GitHub.
2. En https://render.com creá un **Web Service** nuevo y conectá el repo.
3. Build command: `npm install` — Start command: `npm start`.
4. En "Environment", cargá las variables.
5. Deploy. Te da una URL pública tipo `https://pulsetrade-tuservicio.onrender.com`.

**Importante:** el plan free de Render "duerme" el servicio tras ~15 min sin tráfico, y al
dormirse el motor deja de correr. Para que corra todo el día, hacé que alguien lo despierte
solo (punto siguiente).

## 5. Mantenerlo despierto (gratis, cron-job.org)

1. Entrá a https://cron-job.org (gratis, sin tarjeta).
2. Creá un cron job que haga GET a `https://tu-url-de-render.onrender.com/health` cada 10
   minutos.

## 6. Instalar el panel como app en el celular

Abrí la URL pública en Chrome (Android) o Safari (iPhone 16.4 o superior) → menú → "Agregar a
pantalla de inicio". Al abrirla, tocá "Activar notificaciones" una vez. Desde ahí las señales
llegan como notificación aunque la app esté cerrada o el celular bloqueado.

## Endpoints

| Ruta | Qué devuelve |
|---|---|
| `GET /api/state` | Señales actuales, precios, últimas 50 operaciones, estadísticas por símbolo y estrategia, auto-tune, estado de mercado y diagnósticos (`diagnostics`: cupo usado por proveedor, variable `TWELVEDATA_DAILY_LIMIT`, spread real vs. estimado). |
| `GET /api/shadow` | Avance del modo sombra: operaciones LIVE por activo y estrategia contra la muestra mínima. |
| `GET /api/history/days` | Días que tienen al menos una señal cerrada. |
| `GET /api/history/:period/:date` | Resumen de señales cerradas por `day`, `week` o `month` (fecha `YYYY-MM-DD`), con desglose por estrategia y por activo. |
| `GET /api/vapid-public-key` | Clave pública para activar notificaciones. |
| `POST /api/subscribe` y `POST /api/unsubscribe` | Alta y baja de un dispositivo para push. |
| `POST /api/check-now` | Fuerza un chequeo inmediato. |
| `GET /api/recalibrate` | Recalibra el auto-tune (backtest completo). Es GET para poder abrirlo desde el navegador. |
| `GET /health` | `{ ok, uptime }` para el pinger y como chequeo de salud. |

## Archivos

- `engine.js` — motor de señales: proveedores de datos, horarios de mercado, auto-tune,
  circuit breakers, modo sombra y backtest. La versión figura en el comentario de cabecera.
- `custom-strategies.js` — las estrategias de trading (activas y apagadas).
- `server.js` — expone la API, arranca el scheduler y sirve el panel.
- `subscriptions.js` — guarda a quién avisar (Supabase) y envía las notificaciones push.
- `localStorage.js` — reemplaza el almacenamiento del navegador por un espejo en memoria
  respaldado en Supabase.
- `public/` — el panel instalable (PWA): `index.html`, `manifest.json`, `service-worker.js` e
  íconos.

## Persistencia

Historial, auto-tune y suscripciones push se guardan en Supabase (Postgres): tabla `kv_store`
para el motor y `push_subscriptions` para los dispositivos. Sobreviven a redeploys y reinicios
mientras `DATABASE_URL` esté configurada. Cada escritura pendiente se espera antes de apagar
el proceso (al recibir SIGTERM de Render), y las escrituras sobre la misma key se hacen en
orden.

Sin `DATABASE_URL`, el motor no persiste nada entre reinicios y las suscripciones caen a un
archivo en disco (`data/subscriptions.json`) que Render borra en cada redeploy. Solo sirve
para correr local.

## Limitaciones conocidas

- **Calendario económico:** el feed público de noticias bloquea la IP de Render (HTTP 429) y el
  proxy no responde. Mientras siga así, el ajuste de score por noticias queda sin datos. El
  motor reintenta como máximo una vez cada 30 minutos.
- **Spread:** Twelve Data no entrega bid/ask reales en `/quote`, así que la compuerta de costo
  usa la tabla de spreads estimados de Exness (`ESTIMATED_SPREAD_PIPS_BY_SYMBOL`).
- **Velas en formación:** las estrategias pueden evaluar la vela de 15 minutos todavía abierta.
  El diagnóstico `candleAge` en `/api/state` muestra cuántos ciclos ocurrió.
