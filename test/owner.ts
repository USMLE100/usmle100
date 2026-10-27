/** Turn an account into the owner, already re-confirmed (as if they had just entered their password at /admin/confirm). */
export async function makeOwner(db: D1Database, email: string) {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("UPDATE users SET role = 'admin', is_owner = 1 WHERE email = ?").bind(email),
    db.prepare('UPDATE sessions SET reauth_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').bind(now, email),
  ]);
}
