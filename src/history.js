/**
 * Availability history.
 *
 * Bangladesh Railway exposes no historical API — search-trips-v2 only answers
 * for dates inside the 10-day selling window, and nothing at all for dates
 * already past. So months of history cannot be back-filled; it has to be
 * ACCUMULATED. Every live search is recorded, and a background collector
 * sweeps the watchlist once per hour, so the archive deepens day by day.
 *
 * What the archive then supports:
 *   - how fast a given journey date drained after its sale opened
 *   - which trains/classes on a route historically still have seats late
 *   - month-by-month coverage of what has been captured so far
 */
import { query, one, transact, isoDate, isoTimestamp, getMeta, setMeta } from './db.js';
import { liveAvailability, bookingWindow } from './availability.js';
import { findTrainsForRoute, stationLabel } from './catalog.js';
import { addDays, daysBetween, todayISO, prettyDate, weekdayShort, nowInDhaka } from './time.js';
import {
  ADVANCE_DAYS, TZ, PROBE_INTERVAL_MS, PROBE_FROM_HOUR, PROBE_TO_HOUR,
  SALE_OPEN_TIME_KEY, SALE_OPEN_EVIDENCE_KEY,
} from './config.js';
import { UpstreamError, hasToken } from './shohoz.js';

/** Persist one observation of a route+date. Returns the snapshot id. */
export async function recordSnapshot({ fromCity, toCity, dateISO, live, source = 'live-search', error = null }) {
  const nowISO = new Date().toISOString();
  const capturedDate = todayISO();

  return transact(async (tx) => {
    const row = await tx.one(
      `INSERT INTO snapshots (from_city, to_city, journey_date, captured_at, captured_date,
                              days_ahead, source, train_count, total_seats, ok, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        fromCity, toCity, dateISO, nowISO, capturedDate,
        daysBetween(capturedDate, dateISO), source,
        live?.tripCount ?? 0, live?.onlineSeats ?? 0,
        !error, error,
      ],
    );
    const snapshotId = row.id;

    const rows = [];
    for (const trip of live?.trips || []) {
      for (const c of trip.classes) {
        rows.push([
          snapshotId, trip.trainNumber, trip.trainName, trip.departureTime,
          trip.arrivalTime, c.seatClass, c.online, c.offline, c.fare, c.vat,
        ]);
      }
    }
    if (rows.length) {
      const values = [];
      const params = [];
      for (const r of rows) {
        const b = params.length;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`);
        params.push(...r);
      }
      await tx.query(
        `INSERT INTO seat_counts (snapshot_id, train_number, train_name, departure_time,
                                  arrival_time, seat_class, online_seats, offline_seats, fare, vat)
         VALUES ${values.join(',')}`,
        params,
      );
    }
    return snapshotId;
  });
}

export async function addWatch(fromCity, toCity) {
  await query(
    `INSERT INTO watchlist (from_city, to_city, created_at) VALUES ($1,$2,$3)
     ON CONFLICT (from_city, to_city) DO NOTHING`,
    [fromCity, toCity, new Date().toISOString()],
  );
}

export async function removeWatch(fromCity, toCity) {
  await query('DELETE FROM watchlist WHERE from_city = $1 AND to_city = $2', [fromCity, toCity]);
}

export async function listWatches() {
  // Counting per row in SQL avoids a query per watch.
  const rows = await query(`
    SELECT w.from_city, w.to_city, w.created_at, w.last_run_at,
           COALESCE(s.n, 0)::int AS snapshots
    FROM watchlist w
    LEFT JOIN (
      SELECT from_city, to_city, COUNT(*) AS n FROM snapshots GROUP BY from_city, to_city
    ) s ON s.from_city = w.from_city AND s.to_city = w.to_city
    ORDER BY w.from_city, w.to_city`);

  return rows.map((r) => ({
    fromCity: r.from_city,
    toCity: r.to_city,
    fromLabel: stationLabel(r.from_city),
    toLabel: stationLabel(r.to_city),
    createdAt: isoTimestamp(r.created_at),
    lastRunAt: isoTimestamp(r.last_run_at),
    snapshots: r.snapshots,
  }));
}

