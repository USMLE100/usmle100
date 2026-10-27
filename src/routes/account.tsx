import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { isStaff } from '../lib/types';
import { IDLE_SECONDS, MAX_SESSION_SECONDS, destroySession, hashPassword, requireUser, sha256Hex, verifyPassword } from '../lib/auth';
import { PublicLayout, PortalLayout, PageHead, Flash, Eyebrow } from '../views/layout';
import { EXAMS, MARKETING_TEXT, gradYears, normalizePhone, validName } from '../lib/profile';
import { passwordProblem, MIN_PASSWORD } from '../lib/passwords';
import { deviceLabel } from '../lib/devices';
import { checkCode, emailReady, notify, sendCode, smsReady } from '../lib/messaging';
import { RISK_TEXT, type Risk } from '../lib/risk';
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

// ---------- My account (profile, consent, password, sign-ins, devices, notices, privacy requests) ----------

const ipOf = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? null;
const accountBack = (msg: string, error = false, anchor = '') => `/account?${error ? 'error' : 'ok'}=${encodeURIComponent(msg)}${anchor}`;
const when = (t: number | string) => (typeof t === 'number' ? new Date(t * 1000).toISOString() : String(t)).slice(0, 16).replace('T', ' ') + ' UTC';

async function checkPassword(db: D1Database, userId: number, password: string) {
  const row = await db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').bind(userId).first<{ password_hash: string; password_salt: string }>();
  return !!row && (await verifyPassword(password, row.password_hash, row.password_salt));
}

