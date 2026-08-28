/**
 * Client for the Bangladesh Railway e-ticketing backend (operated by Shohoz),
 * the same JSON API that https://eticket.railway.gov.bd itself calls.
 *
 * Three endpoints matter here:
 *
 *   GET  /all-trains/info   PUBLIC  — every intercity train: number, origin,
 *                                     destination, zone, ticket-sale opening time.
 *   POST /train-routes      PUBLIC  — full stop list, timings and running days
 *                                     for one train (`model` is the train NUMBER).
 *   GET  /bookings/search-trips-v2   AUTH — live seat counts and fares per class.
 *
 * The first two need no credentials, so schedules, route matching and
 * sale-open times always work. search-trips-v2 needs a logged-in session
 * token; sign-in is Cloudflare-Turnstile protected and deliberately not
 * automated here, so the token is supplied by the user (see README).
 */
import { API_BASE, USER_AGENT, REQUEST_TIMEOUT_MS, SITE_BASE } from './config.js';
import { toApiDate } from './time.js';

export class UpstreamError extends Error {
  constructor(message, { status = 0, code = null, needsAuth = false, body = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.needsAuth = needsAuth;
    this.body = body;
  }
}

/**
 * Device identity that accompanies a session token.
 *
 * The official site's HTTP interceptor sends `X-Device-Id` (a FingerprintJS
 * visitorId it persists in localStorage as `uudid`) and, when present,
 * `X-Device-Key` (`ssdk`) on every request. The backend appears to tie a
 * session to the device it was issued to, so replaying the bare JWT gets a
 * 401 that is indistinguishable from expiry.
 *
 * There is one Bangladesh Railway session per instance, so this is ambient
 * rather than threaded through every call site.
 */
let deviceIdentity = { deviceId: null, deviceKey: null };

export function setDeviceIdentity({ deviceId = null, deviceKey = null } = {}) {
  deviceIdentity = { deviceId: deviceId || null, deviceKey: deviceKey || null };
}

export function getDeviceIdentity() {
  return { ...deviceIdentity };
}

/**
 * Accept whatever the user actually managed to copy.
 *
 * Three real-world shapes: the bare JWT, the JWT with quotes or a `Bearer`
 * prefix picked up from DevTools, and the JSON blob our Settings snippet
 * produces (token + device id + key in one paste). JWTs contain no
 * whitespace, so collapsing it is always safe and repairs a wrapped copy.
 */
export function normalizeCredentials(input) {
  const raw = String(input ?? '').trim();
  const clean = (v) => String(v ?? '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^["'`]+|["'`,;]+$/g, '')
    .replace(/\s+/g, '');

  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw);
      return {
        token: clean(o.token ?? o.access_token ?? o.jwt),
        deviceId: clean(o.deviceId ?? o.uudid ?? o.device_id) || null,
        deviceKey: clean(o.deviceKey ?? o.ssdk ?? o.device_key) || null,
      };
    } catch { /* not JSON after all — fall through to the bare-token path */ }
  }
  return { token: clean(raw), deviceId: null, deviceKey: null };
}

function baseHeaders(token) {
  const h = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
    referer: `${SITE_BASE}/`,
    origin: SITE_BASE,
    // Sent by the site on every call; some endpoints treat its absence as
    // a non-browser request.
    'x-requested-with': 'XMLHttpRequest',
  };
  if (deviceIdentity.deviceId) h['x-device-id'] = deviceIdentity.deviceId;
  if (deviceIdentity.deviceKey) h['x-device-key'] = deviceIdentity.deviceKey;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function request(pathname, { method = 'GET', query, body, token } = {}) {
  const url = new URL(API_BASE + pathname);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const headers = baseHeaders(token);
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new UpstreamError(
      timedOut
        ? 'Bangladesh Railway did not respond in time. It is often slow around ticket-release times — try again in a moment.'
        : `Could not reach Bangladesh Railway: ${err.message}`,
      { code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE' },
    );
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const messages = json?.error?.messages;
    const detail = Array.isArray(messages)
      ? messages.join(' ')
      : typeof messages === 'string'
        ? messages
        : messages?.errorKey || json?.message || `HTTP ${res.status}`;
    const needsAuth = res.status === 401 || /access token/i.test(String(detail));
    throw new UpstreamError(
      needsAuth
        ? 'Bangladesh Railway rejected the session token — it is missing or has expired. Add a fresh one in Settings to see live seat counts.'
        : `Bangladesh Railway returned an error: ${detail}`,
      { status: res.status, code: needsAuth ? 'AUTH_REQUIRED' : 'UPSTREAM_ERROR', needsAuth, body: json },
    );
  }
  return json;
}

