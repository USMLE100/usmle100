import { Hono, type Context } from 'hono';
import type { AppEnv, User } from '../lib/types';
import { isStaff } from '../lib/types';
import { requireEnrolled } from '../lib/auth';
import { PortalLayout, PageHead, Eyebrow, Flash, initials } from '../views/layout';
import { Icon, type IconName } from '../views/icons';
import { lecturesEndedOn, lecturesEndedPage, lectureNotice, LectureNotice } from '../views/lectureAccess';
import { examCountdown } from '../lib/countdown';
import { queueSummary } from '../lib/cards';
import { bunnyEmbedUrl, cohortDay, currentCohort, defaultLecturesUntil, dayDate, dayOfDate, fmtDate, dayOffLabel, isClassDate, isOffToday, LETTERS, todayUtc, ymdToUtc, type Cohort } from '../lib/content';
import { filterQuestions, questionStatuses, scoresBy, shuffle, type Pools } from '../lib/qbank';
import { getSettings, isHttpUrl } from '../lib/settings';
import { CLASSES_PER_MONTH, eveningAccess, GRACE_DAYS, nextStart, type EveningSession } from '../lib/evening';
import { activityByDay, ago, GOAL_QUESTIONS, latestActivity, questionsToday, STREAK_MIN_QUESTIONS, streakFrom } from '../lib/activity';

export const portal = new Hono<AppEnv>();
portal.use('*', async (c, next) => {
  // Someone who only buys Evening Questions has no program enrollment: let them into that section only.
  // Someone who only bought the Course Book on its own gets the Course Book pages; with both, both.
  const user = c.get('user');
  if (user && !isStaff(user) && !c.get('enrollment')) {
    const sections: string[] = [];
    if (await eveningAccess(c.env.DB, user)) sections.push('/evening');
    if (await c.env.DB.prepare('SELECT 1 FROM book_access WHERE user_id = ?').bind(user.id).first()) sections.push('/course-book');
    if (sections.length) {
      if (sections.some((p) => c.req.path === p || c.req.path.startsWith(p + '/'))) return next();
      return c.redirect(sections[0]);
    }
  }
  return requireEnrolled(c, next);
});

export type Lecture = { id: number; day_number: number; title: string; zoom_url: string | null; bunny_video_id: string | null; status: string; completed_at: string | null; subject_id?: number | null };

export async function lecturesFor(db: D1Database, cohortId: number, userId: number) {
  const { results } = await db
    .prepare(
      `SELECT l.id, l.day_number, l.title, l.zoom_url, l.bunny_video_id, l.status, l.subject_id, p.completed_at
       FROM lectures l LEFT JOIN lecture_progress p ON p.lecture_id = l.id AND p.user_id = ?
       WHERE l.cohort_id = ? ORDER BY l.day_number`,
    )
    .bind(userId, cohortId)
    .all<Lecture>();
  return results;
}

const longDate = (t: number | Date) => fmtDate(new Date(t), { month: 'long', day: 'numeric' });
const shortMonth = (t: number) => fmtDate(new Date(t), { month: 'short', day: 'numeric' });
const firstName = (u: User) => u.name.split(' ')[0];

// ---------- Dashboard ----------

