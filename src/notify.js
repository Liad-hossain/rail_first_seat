/**
 * Sale-open alarms.
 *
 * You can only ask for an alarm on a journey date that is NOT yet buyable, and
 * that is the whole point: the sale instant for such a date is deterministic
 * (the release time on D - ADVANCE_DAYS — see effectiveSaleOpenTime), so the alarm needs no
 * polling, no session token, and no luck. The moment is frozen onto the row at
 * creation and a timer fires on it to the millisecond.
 *
 * Delivery is Telegram. Pairing works the way every bot does it: the browser
 * asks for a short code, the user taps a t.me deep link, the bot receives
 * `/start <code>` and binds that chat to the code. The only thing kept about a
 * person is their Telegram chat id and display name — no phone number, no
 * email, nothing they have not already given Telegram.
 */
import crypto from "node:crypto";
import {
  MAX_ALERTS_PER_SUBSCRIBER,
  ALARM_RING_INTERVAL_MS,
  SCHEDULER_SCAN_MS,
  SCHEDULER_LOOKAHEAD_MS,
  PAIR_CODE_TTL_MS,
  ADVANCE_DAYS,
  TELEGRAM_BOT_TOKEN,
  ALARM_REPEAT,
  ALARM_MAX_DURATION_MS,
  ALARM_MAX_RINGS,
  ALARM_TRIGGER_TAG,
  ALARM_STOP_TAG,
  WEBHOOK_MODE,
  PUBLIC_BASE_URL,
  TELEGRAM_WEBHOOK_SECRET,
  ALARM_TEST_DURATION_MS,
  TEST_ALARM_DELAY_SECONDS,
  TEST_ALARM_MAX_DELAY_SECONDS,
} from "./config.js";
import { query, one, transact, isoTimestamp } from "./db.js";
import { routePlan, effectiveSaleOpenTime } from "./availability.js";
import { stationLabel } from "./catalog.js";
import { bookingUrl } from "./shohoz.js";
import {
  addDays,
  prettyDate,
  todayISO,
  daysBetween,
  dhakaToUTC,
} from "./time.js";
import {
  botConfigured,
  getBot,
  sendMessage,
  answerCallback,
  startTelegramListener,
  setBotTokenProvider,
  clearWebhookIfSet,
  setWebhook,
  getWebhookInfo,
  deleteMessage,
  editMessageText,
  esc,
} from "./telegram.js";
import {
  BOT_TOKEN_RE,
  botIdOf,
  listBots,
  botByRowId,
  botByBotId,
  defaultBot,
  botForSubscriber,
  anyBotConfigured,
  upsertBot,
  claimBot,
  deleteBot,
  setBotOffset,
  getBotOffset,
  setBotWebhook,
  ensureDefaultBot,
  describeBot,
} from "./bots.js";

/** Thrown for user-fixable problems; the server maps it to a 400. */
export class NotifyError extends Error {
  constructor(message, code = "NOTIFY_ERROR") {
    super(message);
    this.name = "NotifyError";
    this.code = code;
  }
}

const newCode = () => crypto.randomBytes(4).toString("hex");
const newToken = () => crypto.randomBytes(24).toString("base64url");

/* ------------------------------------------------------------------ *
 * Bots and delivery
 *
 * A bot is a row in `bots` belonging to whoever paired on it first — see
 * bots.js. What lives here is everything about *delivering* through one:
 * registering its webhook, polling it, and connecting or disconnecting it.
 *
 * TELEGRAM_BOT_TOKEN is no longer "the" bot. It seeds a single shared bot that
 * a visitor with no bot of their own may still pair with, and it is what the
 * previously single-bot deployment migrates into.
 * ------------------------------------------------------------------ */

const secretFingerprint = (secret) =>
  secret
    ? crypto
        .createHash("sha256")
        .update(String(secret))
        .digest("hex")
        .slice(0, 16)
    : "none";

/**
 * Each bot gets its own webhook URL, ending in its bot id.
 *
 * A Telegram update carries nothing that says which bot received it. With one
 * site-wide bot that never mattered; with a bot per user it is the only thing
 * separating a `/start` on your bot from a `/start` on someone else's, so it
 * has to come from the path. The bot id is the visible half of every bot token
 * and is not a secret — authenticity still rests entirely on the secret header.
 *
 * Called with no argument it yields the old pathless URL, which is what a bot
 * registered before this change is still pointing at until the next cron pass
 * moves it.
 */
