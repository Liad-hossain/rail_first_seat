/**
 * Sale-open alarms.
 *
 * The two things worth proving are the ones a user would actually be hurt by:
 * that the validation rules hold (you cannot alarm a date that is already
 * buyable, and three is really the cap), and that the scheduler fires ON the
 * sale instant rather than up to a scan-interval late.
 *
 * Telegram is mocked, so nothing leaves the machine. The database is real —
 * these paths are almost entirely SQL, and every row is cleaned up after.
 *
 *   node --experimental-test-module-mocks --test test/alarms.test.mjs
 */
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every message the bot would have sent, in order. */
const sent = [];
/** Message ids the bot asked Telegram to remove. */
const deleted = [];
/** Lets a test make the next sends fail, the way a slow network would. */
let sendHook = null;
const failNextSends = (fn) => { sendHook = fn; };

mock.module(path.join(SRC, 'telegram.js'), {
  namedExports: {
    botConfigured: async () => true,
    getBot: async () => ({ id: 1, username: 'test_bot', name: 'Test' }),
    sendMessage: async (chatId, text, opts) => {
      if (sendHook) sendHook();
      sent.push({ chatId, text, opts, at: Date.now() });
      return { message_id: 1000 + sent.length };
    },
    answerCallback: async () => null,
    startTelegramListener: () => ({ stop() {} }),
    setBotTokenProvider: () => {},
    clearWebhookIfSet: async () => ({ had: false }),
    deleteMessage: async (chatId, messageId) => { deleted.push(messageId); return true; },
    editMessageText: async () => true,
    esc: (s) => String(s ?? ''),
    TelegramError: class TelegramError extends Error {},
  },
});

const { migrate, query, one, closePool } = await import(path.join(SRC, 'db.js'));
const { addDays, todayISO } = await import(path.join(SRC, 'time.js'));
const notify = await import(path.join(SRC, 'notify.js'));
const { ADVANCE_DAYS, MAX_ALERTS_PER_SUBSCRIBER, ALARM_RING_INTERVAL_MS, ALARM_TRIGGER_TAG } =
  await import(path.join(SRC, 'config.js'));

await migrate();

// A throwaway subscriber, so a real paired chat is never touched.
const chatId = `test-${crypto.randomUUID()}`;
const subscriber = await one(
  `INSERT INTO notify_subscribers (chat_id, display_name, access_token, created_at)
   VALUES ($1,'Test User',$2,now()) RETURNING id, chat_id, display_name`,
  [chatId, crypto.randomUUID()],
);

after(async () => {
  await query('DELETE FROM notify_subscribers WHERE chat_id = $1', [chatId]); // cascades to alerts
  await closePool();
});

/**
 * These tests share one database and one module-level scheduler, and an alarm
 * left ringing by an earlier test is legitimately revived by a later one —
 * correct behaviour that would otherwise show up as flakiness. Retire
 * everything and reset the recording arrays before each test.
 */
beforeEach(async () => {
  await query(
    `UPDATE alerts SET status = 'cancelled'
      WHERE subscriber_id = $1 AND status = 'active'`, [subscriber.id],
  );
  await query(
    `UPDATE alerts SET acknowledged_at = now()
      WHERE subscriber_id = $1 AND acknowledged_at IS NULL`, [subscriber.id],
  );
  sent.length = 0;
  deleted.length = 0;
  failNextSends(null);
});

/** A date far enough out that its sale has definitely not opened. */
const futureDate = (n = 5) => addDays(todayISO(), ADVANCE_DAYS + n);

test('refuses a date whose sale is already open', async () => {
  await assert.rejects(
    () => notify.createAlert({
      subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: todayISO(),
    }),
    (err) => err.code === 'ALREADY_OPEN',
    'today is buyable now, so there is nothing to alarm on',
  );
});

test('refuses a route with no direct train', async () => {
  await assert.rejects(
    () => notify.createAlert({
      subscriber, fromCity: 'Sreemangal', toCity: 'Rajshahi', dateISO: futureDate(),
    }),
    (err) => err.code === 'NO_ROUTE' || err.code === 'NO_SERVICE',
  );
});

