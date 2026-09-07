/**
 * Import file reader — the FILE → CSV-TEXT step of an import, and nothing else.
 *
 * An import is three steps that must stay separable:
 *
 *   1. READ    a picked/dropped File  → CSV text        ← this module (browser-side)
 *   2. PARSE   CSV text               → records         ← lib/csv  (parseCsvRecords)
 *   3. WRITE   records                → employments     ← core/import via the server actions
 *
 * d8471481 REPLACED STEP 1 ONLY, exactly as r78 designed it to be replaceable. An Excel workbook is
 * decoded here into the same CSV text a human would have pasted, using the SAME decoder the leave
 * importer uses (`lib/spreadsheet`'s `workbookToCsvText` — there is deliberately only ONE workbook
 * decoder in this repo). Steps 2 and 3 are untouched: the server still receives plain CSV text and
 * still re-validates everything, so no workbook ever reaches a server action.
 *
 * WHY THE BOM STRIP STILL MATTERS. `Blob.text()` performs a UTF-8 decode, which drops a leading
 * byte-order mark. Excel's "CSV UTF-8" export writes one, and without the strip the first header
 * reads as `﻿full_name` — so `full_name`, a REQUIRED column, is reported missing on a file that
 * looks perfectly correct. Verified in Node, not assumed. CSV remains a first-class input (the
 * reporter's own existing files are CSV) and keeps that guarantee.
 */

/** `accept` for the file input. Extensions FIRST (browsers report wildly inconsistent MIME types),
 *  with the MIME types appended for the pickers that use them. */
export const IMPORT_FILE_ACCEPT =
  '.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv';

/** Next Server Functions default to a ~1 MB request body and the CSV text is sent as an argument.
 *  A 500-row employee file is ~60 KB, so this is a generous ceiling that still fails fast and
 *  locally instead of as an opaque 413 from the server action. Checked against the DECODED TEXT,
 *  which is what actually crosses the wire. */
export const MAX_IMPORT_CSV_BYTES = 900_000;

/** Ceiling on the picked file itself, checked before any decode so a 200 MB video is never read.
 *  Higher than the text ceiling because an .xlsx is a ZIP: a workbook whose CSV projection is 900 KB
 *  is far smaller on disk, and rejecting on the compressed size would reject valid files. The text
 *  ceiling above is the one that protects the server action. */
export const MAX_IMPORT_FILE_BYTES = 5_000_000;

export type ImportFileErrorCode =
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'EMPTY_FILE'
  | 'EMPTY_SHEET'
  | 'FILE_READ_FAILED';

/** Thrown by `readImportFile`. Carries a stable code so the UI maps it to a translated message
 *  rather than surfacing a raw browser error string. */
export class ImportFileError extends Error {
  readonly code: ImportFileErrorCode;
  constructor(code: ImportFileErrorCode) {
    super(code);
    this.name = 'ImportFileError';
    this.code = code;
  }
}

/** What was decoded. The Excel formats go through `workbookToCsvText`; 'csv' is read natively. */
export type ImportFileFormat = 'csv' | 'xlsx' | 'xls';

export type ImportFileRead = {
  /** The file's own name, for the "loaded" confirmation line. */
  name: string;
  format: ImportFileFormat;
  /** CSV text — byte-for-byte what the user would otherwise have pasted. */
  text: string;
  /**
   * Item 2983802f — the FAMILY sheet's rows, as CSV text, when the workbook carried one.
   *
   * Empty string when there is no such sheet, and ALWAYS empty for a .csv upload or a paste: a CSV file
   * is one sheet by definition, so family members can only arrive in a real workbook. That limit is
   * stated on the template's Instructions sheet rather than left to be discovered.
   *
   * It travels as CSV text for the same reason the employee rows do — the server action receives text
   * and re-validates it, so no workbook ever reaches the server.
   */
  dependentsText: string;
};

/** True when the name looks like a CSV. Extension-based on purpose: browsers report wildly
 *  inconsistent MIME types for CSV (text/csv, application/vnd.ms-excel, application/octet-stream,
 *  or ""), so trusting `file.type` would reject perfectly good files on some machines. */
export function isCsvFileName(name: string): boolean {
  return name.toLowerCase().trim().endsWith('.csv');
}

