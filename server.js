// Brainkind push server
// Stores each device's push subscription + medication schedule, and checks
// every minute whether any dose time has arrived for that device's timezone.
// Data persists to a local JSON file — fine for personal/single- or
// few-user use. For many users, swap dataStore for a real database.

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3000;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:you@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY environment variables.');
  console.error('Run "npm run generate-keys" once to create a pair, then set them.');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/* ---------- tiny JSON-file data store ---------- */
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { subscriptions: {} };
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
let data = loadData();

/* ---------- app ---------- */
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

// Register (or update) a device's push subscription
app.post('/api/subscribe', (req, res) => {
  const { subscription, timezone, lang } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Missing subscription' });
  }
  const key = subscription.endpoint;
  const existing = data.subscriptions[key] || {};
  data.subscriptions[key] = {
    subscription,
    timezone: timezone || existing.timezone || 'UTC',
    lang: lang || existing.lang || 'en',
    meds: existing.meds || [],
    sentLog: existing.sentLog || {}
  };
  saveData(data);
  res.json({ ok: true });
});

// Sync the medication schedule for a device
app.post('/api/schedule', (req, res) => {
  const { endpoint, meds, timezone, lang } = req.body;
  if (!endpoint || !data.subscriptions[endpoint]) {
    return res.status(404).json({ error: 'Unknown subscription — call /api/subscribe first' });
  }
  data.subscriptions[endpoint].meds = Array.isArray(meds) ? meds : [];
  if (timezone) data.subscriptions[endpoint].timezone = timezone;
  if (lang) data.subscriptions[endpoint].lang = lang;
  saveData(data);
  res.json({ ok: true });
});

// Remove a device's subscription entirely
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint && data.subscriptions[endpoint]) {
    delete data.subscriptions[endpoint];
    saveData(data);
  }
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Brainkind push server listening on :${PORT}`));

/* ---------- scheduler: checks every minute ---------- */
function timeInZone(tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit'
  });
  return fmt.format(new Date()); // "HH:MM"
}
function dateInZone(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz }); // YYYY-MM-DD
  return fmt.format(new Date());
}

const MESSAGES = {
  en: (name, time) => ({ title: 'Brainkind', body: `${name} · ${time} — tap to log` }),
  ro: (name, time) => ({ title: 'Brainkind', body: `${name} · ${time} — atinge pentru a nota` })
};

async function checkAndSend() {
  let dirty = false;
  for (const [endpoint, entry] of Object.entries(data.subscriptions)) {
    const tz = entry.timezone || 'UTC';
    const nowHHMM = timeInZone(tz);
    const today = dateInZone(tz);
    entry.sentLog[today] = entry.sentLog[today] || [];

    for (const med of entry.meds || []) {
      for (const time of med.times || []) {
        if (time !== nowHHMM) continue;
        const marker = `${med.name}|${time}`;
        if (entry.sentLog[today].includes(marker)) continue;

        const msg = (MESSAGES[entry.lang] || MESSAGES.en)(med.name, time);
        try {
          await webpush.sendNotification(entry.subscription, JSON.stringify(msg));
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            delete data.subscriptions[endpoint]; // subscription expired/gone
          } else {
            console.error('Push failed for', endpoint, err.message);
          }
        }
        entry.sentLog[today].push(marker);
        dirty = true;
      }
    }
    // trim old day logs so the file doesn't grow forever
    const keepDates = Object.keys(entry.sentLog).slice(-3);
    Object.keys(entry.sentLog).forEach(d => {
      if (!keepDates.includes(d)) delete entry.sentLog[d];
    });
  }
  if (dirty) saveData(data);
}

setInterval(checkAndSend, 60 * 1000);
