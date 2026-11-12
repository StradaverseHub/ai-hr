/** Background leave processing jobs (Generate Entitlement, Run Earned Accrual), safe for the browser. */
import type {LeaveGenerationResult} from '../core/leave-generation';

export const LEAVE_GENERATION_JOB_KIND = 'leave_generation';
export const LEAVE_ACCRUAL_JOB_KIND = 'leave_accrual';
/** Follow-up work a configuration save starts (core/leave-follow-up-worker.ts). */
export const LEAVE_RECALC_JOB_KIND = 'leave_recalc';
export const LEAVE_A2C_JOB_KIND = 'leave_a2c';
export type LeaveCohortJobKind = typeof LEAVE_GENERATION_JOB_KIND | typeof LEAVE_ACCRUAL_JOB_KIND | typeof LEAVE_RECALC_JOB_KIND | typeof LEAVE_A2C_JOB_KIND;
export type LeaveCohortJobState = 'queued' | 'running' | 'completed' | 'failed';
/** What Run Earned Accrual reports when it finishes (the figures the synchronous run returned). */
export type EarnedAccrualJobResult = {granted: number; forfeits: number};
/** What a recalculation (entitlement or A2C) reports: employees whose figures moved. */
export type LeaveRecalcJobResult = {employees?: number; affected: number; totalDelta: number};
export type LeaveCohortJobProgress = {
  id: string;
  kind: LeaveCohortJobKind;
  state: LeaveCohortJobState;
  /** Employees the run visits, and how many it has processed. */
  total: number;
  done: number;
  /** Employees left unchanged because their batch could not be written (the rest are written). */
  failedEmployees: number;
  /** Why the job stopped before it finished, or the first reason employees were left unchanged. */
  error: string | null;
  updatedAt: string;
  result: (LeaveGenerationResult & {runId?: string}) | EarnedAccrualJobResult | LeaveRecalcJobResult | null;
  worker: 'running' | 'unavailable';
};
export const leaveCohortJobActive = (state: LeaveCohortJobState) => state === 'queued' || state === 'running';
export const leaveCohortJobPercent = (job: Pick<LeaveCohortJobProgress, 'state' | 'done' | 'total'>) =>
  job.state === 'completed' ? 100 : job.total > 0 ? Math.min(99, Math.floor((job.done / job.total) * 100)) : 0;
