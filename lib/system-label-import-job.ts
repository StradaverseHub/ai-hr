/** Browser-safe shape of a background System Labels import (kernel kind `system_label_import`). */
import type {BulkJobRowError,BulkJobState} from './bulk-job';
import {bulkJobActive,bulkJobPercent} from './bulk-job';

export const SYSTEM_LABEL_IMPORT_ALREADY_RUNNING='system-label-import-already-running';
/** The finished import's outcome: the same summary (and error workbook) the single-transaction import returned. */
export type SystemLabelImportResult={imported:number;updated:number;skipped:number;failed:number;errorReport?:string};
export type SystemLabelImportProgress={
 id:string;state:BulkJobState;sourceName:string;stepsTotal:number;stepsDone:number;
 error:string|null;errors:BulkJobRowError[];result:SystemLabelImportResult|null;
 /** Whether a live worker serves the kind; `unavailable` keeps a queued import visibly waiting. */
 worker:'running'|'unavailable';createdAt:string;updatedAt:string;
};
export const systemLabelImportActive=(state:BulkJobState)=>bulkJobActive(state);
export const systemLabelImportPercent=(job:Pick<SystemLabelImportProgress,'state'|'stepsDone'|'stepsTotal'>)=>bulkJobPercent(job);
