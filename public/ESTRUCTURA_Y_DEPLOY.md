ESTRUCTURA_Y_DEPLOY.md
Estructura correcta del repo + qué falta
1) Estructura de carpetas que necesita server.js
server.js sirve estáticos desde public/ con:
app.use(express.static(path.join(__dirname, 'public')));
Eso significa que tu repo tiene que quedar así:
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
Si index.html está ahora mismo en la raíz del repo (no dentro de public/), movelo. Sin esto, Render te va a tirar 404 en la página principal.
2) Íconos (icon-192.png / icon-512.png)
El manifest.json y el service-worker.js que te armé referencian estos dos íconos para que la PWA se pueda "instalar" en el celular y para que las notificaciones push muestren un ícono. No los puedo generar yo (son imágenes PNG reales, no código). Opciones:
Más simple: usá cualquier logo/imagen cuadrada que tengas (aunque sea provisorio) y expórtala en 192x192 y 512x512 con cualquier editor o una web como https://www.pwabuilder.com/imageGenerator
Si no los subís, la app va a funcionar igual (señales, notificaciones, panel web), solo que el ícono de la notificación/PWA puede salir en blanco o con el ícono genérico del navegador. No es bloqueante.
3) Variables de entorno necesarias en Render/Railway
Revisando server.js y subscriptions.js, estas son las variables que tenés que cargar en el panel de Render (Environment):
DATABASE_URL=...            (connection string de Supabase — sin esto, el historial
                              y las suscripciones push no persisten entre redeploys)
TWELVEDATA_API_KEY=...
FINNHUB_API_KEY=...
ALPHAVANTAGE_API_KEY=...
FMP_API_KEY=...
COINGECKO_API_KEY=...       (opcional, CoinGecko funciona sin key hasta 10.000 pedidos/mes)
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:tu-email@ejemplo.com
DATA_DIR=/data              (solo si NO configuraste DATABASE_URL, como respaldo local)
PORT=                       (Render lo inyecta solo, no hace falta)
Nota: CRON_SCHEDULE ya no se usa — el refresco lo maneja el scheduler autoajustable de engine.js (startAutoRefreshLoop), no un cron fijo.
Las claves VAPID las generás una sola vez corriendo localmente o en Render:
npm run vapid
(ya está el script en tu package.json). Te va a tirar un par público/privado para pegar en esas dos variables.
4) Base de datos persistente (recordatorio, importante)
Historial, auto-tune y suscripciones push ahora viven en Supabase (Postgres), no en disco — con DATABASE_URL configurada, sobreviven a cualquier redeploy o reinicio del contenedor en Render. Sin DATABASE_URL, las suscripciones push caen a un archivo en disco (data/subscriptions.json) que Render sí borra en cada redeploy — esto fue lo que probablemente causó el último corte de notificaciones sin ningún error visible.
Asegurate de tener DATABASE_URL seteada en Render con la connection string de tu proyecto de Supabase.
Si además querés un disco persistente como respaldo extra (no es necesario si ya tenés Supabase): tu servicio → Disks → Add Disk → montalo en /data, y seteá DATA_DIR=/data.
5) Chequeo rápido post-deploy
Abrí la URL de Render → debería cargar el panel (si sigue en blanco/404, revisá el punto 1).
Tocá "Activar notificaciones" → si dice "Servidor sin configurar", faltan las VAPID keys.
Mirá /health → debería devolver {"ok":true,"uptime":...}.
Mirá los logs de Render un par de minutos: debería aparecer actividad del primer runCycle() y, 2 minutos después, el backtest inicial.
