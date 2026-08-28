/**
 * Session-credential handling.
 *
 * Two failure modes this covers, both of which surface to the user as the
 * same misleading "token is missing or has expired":
 *
 *  1. The paste is fine but mangled — quotes from DevTools, a `Bearer`
 *     prefix, a line-wrapped copy.
 *  2. The token is replayed without the device identity the official site
 *     sends alongside it (X-Device-Id / X-Device-Key), which upstream
 *     answers with the very same 401 as a genuine expiry.
 *
 *   node --test test/credentials.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// A stand-in for the upstream API, so the outgoing headers can be asserted.
// It has to exist before config.js is first evaluated.
let seenHeaders = null;
const stub = http.createServer((req, res) => {
  seenHeaders = req.headers;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: { trains: [] } }));
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.BR_API_BASE = `http://127.0.0.1:${stub.address().port}`;

const { normalizeCredentials, setDeviceIdentity, getDeviceIdentity, searchTrips } =
  await import(path.join(SRC, 'shohoz.js'));

after(() => stub.close());

const JWT = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwiZXhwIjo5OTk5OTk5OTk5fQ.abcdefghijklmnop';

test('accepts a bare token', () => {
  const c = normalizeCredentials(JWT);
  assert.equal(c.token, JWT);
  assert.equal(c.deviceId, null);
});

test('repairs the ways a copy gets mangled', () => {
  assert.equal(normalizeCredentials(`  ${JWT}  `).token, JWT, 'surrounding whitespace');
  assert.equal(normalizeCredentials(`"${JWT}"`).token, JWT, 'DevTools quotes');
  assert.equal(normalizeCredentials(`'${JWT}'`).token, JWT, 'single quotes');
  assert.equal(normalizeCredentials(`Bearer ${JWT}`).token, JWT, 'Bearer prefix');
  assert.equal(normalizeCredentials(`bearer ${JWT}`).token, JWT, 'lowercase bearer');
  assert.equal(normalizeCredentials(`"${JWT}",`).token, JWT, 'trailing comma from a JSON view');

  // A wrapped paste out of a narrow DevTools pane.
  const wrapped = `${JWT.slice(0, 30)}\n${JWT.slice(30, 60)}\n  ${JWT.slice(60)}`;
  assert.equal(normalizeCredentials(wrapped).token, JWT, 'line-wrapped copy');
});

test('accepts the console snippet output, device id included', () => {
  const blob = JSON.stringify({ token: JWT, deviceId: 'fp-abc123', deviceKey: 'dk-xyz' });
  const c = normalizeCredentials(blob);
  assert.equal(c.token, JWT);
  assert.equal(c.deviceId, 'fp-abc123');
  assert.equal(c.deviceKey, 'dk-xyz');
});

test('accepts raw localStorage key names too', () => {
  const c = normalizeCredentials(JSON.stringify({ token: JWT, uudid: 'fp-1', ssdk: 'dk-1' }));
  assert.equal(c.deviceId, 'fp-1');
  assert.equal(c.deviceKey, 'dk-1');
});

test('a missing device key is null, not the string "undefined"', () => {
  // JSON.stringify drops undefined values, so the snippet output on a browser
  // with no `ssdk` simply omits the field.
  const c = normalizeCredentials(JSON.stringify({ token: JWT, deviceId: 'fp-1' }));
  assert.equal(c.deviceKey, null);
});

test('garbage yields an empty token rather than throwing', () => {
  assert.equal(normalizeCredentials('').token, '');
  assert.equal(normalizeCredentials(null).token, '');
  assert.equal(normalizeCredentials('{not json').token, '{notjson');
});

test('device identity is actually sent on the wire', async () => {
  setDeviceIdentity({ deviceId: 'fp-wire', deviceKey: 'dk-wire' });
  assert.deepEqual(getDeviceIdentity(), { deviceId: 'fp-wire', deviceKey: 'dk-wire' });

  await searchTrips({ fromCity: 'Dhaka', toCity: 'Sylhet', dateISO: '2026-09-20', token: JWT });

  assert.equal(seenHeaders['x-device-id'], 'fp-wire', 'X-Device-Id sent');
  assert.equal(seenHeaders['x-device-key'], 'dk-wire', 'X-Device-Key sent');
  assert.equal(seenHeaders['x-requested-with'], 'XMLHttpRequest', 'X-Requested-With sent');
  assert.equal(seenHeaders.authorization, `Bearer ${JWT}`, 'bearer token sent');
});

test('no device headers are sent when none are known', async () => {
  setDeviceIdentity({});
  await searchTrips({ fromCity: 'Dhaka', toCity: 'Sylhet', dateISO: '2026-09-20', token: JWT });

  assert.equal(seenHeaders['x-device-id'], undefined, 'omitted, not sent empty');
  assert.equal(seenHeaders['x-device-key'], undefined);
  assert.equal(seenHeaders['x-requested-with'], 'XMLHttpRequest', 'still sent');
});