test('freezes the sale instant at midnight Dhaka, ADVANCE_DAYS ahead', async () => {
  const date = futureDate(3);
  const alert = await notify.createAlert({
    subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: date,
  });

  const opens = new Date(alert.opensAt);
  const inDhaka = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(opens);
  const get = (t) => inDhaka.find((p) => p.type === t).value;

  assert.equal(`${get('year')}-${get('month')}-${get('day')}`, addDays(date, -ADVANCE_DAYS));
  assert.equal(`${get('hour')}:${get('minute')}`, '00:00', 'opens at Dhaka midnight');

  await notify.cancelAlert(subscriber.id, alert.id);
});

test(`caps at ${MAX_ALERTS_PER_SUBSCRIBER} active alarms and frees a slot on cancel`, async () => {
  const made = [];
  for (let i = 0; i < MAX_ALERTS_PER_SUBSCRIBER; i++) {
    made.push(await notify.createAlert({
      subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: futureDate(10 + i),
    }));
  }

  const full = await notify.listAlerts(subscriber.id);
  assert.equal(full.active, MAX_ALERTS_PER_SUBSCRIBER);
  assert.equal(full.remaining, 0);

  await assert.rejects(
    () => notify.createAlert({
      subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: futureDate(99),
    }),
    (err) => err.code === 'LIMIT_REACHED',
  );

  // The same route+date twice is a duplicate, not a second slot.
  await assert.rejects(
    () => notify.createAlert({
      subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: futureDate(10),
    }),
    (err) => err.code === 'LIMIT_REACHED' || err.code === 'DUPLICATE',
  );

  await notify.cancelAlert(subscriber.id, made[0].id);
  const after1 = await notify.listAlerts(subscriber.id);
  assert.equal(after1.active, MAX_ALERTS_PER_SUBSCRIBER - 1);
  assert.equal(after1.remaining, 1);

  for (const a of made.slice(1)) await notify.cancelAlert(subscriber.id, a.id);
});

test('fires ON the sale instant, not on the next scan tick', async () => {
  sent.length = 0;

  // Backdate a real alert's opens_at to a few seconds out. The scheduler scans
  // every 15s but arms a precise timer, so a target inside that gap is exactly
  // the case that would expose a lazy implementation.
  const alert = await notify.createAlert({
    subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: futureDate(20),
  });
  const target = Date.now() + 3_000;
  await query('UPDATE alerts SET opens_at = $2 WHERE id = $1', [alert.id, new Date(target).toISOString()]);

  const scheduler = notify.startAlertScheduler({ log: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 6_000));
  } finally {
    scheduler.stop();
  }

  assert.equal(sent.length, 1, 'rang exactly once');
  const drift = sent[0].at - target;
  assert.ok(Math.abs(drift) < 750, `fired within 750ms of the instant (drift ${drift}ms)`);

  assert.equal(sent[0].chatId, chatId);
  assert.match(sent[0].text, /TICKETS ARE OPEN NOW/);
  assert.match(sent[0].text, /Sreemangal/);
  assert.ok(sent[0].opts.buttons.flat().some((b) => b.url), 'carries a Book now link');
  assert.ok(sent[0].opts.buttons.flat().some((b) => b.callback_data === `ack:${alert.id}`),
    'carries a Stop alarm button scoped to this alert');

  const row = await one('SELECT status, rings_sent FROM alerts WHERE id = $1', [alert.id]);
  assert.equal(row.status, 'fired');
  assert.equal(row.rings_sent, 1);

  // Silence it, or the next scheduler to start will legitimately resume it.
  await query('UPDATE alerts SET acknowledged_at = now() WHERE id = $1', [alert.id]);
});

