/**
 * Covers the one path that cannot be exercised against live upstream without a
 * signed-in session: parsing search-trips-v2 and merging its seat counts onto
 * the local catalog. The payload below mirrors the real response shape.
 *
 *   node --experimental-test-module-mocks --test test/
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Realistic search-trips-v2 payload shape.
const PAYLOAD = { trains: [
  { trip_number: 'PARABAT EXPRESS (709)',
    departure_date_time: '01 Sep, 2026 06:30 am', arrival_date_time: '01 Sep, 2026 10:32 am',
    travel_time: '4h 02m', origin_city_name: 'Dhaka', destination_city_name: 'Sreemangal',
    seat_types: [
      { type: 'SNIGDHA',  fare: '440', vat_amount: '66', seat_counts: { online: 12, offline: 3 } },
      { type: 'S_CHAIR',  fare: '320', vat_amount: '0',  seat_counts: { online: 0,  offline: 0 } },
      { type: 'AC_S',     fare: '640', vat_amount: '96', seat_counts: { online: 5,  offline: 0 } } ] },
  { trip_number: 'UPABAN EXPRESS (739)',
    departure_date_time: '01 Sep, 2026 10:00 pm', arrival_date_time: '02 Sep, 2026 02:09 am',
    travel_time: '4h 09m', origin_city_name: 'Dhaka', destination_city_name: 'Sreemangal',
    seat_types: [ { type: 'S_CHAIR', fare: '320', seat_counts: { online: 0, offline: 0 } } ] },
  { trip_number: 'GHOST EXPRESS (999)',   // not in the local catalog
    departure_date_time: '01 Sep, 2026 09:00 am', arrival_date_time: '01 Sep, 2026 01:00 pm',
    seat_types: [ { type: 'SHOVAN', fare: '200', seat_counts: { online: 7 } } ] },
]};

mock.module(path.join(SRC, 'shohoz.js'), {
  namedExports: {
    searchTrips: async () => PAYLOAD,
    bookingUrl: () => 'https://eticket.railway.gov.bd/booking/train/search?x=1',
    UpstreamError: class UpstreamError extends Error {},
    checkToken: async () => ({ valid: true }),
    fetchAllTrains: async () => [],
    fetchTrainRoute: async () => ({}),
  },
});

const { migrate, closePool } = await import(path.join(SRC, 'db.js'));
await migrate();

const { fullAvailability, liveAvailability } = await import(path.join(SRC, 'availability.js'));

test.after(async () => { await closePool(); });

test('parses seat classes, fares and totals', async () => {
  const live = await liveAvailability({ fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: '2026-09-01', token: 'x' });
  assert.equal(live.tripCount, 3);
  assert.equal(live.withSeats, 2, 'PARABAT + GHOST have seats; UPABAN sold out');
  assert.equal(live.onlineSeats, 12 + 0 + 5 + 0 + 7);

  const parabat = live.trips.find((t) => t.trainNumber === '709');
  assert.equal(parabat.departureTime, '06:30');
  assert.equal(parabat.arrivalTime, '10:32');
  assert.equal(parabat.onlineSeats, 17);
  assert.equal(parabat.totalSeats, 20, 'offline seats counted in total only');

  const snigdha = parabat.classes.find((c) => c.seatClass === 'SNIGDHA');
  assert.equal(snigdha.seatClassLabel, 'Snigdha (AC chair)');
  assert.equal(snigdha.fare, 440);
  assert.equal(snigdha.totalFare, 506, 'fare + VAT');

  // sorted by departure: 06:30, 09:00, 22:00
  assert.deepEqual(live.trips.map((t) => t.departureTime), ['06:30', '09:00', '22:00']);
});

test('merges live counts onto the catalog trains and flags unmatched trips', async () => {
  const r = await fullAvailability({ fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: '2026-09-01', token: 'x' });

  assert.equal(r.liveChecked, true);
  assert.equal(r.tokenPresent, true);
  assert.equal(r.liveError, null);

  const t709 = r.trains.find((t) => t.trainNumber === '709');
  assert.ok(t709.live, '709 got live data');
  assert.equal(t709.live.hasSeats, true);
  assert.equal(t709.live.onlineSeats, 17);
  assert.equal(t709.live.classes.length, 3);

  const t739 = r.trains.find((t) => t.trainNumber === '739');
  assert.equal(t739.live.hasSeats, false, '739 sold out');

  // 717 is off on Tuesdays and absent from the payload
  const t717 = r.trains.find((t) => t.trainNumber === '717');
  assert.equal(t717.live, null, 'no live match -> null, not a crash');

  assert.equal(r.unmatchedLiveTrips.length, 1);
  assert.match(r.unmatchedLiveTrips[0].trainName, /GHOST/);

  assert.equal(r.live.onlineSeats, 24);
});

test('a date beyond the window skips the live call entirely', async () => {
  const r = await fullAvailability({ fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: '2027-01-01', token: 'x' });
  assert.equal(r.liveChecked, false, 'no wasted upstream request');
  assert.equal(r.dateStatus.kind, 'too_far');
  assert.ok(r.firstAvailability.openDate, 'still answers the sale-open question');
});
