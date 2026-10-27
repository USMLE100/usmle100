import type { Env } from './types';
import { sha256Hex } from './auth';
import { rateHit } from './ratelimit';

/**
 * Email (Resend) and SMS (Twilio). Both are optional: until their keys are added as Cloudflare Secrets nothing is
 * sent, every message still appears in the student's portal (notification history), and features that need codes
 * fall back to the admin-assisted way. No paid service is used until the owner sets it up.
 * Messages never contain passwords, codes for other purposes, or identity documents.
 */
export const emailReady = (env: Env) => !!(env.RESEND_API_KEY && env.EMAIL_FROM);
export const smsReady = (env: Env) => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);

export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!emailReady(env)) return { ok: false, error: 'email not set up' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Resend ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
}

export async function sendSms(env: Env, to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  if (!smsReady(env)) return { ok: false, error: 'SMS not set up' };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: env.TWILIO_FROM!, Body: body }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Twilio ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
}

/**
 * A message to a student: always kept in the portal; also emailed (and texted when `sms`) when those are set up.
 * Failed deliveries are retried by the scheduled job and escalated (see retryNotices).
 */
export async function notify(env: Env, userId: number, n: { kind: string; title: string; body: string; email?: boolean; sms?: boolean }) {
  const db = env.DB;
  const u = await db.prepare('SELECT email, phone FROM users WHERE id = ?').bind(userId).first<{ email: string; phone: string | null }>();
  const wantEmail = n.email !== false && emailReady(env) && !!u?.email && !u.email.endsWith('.invalid');
  const wantSms = !!n.sms && smsReady(env) && !!u?.phone;
  const r = await db
    .prepare('INSERT INTO notices (user_id, kind, title, body, email_status, sms_status) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(userId, n.kind, n.title, n.body, wantEmail ? 'pending' : 'skipped', wantSms ? 'pending' : 'skipped')
    .run();
  const id = Number(r.meta.last_row_id);
  if (wantEmail) await deliver(env, id, 'email');
  if (wantSms) await deliver(env, id, 'sms');
  return id;
}

async function deliver(env: Env, noticeId: number, channel: 'email' | 'sms') {
  const db = env.DB;
  const n = await db.prepare('SELECT n.title, n.body, u.email, u.phone FROM notices n JOIN users u ON u.id = n.user_id WHERE n.id = ?').bind(noticeId).first<any>();
  if (!n) return;
  const res =
    channel === 'email'
      ? await sendEmail(env, n.email, `USMLE100: ${n.title}`, `${n.body}\n\nYou can also see this message in your portal under My account.\n\nUSMLE100`)
      : await sendSms(env, n.phone, `USMLE100: ${n.title}. ${n.body}`.slice(0, 320));
  const col = channel === 'email' ? 'email' : 'sms';
  await db.prepare(`UPDATE notices SET ${col}_status = ?, ${col}_attempts = ${col}_attempts + 1 WHERE id = ?`).bind(res.ok ? 'sent' : 'failed', noticeId).run();
}

/**
 * Scheduled: retry failed deliveries (up to 3 tries each), then try the other verified channel, and escalate:
 * an admin alert 1 hour after a security message could not be delivered, and an owner alert after 24 hours
 * (owner decisions on failed-notification escalation). The message stays in the portal either way.
 */
export async function retryNotices(env: Env) {
  const db = env.DB;
  const failed = (await db.prepare("SELECT id, user_id, kind, email_status, sms_status, email_attempts, sms_attempts, created_at, escalated FROM notices WHERE (email_status = 'failed' OR sms_status = 'failed') AND created_at > datetime('now', '-3 days') LIMIT 50").all<any>()).results;
  for (const n of failed) {
    if (n.email_status === 'failed' && n.email_attempts < 3) await deliver(env, n.id, 'email');
    if (n.sms_status === 'failed' && n.sms_attempts < 3) await deliver(env, n.id, 'sms');
    const after = (await db.prepare('SELECT email_status, sms_status FROM notices WHERE id = ?').bind(n.id).first<any>())!;
    const reached = after.email_status === 'sent' || after.sms_status === 'sent';
    if (reached) continue;
    // Try the other channel once if it wasn't used.
    if (after.sms_status === 'skipped' && smsReady(env)) {
      await db.prepare("UPDATE notices SET sms_status = 'pending' WHERE id = ?").bind(n.id).run();
      await deliver(env, n.id, 'sms');
    }
    const ageH = (Date.now() - Date.parse(n.created_at + 'Z')) / 3600_000;
    if (ageH >= 1 && n.escalated < 1) {
      await db.batch([
        db.prepare("INSERT INTO staff_alerts (level, kind, user_id, message) VALUES ('warning', 'delivery', ?, ?)").bind(n.user_id, `A ${n.kind} message couldn’t be delivered by email or text for an hour. Please contact the student another way.`),
        db.prepare('UPDATE notices SET escalated = 1 WHERE id = ?').bind(n.id),
      ]);
    } else if (ageH >= 24 && n.escalated < 2) {
      await db.batch([
        db.prepare("INSERT INTO staff_alerts (level, kind, user_id, message) VALUES ('critical', 'delivery', ?, ?)").bind(n.user_id, `A ${n.kind} message still hasn’t reached the student after 24 hours.`),
        db.prepare('UPDATE notices SET escalated = 2 WHERE id = ?').bind(n.id),
      ]);
    }
  }
}

/** Scheduled: email new warning/critical staff alerts to the owner (once each), when email is set up. */
export async function emailStaffAlerts(env: Env) {
  if (!emailReady(env) || !env.OWNER_ALERT_EMAIL) return;
  const db = env.DB;
  const rows = (await db.prepare("SELECT id, level, message, created_at FROM staff_alerts WHERE emailed_at IS NULL AND level IN ('warning', 'critical') AND resolved_at IS NULL ORDER BY id LIMIT 20").all<any>()).results;
  for (const a of rows) {
    const res = await sendEmail(env, env.OWNER_ALERT_EMAIL, `USMLE100 ${a.level === 'critical' ? 'URGENT' : 'alert'}: ${a.message.slice(0, 80)}`, `${a.message}\n\nSee Admin → Requests & alerts.`);
    if (res.ok) await db.prepare("UPDATE staff_alerts SET emailed_at = datetime('now') WHERE id = ?").bind(a.id).run();
  }
}

// ---------- One-time codes ----------

export const OTP_TTL = 600;
export const OTP_TRIES = 5;

/** Send a 6-digit code. At most 5 codes per hour per person and channel. */
export async function sendCode(env: Env, userId: number, channel: 'email' | 'sms', purpose: string, target: string) {
  const db = env.DB;
  if (!(await rateHit(db, `otp:${userId}:${channel}`, 5, 3600))) return { ok: false, error: 'Too many codes requested. Please wait an hour.' };
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const t = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare('UPDATE otp_codes SET used_at = ? WHERE user_id = ? AND purpose = ? AND channel = ? AND used_at IS NULL').bind(t, userId, purpose, channel),
    db.prepare('INSERT INTO otp_codes (user_id, channel, purpose, target, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(userId, channel, purpose, target, await sha256Hex(`${userId}:${purpose}:${code}`), t + OTP_TTL, t),
  ]);
  const text = `Your USMLE100 code is ${code}. It expires in 10 minutes. Never share it; USMLE100 will never ask you for it.`;
  const res = channel === 'email' ? await sendEmail(env, target, 'Your USMLE100 code', text) : await sendSms(env, target, text);
  return res.ok ? { ok: true } : { ok: false, error: 'We couldn’t send the code. Please try again later.' };
}

