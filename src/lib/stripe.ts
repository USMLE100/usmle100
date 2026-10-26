import type { Env } from './types';

const API = 'https://api.stripe.com/v1';

function form(data: Record<string, string>) {
  return new URLSearchParams(data).toString();
}

/**
 * A one-time Stripe Checkout payment. `ref` identifies what is being bought:
 * an enrollment ("123", kept as a plain number for checkouts started before Course Book sales existed)
 * or a Course Book purchase ("book-45").
 */
export async function createCheckoutSession(
  env: Env,
  opts: { ref: string; kind: 'enrollment' | 'book'; email: string; amountCents: number; productName: string; successPath: string; cancelPath: string; siteUrl: string },
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
      client_reference_id: opts.ref,
      'metadata[kind]': opts.kind,
      success_url: `${opts.siteUrl}${opts.successPath}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${opts.siteUrl}${opts.cancelPath}`,
    }),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`Stripe error: ${json?.error?.message ?? res.status}`);
  return { id: json.id, url: json.url };
}

/** The fields of a Checkout Session the site relies on. */
export type PaidSession = { id: string; payment_status: string; amount_total: number; currency: string; client_reference_id: string | null };

export async function retrieveCheckoutSession(env: Env, id: string) {
  const res = await fetch(`${API}/checkout/sessions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as PaidSession;
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

/**
 * Marks an enrollment paid. Safe to call more than once (webhook and success page both do):
 * only a pending enrollment with this exact checkout session and the expected amount is activated.
 */
export async function activateEnrollment(db: D1Database, sessionId: string, enrollmentId: number, amountCents: number) {
  const cohort = await db.prepare('SELECT id FROM cohorts ORDER BY start_date DESC LIMIT 1').first<{ id: number }>();
  await db
    .prepare(
      `UPDATE enrollments SET status = 'active', paid_at = COALESCE(paid_at, datetime('now')), amount_cents = ?1,
         cohort_id = COALESCE(cohort_id, ?2)
       WHERE id = ?3 AND stripe_session_id = ?4 AND status = 'pending' AND (amount_cents IS NULL OR amount_cents = ?1)`,
    )
    .bind(amountCents, cohort?.id ?? null, enrollmentId, sessionId)
    .run();
}

/**
 * Marks a Course Book purchase paid and gives the Course Book, in one transaction.
 * Runs once per purchase: a repeated webhook or a second visit to the success page changes nothing.
 * Returns true when this call did the fulfilment.
 */
export async function fulfilBookPurchase(db: D1Database, sessionId: string, purchaseId: number, amountCents: number) {
  const [upd] = await db.batch([
    db.prepare("UPDATE book_purchases SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND stripe_session_id = ? AND status = 'pending' AND amount_cents = ?").bind(purchaseId, sessionId, amountCents),
    db
      .prepare(
        `INSERT INTO book_access (user_id, note) SELECT user_id, 'Bought online · purchase ' || id FROM book_purchases WHERE id = ? AND changes() > 0
         ON CONFLICT (user_id) DO NOTHING`,
      )
      .bind(purchaseId),
  ]);
  return (upd.meta.changes ?? 0) > 0;
}

/** Apply a paid Checkout Session to whatever it bought. Ignores anything not fully paid in US dollars. */
export async function fulfil(db: D1Database, s: PaidSession) {
  if (s.payment_status !== 'paid' || (s.currency ?? 'usd').toLowerCase() !== 'usd' || !s.client_reference_id) return;
  const ref = s.client_reference_id;
  const book = /^book-(\d+)$/.exec(ref);
  if (book) await fulfilBookPurchase(db, s.id, Number(book[1]), s.amount_total);
  else if (/^\d+$/.test(ref)) await activateEnrollment(db, s.id, Number(ref), s.amount_total);
}
