/**
 * Telegram update receiver.
 *
 * The polling loop cannot exist on a serverless host, so Telegram pushes
 * updates here instead. setBotToken() registers this URL automatically when
 * PUBLIC_BASE_URL is set.
 *
 * Authenticity is the whole security story: the URL is guessable, so a request
 * is only trusted when it carries back the secret registered with setWebhook.
 * Without a configured secret nothing is accepted, rather than accepting
 * everything.
 */
import { handleTelegramUpdate } from '../../src/notify.js';
import { TELEGRAM_WEBHOOK_SECRET } from '../../src/config.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!TELEGRAM_WEBHOOK_SECRET) {
    console.error('telegram webhook: TELEGRAM_WEBHOOK_SECRET is not set — refusing updates');
    return new Response('Not configured', { status: 503 });
  }
  if (req.headers.get('x-telegram-bot-api-secret-token') !== TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }

  let update;
  try {
    update = await req.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  try {
    await handleTelegramUpdate(update, { log: console.log });
  } catch (err) {
    // Always 200: a non-2xx makes Telegram retry the same update forever, and
    // a handler bug would turn into an unbounded retry storm.
    console.error(`telegram webhook: handler failed — ${err.message}`);
  }
  return new Response('ok', { status: 200 });
};

export const config = { path: '/api/telegram/webhook' };
