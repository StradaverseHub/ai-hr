/**
 * Import file reader — the FILE → CSV-TEXT step of an import, and nothing else.
 *
 * An import is three steps that must stay separable:
 *
 *   1. READ    a picked/dropped File  → CSV text        ← this module (browser-side)
 *   2. PARSE   CSV text               → records         ← lib/csv  (parseCsvRecords)
 *   3. WRITE   records                → employments     ← core/import via the server actions
 *
 * Only step 1 is new. Steps 2 and 3 already worked; the employee import screen simply had no way to
 * get a file into step 2 other than pasting its contents into a textarea. So this module deliberately
 * stops at "text": it hands back the exact same string a human would have pasted, and every downstream
 * guarantee (validation, per-row errors, the server-side re-validate on commit) is unchanged.
 *
 * SEQUENCING NOTE (d8471481 — .xlsx employee template with dropdown reference values): that work
 * replaces step 1 only. It swaps/extends `readImportFile` to decode a workbook (lib/spreadsheet's
 * `workbookToCsvText` already does this for the leave importer) and leaves steps 2 and 3 untouched.
 * Nothing in this file knows what a column means, so widening it cannot regress the write path.
 */

/** `accept` for the file input. CSV only today — d8471481 widens this alongside `readImportFile`. */
export const IMPORT_FILE_ACCEPT = '.csv,text/csv';

/** Next Server Functions default to a ~1 MB request body and the CSV text is sent as an argument.
 *  A 500-row employee file is ~60 KB, so this is a generous ceiling that still fails fast and
 *  locally instead of as an opaque 413 from the server action. */
export const MAX_IMPORT_CSV_BYTES = 900_000;

export type ImportFileErrorCode =
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'EMPTY_FILE'
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

export type ImportFileRead = {
  /** The file's own name, for the "loaded" confirmation line. */
  name: string;
  /** What was decoded. Only 'csv' today; d8471481 adds 'xlsx'. */
  format: 'csv';
  /** CSV text — byte-for-byte what the user would otherwise have pasted. */
  text: string;
};

/** True when the name looks like a CSV. Extension-based on purpose: browsers report wildly
 *  inconsistent MIME types for CSV (text/csv, application/vnd.ms-excel, application/octet-stream,
 *  or ""), so trusting `file.type` would reject perfectly good files on some machines. */
export function isCsvFileName(name: string): boolean {
  return name.toLowerCase().trim().endsWith('.csv');
}

/**
 * Read a picked/dropped file into CSV text.
 *
 * Checks run cheapest-first so a 200 MB video never gets decoded: name, then size, then contents.
 * `Blob.text()` performs a UTF-8 decode, which strips a leading byte-order mark — the BOM Excel's
 * "CSV UTF-8" export writes would otherwise turn the first header into `﻿full_name` and make
 * the importer report `full_name` as a missing required column.
 */
export async function readImportFile(file: File): Promise<ImportFileRead> {
  if (!isCsvFileName(file.name)) throw new ImportFileError('UNSUPPORTED_FILE_TYPE');
  if (file.size > MAX_IMPORT_CSV_BYTES) throw new ImportFileError('FILE_TOO_LARGE');

  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new ImportFileError('FILE_READ_FAILED');
  }
  if (text.trim() === '') throw new ImportFileError('EMPTY_FILE');

  return { name: file.name, format: 'csv', text };
}

/** Error code → i18n key under the importer's namespace. Exported (rather than inlined in the
 *  component) so the key set is assertable: `t()` is called with a computed key here, and
 *  test/i18n-coverage.test.ts check C only resolves *literal* keys — see the dedicated locale test
 *  in test/employee-import-file.test.ts. */
export const IMPORT_FILE_MESSAGE_KEYS = {
  UNSUPPORTED_FILE_TYPE: 'unsupportedFileType',
  FILE_TOO_LARGE: 'fileTooLarge',
  EMPTY_FILE: 'emptyFile',
  FILE_READ_FAILED: 'fileReadError',
} as const satisfies Record<ImportFileErrorCode, string>;

/** Map anything thrown while reading to a translation key. An unexpected throw degrades to the
 *  generic read-failure message instead of leaking a browser error to an HR admin. */
export function importFileMessageKey(e: unknown): string {
  const code = e instanceof ImportFileError ? e.code : undefined;
  return code ? IMPORT_FILE_MESSAGE_KEYS[code] : IMPORT_FILE_MESSAGE_KEYS.FILE_READ_FAILED;
}
