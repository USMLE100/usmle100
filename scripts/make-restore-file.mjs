#!/usr/bin/env node
/**
 * Turns a D1 export into a file that restores cleanly into a NEW, EMPTY database.
 *
 * Why: a plain `wrangler d1 export` lists each table followed by its rows. Some tables (lectures, notes,
 * threads, …) gained a column that references a table created later (sections, evening_sessions), so
 * replaying the plain export stops with "no such table". Exporting schema and data separately and
 * replaying schema first fixes that; this script also puts AUTOINCREMENT counters back exactly once.
 *
 *   npx wrangler d1 export <db> --remote --no-data   --output schema.sql
 *   npx wrangler d1 export <db> --remote --no-schema --output data.sql
 *   node scripts/make-restore-file.mjs schema.sql data.sql restore.sql
 *   npx wrangler d1 execute <NEW-EMPTY-db> --remote --file restore.sql      (never into usmle100 itself)
 *
 * Verified by the restore drill in LAUNCH.md §7 (row-by-row fingerprints identical before and after).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [schemaPath, dataPath, outPath] = process.argv.slice(2);
if (!schemaPath || !dataPath || !outPath) {
  console.error('Usage: node scripts/make-restore-file.mjs schema.sql data.sql restore.sql');
  process.exit(2);
}
const schema = readFileSync(schemaPath, 'utf8');
const dataLines = readFileSync(dataPath, 'utf8').split('\n');
const isSeq = (l) => /^INSERT INTO "?sqlite_sequence"?/.test(l);
const seq = dataLines.filter(isSeq);
const rest = dataLines.filter((l) => !isSeq(l) && !/^PRAGMA defer_foreign_keys/.test(l));
if (/CREATE TABLE[^;]*\b_cf_/i.test(schema)) console.warn('Note: the export contains Cloudflare internal tables (_cf_*); D1 skips them.');
const out = [
  '-- USMLE100 restore file (scripts/make-restore-file.mjs). Run only against a new, empty database.',
  schema.trim(),
  'PRAGMA defer_foreign_keys=TRUE;',
  ...rest,
  'DELETE FROM sqlite_sequence;',
  ...seq,
  '',
].join('\n');
writeFileSync(outPath, out);
console.log(`${outPath}: schema + ${rest.filter((l) => l.startsWith('INSERT')).length} rows + ${seq.length} counters`);