export function webhookUrl(botId = null) {
  const base = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/telegram/webhook`;
  return botId ? `${base}/${botId}` : base;
}

/**
 * The secret Telegram echoes back for one bot — derived, not stored.
 *
 * Per-bot because these are other people's bots: whoever can read one bot's
 * secret must learn nothing about anyone else's. Deriving rather than storing
 * means rotating TELEGRAM_WEBHOOK_SECRET rotates every bot at once with no
 * migration, and the hex digest is well inside Telegram's 1-256 characters of
 * [A-Za-z0-9_-].
 */
export function webhookSecretFor(botId = null) {
  if (!TELEGRAM_WEBHOOK_SECRET) return "";
  // The pathless legacy URL predates per-bot secrets and still uses the raw one.
  if (!botId) return TELEGRAM_WEBHOOK_SECRET;
  return crypto
    .createHmac("sha256", TELEGRAM_WEBHOOK_SECRET)
    .update(String(botId))
    .digest("hex");
}

export function webhookBlocker() {
  if (!WEBHOOK_MODE) return null;
  if (!PUBLIC_BASE_URL) return "PUBLIC_BASE_URL is not set";
  if (!TELEGRAM_WEBHOOK_SECRET) {
    return (
      "TELEGRAM_WEBHOOK_SECRET is not set, so the webhook endpoint refuses " +
      "every incoming update with 503 — alarms still arrive, but buttons and " +
      "commands (Stop alarm, /start, /stop) do nothing"
    );
  }
  return null;
}

async function registerWebhook(bot, { log = () => {} } = {}) {
  const blocked = webhookBlocker();
  if (blocked) {
    log(`telegram: NOT registering a webhook — ${blocked}`);
    return { blocked };
  }
  const url = webhookUrl(bot.bot_id);
  const secret = webhookSecretFor(bot.bot_id);
  await setWebhook(url, { secret, token: bot.token });
  await setBotWebhook(bot.id, {
    url,
    secretFp: secretFingerprint(secret),
    mode: "webhook",
  });
  return { registered: url };
}

/** True when this bot's updates are pushed to a webhook rather than polled. */
export function webhookIsInCharge(bot) {
  return bot?.delivery_mode === "webhook";
}

/**
 * Put every bot's webhook back if it has gone missing.
 *
 * A webhook can be cleared by anything that polls the same bot — most easily a
 * developer running the server locally against the production database. The
 * symptom is subtle and one-directional: outbound messages still arrive, so
 * alarms look fine, while every button press and /start silently queues up
 * undelivered. Cheap enough to check on the same cron that fires alarms.
 *
 * This is also the migration path off the single pathless webhook: a bot that
 * predates per-bot URLs is found pointing at the old one and moved.
 */
export async function ensureWebhook({ log = () => {} } = {}) {
  if (!WEBHOOK_MODE) return { skipped: "not in webhook mode" };

  const blocked = webhookBlocker();
  if (blocked) {
    log(`telegram: webhook cannot work — ${blocked}`);
    return { blocked };
  }

  const bots = await listBots();
  if (!bots.length) return { skipped: "no bot connected" };

  const results = [];
  for (const bot of bots) {
    try {
      results.push({ botId: bot.bot_id, ...(await ensureOneWebhook(bot, { log })) });
    } catch (err) {
      // One unreachable or revoked bot must not stop the others being repaired.
      results.push({ botId: bot.bot_id, error: err.message });
    }
  }
  return { bots: results };
}

async function ensureOneWebhook(bot, { log = () => {} } = {}) {
  const want = webhookUrl(bot.bot_id);
  let info;
  try {
    info = await getWebhookInfo({ token: bot.token });
  } catch (err) {
    return { skipped: `could not read webhook info: ${err.message}` };
  }

  const wantFp = secretFingerprint(webhookSecretFor(bot.bot_id));
  const staleSecret = bot.webhook_secret_fp !== wantFp;

  if (info?.url === want && !staleSecret) {
    return {
      ok: true,
      url: want,
      pending: info.pending_update_count,
      lastError: info.last_error_message || null,
    };
  }

  const why =
    info?.url !== want
      ? `was ${info?.url ? `pointing at ${info.url}` : "missing"}`
      : `was registered with a ${bot.webhook_secret_fp ? "different" : "missing"} secret`;
  await registerWebhook(bot, { log });
  log(
    `telegram: webhook for @${bot.username || bot.bot_id} ${why} — re-registered at ${want}` +
      (info?.pending_update_count
        ? ` (${info.pending_update_count} queued update(s) will now be delivered)`
        : ""),
  );
  return {
    repaired: true,
    url: want,
    was: info?.url || null,
    secretRotated: staleSecret,
    pending: info?.pending_update_count ?? 0,
  };
}

/**
 * The default bot's token: the fallback for a call with no user in scope.
 *
 * Almost nothing uses it any more — a message belongs to an account, and an
 * account belongs to a bot, so the token comes from the row. This exists for
 * the shared bot and for `botConfigured()`.
 */
export async function getBotToken() {
  try {
    const bot = await defaultBot();
    if (bot?.token) return bot.token;
  } catch { /* database not up yet — fall through to the env var */ }
  return TELEGRAM_BOT_TOKEN || null;
}

/**
 * Installed at module load, not in startNotifications(): a serverless function
 * imports this module and calls into it directly without ever starting the
 * background workers, and it still needs the token to come from the database.
 */
setBotTokenProvider(getBotToken);

/** Seed the deployment's own shared bot. Idempotent; safe to call at any boot. */
export async function ensureBots({ log = () => {} } = {}) {
  return ensureDefaultBot({ log });
}

/** Is there any bot at all to ring through? */
async function canRingAnything() {
  if (await botConfigured()) return true;
  return anyBotConfigured();
}

/**
 * Connect a bot, verified against getMe before anything is stored.
 *
 * Deliberately does NOT assign ownership: the first chat to pair on the bot
 * claims it (see handleStart). Pasting a token is not proof of anything beyond
 * holding it, and the account that will actually receive the alarms is the one
 * that should own the bot.
 */
export async function connectBot(token, { user = null, log = () => {} } = {}) {
  const trimmed = String(token || "").trim();

  if (!BOT_TOKEN_RE.test(trimmed)) {
    throw new NotifyError(
      "That does not look like a bot token. @BotFather gives you something like 123456789:AAH... — copy the whole line.",
      "MALFORMED",
    );
  }

  const existing = await botByBotId(botIdOf(trimmed));
  if (existing?.is_default) {
    throw new NotifyError(
      "That is this site's shared bot, which the deployment configures. Press Connect Telegram to use it, or make your own with @BotFather.",
      "DEFAULT_BOT",
    );
  }
  // Re-pasting a reissued token for your own bot is fine; pasting somebody
  // else's is not, because it would re-point their webhook.
  if (
    existing?.owner_id &&
    String(existing.owner_id) !== String(user?.id ?? "")
  ) {
    throw new NotifyError(
      "That bot is already connected to another account on this site. Sign in as that account, or create a fresh bot with @BotFather.",
      "OWNED",
    );
  }

  let saved;
  try {
    saved = await upsertBot(trimmed);
  } catch (err) {
    throw new NotifyError(
      err.code === "BAD_BOT_TOKEN"
        ? "Telegram rejected that token. Check you copied all of it, or send /revoke to @BotFather for a fresh one."
        : `Could not verify the token with Telegram: ${err.message}`,
      "VERIFY_FAILED",
    );
  }
  const bot = saved.bot;

  // Two mutually exclusive delivery modes. On a serverless host there is no
  // process to hold a long poll, so updates must be pushed to a function;
  // everywhere else a stale webhook would make getUpdates 409 forever and the
  // only symptom would be "pressing Start does nothing".
  let webhook = { had: false };
  if (WEBHOOK_MODE) {
    webhook = await registerWebhook(bot, { log });
  } else {
    webhook = await clearWebhookIfSet({ token: bot.token, log });
    await setBotWebhook(bot.id, { url: null, secretFp: null, mode: "polling" });
  }

  return {
    botId: bot.bot_id,
    botUsername: saved.me.username,
    botName: saved.me.name,
    // Already claimed means this is a re-save of your own bot rather than a
    // new one waiting for its first chat to pair.
    alreadyOwned: Boolean(bot.owner_id),
    webhookRemoved: webhook.had === true,
    webhookRegistered: webhook.registered || null,
    webhookBlocked: webhook.blocked || null,
  };
}

/**
 * Disconnect the caller's own bot.
 *
 * Genuinely destructive: an account IS a chat on a bot, so removing the bot
 * removes every account paired through it and their alarms. There is no
 * sensible alternative — an alarm with no bot to ring through can never fire —
 * so the count goes back to the caller to be shown before and after.
 */
export async function disconnectBot(user, { log = () => {} } = {}) {
  const bot = await botForSubscriber(user.id);
  if (!bot) {
    throw new NotifyError("You have no bot connected.", "NOT_CONFIGURED");
  }
  if (bot.is_default) {
    throw new NotifyError(
      "This site's shared bot is configured by the deployment and cannot be disconnected from here.",
      "DEFAULT_BOT",
    );
  }
  if (String(bot.owner_id) !== String(user.id)) {
    throw new NotifyError(
      "Only the account that first connected this bot can disconnect it.",
      "NOT_OWNER",
    );
  }

  try {
    await clearWebhookIfSet({ token: bot.token, log });
  } catch (err) {
    // Telegram being unreachable must not leave the row undeletable.
    log(`telegram: could not clear the webhook on @${bot.username} — ${err.message}`);
  }
  const { removedSubscribers } = await deleteBot(bot.id);
  log(`telegram: disconnected bot @${bot.username || bot.bot_id}`);
  return { cleared: true, removedSubscribers };
}

export { ALARM_TRIGGER_TAG, ALARM_STOP_TAG };

/**
 * Tell a phone automation to stop ringing.
 *
 * Sent as a NEW message rather than folded into the acknowledgement edit,
 * because Telegram raises no notification for an EDITED message — an
 * automation can only ever see a new one. Silent, so ending an alarm is not
 * itself a noise. Failure is non-fatal: the alarm is already acknowledged
 * server-side, and this only drives the handset.
 */
async function sendStopSignal(chatId, headline, { token = null, log = () => {} } = {}) {
  try {
    await sendMessage(chatId, `${headline}\n${ALARM_STOP_TAG}`, { silent: true, token });
  } catch (err) {
    log(`telegram: stop signal not delivered — ${err.message}`);
  }
}

/**
 * What one viewer may know about the bots on this site.
 *
 * The old version answered site-wide and answered it to anybody: an anonymous
 * visitor got the installed bot's @username, its masked token, its webhook URL
 * and the deployment's public base URL. None of that is a stranger's business
 * now that the bot belongs to a person. A signed-in account sees its own bot in
 * full; everyone else sees only whether a shared bot exists to pair with, which
 * the sign-in panel genuinely needs in order to offer the choice.
 */
export async function notifyStatus({ user = null } = {}) {
  const base = {
    testDelaySeconds: TEST_ALARM_DELAY_SECONDS,
    testRingSeconds: Math.round(ALARM_TEST_DURATION_MS / 1000),
    repeats: ALARM_REPEAT,
    ringIntervalSeconds: ALARM_RING_INTERVAL_MS / 1000,
    ringMinutes: Math.round(ALARM_MAX_DURATION_MS / 60_000),
    triggerTag: ALARM_TRIGGER_TAG,
    stopTag: ALARM_STOP_TAG,
    delivery: WEBHOOK_MODE ? "webhook" : "polling",
    inboundBlocked: webhookBlocker(),
  };

  const shared = await defaultBot();
  const sharedBot = shared
    ? { botId: shared.bot_id, username: shared.username || null }
    : null;

  if (!user) {
    return {
      ...base,
      // "Is there a bot I could pair with right now" — the only bot fact an
      // anonymous visitor needs, and the only one they get.
      configured: Boolean(shared),
      botUsername: shared?.username || null,
      sharedBot,
      bot: { present: Boolean(shared) },
    };
  }

  const bot = await botForSubscriber(user.id);
  return {
    ...base,
    configured: Boolean(bot || shared),
    botUsername: bot?.username || null,
    botName: bot?.name || null,
    sharedBot,
    bot: describeBot(bot, { viewerId: user.id }),
    publicBaseUrl: PUBLIC_BASE_URL || null,
    webhook: bot ? await webhookHealth(bot) : null,
  };
}

async function webhookHealth(bot) {
  if (!WEBHOOK_MODE) return { mode: "polling" };
  try {
    const info = await getWebhookInfo({ token: bot.token });
    return {
      mode: "webhook",
      url: info?.url || null,
      expectedUrl: webhookUrl(bot.bot_id),
      pending: info?.pending_update_count ?? 0,
      lastError: info?.last_error_message || null,
      lastErrorAt: info?.last_error_date
        ? new Date(info.last_error_date * 1000).toISOString()
        : null,
    };
  } catch (err) {
    return { mode: "webhook", error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Subscribers and pairing
 * ------------------------------------------------------------------ */

/**
 * Start pairing: mint a code and the deep link that carries it to the bot.
 *
 * The code is minted for one specific bot and is only redeemable there, so a
 * code shown for your bot cannot be claimed by sending it to somebody else's.
 * Which bot: the one named by the caller (having just pasted its token), else
 * the caller's own if they are already signed in, else the shared bot.
 */
export async function createPairing({ botId = null, user = null } = {}) {
  const bot = botId
    ? await botByBotId(botId)
    : (user ? await botForSubscriber(user.id) : null) || (await defaultBot());

  if (!bot) {
    throw new NotifyError(
      "No Telegram bot to connect to. Create one with @BotFather and paste its token first.",
      "NOT_CONFIGURED",
    );
  }
  // A row can exist without a username only if getMe failed when it was saved.
  const username = bot.username || (await getBot({ token: bot.token })).username;

  const code = newCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PAIR_CODE_TTL_MS);

  await query(
    "INSERT INTO notify_pairings (code, created_at, expires_at, bot_id) VALUES ($1,$2,$3,$4)",
    [code, now.toISOString(), expiresAt.toISOString(), bot.id],
  );
  return {
    code,
    deepLink: `https://t.me/${username}?start=${code}`,
    botUsername: username,
    botId: bot.bot_id,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Browser polls this while the user is off tapping the link. */
export async function pairingStatus(code) {
  const row = await one(
    `SELECT p.code, p.expires_at, p.claimed_at, s.id, s.display_name, s.access_token
       FROM notify_pairings p LEFT JOIN notify_subscribers s ON s.id = p.subscriber_id
      WHERE p.code = $1`,
    [String(code || "")],
  );
  if (!row)
    throw new NotifyError(
      "That pairing code is unknown — start again.",
      "NO_SUCH_CODE",
    );
  if (!row.claimed_at) {
    const expired = new Date(row.expires_at).getTime() < Date.now();
    return { claimed: false, expired };
  }
  return {
    claimed: true,
    expired: false,
    subscriber: {
      id: row.id,
      displayName: row.display_name,
      // Handed over exactly once, when the browser sees its own code claimed.
      accessToken: row.access_token,
    },
  };
}

/** Resolve the bearer secret the browser holds. Returns null when unknown. */
export async function subscriberByToken(token) {
  if (!token) return null;
  const row = await one(
    "SELECT id, chat_id, display_name FROM notify_subscribers WHERE access_token = $1",
    [String(token)],
  );
  if (!row) return null;
  return { id: row.id, chatId: row.chat_id, displayName: row.display_name };
}

/**
 * The account for one chat *on one bot*.
 *
 * Scoped to the bot, not just the chat id: the same person may hold an account
 * on two different bots, and Telegram gives them the same chat id on both. A
 * chat-only lookup would have handed the second bot the first bot's account —
 * and with it that account's alarms and railway session.
 */
async function upsertSubscriber(botRowId, chatId, displayName) {
  return transact(async (tx) => {
    const existing = await tx.one(
      "SELECT id, chat_id, display_name, access_token FROM notify_subscribers WHERE bot_id = $1 AND chat_id = $2",
      [botRowId, String(chatId)],
    );
    if (existing) {
      await tx.query(
        "UPDATE notify_subscribers SET display_name = $2, last_seen_at = $3 WHERE id = $1",
        [
          existing.id,
          displayName || existing.display_name,
          new Date().toISOString(),
        ],
      );
      return existing;
    }
    return tx.one(
      `INSERT INTO notify_subscribers (bot_id, chat_id, display_name, access_token, created_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$5) RETURNING id, chat_id, display_name, access_token`,
      [
        botRowId,
        String(chatId),
        displayName || null,
        newToken(),
        new Date().toISOString(),
      ],
    );
  });
}

/* ------------------------------------------------------------------ *
 * Alerts
 * ------------------------------------------------------------------ */

function rowToAlert(r) {
  return {
    id: r.id,
    fromCity: r.from_city,
    toCity: r.to_city,
    fromLabel: stationLabel(r.from_city),
    toLabel: stationLabel(r.to_city),
    journeyDate: r.journey_date,
    journeyDatePretty: prettyDate(r.journey_date),
    opensAt: isoTimestamp(r.opens_at),
    status: r.status,
    createdAt: isoTimestamp(r.created_at),
    firedAt: isoTimestamp(r.fired_at),
    acknowledgedAt: isoTimestamp(r.acknowledged_at),
    ringsSent: r.rings_sent,
    isTest: r.is_test === true,
    lastError: r.last_error,
    bookingUrl: bookingUrl({
      fromCity: r.from_city,
      toCity: r.to_city,
      dateISO: r.journey_date,
    }),
  };
}

export async function listAlerts(subscriberId, { includeDone = true } = {}) {
  const rows = await query(
    `SELECT * FROM alerts
      WHERE subscriber_id = $1 ${includeDone ? "" : "AND status = 'active'"}
      ORDER BY (status = 'active') DESC, opens_at ASC LIMIT 50`,
    [subscriberId],
  );
  const alerts = rows.map(rowToAlert);
  // A test alarm is a drill, not one of your three.
  const active = alerts.filter(
    (a) => a.status === "active" && !a.isTest,
  ).length;
  return {
    alerts,
    active,
    limit: MAX_ALERTS_PER_SUBSCRIBER,
    remaining: Math.max(0, MAX_ALERTS_PER_SUBSCRIBER - active),
  };
}

/**
 * Create one alarm.
 *
 * Every rejection here is a real user-facing distinction, not defensive
 * paranoia: a route with no train, a weekday the route does not run, a date
 * already on sale (nothing to wait for), and the 3-alarm cap.
 */
export async function createAlert({ subscriber, fromCity, toCity, dateISO }) {
  if (fromCity === toCity)
    throw new NotifyError("Origin and destination must be different stations.");

  const plan = await routePlan({ fromCity, toCity, dateISO });

  if (plan.trainsOnRoute === 0) {
    throw new NotifyError(
      `No direct train runs ${plan.from.label} → ${plan.to.label}, so there is no sale to wait for.`,
      "NO_ROUTE",
    );
  }
  if (plan.trainsRunningOnDate === 0) {
    throw new NotifyError(
      `No train runs ${plan.from.label} → ${plan.to.label} on ${plan.datePretty} — it is an off day for every train on this route.`,
      "NO_SERVICE",
    );
  }

  const sale = plan.firstAvailability;
  if (daysBetween(todayISO(), dateISO) < 0) {
    throw new NotifyError(`${plan.datePretty} is in the past.`, "PAST_DATE");
  }
  if (sale.isOpen) {
    throw new NotifyError(
      `Tickets for ${plan.datePretty} are already on sale — you can book right now, there is nothing to be alarmed about.`,
      "ALREADY_OPEN",
    );
  }

  try {
    const row = await transact(async (tx) => {
      // Counted inside the transaction so two rapid submits cannot both pass.
      const { n } = await tx.one(
        "SELECT COUNT(*)::int AS n FROM alerts WHERE subscriber_id = $1 AND status = 'active' AND is_test = FALSE",
        [subscriber.id],
      );
      if (n >= MAX_ALERTS_PER_SUBSCRIBER) {
        throw new NotifyError(
          `You already have ${n} alarms set, which is the maximum of ${MAX_ALERTS_PER_SUBSCRIBER}. Cancel one first.`,
          "LIMIT_REACHED",
        );
      }
      return tx.one(
        `INSERT INTO alerts (subscriber_id, from_city, to_city, journey_date, opens_at, status, created_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING *`,
        [
          subscriber.id,
          fromCity,
          toCity,
          dateISO,
          sale.opensAtISO,
          new Date().toISOString(),
        ],
      );
    });
    return rowToAlert(row);
  } catch (err) {
    if (err.code === "23505") {
      throw new NotifyError(
        "You already have an alarm set for that route and date.",
        "DUPLICATE",
      );
    }
    throw err;
  }
}

/**
 * Fire a drill.
 *
 * Deliberately a real row on the real scheduler rather than a direct send: a
 * shortcut would still pass if the scheduler, the claim, or the ring loop were
 * broken, which is exactly what a test is supposed to catch. The only
 * differences are the marker, the wording, and fewer repeats.
 */
export async function sendTestAlarm({
  subscriber,
  fromCity,
  toCity,
  dateISO,
  delaySeconds,
}) {
  if (!(await botForSubscriber(subscriber.id))) {
    throw new NotifyError(
      "Your account is not attached to a Telegram bot, so there is nothing to ring. Reconnect Telegram.",
      "NOT_CONFIGURED",
    );
  }

  const delay = Math.min(
    Math.max(
      Number.isFinite(delaySeconds)
        ? Number(delaySeconds)
        : TEST_ALARM_DELAY_SECONDS,
      0,
    ),
    TEST_ALARM_MAX_DELAY_SECONDS,
  );

  // Use whatever route the user was looking at, but never fail the drill over
  // it: a route with no service still proves delivery works.
  let from = fromCity || "Dhaka";
  let to = toCity || "Sreemangal";
  let date = dateISO || addDays(todayISO(), ADVANCE_DAYS + 1);
  try {
    const plan = await routePlan({ fromCity: from, toCity: to, dateISO: date });
    if (plan.trainsRunningOnDate === 0) throw new Error("no service");
  } catch {
    from = "Dhaka";
    to = "Sreemangal";
    date = addDays(todayISO(), ADVANCE_DAYS + 1);
  }

  const opensAt = new Date(Date.now() + delay * 1000);

  return transact(async (tx) => {
    // One drill at a time — repeated presses replace, never pile up.
    await tx.query(
      "UPDATE alerts SET status = 'cancelled' WHERE subscriber_id = $1 AND status = 'active' AND is_test = TRUE",
      [subscriber.id],
    );
    const row = await tx.one(
      `INSERT INTO alerts (subscriber_id, from_city, to_city, journey_date, opens_at,
                           status, created_at, is_test)
       VALUES ($1,$2,$3,$4,$5,'active',$6,TRUE) RETURNING *`,
      [
        subscriber.id,
        from,
        to,
        date,
        opensAt.toISOString(),
        new Date().toISOString(),
      ],
    );
    return { ...rowToAlert(row), delaySeconds: delay };
  });
}

export async function cancelAlert(subscriberId, alertId) {
  const row = await one(
    `UPDATE alerts SET status = 'cancelled'
      WHERE id = $1 AND subscriber_id = $2 AND status = 'active' RETURNING *`,
    [alertId, subscriberId],
  );
  if (!row) throw new NotifyError("No such active alarm.", "NOT_FOUND");
  return rowToAlert(row);
}

/* ------------------------------------------------------------------ *
 * The alarm message
 * ------------------------------------------------------------------ */

function alarmButtons(alert) {
  return [
    [{ text: "🎫 Book now", url: alert.bookingUrl }],
    [{ text: "✅ Stop alarm", callback_data: `ack:${alert.id}` }],
  ];
}

/**
 * Composed at fire time rather than at creation, so the train list reflects
 * the catalog as it stands when the alarm actually rings.
 */
async function alarmText(alert, { ring, late, test = false }) {
  const plan = await routePlan({
    fromCity: alert.fromCity,
    toCity: alert.toCity,
    dateISO: alert.journeyDate,
  });
  const running = plan.trains.filter((t) => t.runsOnDate);
  const lines = running.map(
    (t) =>
      `• <b>${esc(t.trainNumber)}</b> ${esc(t.trainName.replace(/\s*\(\d+\)\s*$/, ""))}` +
      ` — ${esc(t.departureTime || "??")} → ${esc(t.arrivalTime || "??")}`,
  );

  // Ringing is time-boxed, not counted, so tell the user how long is left
  // rather than a ring number that means nothing to them.
  const windowMs = test ? ALARM_TEST_DURATION_MS : ALARM_MAX_DURATION_MS;
  const leftMin = Math.max(
    0,
    Math.ceil((windowMs - (ring - 1) * ALARM_RING_INTERVAL_MS) / 60_000),
  );
  const repeated = ALARM_REPEAT && ring > 1;
  const head = test
    ? repeated
      ? `🔔 <b>TEST ALARM — still ringing (${ring})</b>`
      : "🔔🔔 <b>TEST ALARM</b> 🔔🔔"
    : repeated
      ? `🚨 <b>STILL OPEN — ringing (${ring})</b>`
      : "🚨🚨 <b>TICKETS ARE OPEN NOW</b> 🚨🚨";

  return [
    head,
    "",
    test
      ? "<i>A drill you started from the website. No tickets have opened.</i>\n"
      : null,
    `<b>${esc(alert.fromLabel)} → ${esc(alert.toLabel)}</b>`,
    `Journey date: <b>${esc(alert.journeyDatePretty)}</b>`,
    "",
    test
      ? 'This is exactly what a real alarm looks like, and it reached you the same way. Tap "Stop alarm" below to confirm that works too.'
      : late
        ? "⚠️ This alarm is late — the server was not running at the exact opening moment. Seats may already be moving."
        : `Booking opened this second, ${ADVANCE_DAYS} days ahead. Popular trains sell out in minutes.`,
    "",
    running.length
      ? `<b>${running.length} train${running.length === 1 ? "" : "s"} run that day:</b>`
      : "",
    ...lines,
    "",
    ALARM_REPEAT
      ? `<i>Ringing every ${ALARM_RING_INTERVAL_MS / 1000}s until you tap “Stop alarm”` +
        `${leftMin ? ` — about ${leftMin} min left` : ""}.</i>`
      : "<i>Sent once. If your phone is set up to ring on this message, stop it there.</i>",
    // Never remove or reword: phone automations match on this exact token to
    // start a real alarm. See ALARM_TRIGGER_TAG in config.js.
    ALARM_TRIGGER_TAG,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * Telegram command handling
 * ------------------------------------------------------------------ */

const HELP = [
  "👋 This bot rings you the moment Bangladesh Railway opens ticket sales for a journey date you are waiting on.",
  "",
  "Not connected yet? Open the <b>Alarms</b> panel on the website, press",
  "<b>Connect Telegram</b>, and paste the 8-character code here.",
  "",
  "<b>Commands</b>",
  "/alerts — list your pending alarms",
  "/stop — cancel all of them",
].join("\n");

/**
 * Every handler takes the bot the update arrived on.
 *
 * With one site-wide bot the chat id alone identified an account. It no longer
 * does: the same chat id exists on every bot its owner has ever opened, so each
 * lookup is scoped by bot, and each reply is sent back through the same bot it
 * came from rather than through whichever token happened to be configured.
 */
async function handleStart(msg, payload, log, bot) {
  const chatId = msg.chat.id;
  const send = (text, opts = {}) =>
    sendMessage(chatId, text, { ...opts, token: bot.token });
  const name =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ||
    msg.from?.username ||
    null;
  const subscriber = await upsertSubscriber(bot.id, chatId, name);

  if (!payload) {
    // Reached by pressing START with no deep-link payload — common when the
    // chat already existed. Ask for the code rather than leaving them stuck.
    await send(
      [
        "👋 <b>Bangladesh Railway sale alarms.</b>",
        "",
        "To connect this chat, open the <b>Alarms</b> panel on the website, press",
        "<b>Connect Telegram</b>, and send me the 8-character code it shows.",
        "",
        "You can just paste the code here on its own — no command needed.",
      ].join("\n"),
    );
    return;
  }

  const pairing = await one(
    "SELECT code, expires_at, claimed_at, bot_id FROM notify_pairings WHERE code = $1",
    [payload],
  );
  if (!pairing) {
    await send(
      [
        "⚠️ <b>That code is not recognised.</b>",
        "",
        "Codes last 15 minutes. Open the website, press <b>Connect Telegram</b>",
        "for a fresh one, and paste it here.",
      ].join("\n"),
    );
    return;
  }
  // A code is minted for one bot. Redeeming it elsewhere would silently create
  // an account the website is not watching for, so say so instead.
  if (pairing.bot_id && String(pairing.bot_id) !== String(bot.id)) {
    await send(
      [
        "⚠️ <b>That code was made for a different bot.</b>",
        "",
        "Open the website again and use the link it shows — it points at the bot",
        "the code belongs to.",
      ].join("\n"),
    );
    return;
  }
  if (pairing.claimed_at) {
    await send(
      "✅ Already connected. Head back to the website — you can set alarms now.",
    );
    return;
  }
  if (new Date(pairing.expires_at).getTime() < Date.now()) {
    await send(
      "⌛ That connection link has expired. Press <b>Connect Telegram</b> on the website for a fresh one.",
    );
    return;
  }

  await query(
    "UPDATE notify_pairings SET subscriber_id = $2, claimed_at = $3 WHERE code = $1",
    [payload, subscriber.id, new Date().toISOString()],
  );

  // The first chat to pair on a bot owns it, and is from then on the only
  // account that may replace or disconnect it. A shared bot stays unowned.
  const claimed = bot.is_default ? null : await claimBot(bot.id, subscriber.id);

  log(
    `telegram: paired chat ${chatId}${name ? ` (${name})` : ""} on @${bot.username || bot.bot_id}` +
      (claimed ? " — and claimed the bot" : ""),
  );
  await send(
    [
      `✅ <b>Connected${name ? `, ${esc(name)}` : ""}.</b>`,
      "",
      `Go back to the website and set up to ${MAX_ALERTS_PER_SUBSCRIBER} alarms.`,
      "When a sale opens, this chat will ring.",
      ...(claimed
        ? ["", "This bot is now yours — only this account can change or disconnect it."]
        : []),
    ].join("\n"),
  );
}

/** The account for a chat on this bot, or null. */
async function subscriberFor(bot, chatId) {
  return one(
    "SELECT id FROM notify_subscribers WHERE bot_id = $1 AND chat_id = $2",
    [bot.id, String(chatId)],
  );
}

async function handleListCommand(bot, chatId) {
  const send = (text) => sendMessage(chatId, text, { token: bot.token });
  const sub = await subscriberFor(bot, chatId);
  if (!sub) return send("You have no alarms set. Set them on the website.");

  const { alerts, remaining } = await listAlerts(sub.id, {
    includeDone: false,
  });
  if (!alerts.length)
    return send("No pending alarms. Set them on the website.");

  const lines = alerts.map((a) => {
    const mins = Math.round(
      (new Date(a.opensAt).getTime() - Date.now()) / 60000,
    );
    const when =
      mins > 1440
        ? `in ${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
        : mins > 60
          ? `in ${Math.floor(mins / 60)}h ${mins % 60}m`
          : `in ${Math.max(0, mins)}m`;
    return `• <b>${esc(a.fromLabel)} → ${esc(a.toLabel)}</b> on ${esc(a.journeyDatePretty)}\n  opens ${when}`;
  });
  return send(
    [
      `<b>${alerts.length} pending alarm${alerts.length === 1 ? "" : "s"}</b> (${remaining} slot${remaining === 1 ? "" : "s"} free)`,
      "",
      ...lines,
    ].join("\n"),
  );
}

async function handleStopCommand(bot, chatId) {
  const sub = await subscriberFor(bot, chatId);
  if (!sub)
    return sendMessage(chatId, "Nothing to cancel.", { token: bot.token });

  const rows = await query(
    "UPDATE alerts SET status = 'cancelled' WHERE subscriber_id = $1 AND status = 'active' RETURNING id",
    [sub.id],
  );
  // Also silence anything mid-ring.
  await query(
    "UPDATE alerts SET acknowledged_at = now() WHERE subscriber_id = $1 AND status = 'fired' AND acknowledged_at IS NULL",
    [sub.id],
  );
  // Carries the stop tag too: /stop is the other way a ringing phone is told
  // to shut up, and it must work identically.
  return sendMessage(
    chatId,
    [
      rows.length
        ? `🛑 Cancelled ${rows.length} alarm${rows.length === 1 ? "" : "s"}.`
        : "🛑 No pending alarms — anything still ringing is now silenced.",
      ALARM_STOP_TAG,
    ].join("\n"),
    { silent: true, token: bot.token },
  );
}

/** Pairing codes are 8 hex characters — see newCode(). */
const CODE_RE = /^[0-9a-f]{8}$/i;

function makeMessageHandler(log, bot) {
  return async (msg) => {
    if (!msg.chat?.id || typeof msg.text !== "string") return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const [cmd, ...rest] = text.split(/\s+/);
    const command = cmd.toLowerCase().split("@")[0];

    if (command === "/start") return handleStart(msg, rest[0] || null, log, bot);
    if (command === "/alerts" || command === "/list")
      return handleListCommand(bot, chatId);
    if (command === "/stop" || command === "/cancel")
      return handleStopCommand(bot, chatId);

    // Telegram only offers the START button on a chat you have never opened.
    // Once you have, the t.me deep link just opens the conversation and the
    // payload is never delivered — so accept the bare code as well.
    if (CODE_RE.test(text)) return handleStart(msg, text.toLowerCase(), log, bot);

    return sendMessage(chatId, HELP, { token: bot.token });
  };
}

function makeCallbackHandler(log, bot) {
  return async (cq) => {
    const data = String(cq.data || "");
    if (!data.startsWith("ack:"))
      return answerCallback(cq.id, "", { token: bot.token });

    const id = Number(data.slice(4));
    const chatId = cq.message?.chat?.id;
    // Scoped by bot AND chat: an ack can only silence an alarm belonging to the
    // account that this chat is on this bot.
    const row = await one(
      `UPDATE alerts a SET acknowledged_at = now()
         FROM notify_subscribers s
        WHERE a.id = $1 AND a.subscriber_id = s.id
          AND s.bot_id = $2 AND s.chat_id = $3
          AND a.acknowledged_at IS NULL
        RETURNING a.id, a.from_city, a.to_city, a.journey_date, a.is_test`,
      [id, bot.id, String(chatId)],
    );
    await answerCallback(cq.id, row ? "Alarm silenced 🔕" : "Already silenced", {
      token: bot.token,
    });
    if (!row) return;

    log(`telegram: alarm ${id} acknowledged`);
    // Leave the message on screen but visibly stopped, and drop the ringing
    // button so a second tap cannot look like it failed.
    const alert = rowToAlert({ ...row, journey_date: row.journey_date });
    await editMessageText(
      chatId,
      cq.message?.message_id,
      [
        "🔕 <b>Alarm stopped.</b>",
        "",
        `<b>${esc(alert.fromLabel)} → ${esc(alert.toLabel)}</b>`,
        `Journey date: <b>${esc(alert.journeyDatePretty)}</b>`,
        "",
        row.is_test
          ? "That was a drill — the real one behaves exactly the same way."
          : "Tickets are on sale now. Book before they go.",
      ].join("\n"),
      {
        token: bot.token,
        buttons: row.is_test
          ? null
          : [[{ text: "🎫 Book now", url: alert.bookingUrl }]],
      },
    );
    await sendStopSignal(chatId, "🔕 Alarm stopped.", { token: bot.token, log });
  };
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

/**
 * Send one ring and record it.
 *
 * The previous ring is deleted immediately after the new one lands: a fresh
 * message is what makes the phone sound, but leaving them all behind would
 * bury the chat in a hundred duplicates. Delete after, never before, so a
 * failed send never leaves the user with nothing on screen.
 */
async function ring(alertRow, { ring: ringNo, late }, log) {
  const alert = rowToAlert(alertRow);
  const test = alert.isTest;
  // The bot to ring through comes from the row, never from ambient config:
  // sending one account's alarm as another account's bot would deliver it to
  // nobody at best, and to the wrong chat at worst.
  const chat = await one(
    `SELECT s.chat_id, b.token AS bot_token
       FROM notify_subscribers s LEFT JOIN bots b ON b.id = s.bot_id
      WHERE s.id = $1`,
    [alertRow.subscriber_id],
  );
  if (!chat) throw new Error(`alert ${alert.id} has no subscriber`);
  const botToken = chat.bot_token || null;

  const text = await alarmText(alert, { ring: ringNo, late, test });
  const previousMessageId = alertRow.last_message_id;

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const msg = await sendMessage(chat.chat_id, text, {
        buttons: alarmButtons(alert),
        token: botToken,
      });
      await query(
        "UPDATE alerts SET rings_sent = $2, last_message_id = $3, last_error = NULL WHERE id = $1",
        [alert.id, ringNo, msg?.message_id ?? null],
      );
      if (previousMessageId)
        await deleteMessage(chat.chat_id, previousMessageId, { token: botToken });
      if (ringNo === 1 || ringNo % 6 === 0) {
        log(
          `alarm: ${test ? "TEST " : ""}ringing ${alert.fromLabel} → ${alert.toLabel} ${alert.journeyDate} (ring ${ringNo}${late ? ", late" : ""})`,
        );
      }
      return true;
    } catch (err) {
      lastErr = err;
      if (err.code === "BLOCKED" || err.code === "NOT_CONFIGURED") break; // Retrying cannot help.
      await new Promise((r) => setTimeout(r, attempt * 2_000));
    }
  }
  await query("UPDATE alerts SET last_error = $2 WHERE id = $1", [
    alert.id,
    lastErr?.message || "send failed",
  ]);
  throw lastErr || new Error("send failed");
}

/** Ring loops currently running in this process, so none is ever doubled. */
const ringing = new Set();

/**
 * Only these mean "stop trying". A timeout or a network blip is exactly the
 * moment an alarm must NOT give up: Telegram can be slow, and the ring loop is
 * already coming back in ten seconds.
 */
const PERMANENT = new Set(["BLOCKED", "NOT_CONFIGURED", "BAD_BOT_TOKEN"]);
const isPermanent = (err) => PERMANENT.has(err?.code);

function ringWindowMs(row) {
  return row.is_test ? ALARM_TEST_DURATION_MS : ALARM_MAX_DURATION_MS;
}

/**
 * Keep trying until the alarm has been delivered.
 *
 * With ALARM_REPEAT off this exits as soon as one message is through; it exists
 * so a Telegram timeout on the first attempt does not silently lose the alarm.
 * With ALARM_REPEAT on it keeps ringing until acknowledged instead.
 *
 * Driven by its own timer rather than the 15-second scan; the scan is only the
 * recovery path after a restart.
 */
function startRingLoop(alertId, log) {
  if (ringing.has(alertId)) return;
  ringing.add(alertId);

  const tick = async () => {
    let row;
    try {
      row = await one("SELECT * FROM alerts WHERE id = $1", [alertId]);
    } catch (err) {
      log(`alarm: ring loop lost the database — ${err.message}`);
      ringing.delete(alertId);
      return;
    }

    // Every reason to stop, in one place.
    if (!row || row.status !== "fired" || row.acknowledged_at) {
      ringing.delete(alertId);
      return;
    }
    // One message is the whole job unless repeating is deliberately enabled.
    if (!ALARM_REPEAT && row.rings_sent >= 1) {
      ringing.delete(alertId);
      return;
    }
    const elapsed = Date.now() - new Date(row.fired_at).getTime();
    if (elapsed > ringWindowMs(row) || row.rings_sent >= ALARM_MAX_RINGS) {
      ringing.delete(alertId);
      log(
        `alarm: gave up ringing alert ${alertId} after ${Math.round(elapsed / 1000)}s unacknowledged`,
      );
      return;
    }

    try {
      await ring(row, { ring: row.rings_sent + 1, late: false }, log);
    } catch (err) {
      if (isPermanent(err)) {
        log(`alarm: giving up on ${alertId} — ${err.message}`);
        await query("UPDATE alerts SET status = 'failed' WHERE id = $1", [
          alertId,
        ]);
        ringing.delete(alertId);
        return;
      }
      // Transient: keep the loop alive and try again on the next tick.
      log(
        `alarm: ring ${row.rings_sent + 1} failed for ${alertId}, retrying — ${err.message}`,
      );
    }
    const timer = setTimeout(tick, ALARM_RING_INTERVAL_MS);
    timer.unref?.();
  };

  const timer = setTimeout(tick, ALARM_RING_INTERVAL_MS);
  timer.unref?.();
}

/** Claim + fire. The UPDATE ... WHERE status='active' is the claim. */
async function fire(alertId, log) {
  const row = await one(
    `UPDATE alerts SET status = 'fired', fired_at = now()
      WHERE id = $1 AND status = 'active' RETURNING *`,
    [alertId],
  );
  if (!row) return; // Cancelled, or already claimed by this process.

  const late =
    !row.is_test && Date.now() - new Date(row.opens_at).getTime() > 30_000;
  try {
    await ring(row, { ring: 1, late }, log);
  } catch (err) {
    if (isPermanent(err)) {
      await query("UPDATE alerts SET status = 'failed' WHERE id = $1", [
        alertId,
      ]);
      log(`alarm: FAILED for alert ${alertId} — ${err.message}`);
      return;
    }
    // Telegram was slow or unreachable this second. The alarm is still live;
    // the loop below retries every few seconds inside the window.
    log(
      `alarm: first ring failed for ${alertId}, will keep trying — ${err.message}`,
    );
    startRingLoop(alertId, log);
    return;
  }
  // Delivered. Only keep a loop running if repeats are actually wanted.
  if (ALARM_REPEAT) startRingLoop(alertId, log);
}

/**
 * Scan loop. Arms a precise timer for anything due shortly, continues
 * unacknowledged ring cycles (which is also how rings survive a restart), and
 * retires alerts whose journey date has passed.
 */
export function startAlertScheduler({ log = console.log } = {}) {
  const armed = new Map();
  let stopped = false;

  async function scan() {
    // A date that has come and gone can never open — retire it either way.
    await query(
      "UPDATE alerts SET status = 'expired' WHERE status = 'active' AND journey_date < $1",
      [todayISO()],
    );
    // Drills are transient; keep a day's worth for the UI, then drop them.
    await query(
      "DELETE FROM alerts WHERE is_test = TRUE AND created_at < now() - INTERVAL '1 day'",
    );

    // With no bot connected anywhere there is nothing to ring. Alarms stay
    // pending rather than failing, so connecting a bot later still honours them.
    if (!(await canRingAnything())) return;

    const cutoff = new Date(Date.now() + SCHEDULER_LOOKAHEAD_MS).toISOString();
    const due = await query(
      "SELECT id, opens_at FROM alerts WHERE status = 'active' AND opens_at <= $1 ORDER BY opens_at LIMIT 100",
      [cutoff],
    );
    for (const r of due) {
      if (armed.has(r.id)) continue;
      const delay = Math.max(0, new Date(r.opens_at).getTime() - Date.now());
      const timer = setTimeout(() => {
        armed.delete(r.id);
        fire(r.id, log).catch((e) => log(`alarm: fire failed — ${e.message}`));
      }, delay);
      timer.unref?.();
      armed.set(r.id, timer);
    }

    // Revive ring loops that a restart interrupted. The loop itself owns the
    // cadence; this only makes sure one exists for every still-ringing alarm.
    const unacked = await query(
      `SELECT id, fired_at, is_test FROM alerts
        WHERE status = 'fired' AND acknowledged_at IS NULL
          AND rings_sent < $1
          AND fired_at > now() - INTERVAL '1 hour'`,
      [ALARM_REPEAT ? ALARM_MAX_RINGS : 1],
    );
    for (const r of unacked) {
      const elapsed = Date.now() - new Date(r.fired_at).getTime();
      if (elapsed <= ringWindowMs(r)) startRingLoop(r.id, log);
    }
  }

  (async () => {
    while (!stopped) {
      try {
        await scan();
      } catch (err) {
        log(`alarm scheduler: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, SCHEDULER_SCAN_MS));
    }
  })();

  log(
    `alarm scheduler: running (scan ${SCHEDULER_SCAN_MS / 1000}s, ` +
      (ALARM_REPEAT
        ? `rings every ${ALARM_RING_INTERVAL_MS / 1000}s until acknowledged)`
        : "one message per alarm)"),
  );
  return {
    stop() {
      stopped = true;
      for (const t of armed.values()) clearTimeout(t);
    },
  };
}

