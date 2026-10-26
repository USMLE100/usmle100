export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Public address, e.g. https://usmle100.com. If unset, taken from each request. */
  SITE_URL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  BUNNY_LIBRARY_ID?: string;
  BUNNY_TOKEN_KEY?: string;
  /** Bunny Stream library API key: lets the site ask Bunny to copy Zoom recordings. */
  BUNNY_API_KEY?: string;
  /** Secret Token from the Zoom app's event subscription. */
  ZOOM_WEBHOOK_SECRET?: string;
  /** Optional Zoom Server-to-Server OAuth credentials, used only if Zoom sends no download token. */
  ZOOM_ACCOUNT_ID?: string;
  ZOOM_CLIENT_ID?: string;
  ZOOM_CLIENT_SECRET?: string;
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
  /** Admin-set last day to watch lectures (YYYY-MM-DD); null = the default for the cohort. */
  lectures_until: string | null;
};

/** Data every portal page shows in its top bar and menu. */
export type Shell = { streak: number; lecturesDone: number; lecturesTotal: number; contact: string };

export type Vars = {
  user: User | null;
  enrollment: Enrollment | null;
  shell?: Shell;
};

export type AppEnv = { Bindings: Env; Variables: Vars };

/** Faculty or admin: can watch everything and use the teaching parts of the admin area. */
export const isStaff = (u: User | null) => !!u && (u.role === 'admin' || u.role === 'faculty');
/** Admin only: prices, settings, schedule, student access and the team. */
export const isAdmin = (u: User | null) => !!u && u.role === 'admin';
