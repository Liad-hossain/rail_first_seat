/**
 * HTTP server: JSON API + static frontend.
 *
 * Security note on credentials: the Supabase connection string is read from the
 * environment inside this process and used only to talk to Postgres. It is
 * never included in any API response, never rendered into the HTML, and never
 * logged (see safeDatabaseLabel). The browser only ever calls this server's
 * /api routes, so a visitor cannot reach the database directly or discover how
 * to.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  PORT, WEB_DIR, SEAT_CLASSES, SEAT_CLASS_LABELS, ADVANCE_DAYS, SITE_BASE,
  NODE_ENV, MAX_ALERTS_PER_SUBSCRIBER,
} from './config.js';
import { migrate, verifyConnection, getMeta, setMeta, catalogIsEmpty, closePool } from './db.js';
import {
  syncCatalog, catalogStatus, listStations, destinationsFrom, trainDetail, stationLabel,
} from './catalog.js';
import { fullAvailability, earliestBookable, liveAvailability, bookingWindow, routePlan } from './availability.js';
import {
  recordSnapshot, addWatch, removeWatch, listWatches, historyOverview,
  journeyDateHistory, routeHistory, startCollector, collectOnce,
} from './history.js';
import {
  checkToken, bookingUrl, UpstreamError,
  normalizeCredentials, setDeviceIdentity,
} from './shohoz.js';
import {
  notifyStatus, setBotToken, createPairing, pairingStatus, subscriberByToken,
  listAlerts, createAlert, cancelAlert, sendTestAlarm, startNotifications, NotifyError,
} from './notify.js';
import { normalizeDate, todayISO, addDays } from './time.js';

/* ---------------------------- token storage ---------------------------- */

/**
 * The Bangladesh Railway session token lives in the database (or BR_TOKEN). It
 * is the user's own e-ticket session, used only to read their own search
 * results from railway.gov.bd.
 */
async function getToken() {
  return (await getMeta('br_token')) || process.env.BR_TOKEN || null;
}

async function setToken(token) {
  await setMeta('br_token', token || '');
  await setMeta('br_token_saved_at', token ? new Date().toISOString() : '');
}

/**
 * The device the session token was issued to. Stored beside the token because
 * upstream binds one to the other — see setDeviceIdentity in shohoz.js.
 */
async function getDeviceIdentity() {
  return {
    deviceId: (await getMeta('br_device_id')) || process.env.BR_DEVICE_ID || null,
    deviceKey: (await getMeta('br_device_key')) || process.env.BR_DEVICE_KEY || null,
  };
}

async function setDeviceCredentials({ deviceId, deviceKey }) {
  if (deviceId !== undefined) await setMeta('br_device_id', deviceId || '');
  if (deviceKey !== undefined) await setMeta('br_device_key', deviceKey || '');
  setDeviceIdentity(await getDeviceIdentity());
}

/** Decode a JWT's expiry without verifying it — we only need the claim. */
function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch { return null; }
}

/**
 * Turn a rejected probe into an explanation the user can act on.
 *
 * The upstream 401 is identical whether the token expired or was refused for
 * belonging to another device, and reporting "missing or expired" for the
 * second case sends people off to fetch another token that fails the same way.
 */
function explainRejection(token, probeReason, hadDeviceId) {
  const exp = jwtExpiry(token);
  if (exp && exp.getTime() < Date.now()) {
    return `That token expired on ${exp.toLocaleString()}. Sign in at eticket.railway.gov.bd again and copy a fresh one.`;
  }
  if (exp) {
    return 'Bangladesh Railway rejected that token even though it does not expire until ' +
      `${exp.toLocaleString()}. ` +
      (hadDeviceId
        ? 'The device id was sent with it, so the session itself has probably been invalidated — sign in again and re-copy.'
        : 'That usually means the session is tied to the browser it was issued in. Use the one-line snippet in these instructions, which copies the token AND the device id together.');
  }
  return probeReason || 'Bangladesh Railway rejected that token.';
}

