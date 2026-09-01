import {
  ADVANCE_DAYS, SALE_OPEN_TIME, SALE_OPEN_TIME_KEY, SALE_OPEN_EVIDENCE_KEY,
  PROBE_MAX_BRACKET_MS, ZONE_OPENING_TIME, SEAT_CLASS_LABELS,
} from './config.js';
import { getMeta } from './db.js';
import { findTrainsForRoute, stationLabel } from './catalog.js';
import { searchTrips, bookingUrl, UpstreamError, hasToken } from './shohoz.js';
import {
  addDays, daysBetween, dhakaToUTC, humanDuration, prettyDate,
  todayISO, weekdayShort, minutesOfDay, timeFromText,
} from './time.js';

/** The last journey date currently selectable on the official site. */
export function bookingWindow(now = new Date()) {
  const today = todayISO(now);
  return { firstDate: today, lastDate: addDays(today, ADVANCE_DAYS), advanceDays: ADVANCE_DAYS };
}

/**
 * Does the stored measurement actually rest on a bracket?
 *
 * A release time is only ever measured as an interval: this date was closed at
 * A, open at B, so the release is in (A, B]. A bare "there were seats when I
 * looked" dates the observer, not the release.
 *
 * Checked HERE, at the point of use, and not only where the measurement is
 * written — because the value lives in a shared database that another process
 * can write. An older build of this app, still deployed and pointed at the same
 * Postgres, will happily keep recording first-sightings; refusing them on read
 * is what stops one stale writer putting every alarm on the wrong minute.
 */
export function isBracketedMeasurement(evidence) {
  if (!evidence?.absentAt || !evidence?.seenAt) return false;
  const width = Number(evidence.resolutionMs);
  return Number.isFinite(width) && width >= 0 && width <= PROBE_MAX_BRACKET_MS;
}

async function measurementIsBracketed() {
  const raw = await getMeta(SALE_OPEN_EVIDENCE_KEY);
  if (!raw) return false;
  try { return isBracketedMeasurement(JSON.parse(raw)); } catch { return false; }
}

/**
 * The release time actually in force: measured if we have ever properly
 * measured it, otherwise the documented default. Cached briefly because
 * routePlan() calls this on every request and the value changes at most once a
 * day.
 */
let saleTimeCache = { value: null, at: 0 };

export async function effectiveSaleOpenTime() {
  if (saleTimeCache.value && Date.now() - saleTimeCache.at < 60_000) return saleTimeCache.value;
  let value = SALE_OPEN_TIME;
  let source = 'default';
  try {
    const observed = await getMeta(SALE_OPEN_TIME_KEY);
    if (observed && /^\d{2}:\d{2}:\d{2}$/.test(observed) && await measurementIsBracketed()) {
      value = observed;
      source = 'measured';
    }
  } catch { /* database not reachable — the default is still correct enough */ }
  saleTimeCache = { value, at: Date.now(), source };
  return value;
}

export function saleOpenTimeSource() {
  return saleTimeCache.source || 'default';
}

/** Test hook: the 60s cache would otherwise hide a freshly measured time. */
export function __resetSaleTimeCache() {
  saleTimeCache = { value: null, at: 0 };
}

/**
 * Sale-open instant for one journey date.
 *
 * Two different moments are easy to confuse. The booking WINDOW rolls forward
 * at Dhaka midnight, which is when the date becomes selectable; the SEATS are
 * released later that morning. This returns the second one, because that is
 * when a ticket can actually be bought.
 *
 * `zoneOpenTime` is the operator's published counter hour, carried for display
 * only — see ZONE_OPENING_TIME in config.js.
 */
export function saleOpening(journeyDateISO, train, now = new Date(), openTime = SALE_OPEN_TIME) {
  const openDate = addDays(journeyDateISO, -ADVANCE_DAYS);
  const opensAt = dhakaToUTC(openDate, openTime);
  const msUntil = opensAt.getTime() - now.getTime();
  return {
    openDate,
    openTime: openTime.slice(0, 5),
    zoneOpenTime: (train.openingTime || ZONE_OPENING_TIME[train.zone] || ZONE_OPENING_TIME.EAST).slice(0, 5),
    opensAtISO: opensAt.toISOString(),
    msUntil,
    isOpen: msUntil <= 0,
  };
}

function classifyDate(journeyDateISO, now = new Date()) {
  const today = todayISO(now);
  const offset = daysBetween(today, journeyDateISO);
  if (offset < 0) return { kind: 'past', offset };
  if (offset > ADVANCE_DAYS) return { kind: 'too_far', offset };
  return { kind: 'bookable', offset };
}

