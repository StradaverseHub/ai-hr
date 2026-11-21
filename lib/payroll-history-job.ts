/** Payroll history confirm/revert background job (core/payroll-history-job.ts): browser-safe kind and the screen's
 * status shape. The job itself is a shared bulk-job kernel kind (lib/bulk-job.ts). */
import type {BulkJobProgress,BulkJobWorkerStatus} from './bulk-job';
export const PAYROLL_HISTORY_JOB_KIND='payroll_history';
export type PayrollHistoryJobStatus={job:BulkJobProgress;operation:'confirm'|'revert';attemptId:string|null;worker:BulkJobWorkerStatus};
