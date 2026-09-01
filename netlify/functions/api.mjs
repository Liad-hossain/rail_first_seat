/**
 * The JSON API, as a Netlify Function.
 *
 * Routing, validation and error mapping all live in src/server.js — this only
 * translates between a Fetch Request/Response and dispatch()'s plain values,
 * exactly as src/serve.js does for Node's req/res. Nothing about the API's
 * behaviour differs between the two deployments.
 */
import { dispatch, SECURITY_HEADERS } from '../../src/server.js';
import { migrate } from '../../src/db.js';
import { ensureBots } from '../../src/notify.js';

/**
 * The schema is idempotent and guarded by an advisory lock, so running it once
 * per container is cheap and means a fresh deploy needs no manual step. The
 * flag keeps it to once per container rather than once per request.
 */
let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await migrate();
  // The shared bot is part of "this deployment is set up": without it a fresh
  // container would report no bot at all until the next cron pass.
  await ensureBots({ log: console.log }).catch((err) =>
    console.error(`shared bot: ${err.message}`));
  schemaReady = true;
}

export default async (req) => {
  const url = new URL(req.url);

  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    const text = await req.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return Response.json({ error: 'Request body must be valid JSON' }, { status: 400 });
      }
    }
  }

  try {
    await ensureSchema();
  } catch (err) {
    return Response.json(
      { error: `Database unavailable: ${err.message}` },
      { status: 503, headers: SECURITY_HEADERS },
    );
  }

  const result = await dispatch({
    method: req.method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    body,
    headers: Object.fromEntries(req.headers),
  });

  return Response.json(result.body, {
    status: result.status,
    headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store' },
  });
};

export const config = {
  // Everything under /api except the Telegram webhook, which is its own
  // function so that Telegram's retries never queue behind a browser request.
  path: '/api/*',
  excludedPath: '/api/telegram/*',
};
