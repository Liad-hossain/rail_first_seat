/**
 * Supabase Postgres data layer.
 *
 * Connects with the `pg` driver over the connection string in SUPABASE_DB_URL,
 * so ordinary SQL (including the GROUP BY aggregates the history views need)
 * works directly. Nothing here ever reaches the browser: the frontend only
 * calls this server's /api routes.
 *
 * Two kinds of data live here:
 *  1. The catalog (trains, stations, stops) — refreshed from Bangladesh
 *     Railway's public endpoints, and what makes route matching and sale-time
 *     answers work instantly.
 *  2. Availability history (snapshots + per-class seat counts) — appended over
 *     time so the site can show how a route's availability behaved on previous
 *     days and months.
 */
import fs from 'node:fs';
import pg from 'pg';
import {
  DATABASE_URL, PG_SSL_MODE, SUPABASE_CA_CERT, PG_POOL_MAX,
  assertDatabaseConfigured, safeDatabaseLabel,
} from './config.js';

const { Pool } = pg;

/** Postgres returns BIGINT/NUMERIC as strings to avoid precision loss. */
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

/**
 * Keep DATE columns as plain 'YYYY-MM-DD' strings.
 *
 * By default pg turns a DATE into a JS Date at LOCAL midnight, so on a machine
 * east of UTC `2026-09-01` reads back as `2026-08-31` once formatted in UTC.
 * Journey dates are calendar days in Bangladesh, not instants, so the string is
 * both correct and unambiguous.
 */
pg.types.setTypeParser(1082, (v) => v); // date

function isLocalHost(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === 'host.docker.internal';
  } catch { return false; }
}

/**
 * TLS policy. Supabase requires an encrypted connection; a local container does
 * not offer one. 'strict' verifies the chain (supply SUPABASE_CA_CERT with
 * Supabase's CA bundle); 'require' encrypts without verifying the chain, which
 * is what Supabase's own connection snippets do.
 */
function sslConfig() {
  const mode = PG_SSL_MODE === 'auto'
    ? (isLocalHost(DATABASE_URL) ? 'disable' : 'require')
    : PG_SSL_MODE;

  if (mode === 'disable') return false;

  if (mode === 'strict' || SUPABASE_CA_CERT) {
    if (!SUPABASE_CA_CERT) {
      throw new Error('PG_SSL_MODE=strict needs SUPABASE_CA_CERT (path to Supabase\'s CA certificate).');
    }
    return { ca: fs.readFileSync(SUPABASE_CA_CERT, 'utf8'), rejectUnauthorized: true };
  }
  // Encrypted, chain not verified.
  return { rejectUnauthorized: false };
}

let pool = null;

export function getPool() {
  if (pool) return pool;
  assertDatabaseConfigured();
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: sslConfig(),
    max: PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    // Supabase's transaction-mode pooler rejects named prepared statements;
    // pg only uses them when a query is given a `name`, which we never do.
  });
  pool.on('error', (err) => console.error(`postgres pool error: ${err.message}`));
  return pool;
}

/** Run a query, return rows. Parameters are always bound, never interpolated. */
export async function query(sql, params = []) {
  const res = await getPool().query(sql, params);
  return res.rows;
}