test('a test alarm is a drill, not one of the three slots', async () => {
  // Fill every real slot first: a drill must still be possible.
  const real = [];
  for (let i = 0; i < MAX_ALERTS_PER_SUBSCRIBER; i++) {
    real.push(await notify.createAlert({
      subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: futureDate(30 + i),
    }));
  }

  const drill = await notify.sendTestAlarm({ subscriber, delaySeconds: 2 });
  assert.equal(drill.isTest, true);
  assert.equal(drill.delaySeconds, 2);

  const list = await notify.listAlerts(subscriber.id);
  assert.equal(list.active, MAX_ALERTS_PER_SUBSCRIBER, 'drill not counted');
  assert.equal(list.remaining, 0);
  assert.ok(list.alerts.some((a) => a.isTest && a.status === 'active'), 'drill is visible');

  for (const a of real) await notify.cancelAlert(subscriber.id, a.id);
  await notify.cancelAlert(subscriber.id, drill.id);
});

test('pressing test twice replaces the pending drill rather than stacking', async () => {
  const first = await notify.sendTestAlarm({ subscriber, delaySeconds: 120 });
  const second = await notify.sendTestAlarm({ subscriber, delaySeconds: 120 });
  assert.notEqual(first.id, second.id);

  const rows = await query(
    "SELECT id FROM alerts WHERE subscriber_id = $1 AND status = 'active' AND is_test = TRUE",
    [subscriber.id],
  );
  assert.equal(rows.length, 1, 'only the newest drill is pending');
  assert.equal(rows[0].id, second.id);
  await notify.cancelAlert(subscriber.id, second.id);
});

test('the drill travels the real scheduler and is labelled a test', async () => {
  sent.length = 0;
  const drill = await notify.sendTestAlarm({ subscriber, delaySeconds: 2 });

  const scheduler = notify.startAlertScheduler({ log: () => {} });
  try { await new Promise((r) => setTimeout(r, 5_000)); } finally { scheduler.stop(); }

  assert.equal(sent.length, 1, 'rang once');
  assert.match(sent[0].text, /TEST ALARM/, 'unmistakably a drill');
  assert.match(sent[0].text, /No tickets have opened/, 'says so in words');
  assert.doesNotMatch(sent[0].text, /TICKETS ARE OPEN NOW/, 'cannot be mistaken for the real thing');
  assert.ok(sent[0].opts.buttons.flat().some((b) => b.callback_data === `ack:${drill.id}`),
    'Stop alarm button works on a drill too, which is half the point');

  // It went through fire(): claimed, marked, counted — the real path.
  const row = await one('SELECT status, rings_sent, is_test FROM alerts WHERE id = $1', [drill.id]);
  assert.equal(row.status, 'fired');
  assert.equal(row.rings_sent, 1);
  assert.equal(row.is_test, true);
  await query("UPDATE alerts SET acknowledged_at = now() WHERE id = $1", [drill.id]);
});

test('sends exactly one message per alarm', async () => {

  // Any alarm still ringing from an earlier test would be revived by the
  // scheduler below — correct behaviour, but it would muddle the cadence.
  await query(
    'UPDATE alerts SET acknowledged_at = now() WHERE subscriber_id = $1 AND acknowledged_at IS NULL',
    [subscriber.id],
  );

  sent.length = 0;
  deleted.length = 0;
  const drill = await notify.sendTestAlarm({ subscriber, delaySeconds: 1 });
  const mine = () => sent.filter((m) =>
    m.opts.buttons.flat().some((b) => b.callback_data === `ack:${drill.id}`));

  const scheduler = notify.startAlertScheduler({ log: () => {} });
  try {
    // Long enough for the first ring plus at least two repeats.
    await new Promise((r) => setTimeout(r, 2_000 + ALARM_RING_INTERVAL_MS * 2 + 1_500));
  } finally { scheduler.stop(); }

  // Waited well past several repeat intervals: there must still be just one.
  assert.equal(mine().length, 1, `exactly one message (got ${mine().length})`);
  assert.equal(deleted.length, 0, 'nothing to delete when nothing is superseded');

  const row = await one('SELECT rings_sent FROM alerts WHERE id = $1', [drill.id]);
  assert.equal(row.rings_sent, 1);

  // And it stays one, even with the scheduler still running.
  const s2 = notify.startAlertScheduler({ log: () => {} });
  try { await new Promise((r) => setTimeout(r, ALARM_RING_INTERVAL_MS * 2)); } finally { s2.stop(); }
  assert.equal(mine().length, 1, 'still one after further scans');

  await query('UPDATE alerts SET acknowledged_at = now() WHERE id = $1', [drill.id]);
});

