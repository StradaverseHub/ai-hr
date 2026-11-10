/** Roster bulk operations on the shared bulk-job kernel: browser-safe kinds, progress shape and error text.
 * Server side: core/roster-bulk-job.ts (admission, reads) and core/roster-bulk-worker.ts (the worker handlers). */
import type {BulkJobState} from './bulk-job';
import type {RosterImportResult} from '../core/roster-import';

export const ROSTER_BULK_KIND='roster_bulk';
export const SCHEDULE_GROUP_BULK_KIND='schedule_group_bulk';
/** Generate from a shift template, copy a window forward, the grid's bulk brush, and the month-grid upload. */
export type RosterBulkOp='generate'|'copy'|'assign'|'import';
/** Stable code for an admission refused because the tenant already runs a roster (or Schedule Group) bulk job. */
export const ROSTER_BULK_ALREADY_RUNNING='roster-bulk-already-running';
/** Stored instead of a message the screen must not print (the Schedule Group page shows its own sentence). */
export const SCHEDULE_GROUP_BULK_UNEXPECTED='schedule-group-bulk-unexpected';

/** What a screen polls: the job's state and, once it has ended, where the outcome is shown (the same address the
 * synchronous action redirected to) or the outcome itself for screens that render it in place. */
export type RosterBulkJobView={
 id:string;kind:string;op:RosterBulkOp|'schedule-group';state:BulkJobState;stepsDone:number;stepsTotal:number;
 worker:'running'|'unavailable';updatedAt:string;error:string|null;
 /** Terminal only: the page that shows the outcome (Generate, Copy, Schedule Group bulk). */
 href:string|null;
 /** Terminal only: the upload's result (Upload Shift Roster renders it in place). */
 importResult:RosterImportResult|null;
};
export const ROSTER_BULK_ACTIVE:readonly BulkJobState[]=['queued','preparing','running','finalizing','discarding'];
export const rosterBulkActive=(state:BulkJobState)=>ROSTER_BULK_ACTIVE.includes(state);
export function rosterBulkPercent(job:Pick<RosterBulkJobView,'state'|'stepsDone'|'stepsTotal'>){
 if(job.state==='completed')return 100;
 return job.stepsTotal>0?Math.min(99,Math.floor(job.stepsDone/job.stepsTotal*100)):0;
}

/**
 * 23390097 BLOCKER — no roster screen prints the database's own words (app/roster/actions.ts). Shared by the
 * actions and the background worker, so a job's stored error is the same sentence the action would have shown.
 */
const RAW_DRIVER_TEXT = /failed query|\bparams:|insert into\b|update\s+"|delete from\b/i;
export const ROSTER_WRITE_FAILED = 'The roster change could not be saved. Please try again, or ask an HR administrator.';
export function rosterReadableError(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return message.trim() === '' || RAW_DRIVER_TEXT.test(message) ? ROSTER_WRITE_FAILED : message;
}
