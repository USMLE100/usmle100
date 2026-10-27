import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { IDLE_SECONDS, MAX_SESSION_SECONDS, destroySession, requireUser, sha256Hex } from '../lib/auth';
import { PublicLayout, Flash, Eyebrow } from '../views/layout';
import { audit } from '../lib/audit';
import { getSettings } from '../lib/settings';

/** Session timing, the agreement, and the account notices (warning, suspension, lockdown). */
export const account = new Hono<AppEnv>();

const epoch = () => Math.floor(Date.now() / 1000);

/** How long this sign-in has left. Checking does not count as activity. */
account.get('/session/status', (c) => {
  const s = c.get('session');
  c.header('Cache-Control', 'no-store');
  if (!c.get('user') || !s) return c.json({ ended: c.get('sessionEnded') ?? 'out' }, 401);
  const t = epoch();
  return c.json({ idleLeft: Math.max(0, IDLE_SECONDS - (t - s.lastSeenAt)), absoluteLeft: Math.max(0, MAX_SESSION_SECONDS - (t - s.createdAt)) });
});

/** "Stay logged in" and activity on a page without requests: extend the inactivity timer. */
account.post('/session/ping', async (c) => {
  const s = c.get('session');
  c.header('Cache-Control', 'no-store');
  if (!c.get('user') || !s) return c.json({ ended: c.get('sessionEnded') ?? 'out' }, 401);
  const t = epoch();
  await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').bind(t, s.tokenHash).run();
  return c.json({ idleLeft: IDLE_SECONDS, absoluteLeft: Math.max(0, MAX_SESSION_SECONDS - (t - s.createdAt)) });
});

const paras = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => <p>{p}</p>);

const Notice = (p: { title: string; children: any; tone?: 'error' }) => (
  <PublicLayout title={p.title} user={null} plain>
    <main class="wrap page" style="max-width:640px;padding-top:56px;padding-bottom:72px">
      <Eyebrow>USMLE100</Eyebrow>
      <h1 style={p.tone === 'error' ? 'color:#8c2f20' : undefined}>{p.title}</h1>
      {p.children}
    </main>
  </PublicLayout>
);

const contactLine = (contact: string) =>
  contact ? <p>Contact us at <a href={`mailto:${contact}`}>{contact}</a>.</p> : <p>Please contact USMLE100.</p>;

account.get('/account/suspended', requireUser, async (c) => {
  const contact = (await getSettings(c.env.DB)).contact_email;
  return c.html(
    <Notice title="Your account is suspended" tone="error">
      <Flash kind="error">Access to USMLE100 has been suspended for this account while we review its activity.</Flash>
      {c.get('user')!.status_reason && <p><strong>Reason:</strong> {c.get('user')!.status_reason}</p>}
      {contactLine(contact)}
      <form method="post" action="/sign-out"><button class="btn btn-outline" type="submit">Sign out</button></form>
    </Notice>,
    403,
  );
});

account.get('/account/unavailable', async (c) => {
  const contact = (await getSettings(c.env.DB)).contact_email;
  return c.html(
    <Notice title="The portal is temporarily unavailable">
      <p>USMLE100 has paused access to student areas for maintenance and security. Your account, purchases and progress are safe. Please try again later.</p>
      {contactLine(contact)}
      <a class="btn btn-outline" href="/">Home</a>
    </Notice>,
    503,
  );
});

account.get('/account/notice', requireUser, async (c) => {
  const u = c.get('user')!;
  if (u.status !== 'warned') return c.redirect('/dashboard');
  const contact = (await getSettings(c.env.DB)).contact_email;
  return c.html(
    <Notice title="Important notice about your account" tone="error">
      <Flash kind="error">We detected activity on your account that breaks the USMLE100 agreement.</Flash>
      {u.status_reason && <p><strong>What we saw:</strong> {u.status_reason}</p>}
      <p>Your account is for you alone. Sharing it, recording or copying lectures or the Course Book, or using it on unregistered devices is not allowed. If this happens again, your account will be locked until USMLE100 reviews it with you.</p>
      {contactLine(contact)}
      <form method="post" action="/account/notice">
        <button class="btn btn-primary" type="submit">I understand</button>
      </form>
    </Notice>,
  );
});

account.post('/account/notice', requireUser, async (c) => {
  const u = c.get('user')!;
  if (u.status === 'warned') {
    await c.env.DB.prepare("UPDATE users SET status = 'active', status_at = datetime('now') WHERE id = ? AND status = 'warned'").bind(u.id).run();
    await audit(c.env.DB, { actorId: u.id, action: 'warning.acknowledged', targetUserId: u.id, ip: c.req.header('cf-connecting-ip') ?? null });
  }
  return c.redirect('/dashboard');
});

// ---------- Agreement (R012/R014) ----------

