import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { isOwner, isStaff } from '../lib/types';
import { requireAdminOrFacultyAllowed, requireUser } from '../lib/auth';
import { audit } from '../lib/audit';
import { notify } from '../lib/messaging';
import { PortalLayout, Eyebrow, Flash } from '../views/layout';
import { compensate, examWithin48h, expeditedDue, initialDue, iso, parseIso, addBusinessDays } from '../lib/cases';
import { itemLabel, parseKey } from '../lib/viewing';

/** Students: appeal a restriction or dispute a used lecture view. Staff: review, recommend; the owner decides. */
export const casesStudent = new Hono<AppEnv>();
export const casesAdmin = new Hono<AppEnv>();
casesAdmin.use('*', requireAdminOrFacultyAllowed);

const ip = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? null;
const KIND: Record<string, string> = { appeal: 'Appeal', 'view-dispute': 'View dispute' };
const when = (s: string | null) => (s ? String(s).slice(0, 16).replace('T', ' ') + ' UTC' : '');
const statusText = (c: any) => (c.status === 'decided' ? (c.decision === 'granted' ? 'Decided: granted' : 'Decided: not granted') : c.status === 'reviewed' ? 'Reviewed, awaiting decision' : 'Open');

// ---------- Student ----------

casesStudent.get('/account/appeals', requireUser, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const [cases, msgs, used] = await Promise.all([
    db.prepare('SELECT * FROM cases WHERE user_id = ? ORDER BY id DESC').bind(user.id).all<any>(),
    db.prepare('SELECT m.case_id, m.body, m.created_at FROM case_messages m JOIN cases k ON k.id = m.case_id WHERE k.user_id = ? AND m.to_student = 1 ORDER BY m.id').bind(user.id).all<any>(),
    db.prepare('SELECT DISTINCT item FROM view_sessions WHERE user_id = ? AND counted = 1').bind(user.id).all<{ item: string }>(),
  ]);
  const items = await Promise.all(used.results.map(async (r) => ({ key: r.item, label: await itemLabel(db, r.item) })));
  const Layout = (p: { children: any }) =>
    user.status === 'suspended' ? (
      <main class="wrap page" style="max-width:720px;padding-top:32px;padding-bottom:64px">{p.children}</main>
    ) : (
      <PortalLayout shell={c.get('shell')} title="Appeals and disputes" active="account" user={user}>{p.children}</PortalLayout>
    );
  const page = (
    <Layout>
      <Eyebrow>My account</Eyebrow>
      <h1>Appeals and disputes</h1>
      {c.req.query('ok') && <Flash>Sent. We’ll keep you updated here and by email.</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <p class="muted">If you believe a restriction on your account or a used lecture view was a mistake, tell us here. A USMLE100 administrator reviews it and the owner makes the final decision. Restrictions stay in place while we review.</p>
      {cases.results.map((k: any) => (
        <section class="card stack">
          <div class="row" style="justify-content:space-between"><strong>{KIND[k.kind]} #{k.id}</strong><span class="chip chip-sand">{statusText(k)}</span></div>
          <p class="small muted" style="margin:0">Sent {when(k.created_at)}{k.status !== 'decided' && <> · {k.kind === 'view-dispute' ? 'Decision expected by' : 'Next update by'} {when(k.due_at)}</>}</p>
          <p style="margin:0">{k.statement}</p>
          {msgs.results.filter((m: any) => m.case_id === k.id).map((m: any) => (
            <p class="small" style="margin:0;padding:8px 12px;background:#f4f3ef;border-radius:8px"><strong>USMLE100 · {when(m.created_at)}</strong><br />{m.body}</p>
          ))}
          {k.status === 'decided' && k.decision_reason && <p class="small" style="margin:0"><strong>Decision:</strong> {k.decision_reason}</p>}
          {k.status === 'decided' && k.decision === 'denied' && k.kind === 'appeal' && <p class="small muted" style="margin:0">If you have important new evidence, you can send a new appeal below; it is reviewed within 3 business days.</p>}
        </section>
      ))}
      <section class="card stack">
        <h2 style="margin:0">Send a new request</h2>
        <form method="post" action="/account/appeals" class="stack" style="gap:12px">
          <label class="field">What is it about?
            <select name="kind" required>
              <option value="appeal">A restriction on my account (warning, lock, suspension or blocked device)</option>
              {items.length > 0 && <option value="view-dispute">A lecture view that was used by mistake</option>}
            </select>
          </label>
          {items.length > 0 && (
            <label class="field">Which video? (for a view dispute)
              <select name="item"><option value="">—</option>{items.map((i) => <option value={i.key}>{i.label}</option>)}</select>
            </label>
          )}
          <label class="field">Explain what happened<textarea name="statement" rows={5} required minlength={20} maxlength={4000}></textarea></label>
          <label class="check"><input type="checkbox" name="new_evidence" value="1" /> I have important new evidence for an earlier appeal</label>
          <label class="field">Exam date, if your exam is within the next 48 hours (for a view dispute)<input type="date" name="exam_date" /></label>
          <p class="muted small" style="margin:0">To support an exam date, email us a copy of your exam confirmation. You may hide everything except your name and the date. We delete it within 24 hours after checking it.</p>
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">Send</button>
        </form>
      </section>
      {user.status === 'suspended' && <form method="post" action="/sign-out"><button class="btn btn-ghost" type="submit">Sign out</button></form>}
    </Layout>
  );
  return c.html(user.status === 'suspended' ? <html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Appeals · USMLE100</title><link rel="stylesheet" href="/styles.css" /></head><body>{page}</body></html> : page);
});

