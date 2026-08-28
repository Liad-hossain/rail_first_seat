/**
 * Sale-open alarms.
 *
 * You can only ask for an alarm on a journey date that is NOT yet buyable, and
 * that is the whole point: the sale instant for such a date is deterministic
 * (midnight Dhaka on D - ADVANCE_DAYS, see config.js), so the alarm needs no
 * polling, no session token, and no luck. The moment is frozen onto the row at
 * creation and a timer fires on it to the millisecond.
 *
 * Delivery is Telegram. Pairing works the way every bot does it: the browser
 * asks for a short code, the user taps a t.me deep link, the bot receives
 * `/start <code>` and binds that chat to the code. The only thing kept about a
 * person is their Telegram chat id and display name — no phone number, no
 * email, nothing they have not already given Telegram.
 */
import crypto from 'node:crypto';
import {
  MAX_ALERTS_PER_SUBSCRIBER, ALARM_RING_INTERVAL_MS,
  SCHEDULER_SCAN_MS, SCHEDULER_LOOKAHEAD_MS, PAIR_CODE_TTL_MS, ADVANCE_DAYS,
  TELEGRAM_BOT_TOKEN, ALARM_REPEAT, ALARM_MAX_DURATION_MS, ALARM_MAX_RINGS,
  ALARM_TRIGGER_TAG,
  ALARM_TEST_DURATION_MS, TEST_ALARM_DELAY_SECONDS, TEST_ALARM_MAX_DELAY_SECONDS,
} from './config.js';
import { query, one, transact, isoTimestamp, getMeta, setMeta } from './db.js';
import { routePlan } from './availability.js';
import { stationLabel } from './catalog.js';
import { bookingUrl } from './shohoz.js';
import { addDays, prettyDate, todayISO, daysBetween } from './time.js';
import {
  botConfigured, getBot, sendMessage, answerCallback, startTelegramListener,
  setBotTokenProvider, clearWebhookIfSet, deleteMessage, editMessageText, esc,
} from './telegram.js';

/** Thrown for user-fixable problems; the server maps it to a 400. */
export class NotifyError extends Error {
  constructor(message, code = 'NOTIFY_ERROR') {
    super(message);
    this.name = 'NotifyError';
    this.code = code;
  }
}

const newCode = () => crypto.randomBytes(4).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');

/* ------------------------------------------------------------------ *
 * The bot token
 *
 * Saved from the UI into `meta`, exactly like the Bangladesh Railway session
 * token, so connecting a bot never means editing a file and restarting.
 * TELEGRAM_BOT_TOKEN stays as a fallback for a deployment that would rather
 * inject it as a secret; whatever is in the database wins.
 * ------------------------------------------------------------------ */

export async function getBotToken() {
  return (await getMeta('telegram_bot_token')) || TELEGRAM_BOT_TOKEN || null;
}

/** Never returns the token — only a masked preview and where it came from. */
export async function botTokenInfo() {
  const stored = await getMeta('telegram_bot_token');
  const token = stored || TELEGRAM_BOT_TOKEN || null;
  if (!token) return { present: false, fromEnv: false };
  return {
    present: true,
    fromEnv: !stored && Boolean(TELEGRAM_BOT_TOKEN),
    savedAt: (await getMeta('telegram_bot_token_saved_at')) || null,
    // A bot token is "<bot id>:<secret>". The id half is not sensitive and is
    // the useful part for recognising which bot this is.
    preview: `${token.split(':')[0]}:${'•'.repeat(6)}${token.slice(-4)}`,
  };
}

/**
 * Verify a pasted token against getMe before storing it, so a typo is caught
 * at the moment of pasting rather than silently at 3am when an alarm fires.
 */
