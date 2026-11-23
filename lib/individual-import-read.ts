/**
 * Board 0ec0ee00 — read an Individual Transaction workbook for the background import.
 *
 * Only the transaction sheet (INDIVIDUAL_IMPORT_SHEET[method], else the first sheet) is measured and decoded. The
 * template's reference sheets — Instructions, Employees (one row per employee in scope), Pay Items, Pay Cycles and
 * Input Types — are ignored, so a long employee list can no longer make a five-row file "too large". Rows count only
 * when they hold a value; formatted blank rows do not. Each refusal keeps its own code:
 *
 *   fileTooLarge     the uploaded file is over INDIVIDUAL_IMPORT_MAX_BYTES
 *   tooManyRows      the transaction sheet has more than INDIVIDUAL_IMPORT_MAX_RECORDS filled rows
 *   contentTooLarge  the transaction sheet holds more text than one upload can process
 *   emptyFile        the transaction sheet has no rows
 *   fileReadError    anything else that stops the workbook being read
 */
import {INDIVIDUAL_IMPORT_MAX_BYTES, INDIVIDUAL_IMPORT_MAX_CELLS, INDIVIDUAL_IMPORT_MAX_CSV_BYTES, INDIVIDUAL_IMPORT_MAX_RECORDS} from './individual-import-job';
import {INDIVIDUAL_IMPORT_SHEET, type IndividualImportMethod} from './payroll-txn-import-schema';

export type IndividualImportReadError = 'fileTooLarge' | 'tooManyRows' | 'contentTooLarge' | 'emptyFile' | 'fileReadError' | 'invalidFormat';
export class IndividualImportReadFailure extends Error {
  constructor(readonly code: IndividualImportReadError) { super(code); this.name = 'IndividualImportReadFailure'; }
}

export async function readIndividualImportWorkbook(bytes: Uint8Array, name: string, method: IndividualImportMethod): Promise<string> {
  if (!name.trim().toLowerCase().endsWith('.xlsx')) throw new IndividualImportReadFailure('invalidFormat');
  if (bytes.byteLength > INDIVIDUAL_IMPORT_MAX_BYTES) throw new IndividualImportReadFailure('fileTooLarge');
  // An .xlsx is a ZIP archive. Anything else (a renamed CSV, random bytes) would be read by SheetJS as loose text.
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new IndividualImportReadFailure('fileReadError');
  const {workbookToCsvTexts} = await import('./spreadsheet');
  let text: string;
  try {
    // Header row + the record limit, + 1 so one row over the limit is seen and refused as tooManyRows.
    ({first: text} = await workbookToCsvTexts(bytes, [], false, undefined, false, false,
      {maxRows: INDIVIDUAL_IMPORT_MAX_RECORDS + 1, maxCells: INDIVIDUAL_IMPORT_MAX_CELLS, sheet: INDIVIDUAL_IMPORT_SHEET[method]}));
  } catch (error) {
    const message = (error as Error)?.message;
    throw new IndividualImportReadFailure(message === 'TOO_MANY_ROWS' ? 'tooManyRows' : message === 'FILE_TOO_LARGE' ? 'contentTooLarge'
      : message === 'EMPTY_SHEET' ? 'emptyFile' : 'fileReadError');
  }
  if (new TextEncoder().encode(text).byteLength > INDIVIDUAL_IMPORT_MAX_CSV_BYTES) throw new IndividualImportReadFailure('contentTooLarge');
  if (text.trim() === '') throw new IndividualImportReadFailure('emptyFile');
  return text;
}
