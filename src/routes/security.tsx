import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { isOwner, isStaff } from '../lib/types';
import { requireAdminOrFacultyAllowed, verifyPassword, sha256Hex, REAUTH_SECONDS } from '../lib/auth';
import { PortalLayout, Eyebrow, Flash } from '../views/layout';
import { audit, verifyAuditChain } from '../lib/audit';
import { unlockAccount } from '../lib/ratelimit';
import { lockdownOn } from '../lib/gate';

/**
 * Admin security tools: owner re-confirmation, the security log, locked accounts, warnings,
 * suspensions, the emergency lockdown and the student agreement.
 * Owner-only POSTs are enforced centrally in requireAdminOrFacultyAllowed (OWNER_ONLY in lib/auth).
 */
export const security = new Hono<AppEnv>();
security.use('*', requireAdminOrFacultyAllowed);

const ip = (c: any) => c.req.header('cf-connecting-ip') ?? null;
const safeNext = (n: unknown) => (typeof n === 'string' && n.startsWith('/admin') && !n.startsWith('//') ? n : '/admin/security');

// ---------- Owner re-confirmation (step-up before owner-only changes) ----------

const ConfirmPage = (p: { user: any; shell: any; next: string; error?: string }) => (
  <PortalLayout shell={p.shell} title="Confirm it’s you" active="admin-security" user={p.user}>
    <Eyebrow>Owner</Eyebrow>
    <h1>Confirm it’s you</h1>
    <p class="muted">Owner-only changes need your password again. You won’t be asked again for {REAUTH_SECONDS / 60} minutes.</p>
    {p.error && <Flash kind="error">{p.error}</Flash>}
    <form method="post" action="/admin/confirm" class="card stack" style="gap:14px;max-width:420px">
      <input type="hidden" name="next" value={p.next} />
      <label class="field">Password<input type="password" name="password" required autocomplete="current-password" /></label>
      <button class="btn btn-primary" type="submit">Confirm</button>
    </form>
  </PortalLayout>
);

security.get('/confirm', (c) => {
  const u = c.get('user')!;
  if (!isOwner(u)) return c.text('Only the owner can do this.', 403);
  return c.html(<ConfirmPage user={u} shell={c.get('shell')} next={safeNext(c.req.query('next'))} />);
});

security.post('/confirm', async (c) => {
  const u = c.get('user')!;
  if (!isOwner(u)) return c.text('Only the owner can do this.', 403);
  const f = await c.req.parseBody();
  const next = safeNext(f.next);
  const row = await c.env.DB.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').bind(u.id).first<{ password_hash: string; password_salt: string }>();
  if (!row || !(await verifyPassword(String(f.password ?? ''), row.password_hash, row.password_salt))) {
    await audit(c.env.DB, { actorId: u.id, action: 'owner.confirm_failed', targetUserId: u.id, ip: ip(c) });
    return c.html(<ConfirmPage user={u} shell={c.get('shell')} next={next} error="That password is not right." />, 401);
  }
  await c.env.DB.prepare('UPDATE sessions SET reauth_at = ? WHERE token_hash = ?').bind(Math.floor(Date.now() / 1000), c.get('session')!.tokenHash).run();
  await audit(c.env.DB, { actorId: u.id, action: 'owner.confirmed', targetUserId: u.id, ip: ip(c) });
  return c.redirect(next);
});

// ---------- Security page ----------

const ACTION_LABEL: Record<string, string> = {
  'signin.ok': 'Signed in',
  'signin.failed': 'Wrong password',
  'signin.locked': 'Account locked (5 wrong passwords)',
  'account.created': 'Account created',
  'account.unlocked': 'Account unlocked',
  'password.reset': 'Password reset with link',
  'reset.link_made': 'Reset link made',
  'owner.confirmed': 'Owner confirmed password',
  'owner.confirm_failed': 'Owner confirmation failed',
  'role.changed': 'Role changed',
  'account.warned': 'Warning issued',
  'warning.acknowledged': 'Warning acknowledged',
  'account.suspended': 'Account suspended',
  'account.reinstated': 'Account reinstated',
  'lockdown.on': 'Emergency lockdown ON',
  'lockdown.off': 'Emergency lockdown OFF',
  'agreement.published': 'Agreement published',
  'agreement.signed': 'Agreement signed',
  'settings.changed': 'Site settings changed',
  'payment.enrollment': 'Program purchase',
  'payment.book': 'Course Book purchase',
  'refund.revoked': 'Full refund: access removed',
  'access.restored': 'Refunded access restored',
  'access.book_granted': 'Course Book access given',
  'access.book_removed': 'Course Book access removed',
  'access.evening': 'Evening Questions access changed',
  'access.lectures': 'Lecture access date changed',
  'admin.post': 'Staff change',
  'views.requested': 'Asked for more lecture views',
  'views.granted': 'Extra lecture views given',
  'views.declined': 'Request for more views declined',
  'owner.denied': 'Blocked: owner-only change attempted',
};