/** Overall archive stats + month-by-month coverage, for the History panel. */
export async function historyOverview() {
  const totals = await one(`
    SELECT COUNT(*)::int AS snapshots,
           MIN(captured_date) AS first_day,
           MAX(captured_date) AS last_day,
           COUNT(DISTINCT captured_date)::int AS days_covered,
           COUNT(DISTINCT from_city || '>' || to_city)::int AS routes
    FROM snapshots`);

  const months = (await query(`
    SELECT to_char(captured_date, 'YYYY-MM') AS month,
           COUNT(*)::int AS snapshots,
           COUNT(DISTINCT captured_date)::int AS days,
           COUNT(DISTINCT journey_date)::int AS journey_dates
    FROM snapshots
    GROUP BY 1 ORDER BY 1 DESC LIMIT 12`));

  const routes = (await query(`
    SELECT from_city, to_city, COUNT(*)::int AS snapshots,
           MIN(captured_date) AS first_day, MAX(captured_date) AS last_day
    FROM snapshots GROUP BY from_city, to_city
    ORDER BY snapshots DESC LIMIT 25`)).map((r) => ({
    fromCity: r.from_city, toCity: r.to_city,
    fromLabel: stationLabel(r.from_city), toLabel: stationLabel(r.to_city),
    snapshots: r.snapshots,
    firstDay: isoDate(r.first_day), lastDay: isoDate(r.last_day),
  }));

  const firstDay = isoDate(totals.first_day);

  // How far back the archive reaches, against the 4-6 month goal.
  const monthsCovered = firstDay
    ? Math.max(0.1, Math.round((daysBetween(firstDay, todayISO()) / 30.44) * 10) / 10)
    : 0;

  return {
    snapshots: totals.snapshots || 0,
    firstDay,
    lastDay: isoDate(totals.last_day),
    daysCovered: totals.days_covered || 0,
    routesTracked: totals.routes || 0,
    monthsCovered,
    months,
    routes,
    watches: await listWatches(),
  };
}

/**
 * The drain curve for one journey date: every observation from sale-open to
 * departure, so a user can see how quickly that date filled up.
 */
export async function journeyDateHistory({ fromCity, toCity, dateISO }) {
  const snaps = await query(`
    SELECT id, captured_at, captured_date, days_ahead, source, train_count, total_seats, ok, error
    FROM snapshots
    WHERE from_city = $1 AND to_city = $2 AND journey_date = $3
    ORDER BY captured_at`, [fromCity, toCity, dateISO]);

  // Group by snapshot id, not captured_at: two sweeps can share a timestamp.
  const byClass = await query(`
    SELECT s.id AS snapshot_id, s.captured_at, sc.seat_class,
           SUM(sc.online_seats)::int AS online
    FROM snapshots s JOIN seat_counts sc ON sc.snapshot_id = s.id
    WHERE s.from_city = $1 AND s.to_city = $2 AND s.journey_date = $3
    GROUP BY s.id, s.captured_at, sc.seat_class
    ORDER BY s.captured_at, s.id`, [fromCity, toCity, dateISO]);

  return {
    journeyDate: dateISO,
    datePretty: prettyDate(dateISO),
    points: snaps.map((s) => ({
      capturedAt: isoTimestamp(s.captured_at),
      capturedDate: isoDate(s.captured_date),
      daysAhead: s.days_ahead,
      source: s.source,
      trains: s.train_count,
      seats: s.total_seats,
      ok: Boolean(s.ok),
      error: s.error,
    })),
    byClass: byClass.map((r) => ({
      snapshot_id: r.snapshot_id,
      captured_at: isoTimestamp(r.captured_at),
      seat_class: r.seat_class,
      online: r.online,
    })),
  };
}

/**
 * Per-route history digest: for each "days ahead" bucket, the average seats
 * seen. This is the practical takeaway — e.g. "at 10 days out this route
 * averages 900 seats; by 2 days out, 40" tells you when to actually buy.
 */
