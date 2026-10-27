import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { isOwner, isStaff } from '../lib/types';
import { requireAdminOrFacultyAllowed, verifyPassword, sha256Hex, REAUTH_SECONDS } from '../lib/auth';
import { PortalLayout, Eyebrow, Flash } from '../views/layout';
import { audit, verifyAuditChain } from '../lib/audit';
import { unlockAccount } from '../lib/ratelimit';
import { lockdownOn } from '../lib/gate';
import { hasPasskey } from '../lib/passkeys';
import { PASSKEY_PAGE_JS, WEBAUTHN_JS } from './passkeys';
import { notify } from '../lib/messaging';
import { FREE_VIEWS, PAID_VIEWS, itemLabel, parseKey, titleOf } from '../lib/viewing';

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

const ConfirmPage = (p: { user: any; shell: any; next: string; error?: string; passkey: boolean }) => (
  <PortalLayout shell={p.shell} title="Confirm it’s you" active="admin-security" user={p.user}>
    <Eyebrow>Owner</Eyebrow>
    <h1>Confirm it’s you</h1>
    {p.passkey ? (
      <>
        <p class="muted">Owner-only changes need a fresh confirmation with your passkey. You won’t be asked again for {REAUTH_SECONDS / 60} minutes.</p>
        <p id="pk-msg" class="flash" hidden role="status"></p>
        <button class="btn btn-primary" type="button" data-pk="auth" data-purpose="stepup" data-next={p.next} style="align-self:flex-start">Confirm with my passkey</button>
        <script dangerouslySetInnerHTML={{ __html: WEBAUTHN_JS + PASSKEY_PAGE_JS }} />
      </>
    ) : (
      <>
        <p class="muted">Owner-only changes need your password again. You won’t be asked again for {REAUTH_SECONDS / 60} minutes.</p>
        {p.error && <Flash kind="error">{p.error}</Flash>}
        <form method="post" action="/admin/confirm" class="card stack" style="gap:14px;max-width:420px">
          <input type="hidden" name="next" value={p.next} />
          <label class="field">Password<input type="password" name="password" required autocomplete="current-password" /></label>
          <button class="btn btn-primary" type="submit">Confirm</button>
        </form>
      </>
    )}
  </PortalLayout>
);

security.get('/confirm', async (c) => {
  const u = c.get('user')!;
  if (!isOwner(u)) return c.text('Only the owner can do this.', 403);
  return c.html(<ConfirmPage user={u} shell={c.get('shell')} next={safeNext(c.req.query('next'))} passkey={await hasPasskey(c.env.DB, u.id)} />);
});