/** Every intercity train, with its zone and daily ticket-sale opening time. PUBLIC. */
export async function fetchAllTrains() {
  const json = await request('/all-trains/info');
  const trains = json?.data?.trains;
  if (!Array.isArray(trains)) throw new UpstreamError('Unexpected shape from /all-trains/info', { body: json });
  return trains.map((t) => ({
    trainNumber: String(t.train_number).trim(),
    originCity: t.origin_city,
    destinationCity: t.destination_city,
    openingTime: t.opening_time,
    zone: t.zone,
  }));
}

/**
 * Full stop list for one train. PUBLIC.
 * `model` is the train number as a string ("709"); `departureDate` only has to
 * be a plausible service date for the timetable to resolve.
 */
export async function fetchTrainRoute(trainNumber, departureDateISO) {
  const json = await request('/train-routes', {
    method: 'POST',
    body: { model: String(trainNumber), departure_date_time: departureDateISO },
  });
  const d = json?.data || {};
  return {
    trainNumber: String(trainNumber),
    trainName: d.train_name || '',
    days: Array.isArray(d.days) ? d.days : [],
    totalDuration: d.total_duration || null,
    routes: Array.isArray(d.routes) ? d.routes : [],
  };
}

/**
 * Live trips with per-class seat counts and fares. REQUIRES a session token.
 * `seatClass` only seeds the response's "selected" class; every class the
 * trip offers comes back regardless.
 */
export async function searchTrips({ fromCity, toCity, dateISO, seatClass = 'S_CHAIR', token }) {
  if (!token) {
    throw new UpstreamError(
      'Live seat counts need a Bangladesh Railway session token. Add one in Settings.',
      { code: 'AUTH_REQUIRED', needsAuth: true },
    );
  }
  const json = await request('/bookings/search-trips-v2', {
    query: {
      from_city: fromCity,
      to_city: toCity,
      date_of_journey: toApiDate(dateISO),
      seat_class: seatClass,
    },
    token,
  });
  return {
    trains: Array.isArray(json?.data?.trains) ? json.data.trains : [],
    selectedSeatClass: json?.data?.selected_seat_class || null,
  };
}

/** Cheap liveness/validity probe for a token: does a real search succeed? */
export async function checkToken(token, { fromCity = 'Dhaka', toCity = 'Chattogram', dateISO } = {}) {
  try {
    await searchTrips({ fromCity, toCity, dateISO, token });
    return { valid: true, reason: null };
  } catch (err) {
    if (err instanceof UpstreamError && err.needsAuth) return { valid: false, reason: err.message };
    // Reached the API and got a non-auth answer — the token itself is fine.
    if (err instanceof UpstreamError && err.status >= 400 && err.status < 500) {
      return { valid: true, reason: null };
    }
    return { valid: false, reason: err.message };
  }
}

/** Deep link straight into the official booking flow. */
export function bookingUrl({ fromCity, toCity, dateISO, seatClass = 'S_CHAIR' }) {
  const u = new URL(`${SITE_BASE}/booking/train/search`);
  u.searchParams.set('fromcity', fromCity);
  u.searchParams.set('tocity', toCity);
  u.searchParams.set('doj', toApiDate(dateISO));
  u.searchParams.set('class', seatClass);
  return u.toString();
}