export async function routeHistory({ fromCity, toCity, limitDays = 200 }) {
  const since = addDays(todayISO(), -limitDays);

  const byDaysAhead = await query(`
    SELECT days_ahead,
           COUNT(*)::int AS observations,
           ROUND(AVG(total_seats)::numeric, 1)::float8 AS avg_seats,
           MIN(total_seats)::int AS min_seats,
           MAX(total_seats)::int AS max_seats,
           COUNT(*) FILTER (WHERE total_seats = 0)::int AS sold_out_count
    FROM snapshots
    WHERE from_city = $1 AND to_city = $2 AND ok AND captured_date >= $3
      AND days_ahead BETWEEN 0 AND 10
    GROUP BY days_ahead ORDER BY days_ahead DESC`, [fromCity, toCity, since]);

  const byJourneyDate = await query(`
    SELECT journey_date,
           COUNT(*)::int AS observations,
           MAX(total_seats)::int AS peak_seats,
           MIN(total_seats)::int AS final_seats,
           MIN(captured_at) AS first_seen,
           MAX(captured_at) AS last_seen
    FROM snapshots
    WHERE from_city = $1 AND to_city = $2 AND ok
    GROUP BY journey_date ORDER BY journey_date DESC LIMIT 120`, [fromCity, toCity]);

  const byClass = await query(`
    SELECT sc.seat_class,
           COUNT(DISTINCT s.id)::int AS observations,
           ROUND(AVG(sc.online_seats)::numeric, 1)::float8 AS avg_online,
           MAX(sc.online_seats)::int AS max_online,
           ROUND(AVG(NULLIF(sc.fare, 0))::numeric, 0)::float8 AS avg_fare
    FROM snapshots s JOIN seat_counts sc ON sc.snapshot_id = s.id
    WHERE s.from_city = $1 AND s.to_city = $2 AND s.ok
    GROUP BY sc.seat_class ORDER BY avg_online DESC`, [fromCity, toCity]);

  const dates = byJourneyDate.map((r) => ({
    journey_date: isoDate(r.journey_date),
    observations: r.observations,
    peak_seats: r.peak_seats,
    final_seats: r.final_seats,
    firstSeen: isoTimestamp(r.first_seen),
    lastSeen: isoTimestamp(r.last_seen),
  }));

  const byWeekday = dates.reduce((acc, r) => {
    const wd = weekdayShort(r.journey_date);
    acc[wd] = acc[wd] || { weekday: wd, dates: 0, peakSum: 0 };
    acc[wd].dates += 1;
    acc[wd].peakSum += r.peak_seats || 0;
    return acc;
  }, {});

  return {
    fromCity, toCity,
    fromLabel: stationLabel(fromCity), toLabel: stationLabel(toCity),
    byDaysAhead,
    byJourneyDate: dates.map((r) => ({ ...r, datePretty: prettyDate(r.journey_date) })),
    byClass,
    byWeekday: Object.values(byWeekday).map((w) => ({
      weekday: w.weekday, dates: w.dates,
      avgPeakSeats: w.dates ? Math.round(w.peakSum / w.dates) : 0,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Background collector
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sweep every watched route across the whole bookable window once.
 * Safe to call with no token — it records nothing and says so.
 */
export async function collectOnce({ token, log = () => {} }) {
  if (!hasToken(token)) return { skipped: true, reason: 'no-token', recorded: 0 };

  const watches = await listWatches();
  if (!watches.length) return { skipped: true, reason: 'empty-watchlist', recorded: 0 };

  const { firstDate, lastDate } = bookingWindow();
  let recorded = 0;
  let authFailed = false;

  for (const w of watches) {
    if (authFailed) break;
    const trains = await findTrainsForRoute(w.fromCity, w.toCity);

    for (let d = firstDate; daysBetween(d, lastDate) >= 0; d = addDays(d, 1)) {
      // Skip dates with no service — nothing to learn and it wastes a request.
      const running = trains.filter(
        (t) => !t.runningDays?.length || t.runningDays.includes(weekdayShort(d)));
      if (!running.length) continue;

      try {
        const live = await liveAvailability({ fromCity: w.fromCity, toCity: w.toCity, dateISO: d, token });
        await recordSnapshot({ fromCity: w.fromCity, toCity: w.toCity, dateISO: d, live, source: 'scheduled' });
        recorded += 1;
      } catch (err) {
        await recordSnapshot({
          fromCity: w.fromCity, toCity: w.toCity, dateISO: d,
          live: null, source: 'scheduled', error: err.message,
        });
        if (err instanceof UpstreamError && err.needsAuth) {
          log(`collector: token rejected, stopping sweep — ${err.message}`);
          authFailed = true;
          break;
        }
      }
      await sleep(600); // stay gentle on upstream
    }

    await query('UPDATE watchlist SET last_run_at = $1 WHERE from_city = $2 AND to_city = $3',
      [new Date().toISOString(), w.fromCity, w.toCity]);
  }

  log(`collector: recorded ${recorded} snapshot(s) across ${watches.length} route(s)`);
  return { skipped: false, recorded, routes: watches.length, authFailed };
}

/** Start the hourly collector. Returns a stop function. */
/**
 * The release probe runs on its own, much shorter, interval: an hourly sweep
 * could only ever place the release within an hour, which is useless for an
 * alarm. It no-ops outside the watch hours and once the day is measured.
 */
export function startReleaseProbe({ getToken, log = console.log }) {
  const tick = async () => {
    try {
      const res = await probeSaleRelease({ token: await getToken(), log });
      if (res.measured) {
        const { resyncAlertOpenTimes } = await import('./notify.js');
        await resyncAlertOpenTimes({ log });
      }
    } catch (err) {
      log(`release probe: ${err.message}`);
    }
  };
  const timer = setInterval(tick, PROBE_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
  return { stop() { clearInterval(timer); } };
}

export function startCollector({ getToken, intervalMs = 60 * 60 * 1000, log = console.log }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const res = await collectOnce({ token: await getToken(), log });
      if (res.skipped && res.reason === 'no-token') {
        log('collector: idle (no session token yet — history will start once one is added)');
      }
    } catch (err) {
      log(`collector: sweep failed — ${err.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 10_000).unref?.(); // first sweep shortly after boot
  return () => clearInterval(timer);
}

/* ------------------------------------------------------------------ *
 * Sale-release probe
 *
 * The exact time of day Bangladesh Railway releases seats is not published
 * anywhere and has moved before, so rather than hard-code a guess the app
 * measures it: on each day, watch the NEWEST journey date (today + 10, which
 * became selectable at midnight but has no seats yet) and record the first
 * moment seats appear. That timestamp then drives every alarm.
 * ------------------------------------------------------------------ */

/**
 * One observation. Cheap enough to call every minute: it does nothing outside
 * the watch hours, nothing once today's release has been seen, and nothing
 * without a session token.
 */
export async function probeSaleRelease({ token, log = () => {} }) {
  if (!hasToken(token)) return { skipped: 'no token' };

  const { y, m, d, hh } = nowInDhaka();
  const todayDhaka = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (hh < PROBE_FROM_HOUR || hh >= PROBE_TO_HOUR) return { skipped: 'outside watch hours' };

  // Already measured today? Nothing left to learn until tomorrow.
  const evidence = JSON.parse((await getMeta(SALE_OPEN_EVIDENCE_KEY)) || 'null');
  if (evidence?.observedOn === todayDhaka) return { skipped: 'already seen today' };

  const watches = await listWatches();
  if (!watches.length) return { skipped: 'no tracked routes' };
  const { fromCity, toCity } = watches[0];

  // The newest date is the one whose seats have not been released yet.
  const dateISO = addDays(todayDhaka, ADVANCE_DAYS);

  let live;
  try {
    live = await liveAvailability({ fromCity, toCity, dateISO, token });
  } catch (err) {
    return { skipped: `lookup failed: ${err.message}` };
  }

  if (live.onlineSeats <= 0) return { seatsYet: false, dateISO };

  // First sighting of the day. The true release is somewhere in the interval
  // since the previous check, so record that interval honestly rather than
  // pretending this instant is exact.
  const at = new Date();
  const observed = {
    observedOn: todayDhaka,
    journeyDate: dateISO,
    route: `${fromCity} > ${toCity}`,
    seenAt: at.toISOString(),
    seenAtDhaka: new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(at),
    onlineSeats: live.onlineSeats,
    resolutionMs: PROBE_INTERVAL_MS,
  };

  // Round down to the minute: the release is a scheduled clock time, and the
  // sighting can only be at or after it.
  const [oh, om] = observed.seenAtDhaka.split(':');
  const measured = `${oh}:${om}:00`;

  await setMeta(SALE_OPEN_EVIDENCE_KEY, JSON.stringify(observed));
  await setMeta(SALE_OPEN_TIME_KEY, measured);
  log(`sale release measured: seats for ${dateISO} appeared by ${observed.seenAtDhaka} Dhaka `
    + `(${observed.onlineSeats} seats, ±${Math.round(PROBE_INTERVAL_MS / 1000)}s) — alarms now use ${measured}`);

  return { measured, observed };
}

/** What the probe has learned, for the UI. */
export async function saleReleaseEvidence() {
  const raw = await getMeta(SALE_OPEN_EVIDENCE_KEY);
  const time = await getMeta(SALE_OPEN_TIME_KEY);
  return { time: time || null, evidence: raw ? JSON.parse(raw) : null };
}
