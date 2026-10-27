/** Registration details the owner asked for (name, email, phone, exam, graduation year) and marketing consent. */
export const EXAMS = ['USMLE Step 1', 'USMLE Step 2', 'USMLE Step 3', 'COMLEX 1', 'COMLEX 2', 'COMLEX 3', 'CBSE', 'CCSE', 'COMP'];

/** The exact wording of the optional marketing box. It is stored with each consent as proof of what was agreed. */
export const MARKETING_TEXT = 'Yes, email me USMLE100 news, free webinars and program offers. I can unsubscribe at any time.';

export function gradYears() {
  const y = new Date().getUTCFullYear();
  const out: number[] = [];
  for (let v = y + 8; v >= y - 45; v--) out.push(v);
  return out;
}

/**
 * International phone numbers: "+" and country code, 8 to 15 digits (E.164). A 10-digit number without "+"
 * is taken as US/Canada (+1). Returns the number as +digits, or null when it isn't a phone number.
 */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  if (!/^[+(\d][\d\s().-]{6,24}$/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 && digits[0] !== '0' ? '+' + digits : null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

export const validName = (s: string) => s.length >= 1 && s.length <= 60 && !/[<>@]/.test(s);
