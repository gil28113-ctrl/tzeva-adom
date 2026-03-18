// ═══════════════════════════════════════════════════════════
//  שרת צבע אדום v2
//  ✅ מושך נתונים מ-oref כל 2 שניות
//  ✅ WebSocket — דוחף לכל הלקוחות בזמן אמת
//  ✅ Push Notifications — גם כשהאתר סגור
//  ✅ שומר היסטוריה לקובץ — שורדת כיבוי!
// ═══════════════════════════════════════════════════════════

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const fetch     = require('node-fetch');
const webpush   = require('web-push');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── VAPID KEYS ─────────────────────────────────────────────
let VAPID;
const KEYS_FILE = path.join(__dirname, 'vapid-keys.json');
if (fs.existsSync(KEYS_FILE)) {
  VAPID = JSON.parse(fs.readFileSync(KEYS_FILE));
  console.log('✅ מפתחות VAPID נטענו');
} else {
  VAPID = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEYS_FILE, JSON.stringify(VAPID, null, 2));
  console.log('✅ מפתחות VAPID חדשים נוצרו');
}
webpush.setVapidDetails('mailto:admin@tzeva-adom.local', VAPID.publicKey, VAPID.privateKey);

// ── PUSH SUBSCRIPTIONS ─────────────────────────────────────
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');
let subscriptions = [];
if (fs.existsSync(SUBS_FILE)) {
  try { subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE)); } catch(_){}
  console.log(`✅ ${subscriptions.length} מנויי Push נטענו`);
}
function saveSubs() {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2));
}

// ── HISTORY — נשמרת לקובץ ושורדת כיבוי! ──────────────────
const HISTORY_FILE = path.join(__dirname, 'alert-history.json');
let alertHistory = [];

if (fs.existsSync(HISTORY_FILE)) {
  try {
    alertHistory = JSON.parse(fs.readFileSync(HISTORY_FILE));
    console.log(`✅ נטענו ${alertHistory.length} התרעות מהיסטוריה`);
    if (alertHistory.length > 0) {
      const last = alertHistory[0];
      console.log(`   אחרונה: ${last.title} — ${new Date(last.time).toLocaleString('he-IL')}`);
    }
  } catch(e) {
    console.warn('⚠️ שגיאה בטעינת היסטוריה:', e.message);
    alertHistory = [];
  }
}

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(alertHistory, null, 2)); } catch(e) {}
}

// ── OREF API ───────────────────────────────────────────────
const OREF_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const OREF_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'Referer':          'https://www.oref.org.il/',
  'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
  'Accept':           'application/json, text/plain, */*',
};

// ── STATE ──────────────────────────────────────────────────
// התחל עם ה-ID של ההתרעה האחרונה כדי לא לשכפל
let lastAlertId = alertHistory.length > 0 ? alertHistory[0].id : null;
let connected   = 0;
let lastFetch   = null;
let fetchErrors = 0;

// ── FETCH OREF ─────────────────────────────────────────────
async function fetchOref() {
  try {
    const res  = await fetch(OREF_URL, { headers: OREF_HEADERS, timeout: 5000 });
    lastFetch  = new Date().toISOString();
    const text = await res.text();

    // אין התרעה
    if (!text || text.trim() === '' || text.trim() === '{}' || text.trim() === 'null') return null;

    // נקה BOM ותווים לפני ה-JSON
    const clean = text.trim().replace(/^\uFEFF/, '');
    if (!clean.startsWith('{') && !clean.startsWith('[')) return null;

    let data;
    try { data = JSON.parse(clean); } catch(_) { return null; }

    if (!data || !data.data || data.data.length === 0) return null;
    fetchErrors = 0;
    return data;

  } catch (err) {
    fetchErrors++;
    if (fetchErrors === 1) console.warn(`⚠️ שגיאת חיבור: ${err.message}`);
    return null;
  }
}

