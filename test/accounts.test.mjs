/**
 * Account separation.
 *
 * The site is public: schedules, sale times and the countdown must keep working
 * with no account at all. Everything that is genuinely someone's own — their
 * alarms, their Bangladesh Railway session — must be invisible and unreachable
 * to anyone else, and to anonymous visitors.
 *
 * These drive dispatch() directly, which is the same entry point the HTTP server
 * and the Netlify function both use, so a guard cannot be right here and missing
 * in one transport.
 *
 *   node --experimental-test-module-mocks --test test/accounts.test.mjs
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// No real Telegram, and no real upstream: this is about who may reach what.
mock.module(path.join(SRC, 'telegram.js'), {
  namedExports: {
    botConfigured: async () => true,
    getBot: async () => ({ id: 1, username: 'test_bot', name: 'Test' }),
    sendMessage: async () => ({ message_id: 1 }),
    answerCallback: async () => null,
    startTelegramListener: () => ({ stop() {} }),
    setBotTokenProvider: () => {},
    clearWebhookIfSet: async () => ({ had: false }),
    setWebhook: async () => true,
    getWebhookInfo: async () => ({ url: '' }),
    deleteMessage: async () => true,
    editMessageText: async () => true,
    esc: (s) => String(s ?? ''),
    TelegramError: class extends Error {},
  },
});

const { migrate, query, one, closePool } = await import(path.join(SRC, 'db.js'));
const { dispatch } = await import(path.join(SRC, 'server.js'));

await migrate();

/**
 * A throwaway account, on a throwaway bot it owns.
 *
 * An account is a Telegram chat ON A BOT, and the bot belongs to whoever paired
 * on it first — so a realistic account has both. Returns the bearer secret its
 * browser would hold.
 */
async function makeAccount(name) {
  const token = crypto.randomUUID();
  const botToken = `${900000000 + Math.floor(Math.random() * 99999999)}:test-${crypto.randomUUID()}`;
  const bot = await one(
    `INSERT INTO bots (bot_id, token, username, name)
     VALUES (split_part($1,':',1), $1, $2, $2) RETURNING id, bot_id, token`,
    [botToken, `${name.toLowerCase()}_bot`],
  );
  const row = await one(
    `INSERT INTO notify_subscribers (bot_id, chat_id, display_name, access_token, created_at)
     VALUES ($1,$2,$3,$4,now()) RETURNING id`,
    [bot.id, `acct-${name}-${crypto.randomUUID()}`, name, token],
  );
  await query('UPDATE bots SET owner_id = $2 WHERE id = $1', [bot.id, row.id]);
  return { id: row.id, token, bot };
}

const alice = await makeAccount('Alice');
const bob = await makeAccount('Bob');

after(async () => {
  await query('DELETE FROM notify_subscribers WHERE id = ANY($1)', [[alice.id, bob.id]]);
  await query('DELETE FROM bots WHERE id = ANY($1)', [[alice.bot.id, bob.bot.id]]);
  await closePool();
});

/** dispatch() with an optional session, mirroring what the browser sends. */
const call = (method, pathname, { as = null, body = {}, q = '' } = {}) => dispatch({
  method,
  pathname,
  searchParams: new URLSearchParams(q),
  body,
  headers: as ? { 'x-notify-token': as.token } : {},
});

const ANON_OK = [
  ['GET', '/api/health'],
  ['GET', '/api/meta'],
  ['GET', '/api/stations'],
  ['GET', '/api/watchlist'],
  ['GET', '/api/notify/status'],
];

test('the dashboard works with no account at all', async () => {
  for (const [method, pathname] of ANON_OK) {
    const res = await call(method, pathname);
    assert.equal(res.status, 200, `${method} ${pathname} is public`);
  }
});

test('a signed-out visitor gets schedules and sale times, just no live seats', async () => {
  const res = await call('GET', '/api/search', { q: 'from=Dhaka&to=Sreemangal&date=2026-09-15' });
  assert.equal(res.status, 200);
  assert.equal(res.body.tokenPresent, false, 'no railway session is borrowed from anyone');
  assert.ok(res.body.firstAvailability, 'the sale-open answer still comes back');
  assert.ok(res.body.trains.length > 0, 'and so does the timetable');
});

const GUARDED = [
  ['GET', '/api/token', {}],
  ['POST', '/api/token', { body: { token: 'x' } }],
  ['POST', '/api/collect', {}],
  ['POST', '/api/sync', {}],
  ['POST', '/api/watchlist', { body: { from: 'Dhaka', to: 'Sylhet' } }],
  ['DELETE', '/api/watchlist', { q: 'from=Dhaka&to=Sylhet' }],
  ['GET', '/api/notify/alerts', {}],
  ['POST', '/api/notify/alerts', { body: { from: 'Dhaka', to: 'Sylhet', date: '2026-12-01' } }],
  ['DELETE', '/api/notify/alerts', { q: 'id=1' }],
  ['POST', '/api/notify/test', {}],
  ['DELETE', '/api/notify/bot', {}],
];

test('everything personal or site-wide demands an account, and says so', async () => {
  for (const [method, pathname, opts] of GUARDED) {
    const res = await call(method, pathname, opts);
    assert.equal(res.status, 401, `${method} ${pathname} is guarded`);
    assert.equal(res.body.needsLogin, true, `${method} ${pathname} tells the UI to offer sign-in`);
  }
});

