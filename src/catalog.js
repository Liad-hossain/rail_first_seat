
import { query, one, transact, setMeta, getMeta, isoTimestamp } from './db.js';
import { fetchAllTrains, fetchTrainRoute } from './shohoz.js';
import { CRAWL_DELAY_MS } from './config.js';
import { to24h, addDays, todayISO, minutesOfDay } from './time.js';

const ALL_DAYS = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Underscored upstream names ("Biman_Bandar") -> display form. */
export function stationLabel(city) {
  return String(city || '').replace(/_/g, ' ').trim();
}

function offDayOf(days) {
  if (!Array.isArray(days) || days.length === 0 || days.length >= 7) return null;
  return ALL_DAYS.filter((d) => !days.includes(d)).join(', ') || null;
}

function parseHalt(halt) {
  if (halt == null || halt === '') return null;
  const n = Number(String(halt).trim());
  return Number.isFinite(n) ? n : null;
}


export async function syncCatalog({ onProgress = () => {}, delayMs = CRAWL_DELAY_MS } = {}) {
  const sampleDate = addDays(todayISO(), 3);
  const trains = await fetchAllTrains();
  onProgress({ phase: 'trains', total: trains.length, done: 0 });

  const results = [];
  const failures = [];

  for (let i = 0; i < trains.length; i++) {
    const t = trains[i];
    try {
      const route = await fetchTrainRoute(t.trainNumber, sampleDate);
      results.push({ ...t, ...route });
    } catch (err) {
      failures.push({ trainNumber: t.trainNumber, error: err.message });
      results.push({ ...t, trainName: '', days: [], totalDuration: null, routes: [] });
    }
    onProgress({ phase: 'routes', total: trains.length, done: i + 1, trainNumber: t.trainNumber });
    if (delayMs && i < trains.length - 1) await sleep(delayMs);
  }

  const now = new Date().toISOString();

  await transact(async (tx) => {
    await tx.query('DELETE FROM stops');
    await tx.query('DELETE FROM trains');
    await tx.query('DELETE FROM stations');

    const cityCounts = new Map();

    for (const r of results) {
      await tx.query(
        `INSERT INTO trains (train_number, train_name, origin_city, destination_city, zone,
                             opening_time, running_days, off_day, total_duration, stop_count, route_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,
        [
          r.trainNumber,
          r.trainName || `TRAIN (${r.trainNumber})`,
          r.originCity, r.destinationCity, r.zone, r.openingTime,
          JSON.stringify(r.days || []),
          offDayOf(r.days),
          r.totalDuration,
          (r.routes || []).length,
          now,
        ],
      );

      const stops = r.routes || [];
      if (stops.length) {
        const values = [];
        const params = [];
        stops.forEach((stop, idx) => {
          const b = params.length;
          values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
          params.push(
            r.trainNumber, idx, stop.city,
            to24h(stop.arrival_time), to24h(stop.departure_time),
            parseHalt(stop.halt), stop.duration || null,
          );
          cityCounts.set(stop.city, (cityCounts.get(stop.city) || 0) + 1);
        });
        await tx.query(
          `INSERT INTO stops (train_number, seq, city_name, arrival_time, departure_time, halt_minutes, duration_raw)
           VALUES ${values.join(',')}`,
          params,
        );
      } else {
        // Trains whose stop list failed still contribute their endpoints, so the
        // station picker never silently loses a city.
        for (const c of [r.originCity, r.destinationCity]) {
          if (c) cityCounts.set(c, cityCounts.get(c) || 0);
        }
      }
    }

    const entries = [...cityCounts];
    if (entries.length) {
      const values = [];
      const params = [];
      entries.forEach(([city, n]) => {
        const b = params.length;
        values.push(`($${b + 1},$${b + 2},$${b + 3})`);
        params.push(city, stationLabel(city), n);
      });
      await tx.query(`INSERT INTO stations (city_name, label, train_count) VALUES ${values.join(',')}`, params);
    }
  });

  const stations = (await one('SELECT COUNT(*)::int AS n FROM stations')).n;
  const stops = (await one('SELECT COUNT(*)::int AS n FROM stops')).n;

  await setMeta('catalog_synced_at', now);
  await setMeta('catalog_train_count', results.length);
  await setMeta('catalog_station_count', stations);
  await setMeta('catalog_failures', JSON.stringify(failures));

  return { syncedAt: now, trains: results.length, stations, stops, failures };
}

export async function catalogStatus() {
  const [t, s, st] = await Promise.all([
    one('SELECT COUNT(*)::int AS n FROM trains'),
    one('SELECT COUNT(*)::int AS n FROM stations'),
    one('SELECT COUNT(*)::int AS n FROM stops'),
  ]);
  let failures = [];
  try { failures = JSON.parse(await getMeta('catalog_failures', '[]')) || []; } catch { /* ignore */ }
  return {
    syncedAt: await getMeta('catalog_synced_at'),
    trains: t.n, stations: s.n, stops: st.n,
    failures: failures.length,
  };
}

export async function listStations() {
  const rows = await query(
    'SELECT city_name, label, train_count FROM stations ORDER BY train_count DESC, label ASC',
  );
  return rows.map((r) => ({ city: r.city_name, label: r.label, trains: r.train_count }));
}


export async function findTrainsForRoute(fromCity, toCity) {
  const rows = await query(`
    SELECT t.train_number, t.train_name, t.zone, t.opening_time, t.running_days,
           t.off_day, t.origin_city, t.destination_city, t.total_duration,
           a.seq AS from_seq, a.departure_time AS dep, a.arrival_time AS from_arr,
           b.seq AS to_seq,   b.arrival_time  AS arr, b.departure_time AS to_dep,
           (SELECT COUNT(*)::int FROM stops s WHERE s.train_number = t.train_number
              AND s.seq > a.seq AND s.seq < b.seq) AS intermediate_stops
    FROM trains t
    JOIN stops a ON a.train_number = t.train_number AND a.city_name = $1
    JOIN stops b ON b.train_number = t.train_number AND b.city_name = $2
    WHERE a.seq < b.seq
    ORDER BY a.departure_time ASC NULLS LAST
  `, [fromCity, toCity]);

  return rows.map((r) => {
    // running_days is JSONB, so the driver already hands back an array.
    const days = Array.isArray(r.running_days) ? r.running_days : [];
    const dep = r.dep || r.from_arr;
    const arr = r.arr || r.to_dep;
    let legMinutes = null;
    if (dep && arr) {
      legMinutes = minutesOfDay(arr) - minutesOfDay(dep);
      if (legMinutes < 0) legMinutes += 24 * 60; // crosses midnight
    }
    return {
      trainNumber: r.train_number,
      trainName: r.train_name,
      zone: r.zone,
      openingTime: r.opening_time,
      runningDays: days,
      offDay: r.off_day,
      originCity: r.origin_city,
      destinationCity: r.destination_city,
      fullRouteDuration: r.total_duration,
      departureTime: dep,
      arrivalTime: arr,
      legMinutes,
      intermediateStops: r.intermediate_stops,
      fromIsOrigin: r.from_seq === 0,
    };
  });
}

/** Full stop list for one train, for the expandable detail view. */
export async function trainStops(trainNumber) {
  const rows = await query(`
    SELECT seq, city_name, arrival_time, departure_time, halt_minutes, duration_raw
    FROM stops WHERE train_number = $1 ORDER BY seq`, [trainNumber]);
  return rows.map((r) => ({
    seq: r.seq,
    city: r.city_name,
    label: stationLabel(r.city_name),
    arrival: r.arrival_time,
    departure: r.departure_time,
    haltMinutes: r.halt_minutes,
    cumulative: r.duration_raw,
  }));
}

/** One train's catalog row plus its stops. */
export async function trainDetail(trainNumber) {
  const row = await one(`
    SELECT train_number, train_name, origin_city, destination_city, zone,
           opening_time, running_days, off_day, total_duration, route_synced_at
    FROM trains WHERE train_number = $1`, [trainNumber]);
  if (!row) return null;
  return {
    trainNumber: row.train_number,
    trainName: row.train_name,
    originLabel: stationLabel(row.origin_city),
    destinationLabel: stationLabel(row.destination_city),
    zone: row.zone,
    openingTime: row.opening_time,
    runningDays: Array.isArray(row.running_days) ? row.running_days : [],
    offDay: row.off_day,
    totalDuration: row.total_duration,
    syncedAt: isoTimestamp(row.route_synced_at),
    stops: await trainStops(trainNumber),
  };
}

/** Destinations reachable from a station. */
export async function destinationsFrom(fromCity) {
  const rows = await query(`
    SELECT DISTINCT b.city_name AS city
    FROM stops a JOIN stops b
      ON a.train_number = b.train_number AND b.seq > a.seq
    WHERE a.city_name = $1
    ORDER BY b.city_name`, [fromCity]);
  return rows.map((r) => ({ city: r.city, label: stationLabel(r.city) }));
}