/** Run a query, return the first row or null. */
export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** Run `fn` inside a transaction on a single dedicated connection. */
export async function transact(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn({
      query: async (sql, params = []) => (await client.query(sql, params)).rows,
      one: async (sql, params = []) => {
        const r = await client.query(sql, params);
        return r.rows.length ? r.rows[0] : null;
      },
    });
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

/**
 * Idempotent schema creation. Also runnable by hand as supabase/schema.sql in
 * the Supabase SQL editor; keeping it here means a fresh deploy needs no
 * manual step.
 *
 * Row Level Security is enabled with no policies on every table. This server
 * connects as the database owner, which bypasses RLS, but it means that if the
 * project's anon/publishable key is ever used against PostgREST these tables
 * stay unreadable — defence in depth for the credential-exposure question.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS trains (
  train_number      TEXT PRIMARY KEY,
  train_name        TEXT,
  origin_city       TEXT,
  destination_city  TEXT,
  zone              TEXT,
  opening_time      TEXT,
  running_days      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  off_day           TEXT,
  total_duration    TEXT,
  stop_count        INTEGER,
  route_synced_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stations (
  city_name   TEXT PRIMARY KEY,
  label       TEXT,
  train_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stops (
  train_number   TEXT    NOT NULL REFERENCES trains(train_number) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  city_name      TEXT    NOT NULL,
  arrival_time   TEXT,
  departure_time TEXT,
  halt_minutes   INTEGER,
  duration_raw   TEXT,
  PRIMARY KEY (train_number, seq)
);
CREATE INDEX IF NOT EXISTS idx_stops_city  ON stops(city_name);
CREATE INDEX IF NOT EXISTS idx_stops_train ON stops(train_number);

-- One row per (route, journey date, moment we looked).
CREATE TABLE IF NOT EXISTS snapshots (
  id            BIGSERIAL   PRIMARY KEY,
  from_city     TEXT        NOT NULL,
  to_city       TEXT        NOT NULL,
  journey_date  DATE        NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL,
  captured_date DATE        NOT NULL,
  days_ahead    INTEGER,
  source        TEXT        NOT NULL,
  train_count   INTEGER     NOT NULL DEFAULT 0,
  total_seats   INTEGER     NOT NULL DEFAULT 0,
  ok            BOOLEAN     NOT NULL DEFAULT TRUE,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_route_date
  ON snapshots(from_city, to_city, journey_date, captured_at);
CREATE INDEX IF NOT EXISTS idx_snap_captured ON snapshots(captured_date);

-- Per-train, per-class seat counts belonging to one snapshot.
CREATE TABLE IF NOT EXISTS seat_counts (
  snapshot_id    BIGINT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  train_number   TEXT,
  train_name     TEXT,
  departure_time TEXT,
  arrival_time   TEXT,
  seat_class     TEXT   NOT NULL,
  online_seats   INTEGER NOT NULL DEFAULT 0,
  offline_seats  INTEGER NOT NULL DEFAULT 0,
  fare           DOUBLE PRECISION,
  vat            DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_seat_counts_snap ON seat_counts(snapshot_id);

-- Routes the background collector keeps history for.
CREATE TABLE IF NOT EXISTS watchlist (
  from_city   TEXT        NOT NULL,
  to_city     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  PRIMARY KEY (from_city, to_city)
);

ALTER TABLE meta        ENABLE ROW LEVEL SECURITY;
ALTER TABLE trains      ENABLE ROW LEVEL SECURITY;
ALTER TABLE stations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE stops       ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE seat_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist   ENABLE ROW LEVEL SECURITY;

-- People who can be alarmed. One row per Telegram chat that completed pairing.
CREATE TABLE IF NOT EXISTS notify_subscribers (
  id           BIGSERIAL   PRIMARY KEY,
  chat_id      TEXT        NOT NULL UNIQUE,
  display_name TEXT,
  -- Bearer secret handed to the browser once at pairing, so one person's
  -- alarms cannot be listed or cancelled from someone else's browser.
  access_token TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ
);

-- Short-lived codes that bind "this browser" to "that Telegram chat".
CREATE TABLE IF NOT EXISTS notify_pairings (
  code          TEXT        PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  subscriber_id BIGINT      REFERENCES notify_subscribers(id) ON DELETE CASCADE,
  claimed_at    TIMESTAMPTZ
);

-- One pending alarm: fire when this journey date's sale opens.
CREATE TABLE IF NOT EXISTS alerts (
  id              BIGSERIAL   PRIMARY KEY,
  subscriber_id   BIGINT      NOT NULL REFERENCES notify_subscribers(id) ON DELETE CASCADE,
  from_city       TEXT        NOT NULL,
  to_city         TEXT        NOT NULL,
  journey_date    DATE        NOT NULL,
  -- Frozen at creation from saleOpening(); the sale instant for a given date
  -- never moves, and freezing it keeps the scheduler a pure index scan.
  opens_at        TIMESTAMPTZ NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL,
  fired_at        TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  rings_sent      INTEGER     NOT NULL DEFAULT 0,
  last_error      TEXT
);
-- Test alarms are real rows travelling the real scheduler path, marked so they
-- neither consume one of the three slots nor collide with a genuine alarm.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
-- The message currently ringing. Each new ring deletes the previous one, so the
-- chat keeps one live alarm rather than a wall of duplicates.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_message_id BIGINT;

-- The 3-per-person cap counts only 'active' rows, and the same route+date may
-- be alarmed again after a previous one fired, so uniqueness is partial too.
DROP INDEX IF EXISTS idx_alerts_active_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_real_unique
  ON alerts(subscriber_id, from_city, to_city, journey_date)
  WHERE status = 'active' AND is_test = FALSE;
CREATE INDEX IF NOT EXISTS idx_alerts_due ON alerts(status, opens_at);
CREATE INDEX IF NOT EXISTS idx_alerts_sub ON alerts(subscriber_id, status);

-- Per-user Bangladesh Railway session.
--
-- The session token used to be one site-wide value in the meta table, which
-- meant every visitor shared — and could overwrite — one person's railway
-- login. It belongs to whoever pasted it, so it lives on their row. The old
-- meta.br_token is kept as the fallback the background collector and release
-- probe run under; see serviceCredentials() in server.js.
--
-- device id/key travel with the token because upstream binds a session to the
-- device it was issued to: the token alone gets a 401 that looks like expiry.
ALTER TABLE notify_subscribers ADD COLUMN IF NOT EXISTS br_token TEXT;
ALTER TABLE notify_subscribers ADD COLUMN IF NOT EXISTS br_token_saved_at TIMESTAMPTZ;
ALTER TABLE notify_subscribers ADD COLUMN IF NOT EXISTS br_device_id TEXT;
ALTER TABLE notify_subscribers ADD COLUMN IF NOT EXISTS br_device_key TEXT;

ALTER TABLE notify_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify_pairings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts             ENABLE ROW LEVEL SECURITY;

/* ------------------------------------------------------------------ *
 * Telegram bots — one per user, not one per site.
 *
 * The bot token used to be a single value in the meta table, which made the bot a
 * shared fixture: everyone paired with whoever's bot happened to be installed,
 * its @username and masked token were readable by anonymous visitors, and any
 * signed-in user could swap or delete it out from under everyone else.
 *
 * A bot is now a first-class row. You bring your own from @BotFather, and the
 * first chat that pairs on it becomes its owner — the only account that may
 * replace or disconnect it. bot_id is the numeric half of the token, which
 * Telegram guarantees is stable and unique per bot; it is also the path
 * segment of that bot's webhook, since an incoming update carries nothing that
 * says which bot it was sent to.
 * ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS bots (
  id                BIGSERIAL   PRIMARY KEY,
  -- The "123456789" half of "123456789:AAH...". Stable, not secret, and the
  -- webhook path segment that tells an inbound update which bot it belongs to.
  bot_id            TEXT        NOT NULL UNIQUE,
  token             TEXT        NOT NULL,
  username          TEXT,
  name              TEXT,
  -- Set by the first chat to pair on this bot; only that account may replace
  -- or disconnect it. NULL means "added but nobody has paired yet".
  owner_id          BIGINT      REFERENCES notify_subscribers(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  token_saved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Telegram numbers updates per bot, so the long-poll cursor cannot be shared.
  update_offset     BIGINT      NOT NULL DEFAULT 0,
  delivery_mode     TEXT,
  webhook_url       TEXT,
  webhook_secret_fp TEXT,
  -- The bot seeded from TELEGRAM_BOT_TOKEN, if any. It is the one a visitor
  -- with no bot of their own may pair with, and it has no owner to claim it.
  is_default        BOOLEAN     NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
-- At most one default bot; a partial unique index says so without a trigger.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_one_default ON bots((is_default)) WHERE is_default;

-- Which bot a chat belongs to. Deleting a bot really does end the accounts on
-- it: an alarm with no bot to ring through can never fire.
ALTER TABLE notify_subscribers ADD COLUMN IF NOT EXISTS bot_id BIGINT
  REFERENCES bots(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_subscribers_bot ON notify_subscribers(bot_id);

-- A chat id is only unique WITHIN a bot: the same person may hold an account
-- on two different bots, and Telegram gives them the same chat id on both.
ALTER TABLE notify_subscribers DROP CONSTRAINT IF EXISTS notify_subscribers_chat_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_bot_chat
  ON notify_subscribers(bot_id, chat_id);

-- A pairing code is minted for one specific bot, so a code shown for your bot
-- cannot be redeemed by sending it to somebody else's.
ALTER TABLE notify_pairings ADD COLUMN IF NOT EXISTS bot_id BIGINT
  REFERENCES bots(id) ON DELETE CASCADE;

ALTER TABLE bots ENABLE ROW LEVEL SECURITY;

-- One-time adoption of the pre-multi-tenant deployment: the single meta token
-- becomes the default bot, and every chat paired before this migration keeps
-- working by being attached to it. Guarded by a meta flag rather than by
-- "bots is empty", so disconnecting every bot later cannot resurrect it.
INSERT INTO bots (bot_id, token, is_default)
SELECT split_part(m.value, ':', 1), m.value, TRUE
  FROM meta m
 WHERE m.key = 'telegram_bot_token'
   AND m.value <> ''
   AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'bots_migrated')
ON CONFLICT (bot_id) DO NOTHING;

UPDATE notify_subscribers s SET bot_id = b.id
  FROM bots b
 WHERE s.bot_id IS NULL AND b.is_default
   AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'bots_migrated');

UPDATE bots b SET update_offset = COALESCE(NULLIF(m.value, '')::bigint, 0)
  FROM meta m
 WHERE m.key = 'telegram_update_offset' AND b.is_default
   AND m.value ~ '^[0-9]+$'
   AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'bots_migrated');

INSERT INTO meta (key, value) VALUES ('bots_migrated', '1')
ON CONFLICT (key) DO NOTHING;
`;

let migrated = false;

/** Arbitrary but fixed: every process must pick the same number to serialise on. */
const SCHEMA_LOCK_ID = 8241971;

export async function migrate({ force = false } = {}) {
  if (migrated && !force) return;
  // Two processes running this DDL at the same time deadlock in Postgres —
  // CREATE TABLE/INDEX IF NOT EXISTS still take locks, and they take them in
  // whatever order each transaction reaches them. That is not hypothetical:
  // the server booting while `npm run sync` starts, or two test files, is
  // enough. The advisory lock is released when the transaction ends.
  await transact(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
    await tx.query(SCHEMA_SQL);
  });
  migrated = true;
}

/** Fail fast at boot with a clear message rather than on the first request. */
export async function verifyConnection() {
  assertDatabaseConfigured();
  const row = await one('SELECT current_database() AS db, version() AS version');
  return { database: row.db, version: String(row.version).split(' ').slice(0, 2).join(' '), label: safeDatabaseLabel() };
}

export async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

export async function getMeta(key, fallback = null) {
  const row = await one('SELECT value FROM meta WHERE key = $1', [key]);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  await query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value == null ? null : String(value)],
  );
}

export async function catalogIsEmpty() {
  const row = await one('SELECT COUNT(*)::int AS n FROM trains');
  return row.n === 0;
}

/** DATE columns come back as JS Dates; we want plain ISO day strings. */
export function isoDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

/** TIMESTAMPTZ columns come back as JS Dates; the API speaks ISO strings. */
export function isoTimestamp(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
