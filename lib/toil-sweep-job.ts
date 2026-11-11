/** The two replacement-leave sweeps (Process expirations, Close replacement-leave year) as background jobs, safe for
 * the browser. The service side is core/toil-sweep-job.ts (admission, progress) and core/toil-sweep-worker.ts. */
import type {CloseReplacementYearResult, ToilExpiryResult} from '../packs/leave/service';

export const TOIL_EXPIRY_JOB_KIND = 'toil_expiry';
export const TOIL_YEAR_CLOSE_JOB_KIND = 'toil_year_close';
export const TOIL_SWEEP_JOB_KINDS = [TOIL_EXPIRY_JOB_KIND, TOIL_YEAR_CLOSE_JOB_KIND] as const;
export type ToilSweepJobKind = typeof TOIL_SWEEP_JOB_KINDS[number];
export const isToilSweepJobKind = (kind: unknown): kind is ToilSweepJobKind => kind === TOIL_EXPIRY_JOB_KIND || kind === TOIL_YEAR_CLOSE_JOB_KIND;
/** The Leave Credit page: where both sweeps are started and where their outcome is shown. */
export const TOIL_SWEEP_PAGE = '/admin/leave-config/leave-credit';
export type ToilSweepJobState = 'queued' | 'running' | 'completed' | 'failed';
export type ToilSweepJobProgress = {
  id: string;
  kind: ToilSweepJobKind;
  state: ToilSweepJobState;
  /** Employees the run visits, and how many it has processed. */
  total: number;
  done: number;
  /** Employees whose credits were left unchanged because their batch could not be written (the rest are written). */
  failedEmployees: number;
  /** Why the job stopped before it finished, or the first reason employees were left unchanged. */
  error: string | null;
  updatedAt: string;
  /** What the synchronous sweep returned for the same input. */
  result: ToilExpiryResult | CloseReplacementYearResult | null;
  worker: 'running' | 'unavailable';
};
export const toilSweepJobActive = (state: ToilSweepJobState) => state === 'queued' || state === 'running';
export const toilSweepJobPercent = (job: Pick<ToilSweepJobProgress, 'state' | 'done' | 'total'>) =>
  job.state === 'completed' ? 100 : job.total > 0 ? Math.min(99, Math.floor((job.done / job.total) * 100)) : 0;

/** The address the synchronous action redirected to with this result, so the page shows the same banner. */
export function toilSweepResultHref(job: Pick<ToilSweepJobProgress, 'kind' | 'result'>): string {
  const r = job.result;
  if (!r) return TOIL_SWEEP_PAGE;
  if (job.kind === TOIL_EXPIRY_JOB_KIND)
    return `${TOIL_SWEEP_PAGE}?processed=${r.processed}&converted=${r.converted}&lapsed=${r.lapsed}&skipped=${r.skippedOutOfScope}`;
  const c = r as CloseReplacementYearResult;
  return `${TOIL_SWEEP_PAGE}?closed=1&closedAlready=${c.alreadyClosed ? 1 : 0}&closedProcessed=${c.processed}` +
    `&closedConverted=${c.converted}&closedLapsed=${c.lapsed}&closedCarried=${c.carriedForward}`;
}
