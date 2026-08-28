/**
 * The "first availability" engine.
 *
 * "First availability" has three distinct meanings, and this site answers all
 * three because the useful answer depends on where you are in the cycle:
 *
 *  A. WHEN CAN I FIRST BUY a ticket for journey date D?
 *     Bangladesh Railway sells a rolling window of today .. today+10, so D
 *     opens the instant (D - ADVANCE_DAYS) begins in Dhaka — 00:00 BST, when
 *     the window rolls forward. This is deterministic and needs no login — it
 *     is the question the official site simply refuses to answer, because a
 *     date more than 10 days out is not even selectable in its datepicker.
 *
 *  B. Given D is already on sale, WHICH TRAIN still has seats, in what class,
 *     at what fare? Needs a session token (live seat counts).
 *
 *  C. What is the EARLIEST DATE from now on which this route actually has a
 *     seat I can buy? Scans the bookable window. Needs a session token.
 */
import { ADVANCE_DAYS, SALE_OPEN_TIME, ZONE_OPENING_TIME, SEAT_CLASS_LABELS } from './config.js';
import { findTrainsForRoute, stationLabel } from './catalog.js';
import { searchTrips, bookingUrl, UpstreamError } from './shohoz.js';
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
 * Sale-open instant for one journey date.
 *
 * The gate is the booking window rolling forward at Dhaka midnight, which is
 * the same moment for every train on every route — the train's zone opening
 * time is carried through as `zoneOpenTime` for display only. See
 * ZONE_OPENING_TIME in config.js for why it must not gate this.
 */
export function saleOpening(journeyDateISO, train, now = new Date()) {
  const openDate = addDays(journeyDateISO, -ADVANCE_DAYS);
  const opensAt = dhakaToUTC(openDate, SALE_OPEN_TIME);
  const msUntil = opensAt.getTime() - now.getTime();
  return {
    openDate,
    openTime: SALE_OPEN_TIME.slice(0, 5),
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

/**
 * The offline answer for a route + date. Always available, never needs a login.
 */
export async function routePlan({ fromCity, toCity, dateISO, now = new Date() }) {
  const window = bookingWindow(now);
  const dateStatus = classifyDate(dateISO, now);
  const allTrains = await findTrainsForRoute(fromCity, toCity);

  const trains = allTrains.map((t) => {
    const schedule = runsOn(t, dateISO);
    const sale = saleOpening(dateISO, t, now);

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

  // Requirement A: the earliest moment any ticket for this date can be bought.
  // The window rolls forward for the whole network at once, so every train
  // running that day shares one instant — no per-train minimum to take.
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

/**
 * search-trips-v2 has shifted field names between releases, so read tolerantly
 * and keep the raw payload out of the response.
 */
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

/**
 * Merge the offline plan with live seat data where a token is available.
 * The offline plan is always the backbone, so a missing or expired token
 * degrades the page rather than breaking it.
 */
export async function fullAvailability({ fromCity, toCity, dateISO, token, now = new Date() }) {
  const plan = await routePlan({ fromCity, toCity, dateISO, now });

  let live = null;
  let liveError = null;
  const worthQuerying = token && plan.dateStatus.kind === 'bookable';

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
    tokenPresent: Boolean(token),
  };
}

/**
 * Requirement C: scan the bookable window and report the earliest date that
 * actually has a buyable seat, plus a per-day strip for the whole window.
 */
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

    if (plan.trainsRunningOnDate > 0 && token) {
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

  return { days, earliest, needsAuth: false, tokenPresent: Boolean(token), seatClass };
}
