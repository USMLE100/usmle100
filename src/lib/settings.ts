export type Settings = {
  student_count: string;
  contact_email: string;
  calendly_url: string;
  practice_test_when: string;
  practice_test_link: string;
};

export const SETTING_FIELDS: { key: keyof Settings; label: string; hint: string; type: 'text' | 'email' | 'url' }[] = [
  { key: 'student_count', label: 'Student count on the home page', hint: 'Shown as “Join … students preparing with USMLE100”.', type: 'text' },
  { key: 'contact_email', label: 'Contact email', hint: 'Used by the “Ask about…” buttons.', type: 'email' },
  { key: 'calendly_url', label: 'One-on-one booking link (Calendly)', hint: 'Adds a “1-on-1” link to the student menu. Leave empty to hide it.', type: 'url' },
  { key: 'practice_test_when', label: 'Group practice test: date and time', hint: 'For example “Saturday, January 2, 10:00 AM ET”.', type: 'text' },
  { key: 'practice_test_link', label: 'Group practice test: Zoom link', hint: 'Shown to students on the exam-window page.', type: 'url' },
];

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const s: Settings = { student_count: '', contact_email: '', calendly_url: '', practice_test_when: '', practice_test_link: '' };
  for (const r of results) if (r.key in s) (s as any)[r.key] = r.value;
  return s;
}

export const isHttpUrl = (v: string) => /^https:\/\/[^\s]+$/.test(v);