casesStudent.post('/account/appeals', requireUser, async (c) => {
  const user = c.get('user')!;
  if (isStaff(user)) return c.redirect('/account');
  const db = c.env.DB;
  const f = await c.req.parseBody();
  const kind = f.kind === 'view-dispute' ? 'view-dispute' : 'appeal';
  const statement = String(f.statement ?? '').trim().slice(0, 4000);
  const bad = (m: string) => c.redirect('/account/appeals?error=' + encodeURIComponent(m));
  if (statement.length < 20) return bad('Please explain what happened in a few sentences.');
  let item: string | null = null;
  if (kind === 'view-dispute') {
    item = parseKey(f.item) ? String(f.item) : null;
    if (!item || !(await db.prepare('SELECT 1 FROM view_sessions WHERE user_id = ? AND item = ? AND counted = 1').bind(user.id, item).first())) return bad('Choose the video whose view you want to dispute.');
    if (await db.prepare("SELECT 1 FROM cases WHERE user_id = ? AND item = ? AND status <> 'decided'").bind(user.id, item).first()) return bad('You already have an open dispute for that video.');
  } else if (await db.prepare("SELECT 1 FROM cases WHERE user_id = ? AND kind = 'appeal' AND status <> 'decided'").bind(user.id).first()) {
    return bad('You already have an open appeal. Add details by replying to our email or wait for our update.');
  }
  // At most 5 requests a day, so the queue can't be flooded.
  if (((await db.prepare("SELECT COUNT(*) AS n FROM cases WHERE user_id = ? AND created_at > datetime('now', '-1 day')").bind(user.id).first<{ n: number }>())?.n ?? 0) >= 5) return bad('Please wait a day before sending another request.');
  const examDate = String(f.exam_date ?? '');
  const expedite = kind === 'view-dispute' && examWithin48h(examDate);
  const newEvidence = kind === 'appeal' && f.new_evidence === '1';
  const due = initialDue(kind, newEvidence);
  const r = await db
    .prepare('INSERT INTO cases (user_id, kind, item, statement, exam_date, expedite_requested, new_evidence, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(user.id, kind, item, statement, /^\d{4}-\d{2}-\d{2}$/.test(examDate) ? examDate : null, expedite ? 1 : 0, newEvidence ? 1 : 0, iso(due))
    .run();
  const id = Number(r.meta.last_row_id);
  await db
    .prepare('INSERT INTO staff_alerts (level, kind, user_id, message) VALUES (?, ?, ?, ?)')
    .bind(expedite || newEvidence ? 'warning' : 'info', 'case', user.id, `${KIND[kind]} #${id}${expedite ? ' (exam within 48 hours: verify the date to expedite)' : newEvidence ? ' (new evidence: 3 business days)' : ''}.`)
    .run();
  await audit(db, { actorId: user.id, action: 'case.opened', targetUserId: user.id, detail: { id, kind, item, expedite, newEvidence }, ip: ip(c) });
  await notify(c.env, user.id, { kind: 'case', title: `We received your ${kind === 'appeal' ? 'appeal' : 'view dispute'} (#${id})`, body: `We’ll review it and update you by ${when(iso(due))}.` });
  return c.redirect('/account/appeals?ok=1');
});

// ---------- Staff ----------

casesAdmin.get('/cases', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const rows = (
    await c.env.DB.prepare("SELECT k.*, u.name, u.email FROM cases k JOIN users u ON u.id = k.user_id ORDER BY k.status = 'decided', k.due_at LIMIT 200").all<any>()
  ).results;
  const now = iso(new Date());
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Admin: appeals and disputes" active="admin-cases" user={me} wide>
      <Eyebrow>Admin</Eyebrow>
      <h1>Appeals and disputes</h1>
      <p class="muted">An administrator reviews each case and recommends; the owner makes the final decision. Targets: view disputes 2 business days (12 hours when an exam within 48 hours is verified); appeals get a student update at least every 5 business days, and 3 business days for new evidence.</p>
      <div class="table-box"><table class="t">
        <thead><tr><th scope="col">Case</th><th scope="col">Student</th><th scope="col">Status</th><th scope="col">Target</th></tr></thead>
        <tbody>
          {rows.map((k: any) => (
            <tr>
              <td><a href={`/admin/cases/${k.id}`}>{KIND[k.kind]} #{k.id}</a>{k.expedite_requested ? ' · exam soon' : ''}{k.new_evidence ? ' · new evidence' : ''}</td>
              <td class="small">{k.name}<br /><span class="muted">{k.email}</span></td>
              <td class="small">{statusText(k)}</td>
              <td class="small" style={k.status !== 'decided' && k.due_at < now ? 'color:#8c2f20;font-weight:700' : undefined}>{k.status === 'decided' ? '—' : when(k.due_at)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {rows.length === 0 && <p class="muted">No cases yet.</p>}
    </PortalLayout>,
  );
});

casesAdmin.get('/cases/:id{[0-9]+}', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const k = await db.prepare('SELECT k.*, u.name, u.email, u.status AS user_status, u.status_at, u.status_reason FROM cases k JOIN users u ON u.id = k.user_id WHERE k.id = ?').bind(Number(c.req.param('id'))).first<any>();
  if (!k) return c.notFound();
  const [msgs, label, reviewer] = await Promise.all([
    db.prepare('SELECT m.*, u.name AS author FROM case_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.case_id = ? ORDER BY m.id').bind(k.id).all<any>(),
    k.item ? itemLabel(db, k.item) : Promise.resolve(null),
    k.reviewer_id ? db.prepare('SELECT name FROM users WHERE id = ?').bind(k.reviewer_id).first<{ name: string }>() : Promise.resolve(null),
  ]);
  const owner = isOwner(me);
  return c.html(
    <PortalLayout shell={c.get('shell')} title={`Case #${k.id}`} active="admin-cases" user={me}>
      <nav class="crumbs"><a href="/admin/cases">Appeals and disputes</a></nav>
      <h1>{KIND[k.kind]} #{k.id}</h1>
      {c.req.query('ok') && <Flash>Saved.</Flash>}
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <section class="card stack">
        <p style="margin:0"><strong>{k.name}</strong> · {k.email} · account {k.user_status}{k.status_at ? ` since ${when(k.status_at)}` : ''}{k.status_reason ? ` (${k.status_reason})` : ''}</p>
        {label && <p style="margin:0">Video: {label}</p>}
        {k.exam_date && <p style="margin:0">Exam date given: {k.exam_date}{k.expedite_verified_at ? ` · verified ${when(k.expedite_verified_at)}` : ' · not verified yet'}</p>}
        <p style="margin:0" class="small muted">Sent {when(k.created_at)} · {statusText(k)} · {k.status === 'decided' ? '' : `target ${when(k.due_at)}`}</p>
        <blockquote style="margin:0;padding:10px 14px;border-left:3px solid #ccc">{k.statement}</blockquote>
      </section>
      <section class="card stack">
        <h2 style="margin:0">Messages</h2>
        {msgs.results.map((m: any) => <p class="small" style="margin:0"><strong>{m.author ?? 'Student'}</strong> · {when(m.created_at)} · {m.to_student ? 'to student' : 'staff note'}<br />{m.body}</p>)}
        {k.status !== 'decided' && (
          <form method="post" action={`/admin/cases/${k.id}/message`} class="stack" style="gap:8px">
            <textarea name="body" rows={3} required maxlength={2000} placeholder="Update for the student, or a staff-only note"></textarea>
            <label class="check"><input type="checkbox" name="to_student" value="1" checked /> Send to the student (don’t include confidential evidence or how problems are detected)</label>
            <button class="btn btn-outline btn-sm" type="submit" style="align-self:flex-start">Add</button>
          </form>
        )}
      </section>
      {k.status !== 'decided' && k.expedite_requested && !k.expedite_verified_at ? (
        <section class="card stack">
          <h2 style="margin:0">Exam within 48 hours</h2>
          <p class="muted small" style="margin:0">Check the student’s exam confirmation, then delete the copy within 24 hours. If the dates conflict, ask for clarification instead; the normal 2-business-day target still applies.</p>
          <form method="post" action={`/admin/cases/${k.id}/verify`}><button class="btn btn-outline" type="submit">Exam date verified: expedite (12 hours)</button></form>
        </section>
      ) : null}
      {k.status === 'open' && !owner && (
        <section class="card stack">
          <h2 style="margin:0">Independent review</h2>
          <form method="post" action={`/admin/cases/${k.id}/review`} class="stack" style="gap:8px">
            <label class="field">Recommendation<select name="recommendation"><option value="grant">Grant</option><option value="deny">Don’t grant</option></select></label>
            <label class="field">Reasons (for the owner)<textarea name="note" rows={3} required minlength={10} maxlength={2000}></textarea></label>
            <button class="btn btn-primary btn-sm" type="submit" style="align-self:flex-start">Send to the owner</button>
          </form>
        </section>
      )}
      {k.reviewed_at && <section class="card"><p style="margin:0"><strong>Review by {reviewer?.name}:</strong> recommends {k.recommendation === 'grant' ? 'granting' : 'not granting'}. {k.review_note}</p></section>}
      {k.status !== 'decided' && owner && (
        <section class="card stack">
          <h2 style="margin:0">Owner decision</h2>
          {!k.reviewed_at && <p class="muted small" style="margin:0">No administrator has reviewed this yet. You can still decide if no one else is available.</p>}
          <form method="post" action={`/admin/cases/${k.id}/decide`} class="stack" style="gap:8px">
            <label class="field">Decision<select name="decision"><option value="granted">Grant</option><option value="denied">Don’t grant</option></select></label>
            <label class="field">Reason shown to the student (general reasons and the policy; not the evidence or detection methods)<textarea name="reason" rows={3} required minlength={10} maxlength={2000}></textarea></label>
            {k.reviewed_at && <label class="field">If you disagree with the review, why (kept for the record)<textarea name="justification" rows={2} maxlength={2000}></textarea></label>}
            <p class="muted small" style="margin:0">{k.kind === 'appeal' ? 'Granting reinstates the account and extends each active paid enrollment by the exact time it was restricted.' : 'Granting restores one view of this video.'}</p>
            <button class="btn btn-primary" type="submit" style="align-self:flex-start">Decide</button>
          </form>
        </section>
      )}
      {k.status === 'decided' && <section class="card"><p style="margin:0"><strong>{k.decision === 'granted' ? 'Granted' : 'Not granted'}</strong> on {when(k.decided_at)}. {k.decision_reason}</p></section>}
    </PortalLayout>,
  );
});

const caseBack = (id: number, m: string, error = false) => `/admin/cases/${id}?${error ? 'error' : 'ok'}=${encodeURIComponent(m)}`;

casesAdmin.post('/cases/:id{[0-9]+}/message', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const body = String(f.body ?? '').trim().slice(0, 2000);
  const k = await db.prepare("SELECT * FROM cases WHERE id = ? AND status <> 'decided'").bind(id).first<any>();
  if (!k || !body) return c.redirect(caseBack(id, 'Nothing to add.', true));
  const toStudent = f.to_student === '1';
  await db.batch([
    db.prepare('INSERT INTO case_messages (case_id, author_id, to_student, body) VALUES (?, ?, ?, ?)').bind(id, me.id, toStudent ? 1 : 0, body),
    // An update to the student on an appeal resets the 5-business-day update clock.
    ...(toStudent && k.kind === 'appeal' && !k.new_evidence ? [db.prepare('UPDATE cases SET last_update_at = datetime(\'now\'), due_at = ?, escalated_at = NULL WHERE id = ?').bind(iso(addBusinessDays(new Date(), 5)), id)] : []),
    ...(toStudent ? [db.prepare("UPDATE cases SET last_update_at = datetime('now') WHERE id = ?").bind(id)] : []),
  ]);
  if (toStudent) await notify(c.env, k.user_id, { kind: 'case', title: `Update on your request #${id}`, body });
  return c.redirect(caseBack(id, 'Added.'));
});

casesAdmin.post('/cases/:id{[0-9]+}/verify', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const k = await db.prepare("SELECT * FROM cases WHERE id = ? AND status <> 'decided' AND expedite_requested = 1 AND expedite_verified_at IS NULL").bind(id).first<any>();
  if (!k) return c.redirect(caseBack(id, 'Nothing to verify.', true));
  await db.prepare("UPDATE cases SET expedite_verified_at = datetime('now'), due_at = ?, escalated_at = NULL WHERE id = ?").bind(iso(expeditedDue(k.due_at)), id).run();
  await audit(db, { actorId: me.id, action: 'case.expedited', targetUserId: k.user_id, detail: { id }, ip: ip(c) });
  return c.redirect(caseBack(id, 'Expedited: decision target is now 12 hours (or sooner).'));
});

