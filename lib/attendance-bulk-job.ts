/** Clocking import and Recompute Attendance as background jobs on the shared bulk-job kernel (migration 9940):
 * browser-safe kinds, progress shape and refusal codes. The services are core/attendance-clocking-import-job.ts
 * and core/attendance-recompute-job.ts; the screens poll their own jobs routes. */
import {bulkJobActive,bulkJobPercent,type BulkJobProgress,type BulkJobState} from './bulk-job';

export const CLOCKING_IMPORT_KIND='clocking_import';
export const ATTENDANCE_RECOMPUTE_PREVIEW_KIND='attendance_recompute_preview';
export const ATTENDANCE_RECOMPUTE_KIND='attendance_recompute';

/** One background attendance job as its screen shows it. `result` is the operation's own outcome (the clocking
 * import outcome, or the recompute result) once the job completed; `errors` are the employees it left out. `errorCode` is a refusal the screen translates.
 * `worker`: whether the import service is reporting in; a queued job with no worker stays visibly queued. */
export type AttendanceJobProgress<R>=Omit<BulkJobProgress,'result'>&{result:R|null;errorCode:string|null;worker:'running'|'unavailable'};

/** Stable code, translated on the screen, for a job refused because the same kind is already running. */
export const ATTENDANCE_JOB_ALREADY_RUNNING='alreadyRunning';
export const attendanceJobActive=(state:BulkJobState)=>bulkJobActive(state);
export const attendanceJobPercent=(job:Pick<BulkJobProgress,'state'|'stepsDone'|'stepsTotal'>)=>bulkJobPercent(job);
