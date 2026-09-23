# ESTRUCTURA_Y_DEPLOY.md

Estructura del repo, variables de entorno y chequeos de deploy de PulseTrade PRO.

## 1) Estructura de carpetas que necesita `server.js`

`server.js` sirve los archivos estáticos desde `public/` con:

```js
app.use(express.static(path.join(__dirname, 'public')));
```

Por eso el repo tiene que quedar así:

```
/ (raíz del repo)
├── server.js
├── engine.js
├── custom-strategies.js
├── localStorage.js
├── subscriptions.js
├── package.json
├── .env                      (no se sube a git; en Render van como variables de entorno)
└── public/
    ├── index.html
    ├── manifest.json
    ├── service-worker.js
    ├── icon-192.png
    └── icon-512.png
```

Si `index.html` está en la raíz del repo y no dentro de `public/`, movelo. Sin eso, Render
devuelve 404 en la página principal.

## 2) Íconos (`icon-192.png` / `icon-512.png`)

`manifest.json` y `service-worker.js` referencian estos dos íconos para que la PWA se pueda
instalar en el celular y para que las notificaciones push muestren un ícono. Son imágenes PNG
reales. Podés usar cualquier logo cuadrado exportado a 192x192 y 512x512 (por ejemplo con
https://www.pwabuilder.com/imageGenerator).

Si faltan, la app funciona igual (señales, notificaciones, panel); solo puede salir el ícono
genérico del navegador. No es bloqueante.

## 3) Variables de entorno (Render → Environment)

Estas son las que el código realmente lee:

| Variable | Obligatoria | Qué hace |
|---|---|---|
| `DATABASE_URL` | Sí | Connection string de Supabase. Sin ella, el historial y las suscripciones push no persisten entre redeploys. |
| `TWELVEDATA_API_KEY` | Sí | Proveedor principal (cotizaciones y velas de los 4 activos). |
| `TWELVEDATA_DAILY_LIMIT` | Sí, con plan Grow | Poné `none` para sacar el freno interno de 800 pedidos por día. Sin definir, el motor se autolimita a 800 aunque pagues el plan Grow y, al agotarse, quedás sin velas. Acepta también un número. |
| `FMP_API_KEY` | Recomendada | Cotizaciones de respaldo. |
| `FINNHUB_API_KEY` | Recomendada | Cotizaciones de respaldo (incluye US500). |
| `ALPHAVANTAGE_API_KEY` | Recomendada | Respaldo (25 pedidos por día). |
| `VAPID_PUBLIC_KEY` | Sí | Clave pública de notificaciones push. |
| `VAPID_PRIVATE_KEY` | Sí | Clave privada de notificaciones push. |
| `VAPID_SUBJECT` | Recomendada | Por ejemplo `mailto:tu-email@ejemplo.com`. Si falta, usa un valor de ejemplo. |
| `FMP_OHLCV_ENABLED` | No | `true` solo si pasás FMP a un plan que incluya velas. Por defecto FMP se usa solo para cotizaciones. |
| `FINNHUB_OHLCV_ENABLED` | No | `true` solo si pasás Finnhub a un plan que incluya velas. Por defecto solo cotizaciones. |
| `DATA_DIR` | No | Carpeta del respaldo en disco de las suscripciones, solo si no hay `DATABASE_URL`. |
| `PORT` | No | Render la inyecta sola. |

Variables que **ya no se usan** (podés borrarlas de Render si están cargadas):

- `COINGECKO_API_KEY`: CoinGecko se retiró del código el 20/9 junto con BTC y ETH.
- `CRON_SCHEDULE`: el refresco lo maneja el scheduler autoajustable de `engine.js`
  (`startAutoRefreshLoop`), no un cron fijo. No agregues un cron aparte: duplicaría los
  pedidos y empeoraría el límite de los proveedores.

Las claves VAPID se generan una sola vez:

```bash
npm run vapid
```

(o `npx web-push generate-vapid-keys`). Da un par público y privado para pegar en las dos
variables.

## 4) Base de datos persistente (importante)

Historial, auto-tune y suscripciones push viven en Supabase (Postgres):

- Tabla `kv_store`: todo lo que guarda el motor (historial, señales cerradas, estadísticas,
  auto-tune).
- Tabla `push_subscriptions`: los dispositivos que reciben notificaciones.

Ambas tablas se crean solas al arrancar. Con `DATABASE_URL` configurada sobreviven a cualquier
redeploy o reinicio. Al recibir SIGTERM (redeploy), el proceso espera a que terminen las
escrituras pendientes antes de apagarse.

Sin `DATABASE_URL`, el historial no persiste y las suscripciones push caen a un archivo en
disco (`data/subscriptions.json`), que Render borra en cada redeploy. Eso deja al servidor sin
suscriptores y sin ningún error visible: el motor detecta señales y no manda push a nadie.
Verificá siempre que `DATABASE_URL` esté seteada.

Un disco persistente de Render (Disks → montado en `/data` con `DATA_DIR=/data`) es un respaldo
extra, pero no es necesario si ya usás Supabase.

## 5) Chequeo rápido post-deploy

1. Abrí la URL de Render: debería cargar el panel (si da 404 o queda en blanco, revisá el
   punto 1).
2. Tocá "Activar notificaciones": si dice "Servidor sin configurar", faltan las claves VAPID.
3. `/health` debería devolver `{"ok":true,"uptime":...}`.
4. `/api/state` → `diagnostics.env`: `TWELVEDATA_DAILY_LIMIT` no debería decir "(sin definir →
   800 por defecto)" si estás en plan Grow.
5. `/api/state` → `diagnostics.providerUsage`: muestra cuántos pedidos gastó hoy cada
   proveedor. Con `TWELVEDATA_DAILY_LIMIT=none` el límite de Twelve Data figura como `null`.
6. Mirá los logs de Render unos minutos: debería aparecer actividad de cada ciclo de
   refresco (líneas `[E0-quote]` y `[E0-vela]` por activo) y, 2 minutos después del arranque,
   el backtest inicial.

## 6) Logs útiles

- `[E0-quote] ... spread usado por la compuerta = X pips`: confirma que la compuerta de costo
  usa el spread estimado de la tabla de Exness cuando el proveedor no trae bid/ask reales.
- `[push] enviando ...`: se imprime en cada push real intentado.
- `[NewsCalendar] fallo ...`: el calendario económico no está disponible (ver "Limitaciones
  conocidas" en `README.md`).
- `[cleanup] ...`: limpiezas únicas de auto-tune que corren al arrancar.
