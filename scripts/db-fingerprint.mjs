#!/usr/bin/env node
/**
 * Fingerprint a D1 database: row count and a SHA-256 of every table's full contents, plus the payment,
 * enrollment and lecture-view reconciliation figures. Used for backup/restore drills: fingerprint before,
 * restore, fingerprint after, and compare (they must be identical).
 *
 *   node scripts/db-fingerprint.mjs <database-name> --local  [--out file.json]
 *   node scripts/db-fingerprint.mjs usmle100-dev --remote --preview  [--out file.json]   (staging only)
 *   node scripts/db-fingerprint.mjs --compare before.json after.json
 *
 * Read-only: it only runs SELECT statements. Never point a restore at the production database (usmle100).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args[0] === '--compare') {
  const [a, b] = [JSON.parse(readFileSync(args[1], 'utf8')), JSON.parse(readFileSync(args[2], 'utf8'))];
  const names = [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])].sort();
  let bad = 0;
  for (const n of names) {
    const x = a.tables[n], y = b.tables[n];
    if (!x || !y || x.rows !== y.rows || x.sha256 !== y.sha256) {
      bad++;
      console.log(`DIFFERENT  ${n}: ${x ? x.rows : 'missing'} rows → ${y ? y.rows : 'missing'} rows`);
    }
  }
  const ra = JSON.stringify(a.reconciliation), rb = JSON.stringify(b.reconciliation);
  if (ra !== rb) { bad++; console.log('DIFFERENT  reconciliation figures', ra, '→', rb); }
  console.log(bad ? `${bad} difference(s) across ${names.length} tables.` : `IDENTICAL: ${names.length} tables, reconciliation ${rb}`);
  process.exit(bad ? 1 : 0);
}

const db = args[0];
const where = args.includes('--remote') ? '--remote' : '--local';
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
if (!db || db.startsWith('-')) {
  console.error('Usage: node scripts/db-fingerprint.mjs <database-name> --local|--remote [--preview] [--out file.json]');
  process.exit(2);
}
if (where === '--remote' && db === 'usmle100' && !args.includes('--i-understand-this-is-production-read-only')) {
  console.error('Refusing to read the production database remotely. Drills run on usmle100-dev.');
  process.exit(2);
}

function queryMany(sqls) {
  const extra = args.includes('--preview') ? ['--preview'] : [];
  const raw = execFileSync('npx', ['wrangler', 'd1', 'execute', db, where, ...extra, '--json', '--command', sqls.join(';\n')], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(raw.slice(raw.indexOf('['))).map((r) => r.results);
}
const query = (sql) => queryMany([sql])[0];

const tables = query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_stat%' ORDER BY name").map((r) => r.name);
const colCount = Object.fromEntries(queryMany(tables.map((t) => `SELECT COUNT(*) AS n FROM pragma_table_info('${t}')`)).map((r, i) => [tables[i], r[0].n]));
const result = { database: db, where, taken_at: new Date().toISOString(), tables: {}, reconciliation: {} };
for (let i = 0; i < tables.length; i += 15) {
  const batch = tables.slice(i, i + 15);
  const results = queryMany(batch.map((t) => `SELECT * FROM "${t}" ORDER BY ${Array.from({ length: colCount[t] }, (_, k) => k + 1).join(', ')}`));
  batch.forEach((t, k) => {
    result.tables[t] = { rows: results[k].length, sha256: createHash('sha256').update(JSON.stringify(results[k])).digest('hex') };
  });
}
const one = (sql) => Object.values(query(sql)[0] ?? {})[0] ?? null;
const has = (t) => tables.includes(t);
result.reconciliation = {
  active_enrollments: has('enrollments') ? one("SELECT COUNT(*) FROM enrollments WHERE status = 'active'") : null,
  paid_enrollment_cents: has('enrollments') ? one("SELECT COALESCE(SUM(amount_cents), 0) FROM enrollments WHERE status IN ('active', 'refunded')") : null,
  enrollments_with_stripe_session: has('enrollments') ? one('SELECT COUNT(*) FROM enrollments WHERE stripe_session_id IS NOT NULL') : null,
  paid_book_purchases: has('book_purchases') ? one("SELECT COUNT(*) FROM book_purchases WHERE status = 'paid'") : null,
  stripe_refunds: has('stripe_refunds') ? one('SELECT COUNT(*) FROM stripe_refunds') : null,
  stripe_disputes: has('stripe_disputes') ? one('SELECT COUNT(*) FROM stripe_disputes') : null,
  lecture_progress_rows: has('lecture_progress') ? one('SELECT COUNT(*) FROM lecture_progress') : null,
  lectures_completed: has('lecture_progress') ? one('SELECT COUNT(*) FROM lecture_progress WHERE completed_at IS NOT NULL') : null,
  view_sessions: has('view_sessions') ? one('SELECT COUNT(*) FROM view_sessions') : null,
  view_grants: has('view_grants') ? one('SELECT COUNT(*) FROM view_grants') : null,
  db_environment: has('settings') ? one("SELECT value FROM settings WHERE key = 'db_environment'") : null,
};
const text = JSON.stringify(result, null, 2);
if (out) writeFileSync(out, text + '\n');
console.log(`${tables.length} tables fingerprinted${out ? ` → ${out}` : ''}`);
console.log('reconciliation', JSON.stringify(result.reconciliation));
