/**
 * Who is using the site, and what railway session they hold.
 *
 * The login is deliberately the thinnest thing that actually separates people:
 * pairing a Telegram chat mints a random bearer secret (notify_subscribers.
 * access_token), the browser keeps it, and every request that touches personal
 * data carries it. There is no password to choose, reset or leak, and no second
 * identity to reconcile — your Telegram account IS the account.
 *
 * Everything anonymous still works: schedules, sale times, the countdown and the
 * calendar need no session at all. A login is demanded only where the data is
 * genuinely someone's own — their alarms, and their Bangladesh Railway session.
 *
 * Why the railway token moved here: it used to be a single site-wide value in
 * `meta`, so every visitor shared one person's e-ticket login and any of them
 * could overwrite it. It is now a column on the owner's row.
 */
import { query, one, getMeta } from './db.js';

/** The header the browser sends its bearer secret in. */
export const SESSION_HEADER = 'x-notify-token';

/** Pull the bearer secret out of a request, whatever the header casing. */
export function sessionTokenOf(req) {
  const header = req?.headers?.[SESSION_HEADER] ?? req?.headers?.[SESSION_HEADER.toUpperCase()];
  return (Array.isArray(header) ? header[0] : header) || null;
}

/**
 * The signed-in user, or null.
 *
 * Also stamps last_seen_at, which is what makes "when did this account last do
 * anything" answerable without a separate session table.
 */
export async function currentUser(req) {
  const token = sessionTokenOf(req);
  if (!token) return null;
  const row = await one(
    `UPDATE notify_subscribers SET last_seen_at = now()
      WHERE access_token = $1
      RETURNING id, chat_id, display_name, created_at`,
    [token],
  );
  if (!row) return null;
  // Same shape subscriberByToken has always returned, so every existing caller
  // that takes a `subscriber` keeps working unchanged.
  return {
    id: row.id,
    chatId: row.chat_id,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ *
 * Bangladesh Railway session, per user
 * ------------------------------------------------------------------ */

/**
 * One user's railway credentials, in the shape shohoz.js consumes.
 *
 * Device id/key travel with the token because upstream binds a session to the
 * device it was issued to — the bare JWT gets a 401 indistinguishable from
 * expiry. Returned as a fresh object per call so two users' requests can never
 * end up sharing one mutable identity.
 */
export async function userCredentials(subscriberId) {
  if (!subscriberId) return { token: null, deviceId: null, deviceKey: null };
  const row = await one(
    'SELECT br_token, br_device_id, br_device_key FROM notify_subscribers WHERE id = $1',
    [subscriberId],
  );
  return {
    token: row?.br_token || null,
    deviceId: row?.br_device_id || null,
    deviceKey: row?.br_device_key || null,
  };
}

export async function setUserCredentials(subscriberId, { token, deviceId, deviceKey }) {
  await query(
    `UPDATE notify_subscribers
        SET br_token = $2,
            br_device_id = $3,
            br_device_key = $4,
            br_token_saved_at = CASE WHEN $2 = '' THEN NULL ELSE now() END
      WHERE id = $1`,
    [subscriberId, token || '', deviceId || null, deviceKey || null],
  );
}

/**
 * Credentials for work that belongs to nobody: the hourly history collector,
 * the sale-release probe, and the alarm-tick cron. They run with no request and
 * therefore no user, but still need a live session to read seat counts.
 *
 * Order matters. An explicitly configured deployment token wins, because that
 * is someone deliberately saying "run background work as this session". Failing
 * that we borrow the most recently saved user session — the alternative is
 * history quietly stopping the moment the token stops being site-wide.
 */
export async function serviceCredentials() {
  const configured = (await getMeta('br_token')) || process.env.BR_TOKEN || null;
  if (configured) {
    return {
      token: configured,
      deviceId: (await getMeta('br_device_id')) || process.env.BR_DEVICE_ID || null,
      deviceKey: (await getMeta('br_device_key')) || process.env.BR_DEVICE_KEY || null,
      source: 'configured',
    };
  }

  const row = await one(
    `SELECT br_token, br_device_id, br_device_key FROM notify_subscribers
      WHERE br_token IS NOT NULL AND br_token <> ''
      ORDER BY br_token_saved_at DESC NULLS LAST
      LIMIT 1`,
  );
  if (!row) return { token: null, deviceId: null, deviceKey: null, source: 'none' };
  return {
    token: row.br_token,
    deviceId: row.br_device_id || null,
    deviceKey: row.br_device_key || null,
    source: 'borrowed',
  };
}

/**
 * Masked metadata about a token — never the token itself.
 *
 * The browser needs to show "a session is saved, it expires on X"; it has no
 * business receiving a credential it could replay.
 */
export function describeToken(token, { savedAt = null, deviceId = null, deviceKey = null } = {}) {
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
    savedAt: savedAt ? new Date(savedAt).toISOString() : null,
    expiresAt,
    expired: expiresAt ? Date.parse(expiresAt) < Date.now() : null,
    subject: subject ? String(subject).replace(/(\d{3})\d+(\d{2})/, '$1***$2') : null,
    preview: `${token.slice(0, 8)}…${token.slice(-6)}`,
    hasDeviceId: Boolean(deviceId),
    hasDeviceKey: Boolean(deviceKey),
  };
}

/** What the Settings panel shows one signed-in user about their own session. */
export async function userTokenInfo(subscriberId) {
  const row = await one(
    `SELECT br_token, br_token_saved_at, br_device_id, br_device_key
       FROM notify_subscribers WHERE id = $1`,
    [subscriberId],
  );
  return describeToken(row?.br_token, {
    savedAt: row?.br_token_saved_at,
    deviceId: row?.br_device_id,
    deviceKey: row?.br_device_key,
  });
}