/** Boot both halves: the update listener and the scheduler. */
/**
 * Re-freeze every pending alarm onto the current release time.
 *
 * opens_at is stored on the row so the scheduler stays a plain index scan, but
 * that means a change in the release time — a measurement landing, or the
 * default being corrected — would otherwise leave existing alarms pointing at
 * the old instant. Cheap, and idempotent.
 */
export async function resyncAlertOpenTimes({ log = () => {} } = {}) {
  const openTime = await effectiveSaleOpenTime();
  const rows = await query(
    "SELECT id, journey_date, opens_at FROM alerts WHERE status = 'active'",
  );

  let moved = 0;
  for (const r of rows) {
    const want = dhakaToUTC(addDays(r.journey_date, -ADVANCE_DAYS), openTime);
    if (Math.abs(want.getTime() - new Date(r.opens_at).getTime()) < 1000)
      continue;
    await query("UPDATE alerts SET opens_at = $2 WHERE id = $1", [
      r.id,
      want.toISOString(),
    ]);
    moved += 1;
  }
  if (moved)
    log(`alarms: re-timed ${moved} pending alarm(s) to ${openTime} Dhaka`);
  return { checked: rows.length, moved, openTime };
}

/**
 * One pass of the alarm work, with no timers left behind.
 *
 * The long-running scheduler arms a precise setTimeout and is accurate to the
 * millisecond; a serverless platform has no such luxury, so this is the shape
 * a cron invocation needs: do everything that is due, optionally wait out the
 * last few seconds for something about to become due, and return.
 *
 * `waitWindowMs` is how long it may sleep in-invocation to land on an opening
 * instant precisely. Keep it comfortably under the platform's timeout.
 */
