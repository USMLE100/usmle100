export type QStatus = 'unused' | 'incorrect' | 'omitted' | 'correct';

export type QRow = {
  id: number;
  subject_id: number | null;
  system_id: number | null;
  status: QStatus;
  flagged: number;
};

/** Every approved question with this student's status, based on their most recent attempt. */
export async function questionStatuses(db: D1Database, userId: number): Promise<QRow[]> {
  const { results } = await db
    .prepare(
      `WITH attempts AS (
         SELECT ti.question_id, ti.chosen_index, ti.is_correct,
                ROW_NUMBER() OVER (PARTITION BY ti.question_id ORDER BY t.id DESC, ti.position DESC) AS rn
         FROM test_items ti JOIN tests t ON t.id = ti.test_id
         WHERE t.user_id = ?1 AND (ti.answered_at IS NOT NULL OR t.finished_at IS NOT NULL)
       ),
       flags AS (
         SELECT DISTINCT ti.question_id FROM test_items ti JOIN tests t ON t.id = ti.test_id
         WHERE t.user_id = ?1 AND ti.flagged = 1
       )
       SELECT q.id, q.subject_id, q.system_id,
         CASE WHEN a.question_id IS NULL THEN 'unused'
              WHEN a.chosen_index IS NULL THEN 'omitted'
              WHEN a.is_correct = 1 THEN 'correct' ELSE 'incorrect' END AS status,
         CASE WHEN f.question_id IS NULL THEN 0 ELSE 1 END AS flagged
       FROM questions q
       LEFT JOIN attempts a ON a.question_id = q.id AND a.rn = 1
       LEFT JOIN flags f ON f.question_id = q.id
       WHERE q.status = 'approved'`,
    )
    .bind(userId)
    .all<QRow>();
  return results;
}

export type Pools = { unused: boolean; incorrect: boolean; omitted: boolean; correct: boolean; custom: boolean };

export function filterQuestions(rows: QRow[], pools: Pools, subjects: number[], systems: number[]) {
  const anyPool = pools.unused || pools.incorrect || pools.omitted || pools.correct || pools.custom;
  return rows.filter((r) => {
    if (anyPool) {
      const inPool = (pools[r.status] as boolean) || (pools.custom && r.flagged === 1);
      if (!inPool) return false;
    }
    if (subjects.length && (r.subject_id == null || !subjects.includes(r.subject_id))) return false;
    if (systems.length && (r.system_id == null || !systems.includes(r.system_id))) return false;
    return true;
  });
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export type Score = { id: number; name: string; answered: number; correct: number };

/** Percent correct per reporting category, from every question the student has answered. */
/** Scores by reporting system or discipline. `sinceUtc` ("YYYY-MM-DD HH:MM:SS") limits it to recent answers. */
export async function scoresBy(db: D1Database, userId: number, dim: 'perf_system' | 'discipline', sinceUtc?: string): Promise<Score[]> {
  const table = dim === 'perf_system' ? 'perf_systems' : 'disciplines';
  const col = dim === 'perf_system' ? 'perf_system_id' : 'discipline_id';
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name,
         COUNT(ti.question_id) AS answered,
         COALESCE(SUM(ti.is_correct), 0) AS correct
       FROM ${table} c
       LEFT JOIN questions q ON q.${col} = c.id
       LEFT JOIN test_items ti ON ti.question_id = q.id AND ti.chosen_index IS NOT NULL
         AND ti.test_id IN (SELECT id FROM tests WHERE user_id = ?)
         AND (? IS NULL OR ti.answered_at >= ?)
       GROUP BY c.id ORDER BY c.sort`,
    )
    .bind(userId, sinceUtc ?? null, sinceUtc ?? null)
    .all<Score>();
  return results;
}
