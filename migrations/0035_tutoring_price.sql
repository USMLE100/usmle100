-- Owner, 5 Nov 2026: one-on-one tutoring is $49.99 per session (the price her Stripe link charges).
-- Corrects that one figure in the Terms of Service on the live site; nothing else in the Terms changes.
UPDATE settings SET value = replace(value, 'one-on-one tutoring $50 per 60-minute session', 'one-on-one tutoring $49.99 per 60-minute session') WHERE key = 'terms_text' AND instr(value, 'one-on-one tutoring $50 per 60-minute session') > 0;