export async function runAlarmTick({
  log = console.log,
  waitWindowMs = 5_000,
} = {}) {
  const out = { expired: 0, fired: 0, retried: 0, waitedMs: 0 };

  await resyncAlertOpenTimes({ log });

  const expired = await query(
    "UPDATE alerts SET status = 'expired' WHERE status = 'active' AND journey_date < $1 RETURNING id",
    [todayISO()],
  );
  out.expired = expired.length;
  await query(
    "DELETE FROM alerts WHERE is_test = TRUE AND created_at < now() - INTERVAL '1 day'",
  );

  if (!(await canRingAnything())) return out;

  // Anything already due, plus anything due inside the window we can wait for.
  const cutoff = new Date(Date.now() + waitWindowMs).toISOString();
  const due = await query(
    "SELECT id, opens_at FROM alerts WHERE status = 'active' AND opens_at <= $1 ORDER BY opens_at LIMIT 50",
    [cutoff],
  );

  for (const row of due) {
    const waitMs = new Date(row.opens_at).getTime() - Date.now();
    if (waitMs > 0) {
      // Land on the instant rather than up to a minute after it.
      await new Promise((r) => setTimeout(r, Math.min(waitMs, waitWindowMs)));
      out.waitedMs += Math.min(waitMs, waitWindowMs);
    }
    await fire(row.id, log);
    out.fired += 1;
  }

  // A previous invocation may have claimed an alarm and then failed to send —
  // Telegram times out often enough that this is worth retrying explicitly.
  const undelivered = await query(
    `SELECT * FROM alerts
      WHERE status = 'fired' AND rings_sent = 0 AND acknowledged_at IS NULL
        AND fired_at > now() - INTERVAL '15 minutes'
      LIMIT 20`,
  );
  for (const row of undelivered) {
    try {
      await ring(row, { ring: 1, late: true }, log);
      out.retried += 1;
    } catch (err) {
      log(`alarm: retry failed for ${row.id} — ${err.message}`);
    }
  }

  return out;
}

