/**
 * The alarm scheduler, as a cron.
 *
 * A persistent process arms a precise timer and fires within milliseconds of
 * the sale instant. Cron granularity is one minute, so this runs every minute
 * and closes the gap by waiting out the last few seconds inside the invocation
 * when an alarm is about to become due. Expect a few seconds of lag rather
 * than a few hundred milliseconds.
 */
import { runAlarmTick, resyncAlertOpenTimes, ensureWebhook } from '../../src/notify.js';
import { probeSaleRelease } from '../../src/history.js';
import { migrate, getMeta } from '../../src/db.js';
import { setDeviceIdentity } from '../../src/shohoz.js';

let schemaReady = false;

export default async () => {
  if (!schemaReady) { await migrate(); schemaReady = true; }

  // Inbound updates die silently if the webhook is cleared — outbound keeps
  // working, so nothing looks wrong until a button press does nothing.
  try { await ensureWebhook({ log: console.log }); }
  catch (err) { console.error(`webhook check: ${err.message}`); }

  // A once-a-minute cron is exactly the cadence the release probe wants, so it
  // rides along rather than needing a scheduled function of its own.
  try {
    const token = (await getMeta('br_token')) || process.env.BR_TOKEN || null;
    if (token) {
      setDeviceIdentity({
        deviceId: (await getMeta('br_device_id')) || process.env.BR_DEVICE_ID || null,
        deviceKey: (await getMeta('br_device_key')) || process.env.BR_DEVICE_KEY || null,
      });
      const probe = await probeSaleRelease({ token, log: console.log });
      if (probe.measured) await resyncAlertOpenTimes({ log: console.log });
    }
  } catch (err) {
    console.error(`release probe: ${err.message}`);
  }

  const result = await runAlarmTick({
    log: console.log,
    // Netlify allows 30s for a scheduled function; 8s of waiting keeps a wide
    // margin for the DB round trip and the Telegram send that follow.
    waitWindowMs: 8_000,
  });

  if (result.fired || result.retried || result.expired) console.log('alarm tick:', result);
  return new Response('ok');
};

export const config = { schedule: '* * * * *' };
