# rail_first_seat

Answers the question the official Bangladesh Railway site refuses to: **for a
given station pair and a given date, when do the tickets actually go on sale,
which trains run it, and are there seats right now?**

`eticket.railway.gov.bd` only lets you *select* a date once it is inside the
10-day selling window. Ask it about Dhaka → Sreemangal for a date six weeks out
and you get nothing at all. This site answers for any date, months ahead.

```
Dhaka → Sreemangal, 15 Oct 2026

  Tickets go on sale 5 Oct 2026, Mon at 8:00 AM BST [39d 14h 33m countdown]

  709  PARABAT EXPRESS    06:30 → 10:32   4h 2m   6 stops   off day Mon
  717  JAYENTIKA EXPRESS  11:15 → 16:01   4h 46m  10 stops  off day Tue
  773  KALNI EXPRESS      14:55 → 18:52   3h 57m  5 stops   off day Fri
  739  UPABAN EXPRESS     22:00 → 02:09   4h 9m   4 stops   off day Wed  (+1 day)
```

Storage is **Supabase Postgres**. Frontend is plain HTML/CSS/JS with no build
step. The only runtime dependency is the `pg` driver.

---

## Run it

**1. Create a Supabase project** at <https://supabase.com> (the free tier is
plenty — the whole dataset is a few MB).

**2. Get the connection string.** Supabase dashboard → **Project Settings →
Database → Connection string → URI**. Replace `[YOUR-PASSWORD]` with your
database password.

**3. Configure and install:**

```bash
cd rail_first_seat
cp .env.example .env          # then put your connection string in .env
npm install
```

**4. Create the tables:**

```bash
npm run db:setup
```

**5. Start:**

```bash
npm start                     # → http://localhost:8787
```

On first run it pulls Bangladesh Railway's whole timetable (about a minute: 134
trains, 238 stations, 1,723 stops) into Supabase, and the page reloads itself
when ready. After that every schedule and sale-time question is answered from
the database instantly.

Requires Node 20.12 or newer. Other commands:

| Command | What it does |
| --- | --- |
| `npm start` | Run the server |
| `npm run dev` | Run with auto-reload on file changes |
| `npm run db:setup` | Apply the schema and print table/row/RLS status |
| `npm run sync` | Re-crawl the timetable from Bangladesh Railway |
| `npm run snapshot` | One availability sweep of the tracked routes, then exit |
| `npm test` | Run the test suite |

---

## Keeping the database credentials secret

The connection string is the only real secret here, and it is handled so that a
visitor to the deployed site can never see or reach it.

**How it is loaded.** Only from the environment — `SUPABASE_DB_URL`, read in
[`src/config.js`](src/config.js). It is never hard-coded, and `.env` is
gitignored (along with `.env.*`, `*.pem`, `*.crt`) so it cannot be committed by
accident. `.env.example` carries the variable *names* and a placeholder only.

**How it stays server-side.** The browser never talks to Supabase. It only calls
this server's own `/api/*` routes, and the server holds the connection. Nothing
is injected into the HTML or JavaScript at build or serve time — there is no
build step and no template substitution, so there is no path by which a
credential could end up in a page. Verified: no response from `/`, `/app.js`,
`/api/meta`, `/api/health`, `/api/token` or `/api/search` contains the host,
port, user or password.

**Belt and braces:**

- The startup check refuses to boot on a missing connection string, a
  leftover `[YOUR-PASSWORD]` placeholder, or a non-`postgresql://` URL — with a
  message that says what to fix.
- Logs print a *masked* label (`user@host:port/db`) — never the password. See
  `safeDatabaseLabel()`.
- With `NODE_ENV=production`, unexpected server errors return a generic
  `Internal server error` instead of the exception text, which can carry
  connection detail.
- Every table has **Row Level Security enabled with no policies**. This server
  connects as the database owner and bypasses RLS, but it means that if the
  project's anon/publishable key were ever used against Supabase's PostgREST
  endpoint, these tables stay unreadable.
- Responses carry `Content-Security-Policy: default-src 'self'` (plus
  `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`). The page
  is fully self-contained — no CDN, no external fetches — so nothing can
  exfiltrate to a third-party host. There are no inline styles or scripts, so
  the policy needs no `unsafe-inline` escape hatch.
- The Bangladesh Railway session token is likewise never returned by the API —
  `/api/token` gives only a masked preview (`eyJ0eXAi…Xb3Kq2`), an expiry and a
  masked account label.

