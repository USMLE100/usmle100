import type { Enrollment, User } from './types';
import { isStaff } from './types';

/** Packages that include the USMLE100 Comprehensive Course Book (Companion, and everything above it). */
export const BOOK_PACKAGES = ['companion', 'complete', 'max'];

/** Staff, students whose package includes the book, and anyone given it by an admin (the $199 Course Book on its own). */
export async function hasBook(db: D1Database, user: User, enrollment: Enrollment | null) {
  if (isStaff(user)) return true;
  if (enrollment && BOOK_PACKAGES.includes(enrollment.package_id)) return true;
  return !!(await db.prepare('SELECT 1 FROM book_access WHERE user_id = ?').bind(user.id).first());
}

export type Chapter = {
  id: number;
  number: number;
  title: string;
  subject_id: number | null;
  section_id: number | null;
  description: string | null;
  summary: string | null;
  topics: string | null;
  author: string | null;
  pages: number | null;
  file_id: number | null;
  status: string;
  subject: string | null;
  file_name: string | null;
  read_at: string | null;
};

export async function chapters(db: D1Database, userId: number, includeDrafts = false) {
  return (
    await db
      .prepare(
        `SELECT c.*, s.name AS subject, f.name AS file_name, r.read_at
         FROM book_chapters c LEFT JOIN subjects s ON s.id = c.subject_id LEFT JOIN files f ON f.id = c.file_id
         LEFT JOIN book_reads r ON r.chapter_id = c.id AND r.user_id = ?
         WHERE ${includeDrafts ? '1' : "c.status = 'live'"} ORDER BY c.number, c.id`,
      )
      .bind(userId)
      .all<Chapter>()
  ).results;
}

export const topicList = (t: string | null) => (t ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
