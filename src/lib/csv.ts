/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function toCsv(rows: (string | number | null)[][]): string {
  return rows
    .map((r) => r.map((v) => {
      let s = v == null ? '' : String(v);
      // A cell starting with = + - @ (or a tab/CR) runs as a formula in Excel or Sheets; plain numbers are left alone.
      if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\r\n');
}

export const TEMPLATE_HEADERS = [
  'stem', 'choice_a', 'choice_b', 'choice_c', 'choice_d', 'choice_e', 'choice_f', 'choice_g', 'choice_h',
  'correct', 'explanation', 'bottom_line', 'subject', 'system', 'discipline', 'perf_system', 'lecture_day',
];
