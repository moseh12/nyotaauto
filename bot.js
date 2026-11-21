
import { createSign } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import dns from 'node:dns';
import { Agent } from 'undici';

// ========================================
// NETWORK CONFIGURATION
// ========================================

dns.setDefaultResultOrder('ipv4first');

const ipv4Agent = new Agent({
  connect: {
    family: 4,
    timeout: 30000,
  },
});

// ========================================
// CONFIGURATION
// ========================================

const readJson = (file) =>
  JSON.parse(
    readFileSync(new URL(file, import.meta.url), 'utf8')
  );

const config = readJson('./apps.json');
const messagesData = readJson('./messages.json');
const messages = messagesData.promo || [];

const statePath = new URL('./state.json', import.meta.url);

const state = existsSync(statePath)
  ? readJson('./state.json')
  : { apps: {} };

state.apps ??= {};

const dryRun = process.env.DRY_RUN === '1';
const force = process.env.FORCE === '1';
const mode = process.env.MODE || 'auto';
const onlyApp = process.env.ONLY_APP;

const accessTokenCache = new Map();

let accounts = {};

if (!dryRun) {
  try {
    accounts = JSON.parse(
      process.env.FCM_SERVICE_ACCOUNTS || '{}'
    );
  } catch {
    console.error(
      '[CONFIG ERROR] FCM_SERVICE_ACCOUNTS contains invalid JSON.'
    );
    process.exit(1);
  }
}

// ========================================
// DATE AND TIME
// ========================================