**Deploying.** Do not upload `.env`. Set the variables in the platform's own
secret store:

| Platform | Where |
| --- | --- |
| Railway / Render / Fly.io | Service → Variables / Secrets |
| Vercel | Project → Settings → Environment Variables |
| Heroku | `heroku config:set SUPABASE_DB_URL='…'` |
| Docker | `--env-file` at run time, or your orchestrator's secret mount |

Set at minimum:

```
SUPABASE_DB_URL = postgresql://postgres:…@db.YOUR-REF.supabase.co:5432/postgres
NODE_ENV        = production
```

`PORT` is usually injected by the platform. Rotate the password from the
Supabase dashboard if it is ever exposed; nothing in the code pins it.

**A note on pooling.** For a normal long-running server the direct connection or
the session pooler both work. On serverless/edge hosting, use Supabase's
**transaction pooler** (port `6543`) — the code never names its prepared
statements, so it is compatible with transaction mode.

**A note on TLS.** `PG_SSL_MODE=auto` (the default) encrypts connections to
remote hosts and skips TLS for `localhost`. `auto`/`require` encrypt without
verifying the certificate chain, which is what Supabase's own connection
snippets do. For full verification, download Supabase's CA certificate
(Dashboard → Database → SSL Configuration) and set `PG_SSL_MODE=strict` with
`SUPABASE_CA_CERT=/path/to/prod-ca-2021.crt`.

---

## What it tells you

**1. When the sale opens.** Two moments are easy to confuse, and only the second
one lets you buy anything:

- The booking **window** rolls forward at **00:00 Dhaka** on D-10. That is when
  the date appears in the official datepicker — verified in the site's own JS,
  which feeds `trip_search_day_limit: 10` straight to `maxDate`.
- The **seats** are released later that morning, at **08:00 Dhaka**. Before
  that the date is selectable but every train shows nothing.

Alarms fire on the second. The exact release time is not published anywhere and
has moved before, so the app does not merely trust the default: once a session
token is present it **measures** the release each day by watching the newest
journey date, and the measured value then drives every alarm (`observed_sale_open_time`
in `meta`; see `probeSaleRelease` in `src/history.js`). Pending alarms are
re-timed automatically when a measurement lands. The site computes the exact
moment for your date, shows a live
countdown, and hands you an `.ics` reminder with a 10-minute alarm so you are
logged in and on the search page before it opens.

**2. Which trains actually serve your route.** The public `/all-trains/info`
endpoint only gives origin and destination, which cannot answer "Dhaka →
Sreemangal" — Sreemangal is an intermediate stop. So the catalog sync walks
every train's full stop list and stores it, giving a real route graph:
departure and arrival times for *your* leg, leg duration, intermediate stop
count, overnight (+1 day) arrivals, running days and off days, plus an
expandable timeline of every stop with halt times and your board/alight points
marked.

**3. Whether seats are left.** With a session token added (below) you get live
per-class seat counts and fares per train, an "earliest date with a seat" scan
across the whole selling window, and a growing availability archive.

**4. A 60-day sale-open calendar** for the route, so you can see at a glance
which dates are buyable now and when each future date unlocks.

---

## Live seat counts (optional)

Everything above works with no login. Seat counts and fares need one.

Bangladesh Railway protects its sign-in with a Cloudflare Turnstile challenge,
so this site **cannot and does not** log in for you. Instead it reuses your own
browser session, which you paste in once:

**The token on its own is not enough.** Every request the official site makes
also carries an `X-Device-Id` — a FingerprintJS visitorId it stores in
localStorage as `uudid` — and the backend ties the session to it. A token
replayed without it is refused with *exactly* the same 401 as an expired one,
which makes the failure look like an expiry that no amount of re-copying fixes.
So copy both:

1. Open <https://eticket.railway.gov.bd> and sign in as normal.
2. Open DevTools (`⌥⌘I` on Mac, `F12` on Windows) → **Console**.
3. Run this — it puts all three values on your clipboard:

   ```js
   copy(JSON.stringify({token:localStorage.token,deviceId:localStorage.uudid,deviceKey:localStorage.ssdk}))
   ```

4. Paste the result into **Settings → Session token** and hit *Save & verify*.

The box also accepts a bare token (useful for refreshing once a device id is on
file) and tolerates the usual copy damage — surrounding quotes, a `Bearer`
prefix, line wrapping.