export async function setBotToken(token) {
  const trimmed = String(token || '').trim();

  if (!trimmed) {
    await setMeta('telegram_bot_token', '');
    await setMeta('telegram_bot_token_saved_at', '');
    await setMeta('telegram_update_offset', '0');
    return { cleared: true };
  }

  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    throw new NotifyError(
      'That does not look like a bot token. @BotFather gives you something like 123456789:AAH... — copy the whole line.',
      'MALFORMED',
    );
  }

  let me;
  try {
    me = await getBot({ token: trimmed, refresh: true });
  } catch (err) {
    throw new NotifyError(
      err.code === 'BAD_BOT_TOKEN'
        ? 'Telegram rejected that token. Check you copied all of it, or send /revoke to @BotFather for a fresh one.'
        : `Could not verify the token with Telegram: ${err.message}`,
      'VERIFY_FAILED',
    );
  }

  // A registered webhook makes getUpdates 409 forever, so pairing would never
  // happen and the only symptom would be "pressing Start does nothing".
  const webhook = await clearWebhookIfSet({ token: trimmed });

  const previous = await getMeta('telegram_bot_token');
  await setMeta('telegram_bot_token', trimmed);
  await setMeta('telegram_bot_token_saved_at', new Date().toISOString());

  // Update ids are numbered per bot, so a cursor from the old bot would make
  // the new one skip real updates. Existing chats belong to the old bot too.
  const swapped = Boolean(previous && previous !== trimmed);
  if (swapped) await setMeta('telegram_update_offset', '0');

  const { n: strandedChats } = swapped
    ? await one('SELECT COUNT(*)::int AS n FROM notify_subscribers')
    : { n: 0 };

  return {
    botUsername: me.username, botName: me.name, swapped, strandedChats,
    webhookRemoved: webhook.had === true,
  };
}

export { ALARM_TRIGGER_TAG };

