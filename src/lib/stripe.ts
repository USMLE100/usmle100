import { audit } from './audit';
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
export type PaidSession = { id: string; payment_status: string; amount_total: number; currency: string; client_reference_id: string | null; payment_intent?: string | null };

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
  const r = await db
    .prepare(
      `UPDATE enrollments SET status = 'active', paid_at = COALESCE(paid_at, datetime('now')), amount_cents = ?1,
         cohort_id = COALESCE(cohort_id, ?2)
       WHERE id = ?3 AND stripe_session_id = ?4 AND status = 'pending' AND (amount_cents IS NULL OR amount_cents = ?1)`,
    )
    .bind(amountCents, cohort?.id ?? null, enrollmentId, sessionId)
    .run();
  return (r.meta.changes ?? 0) > 0;
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
  if (book) {
    if (await fulfilBookPurchase(db, s.id, Number(book[1]), s.amount_total)) {
      const p = await db.prepare('SELECT user_id FROM book_purchases WHERE id = ?').bind(Number(book[1])).first<{ user_id: number }>();
      await audit(db, { action: 'payment.book', targetUserId: p?.user_id ?? null, detail: { purchase: Number(book[1]), cents: s.amount_total, session: s.id } });
    }
  } else if (/^\d+$/.test(ref)) {
    if (await activateEnrollment(db, s.id, Number(ref), s.amount_total)) {
      const e = await db.prepare('SELECT user_id, package_id FROM enrollments WHERE id = ?').bind(Number(ref)).first<{ user_id: number; package_id: string }>();
      await audit(db, { action: 'payment.enrollment', targetUserId: e?.user_id ?? null, detail: { enrollment: Number(ref), pkg: e?.package_id, cents: s.amount_total, session: s.id } });
    }
  }
  // Remember the payment, so a refund issued later in Stripe can be matched to this purchase.
  if (s.payment_intent) {
    await db.batch([
      db.prepare('UPDATE book_purchases SET payment_intent = ? WHERE stripe_session_id = ? AND payment_intent IS NULL').bind(s.payment_intent, s.id),
      db.prepare('UPDATE enrollments SET payment_intent = ? WHERE stripe_session_id = ? AND payment_intent IS NULL').bind(s.payment_intent, s.id),
    ]);
  }
}

/** The fields of a Stripe Charge used for refunds. */
export type RefundedCharge = { id: string; payment_intent: string | null; amount: number; amount_refunded: number; refunded: boolean };

/** Checkout Session IDs for a payment, asked from Stripe (only needed for purchases made before payments were remembered). */
async function sessionsForPayment(env: Env, paymentIntent: string): Promise<string[]> {
  if (!env.STRIPE_SECRET_KEY) return [];
  const res = await fetch(`${API}/checkout/sessions?payment_intent=${encodeURIComponent(paymentIntent)}&limit=5`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Stripe error ${res.status} looking up a refunded payment`);
  return (((await res.json()) as { data?: { id: string }[] }).data ?? []).map((x) => x.id);
}

/**
 * A refund the owner issued in the Stripe Dashboard (the site never starts refunds).
 * Only a FULL refund removes access, and only the access this one purchase gave:
 * - a Course Book purchase: marked refunded; its "Bought online" access is removed, but not an admin grant
 *   or a package that includes the book;
 * - a package: that enrollment is marked refunded (other enrollments are untouched).
 * Each charge is handled once, so repeated notifications are harmless and an admin can restore access afterwards.
 * Returns what happened, for the log.
 */
export async function handleRefund(env: Env, ch: RefundedCharge): Promise<string> {
  const db = env.DB;
  const full = ch.refunded === true && ch.amount_refunded >= ch.amount && ch.amount > 0;
  if (!full) return 'partial refund: access kept';
  if (!ch.payment_intent) return 'no payment to match';
  if (await db.prepare('SELECT 1 FROM stripe_refunds WHERE charge_id = ?').bind(ch.id).first()) return 'already handled';

  let book = await db.prepare("SELECT id, user_id, status FROM book_purchases WHERE payment_intent = ?").bind(ch.payment_intent).first<{ id: number; user_id: number; status: string }>();
  let enr = await db.prepare('SELECT id, status FROM enrollments WHERE payment_intent = ?').bind(ch.payment_intent).first<{ id: number; status: string }>();
  if (!book && !enr) {
    for (const sid of await sessionsForPayment(env, ch.payment_intent)) {
      book ??= await db.prepare('SELECT id, user_id, status FROM book_purchases WHERE stripe_session_id = ?').bind(sid).first();
      enr ??= await db.prepare('SELECT id, status FROM enrollments WHERE stripe_session_id = ?').bind(sid).first();
    }
  }

  const steps: D1PreparedStatement[] = [];
  let result = 'no matching purchase';
  if (book) {
    result = `course book purchase ${book.id} refunded`;
    steps.push(
      db.prepare("UPDATE book_purchases SET status = 'refunded', refunded_at = datetime('now') WHERE id = ? AND status = 'paid'").bind(book.id),
      // Only the access this purchase created; an admin grant has its own note and stays.
      db.prepare('DELETE FROM book_access WHERE user_id = ? AND note = ?').bind(book.user_id, 'Bought online · purchase ' + book.id),
      // If the student has another paid purchase still standing, its access stays.
      db
        .prepare(
          `INSERT INTO book_access (user_id, note) SELECT user_id, 'Bought online · purchase ' || id FROM book_purchases
           WHERE user_id = ? AND status = 'paid' ORDER BY id LIMIT 1 ON CONFLICT (user_id) DO NOTHING`,
        )
        .bind(book.user_id),
    );
  }
  if (enr) {
    result = `enrollment ${enr.id} refunded`;
    steps.push(db.prepare("UPDATE enrollments SET status = 'refunded', refunded_at = datetime('now') WHERE id = ? AND status = 'active'").bind(enr.id));
  }
  // Recorded in the same transaction, so a retry after a failure is handled, and a second notification is not.
  steps.push(db.prepare('INSERT OR IGNORE INTO stripe_refunds (charge_id, payment_intent, result) VALUES (?, ?, ?)').bind(ch.id, ch.payment_intent, result));
  await db.batch(steps);
  await audit(db, { action: 'refund.revoked', targetUserId: book?.user_id ?? null, detail: { result, charge: ch.id, cents: ch.amount_refunded } });
  return result;
}