casesAdmin.post('/cases/:id{[0-9]+}/review', async (c) => {
  const me = c.get('user')!;
  if (me.role !== 'admin') return c.text('Not found', 404);
  // The owner decides; the review must come from someone else (independent review).
  if (isOwner(me)) return c.redirect(caseBack(Number(c.req.param('id')), 'The owner decides; another administrator reviews.', true));
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const rec = f.recommendation === 'grant' ? 'grant' : 'deny';
  const note = String(f.note ?? '').trim().slice(0, 2000);
  if (note.length < 10) return c.redirect(caseBack(id, 'Please give reasons.', true));
  const r = await db.prepare("UPDATE cases SET status = 'reviewed', reviewer_id = ?, recommendation = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'open'").bind(me.id, rec, note, id).run();
  if (!r.meta.changes) return c.redirect(caseBack(id, 'This case was already reviewed.', true));
  const k = await db.prepare('SELECT user_id FROM cases WHERE id = ?').bind(id).first<{ user_id: number }>();
  await audit(db, { actorId: me.id, action: 'case.reviewed', targetUserId: k?.user_id ?? null, detail: { id, rec }, ip: ip(c) });
  await db.prepare("INSERT INTO staff_alerts (level, kind, user_id, message) VALUES ('warning', 'case-review', ?, ?)").bind(k?.user_id ?? null, `Case #${id} was reviewed and needs the owner’s decision.`).run();
  return c.redirect(caseBack(id, 'Sent to the owner.'));
});

