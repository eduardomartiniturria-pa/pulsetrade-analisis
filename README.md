# PulseTrade PRO — backend (corre solo, sin celular abierto)

Esto reemplaza la lógica que antes vivía en tu navegador. El motor de señales (SMCEngine,
auto-tune, backtest — todo igual que antes, no se tocó la lógica de trading) ahora corre en un
servidor que nunca se apaga. Cuando detecta una señal nueva, te manda una notificación push al
celular. Vos seguís operando manualmente en tu bróker; esto solo te avisa.

## Qué cambió vs. la versión HTML original
- El historial y el auto-aprendizaje ya no se guardan en el `localStorage` del celular (se
  perdían si borrabas datos del navegador) — ahora viven en el servidor, persistentes.
- Las señales llegan por notificación push instalable, no hace falta tener la app abierta.
- Las API keys se configuran una sola vez en el servidor (`.env`), no en cada celular.

## 1. Generar las claves VAPID (para las notificaciones push)
```bash
npm install
npx web-push generate-vapid-keys
```
Copia las dos claves que te da a tu archivo `.env` (`VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`).

## 2. Configurar `.env`
Copia `.env.example` a `.env` y completa al menos las claves VAPID. Las API keys de datos
(TwelveData, Finnhub, etc.) son opcionales — BTC/ETH funcionan sin ninguna (Binance público),
pero EUR/USD y XAU/USD necesitan al menos una key gratuita de TwelveData
(https://twelvedata.com, plan free).

## 3. Probar en local
```bash
npm install
npm start
```
Abre `http://localhost:3000` en el celular (misma red) o en la compu, tocá "Activar
notificaciones" y dejalo correr.

## 4. Desplegar gratis (Render.com)
1. Sube esta carpeta a un repositorio de GitHub.
2. En https://render.com, crea un **Web Service** nuevo → conecta el repo.
3. Build command: `npm install` — Start command: `npm start`.
4. En "Environment", carga las mismas variables de tu `.env`.
5. Deploy. Te da una URL pública tipo `https://pulsetrade-tuservicio.onrender.com`.

**Importante:** el plan free de Render "duerme" el servicio tras ~15 min sin tráfico, y al
dormirse deja de correr el motor. Para que corra 24/7 gratis, agregá un segundo servicio gratuito
que lo despierte solo:

## 5. Mantenerlo despierto 24/7 (gratis, cron-job.org)
1. Anda a https://cron-job.org (gratis, sin tarjeta).
2. Crea un cron job que haga GET a `https://tu-url-de-render.onrender.com/health` cada 10 minutos.
Eso mantiene el servidor despierto sin depender de tu celular ni de que abras nada — corre solo,
en la nube, para siempre.

## 6. Instalar el panel como app en tu celular
Abre la URL pública en Chrome (Android) o Safari (iPhone 16.4+) → menú → "Agregar a pantalla de
inicio". Al abrirla, tocá "Activar notificaciones" una vez. Desde ahí, las señales te llegan como
notificación aunque tengas la app cerrada o el celular bloqueado.

## Archivos
- `engine.js` — tu motor de señales original (SMCEngine, auto-tune, backtest), adaptado para
  correr en Node en vez del navegador. La lógica de trading no se modificó.
- `server.js` — expone la API, corre el motor cada 5 minutos (cron) y sirve el panel.
- `subscriptions.js` — guarda a quién avisar y envía las notificaciones push.
- `localStorage.js` — reemplaza el almacenamiento del navegador por un archivo en disco.
- `public/` — el panel instalable (PWA) que ves en el celular.

## Nota sobre persistencia
El historial se guarda en `data/store.json` dentro del servidor. En el plan free de Render el
disco es efímero: si Render reinicia el contenedor (redeploy, o inactividad prolongada) podrías
perder el historial acumulado. Si esto te preocupa, decime y armamos que guarde en una base de
datos gratuita externa (Supabase, por ejemplo) que sí persiste siempre.