account.get('/account', requireUser, async (c) => {
  const u = c.get('user')!;
  const db = c.env.DB;
  const full = (await db.prepare('SELECT * FROM users WHERE id = ?').bind(u.id).first<any>())!;
  const me = c.get('session')!;
  const [sessions, devices, history, notices, pendingContact, privacy, signed] = await Promise.all([
    db.prepare('SELECT rowid AS rid, token_hash, created_at, last_seen_at, ip, country, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC').bind(u.id).all<any>(),
    db.prepare("SELECT id, label, status, first_seen, last_seen, last_country FROM devices WHERE user_id = ? AND status IN ('active', 'pending') ORDER BY status, first_seen").bind(u.id).all<any>(),
    db
      .prepare("SELECT at, action, detail, ip FROM audit_log WHERE target_user_id = ? AND action LIKE 'signin.%' AND at > ? ORDER BY id DESC LIMIT 60")
      .bind(u.id, new Date(Date.now() - 30 * 86400_000).toISOString())
      .all<any>(),
    db.prepare('SELECT id, title, body, created_at, read_at FROM notices WHERE user_id = ? ORDER BY id DESC LIMIT 20').bind(u.id).all<any>(),
    db.prepare("SELECT field, new_value, created_at FROM contact_change_requests WHERE user_id = ? AND status = 'pending'").bind(u.id).all<any>(),
    db.prepare("SELECT kind, status, created_at FROM privacy_requests WHERE user_id = ? ORDER BY id DESC LIMIT 5").bind(u.id).all<any>(),
    db.prepare('SELECT s.signed_at, a.title, a.id FROM agreement_signatures s JOIN agreements a ON a.id = s.agreement_id WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 1').bind(u.id).first<any>(),
  ]);
  await db.prepare("UPDATE notices SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").bind(u.id).run();
  const next = c.req.query('next');
  const label = (a: string) =>
    ({ 'signin.ok': 'Signed in', 'signin.failed': 'Wrong password', 'signin.locked': 'Locked after wrong passwords', 'signin.device_blocked': 'Blocked: device not approved' })[a] ?? a;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="My account" active="account" user={u}>
      <PageHead eyebrow="Account" title="My account" />
      {c.req.query('ok') && <Flash>{c.req.query('ok')}</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}

      <section class="card stack" id="details">
        <h2 style="margin:0">Your details</h2>
        <form method="post" action="/account/profile" class="stack" style="gap:12px">
          {next && <input type="hidden" name="next" value={next} />}
          <div class="grid" style="gap:12px">
            <label class="field">First name<input type="text" name="first_name" required maxlength={60} value={full.first_name ?? full.name.split(' ')[0] ?? ''} /></label>
            <label class="field">Last name<input type="text" name="last_name" required maxlength={60} value={full.last_name ?? full.name.split(' ').slice(1).join(' ')} /></label>
          </div>
          <label class="field">Mobile phone<input type="tel" name="phone" required maxlength={25} value={full.phone ?? ''} placeholder="+1 555 123 4567" />
            <span class="muted small" style="font-weight:500">{full.phone_verified_at ? 'Verified. Changing it needs USMLE100’s approval.' : 'Include your country code if you’re outside the US.'}</span>
          </label>
          <div class="grid" style="gap:12px">
            <label class="field">Preparing for<select name="exam" required><option value="">Choose…</option>{EXAMS.map((e) => <option value={e} selected={full.exam === e}>{e}</option>)}</select></label>
            <label class="field">Graduation year<select name="grad_year" required><option value="">Choose…</option>{gradYears().map((y) => <option value={String(y)} selected={full.grad_year === y}>{y}</option>)}</select></label>
          </div>
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">Save details</button>
        </form>
        {(emailReady(c.env) || smsReady(c.env)) && (
          <div class="stack" style="gap:8px">
            <p class="small" style="margin:0">Email: {full.email_verified_at ? 'verified' : 'not verified'} · Phone: {full.phone_verified_at ? 'verified' : 'not verified'}</p>
            <div class="row">
              {!full.email_verified_at && emailReady(c.env) && <form method="post" action="/account/verify/send"><input type="hidden" name="channel" value="email" /><button class="btn btn-outline btn-sm" type="submit">Verify my email</button></form>}
              {!full.phone_verified_at && smsReady(c.env) && full.phone && <form method="post" action="/account/verify/send"><input type="hidden" name="channel" value="sms" /><button class="btn btn-outline btn-sm" type="submit">Verify my phone</button></form>}
            </div>
            {c.req.query('verify') && (
              <form method="post" action="/account/verify" class="row" style="align-items:flex-end">
                <input type="hidden" name="channel" value={c.req.query('verify') === 'sms' ? 'sms' : 'email'} />
                <label class="field" style="flex:0 1 200px">Code we sent you<input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required /></label>
                <button class="btn btn-primary btn-sm" type="submit">Confirm</button>
              </form>
            )}
          </div>
        )}
        {pendingContact.results.map((p: any) => <p class="small muted" style="margin:0">Waiting for approval: new {p.field} {p.new_value} (asked {String(p.created_at).slice(0, 10)}).</p>)}
        <form method="post" action="/account/email" class="row" style="align-items:flex-end">
          <label class="field" style="flex:1 1 240px">Email<input type="email" name="email" required value={full.email} /></label>
          <button class="btn btn-outline" type="submit">Ask to change email</button>
        </form>
        <p class="muted small" style="margin:0">Your email identifies your account, so a change is approved by USMLE100 first.</p>
      </section>

      <section class="card stack" id="marketing">
        <h2 style="margin:0">Emails from USMLE100</h2>
        <p class="small" style="margin:0">{full.marketing_opt_in ? `You agreed on ${String(full.marketing_consent_at).slice(0, 10)}: “${full.marketing_consent_text}”` : 'You don’t receive news or offers. Account and security messages are always sent.'}</p>
        <form method="post" action="/account/marketing">
          <input type="hidden" name="on" value={full.marketing_opt_in ? '0' : '1'} />
          {full.marketing_opt_in ? <button class="btn btn-outline" type="submit">Stop news and offers</button> : <button class="btn btn-outline" type="submit">{MARKETING_TEXT}</button>}
        </form>
      </section>

      <section class="card stack" id="password">
        <h2 style="margin:0">Change password</h2>
        <form method="post" action="/account/password" class="stack" style="gap:12px;max-width:420px">
          <label class="field">Current password<input type="password" name="current" required autocomplete="current-password" /></label>
          <label class="field">New password<input type="password" name="password" required minlength={MIN_PASSWORD} autocomplete="new-password" /></label>
          <label class="field">Type it again<input type="password" name="again" required minlength={MIN_PASSWORD} autocomplete="new-password" /></label>
          <span class="muted small">At least {MIN_PASSWORD} characters. Changing it signs you out on every device.</span>
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">Change password</button>
        </form>
      </section>

      {!isStaff(u) && (
        <section class="card stack" id="devices">
          <h2 style="margin:0">Registered devices</h2>
          <p class="muted small" style="margin:0">Your account works on 2 devices. To use a new one, sign in on it: USMLE100 reviews the request and replaces one of these.</p>
          {devices.results.length === 0 ? <p class="muted" style="margin:0">None yet.</p> : (
            <ul class="stack" style="gap:6px;margin:0;padding-left:18px">
              {devices.results.map((d: any) => <li>{d.label}{d.status === 'pending' ? ' — waiting for approval' : ''} <span class="muted small">· first used {String(d.first_seen).slice(0, 10)} · last {String(d.last_seen).slice(0, 10)}{d.last_country ? ` · ${d.last_country}` : ''}</span></li>)}
            </ul>
          )}
        </section>
      )}

      <section class="card stack" id="sessions">
        <h2 style="margin:0">Where you’re signed in</h2>
        <div class="table-box"><table class="t">
          <thead><tr><th scope="col">Device</th><th scope="col">Last active</th><th scope="col"></th></tr></thead>
          <tbody>
            {sessions.results.map((s: any) => (
              <tr>
                <td>{deviceLabel(s.user_agent ?? '')}{s.token_hash === me.tokenHash && <strong> (this one)</strong>}<br /><span class="muted small">{[s.country, s.ip].filter(Boolean).join(' · ')}</span></td>
                <td class="small muted">{when(s.last_seen_at)}</td>
                <td>{s.token_hash !== me.tokenHash && (
                  <form method="post" action="/account/report" style="margin:0"><input type="hidden" name="rid" value={String(s.rid)} /><button class="btn btn-ghost btn-sm" type="submit">This wasn’t me</button></form>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <form method="post" action="/account/sign-out-all" class="row" style="align-items:flex-end">
          <label class="field" style="flex:1 1 220px">Your password<input type="password" name="password" required autocomplete="current-password" /></label>
          <button class="btn btn-outline" type="submit">Sign out everywhere else</button>
        </form>
      </section>

      <section class="card stack" id="history">
        <h2 style="margin:0">Sign-in history (30 days)</h2>
        {history.results.length === 0 ? <p class="muted" style="margin:0">Nothing in the last 30 days.</p> : (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Where</th></tr></thead>
            <tbody>
              {history.results.map((h: any) => {
                let d: any = {};
                try { d = JSON.parse(h.detail ?? '{}'); } catch {}
                return <tr><td class="small muted">{String(h.at).slice(0, 16).replace('T', ' ')}</td><td class="small">{label(h.action)}</td><td class="small muted">{[d.device, d.country, h.ip].filter(Boolean).join(' · ')}</td></tr>;
              })}
            </tbody>
          </table></div>
        )}
        <p class="muted small" style="margin:0">See something you don’t recognise? Press “This wasn’t me” above, change your password, and contact USMLE100.</p>
      </section>

      {notices.results.length > 0 && (
        <section class="card stack" id="notices">
          <h2 style="margin:0">Messages</h2>
          {notices.results.map((n: any) => <div><strong>{n.title}</strong> <span class="muted small">{String(n.created_at).slice(0, 16)} UTC</span><p class="small" style="margin:4px 0 0">{n.body}</p></div>)}
        </section>
      )}

      <section class="card stack" id="privacy">
        <h2 style="margin:0">Agreement and your data</h2>
        {signed && <p class="small" style="margin:0">You signed “{signed.title}” on {String(signed.signed_at).slice(0, 10)}. <a href="/agreement">View it</a>.</p>}
        {privacy.results.map((p: any) => <p class="small muted" style="margin:0">{p.kind === 'export' ? 'Copy of your data' : 'Account deletion'} requested {String(p.created_at).slice(0, 10)}: {p.status}.</p>)}
        <div class="row">
          <form method="post" action="/account/privacy"><input type="hidden" name="kind" value="export" /><button class="btn btn-ghost btn-sm" type="submit">Ask for a copy of my data</button></form>
          <form method="post" action="/account/privacy"><input type="hidden" name="kind" value="deletion" /><button class="btn btn-ghost btn-sm" type="submit">Ask to delete my account</button></form>
        </div>
        <p class="muted small" style="margin:0">Requests are checked by USMLE100 to confirm it’s you. Records the law requires us to keep (such as payments) are kept.</p>
      </section>
    </PortalLayout>,
  );
});

account.post('/account/profile', requireUser, async (c) => {
  const u = c.get('user')!;
  const db = c.env.DB;
  const f = await c.req.parseBody();
  const first = String(f.first_name ?? '').trim().replace(/\s+/g, ' ');
  const last = String(f.last_name ?? '').trim().replace(/\s+/g, ' ');
  const phone = normalizePhone(String(f.phone ?? ''));
  const exam = String(f.exam ?? '');
  const grad = Number(f.grad_year);
  if (!validName(first) || !validName(last)) return c.redirect(accountBack('Please enter your first and last name.', true));
  if (!phone) return c.redirect(accountBack('Please enter a valid mobile number. Outside the US, start with + and your country code.', true));
  if (!EXAMS.includes(exam) || !gradYears().includes(grad)) return c.redirect(accountBack('Please choose your exam and graduation year.', true));
  const cur = (await db.prepare('SELECT phone, phone_verified_at FROM users WHERE id = ?').bind(u.id).first<{ phone: string | null; phone_verified_at: string | null }>())!;
  const phoneChangeNeedsApproval = !!cur.phone_verified_at && cur.phone !== phone;
  await db.batch([
    db.prepare('UPDATE users SET first_name = ?, last_name = ?, name = ?, exam = ?, grad_year = ?, phone = CASE WHEN ? THEN phone ELSE ? END WHERE id = ?').bind(first, last, `${first} ${last}`, exam, grad, phoneChangeNeedsApproval ? 1 : 0, phone, u.id),
    ...(phoneChangeNeedsApproval ? [db.prepare("INSERT INTO contact_change_requests (user_id, field, new_value) VALUES (?, 'phone', ?)").bind(u.id, phone)] : []),
  ]);
  await audit(db, { actorId: u.id, action: phoneChangeNeedsApproval ? 'contact.requested' : 'profile.updated', targetUserId: u.id, detail: phoneChangeNeedsApproval ? { field: 'phone' } : null, ip: ipOf(c) });
  const next = typeof f.next === 'string' && /^\/(free-lectures|webinars)(\/|$)/.test(f.next) ? f.next : null;
  if (next && !phoneChangeNeedsApproval) return c.redirect(next);
  return c.redirect(accountBack(phoneChangeNeedsApproval ? 'Saved. Your new phone number will be used once USMLE100 approves it.' : 'Saved.'));
});

account.post('/account/email', requireUser, async (c) => {
  const u = c.get('user')!;
  const email = String((await c.req.parseBody()).email ?? '').trim().toLowerCase();
  if (email === u.email) return c.redirect(accountBack('That’s already your email.'));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return c.redirect(accountBack('Please enter a valid email.', true));
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE contact_change_requests SET status = 'cancelled' WHERE user_id = ? AND field = 'email' AND status = 'pending'").bind(u.id),
    db.prepare("INSERT INTO contact_change_requests (user_id, field, new_value) VALUES (?, 'email', ?)").bind(u.id, email),
    db.prepare("INSERT INTO staff_alerts (level, kind, user_id, message) VALUES ('info', 'contact.request', ?, 'A student asked to change their email.')").bind(u.id),
  ]);
  await audit(db, { actorId: u.id, action: 'contact.requested', targetUserId: u.id, detail: { field: 'email' }, ip: ipOf(c) });
  return c.redirect(accountBack('Request sent. USMLE100 will confirm it’s you before changing your email.'));
});

account.post('/account/marketing', requireUser, async (c) => {
  const u = c.get('user')!;
  const on = (await c.req.parseBody()).on === '1';
  await c.env.DB.prepare(
    "UPDATE users SET marketing_opt_in = ?, marketing_consent_at = CASE WHEN ? THEN datetime('now') ELSE marketing_consent_at END, marketing_consent_text = CASE WHEN ? THEN ? ELSE marketing_consent_text END WHERE id = ?",
  )
    .bind(on ? 1 : 0, on ? 1 : 0, on ? 1 : 0, MARKETING_TEXT, u.id)
    .run();
  await audit(c.env.DB, { actorId: u.id, action: on ? 'marketing.opt_in' : 'marketing.opt_out', targetUserId: u.id, ip: ipOf(c) });
  return c.redirect(accountBack(on ? 'Thanks: you’ll hear about news and offers.' : 'Done: no more news or offers.', false, '#marketing'));
});

/** Needs the current password; ends every sign-in (R092, R093). Progress, devices and views are kept. */
account.post('/account/password', requireUser, async (c) => {
  const u = c.get('user')!;
  const db = c.env.DB;
  const f = await c.req.parseBody();
  if (!(await checkPassword(db, u.id, String(f.current ?? '')))) {
    await audit(db, { actorId: u.id, action: 'password.change_failed', targetUserId: u.id, ip: ipOf(c) });
    return c.redirect(accountBack('Your current password isn’t right.', true, '#password'));
  }
  const password = String(f.password ?? '');
  const bad = await passwordProblem(password);
  if (bad) return c.redirect(accountBack(bad, true, '#password'));
  if (password !== String(f.again ?? '')) return c.redirect(accountBack('The two new passwords don’t match.', true, '#password'));
  const { hash, salt } = await hashPassword(password);
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, u.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM play_tabs WHERE user_id = ?').bind(u.id),
  ]);
  await notify(c.env, u.id, { kind: 'security', title: 'Password changed', body: 'Your password was changed and every device was signed out. If this wasn’t you, contact USMLE100 right away.', sms: true });
  await audit(db, { actorId: u.id, action: 'password.changed', targetUserId: u.id, ip: ipOf(c) });
  return c.redirect('/sign-in?ended=password');
});

