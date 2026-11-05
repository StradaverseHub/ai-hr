/** Minimal RFC 4180 reader shared by imports. The strict path retains source line numbers for diagnostics. */
export function parseCsvWithLineNumbers(text:string,strict=false):{cells:string[];line:number}[]{
  const rows:{cells:string[];line:number}[]=[];
  let row:string[]=[],field='',inQuotes=false,afterQuote=false,line=1,rowLine=1;
  const s=(strict?text.replace(/^\uFEFF/,''):text).replace(/\r\n?/g,'\n');
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(inQuotes){
      if(c==='"'){
        if(s[i+1]==='"'){field+='"';i++;continue;}
        inQuotes=false;afterQuote=true;continue;
      }
      if(c==='\n')line++;
      field+=c;continue;
    }
    if(c==='"'){
      if(strict&&(field.length||afterQuote))throw Error('Malformed quotes in the CSV file.');
      inQuotes=true;continue;
    }
    if(c===','||c==='\n'){
      row.push(field);field='';afterQuote=false;
      if(c==='\n'){rows.push({cells:row,line:rowLine});row=[];rowLine=++line;}
      continue;
    }
    if(strict&&afterQuote)throw Error('Malformed quotes in the CSV file.');
    field+=c;
  }
  if(strict&&inQuotes)throw Error('A quoted CSV field is not closed.');
  if(field.length>0||row.length>0){row.push(field);rows.push({cells:row,line:rowLine});}
  return rows.filter(({cells})=>!(cells.length===1&&cells[0].trim()===''));
}
export function parseCsv(text:string):string[][]{
  return parseCsvWithLineNumbers(text).map(row=>row.cells);
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
