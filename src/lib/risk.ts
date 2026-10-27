/**
 * Risk-based sign-in checks (owner decisions R091–R093, p133): a sign-in needs an extra email (and phone, when
 * verified and SMS is set up) code before protected content opens when it comes after 30 days without signing in,
 * from a country the account hasn't used, or from a newly registered device of an account that already had one.
 * Applies only once email sending is set up; until then these sign-ins are recorded and the student is told.
 */
export type Risk = 'inactive' | 'new-country' | 'new-device';

export async function signInRisk(db: D1Database, userId: number, country: string | null, freshDevice: boolean): Promise<Risk | null> {
  const prior = (await db.prepare("SELECT at, detail FROM audit_log WHERE target_user_id = ? AND action = 'signin.ok' ORDER BY id DESC LIMIT 20").bind(userId).all<{ at: string; detail: string | null }>()).results;
  const created = (await db.prepare('SELECT created_at FROM users WHERE id = ?').bind(userId).first<{ created_at: string }>())?.created_at;
  const day = 86400_000;
  const last = prior[0] ? Date.parse(prior[0].at) : created ? Date.parse(created + 'Z') : Date.now();
  if (Date.now() - last > 30 * day) return 'inactive';
  const countries = new Set(
    prior
      .map((p) => {
        try {
          return JSON.parse(p.detail ?? '{}').country as string | null;
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  );
  if (country && countries.size > 0 && !countries.has(country)) return 'new-country';
  if (freshDevice && prior.length > 0) return 'new-device';
  return null;
}

export const RISK_TEXT: Record<Risk, string> = {
  inactive: 'It has been more than 30 days since you last signed in.',
  'new-country': 'This sign-in is from a country your account hasn’t used before.',
  'new-device': 'This sign-in is from a new device.',
};
