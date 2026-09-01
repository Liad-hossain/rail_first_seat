/**
 * Tapping "Stop alarm" must put a matchable stop signal on the wire, and it
 * must not carry the start tag — a macro matching #RAILALARM would otherwise
 * re-arm the alarm it was just told to end.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';

const SRC = path.resolve(process.cwd(), 'src');
const sent = [];
const edited = [];

mock.module(path.join(SRC, 'telegram.js'), {
  namedExports: {
    botConfigured: async () => true,
    getBot: async () => ({ id: 1, username: 't', name: 'T' }),
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { message_id: 7 }; },
    answerCallback: async () => null,
    startTelegramListener: () => ({ stop() {} }),
    setBotTokenProvider: () => {},
    clearWebhookIfSet: async () => ({ had: false }),
    setWebhook: async () => true,
    getWebhookInfo: async () => ({ url: '' }),
    deleteMessage: async () => true,
    editMessageText: async (chatId, id, text) => { edited.push(text); return true; },
    esc: (s) => String(s ?? ''),
    TelegramError: class extends Error {},
  },
});

const { migrate, query, one, closePool } = await import(path.join(SRC, 'db.js'));
const { addDays, todayISO } = await import(path.join(SRC, 'time.js'));
const notify = await import(path.join(SRC, 'notify.js'));
const { ADVANCE_DAYS, ALARM_TRIGGER_TAG, ALARM_STOP_TAG } = await import(path.join(SRC, 'config.js'));

await migrate();
// An account is a chat on a bot, and every reply goes back out through that
// bot — so the update has to name which bot it arrived on, exactly as the
// webhook path and the poll loop do in production.
const botToken = `${900000000 + Math.floor(Math.random() * 99999999)}:test-${crypto.randomUUID()}`;
const bot = await one(
  `INSERT INTO bots (bot_id, token, username, name)
   VALUES (split_part($1,':',1), $1, 't', 'T') RETURNING id, bot_id`,
  [botToken],
);
const chatId = `stoptag-${crypto.randomUUID()}`;
const subscriber = await one(
  `INSERT INTO notify_subscribers (bot_id, chat_id, display_name, access_token, created_at)
   VALUES ($1,$2,'Stop Tag',$3,now()) RETURNING id, chat_id, display_name`,
  [bot.id, chatId, crypto.randomUUID()],
);
after(async () => {
  await query('DELETE FROM notify_subscribers WHERE chat_id = $1', [chatId]);
  await query('DELETE FROM bots WHERE id = $1', [bot.id]);
  await closePool();
});

test('the two tags cannot match each other', () => {
  assert.ok(!ALARM_STOP_TAG.includes(ALARM_TRIGGER_TAG), 'stop tag does not contain the start tag');
  assert.ok(!ALARM_TRIGGER_TAG.includes(ALARM_STOP_TAG), 'start tag does not contain the stop tag');
});

test('tapping Stop alarm emits a silent, matchable stop signal', async () => {
  const alert = await notify.createAlert({
    subscriber, fromCity: 'Dhaka', toCity: 'Sreemangal', dateISO: addDays(todayISO(), ADVANCE_DAYS + 6),
  });
  await query("UPDATE alerts SET status = 'fired', fired_at = now() WHERE id = $1", [alert.id]);

  sent.length = 0; edited.length = 0;
  await notify.handleTelegramUpdate({
    callback_query: { id: 'cb1', data: `ack:${alert.id}`, message: { message_id: 42, chat: { id: chatId } } },
  }, { log: () => {}, botId: bot.bot_id });

  assert.equal(edited.length, 1, 'the ringing message was edited');
  assert.match(edited[0], /Alarm stopped/);

  assert.equal(sent.length, 1, 'a NEW message was sent — an edit alone notifies nothing');
  assert.ok(sent[0].text.includes(ALARM_STOP_TAG), `carries ${ALARM_STOP_TAG}`);
  assert.ok(!sent[0].text.includes(ALARM_TRIGGER_TAG), 'does NOT carry the start tag');
  assert.equal(sent[0].opts?.silent, true, 'sent silently');

  const row = await one('SELECT acknowledged_at FROM alerts WHERE id = $1', [alert.id]);
  assert.ok(row.acknowledged_at, 'still acknowledged server-side');
});

test('/stop carries the stop tag as well', async () => {
  sent.length = 0;
  await notify.handleTelegramUpdate({
    message: { chat: { id: chatId }, from: { first_name: 'X' }, text: '/stop' },
  }, { log: () => {}, botId: bot.bot_id });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes(ALARM_STOP_TAG), 'stop tag present');
  assert.ok(!sent[0].text.includes(ALARM_TRIGGER_TAG), 'start tag absent');
});
