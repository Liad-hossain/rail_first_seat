/* ============================================================
   BR First-Availability Finder — frontend
   Plain ES modules, no build step.
   ============================================================ */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  meta: null,
  stations: [],
  result: null,
  calendar: null,
  earliest: null,
  countdownTimer: null,
  searching: false,
  // pendingBot: the bot just pasted, so pairing goes to it rather than to the
  // site's shared one.
  notify: { status: null, alerts: null, pollTimer: null, pendingBot: null },
};

/* ------------------------------- utilities ------------------------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Every call carries the session secret when we have one.
 *
 * It is attached unconditionally rather than per-endpoint: the public routes
 * ignore it, and forgetting it on a guarded one is exactly the bug that makes a
 * signed-in user look signed out. The server never echoes it back.
 */
async function api(path, opts = {}) {
  const session = sessionToken.get();
  const res = await fetch(path, {
    ...opts,
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers || {}),
      ...(session ? { 'x-notify-token': session } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    // A guarded route reached without a session. Either the secret went stale
    // (bot swapped, account removed) or this browser never had one — both mean
    // "sign in", and stale secrets must be dropped or every later call repeats
    // this same failure.
    if (res.status === 401 && data.needsLogin) {
      if (session) sessionToken.set(null);
      state.meta = state.meta ? { ...state.meta, account: { signedIn: false } } : state.meta;
    }
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
  }
  return data;
}

/** True once this browser holds a session secret. */
const isSignedIn = () => Boolean(sessionToken.get());

/**
 * The prompt shown wherever a panel needs an account.
 *
 * Pairing Telegram IS the sign-in, so this always points at the same place
 * rather than introducing a second credential to explain.
 */
function signInPrompt(what) {
  return `
    <div class="note warn">
      <b>Sign in to use ${esc(what)}.</b>
      <br>${esc(what)} ${what.endsWith('s') ? 'are' : 'is'} tied to your own account, so nobody
      else can see or change ${what.endsWith('s') ? 'them' : 'it'}.
      <br>Signing in is just connecting Telegram — no password, no email.
      <div class="btn-row mt-10">
        <button class="btn btn-sm" data-signin="1">Connect Telegram to sign in</button>
      </div>
    </div>`;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, kind === 'err' ? 6200 : 3600);
}

/** "2:00 PM" from "14:00". */
function ampm(hhmm) {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * Bangladesh Standard Time, always.
 *
 * Every sale instant the API returns is a UTC ISO string (08:00 BST is
 * 02:00Z), so rendering one with plain toLocaleString() prints the VIEWER's
 * clock — 2 AM for anyone on UTC — while the countdown next to it ticks down
 * to the Dhaka moment. The sale happens on Bangladesh's clock, so that is the
 * only clock the UI quotes, whoever is looking.
 */
const DHAKA = 'Asia/Dhaka';

/** "8:00 AM BST" from a UTC ISO instant. */
function dhakaTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: DHAKA, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(t)} BST`;
}

/** "5 Sep 2026, 8:00 AM BST" from a UTC ISO instant. */
function dhakaDateTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  // Assembled from parts rather than a locale date style so the month reads
  // "Sep" like everywhere else here, not the en-GB "Sept".
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: DHAKA, day: 'numeric', month: 'numeric', year: 'numeric',
  }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${Number(p.day)} ${MONTH_ABBR[Number(p.month) - 1]} ${p.year}, ${dhakaTime(iso)}`;
}

/** "8:00 AM BST" from a bare "HH:MM" Dhaka wall-clock time. */
const saleClock = (hhmm) => (hhmm ? `${ampm(hhmm)} BST` : '—');

/**
 * The release time in force, for sections with no search result to read it
 * from. Same value the server schedules alarms on, so nothing can drift.
 */
const metaSaleOpen = () => state.meta?.saleOpen || null;

function splitDuration(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(t / 86400),
    hours: Math.floor((t % 86400) / 3600),
    minutes: Math.floor((t % 3600) / 60),
    seconds: t % 60,
  };
}

/**
 * Run in the console on eticket.railway.gov.bd. `copy()` is a DevTools
 * built-in; the JSON is what this app's token box expects.
 */
const CREDS_SNIPPET =
  "copy(JSON.stringify({token:localStorage.token,deviceId:localStorage.uudid,deviceKey:localStorage.ssdk}))";

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** "5 Sep 2026, Mon" or "2026-09-05" -> "5 Sep". */
function shortDate(input) {
  const s = String(input || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [, m, d] = s.split('-');
    return `${Number(d)} ${MONTH_ABBR[Number(m) - 1]}`;
  }
  return s.split(',')[0].replace(/\s+\d{4}$/, '');
}

function seatTone(n) {
  if (!n) return 'zero';
  if (n < 10) return 'low';
  return 'good';
}

const ICON = {
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  train: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="14" rx="3"/><path d="M4 11h16M8 3v8M16 3v8M8 21l2-4M16 21l-2-4M6 21h12"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/></svg>',
};

/* ------------------------------ station combo ---------------------------- */

class StationCombo {
  constructor(rootId, inputId, listId) {
    this.root = $(`#${rootId}`);
    this.input = $(`#${inputId}`);
    this.list = $(`#${listId}`);
    this.active = -1;
    this.items = [];

    this.input.addEventListener('input', () => this.open());
    this.input.addEventListener('focus', () => this.open());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.close(), 130));
    this.list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-city]');
      if (!li) return;
      e.preventDefault();
      this.pick(li.dataset.label);
    });
  }

  matches() {
    const q = this.input.value.trim().toLowerCase();
    const all = state.stations;
    if (!q) return all.slice(0, 40);
    const starts = [];
    const contains = [];
    for (const s of all) {
      const l = s.label.toLowerCase();
      if (l.startsWith(q)) starts.push(s);
      else if (l.includes(q)) contains.push(s);
    }
    return [...starts, ...contains].slice(0, 40);
  }

  open() {
    this.items = this.matches();
    this.active = -1;
    if (!this.items.length) {
      this.list.innerHTML = '<li class="empty">No station matches that name</li>';
    } else {
      this.list.innerHTML = this.items.map((s, i) => `
        <li role="option" data-city="${esc(s.city)}" data-label="${esc(s.label)}"
            id="${this.list.id}-opt-${i}" aria-selected="false">
          <span>${esc(s.label)}</span>
          <span class="hint">${s.trains} train${s.trains === 1 ? '' : 's'}</span>
        </li>`).join('');
    }
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  }

  close() {
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
  }

  pick(label) {
    this.input.value = label;
    this.close();
  }

  highlight(next) {
    const els = $$('li[data-city]', this.list);
    if (!els.length) return;
    this.active = (next + els.length) % els.length;
    els.forEach((el, i) => el.setAttribute('aria-selected', String(i === this.active)));
    els[this.active].scrollIntoView({ block: 'nearest' });
  }

  onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (this.list.hidden) this.open(); this.highlight(this.active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.highlight(this.active - 1); }
    else if (e.key === 'Enter') {
      const els = $$('li[data-city]', this.list);
      if (!this.list.hidden && this.active >= 0 && els[this.active]) {
        e.preventDefault();
        this.pick(els[this.active].dataset.label);
      }
    } else if (e.key === 'Escape') this.close();
  }

  get value() { return this.input.value.trim(); }
  set value(v) { this.input.value = v; }
}

let fromCombo;
let toCombo;

/* ------------------------------ main rendering --------------------------- */

