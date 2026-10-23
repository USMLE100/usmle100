import { Hono, type Context } from 'hono';
import type { AppEnv } from '../lib/types';
import { isStaff } from '../lib/types';
import { requireEnrolled } from '../lib/auth';
import { PortalLayout, Eyebrow, Flash } from '../views/layout';
import { bunnyEmbedUrl, cohortDay, currentCohort, defaultLecturesUntil, dayDate, dayOfDate, fmtDate, dayOffLabel, isClassDate, isOffToday, LETTERS, todayUtc, ymdToUtc, type Cohort } from '../lib/content';
import { filterQuestions, questionStatuses, scoresBy, shuffle, type Pools } from '../lib/qbank';
import { getSettings, isHttpUrl } from '../lib/settings';
import { CLASSES_PER_MONTH, eveningAccess, GRACE_DAYS, nextStart, type EveningSession } from '../lib/evening';

export const portal = new Hono<AppEnv>();
portal.use('*', async (c, next) => {
  // Someone who only buys Evening Questions has no program enrollment: let them into that section only.
  const user = c.get('user');
  if (user && !isStaff(user) && !c.get('enrollment') && (await eveningAccess(c.env.DB, user))) {
    if (c.req.path === '/evening' || c.req.path.startsWith('/evening/')) return next();
    return c.redirect('/evening');
  }
  return requireEnrolled(c, next);
});

type Lecture = { id: number; day_number: number; title: string; zoom_url: string | null; bunny_video_id: string | null; status: string; completed_at: string | null };

async function lecturesFor(db: D1Database, cohortId: number, userId: number) {
  const { results } = await db
    .prepare(
      `SELECT l.id, l.day_number, l.title, l.zoom_url, l.bunny_video_id, l.status, p.completed_at
       FROM lectures l LEFT JOIN lecture_progress p ON p.lecture_id = l.id AND p.user_id = ?
       WHERE l.cohort_id = ? ORDER BY l.day_number`,
    )
    .bind(userId, cohortId)
    .all<Lecture>();
  return results;
}

// ---------- Dashboard ----------

function Calendar(props: { cohort: Cohort; today: number; lectures: Lecture[] }) {
  const { cohort, today } = props;
  const byDay = new Map(props.lectures.map((l) => [l.day_number, l]));
  const first = dayDate(cohort, 1);
  const last = dayDate(cohort, cohort.total_days);
  const months: { y: number; m: number }[] = [];
  for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); y < last.getUTCFullYear() || (y === last.getUTCFullYear() && m <= last.getUTCMonth()); m === 11 ? (y++, (m = 0)) : m++) months.push({ y, m });
  return (
    <div class="months">
      {months.map(({ y, m }) => {
        const lead = new Date(Date.UTC(y, m, 1)).getUTCDay();
        const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const cells = [];
        for (let i = 0; i < lead; i++) cells.push(<span></span>);
        const todayT = todayUtc();
        for (let d = 1; d <= days; d++) {
          const t = Date.UTC(y, m, d);
          const off = !isClassDate(cohort, t);
          const holiday = dayOffLabel(cohort, t);
          const n = dayOfDate(cohort, t);
          const lec = off ? undefined : byDay.get(n);
          let cls = 'day day-up';
          let label = `${fmtDate(new Date(t))}`;
          if (holiday) (cls = 'day day-holiday'), (label += `, ${holiday}, no class`);
          else if (off) (cls = 'day day-out'), (label += t === todayT ? ', today, weekend' : ', weekend');
          else if (t < first.getTime() || t > last.getTime()) cls = 'day day-out';
          else if (t === todayT) (cls = 'day day-today'), (label += `, today, day ${n}`);
          else if (lec?.completed_at) (cls = 'day day-done'), (label += ', done');
          else if (t < todayT && lec?.status === 'live') (cls = 'day day-missed'), (label += ', missed');
          else if (n > cohort.lecture_days) (cls = 'day day-exam'), (label += ', exam window');
          cells.push(
            lec && lec.status === 'live' ? (
              <a href={`/lectures/${lec.id}`} class={cls} aria-label={label}>
                {d}
              </a>
            ) : (
              <span class={cls} aria-label={label}>
                {d}
              </span>
            ),
          );
        }
        return (
          <div class="stack" style="gap:10px">
            <strong style="color:var(--forest)">{new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</strong>
            <div class="month-grid">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((h) => (
                <span class="dow" aria-hidden="true">
                  {h}
                </span>
              ))}
              {cells}
            </div>
          </div>
        );
      })}
    </div>
  );
}

