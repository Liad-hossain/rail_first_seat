/**
 * When seats actually become buyable.
 *
 * Two moments are easy to conflate and we got it wrong in both directions
 * before: the booking WINDOW rolls at Dhaka midnight (the date becomes
 * selectable), but the SEATS are released later that morning. An alarm must
 * fire on the second one — firing at midnight wakes you for an empty page.
 *
 * Because the release time is unpublished and has moved before, it is measured
 * from live seat data rather than hard-coded. These cover the default, the
 * measured override, and the re-timing of alarms already scheduled.
 *
 *   node --experimental-test-module-mocks --test test/sale-time.test.mjs
 */
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

let liveSeats = 0;
mock.module(path.join(SRC, 'telegram.js'), {
  namedExports: {
    botConfigured: async () => true,
    getBot: async () => ({ id: 1, username: 't', name: 'T' }),
    sendMessage: async () => ({ message_id: 1 }),
    answerCallback: async () => null,
    startTelegramListener: () => ({ stop() {} }),
    setBotTokenProvider: () => {},
    clearWebhookIfSet: async () => ({ had: false }),
    setWebhook: async () => true,
    getWebhookInfo: async () => ({ url: '' }),
    deleteMessage: async () => true,
    editMessageText: async () => true,
    esc: (s) => String(s ?? ''),
    TelegramError: class extends Error {},
  },
});

const { migrate, query, one, getMeta, setMeta, closePool } = await import(path.join(SRC, 'db.js'));
const { addDays, todayISO, dhakaToUTC } = await import(path.join(SRC, 'time.js'));
const availability = await import(path.join(SRC, 'availability.js'));
const notify = await import(path.join(SRC, 'notify.js'));
const {
  ADVANCE_DAYS, SALE_OPEN_TIME, SALE_OPEN_TIME_KEY, SALE_OPEN_EVIDENCE_KEY,
} = await import(path.join(SRC, 'config.js'));

await migrate();

const chatId = `saletime-${crypto.randomUUID()}`;
const subscriber = await one(
  `INSERT INTO notify_subscribers (chat_id, display_name, access_token, created_at)
   VALUES ($1,'Sale Time',$2,now()) RETURNING id, chat_id`,
  [chatId, crypto.randomUUID()],
);

// Preserve any real measurement so a test run cannot destroy it.
const savedTime = await getMeta(SALE_OPEN_TIME_KEY);
const savedEvidence = await getMeta(SALE_OPEN_EVIDENCE_KEY);

after(async () => {
  await setMeta(SALE_OPEN_TIME_KEY, savedTime || '');
  await setMeta(SALE_OPEN_EVIDENCE_KEY, savedEvidence || '');
  await query('DELETE FROM notify_subscribers WHERE chat_id = $1', [chatId]);
  await closePool();
});

beforeEach(async () => {
  await query("UPDATE alerts SET status = 'cancelled' WHERE subscriber_id = $1 AND status = 'active'",
    [subscriber.id]);
  await setMeta(SALE_OPEN_TIME_KEY, '');
  await setMeta(SALE_OPEN_EVIDENCE_KEY, '');
  availability.__resetSaleTimeCache?.();
});

/** Read back the Dhaka wall-clock time an instant lands on. */
const dhakaClock = (iso) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso));

test('the default is a morning release, not midnight', () => {
  assert.notEqual(SALE_OPEN_TIME, '00:00:00',
    'midnight is when the date becomes selectable, not when seats exist');
  const [h] = SALE_OPEN_TIME.split(':').map(Number);
  assert.ok(h >= 1 && h <= 12, `expected a morning hour, got ${SALE_OPEN_TIME}`);
});

test('a plan opens on D-10 at the release time, not at midnight', async () => {
  const date = addDays(todayISO(), ADVANCE_DAYS + 4);
  const plan = await availability.routePlan({ fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: date });
  const fa = plan.firstAvailability;

  assert.equal(fa.openDate, addDays(date, -ADVANCE_DAYS), 'still ten days ahead');
  assert.equal(dhakaClock(fa.opensAtISO), SALE_OPEN_TIME.slice(0, 5), 'lands on the release time');
  assert.notEqual(dhakaClock(fa.opensAtISO), '00:00', 'not midnight');
  assert.equal(fa.openTimeSource, 'default');
});

test('a measured time overrides the default', async () => {
  await setMeta(SALE_OPEN_TIME_KEY, '09:30:00');
  availability.__resetSaleTimeCache?.();

  const t = await availability.effectiveSaleOpenTime();
  assert.equal(t, '09:30:00');
  assert.equal(availability.saleOpenTimeSource(), 'measured');

  const date = addDays(todayISO(), ADVANCE_DAYS + 4);
  const plan = await availability.routePlan({ fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: date });
  assert.equal(dhakaClock(plan.firstAvailability.opensAtISO), '09:30');
  assert.equal(plan.firstAvailability.openTimeSource, 'measured');
});

test('a malformed measurement is ignored rather than trusted', async () => {
  await setMeta(SALE_OPEN_TIME_KEY, 'not-a-time');
  availability.__resetSaleTimeCache?.();
  assert.equal(await availability.effectiveSaleOpenTime(), SALE_OPEN_TIME);
});

test('alarms already scheduled are re-timed when the release time moves', async () => {
  const date = addDays(todayISO(), ADVANCE_DAYS + 6);
  const alert = await notify.createAlert({
    subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: date,
  });
  assert.equal(dhakaClock(alert.opensAt), SALE_OPEN_TIME.slice(0, 5));

  // A measurement lands: every pending alarm must follow it.
  await setMeta(SALE_OPEN_TIME_KEY, '07:45:00');
  availability.__resetSaleTimeCache?.();
  const res = await notify.resyncAlertOpenTimes();
  assert.ok(res.moved >= 1, 'at least this alarm moved');

  const row = await one('SELECT opens_at FROM alerts WHERE id = $1', [alert.id]);
  assert.equal(dhakaClock(row.opens_at), '07:45', 're-frozen onto the measured time');
  assert.equal(
    row.opens_at.toISOString?.() ?? new Date(row.opens_at).toISOString(),
    dhakaToUTC(addDays(date, -ADVANCE_DAYS), '07:45:00').toISOString(),
  );

  await notify.cancelAlert(subscriber.id, alert.id);
});

test('re-timing is idempotent', async () => {
  const date = addDays(todayISO(), ADVANCE_DAYS + 7);
  const alert = await notify.createAlert({
    subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: date,
  });
  const first = await notify.resyncAlertOpenTimes();
  const second = await notify.resyncAlertOpenTimes();
  assert.equal(second.moved, 0, 'nothing to move the second time');
  assert.ok(second.checked >= 1);
  await notify.cancelAlert(subscriber.id, alert.id);
  void first;
});
