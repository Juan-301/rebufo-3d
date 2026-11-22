// Rebufo relay: se conecta al feed de tiempos en vivo de F1 y lo reenvía, ya descomprimido
// y simplificado, a los navegadores conectados por WebSocket.
// Uso personal. No es una API oficial: F1 puede cambiarla o cerrarla en cualquier momento.
import http from 'node:http';
import zlib from 'node:zlib';
import WebSocket, { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8080;
const F1 = (process.env.F1_BASE || 'https://livetiming.formula1.com').replace(/\/$/, '');
const F1_WS = F1.replace(/^http/, 'ws');
const TOPICS = ['Heartbeat', 'SessionInfo', 'DriverList', 'TimingData', 'TimingAppData', 'LapCount',
  'TrackStatus', 'Position.z', 'CarData.z', 'ExtrapolatedClock', 'RaceControlMessages', 'WeatherData'];
const RS = '\u001e';
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- estado ---------- */
const state = {}; // tema -> datos fusionados
let upstream = null, upstreamMode = '', lastFeed = 0, idleTimer = null, reconnectTimer = null;

function merge(dst, src) {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) return src;
  if (dst === null || typeof dst !== 'object' || Array.isArray(dst)) dst = {};
  for (const k of Object.keys(src)) {
    if (k === '_deleted') { for (const d of src[k] || []) delete dst[d]; continue; }
    dst[k] = merge(dst[k], src[k]);
  }
  return dst;
}
function inflate(b64) {
  try { return JSON.parse(zlib.inflateRawSync(Buffer.from(b64, 'base64')).toString('utf8')); }
  catch (e) { return null; }
}

/* ---------- mensajes hacia el navegador ---------- */
const clients = new Set();
function send(ws, msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcast(msg) { const s = JSON.stringify(msg); for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(s); }

function driversMsg() {
  const out = {};
  for (const [num, d] of Object.entries(state.DriverList || {})) {
    if (!d || typeof d !== 'object' || !d.Tla) continue;
    out[num] = { code: d.Tla, name: d.FullName || d.BroadcastName || '', team: d.TeamName || '', color: '#' + (d.TeamColour || '8a8f98'), line: +d.Line || 99 };
  }
  return { type: 'drivers', drivers: out };
}
function sessionMsg() {
  const s = state.SessionInfo || {}, m = s.Meeting || {};
  return {
    type: 'session', name: s.Name || '', meeting: m.Name || '', country: (m.Country || {}).Name || '',
    circuitKey: (m.Circuit || {}).Key || null, circuit: (m.Circuit || {}).ShortName || '',
    year: s.StartDate ? +String(s.StartDate).slice(0, 4) : new Date().getUTCFullYear(),
    status: s.SessionStatus || '', trackStatus: (state.TrackStatus || {}).Message || ''
  };
}
function timingMsg() {
  const lines = {}, L = (state.TimingData || {}).Lines || {};
  for (const [num, l] of Object.entries(L)) {
    if (!l || typeof l !== 'object') continue;
    lines[num] = {
      p: +l.Position || +l.Line || 99,
      gap: l.GapToLeader ?? (l.TimeDiffToFastest || null),
      int: (l.IntervalToPositionAhead || {}).Value ?? (l.TimeDiffToPositionAhead || null),
      lap: +l.NumberOfLaps || 0, pit: !!(l.InPit || l.PitOut), out: !!(l.Retired || l.Stopped)
    };
  }
  const lc = state.LapCount || {};
  return { type: 'timing', lines, lap: +lc.CurrentLap || 0, total: +lc.TotalLaps || 0 };
}
function snapshot(ws) {
  send(ws, { type: 'status', upstream: upstreamMode || 'desconectado', lastFeed });
  if (state.SessionInfo) send(ws, sessionMsg());
  if (state.DriverList) send(ws, driversMsg());
  if (state.TimingData) send(ws, timingMsg());
}

/* ---------- procesamiento del feed ---------- */
function onTopic(topic, data, ts) {
  lastFeed = Date.now();
  if (topic.endsWith('.z')) {
    const obj = typeof data === 'string' ? inflate(data) : data;
    if (!obj) return;
    if (topic === 'Position.z') {
      for (const p of obj.Position || []) {
        const t = Date.parse(p.Timestamp), c = {};
        for (const [num, e] of Object.entries(p.Entries || {})) c[num] = [e.X, e.Y, e.Z, e.Status === 'OffTrack' ? 0 : 1];
        if (isFinite(t)) broadcast({ type: 'pos', t, c });
      }
    } else if (topic === 'CarData.z') {
      for (const e of obj.Entries || []) {
        const t = Date.parse(e.Utc), c = {};
        for (const [num, car] of Object.entries(e.Cars || {})) {
          const ch = car.Channels || {};
          c[num] = [ch['0'] || 0, ch['2'] || 0, ch['3'] || 0, ch['4'] || 0, ch['5'] || 0, ch['45'] || 0];
        }
        if (isFinite(t)) broadcast({ type: 'tel', t, c });
      }
    }
    return;
  }
  state[topic] = merge(state[topic], data);
  if (topic === 'SessionInfo' || topic === 'TrackStatus') broadcast(sessionMsg());
  else if (topic === 'DriverList') broadcast(driversMsg());
  else if (topic === 'RaceControlMessages') {
    const msgs = (data && data.Messages) || {};
    for (const m of Array.isArray(msgs) ? msgs : Object.values(msgs)) if (m && m.Message) broadcast({ type: 'rc', text: m.Message, t: Date.parse(m.Utc) || Date.now() });
  }
}
function onInitial(result) {
  if (!result || typeof result !== 'object') return;
  for (const [topic, data] of Object.entries(result)) {
    if (topic.endsWith('.z')) onTopic(topic, data, null);
    else state[topic] = data;
  }
  for (const ws of clients) snapshot(ws);
}
setInterval(() => { if (clients.size && state.TimingData) broadcast(timingMsg()); }, 1000);

/* ---------- conexión con F1: SignalR Core, con respaldo al SignalR clásico ---------- */
function cookieFrom(res) { return (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; '); }

async function connectCore() {
  const neg = await fetch(F1 + '/signalrcore/negotiate?negotiateVersion=1', { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 rebufo-relay' } });
  if (!neg.ok) throw new Error('negotiate core ' + neg.status);
  const j = await neg.json(), cookie = cookieFrom(neg);
  const token = j.connectionToken || j.connectionId;
  const ws = new WebSocket(F1_WS + '/signalrcore?id=' + encodeURIComponent(token), { headers: cookie ? { cookie } : {} });
  return new Promise((resolve, reject) => {
    let ready = false;
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 6 }) + RS); }, 15000);
    ws.on('open', () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS));
    ws.on('message', raw => {
      for (const part of raw.toString().split(RS)) {
        if (!part) continue;
        let m; try { m = JSON.parse(part); } catch (e) { continue; }
        if (!ready && !m.type) {
          if (m.error) { reject(new Error('handshake: ' + m.error)); return; }
          ready = true; upstreamMode = 'signalrcore'; resolve(ws);
          ws.send(JSON.stringify({ type: 1, invocationId: '1', target: 'Subscribe', arguments: [TOPICS] }) + RS);
          continue;
        }
        if (m.type === 1 && /^feed$/i.test(m.target)) { const [topic, data, ts] = m.arguments || []; onTopic(topic, data, ts); }
        else if (m.type === 3 && m.invocationId === '1') { if (m.error) log('subscribe error', m.error); else onInitial(m.result); }
        else if (m.type === 7) log('servidor F1 cerró:', m.error || '');
      }
    });
    ws.on('close', () => { clearInterval(ping); if (!ready) reject(new Error('cerrado antes del handshake')); });
    ws.on('error', e => { if (!ready) reject(e); });
  });
}