account.post('/account/sign-out-all', requireUser, async (c) => {
  const u = c.get('user')!;
  const db = c.env.DB;
  if (!(await checkPassword(db, u.id, String((await c.req.parseBody()).password ?? '')))) return c.redirect(accountBack('Your password isn’t right.', true, '#sessions'));
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(u.id, c.get('session')!.tokenHash).run();
  await audit(db, { actorId: u.id, action: 'sessions.revoked_all', targetUserId: u.id, ip: ipOf(c) });
  return c.redirect(accountBack('Signed out everywhere else.', false, '#sessions'));
});

/** "This wasn't me": end that sign-in at once, and tell USMLE100 (R: report suspicious activity). */
account.post('/account/report', requireUser, async (c) => {
  const u = c.get('user')!;
  const db = c.env.DB;
  const rid = Number((await c.req.parseBody()).rid);
  const s = await db.prepare('SELECT token_hash, ip, country, user_agent FROM sessions WHERE rowid = ? AND user_id = ?').bind(rid, u.id).first<any>();
  if (s && s.token_hash !== c.get('session')!.tokenHash) {
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(s.token_hash),
      db.prepare('DELETE FROM play_tabs WHERE user_id = ?').bind(u.id),
      db.prepare("INSERT INTO security_flags (user_id, kind, detail) VALUES (?, 'reported_session', ?)").bind(u.id, JSON.stringify({ ip: s.ip, country: s.country, device: deviceLabel(s.user_agent ?? '') })),
      db.prepare("INSERT INTO staff_alerts (level, kind, user_id, message) VALUES ('warning', 'reported_session', ?, 'A student reported a sign-in they don’t recognise. It was ended.')").bind(u.id),
    ]);
    await audit(db, { actorId: u.id, action: 'session.reported', targetUserId: u.id, detail: { ip: s.ip, country: s.country }, ip: ipOf(c) });
  }
  return c.redirect(accountBack('That sign-in was ended and USMLE100 was told. Please change your password now.', false, '#password'));
});