/** Never returns the token itself — only a masked preview and its metadata. */
async function tokenInfo() {
  const stored = await getMeta('br_token');
  const token = stored || process.env.BR_TOKEN || null;
  if (!token) return { present: false };

  let expiresAt = null;
  let subject = null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (payload.exp) expiresAt = new Date(payload.exp * 1000).toISOString();
    subject = payload.display_name || payload.phone_number || payload.username || null;
  } catch { /* opaque token — fine */ }

  return {
    present: true,
    fromEnv: !stored && Boolean(process.env.BR_TOKEN),
    savedAt: (await getMeta('br_token_saved_at')) || null,
    expiresAt,
    expired: expiresAt ? Date.parse(expiresAt) < Date.now() : null,
    subject: subject ? String(subject).replace(/(\d{3})\d+(\d{2})/, '$1***$2') : null,
    preview: `${token.slice(0, 8)}…${token.slice(-6)}`,
    ...(await (async () => {
      const d = await getDeviceIdentity();
      return { hasDeviceId: Boolean(d.deviceId), hasDeviceKey: Boolean(d.deviceKey) };
    })()),
  };
}

/* ------------------------------- helpers ------------------------------- */

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // The frontend is fully self-contained: no CDN, no external fetches.
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(WEB_DIR, rel);
  if (!full.startsWith(path.resolve(WEB_DIR))) throw new HttpError(403, 'Forbidden');

  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  if (stat.isDirectory()) throw new HttpError(404, 'Not found');

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

/** Resolve a user-supplied station to a real catalog city, case-insensitively. */
let stationCache = null;

async function stationIndex() {
  if (stationCache) return stationCache;
  const map = new Map();
  for (const s of await listStations()) {
    map.set(s.city.toLowerCase(), s.city);
    map.set(s.label.toLowerCase(), s.city);
  }
  stationCache = map;
  return map;
}

/* --------------------------- alarm identity ---------------------------- */

/**
 * Alarms are owned by a Telegram chat, not by a login. The browser holds a
 * bearer secret minted at pairing; it is the only thing separating one
 * person's alarms from another's, so it travels in a header rather than the
 * query string (which would land in logs and Referer).
 */
function notifyTokenOf(req) {
  const header = req?.headers?.['x-notify-token'];
  return Array.isArray(header) ? header[0] : header || null;
}

async function requireSubscriber(req) {
  const subscriber = await subscriberByToken(notifyTokenOf(req));
  if (!subscriber) {
    throw new HttpError(401, 'Connect Telegram first to manage sale alarms.', { needsPairing: true });
  }
  return subscriber;
}

async function resolveStation(input, field) {
  const raw = String(input || '').trim();
  if (!raw) throw new HttpError(400, `"${field}" is required`);

  const index = await stationIndex();
  const hit = index.get(raw.toLowerCase()) || index.get(raw.replace(/\s+/g, '_').toLowerCase());
  if (hit) return hit;

  const near = [...new Set(index.values())]
    .filter((c) => c.toLowerCase().includes(raw.toLowerCase().slice(0, 4)))
    .slice(0, 6)
    .map(stationLabel);
  throw new HttpError(
    400,
    `Unknown station "${raw}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`,
    { suggestions: near },
  );
}

function requireDate(input) {
  const iso = normalizeDate(input);
  if (!iso) throw new HttpError(400, 'Provide "date" as YYYY-MM-DD or DD-MMM-YYYY (e.g. 2026-10-15 or 15-Oct-2026)');
  const y = Number(iso.slice(0, 4));
  if (y < 2020 || y > 2100) throw new HttpError(400, `Date ${iso} is out of range`);
  return iso;
}

/* -------------------------------- routes -------------------------------- */

let syncState = { running: false, done: 0, total: 0, startedAt: null, lastResult: null };

