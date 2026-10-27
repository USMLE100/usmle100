import { notify } from '../lib/messaging';
import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { isOwner } from '../lib/types';
import { requireAdminOrFacultyAllowed } from '../lib/auth';
import { audit } from '../lib/audit';
import { toCsv } from '../lib/csv';
import { PortalLayout, Eyebrow, Flash } from '../views/layout';
import { deviceLabel } from '../lib/devices';
import { itemLabel } from '../lib/viewing';
import { money } from '../lib/content';
import { fulfil, retrieveCheckoutSession } from '../lib/stripe';

/**
 * Admin → Students directory: every account with search and filters, a CSV export (admin only: personal data),
 * one student's full picture, and the owner's "give this student a program" (R164: owner authorises
 * complimentary access and enrollment adjustments; logged).
 */
export const studentsAdmin = new Hono<AppEnv>();
studentsAdmin.use('*', requireAdminOrFacultyAllowed);

const FILTERS: Record<string, { label: string; where: string }> = {
  all: { label: 'Everyone', where: "u.role = 'student'" },
  paid: { label: 'Paid program', where: "u.role = 'student' AND EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = u.id AND e.status = 'active')" },
  unpaid: { label: 'No program', where: "u.role = 'student' AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = u.id AND e.status = 'active')" },
  refunded: { label: 'Refunded', where: "u.role = 'student' AND EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = u.id AND e.status = 'refunded')" },
  free: { label: 'Signed up for free lectures', where: "u.role = 'student' AND u.signup_source = 'free-lectures'" },
  marketing: { label: 'Agreed to marketing', where: "u.role = 'student' AND u.marketing_opt_in = 1" },
  flagged: { label: 'Warned or suspended', where: "u.role = 'student' AND u.status <> 'active'" },
};

function query(filter: string, q: string) {
  const f = FILTERS[filter] ?? FILTERS.all;
  const like = `%${q.toLowerCase()}%`;
  return {
    sql: `SELECT u.id, u.name, u.email, u.phone, u.exam, u.grad_year, u.created_at, u.status, u.marketing_opt_in, u.signup_source,
                 (SELECT p.name FROM enrollments e JOIN packages p ON p.id = e.package_id WHERE e.user_id = u.id AND e.status = 'active' ORDER BY e.paid_at DESC LIMIT 1) AS program
          FROM users u WHERE ${f.where} AND (? = '' OR LOWER(u.email) LIKE ? OR LOWER(u.name) LIKE ? OR COALESCE(u.phone, '') LIKE ?)
          ORDER BY u.created_at DESC`,
    binds: [q, like, like, like],
  };
}