account.post('/account/privacy', requireUser, async (c) => {
  const u = c.get('user')!;
  const kind = String((await c.req.parseBody()).kind);
  if (!['export', 'deletion'].includes(kind)) return c.redirect(accountBack('Unknown request.', true));
  const db = c.env.DB;
  if (!(await db.prepare("SELECT 1 FROM privacy_requests WHERE user_id = ? AND kind = ? AND status = 'pending'").bind(u.id, kind).first())) {
    await db.batch([
      db.prepare('INSERT INTO privacy_requests (user_id, kind) VALUES (?, ?)').bind(u.id, kind),
      db.prepare("INSERT INTO staff_alerts (level, kind, user_id, message) VALUES ('info', 'privacy', ?, ?)").bind(u.id, kind === 'export' ? 'A student asked for a copy of their data.' : 'A student asked to delete their account.'),
    ]);
    await audit(db, { actorId: u.id, action: `privacy.${kind}_requested`, targetUserId: u.id, ip: ipOf(c) });
  }
  return c.redirect(accountBack('Request received. USMLE100 will contact you to confirm it’s you.', false, '#privacy'));
});

// ---------- Extra check for risky sign-ins ----------

const CheckPage = (p: { email: string; phone: string | null; reason: string; error?: string; sent?: boolean }) => (
  <PublicLayout title="Confirm it’s you" user={null} plain>
    <main class="wrap page" style="max-width:520px;padding-top:48px;padding-bottom:72px">
      <Eyebrow>USMLE100 · Security check</Eyebrow>
      <h1>Confirm it’s you</h1>
      <p>{p.reason} To keep your account safe, enter the code we sent to <strong>{p.email}</strong>{p.phone && <> and the code we texted to <strong>{p.phone}</strong></>}.</p>
      {p.error && <Flash kind="error">{p.error}</Flash>}
      <form method="post" action="/account/check-sign-in" class="stack" style="gap:12px">
        <label class="field">Email code<input type="text" name="email_code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required /></label>
        {p.phone && <label class="field">Text message code<input type="text" name="sms_code" inputmode="numeric" pattern="[0-9]{6}" required /></label>}
        <button class="btn btn-primary btn-block" type="submit">Continue</button>
      </form>
      <form method="post" action="/account/check-sign-in/resend" style="margin-top:12px"><button class="btn btn-ghost btn-sm" type="submit">Send new codes</button></form>
      <form method="post" action="/sign-out" style="margin-top:8px"><button class="btn btn-ghost btn-sm" type="submit">Sign out</button></form>
    </main>
  </PublicLayout>
);

