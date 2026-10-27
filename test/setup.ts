// Tests never reach the internet. Pwned Passwords is answered locally: these passwords count as breached.
export const BREACHED = ['password12345', 'qwertyuiop123'];
const realFetch = globalThis.fetch;
const sha1 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const m = /^https:\/\/api\.pwnedpasswords\.com\/range\/([0-9A-F]{5})$/.exec(url);
  if (m) {
    const lines: string[] = ['0000000000000000000000000000000000A:0'];
    for (const p of BREACHED) {
      const h = await sha1(p);
      if (h.startsWith(m[1])) lines.push(`${h.slice(5)}:42`);
    }
    return new Response(lines.join('\r\n'));
  }
  return realFetch(input as any, init);
}) as typeof fetch;

// Most tests make staff accounts directly and don't use passkeys; test/passkeys.test.ts turns the requirement back on.
import { beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { ensureMigrated } from '../src/lib/migrate';
beforeAll(async () => {
  const db = (env as any).DB as D1Database;
  await ensureMigrated(db);
  await db.prepare("INSERT INTO settings (key, value) VALUES ('staff_passkeys', '0') ON CONFLICT (key) DO UPDATE SET value = '0'").run();
});