portal.get('/dashboard', async (c) => {
  const user = c.get('user')!;
  const enr = c.get('enrollment');
  const cohort = await currentCohort(c.env.DB, enr?.cohort_id);
  if (!cohort) {
    return c.html(
      <PortalLayout title="Home" active="home" user={user}>
        <h1>Welcome, {user.name.split(' ')[0]}.</h1>
        <Flash kind="error">No cohort is scheduled yet. {isStaff(user) ? <a href="/admin/lectures">Create one in Admin → Lectures.</a> : 'Your start date will appear here soon.'}</Flash>
      </PortalLayout>,
    );
  }
  const today = cohortDay(cohort);
  const lectures = await lecturesFor(c.env.DB, cohort.id, user.id);
  const todays = lectures.find((l) => l.day_number === today);
  const missed = lectures.filter((l) => l.day_number < today && l.status === 'live' && !l.completed_at);
  const statuses = await questionStatuses(c.env.DB, user.id);
  const wrong = statuses.filter((s) => s.status === 'incorrect').length;
  const done = lectures.filter((l) => l.completed_at).length;
  const weekend = isOffToday(cohort);
  const phase = today < 1
    ? `Starts ${fmtDate(dayDate(cohort, 1), { weekday: 'long', month: 'long', day: 'numeric' })}`
    : today > cohort.total_days
      ? 'Program complete'
      : weekend
        ? `Weekend · Day ${today} of ${cohort.total_days} done`
        : `Day ${today} of ${cohort.total_days}`;

  return c.html(
    <PortalLayout title="Home" active="home" user={user}>
      <div class="row between">
        <div class="stack" style="gap:6px">
          <Eyebrow>{phase}</Eyebrow>
          <h1>Welcome back, {user.name.split(' ')[0]}.</h1>
        </div>
        {enr && <span class="chip chip-sand">{enr.package_name}</span>}
      </div>
      <LectureNotice n={lectureNotice(c, cohort)} />

      <div class="grid">
        <section class="card card-dark">
          <Eyebrow>{today > cohort.lecture_days ? 'Exam window' : weekend ? dayOffLabel(cohort, todayUtc()) ?? 'Weekend' : today < 1 ? 'First class' : `Today's lecture · Day ${today}`}</Eyebrow>
          {today < 1 ? (
            <h2>Classes start {fmtDate(dayDate(cohort, 1), { weekday: 'long', month: 'long', day: 'numeric' })}.</h2>
          ) : weekend && today <= cohort.lecture_days ? (
            <>
              <h2>No class today. A good time to catch up.</h2>
              <a class="btn btn-gold" href="/create-test" style="align-self:flex-start">Practice questions</a>
            </>
          ) : today > cohort.lecture_days ? (
            <>
              <h2>Lectures are done. Time to book your exam.</h2>
              <a class="btn btn-gold" href="/exam-window" style="align-self:flex-start">
                Open the exam window
              </a>
            </>
          ) : todays ? (
            <>
              <h2>{todays.title}</h2>
              <div class="row">
                {todays.status === 'live' && (
                  <a class="btn btn-gold" href={`/lectures/${todays.id}`}>
                    Watch the recording
                  </a>
                )}
                {todays.zoom_url && todays.status !== 'live' && <p>The recording appears here after class.</p>}
              </div>
            </>
          ) : (
            <p>No lecture is scheduled for today yet.</p>
          )}
        </section>
        <section class="card">
          <div class="row between">
            <h2>Catch up</h2>
          </div>
          <a class="row" href="/lectures" style="text-decoration:none;color:inherit">
            <span class="chip chip-rust">{missed.length}</span> Missed lectures to watch
          </a>
          <a class="row" href="/create-test?pool=incorrect" style="text-decoration:none;color:inherit">
            <span class="chip chip-sand">{wrong}</span> Questions you got wrong
          </a>
          <span class="row muted">
            <span class="chip chip-gray">{done}</span> Lectures completed
          </span>
        </section>
      </div>

      <section class="card">
        <div class="row between">
          <div class="stack" style="gap:4px">
            <h2>Your {cohort.total_days}-day plan</h2>
            <span class="muted small">
              {cohort.lecture_days} teaching days, Monday to Friday{cohort.daysOff?.size ? ` (holidays off)` : ''}, then a {cohort.total_days - cohort.lecture_days}-weekday exam window · {cohort.name}
            </span>
          </div>
          <div class="cal-legend">
            <span><i class="sw day-done"></i>Done</span>
            <span><i class="sw day-missed"></i>Missed</span>
            <span><i class="sw day-today"></i>Today</span>
            <span><i class="sw day-up"></i>Upcoming</span>
            <span><i class="sw day-exam"></i>Exam window</span>
            <span><i class="sw day-holiday"></i>Holiday</span>
          </div>
        </div>
        <Calendar cohort={cohort} today={today} lectures={lectures} />
      </section>
    </PortalLayout>,
  );
});

// ---------- Lectures ----------

/** Students can watch lectures until 60 days after Day 100, or the date an admin set for them. Null = still allowed. */
async function lecturesEndedOn(c: Context<AppEnv>, cohort: Cohort | null): Promise<string | null> {
  const user = c.get('user')!;
  const enr = c.get('enrollment');
  if (isStaff(user) || !enr || !cohort) return null;
  const until = enr.lectures_until || defaultLecturesUntil(cohort);
  const today = new Date(todayUtc()).toISOString().slice(0, 10);
  return today > until ? until : null;
}

/**
 * After the 90 lecture days, remind students when their lecture recordings close.
 * Shown from Day 91 until access ends; not shown to staff.
 */
