/** Turn an account into the owner, already re-confirmed (as if they had just entered their password at /admin/confirm). */
export async function makeOwner(db: D1Database, email: string) {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("UPDATE users SET role = 'admin', is_owner = 1 WHERE email = ?").bind(email),
    db.prepare('UPDATE sessions SET reauth_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').bind(now, email),
  ]);
}

/** The registration details every new account now gives (name, phone, exam, graduation year). */
export const SIGNUP = { first_name: 'Test', last_name: 'Student', phone: '+15555550100', exam: 'USMLE Step 1', grad_year: '2024' };

/** All cookies a response sets (the sign-in and the device cookie), as a Cookie header for later requests. */
export const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c) => !/=$/.test(c))
    .join('; ');