security.get('/security', async (c) => {
  const me = c.get('user')!;
  if (!isOwner(me) && me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const q = String(c.req.query('q') ?? '').trim().toLowerCase();
  const [locks, flagged, chain, lockdown, log] = await Promise.all([
    db.prepare('SELECT a.email, a.locked_at, u.name FROM account_locks a LEFT JOIN users u ON u.email = a.email WHERE a.unlocked_at IS NULL ORDER BY a.locked_at DESC').all<any>(),
    db.prepare("SELECT id, name, email, status, status_reason, status_at, warnings FROM users WHERE status <> 'active' ORDER BY status_at DESC").all<any>(),
    verifyAuditChain(db),
    lockdownOn(db),
    db
      .prepare(
        `SELECT a.id, a.at, a.action, a.detail, a.ip, ac.name AS actor, t.name AS target, t.email AS target_email
         FROM audit_log a LEFT JOIN users ac ON ac.id = a.actor_id LEFT JOIN users t ON t.id = a.target_user_id
         WHERE (? = '' OR LOWER(COALESCE(t.email, '')) LIKE ? OR LOWER(COALESCE(a.detail, '')) LIKE ? OR a.action LIKE ?)
         ORDER BY a.id DESC LIMIT 200`,
      )
      .bind(q, `%${q}%`, `%${q}%`, `%${q}%`)
      .all<any>(),
  ]);
  const owner = isOwner(me);
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: security" active="admin-security" user={me} wide>
      <Eyebrow>Admin</Eyebrow>
      <h1>Security</h1>
      {c.req.query('ok') && <Flash>Saved.</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}

      <section class="card stack" style={lockdown ? 'border:2px solid #c2462e' : undefined}>
        <h2 style="margin:0">Emergency lockdown</h2>
        <p class="muted" style="margin:0">
          {lockdown
            ? 'ON: students are signed out and cannot open the portal, lectures or the Course Book. Public pages, checkout and staff access keep working.'
            : 'OFF. Turning it on immediately signs every student out and closes student areas until you turn it off. Public pages, checkout and staff keep working.'}
        </p>
        {owner ? (
          <form method="post" action="/admin/security/lockdown" class="row">
            <input type="hidden" name="on" value={lockdown ? '0' : '1'} />
            <button class={'btn ' + (lockdown ? 'btn-primary' : 'btn-outline')} type="submit">{lockdown ? 'Turn lockdown off' : 'Turn lockdown on'}</button>
          </form>
        ) : (
          <p class="small muted" style="margin:0">Only the owner can change this.</p>
        )}
      </section>

      <section class="card stack">
        <h2 style="margin:0">Locked accounts</h2>
        <p class="muted small" style="margin:0">After 5 wrong passwords an account stays locked until an admin unlocks it. Making a password reset link also unlocks it when the link is used.</p>
        {locks.results.length === 0 ? (
          <p class="muted" style="margin:0">No locked accounts.</p>
        ) : (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">Account</th><th scope="col">Locked</th><th scope="col"></th></tr></thead>
            <tbody>
              {locks.results.map((l: any) => (
                <tr>
                  <td>{l.name ?? '(no account)'}<br /><span class="muted small">{l.email}</span></td>
                  <td class="small muted">{String(l.locked_at).slice(0, 16)} UTC</td>
                  <td><form method="post" action="/admin/security/unlock"><input type="hidden" name="email" value={l.email} /><button class="btn btn-outline" type="submit">Unlock</button></form></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <section class="card stack">
        <h2 style="margin:0">Warn or suspend an account</h2>
        <p class="muted small" style="margin:0">A warning shows the student a notice they must acknowledge. A suspension signs them out and blocks the whole account until the owner reinstates it. Their purchases and progress are kept.</p>
        <form method="post" action="/admin/security/status" class="stack" style="gap:12px">
          <div class="row" style="align-items:flex-end">
            <label class="field" style="flex:2 1 240px">Account email<input type="email" name="email" required /></label>
            <label class="field" style="flex:1 1 160px">Action
              <select name="status"><option value="warned">Warn</option><option value="suspended">Suspend</option></select>
            </label>
          </div>
          <label class="field">Reason (shown to the student)<input type="text" name="reason" required maxlength={300} /></label>
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">Save</button>
        </form>
        {flagged.results.length > 0 && (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">Account</th><th scope="col">Status</th><th scope="col">Reason</th><th scope="col"></th></tr></thead>
            <tbody>
              {flagged.results.map((u: any) => (
                <tr>
                  <td>{u.name}<br /><span class="muted small">{u.email}</span></td>
                  <td>{u.status === 'suspended' ? <span class="chip" style="background:#f6dcd5;color:#8c2f20">Suspended</span> : <span class="chip chip-sand">Warned</span>}<br /><span class="muted small">{String(u.status_at ?? '').slice(0, 10)} · warnings: {u.warnings}</span></td>
                  <td class="small">{u.status_reason}</td>
                  <td>{owner && <form method="post" action="/admin/security/reinstate"><input type="hidden" name="user_id" value={String(u.id)} /><button class="btn btn-outline" type="submit">Reinstate</button></form>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <section class="card stack">
        <h2 style="margin:0">Security log</h2>
        {chain.ok ? (
          <Flash>Log intact: all {chain.checked} entries check out. Kept for 24 months.</Flash>
        ) : (
          <Flash kind="error">The log has been altered near entry #{chain.brokenAt}. Contact your developer.</Flash>
        )}
        <form method="get" action="/admin/security" class="row" style="align-items:flex-end">
          <label class="field" style="flex:1 1 240px">Search by email or action<input type="search" name="q" value={q} /></label>
          <button class="btn btn-outline" type="submit">Search</button>
        </form>
        <div class="table-box"><table class="t">
          <thead><tr><th scope="col">When (UTC)</th><th scope="col">What</th><th scope="col">Who</th><th scope="col">Account</th><th scope="col">IP</th></tr></thead>
          <tbody>
            {log.results.map((e: any) => (
              <tr>
                <td class="small muted">{String(e.at).slice(0, 16).replace('T', ' ')}</td>
                <td class="small">{ACTION_LABEL[e.action] ?? e.action}{e.detail && <><br /><span class="muted">{String(e.detail).slice(0, 160)}</span></>}</td>
                <td class="small">{e.actor ?? '—'}</td>
                <td class="small">{e.target ?? ''}{e.target_email && <><br /><span class="muted">{e.target_email}</span></>}</td>
                <td class="small muted">{e.ip ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {log.results.length === 200 && <p class="muted small" style="margin:0">Showing the latest 200 entries. Search to narrow down.</p>}
      </section>
    </PortalLayout>,
  );
});

security.post('/security/unlock', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const email = String((await c.req.parseBody()).email ?? '').trim().toLowerCase();
  await unlockAccount(c.env.DB, email, me.id);
  const t = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>();
  await audit(c.env.DB, { actorId: me.id, action: 'account.unlocked', targetUserId: t?.id ?? null, detail: { email }, ip: ip(c) });
  return c.redirect('/admin/security?ok=1');
});

security.post('/security/status', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const f = await c.req.parseBody();
  const email = String(f.email ?? '').trim().toLowerCase();
  const status = String(f.status ?? '');
  const reason = String(f.reason ?? '').trim().slice(0, 300);
  const bad = (m: string) => c.redirect('/admin/security?error=' + encodeURIComponent(m));
  if (!['warned', 'suspended'].includes(status)) return bad('Pick warn or suspend.');
  if (!reason) return bad('Please give a reason.');
  const t = await c.env.DB.prepare('SELECT id, role, is_owner, status FROM users WHERE email = ?').bind(email).first<any>();
  if (!t) return bad(`No account uses ${email}.`);
  if (t.is_owner === 1) return bad('The owner account cannot be warned or suspended.');
  if (t.id === me.id) return bad('You cannot change your own account status.');
  if (isStaff(t) && !isOwner(me)) return bad('Only the owner can warn or suspend faculty and admins.');
  if (t.status === 'suspended' && status === 'warned') return bad('That account is suspended. The owner can reinstate it first.');
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE users SET status = ?, status_reason = ?, status_at = datetime('now'), warnings = warnings + ? WHERE id = ?").bind(status, reason, status === 'warned' ? 1 : 0, t.id),
    ...(status === 'suspended' ? [db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(t.id)] : []),
  ]);
  await audit(db, { actorId: me.id, action: status === 'warned' ? 'account.warned' : 'account.suspended', targetUserId: t.id, detail: { reason }, ip: ip(c) });
  return c.redirect('/admin/security?ok=1');
});

/** Owner only (OWNER_ONLY): lift a warning or suspension. */
security.post('/security/reinstate', async (c) => {
  const me = c.get('user')!;
  const id = Number((await c.req.parseBody()).user_id);
  await c.env.DB.prepare("UPDATE users SET status = 'active', status_reason = NULL, status_at = datetime('now') WHERE id = ?").bind(id).run();
  await audit(c.env.DB, { actorId: me.id, action: 'account.reinstated', targetUserId: id, ip: ip(c) });
  return c.redirect('/admin/security?ok=1');
});

/** Owner only (OWNER_ONLY): emergency lockdown. Turning it on signs every student out at once. */
security.post('/security/lockdown', async (c) => {
  const me = c.get('user')!;
  const on = (await c.req.parseBody()).on === '1';
  const db = c.env.DB;
  await db.batch([
    db.prepare("INSERT INTO settings (key, value) VALUES ('lockdown', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(on ? '1' : '0'),
    ...(on ? [db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role NOT IN ('admin', 'faculty'))")] : []),
  ]);
  await audit(db, { actorId: me.id, action: on ? 'lockdown.on' : 'lockdown.off', ip: ip(c) });
  return c.redirect('/admin/security?ok=1');
});

// ---------- Student agreement (owner publishes versions) ----------

security.get('/agreement', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const versions = (
    await db
      .prepare(
        `SELECT a.id, a.title, a.body, a.material, a.published_at, u.name AS by_name,
                (SELECT COUNT(*) FROM agreement_signatures s WHERE s.agreement_id = a.id) AS signed
         FROM agreements a LEFT JOIN users u ON u.id = a.published_by ORDER BY a.id DESC`,
      )
      .all<any>()
  ).results;
  const latest = versions[0];
  const students = (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'student'").first<{ n: number }>())?.n ?? 0;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: student agreement" active="admin-agreement" user={me}>
      <Eyebrow>Admin</Eyebrow>
      <h1>Student agreement</h1>
      {c.req.query('ok') && <Flash>Published.</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <p class="muted">
        Students must sign the latest version before using the portal (typed legal name, date of birth, 18+). A <strong>material</strong> change makes every student sign again; a minor
        correction does not. Nothing is shown to students until you publish the first version. Have your lawyer review the text first.
      </p>
      {isOwner(me) ? (
        <form method="post" action="/admin/agreement" class="card stack" style="gap:12px">
          <label class="field">Title<input type="text" name="title" required maxlength={150} value={latest?.title ?? 'USMLE100 Student Agreement'} /></label>
          <label class="field">Text (blank lines start a new paragraph)<textarea name="body" rows={16} required maxlength={60000}>{latest?.body ?? ''}</textarea></label>
          <label class="check"><input type="checkbox" name="material" value="1" checked /> Material change: every student must sign again</label>
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">Publish new version</button>
        </form>
      ) : (
        <p class="small muted">Only the owner can publish versions.</p>
      )}
      <div class="table-box">
        <table class="t">
          <thead><tr><th scope="col">Version</th><th scope="col">Published</th><th scope="col">Type</th><th scope="col">Signed</th></tr></thead>
          <tbody>
            {versions.map((v: any) => (
              <tr>
                <td>{v.id}: {v.title}</td>
                <td class="small muted">{String(v.published_at).slice(0, 16)} UTC{v.by_name && ` · ${v.by_name}`}</td>
                <td>{v.material ? 'Material' : 'Minor'}</td>
                <td>{v.signed} of {students}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PortalLayout>,
  );
});

/** Owner only (OWNER_ONLY). */
security.post('/agreement', async (c) => {
  const me = c.get('user')!;
  const f = await c.req.parseBody();
  const title = String(f.title ?? '').trim().slice(0, 150);
  const body = String(f.body ?? '').replace(/\r\n/g, '\n').trim();
  if (!title || body.length < 50) return c.redirect('/admin/agreement?error=' + encodeURIComponent('Please enter a title and the full agreement text.'));
  if (body.length > 60000) return c.redirect('/admin/agreement?error=' + encodeURIComponent('The text is too long.'));
  const db = c.env.DB;
  const first = !(await db.prepare('SELECT 1 FROM agreements LIMIT 1').first());
  const material = first || f.material === '1' ? 1 : 0;
  const hash = await sha256Hex(title + '\n' + body);
  const r = await db.prepare('INSERT INTO agreements (title, body, body_hash, material, published_by) VALUES (?, ?, ?, ?, ?)').bind(title, body, hash, material, me.id).run();
  await audit(db, { actorId: me.id, action: 'agreement.published', detail: { version: Number(r.meta.last_row_id), material: !!material, hash }, ip: ip(c) });
  return c.redirect('/admin/agreement?ok=1');
});

// ---------- Lecture views: requests and extra views (owner grants, R044/R051) ----------

security.get('/views', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const email = String(c.req.query('email') ?? '').trim().toLowerCase();
  const owner = isOwner(me);
  const requests = (
    await db
      .prepare(
        `SELECT r.id, r.kind, r.created_at, r.user_id, r.lecture_id, u.name, u.email, l.title, l.day_number
         FROM view_requests r JOIN users u ON u.id = r.user_id JOIN lectures l ON l.id = r.lecture_id
         WHERE r.resolved_at IS NULL ORDER BY r.id`,
      )
      .all<any>()
  ).results;
  const student = email ? await db.prepare('SELECT id, name, email FROM users WHERE email = ?').bind(email).first<{ id: number; name: string; email: string }>() : null;
  const rows = student
    ? (
        await db
          .prepare(
            `SELECT v.lecture_id, v.kind, l.title, l.day_number,
                    SUM(v.counted) AS used, SUM(CASE WHEN v.counted = 0 AND v.started_at IS NOT NULL THEN 1 ELSE 0 END) AS open,
                    MAX(v.started_at) AS last_started,
                    (SELECT COALESCE(SUM(g.extra), 0) FROM view_grants g WHERE g.user_id = v.user_id AND g.lecture_id = v.lecture_id AND g.kind = v.kind) AS extra
             FROM view_sessions v JOIN lectures l ON l.id = v.lecture_id
             WHERE v.user_id = ? GROUP BY v.lecture_id, v.kind ORDER BY l.day_number`,
          )
          .bind(student.id)
          .all<any>()
      ).results
    : [];
  const GrantForm = (p: { userId: number; lectureId: number; kind: string; requestId?: number }) =>
    owner ? (
      <form method="post" action="/admin/views/grant" class="row" style="align-items:flex-end;gap:8px">
        <input type="hidden" name="user_id" value={String(p.userId)} />
        <input type="hidden" name="lecture_id" value={String(p.lectureId)} />
        <input type="hidden" name="kind" value={p.kind} />
        {p.requestId && <input type="hidden" name="request_id" value={String(p.requestId)} />}
        <label class="field" style="flex:0 0 90px">Extra<select name="extra"><option>1</option><option>2</option><option>3</option><option>5</option></select></label>
        <label class="field" style="flex:1 1 160px">Reason<input type="text" name="reason" required maxlength={200} /></label>
        <button class="btn btn-primary btn-sm" type="submit">Give views</button>
      </form>
    ) : (
      <span class="muted small">Only the owner can give extra views.</span>
    );
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: lecture views" active="admin-views" user={me} wide>
      <Eyebrow>Admin</Eyebrow>
      <h1>Lecture views</h1>
      {c.req.query('ok') && <Flash>Saved.</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <p class="muted">Paid lectures: 5 views per lecture for each enrollment. Free lectures: 2 views. A view is used at 65% watched or when a started viewing’s 24 hours end. Only the owner can give extra views; every change is logged.</p>
      <section class="card stack">
        <h2 style="margin:0">Requests for more views</h2>
        {requests.length === 0 ? (
          <p class="muted" style="margin:0">No open requests.</p>
        ) : (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">Student</th><th scope="col">Lecture</th><th scope="col">Asked</th><th scope="col">Decision</th></tr></thead>
            <tbody>
              {requests.map((r: any) => (
                <tr>
                  <td>{r.name}<br /><a class="small" href={`/admin/views?email=${encodeURIComponent(r.email)}`}>{r.email}</a></td>
                  <td>Day {r.day_number}: {r.title}<br /><span class="muted small">{r.kind === 'free' ? 'Free lecture' : 'Paid lecture'}</span></td>
                  <td class="small muted">{String(r.created_at).slice(0, 16)} UTC</td>
                  <td class="stack" style="gap:6px">
                    <GrantForm userId={r.user_id} lectureId={r.lecture_id} kind={r.kind} requestId={r.id} />
                    {owner && <form method="post" action="/admin/views/dismiss"><input type="hidden" name="request_id" value={String(r.id)} /><button class="btn btn-ghost btn-sm" type="submit">Decline</button></form>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      <section class="card stack">
        <h2 style="margin:0">A student’s views</h2>
        <form method="get" action="/admin/views" class="row" style="align-items:flex-end">
          <label class="field" style="flex:1 1 240px">Student email<input type="email" name="email" value={email} required /></label>
          <button class="btn btn-outline" type="submit">Look up</button>
        </form>
        {email && !student && <p class="muted" style="margin:0">No account uses {email}.</p>}
        {student && rows.length === 0 && <p class="muted" style="margin:0">{student.name} hasn’t started any lecture yet.</p>}
        {student && rows.length > 0 && (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">Lecture</th><th scope="col">Views used</th><th scope="col">Extra views</th><th scope="col"></th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr>
                  <td>Day {r.day_number}: {r.title}<br /><span class="muted small">{r.kind === 'free' ? 'Free lecture' : 'Paid lecture'}{r.open ? ' · a viewing is open' : ''}</span></td>
                  <td>{r.used} of {(r.kind === 'free' ? 2 : 5) + r.extra}</td>
                  <td>{r.extra}</td>
                  <td><GrantForm userId={student.id} lectureId={r.lecture_id} kind={r.kind} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </PortalLayout>,
  );
});

/** Owner only (OWNER_ONLY). Paid extra views apply to the student's current enrollment. */
security.post('/views/grant', async (c) => {
  const me = c.get('user')!;
  const f = await c.req.parseBody();
  const userId = Number(f.user_id), lectureId = Number(f.lecture_id), kind = String(f.kind);
  const extra = Math.min(10, Math.max(1, Math.floor(Number(f.extra) || 0)));
  const reason = String(f.reason ?? '').trim().slice(0, 200);
  const bad = (m: string) => c.redirect('/admin/views?error=' + encodeURIComponent(m));
  if (!['free', 'paid'].includes(kind) || !reason) return bad('Please give a reason.');
  const db = c.env.DB;
  const u = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string }>();
  if (!u || !(await db.prepare('SELECT 1 FROM lectures WHERE id = ?').bind(lectureId).first())) return bad('Student or lecture not found.');
  const enr = kind === 'paid' ? await db.prepare("SELECT id FROM enrollments WHERE user_id = ? AND status = 'active' ORDER BY paid_at DESC LIMIT 1").bind(userId).first<{ id: number }>() : null;
  if (kind === 'paid' && !enr) return bad('That student has no active program, so paid views can’t be added.');
  await db.batch([
    db.prepare('INSERT INTO view_grants (user_id, lecture_id, kind, enrollment_id, extra, reason, granted_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(userId, lectureId, kind, enr?.id ?? null, extra, reason, me.id),
    db.prepare("UPDATE view_requests SET resolved_at = datetime('now'), resolved_by = ?, outcome = 'granted' WHERE user_id = ? AND lecture_id = ? AND resolved_at IS NULL").bind(me.id, userId, lectureId),
  ]);
  await audit(db, { actorId: me.id, action: 'views.granted', targetUserId: userId, detail: { lecture: lectureId, kind, extra, reason }, ip: ip(c) });
  return c.redirect('/admin/views?ok=1&email=' + encodeURIComponent(u.email));
});

security.post('/views/dismiss', async (c) => {
  const me = c.get('user')!;
  const id = Number((await c.req.parseBody()).request_id);
  const r = await c.env.DB.prepare('SELECT user_id, lecture_id FROM view_requests WHERE id = ?').bind(id).first<{ user_id: number; lecture_id: number }>();
  await c.env.DB.prepare("UPDATE view_requests SET resolved_at = datetime('now'), resolved_by = ?, outcome = 'declined' WHERE id = ? AND resolved_at IS NULL").bind(me.id, id).run();
  if (r) await audit(c.env.DB, { actorId: me.id, action: 'views.declined', targetUserId: r.user_id, detail: { lecture: r.lecture_id }, ip: ip(c) });
  return c.redirect('/admin/views?ok=1');
});
