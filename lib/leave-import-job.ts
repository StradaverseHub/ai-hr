/** Shape of a background leave ledger import, safe for the browser (shared bulk-job kernel kind `leave_ledger`). */
import type {LeaveImportResult} from './leave-import-schema';

export type LeaveImportJobState = 'queued' | 'importing' | 'completed' | 'failed';
export type LeaveImportJobProgress = {
  id: string;
  state: LeaveImportJobState;
  total: number;
  done: number;
  updatedAt: string;
  /** Present once the job has finished. */
  result: LeaveImportResult | null;
  /** `unavailable`: no import service is serving the queue right now, so a queued import is waiting for it. */
  worker: 'running' | 'unavailable';
};

export const leaveImportJobActive = (state: LeaveImportJobState): boolean => state === 'queued' || state === 'importing';
export const leaveImportJobPercent = (job: LeaveImportJobProgress): number =>
  job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