/**
 * Handle a single Telegram update.
 *
 * Long-polling and webhooks deliver the identical payload, so both paths land
 * here and no behaviour can drift between deployment styles.
 *
 * `botId` is the numeric bot id the update arrived for — from the webhook path,
 * or from the poll loop that owns that bot. Omitting it means the shared bot,
 * which is what the pathless legacy webhook resolves to until the cron moves it
 * to its own URL.
 */
export async function handleTelegramUpdate(
  update,
  { log = console.log, botId = null } = {},
) {
  const bot = botId ? await botByBotId(botId) : await defaultBot();
  if (!bot) {
    log(
      `telegram: update for ${botId ? `unknown bot ${botId}` : "no configured bot"} — ignored`,
    );
    return null;
  }
  if (update?.message) return makeMessageHandler(log, bot)(update.message);
  if (update?.callback_query)
    return makeCallbackHandler(log, bot)(update.callback_query);
  return null;
}

/**
 * Long-poll every connected bot, and keep that set current.
 *
 * getUpdates is per-token and its update ids are numbered per bot, so N bots
 * means N loops and N cursors — there is no way to multiplex them. The set is
 * reconciled on a timer rather than fixed at boot because connecting a bot in
 * the UI has to start listening to it without a restart, which the old
 * single-bot loop got for free from its token provider.
 *
 * Only ever runs where there is a process to hold a connection open: a
 * serverless deployment uses webhooks instead.
 */