/** Check a code: right code, not expired, not used, fewer than 5 tries. Returns 'ok', 'wrong', or 'locked'. */
export async function checkCode(db: D1Database, userId: number, channel: 'email' | 'sms', purpose: string, code: string): Promise<'ok' | 'wrong' | 'locked'> {
  const t = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare('SELECT id, code_hash, attempts FROM otp_codes WHERE user_id = ? AND channel = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1')
    .bind(userId, channel, purpose, t)
    .first<{ id: number; code_hash: string; attempts: number }>();
  if (!row) return 'wrong';
  if (row.attempts >= OTP_TRIES) return 'locked';
  if (/^\d{6}$/.test(code.trim()) && (await sha256Hex(`${userId}:${purpose}:${code.trim()}`)) === row.code_hash) {
    await db.prepare('UPDATE otp_codes SET used_at = ? WHERE id = ?').bind(t, row.id).run();
    return 'ok';
  }
  await db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
  return row.attempts + 1 >= OTP_TRIES ? 'locked' : 'wrong';
}

// ---------- Sender (marketing list) ----------

/**
 * Scheduled: add students who opted in and whose email is verified to the Sender list, and remove those who
 * withdrew. Never imports anyone else and sends no email itself. Off until SENDER_API_KEY is set.
 */
export async function syncMarketing(env: Env) {
  if (!env.SENDER_API_KEY) return;
  const db = env.DB;
  const headers = { Authorization: `Bearer ${env.SENDER_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const add = (await db.prepare("SELECT id, email, first_name, last_name FROM users WHERE marketing_opt_in = 1 AND email_verified_at IS NOT NULL AND COALESCE(marketing_sync_state, '') <> 'subscribed' LIMIT 25").all<any>()).results;
  for (const u of add) {
    const res = await fetch('https://api.sender.net/v2/subscribers', { method: 'POST', headers, body: JSON.stringify({ email: u.email, firstname: u.first_name, lastname: u.last_name }) }).catch(() => null);
    if (res?.ok) await db.prepare("UPDATE users SET marketing_sync_state = 'subscribed', marketing_synced_at = datetime('now') WHERE id = ?").bind(u.id).run();
  }
  const remove = (await db.prepare("SELECT id, email FROM users WHERE marketing_opt_in = 0 AND marketing_sync_state = 'subscribed' LIMIT 25").all<any>()).results;
  for (const u of remove) {
    const res = await fetch('https://api.sender.net/v2/subscribers', { method: 'DELETE', headers, body: JSON.stringify({ subscribers: [u.email] }) }).catch(() => null);
    if (res?.ok) await db.prepare("UPDATE users SET marketing_sync_state = 'removed', marketing_synced_at = datetime('now') WHERE id = ?").bind(u.id).run();
  }
}
