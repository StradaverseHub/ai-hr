import type {ImportActor} from './import-reference';
/** Board 0ec0ee00 — the Individual Transaction upload limits, in one place (the client, action, admission, reader,
 *  worker, validation and parser). The Fixed Transaction import keeps its own 2,000-row limit (core/payroll-txn-import.ts). */
export const INDIVIDUAL_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const INDIVIDUAL_IMPORT_MAX_RECORDS = 10_000;
/** The transaction sheet decoded to CSV: about 800 bytes a row at the record limit, which no real row approaches. */
export const INDIVIDUAL_IMPORT_MAX_CSV_BYTES = 8_000_000;
/** Filled cells of the transaction sheet (header + records × at most 20 columns); the template has 9 or 10. */
export const INDIVIDUAL_IMPORT_MAX_CELLS = (INDIVIDUAL_IMPORT_MAX_RECORDS + 1) * 20;
/** Stage 2 — rows written (or reverted) by one short transaction of the background worker. */
export const INDIVIDUAL_IMPORT_STEP_ROWS = 250;
/** Rows shown per page of an Import Log batch. */
export const INDIVIDUAL_IMPORT_PAGE_ROWS = 100;

export type IndividualImportJobState =
  | 'pending' | 'validating' | 'ready' | 'confirmed' | 'importing' | 'completed' | 'failed'
  | 'stopped' | 'reverting' | 'reverted';

export type IndividualImportJob = {
  id: string;
  source_name: string;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  attempt_id: string | null;
  state: IndividualImportJobState;
  processed: number;
  total: number;
  written: number;
  failed_rows: number;
  /** Rows of this batch's import already removed by a revert (0ec0ee00). */
  reverted_rows: number;
  method: 'monthly' | 'daily';
  error: string | null;
  /** Board 8d02748a: readable "Imported by"; set by the readers, absent on writer results. */
  created_by_actor?: ImportActor;
};

/** Percent of `done` out of `total`, never 100 before the work has finished. */
export function individualImportPercent(done: number, total: number, finished: boolean): number {
  if (finished) return 100;
  return total > 0 ? Math.min(99, Math.floor(done * 100 / total)) : 0;
}