/** The format a file name declares, or null when it is not an import file at all. Same
 *  extension-only reasoning as `isCsvFileName` — Excel's MIME types are just as inconsistent. */
export function importFileFormat(name: string): ImportFileFormat | null {
  const n = name.toLowerCase().trim();
  if (n.endsWith('.xlsx')) return 'xlsx';
  if (n.endsWith('.xls')) return 'xls';
  if (n.endsWith('.csv')) return 'csv';
  return null;
}

/**
 * Read a picked/dropped file into CSV text.
 *
 * Checks run cheapest-first so a 200 MB video never gets decoded: name, then size, then contents.
 * SheetJS is imported lazily (it is ~400 KB) so an admin who only ever uploads CSV never downloads
 * it, and it never enters a server bundle.
 */
export async function readImportFile(
  file: File,
  /** Item 2983802f — worksheets to read ALONGSIDE the first one, by name (the employee importer asks
   *  for its Family sheet). Ignored for a .csv upload, which has exactly one sheet. */
  opts?: { extraSheets?: readonly string[] },
): Promise<ImportFileRead> {
  const format = importFileFormat(file.name);
  if (!format) throw new ImportFileError('UNSUPPORTED_FILE_TYPE');
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new ImportFileError('FILE_TOO_LARGE');

  let text: string;
  let dependentsText = '';
  if (format === 'csv') {
    if (file.size > MAX_IMPORT_CSV_BYTES) throw new ImportFileError('FILE_TOO_LARGE');
    try {
      text = await file.text();
    } catch {
      throw new ImportFileError('FILE_READ_FAILED');
    }
  } else {
    const { workbookToCsvTexts } = await import('./spreadsheet');
    const wanted = opts?.extraSheets ?? [];
    let extra: Record<string, string> = {};
    try {
      const decoded = await workbookToCsvTexts(await file.arrayBuffer(), wanted);
      text = decoded.first;
      extra = decoded.extra;
    } catch (e) {
      // The decoder's one meaningful failure is a workbook whose first sheet holds nothing; it is a
      // user-fixable mistake and deserves its own message rather than "could not read that file".
      throw new ImportFileError((e as Error)?.message === 'EMPTY_SHEET' ? 'EMPTY_SHEET' : 'FILE_READ_FAILED');
    }
    dependentsText = wanted.length > 0 ? (extra[wanted[0]] ?? '') : '';
    // A workbook's CSV projection can be far larger than the compressed file, so the text ceiling is
    // enforced AFTER the decode for this path — that is the size the server action actually receives.
    // BOTH sheets are counted: they travel as two arguments of the same server action, so the ceiling
    // that protects it is the ceiling on their sum.
    if (new Blob([text, dependentsText]).size > MAX_IMPORT_CSV_BYTES) throw new ImportFileError('FILE_TOO_LARGE');
  }
  if (text.trim() === '') throw new ImportFileError(format === 'csv' ? 'EMPTY_FILE' : 'EMPTY_SHEET');

  return { name: file.name, format, text, dependentsText };
}

/** Error code → i18n key under the importer's namespace. Exported (rather than inlined in the
 *  component) so the key set is assertable: `t()` is called with a computed key here, and
 *  test/i18n-coverage.test.ts check C only resolves *literal* keys — see the dedicated locale test
 *  in test/employee-import-file.test.ts. */
export const IMPORT_FILE_MESSAGE_KEYS = {
  UNSUPPORTED_FILE_TYPE: 'unsupportedFileType',
  FILE_TOO_LARGE: 'fileTooLarge',
  EMPTY_FILE: 'emptyFile',
  EMPTY_SHEET: 'emptySheet',
  FILE_READ_FAILED: 'fileReadError',
} as const satisfies Record<ImportFileErrorCode, string>;

/** Map anything thrown while reading to a translation key. An unexpected throw degrades to the
 *  generic read-failure message instead of leaking a browser error to an HR admin. */
export function importFileMessageKey(e: unknown): string {
  const code = e instanceof ImportFileError ? e.code : undefined;
  return code ? IMPORT_FILE_MESSAGE_KEYS[code] : IMPORT_FILE_MESSAGE_KEYS.FILE_READ_FAILED;
}