function runsOn(train, journeyDateISO) {
  const wd = weekdayShort(journeyDateISO);
  if (!train.runningDays?.length) return { runs: true, certain: false, weekday: wd };
  return { runs: train.runningDays.includes(wd), certain: true, weekday: wd };
}


export async function routePlan({ fromCity, toCity, dateISO, now = new Date() }) {
  const window = bookingWindow(now);
  const dateStatus = classifyDate(dateISO, now);
  const [allTrains, openTime] = await Promise.all([
    findTrainsForRoute(fromCity, toCity),
    effectiveSaleOpenTime(),
  ]);

  const trains = allTrains.map((t) => {
    const schedule = runsOn(t, dateISO);
    const sale = saleOpening(dateISO, t, now, openTime);

    // Overnight legs land on the following calendar day.
    const overnight = t.departureTime && t.arrivalTime &&
      minutesOfDay(t.arrivalTime) < minutesOfDay(t.departureTime);

    return {
      ...t,
      trainLabel: t.trainName,
      fromLabel: stationLabel(fromCity),
      toLabel: stationLabel(toCity),
      legDuration: humanDuration(t.legMinutes),
      arrivesNextDay: Boolean(overnight),
      arrivalDate: overnight ? addDays(dateISO, 1) : dateISO,
      runsOnDate: schedule.runs,
      runsCertain: schedule.certain,
      offDayNote: t.offDay ? `Off day: ${t.offDay}` : 'Runs daily',
      sale,
      bookingUrl: bookingUrl({ fromCity, toCity, dateISO }),
    };
  });

  const running = trains.filter((t) => t.runsOnDate);

  let firstAvailability = null;
  if (running.length) {
    const sale = running[0].sale;
    const zoneTimes = [...new Set(running.map((t) => t.sale.zoneOpenTime))];
    firstAvailability = {
      opensAtISO: sale.opensAtISO,
      openDate: sale.openDate,
      openDatePretty: prettyDate(sale.openDate),
      openTime: sale.openTime,
      // Only meaningful when the whole route sits in one zone.
      zoneOpenTime: zoneTimes.length === 1 ? zoneTimes[0] : null,
      isOpen: sale.isOpen,
      msUntil: sale.msUntil,
      openTimeSource: saleOpenTimeSource(),
      trains: running.map((t) => ({ trainNumber: t.trainNumber, trainName: t.trainName })),
    };
  }

  return {
    from: { city: fromCity, label: stationLabel(fromCity) },
    to: { city: toCity, label: stationLabel(toCity) },
    date: dateISO,
    datePretty: prettyDate(dateISO),
    weekday: weekdayShort(dateISO),
    dateStatus,
    window,
    trainsOnRoute: trains.length,
    trainsRunningOnDate: running.length,
    firstAvailability,
    trains,
    bookingUrl: trains.length ? trains[0].bookingUrl : bookingUrl({ fromCity, toCity, dateISO }),
  };
}

/* ------------------------------------------------------------------ *
 * Live seat data
 * ------------------------------------------------------------------ */

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function parseSeatType(st) {
  const counts = st?.seat_counts || st?.seatCounts || {};
  const online = num(counts.online ?? st.online_seats ?? st.available_seats);
  const offline = num(counts.offline ?? st.offline_seats);
  const cls = st?.type || st?.seat_class || st?.class || 'UNKNOWN';
  return {
    seatClass: cls,
    seatClassLabel: SEAT_CLASS_LABELS[cls] || cls,
    online,
    offline,
    total: online + offline,
    fare: num(st?.fare),
    vat: num(st?.vat_amount ?? st?.vat),
    totalFare: num(st?.fare) + num(st?.vat_amount ?? st?.vat),
  };
}

function parseTrip(trip) {
  const name = trip?.trip_number || trip?.train_model || trip?.trip_name || '';
  const numberMatch = /\((\d+)\)\s*$/.exec(String(name));
  const classes = (trip?.seat_types || trip?.seatTypes || []).map(parseSeatType);
  const onlineTotal = classes.reduce((s, c) => s + c.online, 0);
  const grandTotal = classes.reduce((s, c) => s + c.total, 0);
  return {
    trainName: name,
    trainNumber: numberMatch ? numberMatch[1] : null,
    departureRaw: trip?.departure_date_time || null,
    arrivalRaw: trip?.arrival_date_time || null,
    departureTime: timeFromText(trip?.departure_date_time),
    arrivalTime: timeFromText(trip?.arrival_date_time),
    travelTime: trip?.travel_time || null,
    originLabel: stationLabel(trip?.origin_city_name),
    destinationLabel: stationLabel(trip?.destination_city_name),
    classes,
    onlineSeats: onlineTotal,
    totalSeats: grandTotal,
    hasSeats: onlineTotal > 0,
  };
}

