import { sha256Hex, toB64 } from './auth';

/** Admin-made password reset links: one use, valid for 1 hour. */
export const RESET_LINK_SECONDS = 60 * 60;
const now = () => Math.floor(Date.now() / 1000);

/** Make a new link for a user. Any earlier unused links for them stop working. Returns the secret for the URL. */
export async function createResetToken(db: D1Database, userId: number, createdBy: number | null): Promise<string> {
  const raw = toB64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (m) => ({ '+': '-', '/': '_', '=': '' })[m]!);
  await db.batch([
    db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(now(), userId),
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at, created_by) VALUES (?, ?, ?, ?)').bind(await sha256Hex(raw), userId, now() + RESET_LINK_SECONDS, createdBy),
  ]);
  return raw;
}

/** The user a still-valid link belongs to, or null. Does not use up the link. */
export async function resetTokenUser(db: D1Database, raw: string) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(raw)) return null;
  return db
    .prepare('SELECT u.id, u.email, u.name FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?')
    .bind(await sha256Hex(raw), now())
    .first<{ id: number; email: string; name: string }>();
}

/** Use up a link. True only for the first caller while it is still valid, so a link works exactly once. */
export async function consumeResetToken(db: D1Database, raw: string, userId: number) {
  const r = await db
    .prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?')
    .bind(now(), await sha256Hex(raw), userId, now())
    .run();
  return r.meta.changes === 1;
}

export async function pruneResetTokens(db: D1Database) {
  await db.prepare('DELETE FROM password_resets WHERE expires_at < ?').bind(now() - 7 * 86400).run();
}