const mask = (s: string) => s.replace(/^(.).*(@.*)$/, '$1•••$2').replace(/^(\+\d{1,3})\d+(\d{2})$/, '$1•••••$2');

async function checkTargets(c: Context<AppEnv>) {
  const u = (await c.env.DB.prepare('SELECT email, phone, phone_verified_at FROM users WHERE id = ?').bind(c.get('user')!.id).first<any>())!;
  return { email: u.email as string, phone: u.phone_verified_at && smsReady(c.env) ? (u.phone as string) : null };
}

async function sendCheckCodes(c: Context<AppEnv>) {
  const uid = c.get('user')!.id;
  const t = await checkTargets(c);
  const a = await sendCode(c.env, uid, 'email', 'signin', t.email);
  const b = t.phone ? await sendCode(c.env, uid, 'sms', 'signin', t.phone) : { ok: true };
  return a.ok && b.ok ? null : (a as any).error ?? (b as any).error;
}

account.get('/account/check-sign-in', requireUser, async (c) => {
  const s = c.get('session')!;
  if (!s.verifyPending) return c.redirect('/dashboard');
  const reasonRow = await c.env.DB.prepare('SELECT verify_reason FROM sessions WHERE token_hash = ?').bind(s.tokenHash).first<{ verify_reason: string | null }>();
  const t = await checkTargets(c);
  const active = await c.env.DB.prepare("SELECT 1 FROM otp_codes WHERE user_id = ? AND purpose = 'signin' AND used_at IS NULL AND expires_at > ?").bind(c.get('user')!.id, Math.floor(Date.now() / 1000)).first();
  const error = active ? null : await sendCheckCodes(c);
  c.header('Cache-Control', 'no-store');
  return c.html(<CheckPage email={mask(t.email)} phone={t.phone ? mask(t.phone) : null} reason={RISK_TEXT[(reasonRow?.verify_reason ?? 'new-device') as Risk] ?? ''} error={error ?? undefined} />);
});