async function runSync() {
  if (syncState.running) return syncState;
  syncState = { running: true, done: 0, total: 0, startedAt: new Date().toISOString(), lastResult: null };
  try {
    const result = await syncCatalog({
      onProgress: ({ done, total }) => { syncState.done = done; syncState.total = total; },
    });
    stationCache = null;
    syncState.lastResult = result;
    return result;
  } finally {
    syncState.running = false;
  }
}

const handlers = {
  'GET /api/meta': async () => {
    const [catalog, token, overview] = await Promise.all([
      catalogStatus(), tokenInfo(), historyOverview(),
    ]);
    return {
      catalog,
      token,
      window: bookingWindow(),
      advanceDays: ADVANCE_DAYS,
      today: todayISO(),
      seatClasses: SEAT_CLASSES.map((c) => ({ code: c, label: SEAT_CLASS_LABELS[c] || c })),
      officialSite: SITE_BASE,
      sync: { running: syncState.running, done: syncState.done, total: syncState.total },
      history: {
        snapshots: overview.snapshots,
        daysCovered: overview.daysCovered,
        monthsCovered: overview.monthsCovered,
        routesTracked: overview.routesTracked,
      },
    };
  },

  'GET /api/stations': async () => ({ stations: await listStations() }),

  'GET /api/destinations': async ({ query }) => {
    const from = await resolveStation(query.get('from'), 'from');
    return { from, fromLabel: stationLabel(from), destinations: await destinationsFrom(from) };
  },

  /** The main search: offline plan + live seats when a token exists. */
  'GET /api/search': async ({ query }) => {
    const fromCity = await resolveStation(query.get('from'), 'from');
    const toCity = await resolveStation(query.get('to'), 'to');
    if (fromCity === toCity) throw new HttpError(400, 'Origin and destination must be different stations');
    const dateISO = requireDate(query.get('date'));
    const token = await getToken();

    const result = await fullAvailability({ fromCity, toCity, dateISO, token });

    // Every live look is worth keeping — this is how history accumulates.
    if (result.liveChecked) {
      try {
        const live = await liveAvailability({ fromCity, toCity, dateISO, token });
        await recordSnapshot({ fromCity, toCity, dateISO, live, source: 'live-search' });
      } catch { /* recording must never break a search */ }
    }
    return result;
  },

  /** Full stop list for one train. */
  'GET /api/train': async ({ query }) => {
    const trainNumber = String(query.get('number') || '').trim();
    if (!trainNumber) throw new HttpError(400, '"number" is required');
    const detail = await trainDetail(trainNumber);
    if (!detail) throw new HttpError(404, `No train numbered ${trainNumber} in the catalog`);
    return detail;
  },

  /** Earliest date on this route that actually has a seat. */
  'GET /api/earliest': async ({ query }) => {
    const fromCity = await resolveStation(query.get('from'), 'from');
    const toCity = await resolveStation(query.get('to'), 'to');
    if (fromCity === toCity) throw new HttpError(400, 'Origin and destination must be different stations');
    const seatClass = query.get('class') || null;
    if (seatClass && !SEAT_CLASSES.includes(seatClass)) throw new HttpError(400, `Unknown seat class "${seatClass}"`);
    return earliestBookable({ fromCity, toCity, token: await getToken(), seatClass });
  },

  /**
   * Sale-open calendar: for each of the next N journey dates (well past the
   * 10-day window), when its tickets go on sale.
   */
  'GET /api/calendar': async ({ query }) => {
    const fromCity = await resolveStation(query.get('from'), 'from');
    const toCity = await resolveStation(query.get('to'), 'to');
    const days = Math.min(Math.max(Number(query.get('days') || 60), 1), 180);
    const start = normalizeDate(query.get('start')) || todayISO();

    const out = [];
    for (let i = 0; i < days; i++) {
      const dateISO = addDays(start, i);
      const plan = await routePlan({ fromCity, toCity, dateISO });
      out.push({
        date: dateISO,
        datePretty: plan.datePretty,
        weekday: plan.weekday,
        status: plan.dateStatus.kind,
        daysAway: plan.dateStatus.offset,
        trainsRunning: plan.trainsRunningOnDate,
        saleOpensAt: plan.firstAvailability?.opensAtISO || null,
        saleOpenDate: plan.firstAvailability?.openDate || null,
        saleOpenDatePretty: plan.firstAvailability?.openDatePretty || null,
        saleOpenTime: plan.firstAvailability?.openTime || null,
        zoneOpenTime: plan.firstAvailability?.zoneOpenTime || null,
        saleIsOpen: plan.firstAvailability?.isOpen ?? null,
        bookingUrl: bookingUrl({ fromCity, toCity, dateISO }),
      });
    }
    return {
      from: { city: fromCity, label: stationLabel(fromCity) },
      to: { city: toCity, label: stationLabel(toCity) },
      window: bookingWindow(),
      days: out,
    };
  },

  'GET /api/history': async ({ query }) => {
    const from = query.get('from');
    const to = query.get('to');
    if (!from || !to) return { overview: await historyOverview() };

    const fromCity = await resolveStation(from, 'from');
    const toCity = await resolveStation(to, 'to');
    const dateParam = query.get('date');
    return {
      overview: await historyOverview(),
      route: await routeHistory({ fromCity, toCity }),
      journeyDate: dateParam
        ? await journeyDateHistory({ fromCity, toCity, dateISO: requireDate(dateParam) })
        : null,
    };
  },

  'GET /api/watchlist': async () => ({ watches: await listWatches() }),

  'POST /api/watchlist': async ({ body }) => {
    const fromCity = await resolveStation(body.from, 'from');
    const toCity = await resolveStation(body.to, 'to');
    if (fromCity === toCity) throw new HttpError(400, 'Origin and destination must be different stations');
    await addWatch(fromCity, toCity);
    return { ok: true, watches: await listWatches() };
  },

  'DELETE /api/watchlist': async ({ query }) => {
    await removeWatch(
      await resolveStation(query.get('from'), 'from'),
      await resolveStation(query.get('to'), 'to'),
    );
    return { ok: true, watches: await listWatches() };
  },

  'POST /api/collect': async () => collectOnce({ token: await getToken() }),

  'GET /api/token': async () => tokenInfo(),

  'POST /api/token': async ({ body }) => {
    // Accepts a bare JWT or the JSON blob the Settings snippet copies.
    const creds = normalizeCredentials(body.token);
    const { token } = creds;

    if (!token) {
      await setToken('');
      await setDeviceCredentials({ deviceId: '', deviceKey: '' });
      return { ok: true, cleared: true, token: await tokenInfo() };
    }
    if (token.split('.').length < 3 || token.length < 40) {
      throw new HttpError(400, 'That does not look like a session token. Use the snippet in these instructions, or copy the full value of the "token" key from local storage on eticket.railway.gov.bd.');
    }

    // Probe with the device identity that came with this paste, falling back
    // to whatever was stored before, so a token-only re-paste still works.
    const existing = await getDeviceIdentity();
    const deviceId = creds.deviceId || existing.deviceId;
    const deviceKey = creds.deviceKey || existing.deviceKey;
    setDeviceIdentity({ deviceId, deviceKey });

    const probe = await checkToken(token, { dateISO: addDays(todayISO(), 1) });
    if (!probe.valid) {
      setDeviceIdentity(existing); // Leave the working state untouched.
      throw new HttpError(400, explainRejection(token, probe.reason, Boolean(deviceId)), {
        hasDeviceId: Boolean(deviceId),
        expiresAt: jwtExpiry(token)?.toISOString() || null,
      });
    }

    await setToken(token);
    await setDeviceCredentials({ deviceId, deviceKey });
    return { ok: true, token: await tokenInfo() };
  },

  'POST /api/sync': async () => {
    if (syncState.running) return { started: false, running: true, ...syncState };
    runSync().catch((err) => { syncState.lastResult = { error: err.message }; });
    return { started: true };
  },

  'GET /api/sync': async () => ({
    running: syncState.running,
    done: syncState.done,
    total: syncState.total,
    startedAt: syncState.startedAt,
    lastResult: syncState.lastResult,
    catalog: await catalogStatus(),
  }),

  /** Liveness/readiness for hosting platforms. Exposes no secrets. */
  'GET /api/health': async () => {
    const catalog = await catalogStatus();
    return { ok: true, env: NODE_ENV, database: 'connected', catalogTrains: catalog.trains };
  },

  /* ----------------------------- sale alarms ---------------------------- */

  'GET /api/notify/status': async ({ req }) => {
    const status = await notifyStatus();
    const subscriber = await subscriberByToken(notifyTokenOf(req));
    return {
      ...status,
      limit: MAX_ALERTS_PER_SUBSCRIBER,
      connected: Boolean(subscriber),
      subscriber: subscriber ? { id: subscriber.id, displayName: subscriber.displayName } : null,
    };
  },

  /**
   * The bot token, managed from the UI and stored in the database like the
   * Bangladesh Railway session token. Saving it verifies against getMe first
   * and takes effect immediately — the update loop picks it up without a
   * restart. The token itself is never returned, only a masked preview.
   */
  'POST /api/notify/bot': async ({ body }) => {
    const res = await setBotToken(body.token);
    return { ...res, status: await notifyStatus() };
  },

  'DELETE /api/notify/bot': async () => {
    await setBotToken('');
    return { cleared: true, status: await notifyStatus() };
  },

  /** Step 1 of pairing: hand the browser a code and the t.me link carrying it. */
  'POST /api/notify/pair': async () => createPairing(),

  /** Step 2: the browser polls until the bot has seen `/start <code>`. */
  'GET /api/notify/pair': async ({ query }) => {
    const code = query.get('code');
    if (!code) throw new HttpError(400, '"code" is required');
    return pairingStatus(code);
  },

  'GET /api/notify/alerts': async ({ req }) => {
    const subscriber = await requireSubscriber(req);
    return listAlerts(subscriber.id);
  },

  'POST /api/notify/alerts': async ({ body, req }) => {
    const subscriber = await requireSubscriber(req);
    const fromCity = await resolveStation(body.from, 'from');
    const toCity = await resolveStation(body.to, 'to');
    const dateISO = requireDate(body.date);

    const alert = await createAlert({ subscriber, fromCity, toCity, dateISO });
    return { alert, ...(await listAlerts(subscriber.id)) };
  },

  /**
   * Fire a drill down the real scheduling path, so what it proves is that the
   * real one works — not merely that a message can be sent.
   */
  'POST /api/notify/test': async ({ body, req }) => {
    const subscriber = await requireSubscriber(req);
    const alert = await sendTestAlarm({
      subscriber,
      fromCity: body.from ? await resolveStation(body.from, 'from') : null,
      toCity: body.to ? await resolveStation(body.to, 'to') : null,
      dateISO: body.date ? requireDate(body.date) : null,
      delaySeconds: body.delaySeconds,
    });
    return { alert, ...(await listAlerts(subscriber.id)) };
  },

  'DELETE /api/notify/alerts': async ({ query, req }) => {
    const subscriber = await requireSubscriber(req);
    const id = Number(query.get('id'));
    if (!Number.isFinite(id)) throw new HttpError(400, '"id" is required');
    await cancelAlert(subscriber.id, id);
    return listAlerts(subscriber.id);
  },
};

