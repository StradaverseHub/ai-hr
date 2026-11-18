import type {ImportActor} from './import-reference';
export const INDIVIDUAL_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export type IndividualImportJobState =
  | 'pending' | 'validating' | 'ready' | 'confirmed' | 'importing' | 'completed' | 'failed';

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
  method: 'monthly' | 'daily';
  error: string | null;
  /** Board 8d02748a: readable "Imported by"; set by the readers, absent on writer results. */
  created_by_actor?: ImportActor;
};