// ── PROCESS ALERT ──────────────────────────────────────────
async function processAlert(alert) {
  if (!alert) return;

  const id = alert.id || JSON.stringify(alert.data);
  if (id === lastAlertId) return;
  lastAlertId = id;

  const entry = {
    id,
    time:  new Date().toISOString(),
    title: alert.title || 'ירי רקטות וטילים',
    cat:   alert.cat   || '1',
    zones: alert.data  || [],
    count: (alert.data || []).length,
  };

  alertHistory.unshift(entry);
  if (alertHistory.length > 200) alertHistory = alertHistory.slice(0, 200);

  // שמור מיד לקובץ!
  saveHistory();

  console.log(`\n🚨 התרעה! [${new Date().toLocaleTimeString('he-IL')}]`);
  console.log(`   ${entry.title} — ${entry.count} אזורים`);
  console.log(`   ${entry.zones.slice(0,5).join(', ')}${entry.count > 5 ? '...' : ''}`);

  broadcastWS({ type: 'ALERT', alert: entry });
  await sendPush(entry);
}

// ── BROADCAST ──────────────────────────────────────────────
function broadcastWS(msg) {
  const json = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(json); });
}

// ── PUSH NOTIFICATIONS ─────────────────────────────────────
async function sendPush(alert) {
  if (!subscriptions.length) return;
  const payload = JSON.stringify({
    title: `🚨 ${alert.title}`,
    body:  `${alert.zones.slice(0,3).join(', ')}${alert.count > 3 ? ` ועוד ${alert.count-3}` : ''}`,
    tag:   'alert-' + alert.id,
  });
  const dead = [];
  await Promise.all(subscriptions.map(async (sub, i) => {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) dead.push(i); }
  }));
  if (dead.length) { subscriptions = subscriptions.filter((_, i) => !dead.includes(i)); saveSubs(); }
  console.log(`📲 Push נשלח ל-${subscriptions.length} מכשירים`);
}

// ── POLLING כל 2 שניות ─────────────────────────────────────
setInterval(async () => {
  const alert = await fetchOref();
  await processAlert(alert);
  broadcastWS({ type: 'STATUS', time: new Date().toISOString(), clients: connected, history: alertHistory });
}, 2000);

// ── WEBSOCKET ──────────────────────────────────────────────
wss.on('connection', (ws) => {
  connected++;
  console.log(`🟢 לקוח חדש | סה"כ: ${connected}`);
  ws.send(JSON.stringify({ type: 'INIT', vapidKey: VAPID.publicKey, history: alertHistory, clients: connected }));
  ws.on('close', () => { connected--; });
  ws.on('error', () => { connected = Math.max(0, connected - 1); });
});

// ── REST API ───────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json({ ok: true, connected, alerts: alertHistory.length, lastFetch, errors: fetchErrors, lastAlert: alertHistory[0] || null }));
app.get('/api/history', (req, res) => res.json(alertHistory));
app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'invalid' });
  if (!subscriptions.some(s => s.endpoint === sub.endpoint)) { subscriptions.push(sub); saveSubs(); console.log(`📱 מנוי חדש (סה"כ: ${subscriptions.length})`); }
  res.json({ ok: true });
});
app.post('/api/test-alert', async (req, res) => {
  lastAlertId = null;
  await processAlert({ id: 'test-' + Date.now(), title: req.body.title || 'ירי רקטות וטילים (בדיקה)', data: req.body.zones || ['גוש דן', 'תל אביב', 'רמת גן'] });
  res.json({ ok: true });
});

// ── START ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║       🚨  שרת צבע אדום v2 פעיל  🚨       ║');
  console.log(`║  http://localhost:${PORT}                    ║`);
  console.log(`║  היסטוריה: ${String(alertHistory.length).padEnd(4)} התרעות שמורות         ║`);
  console.log('╚══════════════════════════════════════════╝\n');
});

process.on('SIGINT', () => { console.log('\n💾 שומר...'); saveHistory(); console.log('👋 נעצר'); process.exit(0); });