security.post('/confirm', async (c) => {
  const u = c.get('user')!;
  if (!isOwner(u)) return c.text('Only the owner can do this.', 403);
  const f = await c.req.parseBody();
  const next = safeNext(f.next);
  // With a passkey set up, a password alone is no longer enough for owner-only changes (fresh MFA, R021).
  if (await hasPasskey(c.env.DB, u.id)) return c.redirect('/admin/confirm?next=' + encodeURIComponent(next));
  const row = await c.env.DB.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').bind(u.id).first<{ password_hash: string; password_salt: string }>();
  if (!row || !(await verifyPassword(String(f.password ?? ''), row.password_hash, row.password_salt))) {
    await audit(c.env.DB, { actorId: u.id, action: 'owner.confirm_failed', targetUserId: u.id, ip: ip(c) });
    return c.html(<ConfirmPage user={u} shell={c.get('shell')} next={next} passkey={false} error="That password is not right." />, 401);
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
  'free.added': 'Video added to Free lectures',
  'free.published': 'Free lecture published',
  'free.unpublished': 'Free lecture unpublished',
  'case.opened': 'Appeal or dispute sent',
  'case.reviewed': 'Case reviewed (recommendation)',
  'case.expedited': 'Case expedited (exam soon)',
  'case.decided': 'Case decided by the owner',
  'passkey.added': 'Passkey added',
  'passkey.removed': 'Passkey removed',
  'passkey.signin': 'Signed in with passkey',
  'passkey.failed': 'Passkey not accepted',
  'passkey.recovery_used': 'Signed in with a recovery code',
  'passkey.recovery_failed': 'Wrong recovery code',
  'passkey.codes_renewed': 'Recovery codes renewed',
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
            <input type="text" name="reason" maxlength={300} placeholder={lockdown ? 'Note (optional)' : 'Reason, for the incident record'} aria-label="Reason" style="flex:1 1 220px" />
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
  const f = await c.req.parseBody();
  const on = f.on === '1';
  const reason = String(f.reason ?? '').trim().slice(0, 300);
  const db = c.env.DB;
  await db.batch([
    db.prepare("INSERT INTO settings (key, value) VALUES ('lockdown', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(on ? '1' : '0'),
    // Signs students out and ends their playback slots, so running videos stop at the next progress check.
    ...(on ? [db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role NOT IN ('admin', 'faculty'))"), db.prepare("DELETE FROM play_tabs WHERE user_id IN (SELECT id FROM users WHERE role NOT IN ('admin', 'faculty'))")] : []),
    // The incident record: when, who and why.
    db.prepare("INSERT INTO staff_alerts (level, kind, user_id, message) VALUES ('critical', ?, ?, ?)").bind(on ? 'lockdown-on' : 'lockdown-off', me.id, on ? `Emergency lockdown turned ON by ${me.name}.${reason ? ' Reason: ' + reason : ''}` : `Emergency lockdown turned OFF by ${me.name}.${reason ? ' Note: ' + reason : ''}`),
  ]);
  await audit(db, { actorId: me.id, action: on ? 'lockdown.on' : 'lockdown.off', detail: reason ? { reason } : null, ip: ip(c) });
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
  const reqRows = (
    await db
      .prepare(`SELECT r.id, r.kind, r.created_at, r.user_id, r.item, u.name, u.email FROM view_requests r JOIN users u ON u.id = r.user_id WHERE r.resolved_at IS NULL ORDER BY r.id`)
      .all<any>()
  ).results;
  const requests = await Promise.all(reqRows.map(async (r: any) => ({ ...r, label: await itemLabel(db, r.item) })));
  const student = email ? await db.prepare('SELECT id, name, email FROM users WHERE email = ?').bind(email).first<{ id: number; name: string; email: string }>() : null;
  const rows = student
    ? await Promise.all(
        (
          await db
            .prepare(
              `SELECT v.item, v.kind, SUM(v.counted) AS used, SUM(CASE WHEN v.counted = 0 AND v.started_at IS NOT NULL THEN 1 ELSE 0 END) AS open,
                      (SELECT COALESCE(SUM(g.extra), 0) FROM view_grants g WHERE g.user_id = v.user_id AND g.item = v.item AND g.kind = v.kind) AS extra
               FROM view_sessions v WHERE v.user_id = ? GROUP BY v.item, v.kind ORDER BY v.item`,
            )
            .bind(student.id)
            .all<any>()
        ).results.map(async (r: any) => ({ ...r, label: await itemLabel(db, r.item) })),
      )
    : [];
  const GrantForm = (p: { userId: number; item: string; kind: string; requestId?: number }) =>
    owner ? (
      <form method="post" action="/admin/views/grant" class="row" style="align-items:flex-end;gap:8px">
        <input type="hidden" name="user_id" value={String(p.userId)} />
        <input type="hidden" name="item" value={p.item} />
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
            <thead><tr><th scope="col">Student</th><th scope="col">Video</th><th scope="col">Asked</th><th scope="col">Decision</th></tr></thead>
            <tbody>
              {requests.map((r: any) => (
                <tr>
                  <td>{r.name}<br /><a class="small" href={`/admin/views?email=${encodeURIComponent(r.email)}`}>{r.email}</a></td>
                  <td>{r.label}</td>
                  <td class="small muted">{String(r.created_at).slice(0, 16)} UTC</td>
                  <td class="stack" style="gap:6px">
                    <GrantForm userId={r.user_id} item={r.item} kind={r.kind} requestId={r.id} />
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
        {student && rows.length === 0 && <p class="muted" style="margin:0">{student.name} hasn’t started any video yet.</p>}
        {student && rows.length > 0 && (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">Video</th><th scope="col">Views used</th><th scope="col">Extra views</th><th scope="col"></th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr>
                  <td>{r.label}<br /><span class="muted small">{r.kind === 'free' ? 'Free' : 'Paid'}{r.open ? ' · a viewing is open' : ''}</span></td>
                  <td>{r.used} of {(r.kind === 'free' ? FREE_VIEWS : PAID_VIEWS) + r.extra}</td>
                  <td>{r.extra}</td>
                  <td><GrantForm userId={student.id} item={r.item} kind={r.kind} /></td>
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
  const userId = Number(f.user_id), item = String(f.item ?? ''), kind = String(f.kind);
  const extra = Math.min(10, Math.max(1, Math.floor(Number(f.extra) || 0)));
  const reason = String(f.reason ?? '').trim().slice(0, 200);
  const bad = (m: string) => c.redirect('/admin/views?error=' + encodeURIComponent(m));
  if (!['free', 'paid'].includes(kind) || !reason) return bad('Please give a reason.');
  if (!parseKey(item) || (kind === 'paid') !== item.startsWith('L:')) return bad('Video not found.');
  const db = c.env.DB;
  const u = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string }>();
  if (!u || !(await titleOf(db, item))) return bad('Student or video not found.');
  const enr = kind === 'paid' ? await db.prepare("SELECT id FROM enrollments WHERE user_id = ? AND status = 'active' ORDER BY paid_at DESC LIMIT 1").bind(userId).first<{ id: number }>() : null;
  if (kind === 'paid' && !enr) return bad('That student has no active program, so paid views can’t be added.');
  await db.batch([
    db.prepare('INSERT INTO view_grants (user_id, item, kind, enrollment_id, extra, reason, granted_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(userId, item, kind, enr?.id ?? null, extra, reason, me.id),
    db.prepare("UPDATE view_requests SET resolved_at = datetime('now'), resolved_by = ?, outcome = 'granted' WHERE user_id = ? AND item = ? AND resolved_at IS NULL").bind(me.id, userId, item),
  ]);
  await audit(db, { actorId: me.id, action: 'views.granted', targetUserId: userId, detail: { item, kind, extra, reason }, ip: ip(c) });
  return c.redirect('/admin/views?ok=1&email=' + encodeURIComponent(u.email));
});

security.post('/views/dismiss', async (c) => {
  const me = c.get('user')!;
  const id = Number((await c.req.parseBody()).request_id);
  const r = await c.env.DB.prepare('SELECT user_id, item FROM view_requests WHERE id = ?').bind(id).first<{ user_id: number; item: string }>();
  await c.env.DB.prepare("UPDATE view_requests SET resolved_at = datetime('now'), resolved_by = ?, outcome = 'declined' WHERE id = ? AND resolved_at IS NULL").bind(me.id, id).run();
  if (r) await audit(c.env.DB, { actorId: me.id, action: 'views.declined', targetUserId: r.user_id, detail: { item: r.item }, ip: ip(c) });
  return c.redirect('/admin/views?ok=1');
});

// ---------- Requests: devices, contact changes, privacy, alerts ----------

security.get('/requests', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const owner = isOwner(me);
  const waiting = (await db.prepare("SELECT COUNT(*) AS n FROM zoom_imports WHERE approved_at IS NULL AND declined_at IS NULL AND status <> 'failed' AND (lecture_id IS NOT NULL OR evening_session_id IS NOT NULL)").first<{ n: number }>())?.n ?? 0;
  const [devices, contacts, privacy, alerts, flags] = await Promise.all([
    db
      .prepare(
        `SELECT d.id, d.user_id, d.label, d.first_seen, d.last_country, u.name, u.email,
                (SELECT COUNT(*) FROM devices x WHERE x.user_id = d.user_id AND x.first_seen > datetime('now', '-30 days') AND (x.status <> 'active' OR x.replaces_id IS NOT NULL)) AS recent
         FROM devices d JOIN users u ON u.id = d.user_id WHERE d.status = 'pending' ORDER BY d.id`,
      )
      .all<any>(),
    db.prepare("SELECT r.id, r.field, r.new_value, r.created_at, u.name, u.email, u.phone FROM contact_change_requests r JOIN users u ON u.id = r.user_id WHERE r.status = 'pending' ORDER BY r.id").all<any>(),
    db.prepare("SELECT r.id, r.kind, r.created_at, u.name, u.email, u.id AS user_id FROM privacy_requests r JOIN users u ON u.id = r.user_id WHERE r.status = 'pending' ORDER BY r.id").all<any>(),
    db.prepare('SELECT a.*, u.name, u.email FROM staff_alerts a LEFT JOIN users u ON u.id = a.user_id WHERE a.resolved_at IS NULL ORDER BY a.id DESC LIMIT 100').all<any>(),
    db.prepare('SELECT f.*, u.name, u.email FROM security_flags f JOIN users u ON u.id = f.user_id WHERE f.reviewed_at IS NULL ORDER BY f.id DESC LIMIT 100').all<any>(),
  ]);
  const actives = new Map<number, any[]>();
  for (const d of devices.results) {
    actives.set(d.user_id, (await db.prepare("SELECT id, label, last_seen, last_country FROM devices WHERE user_id = ? AND status = 'active' ORDER BY last_seen").bind(d.user_id).all<any>()).results);
  }
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: requests" active="admin-requests" user={me} wide>
      <Eyebrow>Admin</Eyebrow>
      <h1>Requests and alerts</h1>
      {c.req.query('ok') && <Flash>{c.req.query('ok')}</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}

      {waiting > 0 && (
        <section class="card row" style="justify-content:space-between;align-items:center">
          <strong>{waiting} class recording{waiting === 1 ? '' : 's'} waiting for approval</strong>
          <a class="btn btn-primary btn-sm" href="/admin/lectures#zoom">Review</a>
        </section>
      )}

      <section class="card stack">
        <h2 style="margin:0">Alerts</h2>
        {alerts.results.length === 0 ? <p class="muted" style="margin:0">No open alerts.</p> : (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">When</th><th scope="col">Alert</th><th scope="col">Student</th><th scope="col"></th></tr></thead>
            <tbody>{alerts.results.map((a: any) => (
              <tr>
                <td class="small muted">{String(a.created_at).slice(0, 16)} UTC</td>
                <td class="small">{a.level === 'critical' ? <strong style="color:#8c2f20">{a.message}</strong> : a.message}</td>
                <td class="small">{a.name ? <a href={`/admin/students/view?email=${encodeURIComponent(a.email)}`}>{a.name}</a> : '—'}</td>
                <td><form method="post" action={`/admin/alerts/${a.id}/resolve`}><button class="btn btn-ghost btn-sm" type="submit">Done</button></form></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {flags.results.length > 0 && (
          <>
            <h3 style="margin:8px 0 0">Flags to review</h3>
            <div class="table-box"><table class="t">
              <thead><tr><th scope="col">When</th><th scope="col">Flag</th><th scope="col">Student</th><th scope="col"></th></tr></thead>
              <tbody>{flags.results.map((f: any) => (
                <tr>
                  <td class="small muted">{String(f.created_at).slice(0, 16)} UTC</td>
                  <td class="small">{FLAG[f.kind] ?? f.kind}<br /><span class="muted">{String(f.detail ?? '').slice(0, 160)}</span></td>
                  <td class="small">{f.name}<br /><span class="muted">{f.email}</span></td>
                  <td class="stack" style="gap:4px">
                    <form method="post" action={`/admin/flags/${f.id}`}><input type="hidden" name="outcome" value="confirmed" /><button class="btn btn-ghost btn-sm" type="submit">Confirmed</button></form>
                    <form method="post" action={`/admin/flags/${f.id}`}><input type="hidden" name="outcome" value="dismissed" /><button class="btn btn-ghost btn-sm" type="submit">False alarm</button></form>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
            <p class="muted small" style="margin:0">“False alarm” stops a sharing flag from counting toward a lock. It doesn’t lift a lock: the owner reinstates accounts on the Security page.</p>
          </>
        )}
      </section>

      <section class="card stack">
        <h2 style="margin:0">New devices waiting for approval</h2>
        <p class="muted small" style="margin:0">Each student may use 2 devices. Approving a new one replaces (signs out and removes) the device you choose. Check the history first, especially when a request repeats within 30 days.</p>
        {devices.results.length === 0 ? <p class="muted" style="margin:0">None.</p> : devices.results.map((d: any) => (
          <form method="post" action={`/admin/requests/device/${d.id}`} class="card stack" style="gap:8px;box-shadow:none;border:1px solid var(--line)">
            <div><strong>{d.name}</strong> <span class="muted small">{d.email}</span></div>
            <div class="small">New: {d.label}{d.last_country ? ` · ${d.last_country}` : ''} · asked {String(d.first_seen).slice(0, 16)} UTC{d.recent >= 2 && <strong style="color:#8c2f20"> · repeated request within 30 days</strong>}</div>
            <label class="field">Replace
              <select name="replace">{(actives.get(d.user_id) ?? []).map((a: any) => <option value={String(a.id)}>{a.label} (last used {String(a.last_seen).slice(0, 10)}{a.last_country ? `, ${a.last_country}` : ''})</option>)}<option value="">Nothing (only if a slot is free)</option></select>
            </label>
            <div class="row">
              <button class="btn btn-primary btn-sm" type="submit" name="decision" value="approve">Approve</button>
              <button class="btn btn-ghost btn-sm" type="submit" name="decision" value="decline">Decline</button>
            </div>
          </form>
        ))}
      </section>

      <section class="card stack">
        <h2 style="margin:0">Email and phone changes</h2>
        {contacts.results.length === 0 ? <p class="muted" style="margin:0">None.</p> : (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">Student</th><th scope="col">Change</th><th scope="col"></th></tr></thead>
            <tbody>{contacts.results.map((r: any) => (
              <tr>
                <td>{r.name}<br /><span class="muted small">{r.email} · {r.phone ?? 'no phone'}</span></td>
                <td class="small">{r.field} → {r.new_value}<br /><span class="muted">asked {String(r.created_at).slice(0, 10)}</span></td>
                <td class="row" style="gap:6px">
                  <form method="post" action={`/admin/requests/contact/${r.id}`}><button class="btn btn-primary btn-sm" type="submit" name="decision" value="approve">Approve</button></form>
                  <form method="post" action={`/admin/requests/contact/${r.id}`}><button class="btn btn-ghost btn-sm" type="submit" name="decision" value="decline">Decline</button></form>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p class="muted small" style="margin:0">Before approving, confirm it’s really the student (for example a call to the phone number on file).</p>
      </section>

      <section class="card stack">
        <h2 style="margin:0">Data copies and account deletions</h2>
        {privacy.results.length === 0 ? <p class="muted" style="margin:0">None.</p> : (
          <div class="table-box"><table class="t">
            <thead><tr><th scope="col">Student</th><th scope="col">Request</th><th scope="col"></th></tr></thead>
            <tbody>{privacy.results.map((r: any) => (
              <tr>
                <td>{r.name}<br /><span class="muted small">{r.email}</span></td>
                <td class="small">{r.kind === 'export' ? 'Copy of their data' : 'Delete their account'} · {String(r.created_at).slice(0, 10)}</td>
                <td class="stack" style="gap:6px">
                  {r.kind === 'export' && <a class="btn btn-outline btn-sm" href={`/admin/requests/privacy/${r.id}/export`}>Download their data (JSON)</a>}
                  {owner ? (
                    <form method="post" action={`/admin/requests/privacy/${r.id}`} class="row" style="gap:6px">
                      <button class="btn btn-primary btn-sm" type="submit" name="decision" value="complete">{r.kind === 'export' ? 'Mark sent' : 'Delete account'}</button>
                      <button class="btn btn-ghost btn-sm" type="submit" name="decision" value="decline">Decline</button>
                    </form>
                  ) : <span class="muted small">The owner decides.</span>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p class="muted small" style="margin:0">Deleting removes the person’s name, email, phone, notes, sign-ins and devices. Payment, enrollment and security records are kept as the law requires, without their contact details.</p>
      </section>
    </PortalLayout>,
  );
});

const FLAG: Record<string, string> = {
  concurrent_stream: 'Lectures played on two devices in different places at once',
  device_replacement_repeat: 'Repeated device replacement within 30 days',
  reported_session: 'Student reported a sign-in they don’t recognise',
  dispute: 'Card payment disputed (chargeback)',
  qbank_scraping: 'Unusual question-bank paging',
  book_scraping: 'Unusual Course Book opening',
};

security.post('/alerts/:id{[0-9]+}/resolve', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  await c.env.DB.prepare("UPDATE staff_alerts SET resolved_at = datetime('now'), resolved_by = ? WHERE id = ?").bind(me.id, Number(c.req.param('id'))).run();
  return c.redirect('/admin/requests');
});

security.post('/flags/:id{[0-9]+}', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const outcome = (await c.req.parseBody()).outcome === 'dismissed' ? 'dismissed' : 'confirmed';
  const f = await c.env.DB.prepare('SELECT user_id, kind FROM security_flags WHERE id = ?').bind(Number(c.req.param('id'))).first<{ user_id: number; kind: string }>();
  await c.env.DB.prepare("UPDATE security_flags SET reviewed_at = datetime('now'), reviewed_by = ?, outcome = ? WHERE id = ?").bind(me.id, outcome, Number(c.req.param('id'))).run();
  if (f) await audit(c.env.DB, { actorId: me.id, action: 'flag.reviewed', targetUserId: f.user_id, detail: { kind: f.kind, outcome }, ip: ip(c) });
  return c.redirect('/admin/requests?ok=' + encodeURIComponent('Saved.'));
});

/** Admin approval for every device replacement (R017). The replaced device is signed out at once. */
security.post('/requests/device/:id{[0-9]+}', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const f = await c.req.parseBody();
  const d = await db.prepare("SELECT id, user_id, label FROM devices WHERE id = ? AND status = 'pending'").bind(Number(c.req.param('id'))).first<{ id: number; user_id: number; label: string }>();
  if (!d) return c.redirect('/admin/requests?error=' + encodeURIComponent('That request was already handled.'));
  if (f.decision === 'decline') {
    await db.prepare("UPDATE devices SET status = 'declined', decided_by = ?, decided_at = datetime('now') WHERE id = ?").bind(me.id, d.id).run();
    await audit(db, { actorId: me.id, action: 'device.declined', targetUserId: d.user_id, detail: { device: d.label }, ip: ip(c) });
    return c.redirect('/admin/requests?ok=' + encodeURIComponent('Declined.'));
  }
  const replace = Number(f.replace) || 0;
  const old = replace ? await db.prepare("SELECT id, device_hash, label FROM devices WHERE id = ? AND user_id = ? AND status = 'active'").bind(replace, d.user_id).first<{ id: number; device_hash: string; label: string }>() : null;
  const active = (await db.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND status = 'active'").bind(d.user_id).first<{ n: number }>())!.n;
  if (!old && active >= 2) return c.redirect('/admin/requests?error=' + encodeURIComponent('Both device slots are in use: choose which device this replaces.'));
  await db.batch([
    ...(old
      ? [
          db.prepare("UPDATE devices SET status = 'removed', decided_by = ?, decided_at = datetime('now') WHERE id = ?").bind(me.id, old.id),
          db.prepare('DELETE FROM sessions WHERE user_id = ? AND device_id = ?').bind(d.user_id, old.device_hash),
        ]
      : []),
    db.prepare("UPDATE devices SET status = 'active', replaces_id = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?").bind(old?.id ?? null, me.id, d.id),
  ]);
  await notify(c.env, d.user_id, { kind: 'device', title: 'New device approved', body: `Your ${d.label} is now registered${old ? ` and replaces your ${old.label}` : ''}. If you didn’t ask for this, contact USMLE100 right away.`, sms: true });
  await audit(db, { actorId: me.id, action: 'device.approved', targetUserId: d.user_id, detail: { device: d.label, replaced: old?.label ?? null }, ip: ip(c) });
  return c.redirect('/admin/requests?ok=' + encodeURIComponent('Approved.'));
});

/** Admin approval for changes to email or phone (R016). */
security.post('/requests/contact/:id{[0-9]+}', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const r = await db.prepare("SELECT * FROM contact_change_requests WHERE id = ? AND status = 'pending'").bind(Number(c.req.param('id'))).first<any>();
  if (!r) return c.redirect('/admin/requests?error=' + encodeURIComponent('That request was already handled.'));
  const approve = (await c.req.parseBody()).decision === 'approve';
  if (approve && r.field === 'email' && (await db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').bind(r.new_value, r.user_id).first())) {
    return c.redirect('/admin/requests?error=' + encodeURIComponent('Another account already uses that email.'));
  }
  await db.batch([
    db.prepare("UPDATE contact_change_requests SET status = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?").bind(approve ? 'approved' : 'declined', me.id, r.id),
    ...(approve
      ? [
          r.field === 'email'
            ? db.prepare('UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?').bind(r.new_value, r.user_id)
            : db.prepare('UPDATE users SET phone = ?, phone_verified_at = NULL WHERE id = ?').bind(r.new_value, r.user_id),
        ]
      : []),
  ]);
  await notify(c.env, r.user_id, {
    kind: 'account',
    title: approve ? `Your ${r.field} was changed` : `Your ${r.field} change was not approved`,
    body: approve ? `Your ${r.field} is now ${r.new_value}. If you didn’t ask for this, contact USMLE100 right away.` : `Please contact USMLE100 if you still need to change your ${r.field}.`,
    sms: true,
  });
  await audit(db, { actorId: me.id, action: approve ? 'contact.approved' : 'contact.declined', targetUserId: r.user_id, detail: { field: r.field }, ip: ip(c) });
  return c.redirect('/admin/requests?ok=' + encodeURIComponent(approve ? 'Changed.' : 'Declined.'));
});

/** Everything stored about one person, for a data-copy request (protected course content is not included). */
security.get('/requests/privacy/:id{[0-9]+}/export', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const r = await db.prepare('SELECT user_id FROM privacy_requests WHERE id = ?').bind(Number(c.req.param('id'))).first<{ user_id: number }>();
  if (!r) return c.notFound();
  const uid = r.user_id;
  const q = (sql: string) => db.prepare(sql).bind(uid).all().then((x) => x.results);
  const data = {
    account: await db.prepare('SELECT id, email, name, first_name, last_name, phone, exam, exam_date, grad_year, created_at, marketing_opt_in, marketing_consent_at, marketing_consent_text, signup_source, birth_date FROM users WHERE id = ?').bind(uid).first(),
    enrollments: await q('SELECT id, package_id, status, amount_cents, paid_at, cohort_id, lectures_until FROM enrollments WHERE user_id = ?'),
    course_book_purchases: await q('SELECT id, status, amount_cents, paid_at, refunded_at FROM book_purchases WHERE user_id = ?'),
    agreement_signatures: await q('SELECT agreement_id, legal_name, birth_date, signed_at, ip FROM agreement_signatures WHERE user_id = ?'),
    devices: await q('SELECT label, status, first_seen, last_seen, last_country FROM devices WHERE user_id = ?'),
    lecture_progress: await q('SELECT lecture_id, completed_at FROM lecture_progress WHERE user_id = ?'),
    lecture_views: await q('SELECT item, kind, started_at, counted, counted_reason FROM view_sessions WHERE user_id = ?'),
    test_answers: await q('SELECT t.id AS test, ti.question_id, ti.chosen, ti.correct FROM tests t JOIN test_items ti ON ti.test_id = t.id WHERE t.user_id = ?').catch(() => []),
    notes: await q('SELECT id, title, created_at FROM notes WHERE user_id = ?').catch(() => []),
    security_log: await q('SELECT at, action, ip FROM audit_log WHERE target_user_id = ? ORDER BY id'),
  };
  await audit(db, { actorId: me.id, action: 'privacy.exported', targetUserId: uid, ip: ip(c) });
  c.header('Content-Disposition', `attachment; filename="usmle100-data-${uid}.json"`);
  c.header('Cache-Control', 'no-store');
  return c.json(data);
});

/** Owner only (OWNER_ONLY): complete or decline a privacy request. Deletion anonymises the account. */
security.post('/requests/privacy/:id{[0-9]+}', async (c) => {
  const me = c.get('user')!;
  const db = c.env.DB;
  const r = await db.prepare("SELECT * FROM privacy_requests WHERE id = ? AND status = 'pending'").bind(Number(c.req.param('id'))).first<any>();
  if (!r) return c.redirect('/admin/requests?error=' + encodeURIComponent('That request was already handled.'));
  const complete = (await c.req.parseBody()).decision === 'complete';
  const target = await db.prepare('SELECT is_owner, role FROM users WHERE id = ?').bind(r.user_id).first<{ is_owner: number; role: string }>();
  if (complete && r.kind === 'deletion' && (target?.is_owner || target?.role !== 'student')) return c.redirect('/admin/requests?error=' + encodeURIComponent('Staff accounts can’t be deleted here.'));
  const uid = r.user_id;
  await db.batch([
    db.prepare("UPDATE privacy_requests SET status = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?").bind(complete ? 'completed' : 'declined', me.id, r.id),
    ...(complete && r.kind === 'deletion'
      ? [
          db.prepare(
            `UPDATE users SET email = 'deleted-' || id || '@deleted.invalid', name = 'Deleted student', first_name = NULL, last_name = NULL, phone = NULL,
               birth_date = NULL, marketing_opt_in = 0, password_hash = 'deleted', password_salt = 'deleted', status = 'suspended', status_reason = 'Account deleted at the student’s request.' WHERE id = ?`,
          ).bind(uid),
          db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid),
          db.prepare('DELETE FROM devices WHERE user_id = ?').bind(uid),
          db.prepare('DELETE FROM play_tabs WHERE user_id = ?').bind(uid),
          db.prepare('DELETE FROM notices WHERE user_id = ?').bind(uid),
        ]
      : []),
  ]);
  if (complete && r.kind === 'deletion') await db.prepare('DELETE FROM notes WHERE user_id = ?').bind(uid).run().catch(() => {});
  await audit(db, { actorId: me.id, action: complete ? `privacy.${r.kind}_completed` : `privacy.${r.kind}_declined`, targetUserId: uid, ip: ip(c) });
  return c.redirect('/admin/requests?ok=' + encodeURIComponent('Done.'));
});
