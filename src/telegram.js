/**
 * Telegram Bot API transport.
 *
 * Telegram was chosen as the alarm channel because it needs no third-party
 * account beyond the bot itself, no npm dependency (this file is `fetch` and
 * nothing else), and its phone notifications already ring and vibrate — which
 * is what a sale-open alarm has to do.
 *
 * This module is pure transport plus the update loop. It knows nothing about
 * alerts or the database; `notify.js` supplies the handlers.
 */
import { TELEGRAM_API, TELEGRAM_BOT_TOKEN } from './config.js';

/**
 * The bot token is supplied at runtime, not at import time: it is saved from
 * the Settings UI into the database, so it can change while the server runs.
 * `notify.js` installs the real provider at boot; the env var is only a
 * fallback for a deployment that would rather not use the UI.
 */
let tokenProvider = async () => TELEGRAM_BOT_TOKEN;

export function setBotTokenProvider(fn) {
  tokenProvider = fn;
  botInfoCache.clear();
}

async function currentToken() {
  try { return (await tokenProvider()) || ''; } catch { return ''; }
}

export class TelegramError extends Error {
  constructor(message, { status = 0, code = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export async function botConfigured() {
  return Boolean(await currentToken());
}

/**
 * One Bot API call. `timeoutMs` is generous for getUpdates, which deliberately
 * holds the connection open until an update arrives.
 */
async function callApi(method, payload = {}, { timeoutMs = 20_000, token = null } = {}) {
  const botToken = token || await currentToken();
  if (!botToken) {
    throw new TelegramError(
      'No Telegram bot connected yet. Add the token @BotFather gave you in Settings.',
      { code: 'NOT_CONFIGURED' },
    );
  }

  let res;
  try {
    res = await fetch(`${TELEGRAM_API}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new TelegramError(
      timedOut ? `Telegram did not respond in time (${method})` : `Could not reach Telegram: ${err.message}`,
      { code: timedOut ? 'TIMEOUT' : 'UNREACHABLE' },
    );
  }

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    const desc = json?.description || `HTTP ${res.status}`;
    throw new TelegramError(`Telegram rejected ${method}: ${desc}`, {
      status: res.status,
      code: res.status === 401 ? 'BAD_BOT_TOKEN'
        : res.status === 403 ? 'BLOCKED'
        // 409 means getUpdates cannot run: either a webhook is registered on
        // this bot, or a second process is already long-polling it.
        : res.status === 409 ? 'CONFLICT'
        : 'API_ERROR',
      retryAfter: json?.parameters?.retry_after ?? null,
    });
  }
  return json.result;
}

/** Telegram's HTML parse mode needs exactly these three escaped. */
export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const botInfoCache = new Map();

/**
 * Bot identity, cached per token — used for the t.me deep link, and to verify
 * a token the moment someone pastes it. Keying by token means swapping bots
 * can never serve the previous bot's @username.
 */
export async function getBot({ refresh = false, token = null } = {}) {
  const key = token || await currentToken();
  if (!key) throw new TelegramError('No Telegram bot connected yet.', { code: 'NOT_CONFIGURED' });
  if (!refresh && botInfoCache.has(key)) return botInfoCache.get(key);

  const me = await callApi('getMe', {}, { token: key });
  const info = { id: me.id, username: me.username, name: me.first_name };
  botInfoCache.set(key, info);
  return info;
}

/**
 * A webhook and getUpdates are mutually exclusive. A bot that has ever had one
 * registered will 409 on every poll, so pairing silently never happens — the
 * user presses Start and nothing at all occurs. Clearing it is safe: this app
 * only ever polls.
 */
export async function clearWebhookIfSet({ token = null, log = () => {} } = {}) {
  try {
    const info = await callApi('getWebhookInfo', {}, { token });
    if (!info?.url) return { had: false };
    log(`telegram: a webhook was registered (${info.url}) — removing it so polling can work`);
    await callApi('deleteWebhook', { drop_pending_updates: false }, { token });
    return { had: true, url: info.url };
  } catch (err) {
    log(`telegram: could not check for a webhook — ${err.message}`);
    return { had: false, error: err.message };
  }
}

/**
 * Point the bot at a webhook instead of polling.
 *
 * Serverless has nowhere to run a long poll, so updates have to be pushed. The
 * secret token is echoed back by Telegram in the
 * X-Telegram-Bot-Api-Secret-Token header, which is what stops anyone who
 * guesses the URL from injecting fake updates.
 */
export async function setWebhook(url, { secret = null, token = null } = {}) {
  return callApi('setWebhook', {
    url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
    ...(secret ? { secret_token: secret } : {}),
  }, { token });
}

export async function getWebhookInfo({ token = null } = {}) {
  return callApi('getWebhookInfo', {}, { token });
}

export async function sendMessage(chatId, text, { buttons = null, silent = false } = {}) {
  return callApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: silent,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

/**
 * Remove a previous ring. Failure is expected and harmless — the user may have
 * deleted it, or it may be older than Telegram's 48-hour deletion window.
 */
export async function deleteMessage(chatId, messageId) {
  if (!messageId) return false;
  try {
    await callApi('deleteMessage', { chat_id: chatId, message_id: messageId });
    return true;
  } catch { return false; }
}

/** Rewrite a message in place. Editing does NOT produce a notification. */
export async function editMessageText(chatId, messageId, text, { buttons = null } = {}) {
  if (!messageId) return false;
  try {
    await callApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
    return true;
  } catch { return false; }
}

/** Clears the spinner on a tapped inline button; Telegram requires an answer. */
export async function answerCallback(callbackQueryId, text = '') {
  return callApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: false })
    .catch(() => null); // Purely cosmetic — never fail an ack over it.
}

/**
 * Long-poll update loop.
 *
 * `getOffset`/`setOffset` persist Telegram's cursor so a restart does not
 * replay old commands (which would re-pair stale codes). Handlers are called
 * one update at a time; a throwing handler is logged and skipped so one bad
 * update cannot wedge the loop.
 */
export function startTelegramListener({ getOffset, setOffset, onMessage, onCallback, log = console.log }) {
  let stopped = false;
  let backoffMs = 1_000;
  // Tracks which token we last announced, so adding, swapping or removing a
  // token from the UI is picked up mid-flight — no restart, and no log spam.
  let announced = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    while (!stopped) {
      const token = await currentToken();

      if (!token) {
        if (announced !== null) {
          log('telegram: bot disconnected — sale-open alarms are paused');
          announced = null;
        }
        await sleep(3_000); // Idle until a token is saved in the UI.
        continue;
      }

      if (announced !== token) {
        try {
          const me = await getBot({ token });
          await clearWebhookIfSet({ token, log });
          log(`telegram: listening as @${me.username}`);
          announced = token;
          backoffMs = 1_000;
        } catch (err) {
          log(`telegram: cannot reach the Bot API — ${err.message}`);
          await sleep(5_000);
          continue;
        }
      }

      try {
        const offset = Number(await getOffset()) || 0;
        const updates = await callApi('getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        }, { timeoutMs: 40_000, token });

        backoffMs = 1_000;
        if (!updates.length) continue;

        for (const u of updates) {
          try {
            if (u.message) await onMessage?.(u.message);
            else if (u.callback_query) await onCallback?.(u.callback_query);
          } catch (err) {
            log(`telegram: handler failed on update ${u.update_id} — ${err.message}`);
          }
        }
        // Acknowledge only after handling, so a crash mid-batch replays it.
        await setOffset(updates[updates.length - 1].update_id + 1);
      } catch (err) {
        if (stopped) break;
        if (err.code === 'TIMEOUT') continue; // Normal for an idle long poll.
        if (err.code === 'BAD_BOT_TOKEN') {
          // Do not give up: the user can paste a corrected token at any moment.
          log('telegram: bot token rejected — waiting for a corrected one');
          announced = null;
          await sleep(10_000);
          continue;
        }
        if (err.code === 'CONFLICT') {
          // Almost always a second copy of this server polling the same bot;
          // occasionally a leftover webhook. Say which, because the symptom
          // (pressing Start does nothing) gives the user no clue.
          log('telegram: getUpdates conflict — another process is polling this ' +
              'bot, or a webhook is set. Stop the other copy, or use a second bot.');
          await clearWebhookIfSet({ token, log });
          await sleep(10_000);
          continue;
        }
        const wait = err.retryAfter ? err.retryAfter * 1000 : backoffMs;
        log(`telegram: ${err.message} — retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  })();

  return { stop() { stopped = true; } };
}
