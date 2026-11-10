/** Every bulk operation the protected import worker runs on the shared kernel. A new kind adds its handler here,
 * its bulk_job_kind row in a migration and its completion-notice entry in lib/bulk-job.ts (ADR "Shared job kernel"). */
import type {BulkJobHandler} from './bulk-job-worker';
import {employeeImportJobHandler} from './employee-import-worker';
import {payrollProcessJobHandler} from './payroll-processing-job';
import {payrollHistoryJobHandler} from './payroll-history-job';
import {payrollReprocessJobHandler} from './payroll-reprocess-job';

export const BULK_JOB_HANDLERS:readonly BulkJobHandler[]=[employeeImportJobHandler,payrollProcessJobHandler,payrollHistoryJobHandler,payrollReprocessJobHandler];