async function connectLegacy() {
  const cd = encodeURIComponent(JSON.stringify([{ name: 'Streaming' }]));
  const neg = await fetch(F1 + '/signalr/negotiate?connectionData=' + cd + '&clientProtocol=1.5', { headers: { 'user-agent': 'BestHTTP', 'accept-encoding': 'gzip,identity' } });
  if (!neg.ok) throw new Error('negotiate legacy ' + neg.status);
  const j = await neg.json(), cookie = cookieFrom(neg);
  const url = F1_WS + '/signalr/connect?transport=webSockets&clientProtocol=1.5&connectionToken=' + encodeURIComponent(j.ConnectionToken) + '&connectionData=' + cd;
  const ws = new WebSocket(url, { headers: { 'user-agent': 'BestHTTP', 'accept-encoding': 'gzip,identity', ...(cookie ? { cookie } : {}) } });
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      upstreamMode = 'signalr'; resolve(ws);
      ws.send(JSON.stringify({ H: 'Streaming', M: 'Subscribe', A: [TOPICS], I: 1 }));
    });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.R && String(m.I) === '1') onInitial(m.R);
      for (const x of m.M || []) if (/^feed$/i.test(x.M)) { const [topic, data, ts] = x.A || []; onTopic(topic, data, ts); }
    });
    ws.on('error', e => reject(e));
  });
}

async function startUpstream() {
  if (upstream || reconnectTimer) return;
  for (const [name, fn] of [['signalrcore', connectCore], ['signalr', connectLegacy]]) {
    try {
      const ws = await fn();
      upstream = ws; log('conectado a F1 por', name);
      broadcast({ type: 'status', upstream: upstreamMode, lastFeed });
      ws.on('close', () => {
        log('conexión con F1 cerrada'); upstream = null; upstreamMode = '';
        broadcast({ type: 'status', upstream: 'desconectado', lastFeed });
        if (clients.size) reconnectTimer = setTimeout(() => { reconnectTimer = null; startUpstream(); }, 5000);
      });
      return;
    } catch (e) { log('falló', name, '-', e.message); }
  }
  broadcast({ type: 'status', upstream: 'error', lastFeed });
  if (clients.size) reconnectTimer = setTimeout(() => { reconnectTimer = null; startUpstream(); }, 15000);
}
function stopUpstream() {
  if (upstream) { try { upstream.close(); } catch (e) {} }
  upstream = null; upstreamMode = '';
  clearTimeout(reconnectTimer); reconnectTimer = null;
}

/* ---------- servidor para los navegadores ---------- */
const server = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, upstream: upstreamMode || 'desconectado', clients: clients.size, lastFeed: lastFeed ? new Date(lastFeed).toISOString() : null, session: state.SessionInfo ? sessionMsg() : null }));
});
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  clients.add(ws); clearTimeout(idleTimer);
  snapshot(ws); startUpstream();
  const alive = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 25000);
  ws.on('close', () => {
    clients.delete(ws); clearInterval(alive);
    if (!clients.size) idleTimer = setTimeout(stopUpstream, 60000);
  });
});
server.listen(PORT, () => log('Rebufo relay escuchando en el puerto', PORT));
