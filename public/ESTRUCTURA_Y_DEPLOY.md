# Estructura correcta del repo + qué falta

## 1) Estructura de carpetas que necesita `server.js`

`server.js` sirve estáticos desde `public/` con:
```js
app.use(express.static(path.join(__dirname, 'public')));
```

Eso significa que tu repo tiene que quedar así:

```
/ (raíz del repo)
├── server.js
├── engine.js
├── localStorage.js
├── subscriptions.js
├── package.json
├── .env                      (no se sube a git, solo en Render/Railway como variables)
└── public/
    ├── index.html
    ├── manifest.json         <- te lo armé, adjunto
    ├── service-worker.js     <- te lo armé, adjunto
    ├── icon-192.png          <- FALTA, ver abajo
    └── icon-512.png          <- FALTA, ver abajo
```

Si `index.html` está ahora mismo en la raíz del repo (no dentro de `public/`),
movelo. Sin esto, Render te va a tirar 404 en la página principal.

## 2) Íconos (icon-192.png / icon-512.png)

El `manifest.json` y el `service-worker.js` que te armé referencian estos dos
íconos para que la PWA se pueda "instalar" en el celular y para que las
notificaciones push muestren un ícono. No los puedo generar yo (son imágenes
PNG reales, no código). Opciones:

- Más simple: usá cualquier logo/imagen cuadrada que tengas (aunque sea
  provisorio) y expórtala en 192x192 y 512x512 con cualquier editor o una
  web como https://www.pwabuilder.com/imageGenerator
- Si no los subís, la app va a funcionar igual (señales, notificaciones,
  panel web), solo que el ícono de la notificación/PWA puede salir en blanco
  o con el ícono genérico del navegador. No es bloqueante.

## 3) Variables de entorno necesarias en Render/Railway

Revisando `server.js` y `subscriptions.js`, estas son las variables que
tenés que cargar en el panel de Render (Environment):

```
TWELVEDATA_API_KEY=...
FINNHUB_API_KEY=...
ALPHAVANTAGE_API_KEY=...
FMP_API_KEY=...
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:tu-email@ejemplo.com
DATA_DIR=/data              (si configuraste un disco persistente)
CRON_SCHEDULE=*/5 * * * *   (opcional, ya tiene default)
PORT=                       (Render lo inyecta solo, no hace falta)
```

Las claves VAPID las generás una sola vez corriendo localmente o en Render:
```
npm run vapid
```
(ya está el script en tu `package.json`). Te va a tirar un par público/privado
para pegar en esas dos variables.

## 4) Disco persistente (recordatorio, importante)

Sin esto, cada redeploy en Render borra `data/store.json` y
`data/subscriptions.json`, y perdés historial, auto-tune calibrado y todas
las suscripciones push registradas.

- Render: tu servicio → **Disks** → Add Disk → montalo en `/data`.
- Luego seteá `DATA_DIR=/data` en las variables de entorno.

## 5) Chequeo rápido post-deploy

1. Abrí la URL de Render → debería cargar el panel (si sigue en blanco/404,
   revisá el punto 1).
2. Tocá "Activar notificaciones" → si dice "Servidor sin configurar",
   faltan las VAPID keys.
3. Mirá `/health` → debería devolver `{"ok":true,"uptime":...}`.
4. Mirá los logs de Render un par de minutos: debería aparecer actividad del
   primer `runCycle()` y, 2 minutos después, el backtest inicial.