studentsAdmin.get('/students/directory', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const filter = FILTERS[c.req.query('f') ?? ''] ? c.req.query('f')! : 'all';
  const q = String(c.req.query('q') ?? '').trim().slice(0, 100);
  const { sql, binds } = query(filter, q);
  const rows = (await c.env.DB.prepare(sql + ' LIMIT 300').bind(...binds).all<any>()).results;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: all students" active="admin-students" user={me} wide>
      <Eyebrow>Admin · Students</Eyebrow>
      <h1>All students</h1>
      <form method="get" action="/admin/students/directory" class="card row" style="align-items:flex-end">
        <label class="field" style="flex:2 1 220px">Search name, email or phone<input type="search" name="q" value={q} /></label>
        <label class="field" style="flex:1 1 200px">Show<select name="f">{Object.entries(FILTERS).map(([k, v]) => <option value={k} selected={k === filter}>{v.label}</option>)}</select></label>
        <button class="btn btn-outline" type="submit">Find</button>
        <a class="btn btn-ghost" href={`/admin/students/export.csv?f=${filter}&q=${encodeURIComponent(q)}`}>Download CSV</a>
      </form>
      <p class="muted small">{rows.length === 300 ? 'Showing the newest 300. Search to narrow down.' : `${rows.length} found.`}</p>
      <div class="table-box"><table class="t">
        <thead><tr><th scope="col">Student</th><th scope="col">Program</th><th scope="col">Details</th><th scope="col">Joined</th></tr></thead>
        <tbody>
          {rows.map((r: any) => (
            <tr>
              <td><a href={`/admin/students/view?email=${encodeURIComponent(r.email)}`}>{r.name}</a><br /><span class="muted small">{r.email}{r.phone ? ` · ${r.phone}` : ''}</span>{r.status !== 'active' && <><br /><span class="chip chip-rust">{r.status}</span></>}</td>
              <td class="small">{r.program ?? <span class="muted">—</span>}</td>
              <td class="small">{[r.exam, r.grad_year && `Class of ${r.grad_year}`, r.marketing_opt_in ? 'Marketing: yes' : null, r.signup_source].filter(Boolean).join(' · ')}</td>
              <td class="small muted">{String(r.created_at).slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </PortalLayout>,
  );
});

/** Admin only (personal data); every download is logged. Only the columns needed for running the courses. */
studentsAdmin.get('/students/export.csv', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const filter = FILTERS[c.req.query('f') ?? ''] ? c.req.query('f')! : 'all';
  const { sql, binds } = query(filter, String(c.req.query('q') ?? '').trim().slice(0, 100));
  const rows = (await c.env.DB.prepare(sql).bind(...binds).all<any>()).results;
  await audit(c.env.DB, { actorId: me.id, action: 'export.students', detail: { filter, rows: rows.length }, ip: c.req.header('cf-connecting-ip') ?? null });
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="usmle100-students-${filter}.csv"`);
  c.header('Cache-Control', 'no-store');
  return c.body(
    toCsv([
      ['Name', 'Email', 'Phone', 'Exam', 'Graduation year', 'Program', 'Marketing opt-in', 'Signed up via', 'Joined', 'Status'],
      ...rows.map((r: any) => [r.name, r.email, r.phone, r.exam, r.grad_year, r.program, r.marketing_opt_in ? 'yes' : 'no', r.signup_source, String(r.created_at).slice(0, 10), r.status]),
    ]),
  );
});

studentsAdmin.get('/students/view', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const email = String(c.req.query('email') ?? '').trim().toLowerCase();
  const u = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<any>();
  if (!u) return c.html(<PortalLayout shell={c.get('shell')} title="Student" active="admin-students" user={me}><Flash kind="error">No account uses {email}.</Flash><a href="/admin/students/directory">Back</a></PortalLayout>, 404);
  const passkeyCount = (await db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').bind(u.id).first<{ n: number }>())?.n ?? 0;
  const [enr, book, evening, devices, sessions, views, signed, packages, cohorts, log] = await Promise.all([
    db.prepare('SELECT e.*, p.name AS package_name, c.name AS cohort FROM enrollments e JOIN packages p ON p.id = e.package_id LEFT JOIN cohorts c ON c.id = e.cohort_id WHERE e.user_id = ? ORDER BY e.id DESC').bind(u.id).all<any>(),
    db.prepare('SELECT note, created_at FROM book_access WHERE user_id = ?').bind(u.id).first<any>().catch(() => null),
    db.prepare('SELECT start_date, months FROM evening_subscriptions WHERE user_id = ? ORDER BY start_date DESC LIMIT 5').bind(u.id).all<any>().catch(() => ({ results: [] as any[] })),
    db.prepare('SELECT label, status, first_seen, last_seen, last_country FROM devices WHERE user_id = ? ORDER BY id').bind(u.id).all<any>(),
    db.prepare('SELECT created_at, last_seen_at, ip, country, user_agent FROM sessions WHERE user_id = ?').bind(u.id).all<any>(),
    db.prepare('SELECT item, kind, SUM(counted) AS used FROM view_sessions WHERE user_id = ? GROUP BY item, kind ORDER BY item').bind(u.id).all<any>(),
    db.prepare('SELECT a.title, s.signed_at, s.legal_name FROM agreement_signatures s JOIN agreements a ON a.id = s.agreement_id WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 1').bind(u.id).first<any>(),
    db.prepare('SELECT id, name FROM packages ORDER BY sort').all<any>(),
    db.prepare('SELECT id, name FROM cohorts ORDER BY start_date DESC').all<any>(),
    db.prepare('SELECT at, action, detail FROM audit_log WHERE target_user_id = ? ORDER BY id DESC LIMIT 30').bind(u.id).all<any>(),
  ]);
  const viewRows = await Promise.all(views.results.map(async (v: any) => ({ ...v, label: await itemLabel(db, v.item) })));
  const owner = isOwner(me);
  return c.html(
    <PortalLayout shell={c.get('shell')} title={`Admin: ${u.name}`} active="admin-students" user={me} wide>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/admin/students/directory">All students</a></nav>
      <Eyebrow>Student #{u.id}</Eyebrow>
      <h1>{u.name}</h1>
      {c.req.query('ok') && <Flash>{c.req.query('ok')}</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <section class="card stack">
        <p style="margin:0">{u.email} · {u.phone ?? 'no phone'} · {u.exam ?? 'exam not set'}{u.grad_year ? ` · class of ${u.grad_year}` : ''}</p>
        <p class="small muted" style="margin:0">
          Joined {String(u.created_at).slice(0, 10)} via {u.signup_source ?? 'sign-up'} · status <strong>{u.status}</strong>{u.status_reason ? ` (${u.status_reason})` : ''} · marketing {u.marketing_opt_in ? `yes since ${String(u.marketing_consent_at).slice(0, 10)}` : 'no'}
          {signed ? ` · agreement signed ${String(signed.signed_at).slice(0, 10)} as “${signed.legal_name}”` : ' · agreement not signed'}
        </p>
        <div class="row">
          <a class="btn btn-ghost btn-sm" href={`/admin/views?email=${encodeURIComponent(u.email)}`}>Lecture views</a>
          <a class="btn btn-ghost btn-sm" href={`/admin/security?q=${encodeURIComponent(u.email)}`}>Security log</a>
          <form method="post" action="/admin/reset-link"><input type="hidden" name="email" value={u.email} /><button class="btn btn-ghost btn-sm" type="submit">Make reset link</button></form>
          <form method="post" action={`/admin/students/${u.id}/sign-out`}><button class="btn btn-ghost btn-sm" type="submit">Sign out everywhere</button></form>
        </div>
      </section>

      <section class="card stack">
        <h2 style="margin:0">Programs and purchases</h2>
        {enr.results.length === 0 ? <p class="muted" style="margin:0">No program.</p> : (
          <ul class="stack" style="gap:4px;margin:0;padding-left:18px">
            {enr.results.map((e: any) => <li class="small">{e.package_name} · {e.status}{e.cohort ? ` · ${e.cohort}` : ''}{e.amount_cents != null ? ` · ${money(e.amount_cents)}` : ''}{e.paid_at ? ` · ${String(e.paid_at).slice(0, 10)}` : ''}{e.note ? ` · ${e.note}` : ''}</li>)}
          </ul>
        )}
        <p class="small" style="margin:0">Course Book: {book ? `yes (${book.note ?? 'given'})` : 'no'} · Evening Questions: {evening.results.length ? evening.results.map((x: any) => `${x.start_date} (${x.months} mo)`).join(', ') : 'no'}</p>
        {owner ? (
          <form method="post" action={`/admin/students/${u.id}/give-program`} class="row" style="align-items:flex-end">
            <label class="field" style="flex:1 1 160px">Give a program<select name="package">{packages.results.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></label>
            <label class="field" style="flex:1 1 160px">Cohort<select name="cohort">{cohorts.results.map((x: any) => <option value={String(x.id)}>{x.name}</option>)}</select></label>
            <label class="field" style="flex:2 1 200px">Reason<input type="text" name="reason" required maxlength={200} placeholder="e.g. paid by bank transfer" /></label>
            <button class="btn btn-outline" type="submit">Give</button>
          </form>
        ) : (
          <p class="muted small" style="margin:0">Only the owner can give a program.</p>
        )}
      </section>

      <section class="card stack">
        <h2 style="margin:0">Devices and sign-ins</h2>
        <ul class="stack" style="gap:4px;margin:0;padding-left:18px">
          {devices.results.map((d: any) => <li class="small">{d.label} · {d.status} · first {String(d.first_seen).slice(0, 10)} · last {String(d.last_seen).slice(0, 10)}{d.last_country ? ` · ${d.last_country}` : ''}</li>)}
          {sessions.results.map((s: any) => <li class="small muted">Signed in: {deviceLabel(s.user_agent ?? '')} · {[s.country, s.ip].filter(Boolean).join(' · ')}</li>)}
        </ul>
        {u.role === 'student' && passkeyCount > 0 && (
          <form method="post" action={`/admin/students/${u.id}/passkeys/clear`} class="row" style="align-items:center;gap:8px">
            <span class="small">{passkeyCount} passkey{passkeyCount === 1 ? '' : 's'}. If the student lost the device(s) and you’ve checked it’s really them, remove them; their password still works.</span>
            <button class="btn btn-ghost btn-sm" type="submit">Remove passkeys</button>
          </form>
        )}
      </section>

      <section class="card stack">
        <h2 style="margin:0">Views used</h2>
        {viewRows.length === 0 ? <p class="muted" style="margin:0">None yet.</p> : <ul class="stack" style="gap:4px;margin:0;padding-left:18px">{viewRows.map((v: any) => <li class="small">{v.label}: {v.used} ({v.kind})</li>)}</ul>}
      </section>

      <section class="card stack">
        <h2 style="margin:0">Recent activity</h2>
        <ul class="stack" style="gap:2px;margin:0;padding-left:18px">{log.results.map((l: any) => <li class="small"><span class="muted">{String(l.at).slice(0, 16).replace('T', ' ')}</span> {l.action}</li>)}</ul>
      </section>
    </PortalLayout>,
  );
});

studentsAdmin.post('/students/:uid{[0-9]+}/sign-out', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const uid = Number(c.req.param('uid'));
  const u = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(uid).first<{ email: string }>();
  if (!u) return c.notFound();
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid), c.env.DB.prepare('DELETE FROM play_tabs WHERE user_id = ?').bind(uid)]);
  await audit(c.env.DB, { actorId: me.id, action: 'sessions.revoked_by_admin', targetUserId: uid, ip: c.req.header('cf-connecting-ip') ?? null });
  return c.redirect(`/admin/students/view?email=${encodeURIComponent(u.email)}&ok=${encodeURIComponent('Signed out everywhere.')}`);
});

/** Owner only (OWNER_ONLY): complimentary or offline-paid program, recorded with its reason. */
studentsAdmin.post('/students/:uid{[0-9]+}/give-program', async (c) => {
  const me = c.get('user')!;
  const db = c.env.DB;
  const uid = Number(c.req.param('uid'));
  const f = await c.req.parseBody();
  const u = await db.prepare("SELECT email FROM users WHERE id = ? AND role = 'student'").bind(uid).first<{ email: string }>();
  const pkg = await db.prepare('SELECT id FROM packages WHERE id = ?').bind(String(f.package ?? '')).first<{ id: string }>();
  const cohort = await db.prepare('SELECT id FROM cohorts WHERE id = ?').bind(Number(f.cohort) || 0).first<{ id: number }>();
  const reason = String(f.reason ?? '').trim().slice(0, 200);
  const back = (msg: string, err = false) => c.redirect(`/admin/students/view?email=${encodeURIComponent(u?.email ?? '')}&${err ? 'error' : 'ok'}=${encodeURIComponent(msg)}`);
  if (!u || !pkg || !cohort) return back('Choose a program and a cohort.', true);
  if (!reason) return back('Please give a reason.', true);
  if (await db.prepare("SELECT 1 FROM enrollments WHERE user_id = ? AND status = 'active'").bind(uid).first()) return back('This student already has an active program.', true);
  await db.prepare("INSERT INTO enrollments (user_id, package_id, status, paid_at, amount_cents, cohort_id, note) VALUES (?, ?, 'active', datetime('now'), 0, ?, ?)").bind(uid, pkg.id, cohort.id, `Given by the owner: ${reason}`).run();
  await audit(db, { actorId: me.id, action: 'access.program_given', targetUserId: uid, detail: { package: pkg.id, cohort: cohort.id, reason }, ip: c.req.header('cf-connecting-ip') ?? null });
  return back('Program given.');
});

// ---------- Payments check: Stripe vs enrollments (owner decision: reconciliation, owner approves retries) ----------

type Problem = { kind: string; detail: string; who?: string; session?: string };

/** Local consistency checks that need no Stripe access. */
export async function localProblems(db: D1Database): Promise<Problem[]> {
  const out: Problem[] = [];
  const q = (sql: string) => db.prepare(sql).all<any>().then((r) => r.results);
  for (const r of await q(`SELECT b.id, u.email FROM book_purchases b JOIN users u ON u.id = b.user_id
      WHERE b.status = 'paid' AND NOT EXISTS (SELECT 1 FROM book_access a WHERE a.user_id = b.user_id)
      AND NOT EXISTS (SELECT 1 FROM stripe_disputes d WHERE d.book_purchase_id = b.id AND d.closed_at IS NULL)`))
    out.push({ kind: 'Course Book paid, but no access', detail: `purchase ${r.id}`, who: r.email });
  for (const r of await q(`SELECT a.user_id, a.note, u.email FROM book_access a JOIN users u ON u.id = a.user_id
      WHERE a.note LIKE 'Bought online · purchase %' AND NOT EXISTS (SELECT 1 FROM book_purchases b WHERE b.user_id = a.user_id AND b.status = 'paid')`))
    out.push({ kind: 'Course Book access without a paid purchase', detail: r.note, who: r.email });
  for (const r of await q(`SELECT e.id, u.email, e.amount_cents FROM enrollments e JOIN users u ON u.id = e.user_id
      WHERE e.status = 'active' AND (e.amount_cents IS NULL OR e.amount_cents = 0) AND COALESCE(e.note, '') = ''`))
    out.push({ kind: 'Active program with no payment and no reason', detail: `enrollment ${r.id}`, who: r.email });
  for (const r of await q(`SELECT e.id, u.email FROM enrollments e JOIN users u ON u.id = e.user_id
      WHERE e.status = 'active' AND e.stripe_session_id IS NOT NULL AND e.paid_at IS NULL`))
    out.push({ kind: 'Active program without a payment time', detail: `enrollment ${r.id}`, who: r.email });
  for (const r of await q(`SELECT e.id, u.email FROM enrollments e JOIN users u ON u.id = e.user_id
      WHERE e.status = 'pending' AND e.created_at < datetime('now', '-2 days') AND e.stripe_session_id IS NOT NULL`))
    out.push({ kind: 'Checkout started but never paid (usually abandoned)', detail: `enrollment ${r.id}`, who: r.email });
  return out;
}

studentsAdmin.get('/payments', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const problems = await localProblems(db);
  // With Stripe connected: paid Checkout Sessions from the last 30 days that never activated anything.
  const unfulfilled: Problem[] = [];
  let stripeNote = 'Stripe isn’t connected yet, so only the site’s own records were checked.';
  if (c.env.STRIPE_SECRET_KEY && c.req.query('stripe') === '1') {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions?limit=100&status=complete&created[gte]=${since}`, { headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` } });
    if (!res.ok) stripeNote = `Stripe couldn’t be reached (error ${res.status}).`;
    else {
      const sessions = ((await res.json()) as { data?: any[] }).data ?? [];
      stripeNote = `Checked ${sessions.length} paid Stripe checkouts from the last 30 days.`;
      for (const s of sessions) {
        if (s.payment_status !== 'paid' || !s.client_reference_id) continue;
        const ref = String(s.client_reference_id);
        const book = /^book-(\d+)$/.exec(ref);
        const ok = book
          ? await db.prepare("SELECT 1 FROM book_purchases WHERE id = ? AND status IN ('paid', 'refunded')").bind(Number(book[1])).first()
          : await db.prepare("SELECT 1 FROM enrollments WHERE id = ? AND status IN ('active', 'refunded')").bind(Number(ref) || 0).first();
        if (!ok) unfulfilled.push({ kind: 'Paid in Stripe, not activated here', detail: `${ref} · ${(s.amount_total / 100).toFixed(2)} ${String(s.currency).toUpperCase()}`, who: s.customer_details?.email ?? s.customer_email ?? '', session: s.id });
      }
    }
  }
  const owner = isOwner(me);
  const Rows = (p: { list: Problem[] }) => (
    <div class="table-box"><table class="t">
      <thead><tr><th scope="col">What</th><th scope="col">Record</th><th scope="col">Student</th><th scope="col"></th></tr></thead>
      <tbody>{p.list.map((x) => (
        <tr>
          <td class="small">{x.kind}</td><td class="small">{x.detail}</td><td class="small">{x.who}</td>
          <td>{x.session && owner && <form method="post" action="/admin/payments/fulfil"><input type="hidden" name="session" value={x.session} /><button class="btn btn-primary btn-sm" type="submit">Activate now</button></form>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: payments check" active="admin-payments" user={me} wide>
      <Eyebrow>Admin</Eyebrow>
      <h1>Payments check</h1>
      {c.req.query('ok') && <Flash>{c.req.query('ok')}</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <p class="muted">Compares what was paid with what the site gave. Run it after any outage or restore from backup, and before reopening (owner decision on reconciliation).</p>
      <section class="card stack">
        <h2 style="margin:0">Site records</h2>
        {problems.length === 0 ? <Flash>Everything matches.</Flash> : <Rows list={problems} />}
      </section>
      <section class="card stack">
        <h2 style="margin:0">Stripe</h2>
        <p class="small" style="margin:0">{stripeNote}</p>
        {c.env.STRIPE_SECRET_KEY && c.req.query('stripe') !== '1' && <a class="btn btn-outline btn-sm" href="/admin/payments?stripe=1" style="align-self:flex-start">Check against Stripe</a>}
        {unfulfilled.length > 0 && <Rows list={unfulfilled} />}
        {c.req.query('stripe') === '1' && unfulfilled.length === 0 && c.env.STRIPE_SECRET_KEY && <Flash>Every paid checkout was activated.</Flash>}
        <p class="muted small" style="margin:0">“Activate now” re-checks the payment with Stripe and applies it exactly as the normal payment confirmation would (owner only).</p>
      </section>
    </PortalLayout>,
  );
});

/** Owner only (OWNER_ONLY): retry fulfilment of a paid session after confirming it with Stripe. */
studentsAdmin.post('/payments/fulfil', async (c) => {
  const me = c.get('user')!;
  const sid = String((await c.req.parseBody()).session ?? '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid) || !c.env.STRIPE_SECRET_KEY) return c.redirect('/admin/payments?error=' + encodeURIComponent('Not a Stripe checkout.'));
  const s = await retrieveCheckoutSession(c.env, sid);
  if (!s || s.payment_status !== 'paid') return c.redirect('/admin/payments?error=' + encodeURIComponent('Stripe says that checkout is not paid.'));
  await fulfil(c.env.DB, s);
  await audit(c.env.DB, { actorId: me.id, action: 'payment.manual_fulfil', detail: { session: sid, ref: s.client_reference_id }, ip: c.req.header('cf-connecting-ip') ?? null });
  return c.redirect('/admin/payments?stripe=1&ok=' + encodeURIComponent('Applied.'));
});

/** Lost-passkey recovery (p155): an admin removes a student's passkeys after checking who they are. Logged; the student is told. */
studentsAdmin.post('/students/:id{[0-9]+}/passkeys/clear', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const u = await db.prepare("SELECT email FROM users WHERE id = ? AND role = 'student'").bind(id).first<{ email: string }>();
  if (!u) return c.notFound();
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND passkey_id IS NOT NULL').bind(id),
    db.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(id),
  ]);
  await audit(db, { actorId: me.id, action: 'passkey.cleared_by_admin', targetUserId: id, ip: c.req.header('cf-connecting-ip') ?? null });
  await notify(c.env, id, { kind: 'security', title: 'Your passkeys were removed', body: 'USMLE100 removed the passkeys on your account at your request. Sign in with your password. If you didn’t ask for this, contact USMLE100 right away.', sms: true });
  return c.redirect('/admin/students/view?email=' + encodeURIComponent(u.email));
});
