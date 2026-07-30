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
 * A number as PLAIN DIGITS — never `1.23457e+21`.
 *
 * d8471481: identity-shaped fields (IC, bank account, phone, EPF/SOCSO/tax numbers) are typed into
 * Excel by HR and land here as JS numbers whenever the cell was left in General format. `String(n)`
 * switches to exponential notation at 1e21 and for tiny magnitudes, so a 21-digit account number
 * would reach the importer as "1.234567890123457e+21" and be stored — or rejected — as that literal
 * text. Integers are emitted via `toFixed(0)`, which stays positional for every finite value.
 *
 * What this CANNOT do is bring back a LEADING ZERO: `0123456789` typed into a General cell is stored
 * by Excel as the number 123456789 and the zero is gone from the file itself, before we ever see it.
 * That is why the downloadable template pre-formats those columns as text (`z: '@'`).
 */
export function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toFixed(0);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  // Fractional AND exponential (e.g. 1e-7): expand without trailing-zero noise.
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Read an .xlsx/.xls workbook (an ArrayBuffer from File.arrayBuffer()) and return CSV text of its
 * FIRST worksheet, shaped exactly like the paste box / CSV file path so everything downstream
 * (parseCsvRecords → analyze → commit) is byte-identical. Throws 'EMPTY_SHEET' when the first sheet
 * has no rows so the caller can surface a clear i18n message.
 */
export async function workbookToCsvText(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const XLSX = await import('xlsx');
  // Normalise to a Uint8Array view: SheetJS accepts either, but being explicit keeps us robust to
  // callers handing us File.arrayBuffer() output OR raw bytes (and to SheetJS's own type drift).
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // cellDates → real Date objects for date-formatted cells; we ISO-format them below so a spreadsheet
  // date lands as the engine's YYYY-MM-DD (DATE_RE) instead of an Excel serial number or locale string.
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
  const firstName = wb.SheetNames[0];
  if (!firstName) throw new Error('EMPTY_SHEET');
  const ws = wb.Sheets[firstName];
  // header:1 → array-of-arrays (no header inference); raw:true → raw cell values, so a date cell stays
  // the Date instance cellDates produced (raw:false would substitute the FORMATTED text, e.g. "1/1/26",
  // which fails the engine's DATE_RE). Non-date cells are strings/numbers and are String()-ed below.
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });
  const rows = (aoa as Cell[][]).map((row) =>
    row.map((cell) => {
      if (cell instanceof Date) return toIsoDate(cell);
      // d8471481 — a General-formatted identity column arrives as a JS number; emit plain digits so
      // nothing downstream ever sees exponential notation.
      if (typeof cell === 'number') return numberToPlainString(cell);
      return cell;
    }),
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
export async function buildXlsx(
  header: string[],
  rows: string[][],
  opts?: BuildXlsxOptions,
): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  if (opts?.textColumns?.length) applyTextColumns(XLSX, ws, opts.textColumns, rows.length, opts.textRowFloor ?? TEXT_ROW_FLOOR);
  XLSX.utils.book_append_sheet(wb, ws, opts?.sheetName ?? 'Leave Import');
  for (const extra of opts?.extraSheets ?? []) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(extra.rows), extra.name);
  }
  // type:'array' → SheetJS returns an ArrayBuffer (despite older typings suggesting Uint8Array);
  // wrap it so callers always get real bytes, safe for a browser Blob or Buffer.from().
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

export type BuildXlsxOptions = {
  /** Name of the first (data) sheet. Defaults to the leave importer's historical name. */
  sheetName?: string;
  /** 0-based indexes of columns that must be TEXT so leading zeros survive HR's typing. */
  textColumns?: number[];
  /** Additional read-only sheets (reference lists, instructions), appended after the data sheet. */
  extraSheets?: { name: string; rows: (string | number)[][] }[];
  /** How many rows below the samples get the text format pre-applied. */
  textRowFloor?: number;
};

/** Rows of blank, text-formatted cells written under the samples so a value typed into an EMPTY row
 *  of an identity column is still treated as text by Excel. 500 covers a large day-one load without
 *  bloating the file (a blank string cell is a few bytes). */
const TEXT_ROW_FLOOR = 500;

/**
 * Stamp the `@` (text) number format down whole columns.
 *
 * This is the half of the leading-zero fix that lives in the TEMPLATE. Excel decides a cell's type
 * when the value is typed, from the cell's format: in a General cell `0123456789` becomes the number
 * 123456789 and the zero is destroyed IN THE FILE, so no amount of reader cleverness can recover it.
 * Pre-formatting the column as text means Excel keeps exactly what was typed, and SheetJS then hands
 * it back as a string.
 *
 * Cell number formats (`z`) are written by the SheetJS community build; cell STYLES (fonts, fills)
 * are not, which is why nothing here reaches for them.
 */
function applyTextColumns(
  XLSX: typeof import('xlsx'),
  ws: import('xlsx').WorkSheet,
  textColumns: number[],
  dataRowCount: number,
  floor: number,
): void {
  const lastRow = Math.max(dataRowCount, floor); // 0-based header at row 0; data starts at row 1
  for (const c of textColumns) {
    for (let r = 1; r <= lastRow; r++) {
      const addr = XLSX.utils.encode_cell({ c, r });
      const cell = ws[addr] as { t?: string; v?: unknown; z?: string } | undefined;
      if (cell) {
        cell.t = 's';
        cell.v = cell.v == null ? '' : String(cell.v);
        cell.z = '@';
      } else {
        ws[addr] = { t: 's', v: '', z: '@' };
      }
    }
  }
  // Widen !ref so the pre-formatted blank rows are actually part of the sheet.
  const ref = ws['!ref'];
  if (ref) {
    const range = XLSX.utils.decode_range(ref);
    range.e.r = Math.max(range.e.r, lastRow);
    range.e.c = Math.max(range.e.c, ...textColumns);
    ws['!ref'] = XLSX.utils.encode_range(range);
  }
}
