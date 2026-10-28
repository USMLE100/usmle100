#!/usr/bin/env node
/**
 * Checks, from wrangler.toml as Wrangler itself reads it, that Worker Previews (staging) cannot reach production:
 * every storage binding the live Worker has is re-bound for Previews to a different resource, the Preview
 * database is usmle100-dev and never the production database, and the environment flags are right.
 * Runs offline; part of `npm test`.
 */
import { unstable_readConfig } from 'wrangler';

const PROD_DB_ID = 'd1ff7fee-bf81-42d8-863a-652e3476716c';
const DEV_DB_ID = '7cf62a77-9fc6-46ab-b9fa-bdf16f5dcef3';

const c = unstable_readConfig({ config: process.env.WRANGLER_CONFIG || 'wrangler.toml' }, { hideWarnings: true });
const p = c.previews;
const fails = [];
const ok = (cond, msg) => (cond ? console.log(`  ok    ${msg}`) : (fails.push(msg), console.log(`  FAIL  ${msg}`)));

console.log('Production (top level)');
ok(c.vars?.ENVIRONMENT === 'production', 'ENVIRONMENT = "production"');
ok(c.d1_databases?.some((d) => d.binding === 'DB' && d.database_id === PROD_DB_ID), `DB → usmle100 (${PROD_DB_ID})`);
ok(!c.vars?.DEV_FAKE_PAYMENTS, 'DEV_FAKE_PAYMENTS not set');

console.log('Previews (staging)');
ok(!!p, 'a [previews] block exists');
const pd = p?.d1_databases ?? [];
ok(pd.length === 1 && pd[0].binding === 'DB', 'exactly one Preview database binding, named DB');
ok(pd.every((d) => d.database_id !== PROD_DB_ID && d.database_name !== 'usmle100'), 'Preview database is not the production database');
ok(pd[0]?.database_id === DEV_DB_ID && pd[0]?.database_name === 'usmle100-dev', `Preview DB → usmle100-dev (${DEV_DB_ID})`);
ok(p?.vars?.ENVIRONMENT === 'preview', 'Preview ENVIRONMENT = "preview"');
ok((p?.vars?.BUNNY_LIBRARY_ID ?? '') !== '785730', 'Preview does not use the live Bunny library');
ok(p?.vars?.PREVIEW_ALLOW_ZOOM !== '1', 'Zoom off on Previews (owner has not opted in)');
ok(!p?.vars?.DEV_FAKE_PAYMENTS, 'DEV_FAKE_PAYMENTS not set on Previews');

// Every live storage binding must be re-bound for Previews to something else.
const kinds = ['d1_databases', 'kv_namespaces', 'r2_buckets', 'queues', 'vectorize', 'hyperdrive'];
for (const k of kinds) {
  const live = k === 'queues' ? c.queues?.producers ?? [] : c[k] ?? [];
  const prev = k === 'queues' ? p?.queues?.producers ?? [] : p?.[k] ?? [];
  for (const b of live) {
    const id = (x) => x.database_id ?? x.id ?? x.bucket_name ?? x.queue ?? x.index_name;
    const twin = prev.find((x) => x.binding === b.binding);
    ok(!!twin && id(twin) !== id(b), `${k}.${b.binding} re-bound for Previews to a different resource`);
  }
}

if (fails.length) {
  console.error(`\n${fails.length} staging-isolation check(s) failed.`);
  process.exit(1);
}
console.log('\nStaging isolation: all checks passed.');
