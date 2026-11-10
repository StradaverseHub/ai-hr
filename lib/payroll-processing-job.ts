/** Payroll processing background job (core/payroll-processing-job.ts): browser-safe kind and the run screen's
 * status shape. The job itself is a shared bulk-job kernel kind (lib/bulk-job.ts). */
import type {BulkJobProgress,BulkJobWorkerStatus} from './bulk-job';
export const PAYROLL_PROCESS_JOB_KIND='payroll_process';
/** `job` is the signed-in creator's latest processing job for the run; other payroll operators see the status. */
export type PayrollProcessingStatus={status:'draft'|'processing'|'processed'|'closed';job:BulkJobProgress|null;worker:BulkJobWorkerStatus};