function lectureNotice(c: Context<AppEnv>, cohort: Cohort | null) {
  const user = c.get('user')!;
  const enr = c.get('enrollment');
  if (isStaff(user) || !enr || !cohort || cohortDay(cohort) <= cohort.lecture_days) return null;
  const until = enr.lectures_until || defaultLecturesUntil(cohort);
  const daysLeft = Math.round((ymdToUtc(until) - todayUtc()) / 86400_000) + 1;
  return daysLeft >= 1 ? { until, daysLeft } : null;
}

function LectureNotice(props: { n: { until: string; daysLeft: number } | null }) {
  if (!props.n) return null;
  const date = fmtDate(new Date(props.n.until + 'T00:00:00Z'), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const soon = props.n.daysLeft <= 14;
  return (
    <p class={'flash ' + (soon ? 'flash-error' : 'flash-ok')} role="status">
      You’ve finished the 90 days of lectures. Your lecture recordings stay available until <strong>{date}</strong>
      {soon ? <> — only <strong>{props.n.daysLeft} day{props.n.daysLeft === 1 ? '' : 's'} left</strong>.</> : '.'} After that they close.
    </p>
  );
}

function LecturesEnded(props: { user: any; until: string; email: string }) {
  return (
    <PortalLayout title="Lectures" active="lectures" user={props.user}>
      <Eyebrow>Study</Eyebrow>
      <h1>Lectures</h1>
      <section class="card">
        <p style="margin:0">
          Your access to the lecture recordings ended on {fmtDate(new Date(props.until + 'T00:00:00Z'), { month: 'long', day: 'numeric', year: 'numeric' })}.
          {props.email && <> To ask for more time, email <a href={`mailto:${props.email}?subject=${encodeURIComponent('USMLE100: more time for lectures')}`}>{props.email}</a>.</>}
        </p>
      </section>
    </PortalLayout>
  );
}

portal.get('/lectures', async (c) => {
  const user = c.get('user')!;
  const cohort = await currentCohort(c.env.DB, c.get('enrollment')?.cohort_id);
  const ended = await lecturesEndedOn(c, cohort);
  if (ended) return c.html(<LecturesEnded user={user} until={ended} email={(await getSettings(c.env.DB)).contact_email} />);
  const lectures = cohort ? await lecturesFor(c.env.DB, cohort.id, user.id) : [];
  const today = cohort ? cohortDay(cohort) : 0;
  return c.html(
    <PortalLayout title="Lectures" active="lectures" user={user}>
      <Eyebrow>Study</Eyebrow>
      <h1>Lectures</h1>
      <LectureNotice n={lectureNotice(c, cohort)} />
      {!lectures.length && <p class="muted">No lectures yet.</p>}
      {lectures.length > 0 && (
        <div class="table-box">
          <table class="t">
            <thead>
              <tr><th scope="col">Day</th><th scope="col">Date</th><th scope="col">Lecture</th><th scope="col">Status</th></tr>
            </thead>
            <tbody>
              {lectures.map((l) => (
                <tr>
                  <td><strong>Day {l.day_number}</strong></td>
                  <td class="muted">{fmtDate(dayDate(cohort!, l.day_number))}</td>
                  <td>{l.status === 'live' ? <a href={`/lectures/${l.id}`}>{l.title}</a> : l.title}</td>
                  <td>
                    {l.completed_at ? <span class="chip">Watched</span> : l.status !== 'live' ? <span class="chip chip-gray">Coming soon</span> : l.day_number < today ? <span class="chip chip-rust">Missed</span> : <span class="chip chip-sand">To watch</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PortalLayout>,
  );
});

portal.get('/lectures/:id', async (c) => {
  const user = c.get('user')!;
  const l = await c.env.DB.prepare(
    `SELECT l.*, p.completed_at FROM lectures l LEFT JOIN lecture_progress p ON p.lecture_id = l.id AND p.user_id = ? WHERE l.id = ?`,
  )
    .bind(user.id, Number(c.req.param('id')))
    .first<Lecture>();
  if (!l || (l.status !== 'live' && !isStaff(user))) return c.notFound();
  const ended = await lecturesEndedOn(c, await currentCohort(c.env.DB, c.get('enrollment')?.cohort_id));
  if (ended) return c.html(<LecturesEnded user={user} until={ended} email={(await getSettings(c.env.DB)).contact_email} />);
  const src = l.bunny_video_id ? await bunnyEmbedUrl(c.env, l.bunny_video_id) : null;
  return c.html(
    <PortalLayout title={l.title} active="lectures" user={user}>
      <Eyebrow>Day {l.day_number}</Eyebrow>
      <h1>{l.title}</h1>
      {src ? (
        <div class="video-wrap">
          <iframe src={src} title={l.title} loading="lazy" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
          <span class="watermark" aria-hidden="true">{user.email}</span>
        </div>
      ) : (
        <Flash kind="error">{l.bunny_video_id ? 'This video can’t be played right now. Please try again later.' : 'The video for this lecture isn’t uploaded yet.'}</Flash>
      )}
      <div class="row">
        {l.completed_at ? (
          <span class="chip">Watched</span>
        ) : (
          <form method="post" action={`/lectures/${l.id}/done`}>
            <button class="btn btn-primary" type="submit">Mark as watched</button>
          </form>
        )}
        <a class="btn btn-ghost" href="/lectures">All lectures</a>
      </div>
    </PortalLayout>,
  );
});

portal.post('/lectures/:id/done', async (c) => {
  const user = c.get('user')!;
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare(
    `INSERT INTO lecture_progress (user_id, lecture_id, completed_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (user_id, lecture_id) DO UPDATE SET completed_at = COALESCE(completed_at, datetime('now')), updated_at = datetime('now')`,
  )
    .bind(user.id, id)
    .run();
  return c.redirect(`/lectures/${id}`);
});

// ---------- Evening Questions (Mon/Wed/Fri recordings, own access) ----------

portal.get('/evening', async (c) => {
  const user = c.get('user')!;
  const acc = await eveningAccess(c.env.DB, user);
  if (!acc) {
    const settings = await getSettings(c.env.DB);
    const next = { d: await nextStart(c.env.DB, user.id) };
    return c.html(
      <PortalLayout title="Evening Questions" active="evening" user={user}>
        <Eyebrow>Study</Eyebrow>
        <h1>Evening Questions</h1>
        <section class="card">
          {next?.d && <Flash>Your next month of Evening Questions starts on {fmtDate(new Date(next.d + 'T00:00:00Z'), { weekday: 'long', month: 'long', day: 'numeric' })}.</Flash>}
          <p>Live question sessions on Monday, Wednesday and Friday evenings. Each month covers {CLASSES_PER_MONTH} classes, and you can rewatch them until {GRACE_DAYS} days after the 12th recording goes up.</p>
          <p>Included for 4 months with the <strong>Companion</strong>, <strong>Complete</strong> and <strong>MAX</strong> programs, or on its own for <strong>$160 a month</strong>.</p>
          <div class="row">
            <a class="btn btn-primary" href="/programs">See programs</a>
            {settings.contact_email && (
              <a class="btn btn-outline" href={`mailto:${settings.contact_email}?subject=${encodeURIComponent('USMLE100: Evening Questions')}`}>Ask about Evening Questions</a>
            )}
          </div>
        </section>
      </PortalLayout>,
    );
  }
  const all = (await c.env.DB.prepare("SELECT * FROM evening_sessions WHERE status = 'live' ORDER BY session_date DESC").all<EveningSession>()).results;
  const sessions = acc.staff ? all : all.filter((e) => acc.visible.has(e.id));
  const long = (d: string) => fmtDate(new Date(d + 'T00:00:00Z'), { weekday: 'long', month: 'long', day: 'numeric' });
  const cur = acc.staff ? null : acc.current;
  return c.html(
    <PortalLayout title="Evening Questions" active="evening" user={user}>
      <Eyebrow>Study</Eyebrow>
      <h1>Evening Questions</h1>
      <p class="muted">Monday, Wednesday and Friday evening recordings.</p>
      {cur && (
        <section class="card">
          <p style="margin:0">
            <strong>Month {cur.month}{cur.months > 1 ? ` of ${cur.months}` : ''}</strong> · class {cur.sessions.length} of {CLASSES_PER_MONTH} so far.{' '}
            {cur.end
              ? <>All {CLASSES_PER_MONTH} classes are up. You can watch them until the end of <strong>{long(cur.end)}</strong>.</>
              : <>You can watch this month’s classes until {GRACE_DAYS} days after class {CLASSES_PER_MONTH} goes up.</>}
          </p>
        </section>
      )}
      {!sessions.length ? (
        <p class="muted">No recordings for this month yet. They appear here after each evening class.</p>
      ) : (
        <div class="table-box">
          <table class="t">
            <thead><tr><th scope="col">Date</th><th scope="col">Session</th></tr></thead>
            <tbody>
              {sessions.map((e) => (
                <tr>
                  <td class="muted">{fmtDate(new Date(e.session_date + 'T00:00:00Z'), { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                  <td><a href={`/evening/${e.id}`}>{e.title}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PortalLayout>,
  );
});

portal.get('/evening/:id', async (c) => {
  const user = c.get('user')!;
  const acc = await eveningAccess(c.env.DB, user);
  if (!acc) return c.redirect('/evening');
  const e = await c.env.DB.prepare('SELECT * FROM evening_sessions WHERE id = ?').bind(Number(c.req.param('id'))).first<EveningSession>();
  if (!e || (e.status !== 'live' && !isStaff(user))) return c.notFound();
  // Only the classes in the student's current month.
  if (!acc.staff && !acc.visible.has(e.id)) return c.redirect('/evening');
  const src = e.bunny_video_id ? await bunnyEmbedUrl(c.env, e.bunny_video_id) : null;
  return c.html(
    <PortalLayout title={e.title} active="evening" user={user}>
      <Eyebrow>Evening Questions</Eyebrow>
      <h1>{e.title}</h1>
      {src ? (
        <div class="video-wrap">
          <iframe src={src} title={e.title} loading="lazy" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
          <span class="watermark" aria-hidden="true">{user.email}</span>
        </div>
      ) : (
        <Flash kind="error">{e.bunny_video_id ? 'This video can’t be played right now. Please try again later.' : 'The video for this session isn’t ready yet.'}</Flash>
      )}
      <div class="row"><a class="btn btn-ghost" href="/evening">All evening sessions</a></div>
    </PortalLayout>,
  );
});

// ---------- Create a test ----------

const POOLS: { key: keyof Pools; label: string; sub: string }[] = [
  { key: 'unused', label: 'Unused', sub: 'Never attempted' },
  { key: 'incorrect', label: 'Incorrect', sub: 'Answered incorrectly' },
  { key: 'omitted', label: 'Omitted', sub: 'Skipped without answering' },
  { key: 'correct', label: 'Correct', sub: 'Answered correctly' },
  { key: 'custom', label: 'Custom', sub: 'Questions you flagged' },
];

portal.get('/create-test', async (c) => {
  const user = c.get('user')!;
  const [subjects, systems, rows] = await Promise.all([
    c.env.DB.prepare('SELECT id, name FROM subjects ORDER BY sort').all<{ id: number; name: string }>(),
    c.env.DB.prepare('SELECT id, name FROM systems ORDER BY sort').all<{ id: number; name: string }>(),
    questionStatuses(c.env.DB, user.id),
  ]);
  const count = (k: keyof Pools) => (k === 'custom' ? rows.filter((r) => r.flagged).length : rows.filter((r) => r.status === k).length);
  const pre = c.req.query('pool') ?? 'unused';
  const err = c.req.query('error');
  return c.html(
    <PortalLayout title="Create a test" active="create" user={user}>
      <Eyebrow>Practice</Eyebrow>
      <h1>Create a test</h1>
      {err && <Flash kind="error">{err}</Flash>}
      <form method="post" class="stack">
        <fieldset class="card">
          <legend><h2>How should it grade you?</h2></legend>
          {[
            ['tutor', 'Tutor', 'Answer and explanation shown as you go'],
            ['timed', 'Timed', '90 seconds per question, exam conditions'],
            ['untimed', 'Untimed', 'No clock, graded at the end'],
          ].map(([v, l, s], i) => (
            <label class="check">
              <input type="radio" name="mode" value={v} checked={i === 0} /> <span><strong>{l}</strong> <span class="muted small">· {s}</span></span>
            </label>
          ))}
        </fieldset>
        <fieldset class="card">
          <legend><h2>Which questions?</h2></legend>
          <p class="muted small">Pick one or more.</p>
          {POOLS.map((p) => (
            <label class="check">
              <input type="checkbox" name="pool" value={p.key} checked={p.key === pre} /> <span><strong>{p.label}</strong> <span class="muted small">· {p.sub} · {count(p.key)}</span></span>
            </label>
          ))}
        </fieldset>
        <fieldset class="card">
          <legend><h2>Select subjects <span class="muted small">(13)</span></h2></legend>
          <p class="muted small">Leave all unticked to include every subject.</p>
          <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:0 16px">
            {subjects.results.map((s) => (
              <label class="check"><input type="checkbox" name="subject" value={String(s.id)} /> {s.name}</label>
            ))}
          </div>
        </fieldset>
        <fieldset class="card">
          <legend><h2>Select systems <span class="muted small">(26)</span></h2></legend>
          <p class="muted small">Leave all unticked to include every system.</p>
          <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0 16px">
            {systems.results.map((s) => (
              <label class="check"><input type="checkbox" name="system" value={String(s.id)} /> {s.name}</label>
            ))}
          </div>
        </fieldset>
        <div class="card">
          <label class="field" style="max-width:220px">
            How many questions?
            <input type="number" name="count" min="1" max="40" value="10" />
          </label>
          <p class="muted small">{rows.length} approved questions in the bank.</p>
          <button class="btn btn-primary" type="submit" style="align-self:flex-start">Start test</button>
        </div>
      </form>
    </PortalLayout>,
  );
});

portal.post('/create-test', async (c) => {
  const user = c.get('user')!;
  const f = await c.req.parseBody({ all: true });
  const list = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);
  const poolKeys = list(f.pool);
  const pools: Pools = { unused: false, incorrect: false, omitted: false, correct: false, custom: false };
  for (const k of poolKeys) if (k in pools) pools[k as keyof Pools] = true;
  const subjects = list(f.subject).map(Number).filter(Number.isInteger);
  const systems = list(f.system).map(Number).filter(Number.isInteger);
  const mode = ['tutor', 'timed', 'untimed'].includes(String(f.mode)) ? String(f.mode) : 'tutor';
  const count = Math.max(1, Math.min(40, Number(f.count) || 10));

  const rows = await questionStatuses(c.env.DB, user.id);
  const picked = shuffle(filterQuestions(rows, pools, subjects, systems)).slice(0, count);
  if (!picked.length) return c.redirect('/create-test?error=' + encodeURIComponent('No questions match those choices. Try more pools, subjects or systems.'));

  const t = await c.env.DB.prepare('INSERT INTO tests (user_id, mode) VALUES (?, ?)').bind(user.id, mode).run();
  const testId = Number(t.meta.last_row_id);
  await c.env.DB.batch(picked.map((q, i) => c.env.DB.prepare('INSERT INTO test_items (test_id, position, question_id) VALUES (?, ?, ?)').bind(testId, i + 1, q.id)));
  return c.redirect(`/tests/${testId}/1`);
});

// ---------- Test runner ----------

type Item = { position: number; question_id: number; chosen_index: number | null; is_correct: number | null; flagged: number };
type Q = { id: number; stem: string; choices_json: string; correct_index: number; explanation: string; wrong_explanations_json: string | null; bottom_line: string | null; image_url: string | null };

async function loadTest(c: Context<AppEnv>, id: number) {
  const user = c.get('user')!;
  const test = await c.env.DB.prepare('SELECT * FROM tests WHERE id = ? AND user_id = ?').bind(id, user.id).first<{ id: number; mode: string; finished_at: string | null; created_at: string }>();
  if (!test) return null;
  const items = (await c.env.DB.prepare('SELECT position, question_id, chosen_index, is_correct, flagged FROM test_items WHERE test_id = ? ORDER BY position').bind(id).all<Item>()).results;
  return { test, items };
}

portal.get('/tests/:id/:pos{[0-9]+}', async (c) => {
  const user = c.get('user')!;
  const id = Number(c.req.param('id'));
  const pos = Number(c.req.param('pos'));
  const loaded = await loadTest(c, id);
  if (!loaded) return c.notFound();
  const { test, items } = loaded;
  const item = items.find((i) => i.position === pos);
  if (!item) return c.notFound();
  const q = await c.env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(item.question_id).first<Q>();
  if (!q) return c.notFound();
  const choices: string[] = JSON.parse(q.choices_json);
  const wrongEx: Record<string, string> = q.wrong_explanations_json ? JSON.parse(q.wrong_explanations_json) : {};
  const answered = item.chosen_index != null;
  const reveal = !!test.finished_at || (test.mode === 'tutor' && answered);
  const total = items.length;
  const deadline = test.mode === 'timed' && !test.finished_at ? Date.parse(test.created_at.replace(' ', 'T') + 'Z') + total * 90_000 : null;

  return c.html(
    <PortalLayout title={`Question ${pos} of ${total}`} active="create" user={user}>
      <div class="row between">
        <div class="stack" style="gap:4px">
          <Eyebrow>{test.finished_at ? 'Review' : test.mode === 'tutor' ? 'Tutor mode' : test.mode === 'timed' ? 'Timed' : 'Untimed'}</Eyebrow>
          <h1>Question {pos} of {total}</h1>
        </div>
        {deadline && (
          <span class="chip chip-sand" id="timer" data-deadline={String(deadline)} data-finish={`/tests/${id}/finish`}>Time left</span>
        )}
      </div>
      <nav class="qnav" aria-label="Questions">
        {items.map((i) => (
          <a href={`/tests/${id}/${i.position}`} class={(i.position === pos ? 'on' : i.chosen_index != null ? 'ans' : '') } aria-current={i.position === pos ? 'true' : undefined}>
            {i.position}{i.flagged ? '⚑' : ''}
          </a>
        ))}
      </nav>
      <section class="card">
        <p class="stem">{q.stem}</p>
        {q.image_url && <img src={q.image_url} alt="Question image" />}
        <form method="post" action={`/tests/${id}/${pos}`} class="stack" style="gap:10px">
          {choices.map((ch, idx) => {
            let cls = 'choice';
            if (reveal && idx === q.correct_index) cls += ' choice-correct';
            else if (reveal && idx === item.chosen_index) cls += ' choice-wrong';
            return (
              <label class={cls}>
                <input type="radio" name="choice" value={String(idx)} checked={item.chosen_index === idx} disabled={reveal} required />
                <span class="letter">{LETTERS[idx]}.</span>
                <span>{ch}</span>
              </label>
            );
          })}
          {!reveal && (
            <div class="row">
              <button class="btn btn-primary" type="submit">{test.mode === 'tutor' ? 'Submit answer' : 'Save and next'}</button>
            </div>
          )}
        </form>
        <div class="row">
          <form method="post" action={`/tests/${id}/${pos}/flag`}>
            <button class="btn btn-ghost" type="submit">{item.flagged ? 'Unflag' : 'Flag for later'}</button>
          </form>
          {pos > 1 && <a class="btn btn-ghost" href={`/tests/${id}/${pos - 1}`}>Previous</a>}
          {pos < total && <a class="btn btn-ghost" href={`/tests/${id}/${pos + 1}`}>Next</a>}
          {!test.finished_at && (
            <form method="post" action={`/tests/${id}/finish`}>
              <button class="btn btn-outline" type="submit">End test</button>
            </form>
          )}
          {test.finished_at && <a class="btn btn-outline" href={`/tests/${id}/results`}>Results</a>}
        </div>
      </section>
      {reveal && (
        <section class="card">
          <h2>{item.chosen_index == null ? 'Not answered' : item.is_correct ? 'Correct' : 'Incorrect'} · the answer is {LETTERS[q.correct_index]}</h2>
          <p class="explain">{q.explanation}</p>
          {Object.entries(wrongEx).map(([k, v]) => (
            <p class="explain"><strong>Choice {LETTERS[Number(k)]}:</strong> {v}</p>
          ))}
          {q.bottom_line && <p class="explain"><strong>Bottom line:</strong> {q.bottom_line}</p>}
        </section>
      )}
      {deadline && (
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var el=document.getElementById('timer');if(!el)return;var d=+el.dataset.deadline;function tick(){var s=Math.max(0,Math.round((d-Date.now())/1000));el.textContent='Time left '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0');if(s<=0){var f=document.createElement('form');f.method='post';f.action=el.dataset.finish;document.body.appendChild(f);f.submit();return;}setTimeout(tick,1000);}tick();})();`,
          }}
        />
      )}
    </PortalLayout>,
  );
});

portal.post('/tests/:id/:pos{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const pos = Number(c.req.param('pos'));
  const loaded = await loadTest(c, id);
  if (!loaded || loaded.test.finished_at) return c.redirect(`/tests/${id}/${pos}`);
  const item = loaded.items.find((i) => i.position === pos);
  if (!item) return c.notFound();
  const f = await c.req.parseBody();
  const choice = Number(f.choice);
  const q = await c.env.DB.prepare('SELECT correct_index, choices_json FROM questions WHERE id = ?').bind(item.question_id).first<{ correct_index: number; choices_json: string }>();
  if (!q || !Number.isInteger(choice) || choice < 0 || choice >= JSON.parse(q.choices_json).length) return c.redirect(`/tests/${id}/${pos}`);
  // Tutor mode locks the first answer; timed/untimed allow changes until the test ends.
  if (loaded.test.mode === 'tutor' && item.chosen_index != null) return c.redirect(`/tests/${id}/${pos}`);
  await c.env.DB.prepare(`UPDATE test_items SET chosen_index = ?, is_correct = ?, answered_at = datetime('now') WHERE test_id = ? AND position = ?`)
    .bind(choice, choice === q.correct_index ? 1 : 0, id, pos)
    .run();
  const next = loaded.test.mode === 'tutor' ? pos : Math.min(pos + 1, loaded.items.length);
  return c.redirect(`/tests/${id}/${next}`);
});

portal.post('/tests/:id/:pos{[0-9]+}/flag', async (c) => {
  const id = Number(c.req.param('id'));
  const pos = Number(c.req.param('pos'));
  if (!(await loadTest(c, id))) return c.notFound();
  await c.env.DB.prepare('UPDATE test_items SET flagged = 1 - flagged WHERE test_id = ? AND position = ?').bind(id, pos).run();
  return c.redirect(`/tests/${id}/${pos}`);
});

portal.post('/tests/:id/finish', async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await loadTest(c, id))) return c.notFound();
  await c.env.DB.prepare(`UPDATE tests SET finished_at = COALESCE(finished_at, datetime('now')) WHERE id = ?`).bind(id).run();
  return c.redirect(`/tests/${id}/results`);
});

portal.get('/tests/:id/results', async (c) => {
  const user = c.get('user')!;
  const id = Number(c.req.param('id'));
  const loaded = await loadTest(c, id);
  if (!loaded) return c.notFound();
  const { items } = loaded;
  const correct = items.filter((i) => i.is_correct === 1).length;
  const answered = items.filter((i) => i.chosen_index != null).length;
  return c.html(
    <PortalLayout title="Test results" active="create" user={user}>
      <Eyebrow>Results</Eyebrow>
      <h1>{items.length ? Math.round((correct / items.length) * 100) : 0}% correct</h1>
      <p class="muted">{correct} correct · {answered - correct} incorrect · {items.length - answered} omitted</p>
      <nav class="qnav" aria-label="Review questions">
        {items.map((i) => (
          <a href={`/tests/${id}/${i.position}`} class={i.is_correct ? 'ans' : ''}>{i.position}{i.is_correct === 1 ? '✓' : i.chosen_index == null ? '–' : '✗'}</a>
        ))}
      </nav>
      <div class="row">
        <a class="btn btn-primary" href="/create-test">New test</a>
        <a class="btn btn-ghost" href="/performance">Performance</a>
      </div>
    </PortalLayout>,
  );
});

// ---------- Performance ----------

portal.get('/performance', async (c) => {
  const user = c.get('user')!;
  const [bySystem, byDiscipline] = await Promise.all([scoresBy(c.env.DB, user.id, 'perf_system'), scoresBy(c.env.DB, user.id, 'discipline')]);
  const total = bySystem.reduce((a, s) => a + s.answered, 0);
  const right = bySystem.reduce((a, s) => a + s.correct, 0);
  const tests = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM tests WHERE user_id = ? AND finished_at IS NOT NULL').bind(user.id).first<{ n: number }>();
  const Bars = (p: { title: string; rows: typeof bySystem }) => (
    <section class="card" style="gap:4px">
      <h2 style="margin-bottom:8px">{p.title}</h2>
      {p.rows.map((r) => {
        const pct = r.answered ? Math.round((r.correct / r.answered) * 100) : null;
        return (
          <div class="bar-row">
            <div class="bar-head"><span>{r.name}</span><span>{pct == null ? '—' : `${pct}%`}<span class="muted small"> · {r.answered}</span></span></div>
            <div class="bar"><i class={pct != null && pct < 60 ? 'low' : ''} style={`width:${pct ?? 0}%`}></i></div>
          </div>
        );
      })}
    </section>
  );
  return c.html(
    <PortalLayout title="Performance" active="performance" user={user}>
      <Eyebrow>Progress</Eyebrow>
      <h1>Performance</h1>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
        <div class="card"><span class="muted small">Correct overall</span><strong style="font-size:28px">{total ? Math.round((right / total) * 100) : 0}%</strong></div>
        <div class="card"><span class="muted small">Questions answered</span><strong style="font-size:28px">{total}</strong></div>
        <div class="card"><span class="muted small">Tests completed</span><strong style="font-size:28px">{tests?.n ?? 0}</strong></div>
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr));align-items:start">
        <Bars title="Performance by system" rows={bySystem} />
        <Bars title="Performance by discipline" rows={byDiscipline} />
      </div>
      <p class="muted small">Scores under 60% show in amber. Numbers after each score are questions answered.</p>
    </PortalLayout>,
  );
});

// ---------- Exam window ----------

portal.get('/exam-window', async (c) => {
  const user = c.get('user')!;
  const settings = await getSettings(c.env.DB);
  const cohort = await currentCohort(c.env.DB, c.get('enrollment')?.cohort_id);
  const scores = [...(await scoresBy(c.env.DB, user.id, 'perf_system')), ...(await scoresBy(c.env.DB, user.id, 'discipline'))]
    .filter((s) => s.answered >= 5)
    .map((s) => ({ ...s, pct: Math.round((s.correct / s.answered) * 100) }))
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 3);
  const steps = [
    ['Get your scheduling permit', 'Through NBME, or ECFMG if you are an international graduate.'],
    ['Book your test date and center', 'On the Prometric website. Pick a date inside or right after your window.'],
    ['Plan travel if needed', 'If the nearest open center is far away, book transport and a place to stay.'],
    ['Book your final one-on-one sessions', 'Use them on your weakest areas below.'],
    ['Take the group practice test', 'Timed, full length, with your class.'],
    ['Review your last weak areas', 'Short targeted tests from your lowest-scoring topics.'],
  ];
  const windowStart = cohort ? fmtDate(dayDate(cohort, cohort.lecture_days + 1), { month: 'long', day: 'numeric' }) : '';
  const windowEnd = cohort ? fmtDate(dayDate(cohort, cohort.total_days), { month: 'long', day: 'numeric' }) : '';
  return c.html(
    <PortalLayout title="Exam window" active="exam" user={user}>
      <Eyebrow>Days 91 to 100</Eyebrow>
      <h1>Your exam window</h1>
      {cohort && <p class="muted">{windowStart} to {windowEnd}. Test centers fill up, so book your date first.</p>}
      <div class="grid" style="align-items:start">
        <section class="card">
          <h2>Your exam checklist</h2>
          {steps.map(([t, s], i) => (
            <label class="check" style="align-items:flex-start;padding:8px 0;border-top:1px solid var(--line-soft)">
              <input type="checkbox" data-step={String(i)} />
              <span><strong>{t}</strong><br /><span class="muted small">{s}</span></span>
            </label>
          ))}
        </section>
        <div class="stack">
          <section class="card card-sand">
            <Eyebrow>Group practice test</Eyebrow>
            <h2>Full practice exam with your class</h2>
            {settings.practice_test_when ? <p><strong>{settings.practice_test_when}</strong></p> : <p>Your instructor will post the date and Zoom link here.</p>}
            {isHttpUrl(settings.practice_test_link) && (
              <a class="btn btn-primary" href={settings.practice_test_link} rel="noopener" style="align-self:flex-start">Join on Zoom</a>
            )}
          </section>
          <section class="card">
            <h2>Your last weak areas</h2>
            {scores.length ? (
              scores.map((s) => (
                <a class="row between" href="/create-test" style="text-decoration:none;color:inherit;border-top:1px solid var(--line-soft);padding-top:10px">
                  <strong>{s.name}</strong><span class="chip chip-sand">{s.pct}% · Practice</span>
                </a>
              ))
            ) : (
              <p class="muted">Answer at least 5 questions in an area to see it here.</p>
            )}
          </section>
        </div>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var k='u100-exam-steps';var s={};try{s=JSON.parse(localStorage.getItem(k)||'{}')}catch(e){}document.querySelectorAll('[data-step]').forEach(function(b){b.checked=!!s[b.dataset.step];b.addEventListener('change',function(){s[b.dataset.step]=b.checked;try{localStorage.setItem(k,JSON.stringify(s))}catch(e){}})})})();`,
        }}
      />
    </PortalLayout>,
  );
});

// ---------- One-on-one booking ----------

portal.get('/book', async (c) => {
  const settings = await getSettings(c.env.DB);
  if (isHttpUrl(settings.calendly_url)) return c.redirect(settings.calendly_url);
  return c.html(
    <PortalLayout title="1-on-1" active="book" user={c.get('user')!}>
      <Eyebrow>Help</Eyebrow>
      <h1>Book a one-on-one session</h1>
      <p class="muted">Online booking opens soon. Until then, email {settings.contact_email} to book.</p>
    </PortalLayout>,
  );
});
