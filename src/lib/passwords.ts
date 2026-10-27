/**
 * Password rules (R094): at least 12 characters, long passphrases and password managers welcome,
 * no forced expiry, and passwords known from data breaches are refused.
 * The breach check uses the free Pwned Passwords range API: only the first 5 characters of the
 * password's SHA-1 hash leave the server, never the password.
 */
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;

async function sha1Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** True if the password appears in known breaches. If the check service can't be reached, returns false (sign-up keeps working). */
export async function isBreached(password: string): Promise<boolean> {
  try {
    const h = await sha1Hex(password);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${h.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const suffix = h.slice(5);
    return (await res.text()).split('\n').some((l) => {
      const [s, n] = l.trim().split(':');
      return s === suffix && Number(n) > 0;
    });
  } catch {
    console.error('Pwned Passwords check unavailable; password accepted without it');
    return false;
  }
}

/** An error message for an unacceptable new password, or null. */
export async function passwordProblem(password: string): Promise<string | null> {
  if (password.length < MIN_PASSWORD) return `Your password needs at least ${MIN_PASSWORD} characters. A short phrase of a few words works well.`;
  if (password.length > MAX_PASSWORD) return `Your password can be at most ${MAX_PASSWORD} characters.`;
  if (await isBreached(password)) return 'That password has appeared in a data breach elsewhere, so it isn’t safe. Please choose a different one.';
  return null;
}