test('a slow Telegram does not kill the alarm — it keeps trying', async () => {
  await query(
    'UPDATE alerts SET acknowledged_at = now() WHERE subscriber_id = $1 AND acknowledged_at IS NULL',
    [subscriber.id],
  );
  sent.length = 0;

  // Exactly the failure the user hit: sendMessage times out, twice.
  let failuresLeft = 2;
  failNextSends(() => {
    if (failuresLeft-- > 0) {
      const e = new Error('Telegram did not respond in time (sendMessage)');
      e.code = 'TIMEOUT';
      throw e;
    }
  });

  const drill = await notify.sendTestAlarm({ subscriber, delaySeconds: 1 });
  const scheduler = notify.startAlertScheduler({ log: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 2_000 + ALARM_RING_INTERVAL_MS * 2 + 1_500));
  } finally { scheduler.stop(); failNextSends(null); }

  const row = await one('SELECT status, rings_sent FROM alerts WHERE id = $1', [drill.id]);
  assert.notEqual(row.status, 'failed', 'a timeout must not retire the alarm');
  assert.equal(row.rings_sent, 1, 'delivered once, despite two failed attempts');

  const delivered = sent.filter((m) =>
    m.opts.buttons.flat().some((b) => b.callback_data === `ack:${drill.id}`));
  assert.equal(delivered.length, 1, 'retrying must not produce duplicate messages');

  await query('UPDATE alerts SET acknowledged_at = now() WHERE id = $1', [drill.id]);
});

test('every alarm carries the phone-automation trigger tag', async () => {
  await query(
    'UPDATE alerts SET acknowledged_at = now() WHERE subscriber_id = $1 AND acknowledged_at IS NULL',
    [subscriber.id],
  );
  sent.length = 0;

  const drill = await notify.sendTestAlarm({ subscriber, delaySeconds: 1 });
  const scheduler = notify.startAlertScheduler({ log: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 2_000 + ALARM_RING_INTERVAL_MS + 1_000));
  } finally { scheduler.stop(); }

  const rings = sent.filter((m) => m.opts.buttons.flat().some((b) => b.callback_data === `ack:${drill.id}`));
  assert.equal(rings.length, 1, 'one message');
  // A drill must carry it too, or the automation cannot be tested without
  // waiting for a real sale.
  assert.ok(rings.every((m) => m.text.includes(ALARM_TRIGGER_TAG)),
    `every ring contains ${ALARM_TRIGGER_TAG}`);

  await query('UPDATE alerts SET acknowledged_at = now() WHERE id = $1', [drill.id]);
});

test('a real (non-drill) alarm carries it as well', async () => {
  const alert = await notify.createAlert({
    subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: futureDate(60),
  });
  await query('UPDATE alerts SET opens_at = $2 WHERE id = $1',
    [alert.id, new Date(Date.now() + 1_500).toISOString()]);

  sent.length = 0;
  const scheduler = notify.startAlertScheduler({ log: () => {} });
  try { await new Promise((r) => setTimeout(r, 4_000)); } finally { scheduler.stop(); }

  const ring = sent.find((m) => m.opts.buttons.flat().some((b) => b.callback_data === `ack:${alert.id}`));
  assert.ok(ring, 'the real alarm rang');
  assert.ok(ring.text.includes(ALARM_TRIGGER_TAG), 'tag present');
  assert.match(ring.text, /TICKETS ARE OPEN NOW/);

  await query('UPDATE alerts SET acknowledged_at = now() WHERE id = $1', [alert.id]);
});
