/** Every bulk operation the protected import worker runs on the shared kernel. A new kind adds its handler here,
 * its bulk_job_kind row in a migration and its completion-notice entry in lib/bulk-job.ts (ADR "Shared job kernel"). */
import type {BulkJobHandler} from './bulk-job-worker';
import {employeeImportJobHandler} from './employee-import-worker';
import {leaveImportJobHandler} from './leave-import-worker';
import {earnedAccrualJobHandler,leaveGenerationJobHandler} from './leave-cohort-worker';
import {rosterBulkJobHandler,scheduleGroupBulkJobHandler} from './roster-bulk-worker';
import {clockingImportJobHandler} from '../packs/attendance/service';
import {attendanceRecomputeJobHandler,attendanceRecomputePreviewJobHandler} from './attendance-recompute-job';
import {payrollProcessJobHandler} from './payroll-processing-job';
import {systemLabelImportJobHandler} from './system-label-import-worker';

export const BULK_JOB_HANDLERS:readonly BulkJobHandler[]=[employeeImportJobHandler,leaveImportJobHandler,leaveGenerationJobHandler,
 earnedAccrualJobHandler,rosterBulkJobHandler,scheduleGroupBulkJobHandler,clockingImportJobHandler,attendanceRecomputePreviewJobHandler,
 attendanceRecomputeJobHandler,payrollProcessJobHandler,systemLabelImportJobHandler];