function renderAnswer(r) {
  const fa = r.firstAvailability;
  const status = r.dateStatus.kind;

  // No train covers this pair at all.
  if (r.trainsOnRoute === 0) {
    return `
      <div class="answer is-none">
        <span class="answer-kicker">No direct train</span>
        <h2>No direct train runs ${esc(r.from.label)} → ${esc(r.to.label)}</h2>
        <p>
          No intercity train in Bangladesh Railway's timetable stops at ${esc(r.from.label)}
          and later at ${esc(r.to.label)}. You would need to break the journey at a junction —
          try a major hub such as Dhaka, Akhaura, Bhairab Bazar, Ishwardi or Santahar as an
          intermediate stop.
        </p>
      </div>`;
  }

  // Trains exist, but none run on this weekday.
  if (r.trainsRunningOnDate === 0) {
    const offDays = [...new Set(r.trains.map((t) => t.offDay).filter(Boolean))].join('; ');
    return `
      <div class="answer is-none">
        <span class="answer-kicker">No service that day</span>
        <h2>No train runs this route on ${esc(r.datePretty)}</h2>
        <p>
          All ${r.trainsOnRoute} train${r.trainsOnRoute === 1 ? '' : 's'} on
          ${esc(r.from.label)} → ${esc(r.to.label)} have ${esc(r.weekday)} as an off day.
          ${offDays ? `Off days on this route: ${esc(offDays)}.` : ''}
          Pick the day before or after.
        </p>
        <div class="answer-actions">
          <button class="btn btn-ghost btn-sm" data-shift="-1">← Try ${esc(r.weekday)} − 1 day</button>
          <button class="btn btn-ghost btn-sm" data-shift="1">Try ${esc(r.weekday)} + 1 day →</button>
        </div>
      </div>`;
  }

  const trainNames = fa.trains.map((t) => t.trainName).join(', ');

  // Sale not open yet — the headline case this site exists for.
  if (!fa.isOpen) {
    const d = splitDuration(fa.msUntil);
    return `
      <div class="answer is-pending" data-countdown="${esc(fa.opensAtISO)}">
        <span class="answer-kicker">${ICON.bell} Not on sale yet</span>
        <h2>Tickets go on sale at ${esc(saleClock(fa.openTime))} on ${esc(fa.openDatePretty)}</h2>
        <p>
          For travel on <b>${esc(r.datePretty)}</b> from ${esc(r.from.label)} to ${esc(r.to.label)}.
          Bangladesh Railway sells a rolling ${r.window.advanceDays}-day window, so
          ${esc(shortDate(fa.openDate))} is when this date can first be bought. The date becomes
          selectable at midnight BST, but the seats themselves are released at
          <b>${esc(saleClock(fa.openTime))}</b> — the countdown below runs to that moment${
            fa.openTimeSource === 'measured'
              ? ', measured from live seat data'
              : ''}. Be logged in and on the search page a minute
          early — popular ${esc(r.to.label)} trains can sell out within minutes.
        </p>
        <div class="countdown" id="countdown">
          ${['days', 'hours', 'minutes', 'seconds'].map((u) => `
            <div class="cd-unit"><b data-cd="${u}">${String(d[u]).padStart(2, '0')}</b><span>${u}</span></div>`).join('')}
        </div>
        <div class="stat-row">
          <div class="stat"><b>${r.trainsRunningOnDate}</b><span>trains running that day</span></div>
          <div class="stat"><b>${esc(shortDate(fa.openDate))}</b><span>on sale from (${esc(saleClock(fa.openTime))})</span></div>
          <div class="stat"><b>${r.dateStatus.offset}</b><span>days until travel</span></div>
        </div>
        <div class="answer-actions">
          <button class="btn" data-alarm="1">${ICON.bell} Alarm me when this opens</button>
          <button class="btn btn-ghost" data-ics="1">${ICON.cal} Add to calendar</button>
          <button class="btn btn-ghost" data-watch="1">Track availability</button>
        </div>
      </div>`;
  }

  // On sale, and we have live seat data.
  if (r.live) {
    const anySeats = r.live.onlineSeats > 0;
    return `
      <div class="answer ${anySeats ? 'is-open' : 'is-none'}">
        <span class="answer-kicker">${anySeats ? 'On sale — seats available' : 'On sale — sold out'}</span>
        <h2>${anySeats
          ? `${r.live.onlineSeats.toLocaleString()} seat${r.live.onlineSeats === 1 ? '' : 's'} left for ${esc(r.datePretty)}`
          : `Every seat for ${esc(r.datePretty)} is gone`}</h2>
        <p>
          ${esc(r.from.label)} → ${esc(r.to.label)}, checked just now against Bangladesh Railway.
          ${anySeats
            ? `${r.live.withSeats} of ${r.live.tripCount} trains still have online seats.`
            : `Seats are sometimes released back when unpaid bookings expire — re-check in a few minutes, and try the next date too.`}
        </p>
        <div class="stat-row">
          <div class="stat"><b>${r.live.onlineSeats.toLocaleString()}</b><span>seats bookable online</span></div>
          <div class="stat"><b>${r.live.withSeats}/${r.live.tripCount}</b><span>trains with seats</span></div>
          <div class="stat"><b>${esc(fa.openDatePretty.split(',')[0])}</b><span>went on sale</span></div>
        </div>
        <div class="answer-actions">
          <a class="btn" href="${esc(r.bookingUrl)}" target="_blank" rel="noopener">${ICON.ext} Book on eticket.railway.gov.bd</a>
          <button class="btn btn-ghost" data-refresh="1">Re-check seats</button>
        </div>
      </div>`;
  }

  // On sale, but no live data (no token, or live lookup failed).
  const why = r.liveError
    ? esc(r.liveError.message)
    : (isSignedIn()
      ? 'Add your Bangladesh Railway session token in Settings to see live seat counts and fares here.'
      : 'Sign in with Telegram and add your own Bangladesh Railway session to see live seat counts and fares here. Schedules and sale times need no account.');
  return `
    <div class="answer is-open">
      <span class="answer-kicker">On sale now</span>
      <h2>Tickets for ${esc(r.datePretty)} are already on sale</h2>
      <p>
        They opened at <b>${esc(saleClock(fa.openTime))}</b> on <b>${esc(fa.openDatePretty)}</b>, and
        ${r.trainsRunningOnDate} train${r.trainsRunningOnDate === 1 ? '' : 's'} run
        ${esc(r.from.label)} → ${esc(r.to.label)} that day. ${why}
      </p>
      <div class="answer-actions">
        <a class="btn" href="${esc(r.bookingUrl)}" target="_blank" rel="noopener">${ICON.ext} Check seats &amp; book</a>
        ${r.tokenPresent ? '' : '<button class="btn btn-ghost" data-open-settings="1">Enable live seat counts</button>'}
      </div>
    </div>`;
}

function renderClasses(t) {
  if (!t.live?.classes?.length) return '';
  return `<div class="classes">${t.live.classes.map((c) => `
    <div class="cls ${c.online === 0 ? 'sold' : ''} ${c.online > 20 ? 'plenty' : ''}">
      <div class="cls-name">${esc(c.seatClassLabel)}</div>
      <div class="cls-seats ${seatTone(c.online)}">${c.online === 0 ? 'Sold out' : c.online}</div>
      <div class="cls-fare">৳${Math.round(c.totalFare || c.fare).toLocaleString()}${c.online ? ' · per seat' : ''}</div>
    </div>`).join('')}</div>`;
}

function renderTrain(t, r) {
  const live = t.live;
  const cls = [
    'train',
    !t.runsOnDate ? 'is-off' : '',
    live ? (live.hasSeats ? 'has-seats' : 'no-seats') : '',
  ].filter(Boolean).join(' ');

  const badges = [];
  if (!t.runsOnDate) badges.push(`<span class="badge muted">Not running ${esc(r.weekday)}</span>`);
  if (live?.hasSeats) badges.push(`<span class="badge ok">${live.onlineSeats} seat${live.onlineSeats === 1 ? '' : 's'} left</span>`);
  else if (live) badges.push('<span class="badge danger">Sold out</span>');
  else if (t.runsOnDate && !t.sale.isOpen) badges.push(`<span class="badge warn">On sale from ${esc(shortDate(r.firstAvailability?.openDatePretty || t.sale.openDate))}</span>`);
  else if (t.runsOnDate) badges.push('<span class="badge info">On sale</span>');

  return `
  <article class="${cls}" data-train="${esc(t.trainNumber)}">
    <div class="train-main">
      <div class="train-id">
        <div class="train-name">
          <span class="train-no">${esc(t.trainNumber)}</span>
          ${esc(t.trainName.replace(/\s*\(\d+\)\s*$/, ''))}
        </div>
        <div class="train-meta">
          <span>${esc(t.originCity.replace(/_/g, ' '))} → ${esc(t.destinationCity.replace(/_/g, ' '))}</span>
          <span>·</span>
          <span>${esc(t.offDayNote)}</span>
          ${t.fromIsOrigin ? '' : '<span>·</span><span>Starts earlier up the line</span>'}
        </div>
      </div>

      <div class="leg">
        <div class="leg-end">
          <b>${esc(t.departureTime || '—')}</b>
          <span>${esc(r.from.label)}</span>
        </div>
        <div class="leg-line">
          <span class="dur">${esc(t.legDuration || '—')}</span>
          <span class="stops">${t.intermediateStops} stop${t.intermediateStops === 1 ? '' : 's'} between</span>
        </div>
        <div class="leg-end">
          <b>${esc(t.arrivalTime || '—')}</b>
          <span class="${t.arrivesNextDay ? 'nextday' : ''}">${esc(r.to.label)}${t.arrivesNextDay ? ' (+1 day)' : ''}</span>
        </div>
      </div>

      <div class="train-side">${badges.join('')}</div>
    </div>

    ${renderClasses(t)}

    <div class="train-foot">
      <button class="disclose" data-stops="${esc(t.trainNumber)}" aria-expanded="false">
        ${ICON.chevron} Full route &amp; stop times
      </button>
      <span class="grow"></span>
      <span>Sale opens ${esc(shortDate(r.firstAvailability?.openDatePretty || t.sale.openDate))}, ${esc(saleClock(t.sale.openTime))} · ${esc(t.zone)} zone counters ${esc(ampm(t.sale.zoneOpenTime))} (counter sales only)</span>
      <a class="btn btn-ghost btn-sm" href="${esc(t.bookingUrl)}" target="_blank" rel="noopener">${ICON.ext} Book</a>
    </div>

    <div class="timeline" id="tl-${esc(t.trainNumber)}" hidden></div>
  </article>`;
}

