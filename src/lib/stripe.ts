import type { Env } from './types';

const API = 'https://api.stripe.com/v1';

function form(data: Record<string, string>) {
  return new URLSearchParams(data).toString();
}

export async function createCheckoutSession(
  env: Env,
  opts: { enrollmentId: number; email: string; name: string; amountCents: number; productName: string; siteUrl: string },
): Promise<{ id: string; url: string }> {
  const res = await fetch(`${API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(opts.amountCents),
      'line_items[0][price_data][product_data][name]': opts.productName,
      customer_email: opts.email,
      client_reference_id: String(opts.enrollmentId),
      'metadata[enrollment_id]': String(opts.enrollmentId),
      success_url: `${opts.siteUrl}/enroll/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${opts.siteUrl}/enroll?cancelled=1`,
    }),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`Stripe error: ${json?.error?.message ?? res.status}`);
  return { id: json.id, url: json.url };
}

export async function retrieveCheckoutSession(env: Env, id: string) {
  const res = await fetch(`${API}/checkout/sessions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as { id: string; payment_status: string; amount_total: number; client_reference_id: string };
}

/** Verifies the Stripe-Signature header (HMAC-SHA256 over "timestamp.payload"). */
export async function verifyWebhook(payload: string, header: string | undefined, secret: string, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = parts['t'];
  const sigs = header
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => s.length === hex.length && [...s].every((ch, i) => ch === hex[i]));
}

/** Marks an enrollment paid. Safe to call more than once (webhook and success page both do). */
export async function activateEnrollment(db: D1Database, sessionId: string, enrollmentId: number, amountCents: number) {
  const cohort = await db.prepare('SELECT id FROM cohorts ORDER BY start_date DESC LIMIT 1').first<{ id: number }>();
  await db
    .prepare(
      `UPDATE enrollments SET status = 'active', paid_at = COALESCE(paid_at, datetime('now')), amount_cents = ?,
         cohort_id = COALESCE(cohort_id, ?)
       WHERE id = ? AND stripe_session_id = ? AND status = 'pending'`,
    )
    .bind(amountCents, cohort?.id ?? null, enrollmentId, sessionId)
    .run();
}
