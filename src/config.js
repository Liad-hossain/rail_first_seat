import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const WEB_DIR = path.join(ROOT, 'web');

/**
 * Load a local .env for development. On a hosting platform there is no .env —
 * the variables come from the platform's own secret store, so a missing file is
 * normal and never an error.
 */
if (fs.existsSync(path.join(ROOT, '.env'))) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); }
  catch (err) { console.warn(`Could not read .env: ${err.message}`); }
}

export const PORT = Number(process.env.PORT || 8787);
export const NODE_ENV = process.env.NODE_ENV || 'development';

/* ------------------------------------------------------------------ *
 * Database — Supabase Postgres
 *
 * The connection string is a SECRET. It is read from the environment only:
 * never hard-coded, never written to a committed file, and never sent to the
 * browser. The frontend talks exclusively to this server's own /api routes, so
 * no database credential ever reaches a visitor.
 * ------------------------------------------------------------------ */

export const DATABASE_URL =
  process.env.SUPABASE_DB_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  '';

/** Obvious placeholders people leave behind after copying .env.example. */
const PLACEHOLDER = /\[YOUR-PASSWORD\]|YOUR-PASSWORD|<password>|xxxxx|change[-_]?me/i;

export function assertDatabaseConfigured() {
  if (!DATABASE_URL) {
    throw new Error(
      'No database configured. Set SUPABASE_DB_URL to your Supabase Postgres ' +
      'connection string.\n' +
      '  Supabase dashboard → Project Settings → Database → Connection string → URI\n' +
      '  Local development: copy .env.example to .env and put it there.\n' +
      '  Hosting: add it as an environment variable / secret in the platform dashboard.',
    );
  }
  if (PLACEHOLDER.test(DATABASE_URL)) {
    throw new Error(
      'SUPABASE_DB_URL still contains a placeholder. Replace it with your real ' +
      'database password from the Supabase dashboard.',
    );
  }
  if (!/^postgres(ql)?:\/\//.test(DATABASE_URL)) {
    throw new Error('SUPABASE_DB_URL must be a postgresql:// connection string.');
  }
}

