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
  /** Optional free Cloudflare Turnstile bot check on sign-up: the site key (public) and secret. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** Optional email sending (Resend) and SMS (Twilio) for codes and alerts; nothing is sent until these are set. */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM?: string;
  /** Optional Sender (marketing) API key: only students who opted in are sent. */
  SENDER_API_KEY?: string;
  /** Where owner alerts are emailed (once email sending is set up). */
  OWNER_ALERT_EMAIL?: string;
};

export type User = {
  id: number;
  email: string;
  name: string;
  role: 'student' | 'faculty' | 'admin';
  exam_date: string | null;
  exam?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  grad_year?: number | null;
  marketing_opt_in?: number;
  email_verified_at?: string | null;
  phone_verified_at?: string | null;
  onboarded_at?: string | null;
  /** The owner: final authority over admins, money, access changes and reinstatement. */
  is_owner?: number;
  /** active | warned | suspended */
  status?: string;
  status_reason?: string | null;
  warnings?: number;
  birth_date?: string | null;
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
export type Shell = { streak: number; lecturesDone: number; lecturesTotal: number; contact: string; terms: boolean; privacy: boolean; refunds: boolean };

export type Vars = {
  user: User | null;
  enrollment: Enrollment | null;
  shell?: Shell;
  session?: { tokenHash: string; createdAt: number; lastSeenAt: number; reauthAt: number | null; deviceHash?: string | null; verifyPending?: boolean; verifyReason?: string | null };
  /** Set when this request found the session ended: 'idle' (30 minutes) or 'expired' (24 hours). */
  sessionEnded?: 'idle' | 'expired';
};

export type AppEnv = { Bindings: Env; Variables: Vars };

/** Faculty or admin: can watch everything and use the teaching parts of the admin area. */
export const isStaff = (u: User | null) => !!u && (u.role === 'admin' || u.role === 'faculty');
/** Admin only: prices, settings, schedule, student access and the team. */
export const isAdmin = (u: User | null) => !!u && u.role === 'admin';
/** The owner (an admin with final authority). */
export const isOwner = (u: User | null) => !!u && u.role === 'admin' && u.is_owner === 1;
