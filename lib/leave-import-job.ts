/** Shape of a background leave ledger import, safe for the browser. */
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
};

export const leaveImportJobActive = (state: LeaveImportJobState): boolean => state === 'queued' || state === 'importing';
export const leaveImportJobPercent = (job: LeaveImportJobProgress): number =>
  job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