test('one account cannot see or use another account\'s railway session', async () => {
  // Alice saves a session directly — the HTTP path would need a live upstream.
  const jwt = `aaa.${Buffer.from(JSON.stringify({ exp: 4102444800, display_name: 'Alice R' })).toString('base64url')}.zzz`;
  await query(
    `UPDATE notify_subscribers
        SET br_token = $2, br_device_id = 'alice-device', br_token_saved_at = now()
      WHERE id = $1`,
    [alice.id, jwt],
  );

  const hers = await call('GET', '/api/token', { as: alice });
  assert.equal(hers.status, 200);
  assert.equal(hers.body.present, true, 'Alice sees her own session');
  assert.equal(hers.body.hasDeviceId, true);
  assert.ok(!JSON.stringify(hers.body).includes(jwt), 'but never the raw token, even to its owner');

  const his = await call('GET', '/api/token', { as: bob });
  assert.equal(his.status, 200);
  assert.equal(his.body.present, false, "Bob sees nothing of Alice's session");

  // And Bob's searches must not silently ride on Alice's session.
  const search = await call('GET', '/api/search', {
    as: bob, q: 'from=Dhaka&to=Sreemangal&date=2026-09-15',
  });
  assert.equal(search.body.tokenPresent, false, "Bob's search does not borrow Alice's token");

  const anonMeta = await call('GET', '/api/meta');
  assert.equal(anonMeta.body.token.present, false, 'and nor does an anonymous visitor');
  assert.equal(anonMeta.body.account.signedIn, false);
});

test('alarms are listed per account', async () => {
  const mine = await call('GET', '/api/notify/alerts', { as: alice });
  const theirs = await call('GET', '/api/notify/alerts', { as: bob });
  assert.equal(mine.status, 200);
  assert.equal(theirs.status, 200);

  await query(
    `INSERT INTO alerts (subscriber_id, from_city, to_city, journey_date, opens_at, status, created_at)
     VALUES ($1,'Dhaka','Sylhet','2026-12-01', now() + interval '5 days', 'active', now())`,
    [alice.id],
  );

  const after1 = await call('GET', '/api/notify/alerts', { as: alice });
  const after2 = await call('GET', '/api/notify/alerts', { as: bob });
  assert.equal(after1.body.alerts.length, mine.body.alerts.length + 1, 'Alice sees her new alarm');
  assert.equal(after2.body.alerts.length, theirs.body.alerts.length, 'Bob sees no change');
});

test('a stale or forged session is refused, not treated as anonymous', async () => {
  const res = await call('GET', '/api/token', { as: { token: 'not-a-real-secret' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.needsLogin, true);
});

test('/api/meta names the signed-in account and never leaks the secret', async () => {
  const res = await call('GET', '/api/meta', { as: alice });
  assert.equal(res.body.account.signedIn, true);
  assert.equal(res.body.account.displayName, 'Alice');
  assert.ok(!JSON.stringify(res.body).includes(alice.token), 'the bearer secret is never echoed');
});

/* ------------------------------------------------------------------ *
 * Bots
 *
 * The bot used to be one site-wide token in `meta`: everybody paired with
 * whoever's bot was installed, an anonymous visitor could read its @username
 * and masked token, and any signed-in account could swap or delete it out from
 * under everyone else. A bot is now somebody's property, and these are the
 * three ways that could still leak.
 * ------------------------------------------------------------------ */

test("each account sees its own bot and no trace of anyone else's", async () => {
  const hers = await call('GET', '/api/notify/status', { as: alice });
  assert.equal(hers.status, 200);
  assert.equal(hers.body.bot.present, true, 'Alice sees a bot');
  assert.equal(hers.body.bot.username, 'alice_bot', 'and it is hers');
  assert.equal(hers.body.bot.isOwner, true, 'which she owns');

  const his = await call('GET', '/api/notify/status', { as: bob });
  const seen = JSON.stringify(his.body);
  assert.equal(his.body.bot.username, 'bob_bot', 'Bob sees his own bot');
  assert.ok(!seen.includes('alice_bot'), "and nothing of Alice's");
  assert.ok(!seen.includes(alice.bot.token), 'and no bot token, ever');
});

test('an anonymous visitor learns nothing about anybody\'s bot', async () => {
  const res = await call('GET', '/api/notify/status');
  assert.equal(res.status, 200);
  const seen = JSON.stringify(res.body);
  assert.ok(!seen.includes('alice_bot') && !seen.includes('bob_bot'), 'no @usernames');
  assert.ok(
    !seen.includes(alice.bot.token) && !seen.includes(bob.bot.token),
    'no bot tokens',
  );
  assert.equal(res.body.bot.preview, undefined, 'not even a masked preview');
  assert.equal(res.body.webhook, undefined, 'and no webhook internals');
  assert.equal(res.body.publicBaseUrl, undefined, 'nor the deployment URL');
});

test("one account can neither take over nor delete another's bot", async () => {
  const stolen = await call('POST', '/api/notify/bot', {
    as: bob, body: { token: alice.bot.token },
  });
  assert.equal(stolen.status, 400, "Bob cannot re-register Alice's bot");
  assert.equal(stolen.body.code, 'OWNED');

  // Disconnecting reaches only the caller's own bot — there is no "the" bot to
  // aim at any more. It takes Bob's account with it, which is why this is last.
  const gone = await call('DELETE', '/api/notify/bot', { as: bob });
  assert.equal(gone.status, 200);
  assert.equal(gone.body.removedSubscribers, 1, 'his own account went with it');

  const after = await call('GET', '/api/notify/status', { as: alice });
  assert.equal(after.body.bot.username, 'alice_bot', "Alice's bot is untouched");
});