function localClock(timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .filter((x) => x.type !== 'literal')
      .map((x) => [x.type, x.value])
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function quiet(hour, { start, end }) {
  if (start === end) return false;

  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

// ========================================
// MESSAGE ROTATION
// ========================================

function nextMessage(appState, firstMessageId) {
  if (!messages.length) {
    throw new Error(
      'messages.json has no promotional messages.'
    );
  }

  const last = appState.lastMessageId;

  if (!last && firstMessageId) {
    const first = messages.find(
      (message) => message.id === firstMessageId
    );

    if (first) return first;
  }

  const pool = messages.filter(
    (message) => message.id !== last
  );

  const available = pool.length ? pool : messages;

  return available[
    Math.floor(Math.random() * available.length)
  ];
}

// ========================================
// ERROR DIAGNOSTICS
// ========================================

function networkError(stage, error) {
  const cause = error.cause;

  const details = [
    `${stage} connection failed`,
    error.message,
    cause?.code ? `code=${cause.code}` : null,
    cause?.errno ? `errno=${cause.errno}` : null,
    cause?.address ? `address=${cause.address}` : null,
    cause?.port ? `port=${cause.port}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  return new Error(details, { cause: error });
}

function logError(appId, error) {
  console.error(`\n[ERROR] ${appId}`);
  console.error('Message:', error.message);

  let cause = error.cause;
  let depth = 0;

  while (cause && depth < 5) {
    console.error(`Cause ${depth + 1}:`, {
      name: cause.name,
      message: cause.message,
      code: cause.code,
      errno: cause.errno,
      address: cause.address,
      port: cause.port,
    });

    cause = cause.cause;
    depth++;
  }

  console.error('Stack:', error.stack);
}

// ========================================
// GOOGLE OAUTH AUTHENTICATION
// ========================================

function base64url(value) {
  return Buffer.from(
    typeof value === 'string'
      ? value
      : JSON.stringify(value)
  ).toString('base64url');
}

async function accessToken(serviceAccount) {
  const cacheKey = serviceAccount.client_email;

  const cached = accessTokenCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const now = Math.floor(Date.now() / 1000);

  const tokenUri =
    serviceAccount.token_uri ||
    'https://oauth2.googleapis.com/token';

  const header = base64url({
    alg: 'RS256',
    typ: 'JWT',
  });

  const payload = base64url({
    iss: serviceAccount.client_email,
    scope:
      'https://www.googleapis.com/auth/firebase.messaging',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  });

  const unsigned = `${header}.${payload}`;

  let signature;

  try {
    signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(serviceAccount.private_key)
      .toString('base64url');
  } catch (error) {
    throw new Error(
      `Firebase service account signing failed: ${error.message}`
    );
  }

  const assertion = `${unsigned}.${signature}`;

  console.log('[AUTH] Requesting Google OAuth token...');

  let response;

  try {
    response = await fetch(tokenUri, {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type:
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      dispatcher: ipv4Agent,
      signal: AbortSignal.timeout(45000),
    });
  } catch (error) {
    throw networkError('Google OAuth', error);
  }

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(
      `Google OAuth returned an invalid response (HTTP ${response.status}).`
    );
  }

  if (!response.ok || !result.access_token) {
    const errorCode = result.error || 'unknown_error';
    const description =
      result.error_description || 'No description';

    throw new Error(
      `Google OAuth failed (HTTP ${response.status}): ${errorCode} — ${description}`
    );
  }

  accessTokenCache.set(cacheKey, {
    token: result.access_token,
    expiresAt: Date.now() + 50 * 60 * 1000,
  });

  console.log(
    '[AUTH] Google OAuth authentication successful.'
  );

  return result.access_token;
}

// ========================================
// FIREBASE PUSH NOTIFICATION
// ========================================

async function push(app, message) {
  const topic = app.topic || config.defaults.topic;

  if (!topic) {
    throw new Error(
      `Firebase topic missing for ${app.id}`
    );
  }

  if (dryRun) {
    console.log(
      `[DRY RUN] ${app.id}: ${message.title} — ${message.body}`
    );
    console.log(`[DRY RUN] Topic: ${topic}`);
    return;
  }

  const sa = accounts[app.id];

  if (
    !sa?.project_id ||
    !sa?.private_key ||
    !sa?.client_email
  ) {
    throw new Error(
      `FCM_SERVICE_ACCOUNTS missing valid service account for ${app.id}`
    );
  }

  console.log(`[FCM] App: ${app.id}`);
  console.log(`[FCM] Project: ${sa.project_id}`);
  console.log(`[FCM] Topic: ${topic}`);

  const token = await accessToken(sa);

  const endpoint =
    `https://fcm.googleapis.com/v1/projects/` +
    `${encodeURIComponent(sa.project_id)}/messages:send`;

  const payload = {
    message: {
      topic,
      notification: {
        title: message.title,
        body: message.body,
      },
      data: {
        type: 'promotion',
        screen: 'home',
        message_id: String(message.id),
      },
      android: {
        priority: 'NORMAL',
        notification: {
          channel_id:
            config.defaults.channelId ||
            'nyota_fund_alerts',
          tag: 'nyotafund_promotion',
          sound: 'default',
        },
      },
    },
  };

  console.log('[FCM] Sending notification...');

  let response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      dispatcher: ipv4Agent,
      signal: AbortSignal.timeout(45000),
    });
  } catch (error) {
    throw networkError('Firebase FCM', error);
  }

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Firebase FCM HTTP ${response.status}: ${errorText}`
    );
  }

  const result = await response.json();

  console.log(
    `[SENT] ${app.id}: ${message.id} (${result.name || 'accepted'})`
  );
}

// ========================================
// MAIN EXECUTION
// ========================================

async function main() {
  console.log('\n================================');
  console.log('NYOTA FUND NOTIFICATION BOT');
  console.log('================================');

  console.log('Mode:', mode);
  console.log('Dry run:', dryRun);
  console.log('Force:', force);
  console.log('Messages:', messages.length);

  let failures = 0;

  const apps = config.apps.filter(
    (app) =>
      app.enabled !== false &&
      (!onlyApp || onlyApp === app.id)
  );

  if (!apps.length) {
    console.log('[INFO] No enabled apps found.');
    return;
  }

  for (const app of apps) {
    try {
      const defaults = config.defaults;
      const clock = localClock(defaults.timezone);
      const appState = (state.apps[app.id] ??= {});

      const message =
        mode === 'test'
          ? {
              id: 'test',
              title: '✅ Nyota Fund notification test',
              body:
                'Firebase notifications are connected successfully.',
            }
          : nextMessage(
              appState,
              defaults.firstMessageId
            );

      if (mode !== 'test' && !force) {
        if (quiet(clock.hour, defaults.quietHours)) {
          console.log(
            `[SKIP] ${app.id}: quiet hours`
          );
          continue;
        }

        const todayCount =
          appState.date === clock.date
            ? appState.count || 0
            : 0;

        if (
          todayCount >=
          defaults.maxPromotionsPerDay
        ) {
          console.log(
            `[SKIP] ${app.id}: daily limit reached`
          );
          continue;
        }

        const elapsed =
          Date.now() - (appState.lastSentAt || 0);

        if (
          elapsed <
          defaults.minimumMinutesBetweenPromotions *
            60000
        ) {
          console.log(
            `[SKIP] ${app.id}: cooldown active`
          );
          continue;
        }
      }

      await push(app, message);

      if (!dryRun && mode !== 'test') {
        const count =
          appState.date === clock.date
            ? appState.count || 0
            : 0;

        appState.date = clock.date;
        appState.count = count + 1;
        appState.lastSentAt = Date.now();
        appState.lastMessageId = message.id;
      }
    } catch (error) {
      failures++;
      logError(app.id, error);
    }
  }

  if (!dryRun && mode !== 'test') {
    writeFileSync(
      statePath,
      `${JSON.stringify(state, null, 2)}\n`
    );
  }

  if (failures) {
    process.exitCode = 1;
  }

  console.log('\n[BOT] Execution finished.');
}

try {
  await main();
} finally {
  await ipv4Agent.close();
}
