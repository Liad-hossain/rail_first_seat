import { TELEGRAM_BOT_TOKEN } from './config.js';
import { query, one } from './db.js';
import { getBot } from './telegram.js';

/** A bot token is "<bot id>:<secret>". The id half is not sensitive. */
export const BOT_TOKEN_RE = /^(\d+):[A-Za-z0-9_-]{20,}$/;

export function botIdOf(token) {
  const m = BOT_TOKEN_RE.exec(String(token || '').trim());
  return m ? m[1] : null;
}

const COLUMNS = `id, bot_id, token, username, name, owner_id, created_at,
                 token_saved_at, update_offset, delivery_mode, webhook_url,
                 webhook_secret_fp, is_default`;

export async function listBots() {
  return query(`SELECT ${COLUMNS} FROM bots ORDER BY id`);
}

export async function botByRowId(id) {
  if (!id) return null;
  return one(`SELECT ${COLUMNS} FROM bots WHERE id = $1`, [id]);
}

/** By the numeric half of the token — the webhook's path segment. */
export async function botByBotId(botId) {
  if (!botId) return null;
  return one(`SELECT ${COLUMNS} FROM bots WHERE bot_id = $1`, [String(botId)]);
}


export async function defaultBot() {
  return one(`SELECT ${COLUMNS} FROM bots WHERE is_default LIMIT 1`);
}

/** The bot a signed-in account's chat lives on. */
export async function botForSubscriber(subscriberId) {
  if (!subscriberId) return null;
  return one(
    `SELECT b.* FROM bots b JOIN notify_subscribers s ON s.bot_id = b.id
      WHERE s.id = $1`,
    [subscriberId],
  );
}

export async function countBots() {
  const row = await one('SELECT COUNT(*)::int AS n FROM bots');
  return row?.n ?? 0;
}

/** Is there any bot at all to ring through? */
export async function anyBotConfigured() {
  return (await countBots()) > 0;
}


export async function upsertBot(token, { isDefault = false } = {}) {
  const trimmed = String(token || '').trim();
  const botId = botIdOf(trimmed);
  if (!botId) throw new Error('malformed bot token');

  const me = await getBot({ token: trimmed, refresh: true });

  const row = await one(
    `INSERT INTO bots (bot_id, token, username, name, is_default, token_saved_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (bot_id) DO UPDATE
       SET token = EXCLUDED.token,
           username = EXCLUDED.username,
           name = EXCLUDED.name,
           token_saved_at = now(),
           is_default = bots.is_default OR EXCLUDED.is_default
       -- update_offset is deliberately untouched: update ids are numbered per
       -- bot, and a reissued token is the same bot, so the cursor stays valid.
       -- owner_id too — a re-save must never reassign the bot.
     RETURNING ${COLUMNS}`,
    [botId, trimmed, me.username || null, me.name || null, isDefault],
  );
  return { bot: row, me };
}

/** Claimed by the first chat to pair. Never reassigns an owned bot. */
export async function claimBot(botRowId, subscriberId) {
  return one(
    `UPDATE bots SET owner_id = $2 WHERE id = $1 AND owner_id IS NULL
     RETURNING ${COLUMNS}`,
    [botRowId, subscriberId],
  );
}


export async function deleteBot(botRowId) {
  const { n } = await one(
    'SELECT COUNT(*)::int AS n FROM notify_subscribers WHERE bot_id = $1',
    [botRowId],
  );
  await query('DELETE FROM bots WHERE id = $1', [botRowId]);
  return { removedSubscribers: n };
}

export async function setBotOffset(botRowId, offset) {
  await query('UPDATE bots SET update_offset = $2 WHERE id = $1', [
    botRowId,
    Number(offset) || 0,
  ]);
}

export async function getBotOffset(botRowId) {
  const row = await one('SELECT update_offset FROM bots WHERE id = $1', [botRowId]);
  return Number(row?.update_offset) || 0;
}

export async function setBotWebhook(botRowId, { url, secretFp, mode }) {
  await query(
    `UPDATE bots SET webhook_url = $2, webhook_secret_fp = $3, delivery_mode = $4
      WHERE id = $1`,
    [botRowId, url || null, secretFp || null, mode || null],
  );
}


export async function ensureDefaultBot({ log = () => {} } = {}) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  const botId = botIdOf(TELEGRAM_BOT_TOKEN);
  if (!botId) {
    log('telegram: TELEGRAM_BOT_TOKEN is not a valid bot token — ignoring it');
    return null;
  }

  const existing = await botByBotId(botId);
  // Already known and named: nothing to do, and no getMe round trip at boot.
  if (existing?.username) {
    if (!existing.is_default) {
      await query('UPDATE bots SET is_default = TRUE WHERE id = $1', [existing.id]);
    }
    return existing;
  }

  try {
    const { bot } = await upsertBot(TELEGRAM_BOT_TOKEN, { isDefault: true });
    log(`telegram: default bot @${bot.username} available to visitors with no bot of their own`);
    return bot;
  } catch (err) {
    log(`telegram: could not verify TELEGRAM_BOT_TOKEN — ${err.message}`);
    return existing || null;
  }
}


export function describeBot(bot, { viewerId = null } = {}) {
  if (!bot) return { present: false };
  return {
    present: true,
    botId: bot.bot_id,
    username: bot.username || null,
    name: bot.name || null,
    savedAt: bot.token_saved_at ? new Date(bot.token_saved_at).toISOString() : null,
    preview: `${bot.bot_id}:${'•'.repeat(6)}${String(bot.token).slice(-4)}`,
    isDefault: bot.is_default === true,
    // A default bot belongs to the deployment, not to a person, so nobody can
    // replace or disconnect it through the UI.
    owned: Boolean(bot.owner_id),
    isOwner: Boolean(viewerId) && String(bot.owner_id) === String(viewerId),
  };
}