const latestAgreement = (db: D1Database) =>
  db.prepare('SELECT id, title, body, body_hash, published_at FROM agreements ORDER BY id DESC LIMIT 1').first<{ id: number; title: string; body: string; body_hash: string; published_at: string }>();

/** Whole years between a YYYY-MM-DD birth date and today (UTC). */
export function ageOn(birth: string, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth);
  if (!m) return -1;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return -1;
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < mo || (today.getUTCMonth() + 1 === mo && today.getUTCDate() < d)) age--;
  return age;
}

const safeNext = (n: unknown) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard');

const AgreementPage = (p: { a: { id: number; title: string; body: string; published_at: string }; next: string; error?: string; name?: string; birth?: string; signed?: boolean }) => (
  <PublicLayout title="Student agreement" user={null} plain>
    <main class="wrap page" style="max-width:720px;padding-top:40px;padding-bottom:72px">
      <Eyebrow>USMLE100 · Version {p.a.id} · {String(p.a.published_at).slice(0, 10)}</Eyebrow>
      <h1>{p.a.title}</h1>
      {p.signed ? <Flash>You have signed this version.</Flash> : <p class="muted">Please read and sign this agreement to continue to your portal.</p>}
      <section class="card agreement-text" style="max-height:52vh;overflow:auto">{paras(p.a.body)}</section>
      {!p.signed && (
        <form method="post" action="/agreement" class="stack" style="gap:14px;margin-top:18px">
          {p.error && <Flash kind="error">{p.error}</Flash>}
          <input type="hidden" name="next" value={p.next} />
          <input type="hidden" name="version" value={String(p.a.id)} />
          <label class="field">Full legal name (typed signature)<input type="text" name="legal_name" required minlength={3} maxlength={120} autocomplete="name" value={p.name ?? ''} /></label>
          <label class="field">Date of birth<input type="date" name="birth_date" required value={p.birth ?? ''} /></label>
          <label class="check"><input type="checkbox" name="accept" value="1" required /> I have read this agreement, I am 18 or older, and I agree to it.</label>
          <button class="btn btn-primary btn-block" type="submit">Sign and continue</button>
        </form>
      )}
      {p.signed && <a class="btn btn-primary" href={p.next}>Continue</a>}
      <form method="post" action="/sign-out" style="margin-top:14px"><button class="btn btn-ghost" type="submit">Sign out</button></form>
    </main>
  </PublicLayout>
);

account.get('/agreement', requireUser, async (c) => {
  const a = await latestAgreement(c.env.DB);
  if (!a) return c.redirect('/dashboard');
  const u = c.get('user')!;
  const signed = !!(await c.env.DB.prepare('SELECT 1 FROM agreement_signatures WHERE user_id = ? AND agreement_id = ?').bind(u.id, a.id).first());
  return c.html(<AgreementPage a={a} next={safeNext(c.req.query('next'))} signed={signed} birth={u.birth_date ?? undefined} />);
});

account.post('/agreement', requireUser, async (c) => {
  const u = c.get('user')!;
  const f = await c.req.parseBody();
  const a = await latestAgreement(c.env.DB);
  if (!a) return c.redirect('/dashboard');
  const next = safeNext(f.next);
  const name = String(f.legal_name ?? '').trim().replace(/\s+/g, ' ');
  const birth = String(f.birth_date ?? '').trim();
  const again = (error: string) => c.html(<AgreementPage a={a} next={next} error={error} name={name} birth={birth} />, 400);
  if (Number(f.version) !== a.id) return again('The agreement was updated while you were reading. Please read this version and sign again.');
  if (name.length < 3 || name.length > 120) return again('Please type your full legal name.');
  const age = ageOn(birth);
  if (age < 0 || age > 120) return again('Please enter a valid date of birth.');
  if (age < 18) return again('USMLE100 is only for people aged 18 or older.');
  if (f.accept !== '1') return again('Please tick the box to confirm you agree.');
  // The stored hash proves exactly which text was signed, even if the version is edited later.
  const bodyHash = a.body_hash || (await sha256Hex(a.body));
  const ip = c.req.header('cf-connecting-ip') ?? null;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO agreement_signatures (user_id, agreement_id, legal_name, email, birth_date, body_hash, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(u.id, a.id, name, u.email, birth, bodyHash, ip, (c.req.header('user-agent') ?? '').slice(0, 300)),
    c.env.DB.prepare('UPDATE users SET birth_date = ? WHERE id = ?').bind(birth, u.id),
  ]);
  await audit(c.env.DB, { actorId: u.id, action: 'agreement.signed', targetUserId: u.id, detail: { version: a.id, bodyHash }, ip });
  return c.redirect(next);
});

/** Used by the sign-out button in the inactivity timer as well. */
account.post('/session/end', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});
