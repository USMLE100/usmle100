import { sha256Hex } from './auth';

/**
 * Tamper-evident security log. Every entry stores the hash of the entry before it, so changing or removing
 * an entry in the middle breaks the chain and shows up in verifyAuditChain(). Kept 24 months (R010).
 */
export const AUDIT_RETENTION_DAYS = 730;
const GENESIS = 'genesis';

export type AuditEntry = { actorId?: number | null; action: string; targetUserId?: number | null; detail?: Record<string, unknown> | string | null; ip?: string | null };

const line = (prev: string, at: string, e: { actor_id: number | null; action: string; target_user_id: number | null; detail: string | null; ip: string | null }) =>
  [prev, at, e.actor_id ?? '', e.action, e.target_user_id ?? '', e.detail ?? '', e.ip ?? ''].join('|');

/** Append one entry. Retries if another request appended at the same moment, so the chain never forks. */
export async function audit(db: D1Database, e: AuditEntry) {
  const row = {
    actor_id: e.actorId ?? null,
    action: e.action,
    target_user_id: e.targetUserId ?? null,
    detail: e.detail == null ? null : typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail),
    ip: e.ip ?? null,
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').first<{ hash: string }>();
    const prev = last?.hash ?? GENESIS;
    const at = new Date().toISOString();
    const hash = await sha256Hex(line(prev, at, row));
    // Only insert if no one appended since we read the last hash.
    const r = await db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_user_id, detail, ip, prev_hash, hash)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1), ?) = ?`,
      )
      .bind(at, row.actor_id, row.action, row.target_user_id, row.detail, row.ip, prev, hash, GENESIS, prev)
      .run();
    if ((r.meta.changes ?? 0) > 0) return;
  }
  console.error('audit log: could not append after retries', row.action);
}

/** Check the whole chain. Returns the first broken entry, or null when intact. */
export async function verifyAuditChain(db: D1Database): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
  const rows = (await db.prepare('SELECT * FROM audit_log ORDER BY id').all<any>()).results;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // The oldest kept entry may point at an entry removed by the 24-month retention; its own hash must still match.
    if (i > 0 && r.prev_hash !== rows[i - 1].hash) return { ok: false, checked: i, brokenAt: r.id };
    if ((await sha256Hex(line(r.prev_hash, r.at, r))) !== r.hash) return { ok: false, checked: i, brokenAt: r.id };
  }
  return { ok: true, checked: rows.length };
}

export async function pruneAudit(db: D1Database) {
  await db.prepare('DELETE FROM audit_log WHERE at < ?').bind(new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400_000).toISOString()).run();
}
