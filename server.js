const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const webpush = require('web-push');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let VAPID;
const KEYS_FILE = path.join(__dirname, 'vapid-keys.json');
if (fs.existsSync(KEYS_FILE)) {
  VAPID = JSON.parse(fs.readFileSync(KEYS_FILE));
} else {
  VAPID = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEYS_FILE, JSON.stringify(VAPID, null, 2));
}
webpush.setVapidDetails('mailto:admin@tzeva-adom.local', VAPID.publicKey, VAPID.privateKey);

let subscriptions = [];
let alertHistory = [];
let lastAlertId = null;
let connected = 0;
let fetchErrors = 0;

const OREF_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const OREF_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': 'https://www.oref.org.il/',
  'User-Agent': 'Mozilla/5.0 Chrome/120',
  'Accept': 'application/json',
};

async function fetchOref() {
  try {
    const res = await fetch(OREF_URL, { headers: OREF_HEADERS, timeout: 5000 });
    const text = await res.text();
    if (!text || text.trim() === '' || text.trim() === '{}') return null;
    const clean = text.trim().replace(/^\uFEFF/, '');
    if (!clean.startsWith('{')) return null;
    let data;
    try { data = JSON.parse(clean); } catch(_) { return null; }
    if (!data || !data.data || !data.data.length) return null;
    fetchErrors = 0;
    return data;
  } catch (err) {
    fetchErrors++;
    return null;
  }
}

async function processAlert(alert) {
  if (!alert) return;
  const id = alert.id || JSON.stringify(alert.data);
  if (id === lastAlertId) return;
  lastAlertId = id;
  const entry = {
    id, time: new Date().toISOString(),
    title: alert.title || 'ירי רקטות וטילים',
    zones: alert.data || [],
    count: (alert.data || []).length,
  };
  alertHistory.unshift(entry);
  if (alertHistory.length > 200) alertHistory = alertHistory.slice(0, 200);
  console.log('התרעה:', entry.title, entry.count, 'אזורים');
  broadcastWS({ type: 'ALERT', alert: entry });
  await sendPush(entry);
}

function broadcastWS(msg) {
  const json = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(json); });
}

async function sendPush(alert) {
  if (!subscriptions.length) return;
  const payload = JSON.stringify({
    title: '🚨 ' + alert.title,
    body: alert.zones.slice(0,3).join(', '),
    tag: 'alert-' + alert.id,
  });
  const dead = [];
  await Promise.all(subscriptions.map(async (sub, i) => {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) dead.push(i); }
  }));
  if (dead.length) subscriptions = subscriptions.filter((_, i) => !dead.includes(i));
}

setInterval(async () => {
  const alert = await fetchOref();
  await processAlert(alert);
  broadcastWS({ type: 'STATUS', time: new Date().toISOString(), clients: connected, history: alertHistory });
}, 2000);

wss.on('connection', (ws) => {
  connected++;
  ws.send(JSON.stringify({ type: 'INIT', vapidKey: VAPID.publicKey, history: alertHistory, clients: connected }));
  ws.on('close', () => { connected--; });
  ws.on('error', () => { connected = Math.max(0, connected - 1); });
});

app.get('/api/status', (req, res) => res.json({ ok: true, connected, alerts: alertHistory.length }));
app.get('/api/history', (req, res) => res.json(alertHistory));
app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'invalid' });
  if (!subscriptions.some(s => s.endpoint === sub.endpoint)) subscriptions.push(sub);
  res.json({ ok: true });
});
app.post('/api/test-alert', async (req, res) => {
  lastAlertId = null;
  await processAlert({ id: 'test-' + Date.now(), title: 'בדיקה', data: req.body.zones || ['גוש דן'] });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('שרת פועל על פורט', PORT);
  console.log('תיקיה:', __dirname);
  console.log('קבצים:', fs.readdirSync(__dirname).join(', '));
});