function renderResult(r) {
  const running = r.trains.filter((t) => t.runsOnDate);
  const notRunning = r.trains.filter((t) => !t.runsOnDate);

  const notices = [];
  if (r.dateStatus.kind === 'too_far') {
    notices.push(`<div class="note info">
      <b>${esc(r.datePretty)} is ${r.dateStatus.offset} days away.</b>
      The official site will not let you select it yet — only dates up to
      ${esc(r.window.lastDate)} are selectable. Everything below is from the published
      timetable; live seat counts become available once the sale opens.
    </div>`);
  }
  if (r.dateStatus.kind === 'past') {
    notices.push(`<div class="note warn"><b>That date has passed.</b>
      Shown for reference — sale and schedule details are historical.</div>`);
  }
  if (r.liveError && !r.liveError.needsAuth) {
    notices.push(`<div class="note danger"><b>Live seat lookup failed.</b> ${esc(r.liveError.message)}</div>`);
  }
  if (r.liveError?.needsAuth) {
    notices.push(`<div class="note warn"><b>Session token expired.</b> ${esc(r.liveError.message)}
      <button class="btn btn-ghost btn-sm ml-8" data-open-settings="1">Update token</button></div>`);
  }
  if (r.unmatchedLiveTrips?.length) {
    notices.push(`<div class="note info">Bangladesh Railway also listed
      ${r.unmatchedLiveTrips.length} trip${r.unmatchedLiveTrips.length === 1 ? '' : 's'} not in the local
      timetable (${esc(r.unmatchedLiveTrips.map((t) => t.trainName).join(', '))}).
      Re-sync the timetable in Settings to pick them up.</div>`);
  }

  return `
    ${renderAnswer(r)}
    ${notices.join('')}
    ${running.length ? `
      <div class="section-title">${running.length} train${running.length === 1 ? '' : 's'} on ${esc(r.datePretty)}</div>
      ${running.map((t) => renderTrain(t, r)).join('')}` : ''}
    ${notRunning.length ? `
      <div class="section-title">Also on this route — not running ${esc(r.weekday)}</div>
      ${notRunning.map((t) => renderTrain(t, r)).join('')}` : ''}
  `;
}

/* -------------------------------- countdown ------------------------------ */