function startTelegramListeners({ log = console.log } = {}) {
  const running = new Map(); // bot_id -> { listener, token }
  let stopped = false;

  async function reconcile() {
    const bots = await listBots();
    const live = new Set();

    for (const bot of bots) {
      live.add(bot.bot_id);
      const current = running.get(bot.bot_id);
      if (current?.token === bot.token) continue;
      // A reissued token is the same bot on a new connection: restart the loop
      // on it rather than leaving one polling with a token Telegram now 401s.
      current?.listener.stop();

      const listener = startTelegramListener({
        token: bot.token,
        getOffset: () => getBotOffset(bot.id),
        setOffset: (v) => setBotOffset(bot.id, v),
        // Never hijack a deployment's webhook by polling the same bot.
        isWebhookMode: async () => {
          if (WEBHOOK_MODE) return false;
          return webhookIsInCharge(await botByRowId(bot.id));
        },
        onMessage: makeMessageHandler(log, bot),
        onCallback: makeCallbackHandler(log, bot),
        log,
      });
      running.set(bot.bot_id, { listener, token: bot.token });
    }

    for (const [botId, entry] of running) {
      if (live.has(botId)) continue;
      entry.listener.stop();
      running.delete(botId);
      log(`telegram: stopped polling bot ${botId} — it was disconnected`);
    }
  }

  (async () => {
    while (!stopped) {
      try {
        await reconcile();
      } catch (err) {
        log(`telegram: could not refresh the bot list — ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, BOT_RECONCILE_MS));
    }
  })();

  return {
    stop() {
      stopped = true;
      for (const entry of running.values()) entry.listener.stop();
      running.clear();
    },
  };
}

/** How often the poll loops are matched against the bots in the database. */
const BOT_RECONCILE_MS = 5_000;

export function startNotifications({ log = console.log } = {}) {
  ensureBots({ log }).catch((err) =>
    log(`telegram: could not seed the shared bot — ${err.message}`),
  );
  const listeners = startTelegramListeners({ log });
  const scheduler = startAlertScheduler({ log });
  return {
    stop() {
      listeners.stop();
      scheduler.stop();
    },
  };
}
