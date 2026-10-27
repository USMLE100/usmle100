import m0001 from '../../migrations/0001_init.sql';
import m0002 from '../../migrations/0002_seed.sql';
import m0003 from '../../migrations/0003_settings.sql';
import m0004 from '../../migrations/0004_days_off.sql';
import m0005 from '../../migrations/0005_zoom_imports.sql';
import m0006 from '../../migrations/0006_evening.sql';
import m0007 from '../../migrations/0007_evening_periods.sql';
import m0008 from '../../migrations/0008_evening_classes.sql';
import m0009 from '../../migrations/0009_lecture_access.sql';
import m0010 from '../../migrations/0010_login_limits_and_resets.sql';
import m0011 from '../../migrations/0011_phase2.sql';
import m0012 from '../../migrations/0012_book_purchases.sql';
import m0013 from '../../migrations/0013_refunds.sql';
import m0014 from '../../migrations/0014_owner_security.sql';
import m0015 from '../../migrations/0015_viewing.sql';
import m0016 from '../../migrations/0016_accounts.sql';
import m0017 from '../../migrations/0017_recording_approval.sql';
import m0018 from '../../migrations/0018_webinars.sql';
import m0019 from '../../migrations/0019_payments_ops.sql';

/**
 * Database migrations run by the Worker itself on first request, so deploys
 * need no extra database permissions. Add new files to the end of this list.
 */
const MIGRATIONS: [string, string][] = [
  ['0001_init', m0001],
  ['0002_seed', m0002],
  ['0003_settings', m0003],
  ['0004_days_off', m0004],
  ['0005_zoom_imports', m0005],
  ['0006_evening', m0006],
  ['0007_evening_periods', m0007],
  ['0008_evening_classes', m0008],
  ['0009_lecture_access', m0009],
  ['0010_login_limits_and_resets', m0010],
  ['0011_phase2', m0011],
  ['0012_book_purchases', m0012],
  ['0013_refunds', m0013],
  ['0014_owner_security', m0014],
  ['0015_viewing', m0015],
  ['0016_accounts', m0016],
  ['0017_recording_approval', m0017],
  ['0018_webinars', m0018],
  ['0019_payments_ops', m0019],
];

function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let done: Promise<void> | null = null;

export function ensureMigrated(db: D1Database): Promise<void> {
  if (!done) {
    done = run(db).catch((e) => {
      done = null;
      throw e;
    });
  }
  return done;
}

async function run(db: D1Database) {
  await db.prepare('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))').run();
  const applied = new Set((await db.prepare('SELECT name FROM _migrations').all<{ name: string }>()).results.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    try {
      // One transaction: the migration's statements plus its record. A concurrent run fails and rolls back.
      await db.batch([...statements(sql).map((s) => db.prepare(s)), db.prepare('INSERT INTO _migrations (name) VALUES (?)').bind(name)]);
    } catch (e) {
      const now = await db.prepare('SELECT 1 FROM _migrations WHERE name = ?').bind(name).first();
      if (!now) throw e;
    }
  }
}