/** V12 month cards, Monday first. */
export function Calendar(props: { cohort: Cohort; lectures: Lecture[] }) {
  const { cohort } = props;
  const byDay = new Map(props.lectures.map((l) => [l.day_number, l]));
  const first = dayDate(cohort, 1);
  const last = dayDate(cohort, cohort.total_days);
  const todayT = todayUtc();
  // Start at this month when the course hasn't begun yet, so today is always on the calendar.
  const from = new Date(Math.min(first.getTime(), todayT));
  const months: { y: number; m: number }[] = [];
  for (let y = from.getUTCFullYear(), m = from.getUTCMonth(); y < last.getUTCFullYear() || (y === last.getUTCFullYear() && m <= last.getUTCMonth()); m === 11 ? (y++, (m = 0)) : m++) months.push({ y, m });
  return (
    <div class="months">
      {months.map(({ y, m }) => {
        const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
        const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const isCurrent = new Date(todayT).getUTCFullYear() === y && new Date(todayT).getUTCMonth() === m;
        const cells = [];
        for (let i = 0; i < lead; i++) cells.push(<span class="day blank" aria-hidden="true"></span>);
        for (let d = 1; d <= days; d++) {
          const t = Date.UTC(y, m, d);
          const off = !isClassDate(cohort, t);
          const holiday = dayOffLabel(cohort, t);
          const n = dayOfDate(cohort, t);
          const lec = off ? undefined : byDay.get(n);
          let cls = 'day day-up';
          let label = fmtDate(new Date(t));
          if (holiday) (cls = 'day day-holiday'), (label += `, ${holiday}, no class`);
          else if (t === todayT) (cls = 'day day-today'), (label += off ? ', today' : `, today, day ${n}`);
          else if (off) (cls = 'day day-out'), (label += ', weekend');
          else if (t < first.getTime() || t > last.getTime()) cls = 'day day-out';
          else if (lec?.completed_at) (cls = 'day day-done'), (label += ', completed');
          else if (t < todayT && lec?.status === 'live') (cls = 'day day-missed'), (label += ', missed');
          else if (n > cohort.lecture_days) (cls = 'day day-exam'), (label += ', exam window');
          cells.push(
            lec && lec.status === 'live' ? (
              <a href={`/lectures/${lec.id}`} class={cls} aria-label={label}>{d}</a>
            ) : (
              <span class={cls} aria-label={label}>{d}</span>
            ),
          );
        }
        return (
          <section class={'month' + (isCurrent ? ' current' : '')}>
            <div class="month-head">
              <h3>{new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h3>
              <span class="chip">{isCurrent ? `Today · ${shortMonth(todayT)}` : `${fmtDate(new Date(Date.UTC(y, m, 1)), { month: 'short' })} 1–${days}`}</span>
            </div>
            <div class="month-grid">
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((h) => (
                <span class="dow" aria-hidden="true">{h}</span>
              ))}
              {cells}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const Tile = (p: { href: string; tone: string; icon: IconName; title: string; sub: string }) => (
  <a class={`tile tile-${p.tone}`} href={p.href}>
    <span class="ti"><Icon name={p.icon} size={20} /></span>
    <strong>{p.title}</strong>
    <span class="sub">{p.sub}</span>
  </a>
);

const Ring = (p: { pct: number; color?: string; label: string }) => (
  <div class="ring" style={`--p:${Math.max(0, Math.min(100, p.pct))};${p.color ? `--c:${p.color}` : ''}`} role="img" aria-label={p.label}>
    <b>{p.pct}%</b>
  </div>
);

portal.get('/dashboard', async (c) => {
  const user = c.get('user')!;
  const enr = c.get('enrollment');
  const db = c.env.DB;
  const cohort = await currentCohort(db, enr?.cohort_id);
  if (!cohort) {
    return c.html(
      <PortalLayout shell={c.get('shell')} title="Home" active="home" user={user}>
        <div class="welcome"><span class="avatar">{initials(user.name)}</span><h1>Welcome back, {firstName(user)}</h1></div>
        <Flash kind="error">No cohort is scheduled yet. {isStaff(user) ? <a href="/admin/lectures">Create one in Admin → Lectures.</a> : 'Your start date will appear here soon.'}</Flash>
      </PortalLayout>,
    );
  }
  const today = cohortDay(cohort);
  const todayT = todayUtc();
  const weekend = isOffToday(cohort);
  const [lectures, statuses, byDay, activity, openTest, subjectRows, evening] = await Promise.all([
    lecturesFor(db, cohort.id, user.id),
    questionStatuses(db, user.id),
    activityByDay(db, user.id),
    latestActivity(db, user.id, 5),
    db
      .prepare(
        `SELECT t.id, t.mode, COUNT(ti.position) AS n, MIN(CASE WHEN ti.chosen_index IS NULL THEN ti.position END) AS next
         FROM tests t JOIN test_items ti ON ti.test_id = t.id
         WHERE t.user_id = ? AND t.finished_at IS NULL GROUP BY t.id HAVING next IS NOT NULL ORDER BY t.id DESC LIMIT 1`,
      )
      .bind(user.id)
      .first<{ id: number; mode: string; n: number; next: number }>(),
    db
      .prepare(
        `SELECT s.id, s.name,
           (SELECT COUNT(*) FROM lectures l WHERE l.cohort_id = ?1 AND l.subject_id = s.id) AS lectures,
           (SELECT COUNT(*) FROM lectures l JOIN lecture_progress p ON p.lecture_id = l.id AND p.user_id = ?2 AND p.completed_at IS NOT NULL
              WHERE l.cohort_id = ?1 AND l.subject_id = s.id) AS watched,
           (SELECT COUNT(*) FROM questions q WHERE q.subject_id = s.id AND q.status = 'approved') AS questions,
           (SELECT COUNT(DISTINCT ti.question_id) FROM test_items ti JOIN tests t ON t.id = ti.test_id JOIN questions q ON q.id = ti.question_id
              WHERE t.user_id = ?2 AND q.subject_id = s.id AND ti.chosen_index IS NOT NULL) AS answered
         FROM subjects s ORDER BY s.sort`,
      )
      .bind(cohort.id, user.id)
      .all<{ id: number; name: string; lectures: number; watched: number; questions: number; answered: number }>(),
    eveningAccess(db, user),
  ]);
  const ended = await lecturesEndedOn(c, cohort);
  const [chapterRow, articles, faqs] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM book_chapters WHERE status = 'live'").first<{ n: number }>(),
    db.prepare("SELECT id, kicker, title, summary, author FROM articles WHERE status = 'live' ORDER BY sort, id LIMIT 6").all<{ id: number; kicker: string | null; title: string; summary: string | null; author: string | null }>(),
    db.prepare("SELECT question, answer FROM faqs WHERE status = 'live' ORDER BY sort, id").all<{ question: string; answer: string }>(),
  ]);
  const chapterCount = chapterRow?.n ?? 0;
  const countdown = examCountdown(user.exam ?? null, user.exam_date);
  const todays = lectures.find((l) => l.day_number === today);
  const done = lectures.filter((l) => l.completed_at).length;
  const missed = ended ? [] : lectures.filter((l) => l.day_number < today && l.status === 'live' && !l.completed_at);
  const answeredQs = statuses.filter((s) => s.status === 'correct' || s.status === 'incorrect');
  const correctQs = statuses.filter((s) => s.status === 'correct').length;
  const wrong = statuses.filter((s) => s.status === 'incorrect').length;
  const qPct = answeredQs.length ? Math.round((correctQs / answeredQs.length) * 100) : 0;
  const lPct = cohort.lecture_days ? Math.round((done / cohort.lecture_days) * 100) : 0;
  const streak = c.get('shell')?.streak ?? streakFrom(byDay);
  const qToday = questionsToday(byDay);
  const classToday = !ended && !weekend && today >= 1 && today <= cohort.lecture_days;
  const todayLectureDone = !!todays?.completed_at;

  // Continue where you left off: an unfinished test first, then today's or the oldest missed lecture.
  const nextLecture = ended ? undefined : todays && todays.status === 'live' && !todays.completed_at ? todays : missed[0];
  const cont = openTest
    ? { href: `/tests/${openTest.id}/${openTest.next}`, icon: 'quiz' as IconName, kicker: 'Continue your test', title: `${openTest.mode === 'timed' ? 'Timed' : openTest.mode === 'untimed' ? 'Untimed' : 'Tutor'} test · question ${openTest.next} of ${openTest.n}`, sub: 'Pick up where you stopped' }
    : nextLecture
      ? { href: `/lectures/${nextLecture.id}`, icon: 'play_circle' as IconName, kicker: nextLecture === todays ? "Today's lecture" : 'Catch up', title: nextLecture.title, sub: `Day ${nextLecture.day_number} · ${fmtDate(dayDate(cohort, nextLecture.day_number), { weekday: 'long', month: 'long', day: 'numeric' })}` }
      : null;

  const todayMsg = today < 1
    ? `Classes start ${fmtDate(dayDate(cohort, 1), { weekday: 'long', month: 'long', day: 'numeric' })}`
    : today > cohort.lecture_days
      ? 'Lectures are done. Time to book your exam.'
      : weekend
        ? `${dayOffLabel(cohort, todayT) ?? 'Weekend'} · no class today`
        : todays?.completed_at
          ? `Day ${today} lecture done`
          : todays?.status === 'live'
            ? `Day ${today}: ${todays.title}`
            : done
              ? `Day ${today} · the recording appears here after class`
              : 'Complete your first lecture to start the calendar';
  const subjects = subjectRows.results.filter((s) => s.lectures > 0 || s.questions > 0);

  return (
    c.html(
      <PortalLayout shell={c.get('shell')} title="Home" active="home" user={user} wide>
        <div class="welcome">
          <span class="avatar">{initials(user.name)}</span>
          <h1>Welcome back, {firstName(user)}</h1>
        </div>
        {countdown && <p class="muted small" style="margin-top:-8px">{countdown}</p>}
        <LectureNotice n={lectureNotice(c, cohort)} />
        {ended && <Flash>Your lecture recordings closed on {fmtDate(new Date(ended + 'T00:00:00Z'), { month: 'long', day: 'numeric', year: 'numeric' })}. The question bank and your progress stay open.</Flash>}

        {cont && (
          <a class="card continue" href={cont.href} style="text-decoration:none">
            <span class="ci"><Icon name={cont.icon} size={26} /></span>
            <span class="txt">
              <small>{cont.kicker}</small>
              <strong>{cont.title}</strong>
              <span>{cont.sub}</span>
            </span>
            <Icon name="chevron_right" />
          </a>
        )}

        <div class="tiles">
          <Tile href="/warmup" tone="warm" icon="bolt" title="Daily Warmup" sub="10 daily questions" />
          <Tile href="/lectures" tone="green" icon="play_circle" title="Lectures" sub="Video curriculum" />
          <Tile href="/course-book" tone="sky" icon="menu_book" title="USMLE100 Book" sub={chapterCount ? `${chapterCount} chapter${chapterCount === 1 ? '' : 's'} & PDFs` : 'Chapters & PDFs'} />
          <Tile href="/cards" tone="lilac" icon="cards" title="Flash Cards" sub="Active recall deck" />
          <Tile href="/performance" tone="rose" icon="monitoring" title="Performance" sub="Section analytics" />
          <Tile href="/book" tone="olive" icon="event" title="1-on-1 Tutoring" sub="Book with Dr. Khan" />
          <Tile href="/evening" tone="sky2" icon="videocam" title="Evening Questions" sub={evening ? 'Mon · Wed · Fri classes' : 'Live question classes'} />
          <Tile href="/qbank" tone="warm2" icon="quiz" title="Question Bank" sub="Custom tests & blocks" />
        </div>

        <h2 class="section-title" id="streak">Today</h2>
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));align-items:stretch">
          <section class="card">
            <h3>Today’s study goal</h3>
            {classToday ? (
              <div class={'goal-row' + (todayLectureDone ? ' done' : '')}>
                <span class="gi"><Icon name={todayLectureDone ? 'check' : 'play_circle'} size={20} /></span>
                <span class="gt">
                  <strong>Watch today’s lecture</strong>
                  <span>{todays ? (todays.status === 'live' ? todays.title : 'Recording appears after class') : 'Not posted yet'}</span>
                </span>
                {todays?.status === 'live' && !todayLectureDone && <a class="btn btn-outline btn-sm" href={`/lectures/${todays.id}`}>Watch</a>}
              </div>
            ) : null}
            <div class={'goal-row' + (qToday >= GOAL_QUESTIONS ? ' done' : '')}>
              <span class="gi"><Icon name={qToday >= GOAL_QUESTIONS ? 'check' : 'quiz'} size={20} /></span>
              <span class="gt">
                <strong>Answer {GOAL_QUESTIONS} questions</strong>
                <span>{Math.min(qToday, GOAL_QUESTIONS)} of {GOAL_QUESTIONS} today</span>
              </span>
              {qToday < GOAL_QUESTIONS && (
                <form method="post" action="/qbank/quick"><button class="btn btn-outline btn-sm" type="submit">Start</button></form>
              )}
            </div>
            <div class="bar"><i style={`width:${Math.min(100, Math.round((Math.min(qToday, GOAL_QUESTIONS) / GOAL_QUESTIONS) * 100))}%`}></i></div>
          </section>
          <section class="card card-cream">
            <h3>Study streak</h3>
            <div class="streak-big"><Icon name="fire" size={30} class={streak ? '' : 'muted'} />{streak}<small>day{streak === 1 ? '' : 's'}</small></div>
            <p class="small">A day counts when you watch a lecture or answer at least {STREAK_MIN_QUESTIONS} questions.</p>
          </section>
        </div>

        <div class="stats-2">
          <a class="ring-card" href="/lectures" style="text-decoration:none">
            <Ring pct={lPct} label={`${lPct}% of lectures completed`} />
            <span class="lbl">Lecture completion</span>
            <span class="sub">{done} of {cohort.lecture_days} lectures</span>
          </a>
          <a class="ring-card" href="/performance" style="text-decoration:none">
            <Ring pct={qPct} color={qPct && qPct < 60 ? '#c9a14a' : undefined} label={`${qPct}% of questions correct`} />
            <span class="lbl">Qbank performance</span>
            <span class="sub">{answeredQs.length ? `${correctQs} of ${answeredQs.length} correct` : 'No questions answered yet'}</span>
          </a>
        </div>

        <h2 class="section-title">Study Schedule</h2>
        <section class="card">
          <div class="sched-head">
            <span class="sched-num">{done}<small>/{cohort.lecture_days}</small></span>
            <span>
              <strong>Lectures completed</strong>
              <span>{cohort.lecture_days}-day structured study schedule</span>
            </span>
          </div>
          <div class="today-pill"><b>Today: {longDate(todayT)}</b><span>· {todayMsg}</span></div>
          <div class="bar"><i style={`width:${lPct}%`}></i></div>
          <div class="cal-legend">
            <span><i class="sw today"></i>Today ({shortMonth(todayT)})</span>
            <span><i class="sw done"></i>Completed</span>
            <span><i class="sw missed"></i>Missed</span>
            <span><i class="sw up"></i>Upcoming</span>
            <span><i class="sw exam"></i>Exam window</span>
            {cohort.daysOff?.size ? <span><i class="sw holiday"></i>Holiday</span> : null}
          </div>
          <Calendar cohort={cohort} lectures={lectures} />
        </section>

        {subjects.length > 0 && (
          <>
            <h2 class="section-title">Subjects</h2>
            <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))">
              {subjects.map((s) => (
                <section class="card subject">
                  <div class="subject-top">
                    <span class="subject-ic"><Icon name="school" size={22} /></span>
                    <div>
                      <strong>{s.name}</strong>
                      <span>{s.lectures} lecture{s.lectures === 1 ? '' : 's'} · {s.questions} question{s.questions === 1 ? '' : 's'}</span>
                    </div>
                  </div>
                  <div>
                    <div class="bar"><i style={`width:${s.questions ? Math.round((s.answered / s.questions) * 100) : 0}%`}></i></div>
                    <div class="bar-label">{s.answered} of {s.questions} questions answered</div>
                  </div>
                  <div>
                    <div class="bar"><i style={`width:${s.lectures ? Math.round((s.watched / s.lectures) * 100) : 0}%`}></i></div>
                    <div class="bar-label">{s.watched} of {s.lectures} lectures completed</div>
                  </div>
                </section>
              ))}
            </div>
          </>
        )}

        {!isStaff(user) && !user.onboarded_at && (
          <section class="card card-sage getting-started">
            <div class="eyebrow" style="color:var(--body)">Getting started</div>
            <h2>Select your subjects</h2>
            <p class="small">Tell us your exam and the subjects you want to start with, and your path puts them first.</p>
            <a class="btn btn-primary btn-block" href="/welcome">Browse subjects <Icon name="arrow_forward" size={18} /></a>
          </section>
        )}
        {articles.results.length > 0 && (
          <>
            <h2 class="section-title">Study Strategy</h2>
            <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))">
              {articles.results.map((a, i) => (
                <a class={'card strategy ' + (i % 2 ? 'card-sky' : 'card-cream')} href={`/articles/${a.id}`}>
                  <span class={'si ' + (i % 2 ? 'sky' : 'gold')}><Icon name={i % 2 ? 'verified' : 'lightbulb'} size={24} /></span>
                  <span class="txt">
                    <span class="eyebrow" style="color:var(--body)">{a.kicker ?? 'Study strategy'}</span>
                    <strong>{a.title}</strong>
                    {a.summary && <span>{a.summary}</span>}
                    {a.author && <span class="author"><span class="avatar avatar-sm">{initials(a.author)}</span>{a.author}</span>}
                  </span>
                </a>
              ))}
            </div>
          </>
        )}
        {faqs.results.length > 0 && (
          <>
            <h2 class="section-title">Frequently asked questions</h2>
            <div class="faq">
              {faqs.results.map((q) => (
                <details>
                  <summary>{q.question}<span class="pl"><Icon name="close" size={16} /></span></summary>
                  <p>{q.answer}</p>
                </details>
              ))}
            </div>
          </>
        )}

        <h2 class="section-title">Latest study activity</h2>
        <section class="card">
          {activity.length ? (
            <ul class="activity">
              {activity.map((a) => (
                <li>
                  <span class={'ai' + (a.kind === 'test' ? ' q' : '')}><Icon name={a.kind === 'test' ? 'quiz' : 'play_circle'} size={18} /></span>
                  <a href={a.href} style="text-decoration:none;flex:1">
                    <strong>{a.title}</strong>
                    <span>{a.detail} · {ago(a.at)}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">Nothing yet. Watched lectures and finished tests will show here.</p>
          )}
        </section>
        {wrong > 0 && (
          <p class="small muted">You have {wrong} question{wrong === 1 ? '' : 's'} to retry in <a href="/review">Review</a>.</p>
        )}
      </PortalLayout>,
    )
  );
});

// ---------- Lectures ----------

// ---------- Evening Questions (Mon/Wed/Fri recordings, own access) ----------

portal.get('/evening', async (c) => {
  const user = c.get('user')!;
  const acc = await eveningAccess(c.env.DB, user);
  if (!acc) {
    const settings = await getSettings(c.env.DB);
    const next = { d: await nextStart(c.env.DB, user.id) };
    return c.html(
      <PortalLayout shell={c.get('shell')} title="Evening Questions" active="evening" user={user}>
        <PageHead eyebrow="Evening Questions" title="Live question sessions" sub="Monday, Wednesday and Friday evenings with your instructor." />
        {next?.d && <Flash>Your next month of Evening Questions starts on {fmtDate(new Date(next.d + 'T00:00:00Z'), { weekday: 'long', month: 'long', day: 'numeric' })}.</Flash>}
        <section class="card card-sage">
          <h2>Evening Questions</h2>
          <p>Each month covers {CLASSES_PER_MONTH} classes, and you can rewatch them until {GRACE_DAYS} days after the 12th recording goes up.</p>
          <p>Included for 4 months with the <strong>Companion</strong>, <strong>Complete</strong> and <strong>MAX</strong> programs, or on its own for <strong>$160 a month</strong>.</p>
          <a class="btn btn-primary btn-block" href="/programs">See programs</a>
          {settings.contact_email && (
            <a class="btn btn-outline btn-block" href={`mailto:${settings.contact_email}?subject=${encodeURIComponent('USMLE100: Evening Questions')}`}>Ask about Evening Questions</a>
          )}
        </section>
      </PortalLayout>,
    );
  }
  const all = (await c.env.DB.prepare("SELECT * FROM evening_sessions WHERE status = 'live' ORDER BY session_date DESC").all<EveningSession>()).results;
  const sessions = acc.staff ? all : all.filter((e) => acc.visible.has(e.id));
  const long = (d: string) => fmtDate(new Date(d + 'T00:00:00Z'), { weekday: 'long', month: 'long', day: 'numeric' });
  const cur = acc.staff ? null : acc.current;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Evening Questions" active="evening" user={user}>
      <PageHead eyebrow="Evening Questions" title="Evening recordings" sub="Monday, Wednesday and Friday evening question sessions." />
      {cur && (
        <section class="card card-sage">
          <div class="row between">
            <strong style="font:700 17px var(--display);color:var(--ink)">Month {cur.month}{cur.months > 1 ? ` of ${cur.months}` : ''}</strong>
            <span class="chip">Class {cur.sessions.length} of {CLASSES_PER_MONTH}</span>
          </div>
          <div class="bar"><i style={`width:${Math.round((cur.sessions.length / CLASSES_PER_MONTH) * 100)}%`}></i></div>
          <p class="small">
            {cur.end
              ? <>All {CLASSES_PER_MONTH} classes are up. You can watch them until the end of <strong>{long(cur.end)}</strong>.</>
              : <>You can watch this month’s classes until {GRACE_DAYS} days after class {CLASSES_PER_MONTH} goes up.</>}
          </p>
        </section>
      )}
      {!sessions.length ? (
        <p class="muted">No recordings for this month yet. They appear here after each evening class.</p>
      ) : (
        <div class="lec-grid">
          {sessions.map((e) => (
            <article class="lec-card">
              <div class="lec-top"><span class="dot" aria-hidden="true"></span><span class="lec-num">{fmtDate(new Date(e.session_date + 'T00:00:00Z'), { weekday: 'short', month: 'short', day: 'numeric' })}</span><span class="tag">Video</span></div>
              <a class="lec-title" href={`/evening/${e.id}`}>{e.title}</a>
              <a class="btn btn-primary btn-block" href={`/evening/${e.id}`}><Icon name="play" size={18} />Watch</a>
            </article>
          ))}
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
  const watched = await c.env.DB.prepare('SELECT 1 FROM evening_progress WHERE user_id = ? AND session_id = ?').bind(user.id, e.id).first();
  return c.html(
    <PortalLayout shell={c.get('shell')} title={e.title} active="evening" user={user}>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/dashboard">Home</a><Icon name="chevron_right" size={16} /><a href="/evening">Evening Questions</a></nav>
      <div class="stack" style="gap:6px">
        <Eyebrow>{fmtDate(new Date(e.session_date + 'T00:00:00Z'), { weekday: 'long', month: 'long', day: 'numeric' })}</Eyebrow>
        <h1>{e.title}</h1>
      </div>
      {src ? (
        <div class="video-wrap">
          <iframe src={src} title={e.title} loading="lazy" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
          <span class="watermark" aria-hidden="true">{user.email}</span>
        </div>
      ) : (
        <Flash kind="error">{e.bunny_video_id ? 'This video can’t be played right now. Please try again later.' : 'The video for this session isn’t ready yet.'}</Flash>
      )}
      <section class="card" style="flex-direction:row;align-items:center;flex-wrap:wrap;gap:10px">
        {watched ? (
          <span class="tag" style="font-size:13px;padding:6px 12px"><Icon name="check_circle" size={16} />&nbsp;Watched</span>
        ) : (
          <form method="post" action={`/evening/${e.id}/done`}><button class="btn btn-primary" type="submit"><Icon name="check" size={18} />Mark as watched</button></form>
        )}
        <a class="btn btn-ghost" href="/evening">All evening sessions</a>
      </section>
    </PortalLayout>,
  );
});

// ---------- Question Bank ----------

portal.get('/qbank', async (c) => {
  const user = c.get('user')!;
  const rows = await questionStatuses(c.env.DB, user.id);
  const n = (k: string) => rows.filter((r) => r.status === k).length;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Question Bank" active="qbank" user={user}>
      {c.req.query('error') && <Flash kind="error">{c.req.query('error')}</Flash>}
      <section class="card hero-block">
        <span class="hi"><Icon name="quiz" size={40} /></span>
        <h1 style="font-size:24px">Ready for a Question Block?</h1>
        <p>Start a quick 10-question tutor block immediately or build a custom test filtered by pool, subject, and system.</p>
        <form method="post" action="/qbank/quick" style="display:contents">
          <button class="btn btn-primary" type="submit" disabled={!rows.length}><Icon name="bolt" size={18} />Start quick 10-Q block</button>
        </form>
        <a class="btn btn-outline" href="/create-test"><Icon name="filter" size={18} />Custom test builder</a>
      </section>
      <div class="stat-tiles">
        <div class="stat s1"><b>{n('unused')}</b><span>unused</span></div>
        <div class="stat s2"><b>{n('correct')}</b><span>correct</span></div>
        <div class="stat s4"><b>{n('incorrect')}</b><span>incorrect</span></div>
        <div class="stat s3"><b>{rows.filter((r) => r.flagged).length}</b><span>flagged</span></div>
      </div>
      {!rows.length && <p class="muted">No questions are in the bank yet.</p>}
    </PortalLayout>,
  );
});

/** A 10-question tutor block: unused questions first, then ones answered wrong, then anything. */
portal.post('/qbank/quick', async (c) => {
  const user = c.get('user')!;
  const rows = await questionStatuses(c.env.DB, user.id);
  const order = ['unused', 'incorrect', 'omitted', 'correct'];
  const picked = order.flatMap((k) => shuffle(rows.filter((r) => r.status === k))).slice(0, 10);
  if (!picked.length) return c.redirect('/qbank?error=' + encodeURIComponent('No questions are in the bank yet.'));
  const t = await c.env.DB.prepare("INSERT INTO tests (user_id, mode) VALUES (?, 'tutor')").bind(user.id).run();
  const testId = Number(t.meta.last_row_id);
  await c.env.DB.batch(picked.map((q, i) => c.env.DB.prepare('INSERT INTO test_items (test_id, position, question_id) VALUES (?, ?, ?)').bind(testId, i + 1, q.id)));
  return c.redirect(`/tests/${testId}/1`);
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
  const max = Math.max(1, Math.min(40, rows.length || 1));
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Create a test" active="create" user={user}>
      <PageHead title="Create a test" sub="Configure your custom exam session using question activity and subject filters." />
      {err && <Flash kind="error">{err}</Flash>}
      <form method="post" class="stack" id="builder">
        <fieldset class="card" style="border:1px solid var(--line);margin:0">
          <legend class="sr">Grading mode</legend>
          <h2>How should it grade you?</h2>
          <div class="opt-list">
            {[
              ['tutor', 'Tutor', 'Answer shown as you go'],
              ['timed', 'Timed', 'Clock on, exam conditions'],
              ['untimed', 'Untimed', 'No clock, graded at the end'],
            ].map(([v, l, s], i) => (
              <label class="opt opt-radio">
                <input type="radio" name="mode" value={v} checked={i === 0} />
                <span class="ot"><strong>{l}</strong><span>{s}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset class="card" style="border:1px solid var(--line);margin:0">
          <legend class="sr">Question pools</legend>
          <h2>Which Questions?</h2>
          <div class="opt-list">
            {POOLS.map((p) => (
              <label class="opt">
                <input type="checkbox" name="pool" value={p.key} checked={p.key === pre} data-count={String(count(p.key))} />
                <span class="ot"><strong>{p.label}</strong><span>{p.sub}</span></span>
                <span class="count">{count(p.key)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <section class="card">
          <div class="row between">
            <h2>Select Subjects</h2>
            <button type="button" class="sel-all" id="selall"><Icon name="check_circle" size={18} /><span>Select All Subjects</span></button>
          </div>
          <div class="tabs" role="tablist">
            <button type="button" class="on" role="tab" aria-selected="true" data-pane="subjects">Subjects ({subjects.results.length})</button>
            <button type="button" role="tab" aria-selected="false" data-pane="systems">Systems ({systems.results.length})</button>
          </div>
          <p class="muted small">Leave all unticked to include everything.</p>
          <div class="pane opt-grid" id="pane-subjects">
            {subjects.results.map((s) => (
              <label class="pick"><input type="checkbox" name="subject" value={String(s.id)} />{s.name}</label>
            ))}
          </div>
          <div class="pane opt-grid" id="pane-systems" hidden>
            {systems.results.map((s) => (
              <label class="pick"><input type="checkbox" name="system" value={String(s.id)} />{s.name}</label>
            ))}
          </div>
        </section>
        <section class="card">
          <h2>How many questions?</h2>
          <div class="count-row">
            <input type="number" name="count" id="qcount" min="1" max={String(max)} value={String(Math.min(10, max))} aria-label="Number of questions" />
            <input type="range" id="qrange" min="1" max={String(max)} value={String(Math.min(10, max))} aria-label="Number of questions" />
          </div>
          <span class="small" style="color:var(--green);font-weight:600">{rows.length} available</span>
        </section>
        <button class="btn btn-primary btn-block" type="submit" id="startbtn"><Icon name="play" size={18} /><span>Start {Math.min(10, max)}-question test</span></button>
      </form>
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var n=document.getElementById('qcount'),r=document.getElementById('qrange'),b=document.querySelector('#startbtn span');function set(v){n.value=v;r.value=v;b.textContent='Start '+v+'-question test';}n.addEventListener('input',function(){set(n.value)});r.addEventListener('input',function(){set(r.value)});var tabs=document.querySelectorAll('[data-pane]'),cur='subjects',sa=document.getElementById('selall');function boxes(){return document.querySelectorAll('#pane-'+cur+' input[type=checkbox]')}function label(){var all=[].every.call(boxes(),function(x){return x.checked});sa.querySelector('span').textContent=(all?'Clear all ':'Select all ')+(cur==='subjects'?'subjects':'systems');}tabs.forEach(function(t){t.addEventListener('click',function(){cur=t.dataset.pane;tabs.forEach(function(x){var on=x===t;x.classList.toggle('on',on);x.setAttribute('aria-selected',on);document.getElementById('pane-'+x.dataset.pane).hidden=!on;});label();});});sa.addEventListener('click',function(){var bs=boxes(),all=[].every.call(bs,function(x){return x.checked});bs.forEach(function(x){x.checked=!all});label();});document.getElementById('builder').addEventListener('change',label);label();})();`,
        }}
      />
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
type Q = { id: number; stem: string; choices_json: string; correct_index: number; explanation: string; wrong_explanations_json: string | null; bottom_line: string | null; image_url: string | null; subject_id: number | null; system_id: number | null };

async function loadTest(c: Context<AppEnv>, id: number) {
  const user = c.get('user')!;
  const test = await c.env.DB.prepare('SELECT * FROM tests WHERE id = ? AND user_id = ?').bind(id, user.id).first<{ id: number; mode: string; finished_at: string | null; created_at: string }>();
  if (!test) return null;
  const items = (await c.env.DB.prepare('SELECT position, question_id, chosen_index, is_correct, flagged FROM test_items WHERE test_id = ? ORDER BY position').bind(id).all<Item>()).results;
  return { test, items };
}

const modeName = (m: string) => (m === 'timed' ? 'Timed' : m === 'untimed' ? 'Untimed' : m === 'warmup' ? 'Daily Warmup' : 'Tutor');
/** Tutor and Daily Warmup show the answer straight after each question and lock the first answer. */
const instant = (m: string) => m === 'tutor' || m === 'warmup';

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
  const tags = await c.env.DB.prepare('SELECT (SELECT name FROM subjects WHERE id = ?) AS subject, (SELECT name FROM systems WHERE id = ?) AS system').bind(q.subject_id, q.system_id).first<{ subject: string | null; system: string | null }>();
  const choices: string[] = JSON.parse(q.choices_json);
  const wrongEx: Record<string, string> = q.wrong_explanations_json ? JSON.parse(q.wrong_explanations_json) : {};
  const answered = item.chosen_index != null;
  const reveal = !!test.finished_at || (instant(test.mode) && answered);
  const total = items.length;
  const deadline = test.mode === 'timed' && !test.finished_at ? Date.parse(test.created_at.replace(' ', 'T') + 'Z') + total * 90_000 : null;

  return c.html(
    <PortalLayout shell={c.get('shell')} title={`Question ${pos} of ${total}`} active="test" user={user}>
      <h1 class="sr">Question {pos} of {total}</h1>
      <section class="card qhead">
        <div class="qbar">
          <a class="x" href={test.finished_at ? `/tests/${id}/results` : '/qbank'} aria-label={test.finished_at ? 'Back to results' : 'Leave the test (your answers are saved)'}><Icon name="close" /></a>
          <strong>{test.finished_at ? 'Review' : test.mode === 'warmup' ? 'Daily Warmup' : `${modeName(test.mode)} test`}</strong>
          <span class="pos">{pos} / {total}</span>
          {deadline && <span class="clock" id="timer" data-deadline={String(deadline)} data-finish={`/tests/${id}/finish`}>–:––</span>}
          {test.mode === 'warmup' && !test.finished_at && <span class="clock" id="elapsed" data-start={String(Date.parse(test.created_at.replace(' ', 'T') + 'Z'))}>0:00</span>}
        </div>
        <div class="bar thin"><i style={`width:${Math.round((items.filter((i) => i.chosen_index != null).length / total) * 100)}%`}></i></div>
      </section>
      <section class="card qcard">
        <nav class="qnav" aria-label="Questions">
          {items.map((i) => (
            <a
              href={`/tests/${id}/${i.position}`}
              class={i.position === pos ? 'on' : (test.finished_at || instant(test.mode)) && i.chosen_index != null ? (i.is_correct ? 'ans' : 'wrong') : i.chosen_index != null ? 'ans' : ''}
              aria-current={i.position === pos ? 'true' : undefined}
            >
              {i.position}{i.flagged ? '⚑' : ''}
            </a>
          ))}
        </nav>
        <p class="stem">{q.stem}</p>
        {q.image_url && <img src={q.image_url} alt="Question image" style="max-width:100%;border-radius:12px" />}
        {(tags?.subject || tags?.system) && <p class="qtags">{[tags?.subject, tags?.system].filter(Boolean).join(' · ')}</p>}
        <form method="post" action={`/tests/${id}/${pos}`} class="stack" style="gap:10px">
          {choices.map((ch, idx) => {
            let cls = 'choice' + (reveal ? ' locked' : '');
            if (reveal && idx === q.correct_index) cls += ' choice-correct';
            else if (reveal && idx === item.chosen_index) cls += ' choice-wrong';
            return (
              <label class={cls}>
                <input type="radio" name="choice" value={String(idx)} checked={item.chosen_index === idx} disabled={reveal} required />
                <span class="letter">{LETTERS[idx]}</span>
                <span>{ch}</span>
              </label>
            );
          })}
          {!reveal && (
            <><input type="hidden" name="secs" value="" data-secs /><button class="btn btn-primary btn-block" type="submit">{instant(test.mode) ? 'Submit answer' : 'Save and next'}</button></>
          )}
        </form>
        <div class="row">
          <form method="post" action={`/tests/${id}/${pos}/flag`}>
            <button class="btn btn-ghost btn-sm" type="submit"><Icon name={item.flagged ? 'flag' : 'flag_outline'} size={18} />{item.flagged ? 'Unflag' : 'Flag for later'}</button>
          </form>
          {pos > 1 && <a class="btn btn-ghost btn-sm" href={`/tests/${id}/${pos - 1}`}>Previous</a>}
          {pos < total && <a class="btn btn-ghost btn-sm" href={`/tests/${id}/${pos + 1}`}>Next</a>}
          {!test.finished_at && (
            <form method="post" action={`/tests/${id}/finish`}>
              <button class="btn btn-outline btn-sm" type="submit">End test</button>
            </form>
          )}
          {test.finished_at && <a class="btn btn-outline btn-sm" href={`/tests/${id}/results`}>Results</a>}
        </div>
      </section>
      {reveal && (
        <section class={'card explain ' + (item.chosen_index == null ? '' : item.is_correct ? 'ok' : 'bad')}>
          <h2>{item.chosen_index == null ? 'Not answered' : item.is_correct ? 'Correct' : 'Incorrect'} · the answer is {LETTERS[q.correct_index]}</h2>
          <p>{q.explanation}</p>
          {Object.entries(wrongEx).map(([k, v]) => (
            <p><strong>Choice {LETTERS[Number(k)]}:</strong> {v}</p>
          ))}
          {q.bottom_line && <p class="bl"><strong>Bottom line:</strong> {q.bottom_line}</p>}
        </section>
      )}
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var t0=Date.now();document.querySelectorAll('[data-secs]').forEach(function(i){i.form.addEventListener('submit',function(){i.value=Math.round((Date.now()-t0)/1000)})});var e=document.getElementById('elapsed');if(e){var s0=+e.dataset.start;(function tick(){var s=Math.max(0,Math.round((Date.now()-s0)/1000));e.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');setTimeout(tick,1000)})()}})();`,
        }}
      />
      {deadline && (
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var el=document.getElementById('timer');if(!el)return;var d=+el.dataset.deadline;function tick(){var s=Math.max(0,Math.round((d-Date.now())/1000));el.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');el.classList.toggle('low',s<60);if(s<=0){var f=document.createElement('form');f.method='post';f.action=el.dataset.finish;document.body.appendChild(f);f.submit();return;}setTimeout(tick,1000);}tick();})();`,
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
  if (instant(loaded.test.mode) && item.chosen_index != null) return c.redirect(`/tests/${id}/${pos}`);
  // Seconds on this question, measured in the page (for Performance: seconds per question). Kept within 1–900.
  const secs = Math.round(Number(f.secs));
  await c.env.DB.prepare(`UPDATE test_items SET chosen_index = ?, is_correct = ?, answered_at = datetime('now'), seconds = COALESCE(seconds, 0) + ? WHERE test_id = ? AND position = ?`)
    .bind(choice, choice === q.correct_index ? 1 : 0, Number.isFinite(secs) && secs > 0 ? Math.min(900, secs) : null, id, pos)
    .run();
  const next = instant(loaded.test.mode) ? pos : Math.min(pos + 1, loaded.items.length);
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
  const { test, items } = loaded;
  const correct = items.filter((i) => i.is_correct === 1).length;
  const answered = items.filter((i) => i.chosen_index != null).length;
  const pct = items.length ? Math.round((correct / items.length) * 100) : 0;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Test results" active="results" user={user}>
      <PageHead eyebrow="Results" title={`${pct}% correct`} sub={`${modeName(test.mode)} test · ${items.length} question${items.length === 1 ? '' : 's'}`} />
      <section class="card" style="flex-direction:row;align-items:center;gap:18px">
        <Ring pct={pct} color={pct < 60 ? '#c9a14a' : undefined} label={`${pct}% correct`} />
        <div class="stack" style="gap:4px">
          <span><strong>{correct}</strong> correct</span>
          <span><strong>{answered - correct}</strong> incorrect</span>
          <span><strong>{items.length - answered}</strong> omitted</span>
        </div>
      </section>
      <section class="card">
        <h2>Review your answers</h2>
        <p class="muted small">Open any question to see the explanation.</p>
        <nav class="qnav" aria-label="Review questions">
          {items.map((i) => (
            <a href={`/tests/${id}/${i.position}`} class={i.is_correct ? 'ans' : i.chosen_index != null ? 'wrong' : ''}>{i.position}{i.is_correct === 1 ? '✓' : i.chosen_index == null ? '–' : '✗'}</a>
          ))}
        </nav>
      </section>
      <div class="row">
        <a class="btn btn-primary" href="/create-test">New test</a>
        <a class="btn btn-ghost" href="/performance">Performance</a>
      </div>
    </PortalLayout>,
  );
});

// ---------- Performance ----------

const RANGES: { key: string; label: string; days: number | null }[] = [
  { key: '7', label: '7 days', days: 7 },
  { key: '30', label: '30 days', days: 30 },
  { key: '90', label: '90 days', days: 90 },
  { key: 'all', label: 'All time', days: null },
];

portal.get('/performance', async (c) => {
  const user = c.get('user')!;
  const range = RANGES.find((r) => r.key === c.req.query('range')) ?? RANGES[3];
  const since = range.days ? new Date(Date.now() - range.days * 86400_000).toISOString().slice(0, 19).replace('T', ' ') : undefined;
  const [bySystem, byDiscipline, tests, pace] = await Promise.all([
    scoresBy(c.env.DB, user.id, 'perf_system', since),
    scoresBy(c.env.DB, user.id, 'discipline', since),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM tests WHERE user_id = ? AND finished_at IS NOT NULL AND (? IS NULL OR finished_at >= ?)').bind(user.id, since ?? null, since ?? null).first<{ n: number }>(),
    c.env.DB.prepare('SELECT AVG(ti.seconds) AS s FROM test_items ti JOIN tests t ON t.id = ti.test_id WHERE t.user_id = ? AND ti.seconds IS NOT NULL AND (? IS NULL OR ti.answered_at >= ?)').bind(user.id, since ?? null, since ?? null).first<{ s: number | null }>(),
  ]);
  const total = bySystem.reduce((a, s) => a + s.answered, 0);
  const right = bySystem.reduce((a, s) => a + s.correct, 0);
  const List = (p: { title: string; rows: typeof bySystem }) => (
    <section class="stack" style="gap:10px">
      <h2 class="section-title">{p.title}</h2>
      <div class="perf-list">
        {p.rows.map((r, i) => {
          const pct = r.answered ? Math.round((r.correct / r.answered) * 100) : null;
          return (
            <div class="perf-row">
              <div class="pr"><span><em>{i + 1}.</em>{r.name}</span><b class={pct == null ? 'none' : ''}>{pct == null ? '—' : `${pct}%`}</b></div>
              <div class={'bar' + (pct != null && pct < 60 ? ' bar-amber' : '')}><i style={`width:${pct ?? 0}%`}></i></div>
            </div>
          );
        })}
      </div>
    </section>
  );
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Performance" active="performance" user={user} wide>
      <section class="card page-card">
      <PageHead eyebrow="Progress" title="Performance" sub="Your actual completed question performance mapped by System and Discipline." />
      <nav class="pills" aria-label="Time range">
        {RANGES.map((r) => (
          <a href={`/performance?range=${r.key}`} class={r === range ? 'on' : ''} aria-current={r === range ? 'page' : undefined}>{r.label}</a>
        ))}
      </nav>
      <div class="stat-tiles">
        <div class="stat s1"><b>{total ? Math.round((right / total) * 100) : 0}%</b><span>correct</span></div>
        <div class="stat s2"><b>{total}</b><span>answered</span></div>
        <div class="stat s3"><b>{tests?.n ?? 0}</b><span>tests</span></div>
        <div class="stat s4"><b>{Math.round(pace?.s ?? 0)}s</b><span>per question</span></div>
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));align-items:start;gap:20px">
        <List title={`Performance by System (${bySystem.length})`} rows={bySystem} />
        <List title={`Performance by Discipline (${byDiscipline.length})`} rows={byDiscipline} />
      </div>
      <p class="muted small">Scores under 60% show in amber.</p>
      </section>
    </PortalLayout>,
  );
});

// ---------- Review & daily catch-up ----------

portal.get('/review', async (c) => {
  const user = c.get('user')!;
  const cohort = await currentCohort(c.env.DB, c.get('enrollment')?.cohort_id);
  const lectures = cohort ? await lecturesFor(c.env.DB, cohort.id, user.id) : [];
  const today = cohort ? cohortDay(cohort) : 0;
  const todays = lectures.find((l) => l.day_number === today);
  const missed = lectures.filter((l) => l.day_number < today && l.status === 'live' && !l.completed_at);
  const rows = await questionStatuses(c.env.DB, user.id);
  const wrong = rows.filter((r) => r.status === 'incorrect').length;
  const flagged = rows.filter((r) => r.flagged).length;
  const cardQ = await queueSummary(c.env.DB, user.id);
  const RetryForm = (p: { pool: string; n: number; label: string }) => (
    <form method="post" action="/create-test">
      <input type="hidden" name="mode" value="tutor" />
      <input type="hidden" name="pool" value={p.pool} />
      <input type="hidden" name="count" value={String(Math.min(40, p.n))} />
      <button class="btn btn-primary btn-sm" type="submit">{p.label}</button>
    </form>
  );
  return c.html(
    <PortalLayout shell={c.get('shell')} title="Review" active="review" user={user}>
      <section class="card page-card">
      <div class="page-head with-ic">
        <span class="phi"><Icon name="replay" size={28} /></span>
        <div><h1>Review &amp; Daily Catch-Up</h1><p>Keep your study run solid by reviewing missed lectures and questions.</p></div>
      </div>
      <section class="card catch">
        <div class="catch-head"><Icon name="play_circle" size={20} />Lectures &amp; daily classes</div>
        {todays && todays.status === 'live' && !todays.completed_at ? (
          <div class="catch-item alert">
            <span class="txt"><strong>Today’s lecture is pending</strong><span>{todays.title}</span><span>Keep your {c.get('shell')?.streak ?? 0}-day streak alive before midnight.</span></span>
            <a class="btn btn-primary btn-sm" href={`/lectures/${todays.id}`}>Watch today</a>
          </div>
        ) : (
          <div class="catch-item">
            <span class="txt"><strong>{todays?.completed_at ? 'Today’s lecture is done' : 'Nothing due today'}</strong><span>{todays?.completed_at ? 'Nice work.' : 'New recordings appear after each class.'}</span></span>
            <span class="okic"><Icon name="check_circle" /></span>
          </div>
        )}
        {missed.length ? (
          missed.slice(0, 8).map((l) => (
            <div class="catch-item alert">
              <span class="txt"><strong>Day {l.day_number} · {l.title}</strong><span>Missed {fmtDate(dayDate(cohort!, l.day_number), { weekday: 'short', month: 'short', day: 'numeric' })}</span></span>
              <a class="btn btn-outline btn-sm" href={`/lectures/${l.id}`}>Watch</a>
            </div>
          ))
        ) : (
          <div class="catch-item"><span class="txt"><strong>No missed lectures</strong><span>You are up to date.</span></span><span class="okic"><Icon name="check_circle" /></span></div>
        )}
        {missed.length > 8 && <a class="small" href="/lectures">See all {missed.length} missed lectures</a>}
      </section>
      <section class="card catch">
        <div class="catch-head"><Icon name="quiz" size={20} />Missed practice questions</div>
        {wrong ? (
          <div class="catch-item alert">
            <span class="txt"><strong>{wrong} question{wrong === 1 ? '' : 's'} to retry</strong><span>Answered incorrectly last time.</span></span>
            <RetryForm pool="incorrect" n={wrong} label="Retry" />
          </div>
        ) : (
          <div class="catch-item"><span class="txt"><strong>Zero unresolved questions</strong><span>All attempted questions are currently answered correctly.</span></span><span class="okic"><Icon name="check_circle" /></span></div>
        )}
        {flagged > 0 && (
          <div class="catch-item">
            <span class="txt"><strong>{flagged} flagged question{flagged === 1 ? '' : 's'}</strong><span>You marked these for later.</span></span>
            <RetryForm pool="custom" n={flagged} label="Practice" />
          </div>
        )}
      </section>
      <section class="card catch">
        <div class="catch-head"><Icon name="cards" size={20} />Flashcard Recall Queue</div>
        {cardQ.due ? (
          <div class="catch-item alert">
            <span class="txt"><strong>{cardQ.due} card{cardQ.due === 1 ? '' : 's'} to review</strong><span>Due today from the lectures you’ve watched.</span></span>
            <a class="btn btn-primary btn-sm" href="/cards">Review</a>
          </div>
        ) : (
          <div class="catch-item"><span class="txt"><strong>Cards up to date</strong><span>0 cards scheduled.{cardQ.next ? ` Next batch arrives ${fmtDate(new Date(cardQ.next + 'T00:00:00Z'), { weekday: 'long', month: 'short', day: 'numeric' })}.` : ''}</span></span><span class="okic"><Icon name="check_circle" /></span></div>
        )}
      </section>
      <div class="row between">
        <a class="link-btn" href="/dashboard">Back to Dashboard</a>
        <a class="btn btn-primary" href="/lectures">Browse all lectures</a>
      </div>
      </section>
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
    <PortalLayout shell={c.get('shell')} title="Exam window" active="exam" user={user}>
      <PageHead eyebrow={`Days ${cohort ? cohort.lecture_days + 1 : 91} to ${cohort?.total_days ?? 100}`} title="Your exam window" sub={cohort ? `${windowStart} to ${windowEnd}. Test centers fill up, so book your date first.` : undefined} />
      <section class="card card-cream">
        <Eyebrow>Group practice test</Eyebrow>
        <h2>Full practice exam with your class</h2>
        {settings.practice_test_when ? <p><strong>{settings.practice_test_when}</strong></p> : <p>Your instructor will post the date and Zoom link here.</p>}
        {isHttpUrl(settings.practice_test_link) && (
          <a class="btn btn-primary" href={settings.practice_test_link} rel="noopener" style="align-self:flex-start"><Icon name="videocam" size={18} />Join on Zoom</a>
        )}
      </section>
      <section class="card">
        <h2>Your exam checklist</h2>
        <div class="opt-list">
          {steps.map(([t, s], i) => (
            <label class="opt">
              <input type="checkbox" data-step={String(i)} />
              <span class="ot"><strong>{t}</strong><span>{s}</span></span>
            </label>
          ))}
        </div>
      </section>
      <section class="card">
        <h2>Your last weak areas</h2>
        {scores.length ? (
          <div class="perf-list">
            {scores.map((s) => (
              <a class="perf-row" href="/create-test" style="text-decoration:none">
                <div class="pr"><span>{s.name}</span><b>{s.pct}%</b></div>
                <div class={'bar' + (s.pct < 60 ? ' bar-amber' : '')}><i style={`width:${s.pct}%`}></i></div>
              </a>
            ))}
          </div>
        ) : (
          <p class="muted">Answer at least 5 questions in an area to see it here.</p>
        )}
      </section>
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
  const enr = c.get('enrollment');
  const booking = isHttpUrl(settings.calendly_url) ? settings.calendly_url : null;
  const used = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM tutoring_sessions WHERE user_id = ?').bind(c.get('user')!.id).first<{ n: number }>())?.n ?? 0;
  return c.html(
    <PortalLayout shell={c.get('shell')} title="1-on-1 Tutoring" active="book" user={c.get('user')!}>
      <PageHead eyebrow="1-on-1 Tutoring" title="Schedule a 1-on-1 Session" sub="Book a 60-minute private tutoring session with Dr. Khan over Zoom to review weak areas, NBME blocks, and exam strategy." />
      <section class="card card-sage">
        <h2>1-on-1 Tutoring</h2>
        <div class="stack" style="gap:8px">
          <span class="row" style="gap:10px"><Icon name="person" size={20} class="gic" />Dr. Khan</span>
          <span class="row" style="gap:10px"><Icon name="schedule" size={20} class="gic" />60 minutes</span>
          <span class="row" style="gap:10px"><Icon name="videocam" size={20} class="gic" />Live over Zoom</span>
        </div>
        <p class="small">Bring a topic, a failed block, or a stem you cannot crack. One hour, one student, no script.</p>
        {enr && enr.one_on_one_sessions > 0 && <p class="small"><strong>Your program includes {enr.one_on_one_sessions} sessions.</strong> You’ve had {used} so far{enr.one_on_one_sessions - used > 0 ? `, so ${enr.one_on_one_sessions - used} ${enr.one_on_one_sessions - used === 1 ? 'is' : 'are'} left` : ''}.</p>}
        {(!enr || !enr.one_on_one_sessions) && used > 0 && <p class="small">You’ve had {used} session{used === 1 ? '' : 's'}.</p>}
        {booking ? (
          <a class="btn btn-primary btn-2line" href={booking} rel="noopener" style="align-self:flex-start"><Icon name="event" size={24} /><span><strong>Open Booking Calendar</strong><small>60 min with Dr. Khan</small></span></a>
        ) : (
          <p>Online booking opens soon. Until then, email <a href={`mailto:${settings.contact_email}?subject=${encodeURIComponent('USMLE100: 1-on-1 session')}`}>{settings.contact_email}</a> to book.</p>
        )}
      </section>
    </PortalLayout>,
  );
});
