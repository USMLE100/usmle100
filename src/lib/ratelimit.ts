/**
 * Sign-in protection against password guessing, kept in D1 (no extra service).
 * - Per email: 5 wrong passwords within 15 minutes locks that account until an administrator unlocks it (R029).
 * - Per network address: 20 wrong passwords within 15 minutes (any emails) locks that address for 15 minutes.
 * Unknown emails are counted the same way, so the response never reveals whether an account exists.
 */
export const EMAIL_MAX_FAILURES = 5;
export const IP_MAX_FAILURES = 20;
export const WINDOW_SECONDS = 15 * 60;
export const LOCK_SECONDS = 15 * 60;

const now = () => Math.floor(Date.now() / 1000);
export const emailKey = (email: string) => `email:${email}`;
export const ipKey = (ip: string) => `ip:${ip}`;

/** Seconds until sign-in is allowed again for any of these keys, or 0 if allowed now. */
export async function lockedFor(db: D1Database, keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  const t = now();
  const row = await db
    .prepare(`SELECT MAX(locked_until) AS until FROM login_attempts WHERE key IN (${keys.map(() => '?').join(',')}) AND locked_until > ?`)
    .bind(...keys, t)
    .first<{ until: number | null }>();
  return row?.until ? row.until - t : 0;
}

/** Count one failed sign-in against a key (one atomic statement). */
function failure(db: D1Database, key: string, max: number) {
  const t = now();
  const cutoff = t - WINDOW_SECONDS;
  return db
    .prepare(
      `INSERT INTO login_attempts (key, failures, window_start, locked_until) VALUES (?1, 1, ?2, CASE WHEN 1 >= ?4 THEN ?2 + ?5 END)
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN window_start < ?3 THEN 1 ELSE failures + 1 END,
         locked_until = CASE WHEN (CASE WHEN window_start < ?3 THEN 1 ELSE failures + 1 END) >= ?4 THEN ?2 + ?5 ELSE locked_until END,
         window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END`,
    )
    .bind(key, t, cutoff, max, LOCK_SECONDS);
}

/** Count a failed sign-in. Returns true when this failure locked the account. */
export async function recordFailure(db: D1Database, email: string, ip: string | null) {
  await db.batch([failure(db, emailKey(email), EMAIL_MAX_FAILURES), ...(ip ? [failure(db, ipKey(ip), IP_MAX_FAILURES)] : [])]);
  const row = await db.prepare('SELECT failures, locked_until FROM login_attempts WHERE key = ?').bind(emailKey(email)).first<{ failures: number; locked_until: number | null }>();
  if (row && row.failures >= EMAIL_MAX_FAILURES) {
    const r = await db
      .prepare('INSERT INTO account_locks (email) VALUES (?) ON CONFLICT (email) DO UPDATE SET locked_at = datetime(\'now\'), unlocked_at = NULL, unlocked_by = NULL WHERE unlocked_at IS NOT NULL')
      .bind(email)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }
  return false;
}

/** True while an account is locked awaiting an administrator. */
export async function accountLocked(db: D1Database, email: string) {
  return !!(await db.prepare('SELECT 1 FROM account_locks WHERE email = ? AND unlocked_at IS NULL').bind(email).first());
}

/** An administrator unlocks an account (also clears its failure counter). */
export async function unlockAccount(db: D1Database, email: string, by: number | null) {
  await db.batch([
    db.prepare("UPDATE account_locks SET unlocked_at = datetime('now'), unlocked_by = ? WHERE email = ? AND unlocked_at IS NULL").bind(by, email),
    db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(emailKey(email)),
  ]);
}

/** A correct password (or a password reset) clears that email's counter. */
export async function clearFailures(db: D1Database, email: string) {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(emailKey(email)).run();
}

/** Housekeeping for the scheduled job: drop counters that no longer matter. */
export async function pruneLoginAttempts(db: D1Database) {
  const t = now();
  await db.prepare('DELETE FROM login_attempts WHERE window_start < ? AND (locked_until IS NULL OR locked_until < ?)').bind(t - WINDOW_SECONDS, t).run();
}

/**
 * A general counter for other actions (sign-ups, question-bank paging, Course Book opening).
 * Counts one hit and returns false once more than `max` hits fall within `windowSeconds`.
 */
export async function rateHit(db: D1Database, key: string, max: number, windowSeconds: number) {
  const t = now();
  const row = await db
    .prepare(
      `INSERT INTO login_attempts (key, failures, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN window_start < ?3 THEN 1 ELSE failures + 1 END,
         window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
       RETURNING failures`,
    )
    .bind(key, t, t - windowSeconds)
    .first<{ failures: number }>();
  return (row?.failures ?? 0) <= max;
}
