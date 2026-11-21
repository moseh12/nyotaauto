import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const readJson = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const config = readJson('./apps.json');
const messages = readJson('./messages.json').promo;
const statePath = new URL('./state.json', import.meta.url);
const state = existsSync(statePath) ? readJson('./state.json') : { apps: {} };
state.apps ??= {};
const dryRun = process.env.DRY_RUN === '1';
const force = process.env.FORCE === '1';
const mode = process.env.MODE || 'auto'; // auto | test
const onlyApp = process.env.ONLY_APP;
const accounts = dryRun ? {} : JSON.parse(process.env.FCM_SERVICE_ACCOUNTS || '{}');
const accessTokenCache = new Map();

function localClock(timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: +parts.hour, minute: +parts.minute };
}

function quiet(hour, { start, end }) {
  return start === end ? false : start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

function nextMessage(appState, firstMessageId) {
  const last = appState.lastMessageId;
  if (!last && firstMessageId) {
    const first = messages.find(m => m.id === firstMessageId);
    if (first) return first;
  }
  const pool = messages.filter(m => m.id !== last);
  if (!pool.length) return messages[0];
  return pool[Math.floor(Math.random() * pool.length)];
}

function base64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

async function accessToken(serviceAccount) {
  const cacheKey = serviceAccount.client_email;
  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: tokenUri, iat: now, exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned).sign(serviceAccount.private_key).toString('base64url');
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(`Google OAuth failed (${response.status}): ${JSON.stringify(result)}`);
  }
  accessTokenCache.set(cacheKey, { token: result.access_token, expiresAt: Date.now() + 50 * 60 * 1000 });
  return result.access_token;
}

async function push(app, message) {
  if (dryRun) {
    console.log(`[DRY RUN] ${app.id}: ${message.title} — ${message.body}`);
    return;
  }
  const sa = accounts[app.id];
  if (!sa?.project_id || !sa?.private_key || !sa?.client_email) {
    throw new Error(`FCM_SERVICE_ACCOUNTS missing valid service account for ${app.id}`);
  }
  const token = await accessToken(sa);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          topic: app.topic || config.defaults.topic,
          notification: { title: message.title, body: message.body },
          data: { type: 'promotion', screen: 'home', message_id: message.id },
          android: {
            priority: 'NORMAL',
            notification: {
              channel_id: config.defaults.channelId,
              tag: 'nyotafund_promotion',
              sound: 'default',
            },
          },
        },
      }),
      signal: AbortSignal.timeout(25000),
    },
  );
  if (!response.ok) throw new Error(`FCM HTTP ${response.status}: ${await response.text()}`);
  const data = await response.json();
  console.log(`[SENT] ${app.id}: ${message.id} (${data.name || 'accepted'})`);
}

let failures = 0;
for (const app of config.apps.filter(a => a.enabled !== false && (!onlyApp || onlyApp === a.id))) {
  try {
    const defaults = config.defaults;
    const clock = localClock(defaults.timezone);
    const appState = (state.apps[app.id] ??= {});
    const message = mode === 'test' ? {
      id: 'test', title: '✅ Nyota Fund notification test', body: 'Firebase notifications are connected successfully.',
    } : nextMessage(appState, defaults.firstMessageId);
    if (!message) throw new Error('messages.json has no messages');

    if (mode !== 'test' && !force) {
      if (quiet(clock.hour, defaults.quietHours)) {
        console.log(`[SKIP] ${app.id}: quiet hours`); continue;
      }
      const todayCount = appState.date === clock.date ? (appState.count || 0) : 0;
      if (todayCount >= defaults.maxPromotionsPerDay) {
        console.log(`[SKIP] ${app.id}: daily limit reached`); continue;
      }
      const elapsed = Date.now() - (appState.lastSentAt || 0);
      if (elapsed < defaults.minimumMinutesBetweenPromotions * 60000) {
        console.log(`[SKIP] ${app.id}: cooldown active`); continue;
      }
    }

    await push(app, message);
    if (!dryRun && mode !== 'test') {
      const count = appState.date === clock.date ? (appState.count || 0) : 0;
      appState.date = clock.date;
      appState.count = count + 1;
      appState.lastSentAt = Date.now();
      appState.lastMessageId = message.id;
    }
    } catch (error) {
  failures++;

  console.error(`\n[ERROR] ${app.id}`);
  console.error('Message:', error.message);
  console.error('Cause:', error.cause ?? 'No additional cause');
  console.error('Stack:', error.stack);
}
  
}

if (!dryRun && mode !== 'test') {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
if (failures) process.exitCode = 1;
