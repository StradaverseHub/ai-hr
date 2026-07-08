/**
 * Spreadsheet (.xlsx / .xls) support for the Leave Data Import & Migration Tool.
 *
 * BROWSER-ONLY, dynamically imported. SheetJS (`xlsx`) is heavy (~400 KB) and only ever needed when
 * an HR admin actually picks an Excel file, so every entry point below does `await import('xlsx')`
 * lazily — the library stays out of the initial bundle AND out of every server action. The server
 * continues to receive plain CSV text and re-validates everything in analyze(); this module only ever
 * converts an Excel workbook INTO that CSV text (and builds a downloadable Excel template), so no new
 * server attack surface and no server-side workbook parsing.
 *
 * DEPENDENCY NOTE: `xlsx` is added to package.json but is NOT installable into the symlinked build
 * worktree — the integration step installs it for real. Until then `tsc` reports "Cannot find module
 * 'xlsx'", which is expected and isolated to this file's two dynamic imports.
 */

// Cells arrive as strings (raw:false) or, for date cells with cellDates, JS Dates. Anything else is
// coerced to string. We never trust a cell to be a specific type.
type Cell = string | number | boolean | Date | null | undefined;

/** RFC-4180 serialiser used ONLY to feed text back into parseCsvRecords. Deliberately NOT lib/csv.ts's
 *  toCsv: that runs csvSafeCell, which prefixes a leading '-' with a quote (formula-injection guard for
 *  files opened IN Excel). A `days` value of `-2` would become `'-2` and fail Number() in analyze().
 *  Here the text is re-parsed by our own code, never opened in a spreadsheet, so no guard is wanted —
 *  just correct quoting (quote when the cell holds a comma, quote, CR or LF; double embedded quotes). */
function rowsToCsvText(rows: Cell[][]): string {
  const esc = (v: Cell): string => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

/** yyyy-mm-dd from a JS Date in local time (SheetJS returns dates at local midnight with cellDates). */
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Read an .xlsx/.xls workbook (an ArrayBuffer from File.arrayBuffer()) and return CSV text of its
 * FIRST worksheet, shaped exactly like the paste box / CSV file path so everything downstream
 * (parseCsvRecords → analyze → commit) is byte-identical. Throws 'EMPTY_SHEET' when the first sheet
 * has no rows so the caller can surface a clear i18n message.
 */
export async function workbookToCsvText(buf: ArrayBuffer): Promise<string> {
  const XLSX = await import('xlsx');
  // cellDates → real Date objects for date-formatted cells; we ISO-format them below so a spreadsheet
  // date lands as the engine's YYYY-MM-DD (DATE_RE) instead of an Excel serial number or locale string.
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const firstName = wb.SheetNames[0];
  if (!firstName) throw new Error('EMPTY_SHEET');
  const ws = wb.Sheets[firstName];
  // header:1 → array-of-arrays (no header inference); raw:false → formatted strings for non-date cells.
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false });
  const rows = (aoa as Cell[][]).map((row) =>
    row.map((cell) => (cell instanceof Date ? toIsoDate(cell) : cell)),
  );
  // Drop fully-empty trailing rows so a workbook padded with blanks doesn't yield empty CSV records.
  const nonEmpty = rows.filter((r) => r.some((c) => c != null && String(c).trim() !== ''));
  if (nonEmpty.length === 0) throw new Error('EMPTY_SHEET');
  return rowsToCsvText(nonEmpty);
}

/**
 * Build a real .xlsx workbook (single sheet) from a header row + data rows and return it as bytes.
 * Used for the "Download Excel template" button so HR gets a genuine Excel file (not a CSV renamed
 * .xlsx). Headers are the reporter's human labels ("Employee ID", …) which normalise back to the
 * snake_case contract via parseCsvRecords on re-upload.
 */
export async function buildXlsx(header: string[], rows: string[][]): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leave Import');
  // type:'array' → ArrayBuffer/Uint8Array bytes, safe to wrap in a browser Blob for download.
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}