export async function notifyStatus() {
  const base = {
    testDelaySeconds: TEST_ALARM_DELAY_SECONDS,
    testRingSeconds: Math.round(ALARM_TEST_DURATION_MS / 1000),
    repeats: ALARM_REPEAT,
    ringIntervalSeconds: ALARM_RING_INTERVAL_MS / 1000,
    ringMinutes: Math.round(ALARM_MAX_DURATION_MS / 60_000),
    triggerTag: ALARM_TRIGGER_TAG,
    token: await botTokenInfo(),
  };
  if (!(await botConfigured())) return { ...base, configured: false, botUsername: null };
  try {
    const me = await getBot();
    return { ...base, configured: true, botUsername: me.username, botName: me.name };
  } catch (err) {
    return { ...base, configured: false, botUsername: null, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Subscribers and pairing
 * ------------------------------------------------------------------ */

/** Start pairing: mint a code and the deep link that carries it to the bot. */
export async function createPairing() {
  if (!(await botConfigured())) {
    throw new NotifyError(
      'No Telegram bot is connected yet. Add the bot token in Settings first.',
      'NOT_CONFIGURED',
    );
  }
  const me = await getBot();
  const code = newCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PAIR_CODE_TTL_MS);

  await query(
    'INSERT INTO notify_pairings (code, created_at, expires_at) VALUES ($1,$2,$3)',
    [code, now.toISOString(), expiresAt.toISOString()],
  );
  return {
    code,
    deepLink: `https://t.me/${me.username}?start=${code}`,
    botUsername: me.username,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Browser polls this while the user is off tapping the link. */
export async function pairingStatus(code) {
  const row = await one(
    `SELECT p.code, p.expires_at, p.claimed_at, s.id, s.display_name, s.access_token
       FROM notify_pairings p LEFT JOIN notify_subscribers s ON s.id = p.subscriber_id
      WHERE p.code = $1`,
    [String(code || '')],
  );
  if (!row) throw new NotifyError('That pairing code is unknown — start again.', 'NO_SUCH_CODE');
  if (!row.claimed_at) {
    const expired = new Date(row.expires_at).getTime() < Date.now();
    return { claimed: false, expired };
  }
  return {
    claimed: true,
    expired: false,
    subscriber: {
      id: row.id,
      displayName: row.display_name,
      // Handed over exactly once, when the browser sees its own code claimed.
      accessToken: row.access_token,
    },
  };
}

/** Resolve the bearer secret the browser holds. Returns null when unknown. */
export async function subscriberByToken(token) {
  if (!token) return null;
  const row = await one(
    'SELECT id, chat_id, display_name FROM notify_subscribers WHERE access_token = $1',
    [String(token)],
  );
  if (!row) return null;
  return { id: row.id, chatId: row.chat_id, displayName: row.display_name };
}

async function upsertSubscriber(chatId, displayName) {
  return transact(async (tx) => {
    const existing = await tx.one(
      'SELECT id, chat_id, display_name, access_token FROM notify_subscribers WHERE chat_id = $1',
      [String(chatId)],
    );
    if (existing) {
      await tx.query(
        'UPDATE notify_subscribers SET display_name = $2, last_seen_at = $3 WHERE id = $1',
        [existing.id, displayName || existing.display_name, new Date().toISOString()],
      );
      return existing;
    }
    return tx.one(
      `INSERT INTO notify_subscribers (chat_id, display_name, access_token, created_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$4) RETURNING id, chat_id, display_name, access_token`,
      [String(chatId), displayName || null, newToken(), new Date().toISOString()],
    );
  });
}

/* ------------------------------------------------------------------ *
 * Alerts
 * ------------------------------------------------------------------ */

function rowToAlert(r) {
  return {
    id: r.id,
    fromCity: r.from_city,
    toCity: r.to_city,
    fromLabel: stationLabel(r.from_city),
    toLabel: stationLabel(r.to_city),
    journeyDate: r.journey_date,
    journeyDatePretty: prettyDate(r.journey_date),
    opensAt: isoTimestamp(r.opens_at),
    status: r.status,
    createdAt: isoTimestamp(r.created_at),
    firedAt: isoTimestamp(r.fired_at),
    acknowledgedAt: isoTimestamp(r.acknowledged_at),
    ringsSent: r.rings_sent,
    isTest: r.is_test === true,
    lastError: r.last_error,
    bookingUrl: bookingUrl({ fromCity: r.from_city, toCity: r.to_city, dateISO: r.journey_date }),
  };
}

export async function listAlerts(subscriberId, { includeDone = true } = {}) {
  const rows = await query(
    `SELECT * FROM alerts
      WHERE subscriber_id = $1 ${includeDone ? '' : "AND status = 'active'"}
      ORDER BY (status = 'active') DESC, opens_at ASC LIMIT 50`,
    [subscriberId],
  );
  const alerts = rows.map(rowToAlert);
  // A test alarm is a drill, not one of your three.
  const active = alerts.filter((a) => a.status === 'active' && !a.isTest).length;
  return {
    alerts,
    active,
    limit: MAX_ALERTS_PER_SUBSCRIBER,
    remaining: Math.max(0, MAX_ALERTS_PER_SUBSCRIBER - active),
  };
}

/**
 * Create one alarm.
 *
 * Every rejection here is a real user-facing distinction, not defensive
 * paranoia: a route with no train, a weekday the route does not run, a date
 * already on sale (nothing to wait for), and the 3-alarm cap.
 */
export async function createAlert({ subscriber, fromCity, toCity, dateISO }) {
  if (fromCity === toCity) throw new NotifyError('Origin and destination must be different stations.');

  const plan = await routePlan({ fromCity, toCity, dateISO });

  if (plan.trainsOnRoute === 0) {
    throw new NotifyError(
      `No direct train runs ${plan.from.label} → ${plan.to.label}, so there is no sale to wait for.`,
      'NO_ROUTE',
    );
  }
  if (plan.trainsRunningOnDate === 0) {
    throw new NotifyError(
      `No train runs ${plan.from.label} → ${plan.to.label} on ${plan.datePretty} — it is an off day for every train on this route.`,
      'NO_SERVICE',
    );
  }

  const sale = plan.firstAvailability;
  if (daysBetween(todayISO(), dateISO) < 0) {
    throw new NotifyError(`${plan.datePretty} is in the past.`, 'PAST_DATE');
  }
  if (sale.isOpen) {
    throw new NotifyError(
      `Tickets for ${plan.datePretty} are already on sale — you can book right now, there is nothing to be alarmed about.`,
      'ALREADY_OPEN',
    );
  }

  try {
    const row = await transact(async (tx) => {
      // Counted inside the transaction so two rapid submits cannot both pass.
      const { n } = await tx.one(
        "SELECT COUNT(*)::int AS n FROM alerts WHERE subscriber_id = $1 AND status = 'active' AND is_test = FALSE",
        [subscriber.id],
      );
      if (n >= MAX_ALERTS_PER_SUBSCRIBER) {
        throw new NotifyError(
          `You already have ${n} alarms set, which is the maximum of ${MAX_ALERTS_PER_SUBSCRIBER}. Cancel one first.`,
          'LIMIT_REACHED',
        );
      }
      return tx.one(
        `INSERT INTO alerts (subscriber_id, from_city, to_city, journey_date, opens_at, status, created_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING *`,
        [subscriber.id, fromCity, toCity, dateISO, sale.opensAtISO, new Date().toISOString()],
      );
    });
    return rowToAlert(row);
  } catch (err) {
    if (err.code === '23505') {
      throw new NotifyError('You already have an alarm set for that route and date.', 'DUPLICATE');
    }
    throw err;
  }
}

/**
 * Fire a drill.
 *
 * Deliberately a real row on the real scheduler rather than a direct send: a
 * shortcut would still pass if the scheduler, the claim, or the ring loop were
 * broken, which is exactly what a test is supposed to catch. The only
 * differences are the marker, the wording, and fewer repeats.
 */
export async function sendTestAlarm({ subscriber, fromCity, toCity, dateISO, delaySeconds }) {
  if (!(await botConfigured())) {
    throw new NotifyError('No Telegram bot is connected yet.', 'NOT_CONFIGURED');
  }

  const delay = Math.min(
    Math.max(Number.isFinite(delaySeconds) ? Number(delaySeconds) : TEST_ALARM_DELAY_SECONDS, 0),
    TEST_ALARM_MAX_DELAY_SECONDS,
  );

  // Use whatever route the user was looking at, but never fail the drill over
  // it: a route with no service still proves delivery works.
  let from = fromCity || 'Dhaka';
  let to = toCity || 'Sreemangal';
  let date = dateISO || addDays(todayISO(), ADVANCE_DAYS + 1);
  try {
    const plan = await routePlan({ fromCity: from, toCity: to, dateISO: date });
    if (plan.trainsRunningOnDate === 0) throw new Error('no service');
  } catch {
    from = 'Dhaka';
    to = 'Sreemangal';
    date = addDays(todayISO(), ADVANCE_DAYS + 1);
  }

  const opensAt = new Date(Date.now() + delay * 1000);

  return transact(async (tx) => {
    // One drill at a time — repeated presses replace, never pile up.
    await tx.query(
      "UPDATE alerts SET status = 'cancelled' WHERE subscriber_id = $1 AND status = 'active' AND is_test = TRUE",
      [subscriber.id],
    );
    const row = await tx.one(
      `INSERT INTO alerts (subscriber_id, from_city, to_city, journey_date, opens_at,
                           status, created_at, is_test)
       VALUES ($1,$2,$3,$4,$5,'active',$6,TRUE) RETURNING *`,
      [subscriber.id, from, to, date, opensAt.toISOString(), new Date().toISOString()],
    );
    return { ...rowToAlert(row), delaySeconds: delay };
  });
}

export async function cancelAlert(subscriberId, alertId) {
  const row = await one(
    `UPDATE alerts SET status = 'cancelled'
      WHERE id = $1 AND subscriber_id = $2 AND status = 'active' RETURNING *`,
    [alertId, subscriberId],
  );
  if (!row) throw new NotifyError('No such active alarm.', 'NOT_FOUND');
  return rowToAlert(row);
}

/* ------------------------------------------------------------------ *
 * The alarm message
 * ------------------------------------------------------------------ */

function alarmButtons(alert) {
  return [
    [{ text: '🎫 Book now', url: alert.bookingUrl }],
    [{ text: '✅ Stop alarm', callback_data: `ack:${alert.id}` }],
  ];
}

/**
 * Composed at fire time rather than at creation, so the train list reflects
 * the catalog as it stands when the alarm actually rings.
 */
async function alarmText(alert, { ring, late, test = false }) {
  const plan = await routePlan({
    fromCity: alert.fromCity, toCity: alert.toCity, dateISO: alert.journeyDate,
  });
  const running = plan.trains.filter((t) => t.runsOnDate);
  const lines = running.map((t) =>
    `• <b>${esc(t.trainNumber)}</b> ${esc(t.trainName.replace(/\s*\(\d+\)\s*$/, ''))}` +
    ` — ${esc(t.departureTime || '??')} → ${esc(t.arrivalTime || '??')}`);

  // Ringing is time-boxed, not counted, so tell the user how long is left
  // rather than a ring number that means nothing to them.
  const windowMs = test ? ALARM_TEST_DURATION_MS : ALARM_MAX_DURATION_MS;
  const leftMin = Math.max(0, Math.ceil((windowMs - (ring - 1) * ALARM_RING_INTERVAL_MS) / 60_000));
  const repeated = ALARM_REPEAT && ring > 1;
  const head = test
    ? (repeated ? `🔔 <b>TEST ALARM — still ringing (${ring})</b>` : '🔔🔔 <b>TEST ALARM</b> 🔔🔔')
    : (repeated ? `🚨 <b>STILL OPEN — ringing (${ring})</b>` : '🚨🚨 <b>TICKETS ARE OPEN NOW</b> 🚨🚨');

  return [
    head,
    '',
    test ? '<i>A drill you started from the website. No tickets have opened.</i>\n' : null,
    `<b>${esc(alert.fromLabel)} → ${esc(alert.toLabel)}</b>`,
    `Journey date: <b>${esc(alert.journeyDatePretty)}</b>`,
    '',
    test
      ? 'This is exactly what a real alarm looks like, and it reached you the same way. Tap "Stop alarm" below to confirm that works too.'
      : late
        ? '⚠️ This alarm is late — the server was not running at the exact opening moment. Seats may already be moving.'
        : `Booking opened this second, ${ADVANCE_DAYS} days ahead. Popular trains sell out in minutes.`,
    '',
    running.length ? `<b>${running.length} train${running.length === 1 ? '' : 's'} run that day:</b>` : '',
    ...lines,
    '',
    ALARM_REPEAT
      ? `<i>Ringing every ${ALARM_RING_INTERVAL_MS / 1000}s until you tap “Stop alarm”` +
        `${leftMin ? ` — about ${leftMin} min left` : ''}.</i>`
      : '<i>Sent once. If your phone is set up to ring on this message, stop it there.</i>',
    // Never remove or reword: phone automations match on this exact token to
    // start a real alarm. See ALARM_TRIGGER_TAG in config.js.
    ALARM_TRIGGER_TAG,
  ].filter((l) => l !== null).join('\n');
}

/* ------------------------------------------------------------------ *
 * Telegram command handling
 * ------------------------------------------------------------------ */

const HELP = [
  '👋 This bot rings you the moment Bangladesh Railway opens ticket sales for a journey date you are waiting on.',
  '',
  'Not connected yet? Open the <b>Alarms</b> panel on the website, press',
  '<b>Connect Telegram</b>, and paste the 8-character code here.',
  '',
  '<b>Commands</b>',
  '/alerts — list your pending alarms',
  '/stop — cancel all of them',
].join('\n');

async function handleStart(msg, payload, log) {
  const chatId = msg.chat.id;
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
    || msg.from?.username || null;
  const subscriber = await upsertSubscriber(chatId, name);

  if (!payload) {
    // Reached by pressing START with no deep-link payload — common when the
    // chat already existed. Ask for the code rather than leaving them stuck.
    await sendMessage(chatId, [
      '👋 <b>Bangladesh Railway sale alarms.</b>',
      '',
      'To connect this chat, open the <b>Alarms</b> panel on the website, press',
      '<b>Connect Telegram</b>, and send me the 8-character code it shows.',
      '',
      'You can just paste the code here on its own — no command needed.',
    ].join('\n'));
    return;
  }

  const pairing = await one(
    'SELECT code, expires_at, claimed_at FROM notify_pairings WHERE code = $1',
    [payload],
  );
  if (!pairing) {
    await sendMessage(chatId, [
      '⚠️ <b>That code is not recognised.</b>',
      '',
      'Codes last 15 minutes. Open the website, press <b>Connect Telegram</b>',
      'for a fresh one, and paste it here.',
    ].join('\n'));
    return;
  }
  if (pairing.claimed_at) {
    await sendMessage(chatId, '✅ Already connected. Head back to the website — you can set alarms now.');
    return;
  }
  if (new Date(pairing.expires_at).getTime() < Date.now()) {
    await sendMessage(chatId, '⌛ That connection link has expired. Press <b>Connect Telegram</b> on the website for a fresh one.');
    return;
  }

  await query(
    'UPDATE notify_pairings SET subscriber_id = $2, claimed_at = $3 WHERE code = $1',
    [payload, subscriber.id, new Date().toISOString()],
  );
  log(`telegram: paired chat ${chatId}${name ? ` (${name})` : ''}`);
  await sendMessage(chatId, [
    `✅ <b>Connected${name ? `, ${esc(name)}` : ''}.</b>`,
    '',
    `Go back to the website and set up to ${MAX_ALERTS_PER_SUBSCRIBER} alarms.`,
    'When a sale opens, this chat will ring.',
  ].join('\n'));
}

async function handleListCommand(chatId) {
  const sub = await one('SELECT id FROM notify_subscribers WHERE chat_id = $1', [String(chatId)]);
  if (!sub) return sendMessage(chatId, 'You have no alarms set. Set them on the website.');

  const { alerts, remaining } = await listAlerts(sub.id, { includeDone: false });
  if (!alerts.length) return sendMessage(chatId, 'No pending alarms. Set them on the website.');

  const lines = alerts.map((a) => {
    const mins = Math.round((new Date(a.opensAt).getTime() - Date.now()) / 60000);
    const when = mins > 1440 ? `in ${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
      : mins > 60 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : `in ${Math.max(0, mins)}m`;
    return `• <b>${esc(a.fromLabel)} → ${esc(a.toLabel)}</b> on ${esc(a.journeyDatePretty)}\n  opens ${when}`;
  });
  return sendMessage(chatId, [
    `<b>${alerts.length} pending alarm${alerts.length === 1 ? '' : 's'}</b> (${remaining} slot${remaining === 1 ? '' : 's'} free)`,
    '', ...lines,
  ].join('\n'));
}

async function handleStopCommand(chatId) {
  const sub = await one('SELECT id FROM notify_subscribers WHERE chat_id = $1', [String(chatId)]);
  if (!sub) return sendMessage(chatId, 'Nothing to cancel.');
  const rows = await query(
    "UPDATE alerts SET status = 'cancelled' WHERE subscriber_id = $1 AND status = 'active' RETURNING id",
    [sub.id],
  );
  // Also silence anything mid-ring.
  await query(
    "UPDATE alerts SET acknowledged_at = now() WHERE subscriber_id = $1 AND status = 'fired' AND acknowledged_at IS NULL",
    [sub.id],
  );
  return sendMessage(chatId, rows.length
    ? `🛑 Cancelled ${rows.length} alarm${rows.length === 1 ? '' : 's'}.`
    : '🛑 No pending alarms — anything still ringing is now silenced.');
}

/** Pairing codes are 8 hex characters — see newCode(). */
const CODE_RE = /^[0-9a-f]{8}$/i;

function makeMessageHandler(log) {
  return async (msg) => {
    if (!msg.chat?.id || typeof msg.text !== 'string') return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const [cmd, ...rest] = text.split(/\s+/);
    const command = cmd.toLowerCase().split('@')[0];

    if (command === '/start') return handleStart(msg, rest[0] || null, log);
    if (command === '/alerts' || command === '/list') return handleListCommand(chatId);
    if (command === '/stop' || command === '/cancel') return handleStopCommand(chatId);

    // Telegram only offers the START button on a chat you have never opened.
    // Once you have, the t.me deep link just opens the conversation and the
    // payload is never delivered — so accept the bare code as well.
    if (CODE_RE.test(text)) return handleStart(msg, text.toLowerCase(), log);

    return sendMessage(chatId, HELP);
  };
}

function makeCallbackHandler(log) {
  return async (cq) => {
    const data = String(cq.data || '');
    if (!data.startsWith('ack:')) return answerCallback(cq.id);

    const id = Number(data.slice(4));
    const chatId = cq.message?.chat?.id;
    // Scoped by chat so an ack can only silence the recipient's own alarm.
    const row = await one(
      `UPDATE alerts a SET acknowledged_at = now()
         FROM notify_subscribers s
        WHERE a.id = $1 AND a.subscriber_id = s.id AND s.chat_id = $2
          AND a.acknowledged_at IS NULL
        RETURNING a.id, a.from_city, a.to_city, a.journey_date, a.is_test`,
      [id, String(chatId)],
    );
    await answerCallback(cq.id, row ? 'Alarm silenced 🔕' : 'Already silenced');
    if (!row) return;

    log(`telegram: alarm ${id} acknowledged`);
    // Leave the message on screen but visibly stopped, and drop the ringing
    // button so a second tap cannot look like it failed.
    const alert = rowToAlert({ ...row, journey_date: row.journey_date });
    await editMessageText(chatId, cq.message?.message_id, [
      '🔕 <b>Alarm stopped.</b>',
      '',
      `<b>${esc(alert.fromLabel)} → ${esc(alert.toLabel)}</b>`,
      `Journey date: <b>${esc(alert.journeyDatePretty)}</b>`,
      '',
      row.is_test
        ? 'That was a drill — the real one behaves exactly the same way.'
        : 'Tickets are on sale now. Book before they go.',
    ].join('\n'), {
      buttons: row.is_test ? null : [[{ text: '🎫 Book now', url: alert.bookingUrl }]],
    });
  };
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

/**
 * Send one ring and record it.
 *
 * The previous ring is deleted immediately after the new one lands: a fresh
 * message is what makes the phone sound, but leaving them all behind would
 * bury the chat in a hundred duplicates. Delete after, never before, so a
 * failed send never leaves the user with nothing on screen.
 */
async function ring(alertRow, { ring: ringNo, late }, log) {
  const alert = rowToAlert(alertRow);
  const test = alert.isTest;
  const chat = await one(
    'SELECT chat_id FROM notify_subscribers WHERE id = $1', [alertRow.subscriber_id],
  );
  if (!chat) throw new Error(`alert ${alert.id} has no subscriber`);

  const text = await alarmText(alert, { ring: ringNo, late, test });
  const previousMessageId = alertRow.last_message_id;

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const msg = await sendMessage(chat.chat_id, text, { buttons: alarmButtons(alert) });
      await query(
        'UPDATE alerts SET rings_sent = $2, last_message_id = $3, last_error = NULL WHERE id = $1',
        [alert.id, ringNo, msg?.message_id ?? null],
      );
      if (previousMessageId) await deleteMessage(chat.chat_id, previousMessageId);
      if (ringNo === 1 || ringNo % 6 === 0) {
        log(`alarm: ${test ? 'TEST ' : ''}ringing ${alert.fromLabel} → ${alert.toLabel} ${alert.journeyDate} (ring ${ringNo}${late ? ', late' : ''})`);
      }
      return true;
    } catch (err) {
      lastErr = err;
      if (err.code === 'BLOCKED' || err.code === 'NOT_CONFIGURED') break; // Retrying cannot help.
      await new Promise((r) => setTimeout(r, attempt * 2_000));
    }
  }
  await query('UPDATE alerts SET last_error = $2 WHERE id = $1', [alert.id, lastErr?.message || 'send failed']);
  throw lastErr || new Error('send failed');
}

/** Ring loops currently running in this process, so none is ever doubled. */
const ringing = new Set();

/**
 * Only these mean "stop trying". A timeout or a network blip is exactly the
 * moment an alarm must NOT give up: Telegram can be slow, and the ring loop is
 * already coming back in ten seconds.
 */
const PERMANENT = new Set(['BLOCKED', 'NOT_CONFIGURED', 'BAD_BOT_TOKEN']);
const isPermanent = (err) => PERMANENT.has(err?.code);

function ringWindowMs(row) {
  return row.is_test ? ALARM_TEST_DURATION_MS : ALARM_MAX_DURATION_MS;
}

/**
 * Keep trying until the alarm has been delivered.
 *
 * With ALARM_REPEAT off this exits as soon as one message is through; it exists
 * so a Telegram timeout on the first attempt does not silently lose the alarm.
 * With ALARM_REPEAT on it keeps ringing until acknowledged instead.
 *
 * Driven by its own timer rather than the 15-second scan; the scan is only the
 * recovery path after a restart.
 */
function startRingLoop(alertId, log) {
  if (ringing.has(alertId)) return;
  ringing.add(alertId);

  const tick = async () => {
    let row;
    try {
      row = await one('SELECT * FROM alerts WHERE id = $1', [alertId]);
    } catch (err) {
      log(`alarm: ring loop lost the database — ${err.message}`);
      ringing.delete(alertId);
      return;
    }

    // Every reason to stop, in one place.
    if (!row || row.status !== 'fired' || row.acknowledged_at) { ringing.delete(alertId); return; }
    // One message is the whole job unless repeating is deliberately enabled.
    if (!ALARM_REPEAT && row.rings_sent >= 1) { ringing.delete(alertId); return; }
    const elapsed = Date.now() - new Date(row.fired_at).getTime();
    if (elapsed > ringWindowMs(row) || row.rings_sent >= ALARM_MAX_RINGS) {
      ringing.delete(alertId);
      log(`alarm: gave up ringing alert ${alertId} after ${Math.round(elapsed / 1000)}s unacknowledged`);
      return;
    }

    try {
      await ring(row, { ring: row.rings_sent + 1, late: false }, log);
    } catch (err) {
      if (isPermanent(err)) {
        log(`alarm: giving up on ${alertId} — ${err.message}`);
        await query("UPDATE alerts SET status = 'failed' WHERE id = $1", [alertId]);
        ringing.delete(alertId);
        return;
      }
      // Transient: keep the loop alive and try again on the next tick.
      log(`alarm: ring ${row.rings_sent + 1} failed for ${alertId}, retrying — ${err.message}`);
    }
    const timer = setTimeout(tick, ALARM_RING_INTERVAL_MS);
    timer.unref?.();
  };

  const timer = setTimeout(tick, ALARM_RING_INTERVAL_MS);
  timer.unref?.();
}

/** Claim + fire. The UPDATE ... WHERE status='active' is the claim. */
async function fire(alertId, log) {
  const row = await one(
    `UPDATE alerts SET status = 'fired', fired_at = now()
      WHERE id = $1 AND status = 'active' RETURNING *`,
    [alertId],
  );
  if (!row) return; // Cancelled, or already claimed by this process.

  const late = !row.is_test && Date.now() - new Date(row.opens_at).getTime() > 30_000;
  try {
    await ring(row, { ring: 1, late }, log);
  } catch (err) {
    if (isPermanent(err)) {
      await query("UPDATE alerts SET status = 'failed' WHERE id = $1", [alertId]);
      log(`alarm: FAILED for alert ${alertId} — ${err.message}`);
      return;
    }
    // Telegram was slow or unreachable this second. The alarm is still live;
    // the loop below retries every few seconds inside the window.
    log(`alarm: first ring failed for ${alertId}, will keep trying — ${err.message}`);
    startRingLoop(alertId, log);
    return;
  }
  // Delivered. Only keep a loop running if repeats are actually wanted.
  if (ALARM_REPEAT) startRingLoop(alertId, log);
}

/**
 * Scan loop. Arms a precise timer for anything due shortly, continues
 * unacknowledged ring cycles (which is also how rings survive a restart), and
 * retires alerts whose journey date has passed.
 */
export function startAlertScheduler({ log = console.log } = {}) {
  const armed = new Map();
  let stopped = false;

  async function scan() {
    // A date that has come and gone can never open — retire it either way.
    await query(
      "UPDATE alerts SET status = 'expired' WHERE status = 'active' AND journey_date < $1",
      [todayISO()],
    );
    // Drills are transient; keep a day's worth for the UI, then drop them.
    await query("DELETE FROM alerts WHERE is_test = TRUE AND created_at < now() - INTERVAL '1 day'");

    // With no bot connected there is nothing to ring. Alarms stay pending
    // rather than failing, so connecting a bot later still honours them.
    if (!(await botConfigured())) return;

    const cutoff = new Date(Date.now() + SCHEDULER_LOOKAHEAD_MS).toISOString();
    const due = await query(
      "SELECT id, opens_at FROM alerts WHERE status = 'active' AND opens_at <= $1 ORDER BY opens_at LIMIT 100",
      [cutoff],
    );
    for (const r of due) {
      if (armed.has(r.id)) continue;
      const delay = Math.max(0, new Date(r.opens_at).getTime() - Date.now());
      const timer = setTimeout(() => {
        armed.delete(r.id);
        fire(r.id, log).catch((e) => log(`alarm: fire failed — ${e.message}`));
      }, delay);
      timer.unref?.();
      armed.set(r.id, timer);
    }

    // Revive ring loops that a restart interrupted. The loop itself owns the
    // cadence; this only makes sure one exists for every still-ringing alarm.
    const unacked = await query(
      `SELECT id, fired_at, is_test FROM alerts
        WHERE status = 'fired' AND acknowledged_at IS NULL
          AND rings_sent < $1
          AND fired_at > now() - INTERVAL '1 hour'`,
      [ALARM_REPEAT ? ALARM_MAX_RINGS : 1],
    );
    for (const r of unacked) {
      const elapsed = Date.now() - new Date(r.fired_at).getTime();
      if (elapsed <= ringWindowMs(r)) startRingLoop(r.id, log);
    }
  }

  (async () => {
    while (!stopped) {
      try { await scan(); } catch (err) { log(`alarm scheduler: ${err.message}`); }
      await new Promise((r) => setTimeout(r, SCHEDULER_SCAN_MS));
    }
  })();

  log(`alarm scheduler: running (scan ${SCHEDULER_SCAN_MS / 1000}s, ` +
    (ALARM_REPEAT
      ? `rings every ${ALARM_RING_INTERVAL_MS / 1000}s until acknowledged)`
      : 'one message per alarm)'));
  return { stop() { stopped = true; for (const t of armed.values()) clearTimeout(t); } };
}

/** Boot both halves: the update listener and the scheduler. */
export function startNotifications({ log = console.log } = {}) {
  // Read fresh every time: the token can be saved or replaced from the UI
  // while the server runs, and both loops below must see the change at once.
  setBotTokenProvider(getBotToken);

  const listener = startTelegramListener({
    getOffset: () => getMeta('telegram_update_offset', '0'),
    setOffset: (v) => setMeta('telegram_update_offset', v),
    onMessage: makeMessageHandler(log),
    onCallback: makeCallbackHandler(log),
    log,
  });
  const scheduler = startAlertScheduler({ log });
  return { stop() { listener.stop(); scheduler.stop(); } };
}
