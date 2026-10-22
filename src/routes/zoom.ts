import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { importRecording, urlValidation, verifyZoom } from '../lib/zoom';

export const zoom = new Hono<AppEnv>();

zoom.post('/webhook', async (c) => {
  const secret = c.env.ZOOM_WEBHOOK_SECRET;
  if (!secret) return c.text('Zoom is not set up yet', 503);
  const body = await c.req.text();
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return c.text('Bad request', 400);
  }
  // Zoom checks the address when it is saved in the Zoom app.
  if (event.event === 'endpoint.url_validation' && typeof event.payload?.plainToken === 'string') {
    return c.json(await urlValidation(secret, event.payload.plainToken));
  }
  if (!(await verifyZoom(secret, body, c.req.header('x-zm-request-timestamp'), c.req.header('x-zm-signature')))) {
    return c.text('Bad signature', 401);
  }
  if (event.event === 'recording.completed') {
    // Reply to Zoom straight away; the copy to Bunny carries on in the background.
    c.executionCtx.waitUntil(importRecording(c.env, event.payload).catch((e) => console.error('zoom import', e)));
  }
  return c.json({ received: true });
});