/* -------------------------------- wiring -------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    const handler = handlers[key];
    if (handler) {
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
      return sendJson(res, 200, await handler({ query: url.searchParams, body, req }));
    }
    if (url.pathname.startsWith('/api/')) {
      throw new HttpError(404, `No such endpoint: ${req.method} ${url.pathname}`);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { error: err.message, ...err.extra });
    }
    if (err instanceof UpstreamError) {
      return sendJson(res, err.needsAuth ? 401 : 502, {
        error: err.message, code: err.code, needsAuth: err.needsAuth,
      });
    }
    // Every NotifyError is something the user can act on — say exactly what.
    if (err instanceof NotifyError) {
      return sendJson(res, 400, { error: err.message, code: err.code });
    }
    console.error('unhandled error', err);
    // Generic message in production: internal errors can carry connection detail.
    return sendJson(res, 500, {
      error: NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal error'),
    });
  }
});

/* --------------------------------- boot --------------------------------- */

/**
 * Turn listen failures into an explanation instead of an unhandled 'error'
 * event and a stack trace. EADDRINUSE in particular is routine — usually an
 * earlier instance of this very server still running.
 */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use — most likely another copy of this ` +
      'server is still running.\n\n' +
      '  See what is holding it:\n' +
      `    lsof -nP -iTCP:${PORT} -sTCP:LISTEN\n\n` +
      '  Stop it:\n' +
      '    pkill -f "node src/server.js"\n\n' +
      '  Or start on a different port:\n' +
      `    PORT=${PORT + 1} npm start\n`,
    );
  } else if (err.code === 'EACCES') {
    console.error(
      `\n  Not allowed to bind port ${PORT}. Ports below 1024 need elevated ` +
      'privileges — use a higher port, e.g. PORT=8787 npm start\n',
    );
  } else {
    console.error(`\n  Server failed to start: ${err.message}\n`);
  }
  closePool().catch(() => {}).finally(() => process.exit(1));
});

async function start() {
  let conn;
  try {
    conn = await verifyConnection();
    await migrate();
  } catch (err) {
    console.error(`\n  Cannot start: ${err.message}\n`);
    process.exit(1);
  }

  // Must happen before the collector or any search runs: the session token is
  // only accepted alongside the device it was issued to.
  setDeviceIdentity(await getDeviceIdentity());

  const [catalog, token, overview, notify] = await Promise.all([
    catalogStatus(), getToken(), historyOverview(), notifyStatus(),
  ]);

  server.listen(PORT, () => {
    console.log(`\n  rail_first_seat  →  http://localhost:${PORT}\n`);
    console.log(`  database: ${conn.version} at ${conn.label}`);
    console.log(`  catalog : ${catalog.trains} trains, ${catalog.stations} stations, ${catalog.stops} stops` +
      (catalog.syncedAt ? ` (synced ${catalog.syncedAt})` : ''));
    console.log(`  session : ${token ? 'token present — live seat counts enabled' : 'no token — schedules and sale times only'}`);
    console.log(`  history : ${overview.snapshots} snapshot(s) recorded`);
    console.log(`  alarms  : ${notify.configured
      ? `Telegram @${notify.botUsername} — sale-open alarms enabled`
      : 'no bot connected yet — add one in Settings to enable alarms'}\n`);
  });

  // Seeding needs the catalog, so it waits for a first-run sync to finish.
  const seedWatchlist = async () => {
    if (!process.env.BR_WATCH || (await listWatches()).length > 0) return;
    for (const pair of process.env.BR_WATCH.split(',')) {
      const [f, t] = pair.split('>').map((s) => s?.trim());
      if (!f || !t) continue;
      try {
        await addWatch(await resolveStation(f, 'from'), await resolveStation(t, 'to'));
        console.log(`  watchlist: tracking ${f} → ${t}`);
      } catch (e) {
        console.warn(`  watchlist: skipped "${pair}" — ${e.message}`);
      }
    }
  };

  if (await catalogIsEmpty()) {
    console.log('  Catalog is empty — fetching it now from Bangladesh Railway (~1 min)…');
    runSync()
      .then(async (r) => {
        console.log(`  Catalog ready: ${r.trains} trains, ${r.stations} stations.\n`);
        await seedWatchlist();
      })
      .catch((e) => console.error(`  Catalog sync failed: ${e.message}\n`));
  } else {
    await seedWatchlist();
  }

  startCollector({ getToken, log: (m) => console.log(`  ${m}`) });
  startNotifications({ log: (m) => console.log(`  ${m}`) });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\n  shutting down…');
    server.close();
    await closePool().catch(() => {});
    process.exit(0);
  });
}

start();
