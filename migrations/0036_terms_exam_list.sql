-- Owner, 6 Nov 2026: the Terms list every exam the homepage names (USMLE Steps 1, 2 and 3, COMLEX and CBSE).
-- Changes that one sentence in section 2 of the Terms of Service; nothing else in the Terms changes.
UPDATE settings SET value = replace(value, 'USMLE100 is exam preparation for USMLE Step 1, COMLEX and CBSE.', 'USMLE100 is exam preparation for USMLE Steps 1, 2 and 3, COMLEX and CBSE.') WHERE key = 'terms_text' AND instr(value, 'USMLE100 is exam preparation for USMLE Step 1, COMLEX and CBSE.') > 0;
