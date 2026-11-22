# Rebufo 3D

Repeticiones 3D de sesiones de Fórmula 1 en el navegador, con datos reales de [OpenF1](https://openf1.org) (2023 en adelante) o una carrera simulada.

## Qué hace

- Pista 3D construida con las posiciones reales de los coches, carril de boxes y números de curva.
- Torre de tiempos con intervalo, diferencia con el líder o vuelta.
- Cámaras: pista, órbita, persecución, T-cam, helicóptero y director automático.
- Telemetría del coche que sigues: velocidad, marcha, acelerador, freno, RPM y DRS.
- Ambientes de día, atardecer, noche y lluvia.

## Uso

Es un solo archivo estático (`index.html`) con Three.js r128 cargado desde cdnjs. Para probarlo en local, ábrelo en el navegador o sírvelo con cualquier servidor estático:

```bash
npx serve .
```

## Despliegue

Importa el repositorio en Vercel como proyecto sin framework: no necesita build ni configuración.

## Modo en vivo (relay)

La carpeta `relay/` tiene un servidor Node que se conecta al feed de tiempos en vivo de F1 (SignalR Core, con respaldo al SignalR clásico), descomprime los temas `Position.z` y `CarData.z`, y reenvía posiciones, telemetría, tiempos y mensajes de dirección de carrera a la app por WebSocket.

Despliegue en Render: **New → Blueprint**, elige este repositorio y Render lee `render.yaml` (plan gratis, carpeta `relay`). En la app, ve a **Sesión → En vivo** y pega la dirección del servicio (`wss://<nombre>.onrender.com`).

En el plan gratis de Render el servicio se duerme tras 15 minutos sin tráfico; abrir su dirección en el navegador lo despierta en menos de un minuto.

Para probarlo en local: `cd relay && npm install && npm start` (puerto 8080).

## Aviso

Proyecto de fans no oficial, sin relación con Formula 1 ni con la FIA. Los datos vienen de OpenF1 y MultiViewer.
