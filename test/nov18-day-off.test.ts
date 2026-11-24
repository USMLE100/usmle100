import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ensureMigrated, statements } from '../src/lib/migrate';
import { currentCohort, dayDate, dayOfDate, fmtDate, ymdToUtc } from '../src/lib/content';
import sql from '../migrations/0038_nov18_day_off.sql';

// Owner, 23 Nov 2026: no class Wed 18 Nov (weather). Lectures after it move back one day number, dates stay right.
describe('18 Nov day off', () => {
  it('renumbers Days 9-11 to 8-10 with their real dates, and runs only once', async () => {
    const db = env.DB;
    await ensureMigrated(db);
    await db.prepare("DELETE FROM cohorts WHERE start_date = '2026-11-09'").run();
    const cid = Number((await db.prepare("INSERT INTO cohorts (name, start_date, lecture_days, total_days) VALUES ('Fall 2026', '2026-11-09', 90, 100)").run()).meta.last_row_id);
    for (const d of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11]) await db.prepare("INSERT INTO lectures (cohort_id, day_number, title, status) VALUES (?, ?, ?, 'live')").bind(cid, d, `rec ${d}`).run();
    const run = () => db.batch(statements(sql).map((s) => db.prepare(s)));
    await run();
    const rows = (await db.prepare('SELECT day_number d, title FROM lectures WHERE cohort_id = ? ORDER BY day_number').bind(cid).all<any>()).results;
    expect(rows.map((r: any) => `${r.d}:${r.title}`)).toEqual(['1:rec 1', '2:rec 2', '3:rec 3', '4:rec 4', '5:rec 5', '6:rec 6', '7:rec 7', '8:rec 9', '9:rec 10', '10:rec 11']);
    const c = (await currentCohort(db, cid))!;
    const date = (d: number) => fmtDate(dayDate(c, d), { month: 'short', day: 'numeric' });
    expect([date(7), date(8), date(9), date(10), date(11)]).toEqual(['Nov 17', 'Nov 19', 'Nov 20', 'Nov 23', 'Nov 24']);
    expect(dayOfDate(c, ymdToUtc('2026-11-24'))).toBe(11);
    await run(); // a second run changes nothing
    const again = (await db.prepare('SELECT day_number d FROM lectures WHERE cohort_id = ? ORDER BY day_number').bind(cid).all<any>()).results.map((r: any) => r.d);
    expect(again).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await db.prepare('DELETE FROM lectures WHERE cohort_id = ?').bind(cid).run();
    await db.prepare('DELETE FROM cohort_days_off WHERE cohort_id = ?').bind(cid).run();
    await db.prepare('DELETE FROM cohorts WHERE id = ?').bind(cid).run();
  });
});
