/**
 * Small, dependency-free CSV reader for workout exports (Strong, Hevy).
 *
 * - RFC 4180 quoting: fields in double quotes may hold the delimiter, line breaks and doubled quotes ("").
 * - The delimiter is detected from the header line (comma, semicolon or tab, counted outside quotes).
 * - A UTF-8 byte-order mark, CRLF / CR line endings, trailing whitespace around fields and blank rows are ignored.
 * - Numbers: `parseNumber` accepts "82.5", "82,5" (European decimal comma), "1,234.5" / "1.234,5" and plain
 *   integers; anything else is "not recorded" (null), never NaN.
 */

export type Delimiter = ',' | ';' | '\t';

export interface CsvTable {
  delimiter: Delimiter;
  /** Header cells exactly as written (trimmed). */
  headers: string[];
  /** Data rows (blank rows removed). Each row has the same length as `headers` (padded / cut). */
  rows: string[][];
}

/** Count delimiter candidates in the first line, outside quotes. */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && (c === ',' || c === ';' || c === '\t')) counts[c]++;
  }
  // Ties go to the comma (the most common export); a semicolon-separated header rarely contains commas.
  return (Object.keys(counts) as Delimiter[]).reduce((best, d) => (counts[d] > counts[best] ? d : best), ',' as Delimiter);
}

/** Split CSV text into rows of raw cells (quotes removed). Blank lines are dropped. */
export function parseCsvRows(input: string, delimiter: Delimiter = detectDelimiter(input.replace(/^﻿/, ''))): string[][] {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  const endCell = () => {
    row.push(wasQuoted ? cell : cell.trim());
    cell = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell.trim() === '') {
      // An opening quote (leading spaces before it are dropped).
      quoted = true;
      wasQuoted = true;
      cell = '';
    } else if (c === delimiter) endCell();
    else if (c === '\n') endRow();
    else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else if (!(wasQuoted && (c === ' ' || c === '\t'))) cell += c; // ignore spaces after a closing quote
  }
  if (cell !== '' || row.length) endRow();
  return rows;
}

/** Parse a whole file: header row + data rows padded to the header width. */
export function parseCsv(input: string): CsvTable {
  const text = input.replace(/^﻿/, '');
  const delimiter = detectDelimiter(text);
  const [headerRow = [], ...data] = parseCsvRows(text, delimiter);
  const headers = headerRow.map((h) => h.trim());
  const rows = data.map((r) => (r.length >= headers.length ? r.slice(0, Math.max(headers.length, 1)) : [...r, ...Array(headers.length - r.length).fill('')]));
  return { delimiter, headers, rows };
}

/** Header lookup that ignores case, surrounding spaces, quotes and BOMs. */
export const headerKey = (h: string) => h.replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * A number from an export cell, or null when the cell is empty or not a number.
 * "82,5" and "82.5" → 82.5; "1,234.5" → 1234.5; "1.234,5" → 1234.5; "1 234,5" → 1234.5.
 */
export function parseNumber(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  let s = raw.trim().replace(/[\s  ]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the later one is the decimal separator, the other groups thousands.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Only commas: one comma is a decimal comma ("82,5"); several are thousand separators ("1,234,567").
    s = (s.match(/,/g)!.length === 1 ? s.replace(',', '.') : s.replace(/,/g, ''));
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
