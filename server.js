// Brainkind / MediKind push server
// Stores each device's push subscription + medication schedule, and checks
// every minute whether any dose time has arrived for that device's timezone.
// Data persists in Render Key Value (a small free Redis-compatible store),
// so it survives restarts and redeploys — a local file does not, on
// Render's free web service tier.

const express = require('express');
const webpush = require('web-push');
const { createClient } = require('redis');

const PORT = process.env.PORT || 3000;
const DATA_KEY = 'brainkind:subscriptions'; // single JSON blob under one key

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:you@example.com';
const REDIS_URL = process.env.REDIS_URL;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY environment variables.');
  console.error('Run "npm run generate-keys" once to create a pair, then set them.');
  process.exit(1);
}
if (!REDIS_URL) {
  console.error('Missing REDIS_URL. Create a free Render Key Value instance and link it,');
  console.error('or set REDIS_URL manually to its internal connection string.');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/* ---------- Key Value backed data store ---------- */
const redis = createClient({ url: REDIS_URL });
redis.on('error', err => console.error('Redis error:', err.message));

let data = { subscriptions: {} }; // in-memory working copy, synced to Redis

async function loadData() {
  try {
    const raw = await redis.get(DATA_KEY);
    data = raw ? JSON.parse(raw) : { subscriptions: {} };
  } catch (e) {
    console.error('Failed to load data from Redis, starting empty:', e.message);
    data = { subscriptions: {} };
  }
}
async function saveData() {
  try {
    await redis.set(DATA_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save data to Redis:', e.message);
  }
}

/* ---------- app ---------- */
const app = express();
// Small explicit body-size cap — these endpoints only ever send small
// JSON payloads (a subscription + a short medication list), so this is
// cheap insurance against unexpectedly large or malformed requests.
app.use(express.json({ limit: '20kb' }));
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
app.post('/api/subscribe', async (req, res) => {
  const { subscription, timezone, lang, app: appId } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Missing subscription' });
  }
  const key = subscription.endpoint;
  const existing = data.subscriptions[key] || {};
  const now = new Date().toISOString();
  data.subscriptions[key] = {
    subscription,
    timezone: timezone || existing.timezone || 'UTC',
    lang: lang || existing.lang || 'en',
    app: appId || existing.app || 'brainkind',
    meds: existing.meds || [],
    sentLog: existing.sentLog || {},
    createdAt: existing.createdAt || now,
    lastSeenAt: now
  };
  await saveData();
  res.json({ ok: true });
});

// Sync the medication schedule for a device
app.post('/api/schedule', async (req, res) => {
  const { endpoint, meds, timezone, lang, app: appId } = req.body;
  if (!endpoint || !data.subscriptions[endpoint]) {
    return res.status(404).json({ error: 'Unknown subscription — call /api/subscribe first' });
  }
  data.subscriptions[endpoint].meds = Array.isArray(meds) ? meds : [];
  if (timezone) data.subscriptions[endpoint].timezone = timezone;
  if (lang) data.subscriptions[endpoint].lang = lang;
  if (appId) data.subscriptions[endpoint].app = appId;
  data.subscriptions[endpoint].lastSeenAt = new Date().toISOString();
  await saveData();
  res.json({ ok: true });
});

// Remove a device's subscription entirely
app.post('/api/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint && data.subscriptions[endpoint]) {
    delete data.subscriptions[endpoint];
    await saveData();
  }
  res.json({ ok: true });
});

// Lightweight diagnostics — no personal data, just counts, so it's safe to
// check from a browser to see whether stale subscriptions are piling up.
app.get('/api/stats', (req, res) => {
  const entries = Object.values(data.subscriptions);
  const byApp = {};
  let orphaned = 0;
  for (const e of entries) {
    byApp[e.app || 'unknown'] = (byApp[e.app || 'unknown'] || 0) + 1;
    if (!e.meds || e.meds.length === 0) orphaned++;
  }
  res.json({
    totalSubscriptions: entries.length,
    byApp,
    orphaned, // registered but never got a medication schedule synced
    memory: process.memoryUsage()
  });
});

// External cron (e.g. cron-job.org) hits this every minute so checks still
// run even after Render's free tier has spun the service down and a cron
// ping wakes it back up.
app.get('/api/check', async (req, res) => {
  await checkAndSend();
  res.json({ ok: true, checkedAt: new Date().toISOString() });
});

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
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

const APP_NAMES = { brainkind: 'Brainkind', medikind: 'MediKind' };

const MESSAGES = {
  en: (appName, name, time) => ({ title: appName, body: `${name} · ${time} — tap to log` }),
  ro: (appName, name, time) => ({ title: appName, body: `${name} · ${time} — atinge pentru a nota` })
};

async function checkAndSend() {
  let dirty = false;
  for (const [endpoint, entry] of Object.entries(data.subscriptions)) {
    const tz = entry.timezone || 'UTC';
    const nowMinutes = toMinutes(timeInZone(tz));
    const today = dateInZone(tz);
    entry.sentLog[today] = entry.sentLog[today] || [];

    for (const med of entry.meds || []) {
      for (const time of med.times || []) {
        // Fire once the scheduled minute has arrived (or passed, in case a
        // cron ping was late or missed) rather than requiring an exact match.
        if (toMinutes(time) > nowMinutes) continue;
        const marker = `${med.name}|${time}`;
        if (entry.sentLog[today].includes(marker)) continue;

        const appName = APP_NAMES[entry.app] || 'Reminder';
        const msg = (MESSAGES[entry.lang] || MESSAGES.en)(appName, med.name, time);
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
    // trim old day logs so the stored blob doesn't grow forever
    const keepDates = Object.keys(entry.sentLog).slice(-3);
    Object.keys(entry.sentLog).forEach(d => {
      if (!keepDates.includes(d)) delete entry.sentLog[d];
    });
  }
  if (dirty) await saveData();
}

// Remove subscriptions that registered but never received a medication
// schedule, and have sat untouched for over a week — almost always leftover
// test/abandoned registrations rather than active users, and left unchecked
// they'd accumulate indefinitely since they never get pruned by a failed
// push attempt (there's nothing scheduled to ever try sending to them).
async function pruneAbandoned() {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [endpoint, entry] of Object.entries(data.subscriptions)) {
    const hasSchedule = entry.meds && entry.meds.length > 0;
    const lastSeen = new Date(entry.lastSeenAt || entry.createdAt || 0).getTime();
    if (!hasSchedule && lastSeen < weekAgo) {
      delete data.subscriptions[endpoint];
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`Pruned ${removed} abandoned subscription(s).`);
    await saveData();
  }
}

/* ---------- startup ---------- */
async function start() {
  await redis.connect();
  await loadData();
  app.listen(PORT, () => console.log(`Push server listening on :${PORT}`));
  setInterval(checkAndSend, 60 * 1000);
  setInterval(pruneAbandoned, 24 * 60 * 60 * 1000); // once a day
  pruneAbandoned(); // also run once at startup

  // Light periodic memory logging — visible in Render's free Logs tab, so
  // there's a way to see the actual trend even without the paid Metrics
  // graph, useful if this happens again.
  setInterval(() => {
    const mem = process.memoryUsage();
    console.log(`Memory: rss=${Math.round(mem.rss/1024/1024)}MB heapUsed=${Math.round(mem.heapUsed/1024/1024)}MB, subscriptions=${Object.keys(data.subscriptions).length}`);
  }, 30 * 60 * 1000); // every 30 minutes
}
start();