If a token is refused, the message now distinguishes the two cases: it decodes
the JWT's own `exp` and either names the date it expired, or tells you it was
rejected *despite* still being valid — which points at the device id rather
than sending you to fetch another doomed token.

Token and device id are stored in your own Supabase project and only ever sent
back to `railway.gov.bd`. They can also come from `BR_TOKEN`, `BR_DEVICE_ID`
and `BR_DEVICE_KEY`.

The site never handles payments or passenger details — booking always hands off
to the official site.

---

## Availability history

Bangladesh Railway publishes **no historical availability API**.
`search-trips-v2` answers only for dates inside the current 10-day window and
nothing at all for dates already gone. Months of history therefore cannot be
back-filled by anyone — it has to be accumulated. So:

- every live search you run is recorded as a snapshot;
- routes you *track* are swept automatically once an hour;
- the History panel shows archive depth against a 6-month goal, month-by-month
  coverage, the per-route drain curve (average seats at 10 days out, 9, 8 …
  down to departure — the practical guide to when to buy), a per-seat-class
  breakdown with average fares, and the full observation trail for any single
  journey date.

Track a route from the search results (*Track this route's availability*) or in
Settings. If you would rather not keep the server running, drive sweeps from
cron — the interesting moments are just after the two daily releases:

```cron
0 8,14,20 * * * cd /path/to/rail_first_seat && /usr/local/bin/node scripts/run-snapshot.js
```

---

## Sale-open alarms (optional)

The sale moment is deterministic, so you should not have to sit and watch a
countdown. Set an alarm and Telegram rings you the second the date opens.

**Setup, once.** Talk to [@BotFather](https://t.me/BotFather), send `/newbot`,
and copy the token it hands back. Open **Alarms** in the top bar and paste it
there — no file editing and no restart. It is verified against Telegram's
`getMe` before being stored, so a truncated paste is caught immediately, and it
is kept in the database beside the Bangladesh Railway session token. The API
never gives it back; only a masked preview like `123456789:••••••Dsaw`.

Then press *Connect Telegram* and tap the link. That binds this browser to your
chat — the only things stored about you are your Telegram chat id and display
name.

**If pressing Start does nothing**, it is almost always one of these:

- *No Start button appeared.* Telegram only offers it on a chat you have never
  opened. If you already opened the bot (while testing it, say), the deep link
  just opens the conversation and the code is never delivered. Paste the
  8-character code into the chat instead — the panel shows it with a copy
  button, and the bot accepts it on its own or as `/start <code>`.
- *A webhook is registered on the bot.* Webhooks and polling are mutually
  exclusive, so every poll returns 409 and nothing is ever received. Saving a
  token now checks for this and removes it automatically.
- *Two copies of the server are polling the same bot.* Telegram hands updates to
  only one, at random. The log says `getUpdates conflict`. Stop the extra copy
  (`lsof -nP -iTCP:8787 -sTCP:LISTEN`) or give the second one its own bot.

Swapping the bot later is handled: the update cursor is reset (update ids are
numbered per bot) and you are told how many existing chats belonged to the old
bot and must reconnect. Disconnecting pauses alarms without deleting them.

**Then**, search any date that is not on sale yet and press *Alarm me when this
opens*. You may hold **3 alarms at a time**; the panel shows how many slots are
free.

**How it fires.** The opening instant is computed once, at the moment you set
the alarm, and frozen onto the row. A scheduler scans every 15 seconds and arms
a precise timer for anything due inside the next 20, so the message goes out on
the instant rather than up to a scan late — the test suite asserts sub-750 ms
accuracy. No polling of Bangladesh Railway, and **no session token required**.

**One message per alarm.** A Telegram bot cannot play a continuous sound — one
message is one notification, and which sound it makes is the recipient's
Telegram setting. Rather than fake a ring by spamming the chat, the message is
sent once and carries `#RAILALARM`, which a phone automation uses to start a
real looping system alarm (see below). Delivery is retried behind the scenes for
up to 15 minutes if Telegram is slow or times out, but only ever **one** message
arrives. Tapping *Stop alarm* rewrites it as *Alarm stopped* with a *Book now*
deep link. If the server was down at the opening moment the alarm still goes
out, flagged as late.

To go back to Telegram-only repeat ringing, set `ALARM_REPEAT = true` in
`src/config.js`.

### Making the phone actually ring

Telegram is a *trigger*, not a siren. For a real alarm tone that keeps going
until you dismiss it, let the phone produce the sound.

**Android** — install [MacroDroid](https://play.google.com/store/apps/details?id=com.arlosoft.macrodroid)
(free tier suffices) and make one macro:

| | |
| --- | --- |
| Trigger | Device Events → **Notification Received** → app **Telegram** → text contains `#RAILALARM` |
| Action | Media → **Play Sound/Vibrate** → an alarm tone, **Loop** on, stream **Alarm** |
| Action | Volume → **Alarm volume** to max |

Alarm-stream volume ignores silent mode, so it rings even on mute. Tasker (with
AutoNotification) and Automate work the same way. Then press **Send a test
alarm** in the Alarms panel — drills carry the same tag, so it exercises the
whole chain without waiting for a sale.

`#RAILALARM` (`ALARM_TRIGGER_TAG` in `src/config.js`) appears in every alarm
message and never varies with route, date or wording. Do not reword it without
updating the macro.

**iPhone** — iOS gives no app or Shortcut a way to react to another app's
notification, so this approach simply is not available. The realistic options
are Telegram's own loudest sound with *override mute* enabled, or producing the
sound somewhere else entirely (the machine running the server, a push service
with a repeat-until-acknowledged mode, or a phone call).

Either way, set the Telegram side too: bot chat → **Notifications** → Sound on,
longest tone, exception to override mute; on Android let Telegram bypass Do Not
Disturb.

**Test it before you rely on it.** The Alarms panel has a *Send a test alarm*
button. It schedules a real alarm 15 seconds out and lets it travel the real
scheduler, the real claim, the real ring loop — a shortcut that just posted a
message would still pass if any of that were broken, which is the opposite of
what a test is for. Put the phone down and see whether it actually gets your
attention. The drill is clearly labelled, repeats twice rather than four times,
carries the same *Stop alarm* button so you can confirm that works, and does
**not** use one of your three slots — it fires even when all three are taken.

In the chat: `/alerts` lists what is pending, `/stop` cancels everything.

With no bot connected the feature switches itself off cleanly — the panel shows
the setup steps instead — and the rest of the site is unaffected. Alarms already
pending are kept, and ring as soon as a bot is connected again.

---

## Configuration

All environment variables. Only the first is required.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPABASE_DB_URL` | — | **Required.** Supabase Postgres connection string. `DATABASE_URL` / `POSTGRES_URL` also accepted. |
| `PORT` | `8787` | Web server port |
| `NODE_ENV` | `development` | `production` suppresses error detail in responses |
| `PG_SSL_MODE` | `auto` | `auto` / `require` / `strict` / `disable` |
| `SUPABASE_CA_CERT` | — | CA certificate path, for `PG_SSL_MODE=strict` |
| `PG_POOL_MAX` | `8` | Postgres connection pool size |
| `BR_TOKEN` | — | Session token (the Settings panel overrides it) |
| `BR_DEVICE_ID` | — | The `uudid` the session was issued to. Upstream binds one to the other — without it a valid token is refused as if expired. |
| `BR_DEVICE_KEY` | — | The `ssdk` value, when the site has one |
| `BR_API_BASE` | upstream | Override the API base URL. Testing seam. |
| `BR_WATCH` | — | Routes to seed the watchlist, e.g. `Dhaka>Sreemangal,Dhaka>Sylhet` |
| `TELEGRAM_BOT_TOKEN` | — | Optional fallback for the bot token. Normally you paste it in the Alarms panel instead; a token saved there always wins. |
| `BR_CRAWL_DELAY_MS` | `350` | Politeness delay between catalog requests |

---

## Data sources

All from Bangladesh Railway's own e-ticketing backend
(`railspaapi.shohoz.com`), the same API the official website calls:

| Endpoint | Auth | Used for |
| --- | --- | --- |
| `GET /all-trains/info` | public | every train: number, endpoints, zone, sale opening time |
| `POST /train-routes` | public | full stop list, timings, running days (`model` = train **number**) |
| `GET /bookings/search-trips-v2` | session token | live per-class seat counts and fares |

There is no official public API programme and no documented contract, so the
client parses tolerantly and degrades to the offline layer whenever a live call
fails.

---

## Deploying to Netlify

Netlify has no always-on process, so the three background workers cannot run as
they do locally. The port swaps each for something serverless-shaped, and the
routes themselves are shared verbatim — `src/server.js` exposes a transport-
agnostic `dispatch()` that both `src/serve.js` (Node) and
`netlify/functions/api.mjs` (Fetch) call.

| Local (persistent) | Netlify |
| --- | --- |
| HTTP listener in `src/serve.js` | `netlify/functions/api.mjs`, path `/api/*` |
| Telegram long-poll loop | `netlify/functions/telegram-webhook.mjs` — Telegram pushes updates |
| In-process alarm scheduler | `netlify/functions/alarm-tick.mjs`, cron `* * * * *` |
| Hourly collector | `netlify/functions/collect.mjs`, cron `7 * * * *` |

**The one real cost is precision.** Locally an alarm fires within ~750 ms of the
sale instant. Cron granularity is one minute, so the tick runs every minute and
waits out the last few seconds inside the invocation — expect a few seconds of
lag instead. For a sale that drains over minutes that is usually fine, but it is
strictly worse than running a persistent process.

### Steps

1. **A cloud database.** Create a Supabase project and take
   *Settings → Database → Connection string → URI*. Use the **transaction
   pooler** (port 6543): every function container opens its own connection.
2. **Seed the catalog once**, from your machine — the ~1 minute crawl is longer
   than a function may run, and `POST /api/sync` deliberately refuses on
   Netlify rather than appearing to start:
   ```bash
   SUPABASE_DB_URL='<cloud url>' npm run db:setup
   SUPABASE_DB_URL='<cloud url>' npm run sync
   ```
3. **Connect the repo** in Netlify. `netlify.toml` already sets publish dir,
   build command, functions dir and Node 22 — leave the UI fields empty.
4. **Environment variables** (Site configuration → Environment variables):

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_DB_URL` | the pooler URI from step 1 |
   | `TELEGRAM_WEBHOOK_SECRET` | any random string — `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |
   | `PUBLIC_BASE_URL` | your site's https origin, e.g. `https://your-site.netlify.app` |
   | `NODE_ENV` | `production` |
   | `PG_SSL_MODE` | `require` |

   **`PUBLIC_BASE_URL` and `TELEGRAM_WEBHOOK_SECRET` are a pair — set both.**
   They fail the same way, and it is a nasty way: Telegram *inbound* silently
   dies while alarms keep arriving, because outbound needs no webhook at all.
   Every button press, `/start` and `/stop` is dropped; nothing else looks
   wrong.

   - No `PUBLIC_BASE_URL`: the app cannot know its own address and falls back to
     polling, which a function cannot do.
   - No `TELEGRAM_WEBHOOK_SECRET`: the webhook URL is public and guessable, so
     the endpoint trusts nobody and answers every update `503`.

   Both are checked on the once-a-minute `alarm-tick` cron, which re-registers
   the webhook when either changes — including the first time you add the
   secret. The **Alarms** panel shows a red banner whenever inbound is blocked,
   and `getWebhookInfo` tells you directly:

   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | python3 -m json.tool
   # "last_error_message": "Wrong response from the webhook: 503 Service Unavailable"
   #   -> TELEGRAM_WEBHOOK_SECRET is missing on the host
   ```
5. **Deploy**, then open the site, paste the bot token in **Alarms** and the
   session token in **Settings**. Saving the bot token registers the webhook at
   `https://<your-site>/api/telegram/webhook` automatically — the panel confirms
   with *webhook registered*.
6. **Check the crons** under *Site configuration → Functions → Scheduled
   functions*. `alarm-tick` should be listed as running every minute.

### Gotchas

- **Scheduled functions do not run on deploy previews**, only on the production
  deploy. Alarms set against a preview URL will never fire.
- A **paused or unpublished** site stops the crons — same silent failure as a
  sleeping free tier.
- Netlify's free tier includes a monthly function-invocation allowance. A
  once-a-minute cron is ~43,200 invocations/month before any traffic; check the
  current limit before relying on it.
- If you later move back to a persistent host, set `TELEGRAM_POLLING=1` and
  re-save the bot token — it clears the webhook and returns to long-polling.
- **Do not run `npm start` locally against the deployed database** without
  `TELEGRAM_POLLING=1`. Polling and webhooks are mutually exclusive, and a
  local run used to clear the deployed webhook the moment it saw the token.
  The listener now detects that a webhook is in charge (recorded in
  `meta.telegram_delivery_mode`), refuses to poll and leaves it alone, and the
  alarm cron re-registers the webhook if it ever goes missing.

---

## Project layout

```
src/
  config.js       env loading, secret validation, sale-window constants
  time.js         Asia/Dhaka (UTC+6) date maths and the API's DD-MMM-YYYY format
  shohoz.js       upstream client, error normalisation, booking deep links
  db.js           Supabase Postgres pool, schema, DATE/BIGINT type handling
  catalog.js      timetable crawler and the route-graph queries
  availability.js the three "first availability" answers
  history.js      snapshot recording, history digests, hourly collector
  telegram.js     Bot API transport and the long-poll update loop (no deps)
  notify.js       alarm rules, the 3-per-person cap, pairing, the scheduler
  server.js       routes, validation, security headers, transport-agnostic dispatch()
  serve.js        Node entry point: HTTP listener + background workers
web/
  index.html styles.css app.js       no framework, no build step
scripts/
  db-setup.js  sync-catalog.js  run-snapshot.js
netlify/functions/
  api.mjs  telegram-webhook.mjs  alarm-tick.mjs  collect.mjs
supabase/
  schema.sql      the same DDL the server applies, for the Supabase SQL editor
test/
  live-merge.test.mjs   seat parsing and catalog merge
  alarms.test.mjs       alarm rules and firing precision
  credentials.test.mjs  token normalisation and the device headers
```

---

## API

```
GET  /api/search?from=Dhaka&to=Sreemangal&date=2026-10-15
GET  /api/calendar?from=…&to=…&days=60
GET  /api/earliest?from=…&to=…[&class=S_CHAIR]
GET  /api/train?number=739
GET  /api/stations
GET  /api/destinations?from=…
GET  /api/history[?from=…&to=…&date=…]
GET  /api/meta
GET  /api/health
POST /api/token       { token }
POST /api/sync
POST /api/collect
GET|POST|DELETE /api/watchlist

GET    /api/notify/status                 is a bot connected, is this browser paired
POST   /api/notify/bot     { token }      verify with getMe and store it; takes effect live
DELETE /api/notify/bot                    disconnect the bot (alarms are kept)
POST   /api/notify/pair                   mint a pairing code + t.me deep link
GET    /api/notify/pair?code=…            poll until the bot sees /start <code>
GET    /api/notify/alerts                 list your alarms          (x-notify-token)
POST   /api/notify/alerts  { from, to, date }                       (x-notify-token)
DELETE /api/notify/alerts?id=…                                      (x-notify-token)
POST   /api/notify/test    { from?, to?, date?, delaySeconds? }     (x-notify-token)
```

Dates accept `YYYY-MM-DD` or `DD-MMM-YYYY`. Station names are matched
case-insensitively and accept either the display form (`Biman Bandar`) or the
upstream form (`Biman_Bandar`).

---

## Notes and limits

- The 10-day window is Bangladesh Railway policy and can change. It lives in
  `src/config.js` (`ADVANCE_DAYS`), and matches what the official site reads
  from its own `/handshake` config (`trip_search_day_limit`).
- The **seat-release time** (`SALE_OPEN_TIME`, default `08:00:00`) is the one
  number here that is inferred rather than documented. It is bounded by direct
  observation — seats are absent at 00:00 and present by 11:15 — and 08:00 is
  the only clock time Bangladesh Railway publishes in that range. The probe
  exists precisely because that reasoning could be wrong: it replaces the guess
  with a measurement as soon as one is available. Override with
  `BR_SALE_OPEN_TIME=HH:MM:SS` if you know better.
- The 08:00 / 14:00 zone opening times (`ZONE_OPENING_TIME`, and the per-train
  `opening_time` read live from upstream) are the operator's published counter
  hours and are shown for information only. They do **not** gate when a date
  goes on sale — verified 28 Aug 2026, when East-zone Dhaka → Sreemangal
  tickets for 7 Sep were already selling well before 14:00 BST.
- Only **direct** trains are matched. If no single train covers a pair, you are
  told so rather than shown a wrong answer; break the journey at a junction.
- Eid and other special advance-sale periods run on their own announced
  schedule and will not match the standard 10-day rule.
- Journey dates are stored as Postgres `DATE` and read back as plain
  `YYYY-MM-DD` strings. They are calendar days in Bangladesh, not instants, so
  the driver's local-midnight `Date` conversion is deliberately disabled in
  `src/db.js`.
- Re-sync the timetable after a schedule change (Settings, or `npm run sync`).