/** Host:port/db with the password stripped — safe to print in logs. */
export function safeDatabaseLabel() {
  if (!DATABASE_URL) return '(not configured)';
  try {
    const u = new URL(DATABASE_URL);
    return `${u.username ? `${u.username}@` : ''}${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

/** TLS: required for Supabase, pointless for a local container. */
export const PG_SSL_MODE = process.env.PG_SSL_MODE || 'auto'; // auto | require | strict | disable
export const SUPABASE_CA_CERT = process.env.SUPABASE_CA_CERT || '';
export const PG_POOL_MAX = Number(process.env.PG_POOL_MAX || 8);

/* ------------------------------------------------------------------ *
 * Upstream (Shohoz-operated Bangladesh Railway e-ticketing backend)
 * ------------------------------------------------------------------ */

// Overridable so the request path can be asserted against a local stub.
export const API_BASE = process.env.BR_API_BASE || 'https://railspaapi.shohoz.com/v1.0/web';
export const SITE_BASE = 'https://eticket.railway.gov.bd';

/** Bangladesh Standard Time — UTC+6 year-round, no DST. */
export const TZ = 'Asia/Dhaka';
export const TZ_OFFSET_MINUTES = 6 * 60;

/**
 * Bangladesh Railway sells a rolling window of journey dates: today through
 * today + ADVANCE_DAYS. The official site takes the span from its own config
 * endpoint (POST /handshake -> `trip_search_day_limit: 10`) and hands it to its
 * datepicker as `maxDate: 10`, which jQuery UI reads as "10 days from today".
 *
 * So journey date D becomes bookable the moment (D - ADVANCE_DAYS) BEGINS in
 * Dhaka — midnight, when the window rolls forward — not at any later hour.
 *
 * Verified against the live site on 28 Aug 2026: at 11:15 BST, before the
 * 14:00 East-zone hour, the newest selectable date was already 7 Sep
 * (today + 10) and East-zone Dhaka -> Sreemangal tickets for it were on sale.
 */
export const ADVANCE_DAYS = 10;
export const SALE_OPEN_TIME = '00:00:00';

/**
 * The operator's published counter opening time, carried per-train by
 * upstream's `opening_time` and shown by the official site as "Ticket Opening
 * Time" on its train-information page.
 *
 * INFORMATIONAL ONLY. It does not gate when a journey date opens, so it must
 * never be used to compute the sale instant — doing so put every East-zone
 * route 14 hours late.
 */
export const ZONE_OPENING_TIME = { WEST: '08:00:00', EAST: '14:00:00' };

/* ------------------------------------------------------------------ *
 * Sale-open alarms (Telegram)
 *
 * The bot token is a SECRET and is read from the environment only, exactly
 * like the database URL. Anyone holding it can send messages as the bot.
 * ------------------------------------------------------------------ */

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// Overridable so the flow can be exercised end to end against a local stub.
export const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org';

/** Requirement: one person may hold at most this many pending alarms. */
export const MAX_ALERTS_PER_SUBSCRIBER = 3;

/**
 * Alarm behaviour: ONE message per alarm.
 *
 * A Telegram bot cannot play a continuous sound, so this used to repeat every
 * few seconds to approximate one. That is no longer its job — the phone-side
 * automation keyed on ALARM_TRIGGER_TAG starts a looping system alarm from the
 * FIRST notification, so further messages add clutter without adding urgency.
 *
 * Set ALARM_REPEAT back to true only if you rely on Telegram's own
 * notification sound rather than a phone automation.
 */
export const ALARM_REPEAT = false;
export const ALARM_RING_INTERVAL_MS = 10_000;

/**
 * How long delivery may be retried.
 *
 * With ALARM_REPEAT off this is not "how long it rings" but "how long we keep
 * trying to get that single message through" — Telegram times out often enough
 * that giving up on the first failure would lose the alarm entirely.
 */
export const ALARM_MAX_DURATION_MS = 15 * 60_000;

/** Hard stop regardless of duration, so a clock jump cannot run away. */
export const ALARM_MAX_RINGS = 120;

/**
 * A stable marker in every alarm message.
 *
 * Telegram itself cannot ring a phone, but an automation app (MacroDroid,
 * Tasker, Automate) can watch for the notification and start a real system
 * alarm. Those tools match on notification TEXT, so the text needs one token
 * that never changes with wording, route or date. Drills carry it too, so the
 * automation can be tested without waiting for a sale.
 */
export const ALARM_TRIGGER_TAG = '#RAILALARM';

/** A drill proves the behaviour; it does not need a quarter of an hour. */
export const ALARM_TEST_DURATION_MS = 90_000;

/** How long a test alarm waits before going off, so the phone can be put down. */
export const TEST_ALARM_DELAY_SECONDS = 15;
export const TEST_ALARM_MAX_DELAY_SECONDS = 300;

/**
 * How far ahead the scheduler looks. It scans on this interval and then arms a
 * precise timer for anything due inside the next SCHEDULER_LOOKAHEAD_MS, so
 * firing is accurate to the millisecond without querying every second.
 */
export const SCHEDULER_SCAN_MS = 15_000;
export const SCHEDULER_LOOKAHEAD_MS = 20_000;

/** Pairing codes are short-lived: they are a claim on a chat binding. */
export const PAIR_CODE_TTL_MS = 15 * 60_000;

/** Seat classes used by Bangladesh Railway intercity trains. */
export const SEAT_CLASSES = [
  'AC_B', 'AC_S', 'SNIGDHA', 'F_BERTH', 'F_SEAT', 'F_CHAIR',
  'S_CHAIR', 'SHOVAN_CHAIR', 'SHOVAN', 'SHULOV', 'AC_CHAIR',
];

export const SEAT_CLASS_LABELS = {
  AC_B: 'AC Berth', AC_S: 'AC Seat', SNIGDHA: 'Snigdha (AC chair)',
  F_BERTH: 'First Berth', F_SEAT: 'First Seat', F_CHAIR: 'First Chair',
  S_CHAIR: 'Shovan Chair', SHOVAN_CHAIR: 'Shovan Chair', SHOVAN: 'Shovan',
  SHULOV: 'Shulov', AC_CHAIR: 'AC Chair',
};

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Politeness: never hammer upstream. */
export const CRAWL_DELAY_MS = Number(process.env.BR_CRAWL_DELAY_MS || 350);
export const REQUEST_TIMEOUT_MS = 25_000;