/** Owner only (OWNER_ONLY). Applies the outcome exactly once. */
casesAdmin.post('/cases/:id{[0-9]+}/decide', async (c) => {
  const me = c.get('user')!;
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const f = await c.req.parseBody();
  const decision = f.decision === 'granted' ? 'granted' : 'denied';
  const reason = String(f.reason ?? '').trim().slice(0, 2000);
  const justification = String(f.justification ?? '').trim().slice(0, 2000);
  const k = await db.prepare("SELECT * FROM cases WHERE id = ? AND status <> 'decided'").bind(id).first<any>();
  if (!k) return c.redirect(caseBack(id, 'This case was already decided.', true));
  if (reason.length < 10) return c.redirect(caseBack(id, 'Please give the reason the student will see.', true));
  const disagrees = k.recommendation && (k.recommendation === 'grant') !== (decision === 'granted');
  if (disagrees && justification.length < 20) return c.redirect(caseBack(id, 'You are deciding against the review: please record an evidence-based justification.', true));
  // Claim the decision first, so a double submit can't apply it twice.
  const claimed = await db
    .prepare("UPDATE cases SET status = 'decided', decision = ?, decision_reason = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ? AND status <> 'decided'")
    .bind(decision, reason, me.id, id)
    .run();
  if (!claimed.meta.changes) return c.redirect(caseBack(id, 'This case was already decided.', true));
  let effect: unknown = null;
  if (decision === 'granted' && k.kind === 'appeal') {
    const u = await db.prepare('SELECT status, status_at FROM users WHERE id = ?').bind(k.user_id).first<{ status: string; status_at: string | null }>();
    if (u && u.status !== 'active') {
      const from = u.status === 'suspended' && u.status_at ? parseIso(u.status_at) : null;
      await db.prepare("UPDATE users SET status = 'active', status_reason = NULL, status_at = datetime('now') WHERE id = ?").bind(k.user_id).run();
      effect = from ? await compensate(db, id, k.user_id, from) : [];
    }
  } else if (decision === 'granted' && k.kind === 'view-dispute' && k.item) {
    const paid = k.item.startsWith('L:');
    const enr = paid ? await db.prepare("SELECT id FROM enrollments WHERE user_id = ? AND status = 'active' ORDER BY paid_at DESC LIMIT 1").bind(k.user_id).first<{ id: number }>() : null;
    await db
      .prepare('INSERT INTO view_grants (user_id, item, kind, enrollment_id, extra, reason, granted_by, case_id) VALUES (?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(k.user_id, k.item, paid ? 'paid' : 'free', enr?.id ?? null, `Dispute #${id}`, me.id, id)
      .run();
    effect = 'one view restored';
  }
  await audit(db, { actorId: me.id, action: 'case.decided', targetUserId: k.user_id, detail: { id, decision, disagrees: !!disagrees, justification: justification || undefined, effect }, ip: ip(c) });
  await notify(c.env, k.user_id, {
    kind: 'case',
    title: `Decision on your request #${id}`,
    body: `${decision === 'granted' ? 'Your request was granted.' : 'Your request was not granted.'} ${reason}${decision === 'denied' && k.kind === 'appeal' ? ' If you have important new evidence, you can send a new appeal from My account → Appeals and disputes.' : ''}`,
    sms: k.kind === 'appeal',
  });
  return c.redirect(caseBack(id, 'Decided.'));
});