function startCountdown() {
  clearInterval(state.countdownTimer);
  const box = $('[data-countdown]');
  if (!box) return;
  const target = Date.parse(box.dataset.countdown);

  const tick = () => {
    const ms = target - Date.now();
    if (ms <= 0) {
      clearInterval(state.countdownTimer);
      toast('Tickets just went on sale — refreshing.', 'good');
      doSearch();
      return;
    }
    const d = splitDuration(ms);
    for (const u of ['days', 'hours', 'minutes', 'seconds']) {
      const el = $(`[data-cd="${u}"]`, box);
      if (el) el.textContent = String(d[u]).padStart(2, '0');
    }
  };
  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

/* --------------------------------- search -------------------------------- */

function currentQuery() {
  return { from: fromCombo.value, to: toCombo.value, date: $('#date-input').value };
}

function syncUrl(q) {
  const u = new URL(location.href);
  u.searchParams.set('from', q.from);
  u.searchParams.set('to', q.to);
  u.searchParams.set('date', q.date);
  history.replaceState(null, '', u);
}

async function doSearch() {
  const q = currentQuery();
  if (!q.from || !q.to || !q.date) {
    toast('Choose both stations and a journey date.', 'err');
    return;
  }
  if (state.searching) return;
  state.searching = true;

  const btn = $('#search-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Checking';
  $('#results').innerHTML = '<div class="skeleton sk-150"></div><div class="skeleton"></div><div class="skeleton"></div>';
  $('#earliest-slot').innerHTML = '';

  try {
    const r = await api(`/api/search?from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}&date=${encodeURIComponent(q.date)}`);
    state.result = r;
    $('#results').innerHTML = renderResult(r);
    startCountdown();
    syncUrl(q);
    loadCalendar(q).catch(() => {});
    refreshMeta().catch(() => {});
  } catch (err) {
    $('#results').innerHTML = `
      <div class="answer is-none">
        <span class="answer-kicker">Could not search</span>
        <h2>${esc(err.message)}</h2>
        ${err.data?.suggestions?.length
          ? `<p>Try: ${err.data.suggestions.map((s) => `<button class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join(' ')}</p>`
          : '<p>Check the station names and date, then try again.</p>'}
      </div>`;
  } finally {
    state.searching = false;
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4.3-4.3"/></svg> Find`;
  }
}

/* ------------------------------ stop timeline ---------------------------- */

const stopsCache = new Map();

async function toggleStops(trainNumber, btn) {
  const box = $(`#tl-${CSS.escape(trainNumber)}`);
  const open = btn.getAttribute('aria-expanded') === 'true';
  if (open) {
    box.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  btn.setAttribute('aria-expanded', 'true');
  box.hidden = false;

  if (!stopsCache.has(trainNumber)) {
    box.innerHTML = '<div class="skeleton sk-110"></div>';
    try {
      stopsCache.set(trainNumber, await api(`/api/train?number=${encodeURIComponent(trainNumber)}`));
    } catch (err) {
      box.innerHTML = `<div class="note danger">${esc(err.message)}</div>`;
      return;
    }
  }

  const t = stopsCache.get(trainNumber);
  const r = state.result;
  const boardIdx = t.stops.findIndex((s) => s.city === r.from.city);
  const alightIdx = t.stops.findIndex((s, i) => s.city === r.to.city && i > boardIdx);

  box.innerHTML = `
    <div class="note mb-10">
      <b>${esc(t.trainName)}</b> runs the full ${esc(t.originLabel)} → ${esc(t.destinationLabel)} route
      in ${esc(t.totalDuration || '—')} across ${t.stops.length} stops.
      ${t.offDay ? `Off day: <b>${esc(t.offDay)}</b>.` : 'Runs every day.'}
      Your leg is highlighted.
    </div>
    ${t.stops.map((s, i) => {
      const isBoard = i === boardIdx;
      const isAlight = i === alightIdx;
      const inLeg = boardIdx >= 0 && alightIdx >= 0 && i >= boardIdx && i < alightIdx;
      const outside = boardIdx >= 0 && alightIdx >= 0 && (i < boardIdx || i > alightIdx);
      return `
        <div class="tl-row ${isBoard ? 'is-board' : ''} ${isAlight ? 'is-alight' : ''} ${inLeg ? 'is-leg' : ''} ${outside ? 'is-outside' : ''}">
          <div class="tl-time">${esc(s.arrival || s.departure || '—')}</div>
          <div class="tl-dot"><i></i></div>
          <div class="tl-city">
            ${esc(s.label)}
            ${isBoard ? '<span class="badge ok ml-6">Board here</span>' : ''}
            ${isAlight ? '<span class="badge danger ml-6">Get off here</span>' : ''}
          </div>
          <div class="tl-halt">
            ${s.arrival && s.departure ? `${esc(s.arrival)}–${esc(s.departure)}` : ''}
            ${s.haltMinutes ? ` · ${s.haltMinutes}m halt` : ''}
          </div>
        </div>`;
    }).join('')}`;
}

/* ----------------------------- sale calendar ----------------------------- */

async function loadCalendar(q) {
  const cal = await api(`/api/calendar?from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}&days=60`);
  state.calendar = cal;

  const days = cal.days.filter((d) => d.trainsRunning > 0 || d.status === 'bookable');
  $('#calendar-slot').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Sale-open calendar — next 60 days</h2>
        <span class="sub">${esc(cal.from.label)} → ${esc(cal.to.label)}. Tap a date to search it.</span>
      </div>
      <div class="card-body">
        <div class="cal-strip">
          ${days.map((d) => `
            <button class="cal-day st-${d.trainsRunning ? d.status : 'none'} ${d.date === q.date ? 'sel' : ''}"
                    type="button" data-cal-date="${esc(d.date)}"
                    title="${d.saleOpensAt ? `Seats released ${esc(dhakaDateTime(d.saleOpensAt))}` : 'No train runs this route'}">
              <div class="cd-date">${esc(d.datePretty.replace(/,.*$/, ''))}</div>
              <div class="cd-wd">${esc(d.weekday)}</div>
              <div class="cd-note">${
                !d.trainsRunning ? 'No service'
                  : d.status === 'bookable' ? (d.saleIsOpen ? 'On sale now' : `Opens ${ampm(d.saleOpenTime)}`)
                  : `Opens ${esc(shortDate(d.saleOpenDatePretty))}`
              }</div>
            </button>`).join('')}
        </div>
        <div class="legend">
          <span><i class="swatch-ok"></i>Inside the ${cal.window.advanceDays}-day window — buy now</span>
          <span><i class="swatch-warn"></i>Sale opens on the date shown</span>
          <span><i class="swatch-muted"></i>No train runs this route</span>
        </div>
      </div>
    </div>`;
}

/* --------------------------- earliest-seat scan -------------------------- */

async function loadEarliest() {
  const q = currentQuery();
  if (!q.from || !q.to) { toast('Choose both stations first.', 'err'); return; }

  $('#earliest-slot').innerHTML = `
    <div class="card"><div class="card-head"><h2>Scanning the selling window…</h2></div>
    <div class="card-body"><div class="skeleton sk-80"></div></div></div>`;

  try {
    const e = await api(`/api/earliest?from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}`);
    state.earliest = e;

    const head = !e.tokenPresent
      ? `<div class="note warn"><b>Live seat counts need a session token.</b>
           Without one this only shows which days have service, not which have seats.
           <button class="btn btn-ghost btn-sm ml-8" data-open-settings="1">Add token</button></div>`
      : e.needsAuth
        ? '<div class="note danger"><b>Token rejected.</b> Add a fresh one in Settings.</div>'
        : e.earliest
          ? `<div class="note ok"><b>Earliest date with a bookable seat:
               ${esc(e.earliest.datePretty)}</b> — ${e.earliest.seatsOnline} seat${e.earliest.seatsOnline === 1 ? '' : 's'}
               across ${e.earliest.trainsWithSeats} train${e.earliest.trainsWithSeats === 1 ? '' : 's'}.</div>`
          : '<div class="note danger"><b>No seats anywhere in the current 10-day window.</b> The next dates open day by day — check the sale calendar above.</div>';

    $('#earliest-slot').innerHTML = `
      <div class="card">
        <div class="card-head">
          <h2>Earliest date with a seat</h2>
          <span class="sub">Every date currently on sale, ${esc(q.from)} → ${esc(q.to)}</span>
        </div>
        <div class="card-body">
          ${head}
          <div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Day</th><th class="num">Trains</th><th class="num">Seats online</th><th>Status</th><th></th></tr></thead>
            <tbody>${e.days.map((d) => `
              <tr>
                <td><b>${esc(d.datePretty.replace(/,.*$/, ''))}</b></td>
                <td>${esc(d.weekday)}</td>
                <td class="num">${d.trainsRunning}</td>
                <td class="num">${d.seatsOnline == null ? '—' : d.seatsOnline}</td>
                <td>${{
                  available: '<span class="badge ok">Seats available</span>',
                  sold_out: '<span class="badge danger">Sold out</span>',
                  no_service: '<span class="badge muted">No service</span>',
                  error: `<span class="badge warn">${esc(d.error || 'Error')}</span>`,
                  unknown: '<span class="badge info">Not checked</span>',
                }[d.status] || esc(d.status)}</td>
                <td><button class="chip" data-cal-date="${esc(d.date)}">Search</button></td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </div>
      </div>`;
  } catch (err) {
    $('#earliest-slot').innerHTML = `<div class="card"><div class="card-body"><div class="note danger">${esc(err.message)}</div></div></div>`;
  }
}

/* -------------------------------- calendar .ics -------------------------- */

function downloadReminder() {
  const r = state.result;
  const fa = r?.firstAvailability;
  if (!fa) return;

  const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const start = Date.parse(fa.opensAtISO);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BR First Availability//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:br-${r.from.city}-${r.to.city}-${r.date}@local`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(fa.opensAtISO)}`,
    `DTEND:${stamp(new Date(start + 30 * 60000).toISOString())}`,
    `SUMMARY:Train tickets on sale: ${r.from.label} -> ${r.to.label} (${r.datePretty})`,
    `DESCRIPTION:Bangladesh Railway opens sales for ${r.datePretty} now.\\nTrains: ${fa.trains.map((t) => t.trainName).join(', ')}\\nBook: ${r.bookingUrl}`,
    `URL:${r.bookingUrl}`,
    'BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', 'DESCRIPTION:Train tickets open in 10 minutes', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');

  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `br-sale-${r.from.city}-${r.to.city}-${r.date}.ics`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Reminder downloaded — open it to add to your calendar.', 'good');
}

/* -------------------------------- drawers -------------------------------- */

function openDrawer(id) {
  $('#scrim').hidden = false;
  $(`#${id}`).hidden = false;
}
function closeDrawers() {
  $('#scrim').hidden = true;
  $('#settings-drawer').hidden = true;
  $('#history-drawer').hidden = true;
  $('#alarms-drawer').hidden = true;
  stopPairingPoll();
}

/* --------------------------- sale-open alarms ---------------------------- */

/**
 * The whole login: one random secret, minted when a Telegram chat is paired.
 *
 * The key name is unchanged from when this only guarded alarms, so nobody who
 * already paired gets signed out by this becoming a general account.
 */
const NOTIFY_KEY = 'br-notify-token';
const sessionToken = {
  get: () => localStorage.getItem(NOTIFY_KEY) || null,
  set: (v) => (v ? localStorage.setItem(NOTIFY_KEY, v) : localStorage.removeItem(NOTIFY_KEY)),
};

/** api() already attaches the session; kept as the name the alarm code uses. */
const napi = api;

function updateAlarmBadge() {
  const n = state.notify.alerts?.active ?? 0;
  $('#alarms-badge').textContent = n ? `Alarms · ${n}` : 'Alarms';
  $('#alarms-btn').classList.toggle('has-alarms', n > 0);
}

function stopPairingPoll() {
  if (state.notify.pollTimer) {
    clearInterval(state.notify.pollTimer);
    state.notify.pollTimer = null;
  }
}

/** Load status + alerts. Silently tolerates a stale token from a wiped database. */
async function refreshAlarms() {
  const status = await api('/api/notify/status');
  state.notify.status = status;

  if (!status.connected) {
    if (sessionToken.get()) sessionToken.set(null); // Secret no longer recognised.
    state.notify.alerts = null;
  } else {
    state.notify.alerts = await napi('/api/notify/alerts');
  }
  updateAlarmBadge();
  return status;
}

/**
 * The bot panel.
 *
 * A bot belongs to whoever paired on it first, so there is no site-wide bot to
 * describe any more and nothing here is shown to a stranger. It renders one of
 * three things: the form on its own (you have no bot — pasting a token is how
 * you sign up), your own bot with the option to replace or disconnect it, or a
 * note that you are on this site's shared bot, which nobody may change here.
 */
function botTokenForm(status, { collapsed = false } = {}) {
  const bot = status.bot || {};
  const mine = isSignedIn() && bot.present;

  const form = `
    <div class="field mb-11">
      <label for="bot-token-input">Bot token from @BotFather</label>
      <textarea class="control" id="bot-token-input"
        placeholder="123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"></textarea>
    </div>
    <div class="btn-row">
      <button class="btn btn-sm" id="bot-token-save">Save &amp; verify</button>
      ${mine && bot.isOwner && !bot.isDefault
        ? '<button class="btn btn-ghost btn-sm" id="bot-token-clear">Disconnect bot</button>'
        : ''}
    </div>
    <p class="mt-11 fine">
      Verified with Telegram before it is stored, then kept in this project's own
      database and sent only to api.telegram.org. It never comes back to this page —
      only the masked preview. Your bot is yours: nobody else signed in here can see
      it, use it, or change it.
    </p>`;

  const owned = mine && !bot.isDefault
    ? `<p class="fine">Your bot: <b>@${esc(bot.username || '')}</b>
        <code>${esc(bot.preview || '')}</code>${bot.savedAt
          ? ` — connected ${esc(new Date(bot.savedAt).toLocaleString())}` : ''}${bot.isOwner
          ? '' : '<br>Connected by whoever paired on it first, so only they can change it.'}</p>`
    : '';

  const shared = mine && bot.isDefault
    ? `<div class="note">You are on this site's shared bot, which the deployment
        configures — it is not yours to change. For a bot of your own, make one with
        <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> and paste
        its token below. Connecting to it gives you a separate account here.</div>`
    : '';

  const inner = `${shared}${owned}${form}`;
  if (!collapsed) return inner;

  const summary = mine && !bot.isDefault
    ? `Your bot${bot.username ? ` — @${esc(bot.username)}` : ''}`
    : 'Use a Telegram bot of your own';
  return `
    <details class="bot-token-details">
      <summary>${summary}</summary>
      <div class="mt-10">${inner}</div>
    </details>`;
}

async function saveBotToken(token) {
  const btn = $('#bot-token-save');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Verifying…'; }
  try {
    const res = await api('/api/notify/bot', { method: 'POST', body: { token } });
    toast(`Connected to @${res.botUsername}.`, 'good');
    if (res.webhookRemoved) {
      toast('A webhook was registered on that bot and has been removed — it would have blocked pairing.', '');
    }
    if (res.webhookBlocked) {
      toast(`Saved, but its webhook could not be registered: ${res.webhookBlocked}.`, 'err');
    }
    if (isSignedIn()) {
      toast('Connecting to this bot gives you a separate account — your current alarms stay on the bot you are signed in with.', '');
    }
    // Pairing is what claims a bot, so go straight there: a bot nobody has
    // paired on yet is still unclaimed, and the first chat to arrive owns it.
    state.notify.pendingBot = res.botId;
    await renderAlarms();
    if ($('#pair-slot')) startPairing();
  } catch (err) {
    toast(err.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = 'Save & verify'; }
  }
}

async function renderAlarms() {
  openDrawer('alarms-drawer');
  const body = $('#alarms-body');
  body.innerHTML = '<div class="skeleton sk-120"></div>';

  let status;
  try {
    status = await refreshAlarms();
  } catch (err) {
    body.innerHTML = `<div class="note danger">${esc(err.message)}</div>`;
    return;
  }

  if (!status.connected) {
    const shared = status.sharedBot;
    body.innerHTML = `
      <h3>Sign in with Telegram</h3>
      <p>Connecting a Telegram chat is the whole sign-in — no password, no email. It links this
      browser to your own account, so your alarms, your railway session and your bot stay yours
      and nobody else signed in here can see them. Nothing but your Telegram chat id and display
      name is stored.</p>
      ${shared ? `
        <div id="pair-slot">
          <button class="btn" id="pair-start">Connect Telegram</button>
        </div>
        <p class="mt-11 fine">Connects you to this site's shared bot,
          <b>@${esc(shared.username || '')}</b>. You can bring your own instead — see below.</p>`
      : `
        <div class="note warn">
          <b>This site has no shared bot</b>, so alarms are delivered by a bot you make and own.
          It takes about a minute:
        </div>
        <ol>
          <li>Open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> in Telegram and send <code>/newbot</code>.</li>
          <li>Give it any name and a username ending in <code>bot</code>.</li>
          <li>Copy the token it replies with and paste it below.</li>
        </ol>
        <div id="pair-slot"></div>`}
      <p class="mt-11 fine">You can set up to ${status.limit} alarms at a time.</p>
      ${botTokenForm(status, { collapsed: Boolean(shared) })}`;
    return;
  }

  const { alerts, active, limit, remaining } = state.notify.alerts;
  const pending = alerts.filter((a) => a.status === 'active');
  const done = alerts.filter((a) => a.status !== 'active').slice(0, 8);
  const TEST_DELAY = status.testDelaySeconds ?? 15;

  const inbound = status.inboundBlocked
    ? `<div class="note danger">
        <b>Buttons and commands are not reaching the bot.</b>
        <br>${esc(status.inboundBlocked)}.
        <br>Alarms will still ring — only <b>Stop alarm</b>, <code>/start</code> and
        <code>/stop</code> are affected. Set it in your hosting environment variables,
        redeploy, and it repairs itself within a minute.
      </div>`
    : status.webhook?.lastError
      ? `<div class="note warn">
          <b>Telegram could not deliver the last update</b> to
          ${esc(status.webhook.url || 'the webhook')}:
          <br><code>${esc(status.webhook.lastError)}</code>${status.webhook.lastErrorAt
            ? ` (${esc(dhakaDateTime(status.webhook.lastErrorAt))})` : ''}
          ${status.webhook.pending ? `<br>${status.webhook.pending} update(s) queued.` : ''}
        </div>`
      : '';

  body.innerHTML = `
    ${inbound}
    <div class="note ok">
      <b>Connected to Telegram</b>${status.subscriber?.displayName ? ` — ${esc(status.subscriber.displayName)}` : ''}
      ${status.botUsername ? `<br>via <b>@${esc(status.botUsername)}</b>${status.bot?.isDefault ? " (this site's shared bot)" : ''}` : ''}
      <br>${active} of ${limit} alarm${limit === 1 ? '' : 's'} in use.
    </div>

    <div class="test-alarm">
      <div class="grow">
        <b>Does it actually reach you?</b>
        <small>Sends one real alarm through the real scheduler in ${TEST_DELAY}s — same message,
        same trigger tag, so it exercises your phone automation end to end.
        It does not use one of your ${limit} slots.</small>
      </div>
      <button class="btn btn-sm" id="test-alarm">Send a test alarm</button>
    </div>

    <h3>Pending alarms</h3>
    ${pending.length
      ? pending.map((a) => `
        <div class="watch-item${a.isTest ? ' is-test' : ''}">
          <span class="grow">
            <b>${a.isTest ? '🔔 Test alarm — ' : ''}${esc(a.fromLabel)} → ${esc(a.toLabel)}</b>
            <small>${a.isTest ? 'drill, no slot used' : `travel ${esc(a.journeyDatePretty)}`} · rings <span class="alarm-when" data-opens="${esc(a.opensAt)}">${esc(dhakaDateTime(a.opensAt))}</span></small>
          </span>
          <button class="chip" data-cancel-alarm="${a.id}">Cancel</button>
        </div>`).join('')
      : '<p class="fine">No alarms set yet. Search for a date that is not on sale yet, then press <b>Alarm me when this opens</b>.</p>'}

    ${remaining === 0 ? '<div class="note warn">All alarm slots are in use. Cancel one to add another.</div>' : ''}

    ${done.length ? `
      <h3>Recent</h3>
      ${done.map((a) => `
        <div class="watch-item">
          <span class="grow">
            <b>${a.isTest ? '🔔 Test — ' : ''}${esc(a.fromLabel)} → ${esc(a.toLabel)}</b>
            <small>${esc(a.journeyDatePretty)} · ${esc(a.status)}${a.firedAt ? ` ${esc(dhakaDateTime(a.firedAt))}` : ''}${a.lastError ? ` · ${esc(a.lastError)}` : ''}</small>
          </span>
        </div>`).join('')}` : ''}

    <h3>How it fires</h3>
    <p>Bangladesh Railway releases a journey date's seats at
    <b>${esc(saleClock(metaSaleOpen()?.time))}</b>, exactly
    ${state.meta?.window?.advanceDays ?? 10} days ahead — the date turns selectable at midnight,
    but the seats appear later that morning, so an alarm at midnight would wake you for an empty
    page. That moment is known in advance, so the alarm is scheduled on it rather than polled for
    — it rings on the second, with no session token needed.</p>
    <p class="fine">${metaSaleOpen()?.source === 'measured'
      ? `That time was <b>measured</b> from live seat data — this date was still closed at
         ${esc(metaSaleOpen().closedAt || '?')} and had seats by
         ${esc(metaSaleOpen().measuredAt || '?')} Dhaka${metaSaleOpen()?.precisionSeconds
           ? ` (±${metaSaleOpen().precisionSeconds}s)` : ''}, so the release is between the two.`
      : `Bangladesh Railway does not publish this time, so it starts from the documented default
         and is corrected only when the app watches a date go from closed to open — seeing seats
         already on sale proves nothing about when they arrived.${metaSaleOpen()?.inconclusive
           ? ` (Today told us nothing: ${esc(metaSaleOpen().inconclusive.reason || 'no closed sighting')}.)`
           : ''}`}</p>
    <p class="fine">${status.repeats
      ? `It re-rings every ${status.ringIntervalSeconds ?? 10} seconds for up to ${status.ringMinutes ?? 15} minutes until you tap <b>Stop alarm</b>.`
      : 'You get <b>one</b> message per alarm — the ringing is your phone\'s job (below), so repeats would only clutter the chat. Delivery is retried behind the scenes if Telegram is slow, but only ever one message arrives.'}
    Send <code>/stop</code> to the bot to cancel everything at once.</p>

    <h3>Make your phone actually ring</h3>
    <p>A Telegram bot can only post messages — it cannot play a ringing tone, and the sound a
    notification makes is your Telegram setting, not something this app can choose. To get a
    real alarm that rings until you dismiss it, let your <b>phone</b> do the ringing and use the
    Telegram message purely as the trigger.</p>

    <div class="note ok">
      <b>Android — this works properly.</b> Install
      <a href="https://play.google.com/store/apps/details?id=com.arlosoft.macrodroid" target="_blank" rel="noopener">MacroDroid</a>
      (free tier is enough) and build one macro:
      <ol class="mt-10">
        <li><b>Trigger</b> → Device Events → <b>Notification Received</b> → application
          <b>Telegram</b> → “Text content contains” → the tag below.</li>
        <li><b>Action</b> → Media → <b>Play Sound / Vibrate</b>, choose an alarm tone, tick
          <b>Loop</b>, and set the stream to <b>Alarm</b> (alarm volume ignores silent mode).</li>
        <li><b>Action</b> → Volume → set <b>Alarm volume</b> to max, so it is loud regardless.</li>
      </ol>
      Tasker (with AutoNotification) and Automate do the same thing if you prefer them.
    </div>

    <p class="mt-11">Match on this exact tag — it is in every alarm, including test alarms, and
    never changes with route, date or wording:</p>
    <div class="snippet-row">
      <code id="trigger-tag">${esc(status.triggerTag || '#RAILALARM')}</code>
      <button class="chip" id="copy-tag" type="button">Copy</button>
    </div>

    <h3>Stopping the ringing</h3>
    <p>Your phone started the sound, so your phone has to stop it — and the
    <b>Stop alarm</b> button cannot be what does it, for a reason worth knowing:
    tapping it means you are <i>looking at the chat</i>, and Telegram posts no
    notification for the chat currently on screen. There is nothing for a macro
    to see. Build the stop macro on one of these instead.</p>

    <div class="note ok">
      <b>Best — the notification going away is the signal.</b> Add a second macro:
      <ol class="mt-10">
        <li><b>Trigger</b> → Device Events → <b>Notification Removed</b> (some versions call it
          <i>Notification Cleared</i>) → application <b>Telegram</b> → “Text content contains” →
          <code>${esc(status.triggerTag || '#RAILALARM')}</code>.</li>
        <li><b>Action</b> → Media → <b>Stop Sound / Vibrate</b>.</li>
      </ol>
      Opening the chat or swiping the alarm away clears that notification, which fires this
      macro — so the sound stops the moment you actually deal with the alarm.
    </div>

    <div class="note">
      <b>Also add a manual stop, so you are never trapped by a macro that did not fire.</b>
      MacroDroid → <b>Quick Settings tile</b> or a home-screen widget, action
      <b>Stop Sound / Vibrate</b>. This is the one that always works.
    </div>

    <p class="mt-11">And if you tap <b>Stop alarm</b> from <b>another</b> device — Telegram
    Desktop, a tablet, a second phone — the ringing handset does get a silent message. That case
    <i>can</i> be automated, on this tag:</p>
    <div class="snippet-row">
      <code id="stop-tag">${esc(status.stopTag || '#RAILSTOP')}</code>
      <button class="chip" id="copy-stop-tag" type="button">Copy</button>
    </div>
    <p class="fine">Same macro shape as the start one — <b>Notification Received</b> →
    Telegram → text contains this → <b>Stop Sound / Vibrate</b>. It is a bonus, not the
    primary stop: it cannot fire when the chat you tapped in is the one on screen.</p>
    <p class="fine">Press <b>Send a test alarm</b> above once the macro is set up — the drill
    carries the same tag, so it is a genuine end-to-end test of the whole chain.</p>

    <div class="note warn">
      <b>iPhone:</b> iOS has no way for an app or Shortcut to react to another app's
      notification, so this trick does not exist there. The closest options are turning on
      Telegram's loudest notification sound with <b>Notifications → override mute</b>, or having
      the sound come from somewhere else entirely — say the machine running this server. Ask and
      I can wire that up.
    </div>

    <div class="note">
      <b>Whichever route you take</b>, set the Telegram side too: bot chat →
      <b>Notifications</b> → Sound on, longest tone, and enable the exception that overrides
      mute. On Android, let Telegram bypass Do Not Disturb.
    </div>

    ${botTokenForm(status, { collapsed: true })}`;
}

async function startPairing() {
  const slot = $('#pair-slot');
  slot.innerHTML = '<div class="skeleton sk-120"></div>';
  let pairing;
  try {
    pairing = await api('/api/notify/pair', {
      method: 'POST',
      // A code is minted for one bot. Naming the one just pasted is what sends
      // the user to their own bot rather than to the site's shared one.
      body: { bot: state.notify.pendingBot || null },
    });
  } catch (err) {
    slot.innerHTML = `<div class="note danger">${esc(err.message)}</div>`;
    return;
  }

  slot.innerHTML = `
    <a class="btn" href="${esc(pairing.deepLink)}" target="_blank" rel="noopener">
      Open @${esc(pairing.botUsername)} in Telegram
    </a>
    <p class="mt-11">Tap the link, then press <b>Start</b>. This page will notice on its own.</p>

    <div class="note warn">
      <b>No Start button?</b> Telegram only shows it the first time you open a bot.
      If you have opened <b>@${esc(pairing.botUsername)}</b> before — say, while testing it —
      the link just opens the chat and nothing happens. Send it this code instead:
      <div class="snippet-row mt-10">
        <code id="pair-code">${esc(pairing.code)}</code>
        <button class="chip" id="copy-code" type="button">Copy</button>
      </div>
      <span class="fine">Paste it on its own, or as <code>/start ${esc(pairing.code)}</code>. Valid 15 minutes.</span>
    </div>

    <div class="note"><span class="spinner"></span> Waiting for you to connect…</div>`;

  stopPairingPoll();
  state.notify.pollTimer = setInterval(async () => {
    let res;
    try {
      res = await api(`/api/notify/pair?code=${encodeURIComponent(pairing.code)}`);
    } catch { return; }

    if (res.claimed) {
      stopPairingPoll();
      state.notify.pendingBot = null;
      sessionToken.set(res.subscriber.accessToken);
      toast('Telegram connected — you can set alarms now.', 'good');
      renderAlarms();
    } else if (res.expired) {
      stopPairingPoll();
      slot.innerHTML = `
        <div class="note warn">That link expired. Try again.</div>
        <button class="btn" id="pair-start">Connect Telegram</button>`;
    }
  }, 2000);
}

/** Set an alarm for whatever the answer panel is currently showing. */
async function setAlarmForCurrent() {
  const q = currentQuery();
  const status = state.notify.status || await refreshAlarms().catch(() => null);

  if (!status?.configured) { renderAlarms(); return; }
  if (!status.connected) {
    toast('Connect Telegram first — one tap.', '');
    renderAlarms();
    return;
  }

  try {
    const res = await napi('/api/notify/alerts', {
      method: 'POST',
      body: { from: q.from, to: q.to, date: q.date },
    });
    state.notify.alerts = { alerts: res.alerts, active: res.active, limit: res.limit, remaining: res.remaining };
    updateAlarmBadge();
    toast(`Alarm set — Telegram will ring when ${res.alert.journeyDatePretty} opens.`, 'good');
  } catch (err) {
    toast(err.message, 'err');
    if (err.status === 401) renderAlarms();
  }
}

/**
 * Fire a drill for the route currently on screen, so the message names
 * something recognisable. The server falls back if the route has no service.
 */
async function sendTestAlarm() {
  const btn = $('#test-alarm');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Scheduling…'; }

  const q = state.result ? currentQuery() : {};
  try {
    const res = await napi('/api/notify/test', {
      method: 'POST',
      body: { from: q.from || null, to: q.to || null, date: q.date || null },
    });
    toast(`Test alarm scheduled — it starts ringing in ${res.alert.delaySeconds}s and keeps going until you stop it.`, 'good');
    await renderAlarms();
  } catch (err) {
    toast(err.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = 'Send a test alarm'; }
  }
}

async function cancelAlarm(id) {
  try {
    const res = await napi(`/api/notify/alerts?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.notify.alerts = res;
    updateAlarmBadge();
    toast('Alarm cancelled.', '');
    renderAlarms();
  } catch (err) { toast(err.message, 'err'); }
}

async function renderSettings() {
  openDrawer('settings-drawer');
  const body = $('#settings-body');
  body.innerHTML = '<div class="skeleton sk-120"></div>';

  const [meta, watch] = await Promise.all([api('/api/meta'), api('/api/watchlist')]);
  state.meta = meta;
  const tk = meta.token;
  const signedIn = Boolean(meta.account?.signedIn);

  body.innerHTML = `
    ${signedIn
      ? `<div class="note ok"><b>Signed in${meta.account.displayName ? ` as ${esc(meta.account.displayName)}` : ''}.</b>
           Your railway session and your alarms are visible only to you.
           <div class="btn-row mt-10"><button class="btn btn-ghost btn-sm" data-signout="1">Sign out of this browser</button></div>
         </div>`
      : ''}

    <h3>Live seat counts</h3>
    ${!signedIn
      ? signInPrompt('a Bangladesh Railway session')
      : tk.present
      ? `<div class="note ${tk.expired ? 'danger' : 'ok'}">
           <b>${tk.expired ? 'Token expired' : 'Token active'}</b> — ${esc(tk.preview)}
           ${tk.subject ? `<br>Account: ${esc(tk.subject)}` : ''}
           ${tk.expiresAt ? `<br>Expires: ${esc(new Date(tk.expiresAt).toLocaleString())}` : ''}
           <br>Device id: ${tk.hasDeviceId ? 'captured' : '<b>not captured</b> — searches may be rejected'}
           ${tk.fromEnv ? '<br>Loaded from the BR_TOKEN environment variable.' : ''}
         </div>`
      : `<div class="note warn"><b>No token yet.</b> Schedules and sale-open times work without one.
           Seat counts, fares and the availability archive need a railway session.</div>`}

    ${!signedIn ? '' : `
    <p>Bangladesh Railway protects its login with a Cloudflare challenge, so this site
    cannot log in for you. Instead it reuses <em>your own</em> browser session. It is stored
    against your account alone — no other visitor can see it, use it or replace it.</p>

    <div class="note">
      <b>The token alone is not enough.</b> Every request the official site makes also carries
      an <code>X-Device-Id</code> — a browser fingerprint it saves as <code>uudid</code> — and the
      session is tied to it. A token copied without it is rejected exactly as if it had expired.
    </div>

    <ol>
      <li>Open <a href="https://eticket.railway.gov.bd" target="_blank" rel="noopener">eticket.railway.gov.bd</a> and sign in.</li>
      <li>Open DevTools (<code>⌥⌘I</code> on Mac, <code>F12</code> on Windows) and pick the <b>Console</b> tab.</li>
      <li>Paste this line and press Enter — it copies all three values to your clipboard:</li>
    </ol>
    <div class="snippet-row">
      <code id="creds-snippet">${esc(CREDS_SNIPPET)}</code>
      <button class="chip" id="copy-snippet" type="button">Copy</button>
    </div>
    <ol start="4">
      <li>Paste the result below.</li>
    </ol>

    <div class="field mb-11">
      <label for="token-input">Session token (or the copied snippet output)</label>
      <textarea class="control" id="token-input" placeholder='{"token":"eyJ0eXAiOiJKV1Qi...","deviceId":"a1b2c3..."}'></textarea>
    </div>
    <div class="btn-row">
      <button class="btn btn-sm" id="token-save">Save &amp; verify</button>
      ${tk.present ? '<button class="btn btn-ghost btn-sm" id="token-clear">Remove token</button>' : ''}
    </div>
    <p class="mt-11 fine">
      A bare token still works if a device id was captured previously. Both are stored only in
      this project's own database, on your own account row, and sent only back to
      railway.gov.bd. The session expires on its own — re-run the snippet when it does.
    </p>`}

    <h3>Timetable catalog</h3>
    <dl class="kv">
      <dt>Trains</dt><dd>${meta.catalog.trains}</dd>
      <dt>Stations</dt><dd>${meta.catalog.stations}</dd>
      <dt>Stops</dt><dd>${meta.catalog.stops.toLocaleString()}</dd>
      <dt>Last synced</dt><dd>${meta.catalog.syncedAt ? esc(new Date(meta.catalog.syncedAt).toLocaleString()) : 'never'}</dd>
    </dl>
    <p class="mt-10">Re-sync after a timetable change. Takes about a minute.</p>
    <button class="btn btn-ghost btn-sm" id="sync-btn" ${meta.sync.running ? 'disabled' : ''}>
      ${meta.sync.running ? `<span class="spinner"></span> Syncing ${meta.sync.done}/${meta.sync.total}` : 'Re-sync timetable'}
    </button>

    <h3>Tracked routes</h3>
    <p>Tracked routes are swept hourly so their availability history builds up over time.
    The list and the history it produces are shared by everyone; changing it needs an account.</p>
    ${watch.watches.length
      ? watch.watches.map((w) => `
          <div class="watch-item">
            <span class="grow"><b>${esc(w.fromLabel)} → ${esc(w.toLabel)}</b>
              <small>${w.snapshots} snapshot${w.snapshots === 1 ? '' : 's'}${w.lastRunAt ? ` · last swept ${esc(new Date(w.lastRunAt).toLocaleString())}` : ' · not swept yet'}</small>
            </span>
            <button class="chip" data-unwatch="${esc(w.fromCity)}|${esc(w.toCity)}">Remove</button>
          </div>`).join('')
      : '<div class="note">No routes tracked yet. Search a route, then use “Track this route’s availability”.</div>'}
    ${signedIn
      ? '<button class="btn btn-ghost btn-sm mt-9" id="collect-btn">Sweep tracked routes now</button>'
      : '<p class="fine mt-9">Sign in to change tracked routes or sweep them now.</p>'}
  `;

  $('#token-save')?.addEventListener('click', async () => {
    const token = $('#token-input').value.trim();
    const btn = $('#token-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Verifying';
    try {
      await api('/api/token', { method: 'POST', body: { token } });
      toast('Token verified — live seat counts are on.', 'good');
      await renderSettings();
      if (state.result) doSearch();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = 'Save & verify';
    }
  });

  $('#token-clear')?.addEventListener('click', async () => {
    await api('/api/token', { method: 'POST', body: { token: '' } });
    toast('Token removed.');
    renderSettings();
  });

  $('#sync-btn')?.addEventListener('click', async () => {
    await api('/api/sync', { method: 'POST' });
    toast('Timetable sync started — about a minute.');
    const poll = setInterval(async () => {
      const s = await api('/api/sync');
      const btn = $('#sync-btn');
      if (!btn) { clearInterval(poll); return; }
      if (s.running) {
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner"></span> Syncing ${s.done}/${s.total}`;
      } else {
        clearInterval(poll);
        toast('Timetable up to date.', 'good');
        await loadStations();
        renderSettings();
      }
    }, 1500);
  });

  $('#collect-btn')?.addEventListener('click', async () => {
    const btn = $('#collect-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Sweeping';
    try {
      const r = await api('/api/collect', { method: 'POST' });
      toast(r.skipped
        ? (r.reason === 'no-token' ? 'Add a session token first.' : 'No routes tracked yet.')
        : `Recorded ${r.recorded} snapshot(s).`, r.skipped ? 'err' : 'good');
    } catch (err) { toast(err.message, 'err'); }
    renderSettings();
  });

  $$('[data-unwatch]', body).forEach((b) => b.addEventListener('click', async () => {
    const [f, t] = b.dataset.unwatch.split('|');
    await api(`/api/watchlist?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`, { method: 'DELETE' });
    renderSettings();
  }));
}

async function renderHistory() {
  openDrawer('history-drawer');
  const body = $('#history-body');
  body.innerHTML = '<div class="skeleton sk-120"></div>';

  const q = currentQuery();
  const hasRoute = q.from && q.to;
  const url = hasRoute
    ? `/api/history?from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}${q.date ? `&date=${encodeURIComponent(q.date)}` : ''}`
    : '/api/history';

  let h;
  try { h = await api(url); }
  catch { h = await api('/api/history'); }

  const o = h.overview;
  const goalPct = Math.min(100, Math.round((o.monthsCovered / 6) * 100));

  body.innerHTML = `
    <h3>Archive so far</h3>
    <dl class="kv">
      <dt>Snapshots</dt><dd>${o.snapshots.toLocaleString()}</dd>
      <dt>Days covered</dt><dd>${o.daysCovered}</dd>
      <dt>Depth</dt><dd>${o.monthsCovered} month${o.monthsCovered === 1 ? '' : 's'}</dd>
      <dt>Routes</dt><dd>${o.routesTracked}</dd>
      <dt>First record</dt><dd>${o.firstDay ? esc(o.firstDay) : '—'}</dd>
    </dl>
    <div class="my-12">
      <div class="bar-track"><span class="bar" data-pct="${goalPct}"></span></div>
      <small class="faint">${goalPct}% of the 6-month depth goal</small>
    </div>
    <div class="note info">
      Bangladesh Railway publishes no historical availability data — its API only answers for
      dates inside the 10-day selling window. So this archive cannot be back-filled; it is
      built by recording every search and sweeping tracked routes hourly. It deepens each day
      the site keeps running.
    </div>

    ${o.months.length ? `
      <h3>Month by month</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Month</th><th class="num">Snapshots</th><th class="num">Days</th><th class="num">Journey dates</th></tr></thead>
        <tbody>${o.months.map((m) => `<tr>
          <td><b>${esc(m.month)}</b></td><td class="num">${m.snapshots}</td>
          <td class="num">${m.days}</td><td class="num">${m.journey_dates}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}

    ${h.route?.byDaysAhead?.length ? `
      <h3>${esc(h.route.fromLabel)} → ${esc(h.route.toLabel)}: how it drains</h3>
      <p>Average seats seen at each point in the selling window — the practical guide to when to buy.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Days before travel</th><th class="num">Avg seats</th><th class="num">Min</th><th class="num">Max</th><th class="num">Sold out</th></tr></thead>
        <tbody>${h.route.byDaysAhead.map((d) => `<tr>
          <td><b>${d.days_ahead}</b> day${d.days_ahead === 1 ? '' : 's'} out</td>
          <td class="num">${d.avg_seats ?? '—'}</td><td class="num">${d.min_seats}</td>
          <td class="num">${d.max_seats}</td><td class="num">${d.sold_out_count}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}

    ${h.route?.byClass?.length ? `
      <h3>By seat class</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Class</th><th class="num">Avg online</th><th class="num">Peak</th><th class="num">Avg fare</th></tr></thead>
        <tbody>${h.route.byClass.map((c) => `<tr>
          <td><b>${esc(c.seat_class)}</b></td><td class="num">${c.avg_online ?? '—'}</td>
          <td class="num">${c.max_online}</td><td class="num">${c.avg_fare ? `৳${c.avg_fare}` : '—'}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}

    ${h.journeyDate?.points?.length ? `
      <h3>${esc(h.journeyDate.datePretty)} — drain curve</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Observed</th><th class="num">Days out</th><th class="num">Seats</th></tr></thead>
        <tbody>${h.journeyDate.points.map((p) => `<tr>
          <td>${esc(new Date(p.capturedAt).toLocaleString())}</td>
          <td class="num">${p.daysAhead}</td>
          <td class="num">${p.ok ? p.seats : `<span title="${esc(p.error || '')}">error</span>`}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}

    ${hasRoute && !h.route?.byDaysAhead?.length ? `
      <div class="note mt-14">Nothing recorded yet for
        ${esc(q.from)} → ${esc(q.to)}. Track it in Settings and history starts building on the next sweep.</div>` : ''}
  `;

  // Set through the CSSOM, not a style attribute: CSP blocks inline styles.
  const bar = $('.bar[data-pct]', body);
  if (bar) bar.style.width = `${bar.dataset.pct}%`;
}

/* -------------------------------- bootstrap ------------------------------ */

async function loadStations() {
  const { stations } = await api('/api/stations');
  state.stations = stations;
}

async function refreshMeta() {
  state.meta = await api('/api/meta');
  const badge = $('#settings-badge');
  if (badge) badge.textContent = state.meta.token.present ? 'Live · on' : 'Settings';
}

function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  localStorage.setItem('br-theme', mode);
  $('#theme-label').textContent = mode === 'system' ? 'Auto' : mode === 'dark' ? 'Dark' : 'Light';
}

function wireEvents() {
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });
  $('#swap-btn').addEventListener('click', () => {
    const a = fromCombo.value;
    fromCombo.value = toCombo.value;
    toCombo.value = a;
    if (fromCombo.value && toCombo.value) doSearch();
  });
  $('#earliest-btn').addEventListener('click', loadEarliest);
  $('#settings-btn').addEventListener('click', renderSettings);
  $('#alarms-btn').addEventListener('click', renderAlarms);
  $('#history-btn').addEventListener('click', renderHistory);
  $('#scrim').addEventListener('click', closeDrawers);
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeDrawers));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawers(); });

  $('#theme-btn').addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    const cur = localStorage.getItem('br-theme') || 'system';
    applyTheme(order[(order.indexOf(cur) + 1) % order.length]);
  });

  // One delegated handler for everything rendered dynamically.
  document.addEventListener('click', async (e) => {
    const t = e.target;

    const chip = t.closest('.chip[data-from]');
    if (chip) {
      fromCombo.value = chip.dataset.from;
      toCombo.value = chip.dataset.to;
      doSearch();
      return;
    }

    const suggest = t.closest('[data-suggest]');
    if (suggest) { toCombo.value = suggest.dataset.suggest; doSearch(); return; }

    const calDate = t.closest('[data-cal-date]');
    if (calDate) {
      $('#date-input').value = calDate.dataset.calDate;
      doSearch();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const stops = t.closest('[data-stops]');
    if (stops) { toggleStops(stops.dataset.stops, stops); return; }

    const shift = t.closest('[data-shift]');
    if (shift) {
      const d = new Date(`${$('#date-input').value}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + Number(shift.dataset.shift));
      $('#date-input').value = d.toISOString().slice(0, 10);
      doSearch();
      return;
    }

    if (t.closest('[data-alarm]')) { setAlarmForCurrent(); return; }
    if (t.closest('#pair-start')) { startPairing(); return; }
    if (t.closest('#test-alarm')) { sendTestAlarm(); return; }

    if (t.closest('#bot-token-save')) {
      const val = $('#bot-token-input')?.value.trim();
      if (!val) { toast('Paste the token from @BotFather first.', 'err'); return; }
      saveBotToken(val);
      return;
    }
    if (t.closest('#bot-token-clear')) {
      // Genuinely destructive: an account IS a chat on a bot, so removing the
      // bot removes every account paired through it — the caller's included.
      const bot = state.notify.status?.bot || {};
      const ok = confirm(
        `Disconnect @${bot.username || 'this bot'}?\n\n`
        + 'This removes the bot and every account connected through it, including yours, '
        + 'along with their alarms. It cannot be undone.',
      );
      if (!ok) return;
      try {
        const res = await api('/api/notify/bot', { method: 'DELETE' });
        sessionToken.set(null); // Your account went with the bot.
        toast(
          `Bot disconnected — ${res.removedSubscribers} account(s) and their alarms were removed.`,
          '',
        );
      } catch (e) {
        toast(e.message, 'err');
      }
      renderAlarms();
      return;
    }

    const cancelAlarmBtn = t.closest('[data-cancel-alarm]');
    if (cancelAlarmBtn) { cancelAlarm(Number(cancelAlarmBtn.dataset.cancelAlarm)); return; }

    if (t.closest('#copy-tag') || t.closest('#copy-stop-tag')) {
      const id = t.closest('#copy-stop-tag') ? '#stop-tag' : '#trigger-tag';
      const tag = $(id)?.textContent.trim();
      try { await navigator.clipboard.writeText(tag); toast('Tag copied.', 'good'); }
      catch { toast(`Match on: ${tag}`, ''); }
      return;
    }

    if (t.closest('#copy-code')) {
      const code = $('#pair-code')?.textContent.trim();
      try {
        await navigator.clipboard.writeText(code);
        toast('Code copied — paste it to the bot in Telegram.', 'good');
      } catch { toast(`Send this to the bot: ${code}`, ''); }
      return;
    }

    if (t.closest('#copy-snippet')) {
      try {
        await navigator.clipboard.writeText(CREDS_SNIPPET);
        toast('Snippet copied — paste it into the console on eticket.railway.gov.bd.', 'good');
      } catch {
        // Clipboard is blocked without a user gesture in some browsers; select
        // the text so a manual copy still works.
        const r = document.createRange();
        r.selectNodeContents($('#creds-snippet'));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        toast('Press ⌘C / Ctrl+C to copy the selected snippet.', '');
      }
      return;
    }

    if (t.closest('[data-ics]')) { downloadReminder(); return; }
    if (t.closest('[data-refresh]')) { doSearch(); return; }
    if (t.closest('[data-open-settings]')) { renderSettings(); return; }

    // Signing in is pairing Telegram, so both buttons lead to the same panel.
    if (t.closest('[data-signin]')) { closeDrawers(); renderAlarms(); return; }

    if (t.closest('[data-signout]')) {
      // Local only: it forgets the secret in this browser and leaves the
      // account, its alarms and its railway session untouched on the server.
      sessionToken.set(null);
      state.notify.status = null;
      state.notify.alerts = null;
      updateAlarmBadge();
      toast('Signed out of this browser. Your alarms are still set.');
      renderSettings();
      return;
    }

    if (t.closest('[data-watch]')) {
      const q = currentQuery();
      try {
        await api('/api/watchlist', { method: 'POST', body: { from: q.from, to: q.to } });
        toast('Route tracked — availability history will build up hourly.', 'good');
      } catch (err) { toast(err.message, 'err'); }
    }
  });
}

async function init() {
  applyTheme(localStorage.getItem('br-theme') || 'system');
  fromCombo = new StationCombo('from-combo', 'from-input', 'from-list');
  toCombo = new StationCombo('to-combo', 'to-input', 'to-list');
  wireEvents();

  // Alarm state is not critical to the page, so a failure here must not block it.
  refreshAlarms().catch(() => {});

  try {
    await Promise.all([loadStations(), refreshMeta()]);
  } catch (err) {
    $('#results').innerHTML = `<div class="note danger">Could not reach the local server: ${esc(err.message)}</div>`;
    return;
  }

  const meta = state.meta;
  const dateInput = $('#date-input');
  dateInput.min = meta.today;

  if (!meta.catalog.trains) {
    $('#results').innerHTML = `
      <div class="answer is-info">
        <span class="answer-kicker">First run</span>
        <h2>Fetching Bangladesh Railway's timetable…</h2>
        <p>Pulling all trains, stations and stop times. This happens once and takes about a
        minute — the page will reload itself when it is ready.</p>
      </div>`;
    const poll = setInterval(async () => {
      const s = await api('/api/sync');
      if (!s.running && s.catalog.trains) { clearInterval(poll); location.reload(); }
    }, 3000);
    return;
  }

  // Restore from the URL, else default to the route the user came here for.
  const p = new URLSearchParams(location.search);
  fromCombo.value = p.get('from') || 'Dhaka';
  toCombo.value = p.get('to') || 'Sreemangal';
  dateInput.value = p.get('date') || meta.window.lastDate;

  if (p.get('from') || p.get('to') || p.get('date')) doSearch();
  else {
    $('#results').innerHTML = `
      <div class="empty-state">
        ${ICON.train}
        <h3>Pick a route and a date</h3>
        <p>Any date works — including ones the official site will not let you select yet.
        You will get the exact sale-open moment, every train on the route, and live seats
        where they exist.</p>
      </div>`;
  }
}

init();
