import { todayUtc } from './content';

/** "USMLE Step 1 is in 84 days", from the onboarding answers. Null when no future date is set. */
export const examCountdown = (exam: string | null, date: string | null) => {
  if (!date) return null;
  const days = Math.round((Date.parse(date + 'T00:00:00Z') - todayUtc()) / 86400_000);
  return days >= 0 ? `${exam ?? 'Your exam'} is in ${days} day${days === 1 ? '' : 's'}` : null;
};