account.post('/account/check-sign-in/resend', requireUser, async (c) => {
  if (!c.get('session')!.verifyPending) return c.redirect('/dashboard');
  await sendCheckCodes(c);
  return c.redirect('/account/check-sign-in');
});

/** Five wrong tries end the sign-in, put that device back for admin review, and warn the student (R: repeated failures). */
account.post('/account/check-sign-in', requireUser, async (c) => {
  const s = c.get('session')!;
  const u = c.get('user')!;
  if (!s.verifyPending) return c.redirect('/dashboard');
  const db = c.env.DB;
  const f = await c.req.parseBody();
  const t = await checkTargets(c);
  const e = await checkCode(db, u.id, 'email', 'signin', String(f.email_code ?? ''));
  const p = t.phone ? await checkCode(db, u.id, 'sms', 'signin', String(f.sms_code ?? '')) : 'ok';
  if (e === 'ok' && p === 'ok') {
    await db.prepare('UPDATE sessions SET verify_pending = 0 WHERE token_hash = ?').bind(s.tokenHash).run();
    await audit(db, { actorId: u.id, action: 'signin.verified', targetUserId: u.id, ip: ipOf(c) });
    return c.redirect('/dashboard');
  }
  if (e === 'locked' || p === 'locked') {
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(s.tokenHash),
      db.prepare("UPDATE devices SET status = 'pending' WHERE user_id = ? AND device_hash = ?").bind(u.id, s.deviceHash ?? ''),
      db.prepare("INSERT INTO security_flags (user_id, kind, detail) VALUES (?, 'signin_check_failed', ?)").bind(u.id, JSON.stringify({ ip: ipOf(c), country: c.req.header('cf-ipcountry') ?? null })),
      db.prepare("INSERT INTO staff_alerts (level, kind, user_id, message) VALUES ('warning', 'signin_check_failed', ?, 'A sign-in failed the extra security check 5 times. The device needs your review before it can try again.')").bind(u.id),
    ]);
    await notify(c.env, u.id, { kind: 'security', title: 'Blocked sign-in', body: 'Someone signed in with your password but couldn’t confirm the security codes, so we blocked it. If it wasn’t you, change your password now.', sms: true });
    await audit(db, { actorId: u.id, action: 'signin.check_failed', targetUserId: u.id, ip: ipOf(c) });
    return c.redirect('/sign-in?ended=verify');
  }
  const tt = await checkTargets(c);
  return c.html(<CheckPage email={mask(tt.email)} phone={tt.phone ? mask(tt.phone) : null} reason="" error="One of the codes isn’t right. Please try again." />, 400);
});

