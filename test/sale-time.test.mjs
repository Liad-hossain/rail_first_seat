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
const realShohoz = await import(path.join(SRC, 'shohoz.js'));
mock.module(path.join(SRC, 'shohoz.js'), {
  namedExports: {
    ...realShohoz,
    searchTrips: async () => ({
      trains: liveSeats > 0
        ? [{
            trip_number: 'TEST-1', train_model: '709',
            departure_date_time: '2026-01-01T08:00:00', arrival_date_time: '2026-01-01T12:00:00',
            seat_types: [{ type: 'S_CHAIR', seat_counts: { online: liveSeats, offline: 0 }, fare: '100', vat_amount: '0' }],
          }]
        : [],
    }),
  },
});

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
const history = await import(path.join(SRC, 'history.js'));
const {
  ADVANCE_DAYS, SALE_OPEN_TIME, SALE_OPEN_TIME_KEY, SALE_OPEN_EVIDENCE_KEY,
  SALE_OPEN_PENDING_KEY,
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
const savedPending = await getMeta(SALE_OPEN_PENDING_KEY);

after(async () => {
  await setMeta(SALE_OPEN_TIME_KEY, savedTime || '');
  await setMeta(SALE_OPEN_EVIDENCE_KEY, savedEvidence || '');
  await setMeta(SALE_OPEN_PENDING_KEY, savedPending || '');
  await query('DELETE FROM notify_subscribers WHERE chat_id = $1', [chatId]);
  await closePool();
});

beforeEach(async () => {
  await query("UPDATE alerts SET status = 'cancelled' WHERE subscriber_id = $1 AND status = 'active'",
    [subscriber.id]);
  await setMeta(SALE_OPEN_TIME_KEY, '');
  await setMeta(SALE_OPEN_EVIDENCE_KEY, '');
  await setMeta(SALE_OPEN_PENDING_KEY, '');
  liveSeats = 0;
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

/** A properly bracketed measurement, as probeSaleRelease() would leave it. */
async function storeMeasurement(time, { widthMs = 45_000 } = {}) {
  const seenAt = new Date();
  await setMeta(SALE_OPEN_TIME_KEY, time);
  await setMeta(SALE_OPEN_EVIDENCE_KEY, JSON.stringify({
    observedOn: todayISO(),
    journeyDate: addDays(todayISO(), ADVANCE_DAYS),
    route: 'Dhaka > Sreemangal',
    absentAt: new Date(seenAt.getTime() - widthMs).toISOString(),
    absentAtDhaka: '07:59:15',
    seenAt: seenAt.toISOString(),
    seenAtDhaka: time,
    onlineSeats: 5,
    resolutionMs: widthMs,
  }));
}

test('a measured time overrides the default', async () => {
  await storeMeasurement('09:30:00');
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
  await storeMeasurement('not-a-time');
  availability.__resetSaleTimeCache?.();
  assert.equal(await availability.effectiveSaleOpenTime(), SALE_OPEN_TIME);
});

test('a time with no bracket behind it is refused on READ, not just on write', async () => {
  // Exactly what an older build of this app, still deployed against the same
  // database, keeps writing: a first sighting with no "still closed" end.
  await setMeta(SALE_OPEN_TIME_KEY, '09:48:00');
  await setMeta(SALE_OPEN_EVIDENCE_KEY, JSON.stringify({
    observedOn: todayISO(),
    journeyDate: addDays(todayISO(), ADVANCE_DAYS),
    route: 'Dhaka > Sreemangal',
    seenAt: new Date().toISOString(),
    seenAtDhaka: '09:48:08',
    onlineSeats: 10,
    resolutionMs: 60_000,
  }));
  availability.__resetSaleTimeCache?.();

  assert.equal(await availability.effectiveSaleOpenTime(), SALE_OPEN_TIME,
    'the documented default wins over an unbracketed value');
  assert.equal(availability.saleOpenTimeSource(), 'default');
});

test('a bracket too wide to name a minute is refused on read as well', async () => {
  await storeMeasurement('09:48:00', { widthMs: 3 * 60 * 60 * 1000 });
  availability.__resetSaleTimeCache?.();
  assert.equal(await availability.effectiveSaleOpenTime(), SALE_OPEN_TIME);
  assert.equal(availability.saleOpenTimeSource(), 'default');
});

test('alarms already scheduled are re-timed when the release time moves', async () => {
  const date = addDays(todayISO(), ADVANCE_DAYS + 6);
  const alert = await notify.createAlert({
    subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: date,
  });
  assert.equal(dhakaClock(alert.opensAt), SALE_OPEN_TIME.slice(0, 5));

  // A measurement lands: every pending alarm must follow it. It has to be a
  // real, bracketed one — an unbracketed value is no longer a measurement and
  // would correctly move nothing.
  await storeMeasurement('07:45:00');
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


const probeToken = { token: 'test-token', deviceId: 'd', deviceKey: 'k' };

test('seats already on sale at the first look are NOT a measurement', async () => {
  // No "still closed" sighting has ever been recorded — exactly the state a
  // freshly pasted session token leaves behind.
  liveSeats = 10;
  const res = await history.probeSaleRelease({ token: probeToken });

  assert.equal(res.measured, null, 'nothing measured');
  assert.equal(res.inconclusive, 'no absent sighting today');
  assert.equal(await getMeta(SALE_OPEN_TIME_KEY), '',
    'and crucially the release time is left alone, not overwritten');

  availability.__resetSaleTimeCache?.();
  assert.equal(await availability.effectiveSaleOpenTime(), SALE_OPEN_TIME,
    'so the documented default still governs every route');
  assert.equal(availability.saleOpenTimeSource(), 'default',
    'and the UI is told it is a default, not a measurement');
});

test('closed then open IS a measurement, and records both ends', async () => {
  liveSeats = 0;
  const absent = await history.probeSaleRelease({ token: probeToken });
  assert.equal(absent.seatsYet, false, 'the closed sighting is recorded');

  liveSeats = 7;
  const res = await history.probeSaleRelease({ token: probeToken });

  assert.ok(res.measured, `a measurement was taken (got ${JSON.stringify(res)})`);
  assert.match(res.measured, /^\d{2}:\d{2}:00$/);
  assert.ok(res.observed.absentAt, 'the closed end is kept');
  assert.ok(res.observed.seenAt, 'and the open end');
  assert.ok(res.observed.resolutionMs < 60_000,
    'precision is the real bracket width, not an assumed probe interval');
  assert.equal(await getMeta(SALE_OPEN_TIME_KEY), res.measured);

  const { evidence, inconclusive } = await history.saleReleaseEvidence();
  assert.ok(evidence, 'the UI gets real evidence');
  assert.equal(inconclusive, null);
});

test('a stale closed sighting is too weak to name a minute', async () => {
  // Seen closed, but hours ago — the sale could have opened at any point since.
  await setMeta(SALE_OPEN_PENDING_KEY, JSON.stringify({
    observedOn: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date()),
    journeyDate: addDays(todayISO(), ADVANCE_DAYS),
    route: 'Dhaka > Sreemangal',
    absentAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    absentAtDhaka: '06:00:00',
  }));

  liveSeats = 3;
  const res = await history.probeSaleRelease({ token: probeToken });

  assert.equal(res.measured, null, 'refused');
  assert.equal(res.inconclusive, 'bracket too wide');
  assert.equal(await getMeta(SALE_OPEN_TIME_KEY), '', 'release time untouched');
});
