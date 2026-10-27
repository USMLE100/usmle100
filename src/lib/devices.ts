import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from './types';
import { sha256Hex, toB64 } from './auth';
import { audit } from './audit';

/**
 * Registered devices (R001, R017, R085–R088). A device is one browser, recognised by a long-lived random cookie
 * (only its hash is stored). Each student may use 2 registered devices. A third device is not signed in: it waits
 * for an administrator to approve it as a replacement. Repeated replacement requests within 30 days are flagged.
 * Staff are not limited. Clearing cookies makes a browser look new, which is why replacements need a person.
 */
export const MAX_DEVICES = 2;
const COOKIE = 'u100_device';

export function deviceToken(c: Context<AppEnv>) {
  let raw = getCookie(c, COOKIE);
  if (!raw || !/^[A-Za-z0-9_-]{40,60}$/.test(raw)) {
    raw = toB64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (m) => ({ '+': '-', '/': '_', '=': '' })[m]!);
  }
  setCookie(c, COOKIE, raw, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax', path: '/', maxAge: 400 * 86400 });
  return raw;
}

/** A readable name for a device, from its browser description. */
export function deviceLabel(ua: string) {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${br} on ${os}`;
}

export type DeviceCheck = { ok: true; hash: string } | { ok: false; reason: 'pending' | 'declined' | 'new'; hash: string };

/**
 * Called after a correct password, before the sign-in is created. Registers the first two devices; a third
 * becomes a pending replacement request for an administrator.
 */
export async function checkDevice(c: Context<AppEnv>, userId: number): Promise<DeviceCheck> {
  const db = c.env.DB;
  const hash = await sha256Hex(deviceToken(c));
  const ua = c.req.header('user-agent') ?? '';
  const country = c.req.header('cf-ipcountry') ?? null;
  const row = await db.prepare('SELECT id, status FROM devices WHERE user_id = ? AND device_hash = ?').bind(userId, hash).first<{ id: number; status: string }>();
  if (row?.status === 'active') {
    await db.prepare("UPDATE devices SET last_seen = datetime('now'), last_country = ? WHERE id = ?").bind(country, row.id).run();
    return { ok: true, hash };
  }
  if (row?.status === 'pending') return { ok: false, reason: 'pending', hash };
  if (row?.status === 'declined') return { ok: false, reason: 'declined', hash };
  // New (or previously removed) device: take a free slot if there is one. The count and the insert are one statement,
  // so two simultaneous sign-ins cannot both take the last slot.
  const r = await db
    .prepare(
      `INSERT INTO devices (user_id, device_hash, label, status, last_country)
       SELECT ?1, ?2, ?3, 'active', ?4 WHERE (SELECT COUNT(*) FROM devices WHERE user_id = ?1 AND status = 'active') < ?5
       ON CONFLICT (user_id, device_hash) DO UPDATE SET status = 'active', last_seen = datetime('now'), label = excluded.label, last_country = excluded.last_country`,
    )
    .bind(userId, hash, deviceLabel(ua), country, MAX_DEVICES)
    .run();
  if ((r.meta.changes ?? 0) > 0) {
    await audit(db, { actorId: userId, action: 'device.registered', targetUserId: userId, detail: { device: deviceLabel(ua), country }, ip: c.req.header('cf-connecting-ip') ?? null });
    return { ok: true, hash };
  }
  // Both slots taken: ask for a replacement (R017).
  await db
    .prepare(
      `INSERT INTO devices (user_id, device_hash, label, status, last_country) VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT (user_id, device_hash) DO UPDATE SET status = 'pending', last_seen = datetime('now')`,
    )
    .bind(userId, hash, deviceLabel(ua), country)
    .run();
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND first_seen > datetime('now', '-30 days') AND (status <> 'active' OR replaces_id IS NOT NULL)")
    .bind(userId)
    .first<{ n: number }>();
  const repeated = (recent?.n ?? 0) >= 2;
  await db.batch([
    db.prepare('INSERT INTO staff_alerts (level, kind, user_id, message) VALUES (?, ?, ?, ?)').bind(
      repeated ? 'warning' : 'info',
      'device.request',
      userId,
      repeated ? 'Repeated device replacement request within 30 days: review the device history before approving.' : `New device waiting for approval: ${deviceLabel(ua)}${country ? ` (${country})` : ''}.`,
    ),
    ...(repeated ? [db.prepare("INSERT INTO security_flags (user_id, kind, detail) VALUES (?, 'device_replacement_repeat', ?)").bind(userId, deviceLabel(ua))] : []),
  ]);
  await audit(db, { actorId: userId, action: 'device.requested', targetUserId: userId, detail: { device: deviceLabel(ua), country, repeated }, ip: c.req.header('cf-connecting-ip') ?? null });
  return { ok: false, reason: 'new', hash };
}

/**
 * Suspected sharing (R003/R004): the protected video is already playing on another registered device from a
 * different network address. The first time warns the student (red notice) and alerts the owner; the next time
 * locks the account until the owner reinstates it after speaking with the student. Same network = same person
 * switching devices, which is only told to close the other tab.
 */
export async function reportSharing(db: D1Database, userId: number, detail: Record<string, unknown>) {
  const prior = await db.prepare("SELECT COUNT(*) AS n FROM security_flags WHERE user_id = ? AND kind = 'concurrent_stream' AND (outcome IS NULL OR outcome <> 'dismissed')").bind(userId).first<{ n: number }>();
  const second = (prior?.n ?? 0) >= 1;
  const reason = second
    ? 'Your lectures were played on two devices in different places at the same time again. Your account is locked until USMLE100 reviews it with you by phone.'
    : 'Your lectures were played on two devices in different places at the same time. Your account is for you alone. If this happens again, your account will be locked until USMLE100 reviews it with you.';
  await db.batch([
    db.prepare("INSERT INTO security_flags (user_id, kind, detail) VALUES (?, 'concurrent_stream', ?)").bind(userId, JSON.stringify(detail)),
    db.prepare("UPDATE users SET status = ?, status_reason = ?, status_at = datetime('now'), warnings = warnings + 1 WHERE id = ? AND is_owner = 0 AND role = 'student' AND status <> 'suspended'").bind(second ? 'suspended' : 'warned', reason, userId),
    ...(second ? [db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId), db.prepare('DELETE FROM play_tabs WHERE user_id = ?').bind(userId)] : []),
    db.prepare('INSERT INTO staff_alerts (level, kind, user_id, message) VALUES (?, ?, ?, ?)').bind(
      second ? 'critical' : 'warning',
      'sharing',
      userId,
      second ? 'Repeated suspected account sharing: account locked until the owner reinstates it.' : 'Suspected account sharing: the student was warned.',
    ),
    db.prepare('INSERT INTO notices (user_id, kind, title, body) VALUES (?, ?, ?, ?)').bind(userId, 'security', second ? 'Account locked' : 'Warning: account sharing', reason),
  ]);
  await audit(db, { action: second ? 'sharing.locked' : 'sharing.warned', targetUserId: userId, detail });
  return second;
}