// ---------- Verify email and phone (R015), once email/SMS are set up ----------

account.post('/account/verify/send', requireUser, async (c) => {
  const u = c.get('user')!;
  const channel = (await c.req.parseBody()).channel === 'sms' ? 'sms' : 'email';
  const full = (await c.env.DB.prepare('SELECT email, phone FROM users WHERE id = ?').bind(u.id).first<any>())!;
  if (channel === 'email' ? !emailReady(c.env) : !smsReady(c.env) || !full.phone) return c.redirect(accountBack('Verification isn’t available yet.', true));
  const r = await sendCode(c.env, u.id, channel, `verify_${channel}`, channel === 'email' ? full.email : full.phone);
  if (!r.ok) return c.redirect(accountBack(r.error ?? 'We couldn’t send the code.', true));
  return c.redirect(`/account?verify=${channel}#details`);
});

account.post('/account/verify', requireUser, async (c) => {
  const u = c.get('user')!;
  const f = await c.req.parseBody();
  const channel = f.channel === 'sms' ? 'sms' : 'email';
  const r = await checkCode(c.env.DB, u.id, channel, `verify_${channel}`, String(f.code ?? ''));
  if (r !== 'ok') return c.redirect(`/account?verify=${channel}&error=${encodeURIComponent(r === 'locked' ? 'Too many wrong codes. Send a new one.' : 'That code isn’t right.')}#details`);
  await c.env.DB.prepare(`UPDATE users SET ${channel === 'email' ? 'email_verified_at' : 'phone_verified_at'} = datetime('now') WHERE id = ?`).bind(u.id).run();
  await audit(c.env.DB, { actorId: u.id, action: `contact.${channel}_verified`, targetUserId: u.id, ip: ipOf(c) });
  return c.redirect(accountBack(channel === 'email' ? 'Email verified.' : 'Phone verified.', false, '#details'));
});