/** Live seat counts for a route + date. Requires a token. */
export async function liveAvailability({ fromCity, toCity, dateISO, token }) {
  const res = await searchTrips({ fromCity, toCity, dateISO, token });
  const trips = res.trains.map(parseTrip)
    .sort((a, b) => (minutesOfDay(a.departureTime) ?? 1e9) - (minutesOfDay(b.departureTime) ?? 1e9));
  return {
    trips,
    tripCount: trips.length,
    withSeats: trips.filter((t) => t.hasSeats).length,
    onlineSeats: trips.reduce((s, t) => s + t.onlineSeats, 0),
  };
}


export async function fullAvailability({ fromCity, toCity, dateISO, token, now = new Date() }) {
  const plan = await routePlan({ fromCity, toCity, dateISO, now });

  let live = null;
  let liveError = null;
  const worthQuerying = hasToken(token) && plan.dateStatus.kind === 'bookable';

  if (worthQuerying) {
    try {
      live = await liveAvailability({ fromCity, toCity, dateISO, token });
    } catch (err) {
      liveError = {
        message: err.message,
        code: err instanceof UpstreamError ? err.code : 'ERROR',
        needsAuth: err instanceof UpstreamError ? err.needsAuth : false,
      };
    }
  }

  if (live) {
    const byNumber = new Map(live.trips.filter((t) => t.trainNumber).map((t) => [t.trainNumber, t]));
    for (const t of plan.trains) {
      const match = byNumber.get(t.trainNumber);
      t.live = match
        ? {
            classes: match.classes,
            onlineSeats: match.onlineSeats,
            totalSeats: match.totalSeats,
            hasSeats: match.hasSeats,
            travelTime: match.travelTime,
          }
        : null;
    }
    // Trips upstream reports that our catalog did not match (rare: renamed trains).
    plan.unmatchedLiveTrips = live.trips.filter(
      (t) => !t.trainNumber || !plan.trains.some((p) => p.trainNumber === t.trainNumber));
  }

  return {
    ...plan,
    live: live
      ? { tripCount: live.tripCount, withSeats: live.withSeats, onlineSeats: live.onlineSeats }
      : null,
    liveError,
    liveChecked: Boolean(live),
    tokenPresent: hasToken(token),
  };
}


export async function earliestBookable({ fromCity, toCity, token, now = new Date(), seatClass = null }) {
  const { firstDate, lastDate } = bookingWindow(now);
  const dates = [];
  for (let d = firstDate; daysBetween(d, lastDate) >= 0; d = addDays(d, 1)) dates.push(d);

  const days = [];
  let earliest = null;

  for (const dateISO of dates) {
    const plan = await routePlan({ fromCity, toCity, dateISO, now });
    const entry = {
      date: dateISO,
      datePretty: prettyDate(dateISO),
      weekday: weekdayShort(dateISO),
      trainsRunning: plan.trainsRunningOnDate,
      seatsOnline: null,
      trainsWithSeats: null,
      status: plan.trainsRunningOnDate === 0 ? 'no_service' : 'unknown',
      error: null,
    };

    if (plan.trainsRunningOnDate > 0 && hasToken(token)) {
      try {
        const live = await liveAvailability({ fromCity, toCity, dateISO, token });
        const filtered = seatClass
          ? live.trips.map((t) => ({
              ...t,
              onlineSeats: t.classes.filter((c) => c.seatClass === seatClass)
                .reduce((s, c) => s + c.online, 0),
            }))
          : live.trips;
        entry.seatsOnline = filtered.reduce((s, t) => s + t.onlineSeats, 0);
        entry.trainsWithSeats = filtered.filter((t) => t.onlineSeats > 0).length;
        entry.status = entry.seatsOnline > 0 ? 'available' : 'sold_out';
        if (!earliest && entry.seatsOnline > 0) earliest = { ...entry };
      } catch (err) {
        entry.status = 'error';
        entry.error = err.message;
        if (err instanceof UpstreamError && err.needsAuth) {
          return { days: [...days, entry], earliest: null, needsAuth: true, seatClass };
        }
      }
    }
    days.push(entry);
  }

  return { days, earliest, needsAuth: false, tokenPresent: hasToken(token), seatClass };
}
