/** Minimal, dependency-free CSV reader (RFC 4180): quoted fields, escaped quotes (""),
 *  and embedded commas / newlines. Used by the employee importer. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n?/g, '\n'); // normalise CRLF / CR to LF
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // flush the final field/row (file may not end in a newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // drop blank lines (a row that's a single empty cell)
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** CSV formula-injection guard. A cell beginning with `= + - @ TAB CR` is interpreted as a formula by
 *  Excel / Sheets / LibreOffice when the file is opened, so an employee fullName of `=HYPERLINK(...)` or
 *  `@SUM(...)` would execute. Neutralise it by prefixing a single quote (the standard OWASP mitigation),
 *  which the spreadsheet strips on display. Applied to every cell toCsv emits — and exported standalone
 *  so callers can sanitise before any other serializer too. */
export function csvSafeCell(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** Serialise rows to RFC-4180 CSV (CRLF endings; a field is quoted when it contains a comma,
 *  quote, or newline, with embedded quotes doubled). Symmetric with parseCsv. Each cell is first run
 *  through csvSafeCell so a leading-formula value can never execute on open (CSV-injection hardening). */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = csvSafeCell(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

/** Parse a CSV with a header row into records keyed by normalised header
 *  (lower-cased, spaces → underscores). Returns the headers and one record per data row. */
export function parseCsvRecords(text: string): {
  headers: string[];
  records: Record<string, string>[];
} {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const records = rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, idx) => {
      rec[h] = (r[idx] ?? '').trim();
    });
    return rec;
  });
  return { headers, records };
}
