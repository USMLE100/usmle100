export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Public address, e.g. https://usmle100.com. If unset, taken from each request. */
  SITE_URL?: string;
  /** Comma-separated emails that become admins when they sign up. */
  ADMIN_EMAILS?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  BUNNY_LIBRARY_ID?: string;
  BUNNY_TOKEN_KEY?: string;
  /** Local development only: "1" marks enrollments paid without Stripe. Never set in production. */
  DEV_FAKE_PAYMENTS?: string;
};

export type User = {
  id: number;
  email: string;
  name: string;
  role: 'student' | 'faculty' | 'admin';
  exam_date: string | null;
};

export type Enrollment = {
  id: number;
  package_id: string;
  cohort_id: number | null;
  status: string;
  package_name: string;
  one_on_one_sessions: number;
  evening_q_months: number;
};

export type Vars = {
  user: User | null;
  enrollment: Enrollment | null;
};

export type AppEnv = { Bindings: Env; Variables: Vars };

export const isStaff = (u: User | null) => !!u && (u.role === 'admin' || u.role === 'faculty');
