import { TZ, TZ_OFFSET_MINUTES } from './config.js';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/** Current wall-clock time in Dhaka, as a plain {y,m,d,hh,mm,ss}. */
export function nowInDhaka(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(at);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: g('year'), m: g('month'), d: g('day'), hh: g('hour'), mm: g('minute'), ss: g('second') };
}

/** Today in Dhaka as an ISO date string (YYYY-MM-DD). */
export function todayISO(at = new Date()) {
  const { y, m, d } = nowInDhaka(at);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * A Dhaka wall-clock instant as a real UTC Date.
 * BST is UTC+6 with no DST, so a fixed offset is exact.
 */
export function dhakaToUTC(iso, timeHHMMSS = '00:00:00') {
  const [y, m, d] = iso.split('-').map(Number);
  const [hh, mm, ss] = timeHHMMSS.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss || 0) - TZ_OFFSET_MINUTES * 60_000);
}

/** Shift an ISO date by whole days (calendar-safe, no timezone drift). */
export function addDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (both ISO). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** ISO date -> "01-Sep-2026", the format the upstream API and site expect. */
export function toApiDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`;
}

/** "01-Sep-2026" -> "2026-09-01". Returns null if unparseable. */
export function fromApiDate(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

/** Three-letter weekday ("Fri") for an ISO date — matches upstream `days`. */
export function weekdayShort(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** "1 Sep 2026, Tue" for display. */
export function prettyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}, ${weekdayShort(iso)}`;
}

/** Accept YYYY-MM-DD or DD-MMM-YYYY; return ISO or null. */
export function normalizeDate(input) {
  const s = String(input || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return s;
  }
  return fromApiDate(s);
}

/** Normalise upstream "06:53 am BST" / "13:05" into 24h "HH:MM". */
export function to24h(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = /^(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(s);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'pm') h += 12;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  m = /^(\d{1,2}):(\d{2})/.exec(s);
  return m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : null;
}

/**
 * Pull the first clock time out of a longer string, e.g.
 * "01 Sep, 2026 06:30 am" -> "06:30". `to24h` is anchored and would reject this,
 * which is right for bare stop times but wrong for the API's datetime strings.
 */
export function timeFromText(raw) {
  if (!raw) return null;
  const m = /(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i.exec(String(raw));
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) {
    h %= 12;
    if (m[3].toLowerCase() === 'pm') h += 12;
  }
  if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** "HH:MM" -> minutes since midnight. */
export function minutesOfDay(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Minutes -> "6h 30m". */
export function humanDuration(mins) {
  if (mins == null || !Number.isFinite(mins)) return null;
  const sign = mins < 0 ? '-' : '';
  const a = Math.abs(mins);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `${sign}${h ? `${h}h ` : ''}${m}m`.trim();
}
