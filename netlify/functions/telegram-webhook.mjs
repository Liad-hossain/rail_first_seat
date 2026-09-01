/**
 * Telegram update receiver.
 *
 * The polling loop cannot exist on a serverless host, so Telegram pushes
 * updates here instead. connectBot() registers this URL automatically when
 * PUBLIC_BASE_URL is set, and the alarm-tick cron repairs it if it drifts.
 *
 * Bots are per user, and an update carries nothing saying which bot received
 * it — so each bot is registered at its own path, ending in its bot id. The
 * pathless URL is what bots registered before that change still point at; it
 * resolves to the shared bot and keeps working until the cron moves them.
 *
 * Authenticity is the whole security story: the URL is guessable, so a request
 * is only trusted when it carries back the secret registered for that specific
 * bot. Without a configured secret nothing is accepted, rather than everything.
 */
import crypto from "node:crypto";
import { handleTelegramUpdate, webhookSecretFor } from "../../src/notify.js";
import { migrate } from "../../src/db.js";
import { TELEGRAM_WEBHOOK_SECRET } from "../../src/config.js";

let schemaReady = false;

/** Equal-length, constant-time. A mismatched length is simply not equal. */
function secretMatches(got, want) {
  const a = Buffer.from(String(got || ""), "utf8");
  const b = Buffer.from(String(want || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async (req) => {
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405 });

  if (!TELEGRAM_WEBHOOK_SECRET) {
    console.error(
      "telegram webhook: TELEGRAM_WEBHOOK_SECRET is not set — refusing every update. " +
        "Alarms will still send; buttons, /start and /stop will not work. " +
        "Set TELEGRAM_WEBHOOK_SECRET in the site environment variables and redeploy; " +
        "the alarm-tick cron re-registers the webhook with it within a minute.",
    );
    return new Response("Not configured: TELEGRAM_WEBHOOK_SECRET is not set", {
      status: 503,
    });
  }

  // ".../webhook/123456789" — the trailing segment, when it is not "webhook"
  // itself, is the bot id. Read from the path rather than the body because
  // nothing in a Telegram update identifies the bot it was sent to.
  const { pathname } = new URL(req.url);
  const last = pathname.replace(/\/+$/, "").split("/").pop();
  const botId = /^\d+$/.test(last) ? last : null;

  if (
    !secretMatches(
      req.headers.get("x-telegram-bot-api-secret-token"),
      webhookSecretFor(botId),
    )
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  if (!schemaReady) {
    await migrate();
    schemaReady = true;
  }

  let update;
  try {
    update = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  try {
    await handleTelegramUpdate(update, { log: console.log, botId });
  } catch (err) {
    console.error(`telegram webhook: handler failed — ${err.message}`);
  }
  return new Response("ok", { status: 200 });
};

export const config = {
  path: ["/api/telegram/webhook", "/api/telegram/webhook/:botId"],
};
